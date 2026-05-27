"""
Recurring mistake motif clustering.

Rule-based for now: cluster mistakes from the recent window by
(subtype, phase, opening_family). The opening_family is the first character
of the ECO code (A/B/C/D/E), which corresponds to the standard ECO grouping.

Cluster keys with low occurrence counts are filtered out — a "motif" is
something the player has done at least 3 times in the window.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from api.db import db_conn

log = logging.getLogger("chess_coach.mistake_motifs")

MIN_OCCURRENCES = 3
DEFAULT_WINDOW_DAYS = 30
RETENTION_KEEP = 5  # keep the last N snapshots in mistake_motifs


def _opening_family(eco: Optional[str]) -> Optional[str]:
    if not eco:
        return None
    eco = str(eco).strip().upper()
    if not eco or eco[0] not in {"A", "B", "C", "D", "E"}:
        return None
    return eco[0]


def compute_mistake_motifs(window_days: int = DEFAULT_WINDOW_DAYS) -> List[Dict[str, Any]]:
    """
    Compute recurring-pattern clusters from the last N days, persist them, and
    return the list. Older snapshots are pruned to keep storage bounded.
    """
    window_days = max(1, min(int(window_days or DEFAULT_WINDOW_DAYS), 180))

    with db_conn() as conn:
        rows = conn.execute(
            """
            SELECT
                COALESCE(m.mistake_subtype, m.type)            AS subtype,
                COALESCE(m.phase, 'unknown')                   AS phase,
                COALESCE(g.opening_eco, '')                    AS opening_eco,
                m.eval_loss                                    AS eval_loss,
                g.id                                           AS game_id,
                g.date                                         AS game_date,
                m.played_move                                  AS played,
                m.best_move                                    AS best_move
            FROM mistakes m
            JOIN games g ON g.id = m.game_id
            WHERE g.date >= datetime('now', ?)
            """,
            (f"-{window_days} days",),
        ).fetchall()

        clusters: Dict[str, Dict[str, Any]] = {}
        for r in rows:
            family = _opening_family(r["opening_eco"]) or "?"
            cluster_key = f"{r['subtype']}|{r['phase']}|{family}"
            bucket = clusters.setdefault(
                cluster_key,
                {
                    "cluster_key": cluster_key,
                    "subtype": r["subtype"],
                    "phase": r["phase"],
                    "opening_family": family,
                    "occurrences": 0,
                    "eval_loss_sum": 0,
                    "latest_date": None,
                    "example_game_id": None,
                    "example_played": None,
                    "example_best": None,
                },
            )
            bucket["occurrences"] += 1
            bucket["eval_loss_sum"] += int(r["eval_loss"] or 0)
            game_date = r["game_date"]
            if game_date and (bucket["latest_date"] is None or game_date > bucket["latest_date"]):
                bucket["latest_date"] = game_date
                bucket["example_game_id"] = r["game_id"]
                bucket["example_played"] = r["played"]
                bucket["example_best"] = r["best_move"]

        motifs = []
        for bucket in clusters.values():
            if bucket["occurrences"] < MIN_OCCURRENCES:
                continue
            avg = round(bucket["eval_loss_sum"] / bucket["occurrences"], 1)
            motifs.append(
                {
                    "cluster_key": bucket["cluster_key"],
                    "subtype": bucket["subtype"],
                    "phase": bucket["phase"],
                    "opening_family": bucket["opening_family"],
                    "occurrences": bucket["occurrences"],
                    "avg_eval_loss": avg,
                    "latest_date": bucket["latest_date"],
                    "example_game_id": bucket["example_game_id"],
                    "example_played": bucket["example_played"],
                    "example_best": bucket["example_best"],
                }
            )

        motifs.sort(key=lambda m: (m["occurrences"], m["avg_eval_loss"]), reverse=True)

        # Persist this snapshot
        for m in motifs:
            conn.execute(
                """
                INSERT INTO mistake_motifs
                    (window_days, cluster_key, subtype, phase, opening_family,
                     occurrences, avg_eval_loss, latest_date,
                     example_game_id, example_played, example_best)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    window_days,
                    m["cluster_key"],
                    m["subtype"],
                    m["phase"],
                    m["opening_family"],
                    m["occurrences"],
                    m["avg_eval_loss"],
                    m["latest_date"],
                    m["example_game_id"],
                    m["example_played"],
                    m["example_best"],
                ),
            )

        # Prune older snapshots — keep latest RETENTION_KEEP distinct computed_at groups.
        keep_cutoff = conn.execute(
            """
            SELECT computed_at FROM mistake_motifs
            GROUP BY computed_at
            ORDER BY computed_at DESC
            LIMIT 1 OFFSET ?
            """,
            (RETENTION_KEEP,),
        ).fetchone()
        if keep_cutoff:
            conn.execute(
                "DELETE FROM mistake_motifs WHERE computed_at <= ?",
                (keep_cutoff[0],),
            )

        conn.commit()

    log.info("mistake_motifs computed window=%sd clusters=%d", window_days, len(motifs))
    return motifs


def get_latest_motifs(limit: int = 5) -> List[Dict[str, Any]]:
    """Most recent motif snapshot, top N by occurrence."""
    with db_conn() as conn:
        latest = conn.execute(
            "SELECT MAX(computed_at) AS ts FROM mistake_motifs"
        ).fetchone()
        if not latest or not latest["ts"]:
            return []
        rows = conn.execute(
            """
            SELECT cluster_key, subtype, phase, opening_family,
                   occurrences, avg_eval_loss, latest_date,
                   example_game_id, example_played, example_best,
                   computed_at, window_days
            FROM mistake_motifs
            WHERE computed_at = ?
            ORDER BY occurrences DESC, avg_eval_loss DESC
            LIMIT ?
            """,
            (latest["ts"], max(1, min(int(limit), 25))),
        ).fetchall()
        return [dict(r) for r in rows]
