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


def _move_is_tactical(board: chess.Board, move: chess.Move | None) -> bool:
    if move is None:
        return False
    return (
        board.is_capture(move)
        or board.gives_check(move)
        or move.promotion is not None
    )


def _impact_label(eval_loss: int) -> str:
    if eval_loss >= 700:
        return "decisive"
    if eval_loss >= BLUNDER_THRESHOLD:
        return "high"
    if eval_loss >= MISTAKE_THRESHOLD:
        return "moderate"
    return "low"


def classify_mistake_v2(
    board: chess.Board,
    played_move: chess.Move,
    best_move_uci: str | None,
    delta: int,
    phase: str | None,
    is_hanging_piece: bool,
    eval_before: int | None = None,
    clock_before: int | None = None,
) -> Dict[str, Any]:
    """Return richer deterministic coaching labels for a poor move.

    This intentionally stays heuristic-based. Stockfish provides the eval and
    best line; this layer turns that into stable product labels without adding
    LLM latency to the analysis worker.
    """
    eval_loss = abs(delta)
    best_move = None
    if best_move_uci:
        try:
            candidate = chess.Move.from_uci(best_move_uci)
            if candidate in board.legal_moves:
                best_move = candidate
        except ValueError:
            best_move = None

    played_tactical = _move_is_tactical(board, played_move)
    best_tactical = _move_is_tactical(board, best_move)
    winning_position = eval_before is not None and eval_before >= 250
    time_pressure = clock_before is not None and clock_before <= 60

    if phase == "opening" and eval_loss < BLUNDER_THRESHOLD:
        subtype = "opening_inaccuracy"
        confidence = 0.72
    elif is_hanging_piece or (eval_loss >= BLUNDER_THRESHOLD and played_tactical):
        subtype = "tactical_blunder"
        confidence = 0.88
    elif best_tactical and not played_tactical and eval_loss >= MISTAKE_THRESHOLD:
        subtype = "missed_tactic"
        confidence = 0.84
    elif winning_position and eval_loss >= MISTAKE_THRESHOLD:
        subtype = "conversion_miss"
        confidence = 0.78
    else:
        subtype = "strategic_concession"
        confidence = 0.66

    if eval_loss >= 600:
        confidence = min(0.95, confidence + 0.07)
    elif eval_loss < MISTAKE_THRESHOLD:
        confidence = max(0.55, confidence - 0.08)
    if time_pressure:
        confidence = max(0.55, confidence - 0.05)

    plan_text = {
        "tactical_blunder": "Before committing, check loose pieces and forcing replies against your last move.",
        "missed_tactic": "Scan forcing moves first: checks, captures, threats, then compare the engine candidate.",
        "strategic_concession": "Improve the worst-placed piece and avoid conceding a long-term structural or activity edge.",
        "conversion_miss": "When better, reduce counterplay first, then convert with simple forcing improvements.",
        "opening_inaccuracy": "Review this opening branch and prioritize development, king safety, and central control.",
    }.get(subtype, "Review the candidate move and write one habit to prevent this pattern.")

    return {
        "mistake_subtype": subtype,
        "confidence": round(confidence, 2),
        "practical_impact": _impact_label(eval_loss),
        "time_pressure_flag": 1 if time_pressure else 0,
        "plan_text": plan_text,
    }


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
