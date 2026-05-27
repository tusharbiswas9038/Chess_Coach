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
    Labels are carried forward from the previous snapshot for matching
    cluster_keys so the LLM doesn't re-label identical patterns on every run.
    """
    window_days = max(1, min(int(window_days or DEFAULT_WINDOW_DAYS), 180))

    with db_conn() as conn:
        # Map of cluster_key -> coach_label from the most recent prior
        # snapshot, used to carry labels forward.
        try:
            prior_rows = conn.execute(
                """
                SELECT cluster_key, coach_label
                FROM mistake_motifs
                WHERE computed_at = (SELECT MAX(computed_at) FROM mistake_motifs)
                  AND coach_label IS NOT NULL AND coach_label != ''
                """
            ).fetchall()
            prior_labels = {r["cluster_key"]: r["coach_label"] for r in prior_rows}
        except sqlite3.OperationalError:
            prior_labels = {}
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

        # Persist this snapshot, carrying labels forward when the cluster
        # key matches the most recent prior snapshot.
        for m in motifs:
            forwarded_label = prior_labels.get(m["cluster_key"])
            forwarded_at = "datetime('now')" if forwarded_label else "NULL"
            sql = f"""
                INSERT INTO mistake_motifs
                    (window_days, cluster_key, subtype, phase, opening_family,
                     occurrences, avg_eval_loss, latest_date,
                     example_game_id, example_played, example_best,
                     coach_label, labeled_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, {forwarded_at})
            """
            conn.execute(
                sql,
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
                    forwarded_label,
                ),
            )
            if forwarded_label:
                m["coach_label"] = forwarded_label

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
                   coach_label, labeled_at,
                   computed_at, window_days
            FROM mistake_motifs
            WHERE computed_at = ?
            ORDER BY occurrences DESC, avg_eval_loss DESC
            LIMIT ?
            """,
            (latest["ts"], max(1, min(int(limit), 25))),
        ).fetchall()
        return [dict(r) for r in rows]


def clear_motif_labels() -> int:
    """
    Wipe all coach_label values so the next analyze/player-model job will
    regenerate them. Use when the model output style changes or a labels
    refresh is wanted manually. Returns rows affected.
    """
    with db_conn() as conn:
        cur = conn.execute(
            "UPDATE mistake_motifs SET coach_label=NULL, labeled_at=NULL "
            "WHERE coach_label IS NOT NULL"
        )
        conn.commit()
        cleared = cur.rowcount or 0
    log.info("mistake_motifs labels cleared rows=%d", cleared)
    return int(cleared)


def label_pending_motifs(max_labels: int = 5, concurrency: int = 2) -> int:
    """
    Generate a one-line coaching label for each top motif row missing one.
    Uses the fast Ollama model. Idempotent — already-labeled rows are skipped.
    Returns the number of labels written.

    Called after compute_mistake_motifs() inside the analyze/player-model jobs.
    Failures are logged and swallowed; an unlabeled motif still renders correctly.

    Runs all labeling in a single async pass with bounded concurrency, so we
    don't spin up a fresh event loop per row.
    """
    with db_conn() as conn:
        rows = conn.execute(
            """
            SELECT id, cluster_key, subtype, phase, opening_family,
                   occurrences, avg_eval_loss, example_played, example_best
            FROM mistake_motifs
            WHERE coach_label IS NULL OR coach_label = ''
            ORDER BY computed_at DESC, occurrences DESC
            LIMIT ?
            """,
            (max(1, int(max_labels)),),
        ).fetchall()
    if not rows:
        return 0

    pending = [dict(r) for r in rows]

    import asyncio as _asyncio

    try:
        results = _asyncio.run(_label_rows_async(pending, max(1, int(concurrency))))
    except Exception as exc:
        log.warning("motif label batch failed: %s", exc)
        return 0

    written = 0
    if results:
        with db_conn() as conn:
            for row_id, label in results:
                if not label:
                    continue
                conn.execute(
                    "UPDATE mistake_motifs SET coach_label=?, labeled_at=datetime('now') WHERE id=?",
                    (label, row_id),
                )
                written += 1
            conn.commit()
    log.info("mistake_motifs labeled rows=%d (of %d pending)", written, len(pending))
    return written


async def _label_rows_async(rows: List[Dict[str, Any]], concurrency: int) -> List[tuple]:
    """
    Label a batch of motif rows concurrently. Concurrency is capped via a
    semaphore because the local Ollama instance gets thrashy under parallel
    7B inference; 2 is a sweet spot on ARM CPU. Returns (row_id, label) tuples
    for rows that produced a usable label; failures are dropped silently
    (already logged) and skipped at write time.
    """
    import asyncio
    from coach.ollama_client import generate

    sem = asyncio.Semaphore(concurrency)

    async def label_one(row: Dict[str, Any]) -> tuple:
        prompt = _build_label_prompt(row)
        async with sem:
            try:
                raw = await generate(prompt, fast=True)
            except Exception as exc:
                log.warning("motif label generation failed for id=%s: %s", row["id"], exc)
                return (row["id"], None)
        label = _sanitize_label((raw or "").strip())
        return (row["id"], label or None)

    return await asyncio.gather(*(label_one(r) for r in rows))


def _build_label_prompt(row: Dict[str, Any]) -> str:
    subtype = (row.get("subtype") or "mistake").replace("_", " ")
    phase = row.get("phase") or "unknown phase"
    family = row.get("opening_family") or "?"
    family_text = f"ECO family {family}" if family and family != "?" else "mixed openings"
    occurrences = int(row.get("occurrences") or 0)
    avg_loss = int(row.get("avg_eval_loss") or 0)
    played = row.get("example_played") or ""
    best = row.get("example_best") or ""
    example_part = (
        f" Example: played {played}, best was {best}." if played and best else ""
    )
    return (
        "You are summarizing a recurring chess mistake pattern as a single short label.\n"
        f"Pattern: {subtype} in {phase}, {family_text}.\n"
        f"Occurrences in recent games: {occurrences}. Average evaluation loss: {avg_loss}cp.{example_part}\n"
        "Write ONE sentence (under 90 characters) that names the pattern in coaching language. "
        "No bullets, no quotes, no preamble. Output only the sentence."
    )


def _sanitize_label(text: str) -> str:
    if not text:
        return ""
    # Take the first non-empty line and trim quotes / bullets the model
    # sometimes adds despite the instruction.
    line = next((s.strip() for s in text.splitlines() if s.strip()), "")
    line = line.lstrip("-•*0123456789. )(").strip()
    if line.startswith(('"', "'")) and line.endswith(('"', "'")) and len(line) >= 2:
        line = line[1:-1].strip()
    if len(line) > 140:
        line = line[:139].rstrip() + "…"
    return line
