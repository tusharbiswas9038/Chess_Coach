# classifier/hanging_detector.py
"""
Fast hanging piece scanner — no Stockfish needed.
Use this to compute hanging_piece_rate quickly before full analysis completes.
"""
import chess
import chess.pgn
import sqlite3
import io
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from config import DB_PATH, CHESS_USERNAME
from core.chess_utils import get_hanging_squares # New Import


def scan_game_for_hanging(pgn_text: str, player_color_str: str) -> list[dict]:
    """
    Walk through a game and find all positions where the player
    left a piece hanging immediately after their move.
    Returns list of {ply, fen, square, piece_type}.
    """
    player_color = chess.WHITE if player_color_str == "white" else chess.BLACK
    results = []

    try:
        game = chess.pgn.read_game(io.StringIO(pgn_text))
    except Exception:
        return results

    if game is None:
        return results

    board = game.board()
    ply = 0

    for node in game.mainline():
        board.push(node.move)
        ply += 1

        # Check after player's own move only
        mover = chess.WHITE if ply % 2 == 1 else chess.BLACK
        if mover != player_color:
            continue

        for sq in get_hanging_squares(board, player_color):
            piece = board.piece_at(sq)
            if piece:
                results.append({
                    "ply": ply,
                    "fen": board.fen(),
                    "square": chess.square_name(sq),
                    "piece_type": chess.piece_name(piece.piece_type),
                })

    return results


def compute_hanging_rate() -> float:
    """
    Scan all games and compute the fraction where the player
    left at least one piece hanging. Stores result in player_profile.
    """
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode=WAL")

    rows = conn.execute(
        "SELECT id, pgn, color FROM games"
    ).fetchall()

    total = len(rows)
    if total == 0:
        print("No games found.")
        conn.close()
        return 0.0

    games_with_hanging = 0
    for game_id, pgn, color in rows:
        moments = scan_game_for_hanging(pgn, color)
        if moments:
            games_with_hanging += 1

    rate = games_with_hanging / total

    conn.execute("""
        INSERT INTO player_profile (id, username, hanging_piece_rate)
        VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            hanging_piece_rate=excluded.hanging_piece_rate,
            updated_at=datetime('now')
    """, (CHESS_USERNAME, round(rate, 4)))
    conn.commit()
    conn.close()

    print(f"Hanging piece rate: {rate:.1%}  ({games_with_hanging}/{total} games)")
    return rate


if __name__ == "__main__":
    compute_hanging_rate()
