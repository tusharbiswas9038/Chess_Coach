# engine/stockfish_worker.py
import chess
import chess.pgn
import chess.engine
import sqlite3
import io
import json
import time
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


from config import DB_PATH, STOCKFISH_PATH, STOCKFISH_DEPTH, STOCKFISH_THREADS, STOCKFISH_HASH_MB
from core.chess_utils import ( # New Import
    classify_move,
    classify_mistake_v2,
    is_piece_hanging,
    detect_phase,
    INACCURACY_THRESHOLD,
    MISTAKE_THRESHOLD,
    BLUNDER_THRESHOLD,
)

DEPTH = STOCKFISH_DEPTH
BATCH_SIZE = 5
MIN_ANALYSIS_DEPTH = 8
MAX_ANALYSIS_DEPTH = 26


def normalize_eval(score: chess.engine.Score, turn: chess.Color) -> int:
    """
    Return centipawns from the perspective of the player whose turn it is.
    Positive = good for that player.
    Mate scores capped at ±10000.
    """
    if score.is_mate():
        return 10000 if score.mate() > 0 else -10000
    cp = score.score(mate_score=10000)
    return cp if turn == chess.WHITE else -cp


def _bounded_depth(depth: int) -> int:
    return max(MIN_ANALYSIS_DEPTH, min(MAX_ANALYSIS_DEPTH, depth))


def select_depth_policy(board: chess.Board, ply: int, phase: str) -> tuple[int, str]:
    """Use deeper Stockfish only where the position is likely branch-heavy."""
    legal_moves = board.legal_moves.count()
    if phase == "opening" and (ply <= 16 or legal_moves >= 28):
        return _bounded_depth(DEPTH + 2), "opening_branch"
    if board.is_check() or legal_moves >= 34:
        return _bounded_depth(DEPTH), "base"
    return _bounded_depth(DEPTH - 4), "light"


def analyze_position(
    engine: chess.engine.SimpleEngine,
    board: chess.Board,
    depth: int,
    multipv: int = 1,
) -> tuple[int, str | None, str | None, list[dict]]:
    info = engine.analyse(board, chess.engine.Limit(depth=depth), multipv=multipv)
    info_rows = info if isinstance(info, list) else [info]
    primary = info_rows[0] if info_rows else {}
    eval_before = normalize_eval(primary["score"].relative, board.turn)

    candidates = []
    best_move_uci = None
    best_move_san = None
    for idx, row in enumerate(info_rows, 1):
        pv = row.get("pv", [])
        candidate = pv[0] if pv else None
        if candidate is None:
            continue
        try:
            san = board.san(candidate)
        except Exception:
            san = candidate.uci()
        score = normalize_eval(row["score"].relative, board.turn)
        if idx == 1:
            best_move_uci = candidate.uci()
            best_move_san = san
        candidates.append({
            "rank": idx,
            "uci": candidate.uci(),
            "san": san,
            "eval_cp": score,
        })

    return eval_before, best_move_uci, best_move_san, candidates


def _candidate_json(candidates: list[dict]) -> str | None:
    return json.dumps(candidates[:3], separators=(",", ":")) if candidates else None


def _critical_depth() -> int:
    return _bounded_depth(DEPTH + 4)





def analyze_game(
    game_id: str,
    pgn_text: str,
    player_color_str: str,
    engine: chess.engine.SimpleEngine,
    conn: sqlite3.Connection,
) -> bool:
    """
    Analyze a single game. Returns True on success, False on error.
    Uses one Stockfish call per position (fen_before of each ply).
    eval_after is derived from the next ply's eval_before from opponent perspective.
    """
    player_color = chess.WHITE if player_color_str == "white" else chess.BLACK

    try:
        game = chess.pgn.read_game(io.StringIO(pgn_text))
    except Exception as e:
        print(f"  [parse error] {game_id}: {e}")
        return False

    if game is None:
        print(f"  [empty pgn] {game_id}")
        return False

    board = game.board()
    moves_data = []
    ply = 0
    eval_before_by_ply: list[int | None] = []

    for node in game.mainline():
        move = node.move
        fen_before = board.fen()
        move_color = "white" if board.turn == chess.WHITE else "black"
        phase = detect_phase(ply + 1, board)
        depth, depth_policy = select_depth_policy(board, ply + 1, phase)

        clock_before = int(node.clock()) if node.clock() is not None else None

        try:
            eval_before, best_move_uci, best_move_san, candidates = analyze_position(
                engine,
                board,
                depth,
            )
        except Exception as e:
            print(f"  [engine error] {game_id} ply {ply}: {e}")
            board.push(move)
            ply += 1
            eval_before_by_ply.append(None)
            continue

        eval_before_by_ply.append(eval_before)

        # Hanging piece check BEFORE pushing the move
        hanging = is_piece_hanging(board, move)

        board.push(move)
        fen_after = board.fen()
        ply += 1

        classification = None

        moves_data.append({
            "game_id": game_id,
            "ply": ply,
            "move_number": (ply + 1) // 2,
            "color": move_color,
            "san": node.san(),
            "uci": move.uci(),
            "fen_before": fen_before,
            "fen_after": fen_after,
            "eval_before": eval_before,
            "eval_after": None,
            "eval_delta": None,
            "best_move_uci": best_move_uci,
            "best_move_san": best_move_san,
            "best_move_eval": eval_before,  # eval of the best line = eval_before (engine's view)
            "depth": depth,
            "clock_before": clock_before,
            "classification": classification,
            "is_hanging_piece": 1 if (hanging and move_color == player_color_str) else 0,
            "phase": phase,
            "analysis_depth_policy": depth_policy,
            "candidate_alternatives": _candidate_json(candidates),
            "plan_text": None,
            "practical_impact": None,
            "time_pressure_flag": 1 if (clock_before is not None and clock_before <= 60) else 0,
        })

    if not moves_data:
        return False

    # Populate eval_after / eval_delta using the next ply's eval_before.
    for i, move_row in enumerate(moves_data):
        current_eval = move_row["eval_before"]
        next_eval = eval_before_by_ply[i + 1] if i + 1 < len(eval_before_by_ply) else None
        eval_after = -next_eval if next_eval is not None else None
        move_row["eval_after"] = eval_after
        delta = (eval_after - current_eval) if (eval_after is not None and current_eval is not None) else None
        move_row["eval_delta"] = delta
        if move_row["color"] == player_color_str and delta is not None:
            move_row["classification"] = classify_move(delta)

    critical_candidates = [
        (idx, move_row)
        for idx, move_row in enumerate(moves_data)
        if move_row["color"] == player_color_str
        and move_row["eval_delta"] is not None
        and move_row["eval_delta"] <= -MISTAKE_THRESHOLD
    ]
    critical_candidates.sort(key=lambda item: item[1]["eval_delta"])
    for idx, move_row in critical_candidates[:3]:
        try:
            board_before = chess.Board(move_row["fen_before"])
            (
                eval_before,
                best_move_uci,
                best_move_san,
                candidates,
            ) = analyze_position(engine, board_before, _critical_depth(), multipv=3)
        except Exception as e:
            print(f"  [critical recheck error] {game_id} ply {move_row['ply']}: {e}")
            continue

        move_row["eval_before"] = eval_before
        move_row["best_move_uci"] = best_move_uci
        move_row["best_move_san"] = best_move_san
        move_row["best_move_eval"] = eval_before
        move_row["depth"] = _critical_depth()
        move_row["analysis_depth_policy"] = "critical"
        move_row["candidate_alternatives"] = _candidate_json(candidates)
        eval_after = move_row["eval_after"]
        if eval_after is not None:
            delta = eval_after - eval_before
            move_row["eval_delta"] = delta
            move_row["classification"] = classify_move(delta)
            eval_before_by_ply[idx] = eval_before
            if idx > 0:
                previous = moves_data[idx - 1]
                previous["eval_after"] = -eval_before
                previous_current = previous["eval_before"]
                if previous_current is not None:
                    previous_delta = previous["eval_after"] - previous_current
                    previous["eval_delta"] = previous_delta
                    if previous["color"] == player_color_str:
                        previous["classification"] = classify_move(previous_delta)

    # Build mistakes from player's moves only
    player_moves = [m for m in moves_data if m["color"] == player_color_str]
    mistakes_data = []

    if player_moves:
        # Find critical move (worst single eval swing)
        worst = min(
            player_moves,
            key=lambda m: m["eval_delta"] if m["eval_delta"] is not None else 0,
        )
        critical_ply = worst["ply"]

        for m in player_moves:
            delta = m["eval_delta"]
            if delta is None or delta > -INACCURACY_THRESHOLD:
                continue

            if m["is_hanging_piece"]:
                mtype = "hanging_piece"
            elif delta <= -BLUNDER_THRESHOLD:
                mtype = "blunder"
            else:
                mtype = "mistake"

            try:
                board_before = chess.Board(m["fen_before"])
                played_move = chess.Move.from_uci(m["uci"])
                v2 = classify_mistake_v2(
                    board_before,
                    played_move,
                    m["best_move_uci"],
                    delta,
                    m["phase"],
                    bool(m["is_hanging_piece"]),
                    m["eval_before"],
                    m["clock_before"],
                )
            except Exception:
                v2 = {
                    "mistake_subtype": "strategic_concession",
                    "confidence": 0.55,
                    "practical_impact": "low",
                    "time_pressure_flag": 0,
                    "plan_text": "Review this move against the engine recommendation.",
                }

            m["plan_text"] = v2["plan_text"]
            m["practical_impact"] = v2["practical_impact"]
            m["time_pressure_flag"] = v2["time_pressure_flag"]

            mistakes_data.append({
                "game_id": game_id,
                "type": mtype,
                "phase": m["phase"],
                "fen": m["fen_before"],
                "played_move": m["uci"],
                "best_move": m["best_move_uci"] if m["best_move_uci"] and m["best_move_uci"] != m["uci"] else "?",
                "eval_loss": abs(delta),
                "is_critical": 1 if m["ply"] == critical_ply else 0,
                "mistake_subtype": v2["mistake_subtype"],
                "confidence": v2["confidence"],
                "practical_impact": v2["practical_impact"],
                "time_pressure_flag": v2["time_pressure_flag"],
                "candidate_alternatives": m["candidate_alternatives"],
                "plan_text": v2["plan_text"],
            })

    # Idempotency: if this game is re-analyzed, replace old analysis rows.
    conn.execute("DELETE FROM mistakes WHERE game_id=?", (game_id,))
    conn.execute("DELETE FROM moves WHERE game_id=?", (game_id,))

    # Bulk insert moves
    conn.executemany("""
        INSERT INTO moves (
            game_id, ply, move_number, color, san, uci,
            fen_before, fen_after, eval_before, eval_after, eval_delta,
            best_move_uci, best_move_san, best_move_eval, depth,
            clock_before, classification, is_hanging_piece, phase,
            analysis_depth_policy, candidate_alternatives, plan_text,
            practical_impact, time_pressure_flag
        ) VALUES (
            :game_id, :ply, :move_number, :color, :san, :uci,
            :fen_before, :fen_after, :eval_before, :eval_after, :eval_delta,
            :best_move_uci, :best_move_san, :best_move_eval, :depth,
            :clock_before, :classification, :is_hanging_piece, :phase,
            :analysis_depth_policy, :candidate_alternatives, :plan_text,
            :practical_impact, :time_pressure_flag
        )
    """, moves_data)

    if mistakes_data:
        conn.executemany("""
            INSERT INTO mistakes (
                game_id, type, phase, fen, played_move, best_move, eval_loss, is_critical,
                mistake_subtype, confidence, practical_impact, time_pressure_flag,
                candidate_alternatives, plan_text
            ) VALUES (
                :game_id, :type, :phase, :fen, :played_move, :best_move, :eval_loss, :is_critical,
                :mistake_subtype, :confidence, :practical_impact, :time_pressure_flag,
                :candidate_alternatives, :plan_text
            )
        """, mistakes_data)

    num_mistakes = len(mistakes_data)
    conn.execute(
        "UPDATE games SET analyzed=1, mistake_count=? WHERE id=?",
        (num_mistakes, game_id)
    )
    return True


def update_player_profile(conn: sqlite3.Connection):
    """Recompute and upsert player_profile stats from current DB state."""
    from config import CHESS_USERNAME

    total_games = conn.execute("SELECT COUNT(*) FROM games WHERE analyzed=1").fetchone()[0]
    if total_games == 0:
        return
    # Get latest rating from most recent game
    latest = conn.execute("""
        SELECT
            CASE WHEN color='white' THEN white_rating ELSE black_rating END as rating
        FROM games
        WHERE analyzed=1
        ORDER BY date DESC
        LIMIT 1
    """).fetchone()

    if latest:
        conn.execute("""
            UPDATE player_profile SET current_rating=? WHERE id=1
        """, (latest["rating"],))

    hanging_games = conn.execute("""
        SELECT COUNT(DISTINCT game_id) FROM moves WHERE is_hanging_piece=1
    """).fetchone()[0]

    blunder_count = conn.execute("""
        SELECT COUNT(*) FROM mistakes WHERE type IN ('blunder','hanging_piece')
    """).fetchone()[0]

    conn.execute("""
        INSERT INTO player_profile (id, username, games_analyzed, hanging_piece_rate, blunder_per_game, updated_at)
        VALUES (1, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
            username=excluded.username,
            games_analyzed=excluded.games_analyzed,
            hanging_piece_rate=excluded.hanging_piece_rate,
            blunder_per_game=excluded.blunder_per_game,
            updated_at=excluded.updated_at
    """, (
        CHESS_USERNAME,
        total_games,
        round(hanging_games / total_games, 4) if total_games else 0,
        round(blunder_count / total_games, 4) if total_games else 0,
    ))
    conn.commit()


def run_analysis_worker():
    """Process all unanalyzed games. Called by API background task or directly."""
    conn = sqlite3.connect(DB_PATH, timeout=60)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")

    pending = conn.execute(
        "SELECT id, pgn, color FROM games WHERE analyzed=0 ORDER BY date ASC"
    ).fetchall()

    if not pending:
        print("No games to analyze.")
        conn.close()
        return

    total = len(pending)
    print(f"Analyzing {total} game(s) at depth {DEPTH} using {STOCKFISH_THREADS} threads...")

    try:
        engine = chess.engine.SimpleEngine.popen_uci(STOCKFISH_PATH)
        engine.configure({"Threads": STOCKFISH_THREADS, "Hash": STOCKFISH_HASH_MB})
    except Exception as e:
        print(f"Failed to start Stockfish at {STOCKFISH_PATH}: {e}")
        conn.close()
        return

    success = 0
    errors = 0

    try:
        for i, row in enumerate(pending, 1):
            t0 = time.time()
            try:
                conn.execute("BEGIN")
                ok = analyze_game(row["id"], row["pgn"], row["color"], engine, conn)
                elapsed = time.time() - t0

                if ok:
                    success += 1
                    status = f"✓ {elapsed:.1f}s"
                else:
                    errors += 1
                    status = "✗ error"
                    conn.execute("UPDATE games SET analyzed=2 WHERE id=?", (row["id"],))

                conn.commit()
            except Exception as e:
                conn.rollback()
                errors += 1
                status = "✗ exception"
                conn.execute("UPDATE games SET analyzed=2 WHERE id=?", (row["id"],))
                conn.commit()
                print(f"  [unexpected error] {row['id'][:16]}... {e}")

            print(f"  [{i}/{total}] {row['id'][:16]}... {status}")

    finally:
        engine.quit()
        conn.commit()

    update_player_profile(conn)
    conn.close()

    print(f"\nDone. {success} succeeded, {errors} failed.")


if __name__ == "__main__":
    run_analysis_worker()
