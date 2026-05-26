import json
import logging
from typing import Any, Dict, Optional

from api.db import db_conn

log = logging.getLogger("chess_coach.player_model")


def _row_to_dict(row) -> Optional[Dict[str, Any]]:
    return dict(row) if row else None


def _score_ratio(numerator: int, denominator: int) -> float:
    if denominator <= 0:
        return 0.0
    return round(max(0.0, min(1.0, numerator / denominator)), 3)


def _build_snapshot_payload(conn) -> Dict[str, Any]:
    totals = conn.execute(
        """
        SELECT
            COUNT(*) AS total_games,
            SUM(CASE WHEN analyzed = 1 THEN 1 ELSE 0 END) AS analyzed_games,
            MAX(date) AS latest_game_date
        FROM games
        """
    ).fetchone()

    rating_row = conn.execute(
        """
        SELECT
            CASE
                WHEN color = 'white' THEN white_rating
                WHEN color = 'black' THEN black_rating
            END AS current_rating
        FROM games
        WHERE analyzed = 1
          AND (
              (color = 'white' AND white_rating IS NOT NULL AND white_rating > 0)
              OR (color = 'black' AND black_rating IS NOT NULL AND black_rating > 0)
          )
        ORDER BY date DESC
        LIMIT 1
        """
    ).fetchone()

    peak_rating = conn.execute(
        """
        SELECT MAX(player_rating) AS peak_rating
        FROM (
            SELECT
                CASE
                    WHEN color = 'white' THEN white_rating
                    WHEN color = 'black' THEN black_rating
                END AS player_rating
            FROM games
            WHERE analyzed = 1
        )
        WHERE player_rating IS NOT NULL AND player_rating > 0
        """
    ).fetchone()

    mistakes = conn.execute(
        """
        SELECT
            COUNT(*) AS total_mistakes,
            SUM(CASE WHEN type IN ('blunder', 'hanging_piece') THEN 1 ELSE 0 END) AS severe_mistakes,
            SUM(CASE WHEN type = 'hanging_piece' THEN 1 ELSE 0 END) AS hanging_piece_mistakes,
            AVG(COALESCE(eval_loss, 0)) AS avg_eval_loss
        FROM mistakes
        """
    ).fetchone()

    weak_phase = conn.execute(
        """
        SELECT COALESCE(phase, 'unknown') AS phase, COUNT(*) AS count
        FROM mistakes
        GROUP BY COALESCE(phase, 'unknown')
        ORDER BY count DESC
        LIMIT 1
        """
    ).fetchone()

    top_mistake = conn.execute(
        """
        SELECT type, COALESCE(theme, '') AS theme, COUNT(*) AS count
        FROM mistakes
        GROUP BY type, COALESCE(theme, '')
        ORDER BY count DESC
        LIMIT 1
        """
    ).fetchone()

    favorite_white = conn.execute(
        """
        SELECT opening_eco, COALESCE(MAX(NULLIF(opening_name, '')), 'Unknown opening') AS opening_name, COUNT(*) AS games
        FROM games
        WHERE color = 'white' AND opening_eco IS NOT NULL AND TRIM(opening_eco) <> ''
        GROUP BY opening_eco
        ORDER BY games DESC
        LIMIT 1
        """
    ).fetchone()

    favorite_black = conn.execute(
        """
        SELECT opening_eco, COALESCE(MAX(NULLIF(opening_name, '')), 'Unknown opening') AS opening_name, COUNT(*) AS games
        FROM games
        WHERE color = 'black' AND opening_eco IS NOT NULL AND TRIM(opening_eco) <> ''
        GROUP BY opening_eco
        ORDER BY games DESC
        LIMIT 1
        """
    ).fetchone()

    due_drills = conn.execute(
        "SELECT COUNT(*) AS count FROM srs_items WHERE due_date <= date('now')"
    ).fetchone()

    recent = conn.execute(
        """
        SELECT
            COUNT(*) AS games,
            SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) AS wins,
            SUM(CASE WHEN result = 'draw' THEN 1 ELSE 0 END) AS draws
        FROM games
        WHERE date >= datetime('now', '-30 days')
        """
    ).fetchone()

    analyzed_games = int(totals["analyzed_games"] or 0)
    severe_mistakes = int(mistakes["severe_mistakes"] or 0)
    hanging_mistakes = int(mistakes["hanging_piece_mistakes"] or 0)
    total_mistakes = int(mistakes["total_mistakes"] or 0)

    blunders_per_game = round(severe_mistakes / analyzed_games, 2) if analyzed_games else 0.0
    hanging_piece_rate = round(hanging_mistakes / analyzed_games, 4) if analyzed_games else 0.0
    tactical_style = _score_ratio(total_mistakes - hanging_mistakes, max(total_mistakes, 1))
    solid_style = round(1.0 - min(1.0, blunders_per_game / 3.0), 3)
    attacking_style = _score_ratio(int(recent["wins"] or 0), int(recent["games"] or 0))
    recent_games = int(recent["games"] or 0)
    tags = []
    if blunders_per_game >= 3:
        tags.append("tactical volatility")
    if hanging_piece_rate >= 0.4:
        tags.append("piece safety risk")
    if attacking_style >= 0.55:
        tags.append("initiative converts")
    if solid_style >= 0.65:
        tags.append("stable converter")
    if weaknesses := weak_phase["phase"] if weak_phase else None:
        tags.append(f"{weaknesses} leak")
    stability_score = round(
        max(0.0, min(1.0, (solid_style * 0.5) + (min(recent_games, 30) / 30 * 0.25) + ((1 - min(1.0, hanging_piece_rate)) * 0.25))),
        3,
    )

    return {
        "computed_at": None,
        "window_days": 90,
        "sample": {
            "total_games": int(totals["total_games"] or 0),
            "analyzed_games": analyzed_games,
            "latest_game_date": totals["latest_game_date"],
            "recent_30d_games": int(recent["games"] or 0),
        },
        "rating": {
            "current": rating_row["current_rating"] if rating_row else None,
            "peak": peak_rating["peak_rating"] if peak_rating else None,
        },
        "weaknesses": {
            "weak_phase": weak_phase["phase"] if weak_phase else None,
            "top_mistake_type": top_mistake["type"] if top_mistake else None,
            "top_mistake_theme": top_mistake["theme"] if top_mistake and top_mistake["theme"] else None,
            "blunders_per_game": blunders_per_game,
            "hanging_piece_rate": hanging_piece_rate,
            "avg_eval_loss": round(mistakes["avg_eval_loss"] or 0, 1),
            "due_drills": int(due_drills["count"] or 0),
        },
        "openings": {
            "favorite_white": _row_to_dict(favorite_white),
            "favorite_black": _row_to_dict(favorite_black),
        },
        "style": {
            "tactical": tactical_style,
            "attacking": attacking_style,
            "solid": solid_style,
        },
        "model_v2": {
            "behavioral_tags": tags[:5] or ["baseline building"],
            "stability_score": stability_score,
            "stability_label": "stable" if stability_score >= 0.7 else "swingy" if stability_score < 0.45 else "developing",
            "confidence": "high" if analyzed_games >= 100 else "medium" if analyzed_games >= 30 else "low",
        },
    }


def compute_and_store_player_model_snapshot(source: str = "job") -> Dict[str, Any]:
    with db_conn() as conn:
        payload = _build_snapshot_payload(conn)
        snapshot_json = json.dumps(payload, sort_keys=True)
        weaknesses = payload["weaknesses"]
        openings = payload["openings"]
        style = payload["style"]
        model_v2 = payload["model_v2"]
        sample = payload["sample"]
        rating = payload["rating"]

        conn.execute(
            """
            INSERT INTO player_model_snapshots (
                source,
                games_analyzed,
                window_days,
                current_rating,
                blunders_per_game,
                hanging_piece_rate,
                weak_phase,
                top_mistake_type,
                top_mistake_theme,
                favorite_opening_white,
                favorite_opening_black,
                style_tactical,
                style_attacking,
                style_solid,
                behavioral_tags,
                stability_score,
                payload_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                source,
                sample["analyzed_games"],
                payload["window_days"],
                rating["current"],
                weaknesses["blunders_per_game"],
                weaknesses["hanging_piece_rate"],
                weaknesses["weak_phase"],
                weaknesses["top_mistake_type"],
                weaknesses["top_mistake_theme"],
                openings["favorite_white"]["opening_eco"] if openings["favorite_white"] else None,
                openings["favorite_black"]["opening_eco"] if openings["favorite_black"] else None,
                style["tactical"],
                style["attacking"],
                style["solid"],
                json.dumps(model_v2["behavioral_tags"]),
                model_v2["stability_score"],
                snapshot_json,
            ),
        )

        snapshot_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO player_profile (
                id,
                username,
                current_rating,
                peak_rating,
                games_analyzed,
                hanging_piece_rate,
                blunder_per_game,
                favorite_opening_white,
                favorite_opening_black,
                style_tactical,
                style_attacking,
                style_solid,
                weak_phase,
                top_mistake_theme,
                updated_at
            )
            VALUES (1, COALESCE((SELECT username FROM player_profile WHERE id = 1), 'player'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(id) DO UPDATE SET
                current_rating = excluded.current_rating,
                peak_rating = excluded.peak_rating,
                games_analyzed = excluded.games_analyzed,
                hanging_piece_rate = excluded.hanging_piece_rate,
                blunder_per_game = excluded.blunder_per_game,
                favorite_opening_white = excluded.favorite_opening_white,
                favorite_opening_black = excluded.favorite_opening_black,
                style_tactical = excluded.style_tactical,
                style_attacking = excluded.style_attacking,
                style_solid = excluded.style_solid,
                weak_phase = excluded.weak_phase,
                top_mistake_theme = excluded.top_mistake_theme,
                updated_at = excluded.updated_at
            """,
            (
                rating["current"],
                rating["peak"],
                sample["analyzed_games"],
                weaknesses["hanging_piece_rate"],
                weaknesses["blunders_per_game"],
                openings["favorite_white"]["opening_eco"] if openings["favorite_white"] else None,
                openings["favorite_black"]["opening_eco"] if openings["favorite_black"] else None,
                style["tactical"],
                style["attacking"],
                style["solid"],
                weaknesses["weak_phase"],
                weaknesses["top_mistake_theme"] or weaknesses["top_mistake_type"],
            ),
        )
        conn.commit()

        created = conn.execute(
            "SELECT * FROM player_model_snapshots WHERE id = ?",
            (snapshot_id,),
        ).fetchone()

    result = snapshot_to_dto(created)
    log.info(
        "player model snapshot computed id=%s source=%s games_analyzed=%s",
        result["id"],
        source,
        result["games_analyzed"],
    )
    return result


def snapshot_to_dto(row) -> Dict[str, Any]:
    data = dict(row)
    payload = json.loads(data.get("payload_json") or "{}")
    payload["computed_at"] = data["computed_at"]
    return {
        "id": data["id"],
        "source": data["source"],
        "computed_at": data["computed_at"],
        "games_analyzed": data["games_analyzed"],
        "window_days": data["window_days"],
        "summary": {
            "current_rating": data["current_rating"],
            "blunders_per_game": data["blunders_per_game"],
            "hanging_piece_rate": data["hanging_piece_rate"],
            "weak_phase": data["weak_phase"],
            "top_mistake_type": data["top_mistake_type"],
            "top_mistake_theme": data["top_mistake_theme"],
            "favorite_opening_white": data["favorite_opening_white"],
            "favorite_opening_black": data["favorite_opening_black"],
            "style_tactical": data["style_tactical"],
            "style_attacking": data["style_attacking"],
            "style_solid": data["style_solid"],
            "behavioral_tags": json.loads(data.get("behavioral_tags") or "[]"),
            "stability_score": data.get("stability_score"),
        },
        "payload": payload,
    }


def get_latest_player_model_snapshot() -> Optional[Dict[str, Any]]:
    with db_conn() as conn:
        row = conn.execute(
            """
            SELECT *
            FROM player_model_snapshots
            ORDER BY computed_at DESC, id DESC
            LIMIT 1
            """
        ).fetchone()
    return snapshot_to_dto(row) if row else None
