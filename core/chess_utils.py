import chess
import chess.engine
from typing import Dict, List, Any

# Define PIECE_VALUES centrally
PIECE_VALUES: Dict[chess.PieceType, int] = {
    chess.PAWN: 100,
    chess.KNIGHT: 300,
    chess.BISHOP: 310,
    chess.ROOK: 500,
    chess.QUEEN: 900,
    chess.KING: 0, # King value is 0 for material counting, but is infinitely valuable
}

# Thresholds for move classification (from stockfish_worker.py)
INACCURACY_THRESHOLD = 100
MISTAKE_THRESHOLD = 200
BLUNDER_THRESHOLD = 300


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


def get_hanging_squares(board: chess.Board, color: chess.Color) -> List[chess.Square]:
    """Return squares where `color` has a piece that can be captured for free."""
    hanging = []
    for sq in chess.SQUARES:
        piece = board.piece_at(sq)
        if piece is None or piece.color != color or piece.piece_type == chess.KING:
            continue
        enemy_attackers = board.attackers(not color, sq)
        if not enemy_attackers:
            continue
        own_defenders = board.attackers(color, sq)
        if not own_defenders:
            hanging.append(sq)
            continue
        min_atk = min(
            PIECE_VALUES.get(board.piece_at(s).piece_type, 0)
            for s in enemy_attackers
            if board.piece_at(s)
        )
        if min_atk < PIECE_VALUES.get(piece.piece_type, 0):
            hanging.append(sq)
    return hanging


def detect_phase(ply: int, board: chess.Board) -> str:
    piece_count = len(board.piece_map())
    if ply <= 20:
        return "opening"
    if piece_count <= 12:
        return "endgame"
    return "middlegame"