import json
import logging
from typing import Any, Dict, List

from api.db import db_conn

log = logging.getLogger("chess_coach.analytics")


def _confidence(sample_size: int) -> str:
    if sample_size >= 30:
        return "high"
    if sample_size >= 10:
        return "medium"
    return "low"


def _direction(delta: float, threshold: float = 0.05) -> str:
    if delta > threshold:
        return "up"
    if delta < -threshold:
        return "down"
    return "flat"


def _bucket_rating(value: Any) -> str:
    try:
        rating = int(value or 0)
    except (TypeError, ValueError):
        return "unknown"
    if rating <= 0:
        return "unknown"
    if rating < 800:
        return "<800"
    if rating < 1000:
        return "800-999"
    if rating < 1200:
        return "1000-1199"
    if rating < 1400:
        return "1200-1399"
    if rating < 1600:
        return "1400-1599"
    return "1600+"


def _opening_family(eco: Any) -> str:
    clean = str(eco or "").strip().upper()
    return clean[:1] if clean else "unknown"


def _metric_for_window(conn, window_days: int, offset_days: int = 0) -> Dict[str, Any]:
    start_expr = f"datetime('now', '-{window_days + offset_days} days')"
    end_clause = "" if offset_days == 0 else f"AND g.date < datetime('now', '-{offset_days} days')"
    row = conn.execute(
        f"""
        SELECT
            COUNT(DISTINCT g.id) AS games,
            SUM(CASE WHEN g.result='win' THEN 1 ELSE 0 END) AS wins,
            COUNT(m.id) AS mistakes,
            SUM(CASE WHEN m.type IN ('blunder','hanging_piece') OR m.mistake_subtype IN ('tactical_blunder','missed_tactic') THEN 1 ELSE 0 END) AS blunders
        FROM games g
        LEFT JOIN mistakes m ON m.game_id = g.id
        WHERE g.date >= {start_expr}
          {end_clause}
        """
    ).fetchone()
    games = int(row["games"] or 0)
    wins = int(row["wins"] or 0)
    mistakes = int(row["mistakes"] or 0)
    blunders = int(row["blunders"] or 0)
    return {
        "games": games,
        "win_rate": round(wins / games, 4) if games else 0.0,
        "mistakes_per_game": round(mistakes / games, 3) if games else 0.0,
        "blunders_per_game": round(blunders / games, 3) if games else 0.0,
    }


def _slice_rows(conn, dimension: str, bucket_sql: str) -> List[Dict[str, Any]]:
    return [
        dict(row)
        for row in conn.execute(
            f"""
            SELECT
                {bucket_sql} AS bucket,
                COUNT(DISTINCT g.id) AS games,
                COUNT(DISTINCT CASE WHEN g.analyzed=1 THEN g.id END) AS analyzed,
                COUNT(DISTINCT CASE WHEN g.result='win' THEN g.id END) AS wins,
                COUNT(DISTINCT CASE WHEN g.result='loss' THEN g.id END) AS losses,
                COUNT(DISTINCT CASE WHEN g.result='draw' THEN g.id END) AS draws,
                COUNT(m.id) AS mistakes,
                SUM(CASE WHEN m.type IN ('blunder','hanging_piece') OR m.mistake_subtype IN ('tactical_blunder','missed_tactic') THEN 1 ELSE 0 END) AS blunders,
                ROUND(AVG(COALESCE(m.eval_loss, 0)), 1) AS avg_eval_loss
            FROM games g
            LEFT JOIN mistakes m ON m.game_id = g.id
            WHERE g.date >= datetime('now', '-90 days')
            GROUP BY bucket
            HAVING games > 0
            ORDER BY games DESC, bucket ASC
            LIMIT 20
            """
        ).fetchall()
        if row["bucket"] is not None
    ]


def _build_slices(conn) -> List[Dict[str, Any]]:
    raw_groups = {
        "color": _slice_rows(conn, "color", "COALESCE(g.color, 'unknown')"),
        "result": _slice_rows(conn, "result", "COALESCE(g.result, 'unknown')"),
        "phase": _slice_rows(conn, "phase", "COALESCE(m.phase, 'unknown')"),
        "opening_family": _slice_rows(conn, "opening_family", "SUBSTR(COALESCE(NULLIF(g.opening_eco, ''), 'unknown'), 1, 1)"),
        "opponent_rating": [],
    }

    rating_rows = conn.execute(
        """
        SELECT id, opponent_rating FROM games
        WHERE date >= datetime('now', '-90 days')
        """
    ).fetchall()
    rating_case = {}
    for row in rating_rows:
        rating_case[row["id"]] = _bucket_rating(row["opponent_rating"])
    if rating_case:
        buckets = sorted(set(rating_case.values()))
        for bucket in buckets:
            ids = [game_id for game_id, b in rating_case.items() if b == bucket]
            placeholders = ",".join("?" for _ in ids)
            if not placeholders:
                continue
            item = conn.execute(
                f"""
                SELECT
                    COUNT(DISTINCT g.id) AS games,
                    COUNT(DISTINCT CASE WHEN g.analyzed=1 THEN g.id END) AS analyzed,
                    COUNT(DISTINCT CASE WHEN g.result='win' THEN g.id END) AS wins,
                    COUNT(DISTINCT CASE WHEN g.result='loss' THEN g.id END) AS losses,
                    COUNT(DISTINCT CASE WHEN g.result='draw' THEN g.id END) AS draws,
                    COUNT(m.id) AS mistakes,
                    SUM(CASE WHEN m.type IN ('blunder','hanging_piece') OR m.mistake_subtype IN ('tactical_blunder','missed_tactic') THEN 1 ELSE 0 END) AS blunders,
                    ROUND(AVG(COALESCE(m.eval_loss, 0)), 1) AS avg_eval_loss
                FROM games g
                LEFT JOIN mistakes m ON m.game_id = g.id
                WHERE g.id IN ({placeholders})
                """,
                ids,
            ).fetchone()
            raw_groups["opponent_rating"].append({"bucket": bucket, **dict(item)})

    slices: List[Dict[str, Any]] = []
    for dimension, items in raw_groups.items():
        for item in items:
            games = int(item["games"] or 0)
            wins = int(item["wins"] or 0)
            slices.append(
                {
                    "dimension": dimension,
                    "bucket": str(item["bucket"] or "unknown"),
                    "games": games,
                    "analyzed": int(item["analyzed"] or 0),
                    "wins": wins,
                    "losses": int(item["losses"] or 0),
                    "draws": int(item["draws"] or 0),
                    "mistakes": int(item["mistakes"] or 0),
                    "blunders": int(item["blunders"] or 0),
                    "avg_eval_loss": float(item["avg_eval_loss"] or 0),
                    "win_pct": round(wins / games * 100, 1) if games else 0.0,
                    "confidence": _confidence(games),
                }
            )
    return slices


def _build_trends(conn) -> List[Dict[str, Any]]:
    trends: List[Dict[str, Any]] = []
    for window in (7, 14, 30):
        current = _metric_for_window(conn, window, 0)
        previous = _metric_for_window(conn, window, window)
        for metric in ("win_rate", "mistakes_per_game", "blunders_per_game", "games"):
            current_value = float(current[metric])
            previous_value = float(previous[metric])
            delta = round(current_value - previous_value, 4)
            threshold = 0.01 if metric == "win_rate" else 0.1
            trends.append(
                {
                    "metric": metric,
                    "window_days": window,
                    "current_value": current_value,
                    "previous_value": previous_value,
                    "delta_value": delta,
                    "direction": _direction(delta, threshold),
                    "confidence": _confidence(int(current["games"])),
                    "sample_size": int(current["games"]),
                }
            )
    return trends


def compute_and_store_analytics_snapshot(source: str = "job") -> Dict[str, Any]:
    with db_conn() as conn:
        slices = _build_slices(conn)
        trends = _build_trends(conn)
        payload = {
            "window_days": 90,
            "slices": slices,
            "trends": trends,
        }
        conn.execute(
            "INSERT INTO analytics_snapshots(source, window_days, payload_json) VALUES (?, ?, ?)",
            (source, 90, json.dumps(payload, sort_keys=True)),
        )
        snapshot_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
        for item in slices:
            conn.execute(
                """
                INSERT INTO insight_slice_stats (
                    snapshot_id, dimension, bucket, games, analyzed, wins, losses, draws,
                    mistakes, blunders, avg_eval_loss, win_pct, confidence
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    snapshot_id,
                    item["dimension"],
                    item["bucket"],
                    item["games"],
                    item["analyzed"],
                    item["wins"],
                    item["losses"],
                    item["draws"],
                    item["mistakes"],
                    item["blunders"],
                    item["avg_eval_loss"],
                    item["win_pct"],
                    item["confidence"],
                ),
            )
        for item in trends:
            conn.execute(
                """
                INSERT INTO trend_deltas (
                    snapshot_id, metric, window_days, current_value, previous_value,
                    delta_value, direction, confidence, sample_size
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    snapshot_id,
                    item["metric"],
                    item["window_days"],
                    item["current_value"],
                    item["previous_value"],
                    item["delta_value"],
                    item["direction"],
                    item["confidence"],
                    item["sample_size"],
                ),
            )
        conn.commit()
        row = conn.execute("SELECT * FROM analytics_snapshots WHERE id=?", (snapshot_id,)).fetchone()
    result = snapshot_to_dto(row)
    log.info("analytics snapshot computed id=%s source=%s", result["id"], source)
    return result


def snapshot_to_dto(row) -> Dict[str, Any]:
    data = dict(row)
    payload = json.loads(data.get("payload_json") or "{}")
    return {
        "id": data["id"],
        "source": data["source"],
        "computed_at": data["computed_at"],
        "window_days": data["window_days"],
        "slices": payload.get("slices", []),
        "trends": payload.get("trends", []),
    }


def get_latest_analytics_snapshot() -> Dict[str, Any] | None:
    with db_conn() as conn:
        row = conn.execute(
            """
            SELECT *
            FROM analytics_snapshots
            ORDER BY computed_at DESC, id DESC
            LIMIT 1
            """
        ).fetchone()
    return snapshot_to_dto(row) if row else None
