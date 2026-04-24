# engine/stockfish_worker.py
import chess
import chess.pgn
import chess.engine
import sqlite3
import io
import time
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


from config import DB_PATH, STOCKFISH_PATH, STOCKFISH_DEPTH, STOCKFISH_THREADS, STOCKFISH_HASH_MB

DEPTH = STOCKFISH_DEPTH
BATCH_SIZE = 5

INACCURACY_THRESHOLD = 100
MISTAKE_THRESHOLD = 200
BLUNDER_THRESHOLD = 300

PIECE_VALUES = {
    chess.PAWN: 100,
    chess.KNIGHT: 300,
    chess.BISHOP: 310,
    chess.ROOK: 500,
    chess.QUEEN: 900,
    chess.KING: 0,
}


def classify_move(delta: int) -> str:
    """Classify move quality by centipawn loss (delta = eval_after - eval_before, negative = bad)."""
    if delta >= -10:
        return "best"
    if delta >= -25:
        return "excellent"
    if delta >= -60:
        return "good"
    if delta >= -INACCURACY_THRESHOLD:
        return "inaccuracy"
    if delta >= -MISTAKE_THRESHOLD:
        return "mistake"
    return "blunder"


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


def is_piece_hanging(board: chess.Board, move: chess.Move) -> bool:
    """
    After pushing a move, check if the player who just moved left any piece hanging.
    Uses simple SEE heuristic: undefended piece attacked, or cheapest attacker < piece value.
    """
    board_copy = board.copy()
    board_copy.push(move)
    mover_color = not board_copy.turn  # who just moved

    for sq in chess.SQUARES:
        piece = board_copy.piece_at(sq)
        if piece is None or piece.color != mover_color or piece.piece_type == chess.KING:
            continue
        attackers = board_copy.attackers(not mover_color, sq)
        if not attackers:
            continue
        defenders = board_copy.attackers(mover_color, sq)
        if not defenders:
            return True
        min_atk = min(
            PIECE_VALUES.get(board_copy.piece_at(s).piece_type, 0)
            for s in attackers
            if board_copy.piece_at(s)
        )
        piece_val = PIECE_VALUES.get(piece.piece_type, 0)
        if min_atk < piece_val:
            return True
    return False


def detect_phase(ply: int, board: chess.Board) -> str:
    piece_count = len(board.piece_map())
    if ply <= 20:
        return "opening"
    if piece_count <= 12:
        return "endgame"
    return "middlegame"


def analyze_game(
    game_id: str,
    pgn_text: str,
    player_color_str: str,
    engine: chess.engine.SimpleEngine,
    conn: sqlite3.Connection,
) -> bool:
    """
    Analyze a single game. Returns True on success, False on error.
    One Stockfish call per position (not two). Best move extracted from PV.
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
    prev_eval: int | None = None  # eval from previous ply (player perspective)
    prev_info_after = None
    cached_info = None   # reuse previous info_after as next info

    for node in game.mainline():
        move = node.move
        fen_before = board.fen()
        move_color = "white" if board.turn == chess.WHITE else "black"

        clock_before = int(node.clock()) if node.clock() is not None else None

        # --- Single Stockfish call per position ---
        try:
            if cached_info is not None:
                info = cached_info
            else:
                info = engine.analyse(
                        board,
                        chess.engine.Limit(depth=DEPTH),
                        )
        except Exception as e:
            print(f"  [engine error] {game_id} ply {ply}: {e}")
            board.push(move)
            ply += 1
            cached_info = None
            prev_eval = None
            continue

        eval_before = normalize_eval(info["score"].relative, board.turn)

        # Best move and its SAN come from the PV line
        pv = info.get("pv", [])
        best_uci_move = pv[0] if pv else None
        best_move_uci = best_uci_move.uci() if best_uci_move else None
        best_move_san = board.san(best_uci_move) if best_uci_move else None

        # Hanging piece check BEFORE pushing the move
        hanging = is_piece_hanging(board, move)

        board.push(move)
        fen_after = board.fen()
        ply += 1

        # eval_after = negative of next position's eval from that player's perspective
        # We re-use the engine call from next iteration via prev_eval for efficiency
        # For now, compute it directly — still only ONE call (the one above)
        # eval_after is approximated as: -(eval of next position from next player's POV)
        # We do this by analysing the resulting position with 1 less depth for speed
        try:
            info_after = engine.analyse(
                board,
                chess.engine.Limit(depth=DEPTH))
            cached_info = info_after
            # From the mover's perspective: negate the relative eval of the opponent's position
            eval_after = -normalize_eval(info_after["score"].relative, board.turn)
        except Exception:
            eval_after = None
            cached_info = None

        delta = (eval_after - eval_before) if eval_after is not None else None

        classification = None
        if move_color == player_color_str and delta is not None:
            classification = classify_move(delta)

        phase = detect_phase(ply, board)

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
            "eval_after": eval_after,
            "eval_delta": delta,
            "best_move_uci": best_move_uci,
            "best_move_san": best_move_san,
            "best_move_eval": eval_before,  # eval of the best line = eval_before (engine's view)
            "depth": DEPTH,
            "clock_before": clock_before,
            "classification": classification,
            "is_hanging_piece": 1 if (hanging and move_color == player_color_str) else 0,
            "phase": phase,
        })

    if not moves_data:
        return False

    # Idempotency: if this game is re-analyzed, replace old analysis rows.
    conn.execute("DELETE FROM mistakes WHERE game_id=?", (game_id,))
    conn.execute("DELETE FROM moves WHERE game_id=?", (game_id,))

    # Bulk insert moves
    conn.executemany("""
        INSERT INTO moves (
            game_id, ply, move_number, color, san, uci,
            fen_before, fen_after, eval_before, eval_after, eval_delta,
            best_move_uci, best_move_san, best_move_eval, depth,
            clock_before, classification, is_hanging_piece, phase
        ) VALUES (
            :game_id, :ply, :move_number, :color, :san, :uci,
            :fen_before, :fen_after, :eval_before, :eval_after, :eval_delta,
            :best_move_uci, :best_move_san, :best_move_eval, :depth,
            :clock_before, :classification, :is_hanging_piece, :phase
        )
    """, moves_data)

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

            mistakes_data.append({
                "game_id": game_id,
                "type": mtype,
                "phase": m["phase"],
                "fen": m["fen_before"],
                "played_move": m["uci"],
                "best_move": m["best_move_uci"] if m["best_move_uci"] and m["best_move_uci"] != m["uci"] else "?",
                "eval_loss": abs(delta),
                "is_critical": 1 if m["ply"] == critical_ply else 0,
            })

    if mistakes_data:
        conn.executemany("""
            INSERT INTO mistakes (
                game_id, type, phase, fen, played_move, best_move, eval_loss, is_critical
            ) VALUES (
                :game_id, :type, :phase, :fen, :played_move, :best_move, :eval_loss, :is_critical
            )
        """, mistakes_data)

    conn.execute("UPDATE games SET analyzed=1 WHERE id=?", (game_id,))
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
