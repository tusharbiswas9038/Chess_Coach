import sqlite3
import chess
from datetime import date, timedelta
from typing import Any, List, Dict, Optional

from api.db import db_conn
from api.services.slow_query import track_slow_queries

def rows(cursor_result) -> List[Dict[str, Any]]:
    return [dict(r) for r in cursor_result]

def row(r) -> Optional[Dict[str, Any]]:
    return dict(r) if r else None

class GameRepository:
    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn

    def get_game_by_id(self, game_id: str) -> Optional[Dict[str, Any]]:
        return row(self.conn.execute("SELECT * FROM games WHERE id=?", (game_id,)).fetchone())

    def get_moves_for_game(self, game_id: str) -> List[Dict[str, Any]]:
        return rows(self.conn.execute("SELECT * FROM moves WHERE game_id=? ORDER BY ply", (game_id,)).fetchall())

    def get_mistakes_for_game(self, game_id: str) -> List[Dict[str, Any]]:
        return rows(self.conn.execute("SELECT * FROM mistakes WHERE game_id=? ORDER BY is_critical DESC, eval_loss DESC", (game_id,)).fetchall())

    def get_journal_entry_for_game(self, game_id: str) -> Optional[Dict[str, Any]]:
        return row(self.conn.execute("SELECT * FROM journal_entries WHERE game_id=?", (game_id,)).fetchone())

    def get_critical_moment_for_game(self, game_id: str) -> Optional[Dict[str, Any]]:
        return row(self.conn.execute("""
            SELECT * FROM mistakes
            WHERE game_id=? AND is_critical=1
            LIMIT 1
        """, (game_id,)).fetchone())

    def get_sessions(self, limit: int) -> List[Dict[str, Any]]:
        return rows(self.conn.execute("""
            SELECT * FROM sessions
            ORDER BY date DESC LIMIT ?
        """, (limit,)).fetchall())

    def get_today_session(self) -> Optional[Dict[str, Any]]:
        return row(self.conn.execute("""
            SELECT * FROM sessions WHERE date = date('now')
        """).fetchone())

    def get_opening_genome_data(self, eco: str, color: str) -> Dict[str, Any]:
        total_games = self.conn.execute(
            """
            SELECT COUNT(*) AS total
            FROM games g
            WHERE g.opening_eco=? AND g.color=? AND g.analyzed=1
            """,
            (eco, color),
        ).fetchone()["total"]

        ply_rows = self.conn.execute(
            """
            SELECT
                m.ply AS ply,
                COUNT(*) AS total,
                SUM(CASE WHEN g.result='win' THEN 1 ELSE 0 END) AS wins
            FROM games g
            JOIN moves m ON m.game_id = g.id
            WHERE g.opening_eco=? AND g.color=? AND g.analyzed=1 AND m.ply <= 20
            GROUP BY m.ply
            ORDER BY m.ply
            """,
            (eco, color),
        ).fetchall()
        return {
            "total_games": total_games,
            "ply_rows": rows(ply_rows)
        }

    def get_openings_summary(self, limit: int = 200) -> List[Dict[str, Any]]:
        return rows(
            self.conn.execute(
                """
                SELECT
                    g.opening_eco AS eco,
                    COALESCE(MAX(NULLIF(g.opening_name, '')), 'Unknown opening') AS name,
                    g.color AS color,
                    COUNT(*) AS games,
                    SUM(CASE WHEN g.result = 'win' THEN 1 ELSE 0 END) AS wins,
                    ROUND(
                        100.0 * SUM(CASE WHEN g.result = 'win' THEN 1 ELSE 0 END) / COUNT(*),
                        1
                    ) AS win_pct
                FROM games g
                WHERE g.analyzed = 1
                  AND g.opening_eco IS NOT NULL
                  AND TRIM(g.opening_eco) <> ''
                GROUP BY g.opening_eco, g.color
                ORDER BY games DESC, eco ASC
                LIMIT ?
                """,
                (max(1, min(limit, 1000)),),
            ).fetchall()
        )

    @track_slow_queries("game_repository.get_opening_weak_nodes")
    def get_opening_weak_nodes(self, limit: int = 12, color: Optional[str] = None) -> List[Dict[str, Any]]:
        params: List[Any] = []
        color_clause = ""
        if color in {"white", "black"}:
            color_clause = " AND g.color = ?"
            params.append(color)

        node_rows = rows(
            self.conn.execute(
                """
                SELECT
                    g.opening_eco AS eco,
                    COALESCE(MAX(NULLIF(g.opening_name, '')), 'Unknown opening') AS name,
                    g.color AS color,
                    m.ply AS ply,
                    COUNT(*) AS games,
                    SUM(CASE WHEN g.result = 'win' THEN 1 ELSE 0 END) AS wins,
                    ROUND(AVG(COALESCE(m.eval_after, 0)), 1) AS avg_eval_after,
                    SUM(CASE WHEN m.classification IN ('inaccuracy','mistake','blunder','miss') THEN 1 ELSE 0 END) AS issue_moves,
                    SUM(CASE WHEN m.classification = 'blunder' THEN 1 ELSE 0 END) AS blunders
                FROM games g
                JOIN moves m ON m.game_id = g.id
                WHERE g.analyzed = 1
                  AND g.opening_eco IS NOT NULL
                  AND TRIM(g.opening_eco) <> ''
                  AND m.ply BETWEEN 2 AND 20
                  """ + color_clause + """
                GROUP BY g.opening_eco, g.color, m.ply
                HAVING games >= 3
                ORDER BY g.opening_eco, g.color, m.ply
                """,
                params,
            ).fetchall()
        )

        previous_by_line: Dict[tuple[str, str], Dict[str, Any]] = {}
        weak_nodes: List[Dict[str, Any]] = []
        for item in node_rows:
            key = (str(item["eco"] or ""), str(item["color"] or ""))
            games = int(item["games"] or 0)
            wins = int(item["wins"] or 0)
            win_pct = round((wins / games) * 100, 1) if games else 0.0
            issue_rate = round((int(item["issue_moves"] or 0) / games) * 100, 1) if games else 0.0
            previous = previous_by_line.get(key)
            drop = round(win_pct - float(previous["win_pct"]), 1) if previous else 0.0
            eval_drop = (
                round(float(item["avg_eval_after"] or 0) - float(previous["avg_eval_after"] or 0), 1)
                if previous
                else 0.0
            )
            previous_by_line[key] = {
                "win_pct": win_pct,
                "avg_eval_after": float(item["avg_eval_after"] or 0),
            }
            if drop > -8 and win_pct >= 42 and issue_rate < 25 and eval_drop > -80:
                continue
            severity = abs(min(drop, 0)) + max(0, 45 - win_pct) + max(0, issue_rate - 20) / 2 + max(0, -eval_drop) / 40
            weak_nodes.append(
                {
                    "eco": item["eco"],
                    "name": item["name"],
                    "color": item["color"],
                    "ply": int(item["ply"] or 0),
                    "games": games,
                    "win_pct": win_pct,
                    "drop_pct": drop,
                    "avg_eval_after": float(item["avg_eval_after"] or 0),
                    "eval_drop": eval_drop,
                    "issue_rate": issue_rate,
                    "blunders": int(item["blunders"] or 0),
                    "severity": round(severity, 1),
                    "reason": self._opening_weak_node_reason(drop, win_pct, issue_rate, eval_drop),
                }
            )

        return sorted(weak_nodes, key=lambda x: (x["severity"], x["games"]), reverse=True)[: max(1, min(limit, 50))]

    @staticmethod
    def _opening_weak_node_reason(drop: float, win_pct: float, issue_rate: float, eval_drop: float) -> str:
        if drop <= -15:
            return "Win rate collapses at this ply."
        if eval_drop <= -120:
            return "Engine trend drops sharply in this branch."
        if issue_rate >= 35:
            return "Mistakes cluster around this node."
        if win_pct < 42:
            return "This line performs below your repertoire baseline."
        return "This node deserves review before adding more lines."

    def get_repertoire_lines(self, color: Optional[str] = None, active_only: bool = True) -> List[Dict[str, Any]]:
        params: List[Any] = []
        where = ["1=1"]
        if color in {"white", "black"}:
            where.append("l.color = ?")
            params.append(color)
        if active_only:
            where.append("l.active = 1")
        return rows(
            self.conn.execute(
                """
                SELECT
                    l.*,
                    COUNT(h.id) AS training_count,
                    SUM(CASE WHEN h.result = 'missed' THEN 1 ELSE 0 END) AS missed_count,
                    MAX(h.trained_at) AS last_trained_at
                FROM repertoire_lines l
                LEFT JOIN opening_training_history h ON h.line_id = l.id
                WHERE """ + " AND ".join(where) + """
                GROUP BY l.id
                ORDER BY l.active DESC, l.priority DESC, l.updated_at DESC, l.id DESC
                """,
                params,
            ).fetchall()
        )

    def create_repertoire_line(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        cur = self.conn.execute(
            """
            INSERT INTO repertoire_lines(color, eco, name, line_moves, notes, priority)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                payload["color"],
                payload.get("eco"),
                payload["name"],
                payload["line_moves"],
                payload.get("notes"),
                payload.get("priority", 3),
            ),
        )
        self.conn.commit()
        return self.get_repertoire_line(int(cur.lastrowid)) or {}

    def get_repertoire_line(self, line_id: int) -> Optional[Dict[str, Any]]:
        return row(
            self.conn.execute(
                """
                SELECT
                    l.*,
                    COUNT(h.id) AS training_count,
                    SUM(CASE WHEN h.result = 'missed' THEN 1 ELSE 0 END) AS missed_count,
                    MAX(h.trained_at) AS last_trained_at
                FROM repertoire_lines l
                LEFT JOIN opening_training_history h ON h.line_id = l.id
                WHERE l.id = ?
                GROUP BY l.id
                """,
                (line_id,),
            ).fetchone()
        )

    def update_repertoire_line(self, line_id: int, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        existing = self.get_repertoire_line(line_id)
        if not existing:
            return None
        next_values = {
            "color": payload.get("color", existing["color"]),
            "eco": payload.get("eco", existing["eco"]),
            "name": payload.get("name", existing["name"]),
            "line_moves": payload.get("line_moves", existing["line_moves"]),
            "notes": payload.get("notes", existing["notes"]),
            "priority": payload.get("priority", existing["priority"]),
            "active": payload.get("active", existing["active"]),
        }
        self.conn.execute(
            """
            UPDATE repertoire_lines
            SET color=?, eco=?, name=?, line_moves=?, notes=?, priority=?, active=?, updated_at=datetime('now')
            WHERE id=?
            """,
            (
                next_values["color"],
                next_values["eco"],
                next_values["name"],
                next_values["line_moves"],
                next_values["notes"],
                next_values["priority"],
                next_values["active"],
                line_id,
            ),
        )
        self.conn.commit()
        return self.get_repertoire_line(line_id)

    def delete_repertoire_line(self, line_id: int) -> bool:
        cur = self.conn.execute("DELETE FROM repertoire_lines WHERE id=?", (line_id,))
        self.conn.commit()
        return cur.rowcount > 0

    def record_opening_training(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        cur = self.conn.execute(
            """
            INSERT INTO opening_training_history(line_id, node_id, result, recall_ms, notes)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                payload.get("line_id"),
                payload.get("node_id"),
                payload["result"],
                payload.get("recall_ms"),
                payload.get("notes"),
            ),
        )
        history_id = cur.lastrowid

        # Bridge to SRS: when a node is identified, update its SM-2 schedule.
        # remembered → quality 2 (good); missed → quality 0 (fail); skipped → no-op.
        node_id = payload.get("node_id")
        line_id = payload.get("line_id")
        result = payload["result"]
        srs_update = None
        if node_id and result in {"remembered", "missed"}:
            from drills.srs_scheduler import sm2_update

            row_existing = self.conn.execute(
                "SELECT interval_days, ease_factor, repetitions FROM repertoire_node_srs WHERE node_id=?",
                (node_id,),
            ).fetchone()
            if row_existing:
                interval = float(row_existing["interval_days"] or 1)
                ease = float(row_existing["ease_factor"] or 2.5)
                reps = int(row_existing["repetitions"] or 0)
            else:
                interval, ease, reps = 1.0, 2.5, 0

            quality = 2 if result == "remembered" else 0
            new_interval, new_ease, new_reps = sm2_update(interval, ease, reps, quality)

            self.conn.execute(
                """
                INSERT INTO repertoire_node_srs (
                    node_id, line_id, interval_days, ease_factor, repetitions,
                    due_date, last_reviewed, last_result, updated_at
                )
                VALUES (?, ?, ?, ?, ?, date('now', '+' || CAST(? AS TEXT) || ' days'), date('now'), ?, datetime('now'))
                ON CONFLICT(node_id) DO UPDATE SET
                    line_id=excluded.line_id,
                    interval_days=excluded.interval_days,
                    ease_factor=excluded.ease_factor,
                    repetitions=excluded.repetitions,
                    due_date=excluded.due_date,
                    last_reviewed=excluded.last_reviewed,
                    last_result=excluded.last_result,
                    updated_at=excluded.updated_at
                """,
                (
                    node_id,
                    line_id,
                    new_interval,
                    new_ease,
                    new_reps,
                    int(round(new_interval)),
                    result,
                ),
            )
            srs_update = {
                "node_id": node_id,
                "interval_days": new_interval,
                "ease_factor": new_ease,
                "repetitions": new_reps,
                "result": result,
            }

        self.conn.commit()
        record = row(self.conn.execute("SELECT * FROM opening_training_history WHERE id=?", (history_id,)).fetchone()) or {}
        if srs_update:
            record["srs"] = srs_update
        return record

    def get_opening_training_queue(self, color: Optional[str] = None, limit: int = 8) -> Dict[str, Any]:
        lines = self.get_repertoire_lines(color=color, active_only=True)
        lines = sorted(
            lines,
            key=lambda item: (
                int(item.get("missed_count") or 0),
                int(item.get("priority") or 0),
                0 if item.get("last_trained_at") else 1,
            ),
            reverse=True,
        )[: max(1, min(limit, 25))]
        weak_nodes = self.get_opening_weak_nodes(limit=5, color=color)

        # SRS-due nodes: those whose schedule has matured. Bias surfacing
        # toward the most recently missed lines to keep the bridge meaningful.
        params: list = []
        color_filter = ""
        clean_color = (color or "").lower().strip()
        if clean_color in {"white", "black"}:
            color_filter = "AND l.color = ?"
            params.append(clean_color)
        params.append(max(1, min(limit, 25)))
        due_rows = self.conn.execute(
            f"""
            SELECT n.id AS node_id, n.line_id, n.ply, n.move_san, n.move_uci,
                   n.fen_after, n.note, n.is_key_node,
                   l.name AS line_name, l.eco, l.color,
                   srs.due_date, srs.last_result, srs.repetitions, srs.ease_factor
            FROM repertoire_node_srs srs
            JOIN repertoire_nodes n ON n.id = srs.node_id
            JOIN repertoire_lines l ON l.id = n.line_id
            WHERE srs.due_date <= date('now') AND l.active = 1
              {color_filter}
            ORDER BY
                CASE srs.last_result WHEN 'missed' THEN 0 ELSE 1 END,
                srs.due_date ASC,
                srs.repetitions ASC
            LIMIT ?
            """,
            params,
        ).fetchall()
        srs_due_nodes = [dict(r) for r in due_rows]

        return {
            "lines": lines,
            "weak_nodes": weak_nodes,
            "srs_due_nodes": srs_due_nodes,
            "focus": weak_nodes[0] if weak_nodes else None,
        }

    @track_slow_queries("game_repository.get_stats")
    def get_stats(self, drills_ok: bool) -> Dict[str, Any]:
        profile = self.conn.execute(
            "SELECT * FROM player_profile WHERE id=1"
        ).fetchone()

        totals = self.conn.execute("""
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN analyzed=1 THEN 1 ELSE 0 END) AS analyzed,
                SUM(CASE WHEN analyzed=0 THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN analyzed=2 THEN 1 ELSE 0 END) AS errors
            FROM games
        """).fetchone()

        hanging_games = self.conn.execute(
            "SELECT COUNT(DISTINCT game_id) FROM moves WHERE is_hanging_piece=1"
        ).fetchone()[0]

        blunders = self.conn.execute("""
            SELECT
                COUNT(*) AS total_blunders,
                COUNT(DISTINCT game_id) AS games_with_blunders
            FROM mistakes
            WHERE type IN ('blunder','hanging_piece')
        """).fetchone()

        recent_games = self.conn.execute("""
            SELECT
                g.id, g.date, g.color, g.result,
                g.opponent_rating, g.analyzed,
                g.opening_eco, g.opening_name,
                g.mistake_count
            FROM games g
            ORDER BY g.date DESC
            LIMIT 10
        """).fetchall()

        mistake_breakdown = self.conn.execute("""
            SELECT type, COUNT(*) AS count
            FROM mistakes
            GROUP BY type
            ORDER BY count DESC
        """).fetchall()

        weekly_stats = self.conn.execute("""
            SELECT
                date(date, 'weekday 1', '-7 days') AS week_start,
                COUNT(*) AS games,
                SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) AS wins,
                ROUND(
                    100.0 * SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) / COUNT(*),
                    1
                ) AS win_pct
            FROM games
            GROUP BY week_start
            ORDER BY week_start DESC
            LIMIT 8
        """).fetchall()

        drills_due = 0
        drill_summary = {
            "due_total": 0,
            "session_limit": 15,
            "goal_target": 5,
            "today": {
                "date": "",
                "done": 0,
                "correct": 0,
                "wrong": 0,
                "goal_done": False,
            },
            "streak": 0,
        }
        if drills_ok:
            drills_due = self.conn.execute(
                "SELECT COUNT(*) FROM srs_items WHERE due_date <= date('now')"
            ).fetchone()[0]
            today_drills = self.conn.execute(
                """
                SELECT
                    date('now') AS day,
                    COUNT(*) AS done,
                    SUM(CASE WHEN last_result IN ('good', 'easy') THEN 1 ELSE 0 END) AS correct,
                    SUM(CASE WHEN last_result IN ('fail', 'hard') THEN 1 ELSE 0 END) AS wrong
                FROM srs_items
                WHERE last_reviewed = date('now')
                """
            ).fetchone()
            review_days = self.conn.execute(
                """
                SELECT last_reviewed AS day, COUNT(*) AS done
                FROM srs_items
                WHERE last_reviewed IS NOT NULL
                GROUP BY last_reviewed
                ORDER BY last_reviewed DESC
                LIMIT 365
                """
            ).fetchall()
            done_by_day = {r["day"]: int(r["done"] or 0) for r in review_days}
            streak = 0
            cursor_day = date.today()
            while done_by_day.get(cursor_day.isoformat(), 0) >= 5:
                streak += 1
                cursor_day -= timedelta(days=1)
            drill_summary = {
                "due_total": int(drills_due or 0),
                "session_limit": 15,
                "goal_target": 5,
                "today": {
                    "date": today_drills["day"] or "",
                    "done": int(today_drills["done"] or 0),
                    "correct": int(today_drills["correct"] or 0),
                    "wrong": int(today_drills["wrong"] or 0),
                    "goal_done": int(today_drills["done"] or 0) >= 5,
                },
                "streak": streak,
            }

        return {
            "profile": row(profile),
            "totals": dict(totals),
            "hanging_games": hanging_games,
            "blunders": dict(blunders),
            "recent_games": rows(recent_games),
            "mistake_breakdown": rows(mistake_breakdown),
            "weekly_stats": rows(weekly_stats),
            "drills_due": drills_due,
            "drill_summary": drill_summary,
        }

    def get_analysis_progress(self) -> Dict[str, Any]:
        return row(self.conn.execute("""
            SELECT
                SUM(CASE WHEN analyzed=1 THEN 1 ELSE 0 END) AS done,
                SUM(CASE WHEN analyzed=0 THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN analyzed=2 THEN 1 ELSE 0 END) AS errors,
                COUNT(*) AS total
            FROM games
        """).fetchone())

    def get_mistakes_by_phase(self, phase: Optional[str] = None) -> List[Dict[str, Any]]:
        where = "WHERE phase IS NOT NULL"
        params: List[Any] = []
        if phase:
            where += " AND phase = ?"
            params.append(phase)
        return rows(self.conn.execute("""
            SELECT phase, COUNT(*) AS count
            FROM mistakes
            """ + where + """
            GROUP BY phase
            ORDER BY count DESC
        """, params).fetchall())

    @track_slow_queries("game_repository.get_critical_mistakes")
    def get_critical_mistakes(self, limit: int, phase: Optional[str] = None) -> List[Dict[str, Any]]:
        phase_clause = ""
        params: List[Any] = []
        if phase:
            phase_clause = " AND m.phase = ? "
            params.append(phase)
        params.append(limit)
        return rows(self.conn.execute("""
            SELECT
                m.game_id,
                g.date AS game_date,
                m.type,
                m.mistake_subtype,
                m.phase,
                m.played_move,
                m.best_move,
                m.eval_loss,
                m.confidence,
                m.practical_impact,
                m.time_pressure_flag,
                m.candidate_alternatives,
                m.plan_text
            FROM mistakes m
            JOIN games g ON g.id = m.game_id
            WHERE m.is_critical = 1
              AND g.analyzed = 1
              """ + phase_clause + """
            ORDER BY g.date DESC
            LIMIT ?
        """, params).fetchall())

    @track_slow_queries("game_repository.get_weekly_error_motifs")
    def get_weekly_error_motifs(self, limit: int = 3, phase: Optional[str] = None) -> List[Dict[str, Any]]:
        phase_clause = ""
        params: List[Any] = []
        if phase:
            phase_clause = " AND m.phase = ? "
            params.append(phase)
        params.append(max(1, min(limit, 10)))
        return rows(self.conn.execute("""
            SELECT
                m.type,
                COALESCE(m.mistake_subtype, m.type) AS mistake_subtype,
                COALESCE(m.phase, 'unknown') AS phase,
                COUNT(*) AS count,
                ROUND(AVG(COALESCE(m.eval_loss, 0)), 1) AS avg_eval_loss
            FROM mistakes m
            JOIN games g ON g.id = m.game_id
            WHERE g.date >= datetime('now', '-7 days')
            """ + phase_clause + """
            GROUP BY m.type, COALESCE(m.mistake_subtype, m.type), COALESCE(m.phase, 'unknown')
            ORDER BY count DESC, avg_eval_loss DESC
            LIMIT ?
        """, params).fetchall())

    def get_tables_and_counts(self) -> Dict[str, Optional[int]]:
        raw_tables = self.conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall()
        
        valid_table_names = {t["name"] for t in raw_tables}
        counts = {}
        for t in raw_tables:
            name = t["name"]
            if name in valid_table_names:
                try:
                    counts[name] = self.conn.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0]
                except Exception:
                    counts[name] = None
            else:
                counts[name] = None
        return counts

    def list_games(
        self,
        limit: int,
        offset: int,
        search: Optional[str],
        opening: Optional[str],
        color: Optional[str],
        result: Optional[str],
        analyzed: Optional[int],
        min_mistakes: int,
        has_journal: Optional[bool],
        sort: str,
        valid_sorts: Dict[str, str],
        return_total: bool,
    ) -> Any:
        inner_where: List[str] = []
        inner_params: List[Any] = []
        outer_where: List[str] = []
        outer_params: List[Any] = []

        if search and (term := search.strip().lower()):
            like = f"%{term}%"
            inner_where.append("""
                (
                    LOWER(COALESCE(g.opening_name, '')) LIKE ?
                    OR LOWER(COALESCE(g.opening_eco, '')) LIKE ?
                    OR CAST(COALESCE(g.opponent_rating, '') AS TEXT) LIKE ?
                    OR LOWER(COALESCE(g.date, '')) LIKE ?
                )
            """)
            inner_params.extend([like, like, like, like])

        if opening and (term := opening.strip().lower()):
            like = f"%{term}%"
            inner_where.append("""
                (
                    LOWER(COALESCE(g.opening_name, '')) LIKE ?
                    OR LOWER(COALESCE(g.opening_eco, '')) LIKE ?
                )
            """)
            inner_params.extend([like, like])

        if color:
            inner_where.append("g.color = ?")
            inner_params.append(color)

        if result:
            inner_where.append("g.result = ?")
            inner_params.append(result)

        if analyzed is not None:
            inner_where.append("g.analyzed = ?")
            inner_params.append(analyzed)

        if min_mistakes > 0:
            outer_where.append("mistake_count >= ?")
            outer_params.append(min_mistakes)

        if has_journal is not None:
            outer_where.append("has_journal = ?")
            outer_params.append(1 if has_journal else 0)

        inner_clause = f"WHERE {' AND '.join(inner_where)}" if inner_where else ""
        outer_clause = f"WHERE {' AND '.join(outer_where)}" if outer_where else ""

        cte = f"""
            WITH game_rows AS (
                SELECT
                    g.id, g.date, g.color, g.result,
                    g.time_control, g.opponent_rating, g.analyzed,
                    g.opening_eco, g.opening_name,
                    g.mistake_count,
                    j.coach_note,
                    CASE WHEN j.id IS NULL THEN 0 ELSE 1 END AS has_journal
                FROM games g
                LEFT JOIN journal_entries j ON j.game_id = g.id
                {inner_clause}
            )
        """

        result_rows = self.conn.execute(
            cte
            + f"""
            SELECT *
            FROM game_rows
            {outer_clause}
            ORDER BY {valid_sorts[sort]}
            LIMIT ? OFFSET ?
            """,
            (*inner_params, *outer_params, limit, offset),
        ).fetchall()

        items = rows(result_rows)
        if not return_total:
            return items

        total = self.conn.execute(
            cte
            + f"""
            SELECT COUNT(*) AS total
            FROM game_rows
            {outer_clause}
            """,
            (*inner_params, *outer_params),
        ).fetchone()["total"]
        return {
            "items": items,
            "total": total,
            "limit": limit,
            "offset": offset,
        }

    @track_slow_queries("game_repository.get_blunder_heatmap_data")
    def get_blunder_heatmap_data(self, phase: Optional[str] = None) -> Dict[str, int]:
        """
        Heatmap of blunder/hanging-piece destination squares.

        The to-square is the 3rd-4th characters of the UCI move string
        (`e2e4` -> `e4`, `e7e8q` -> `e8`). We aggregate that directly in SQL
        rather than parsing 10k+ FENs through python-chess — empirically
        the FEN/Move parsing was 750ms vs ~15ms for the SQL itself.
        """
        params: List[Any] = []
        phase_clause = ""
        if phase:
            phase_clause = " AND phase = ? "
            params.append(phase)
        rows = self.conn.execute("""
            SELECT
                LOWER(SUBSTR(played_move, 3, 2)) AS sq,
                COUNT(*) AS cnt
            FROM mistakes
            WHERE played_move IS NOT NULL
              AND LENGTH(played_move) >= 4
              AND (
                type IN ('blunder', 'hanging_piece')
                OR mistake_subtype IN ('tactical_blunder', 'missed_tactic')
              )
            """ + phase_clause + """
            GROUP BY sq
        """, params).fetchall()

        heatmap: Dict[str, int] = {}
        for row in rows:
            sq = row["sq"]
            # Defensive: skip rows where the substring isn't a real square.
            if (
                isinstance(sq, str)
                and len(sq) == 2
                and sq[0] in "abcdefgh"
                and sq[1] in "12345678"
            ):
                heatmap[sq] = int(row["cnt"] or 0)
        return heatmap

    def get_weekly_focus_snapshot(self) -> Dict[str, Any]:
        recent_mistakes = rows(self.conn.execute("""
            SELECT
                m.type,
                COALESCE(m.mistake_subtype, m.type) AS mistake_subtype,
                m.phase,
                COUNT(*) AS cnt,
                ROUND(AVG(COALESCE(m.eval_loss, 0)), 1) AS avg_loss
            FROM mistakes m
            JOIN games g ON g.id = m.game_id
            WHERE g.date >= datetime('now', '-14 days')
            GROUP BY m.type, COALESCE(m.mistake_subtype, m.type), m.phase
            ORDER BY cnt DESC, avg_loss DESC
        """).fetchall())

        prior_mistakes_total = self.conn.execute("""
            SELECT COUNT(*) AS cnt
            FROM mistakes m
            JOIN games g ON g.id = m.game_id
            WHERE g.date >= datetime('now', '-28 days')
              AND g.date < datetime('now', '-14 days')
        """).fetchone()["cnt"] or 0

        recent_mistakes_total = sum(int(r["cnt"]) for r in recent_mistakes)

        due_drills = self.conn.execute(
            "SELECT COUNT(*) AS cnt FROM srs_items WHERE due_date <= date('now')"
        ).fetchone()["cnt"] or 0

        recent_games = self.conn.execute("""
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN analyzed = 1 THEN 1 ELSE 0 END) AS analyzed
            FROM games
            WHERE date >= datetime('now', '-14 days')
        """).fetchone()

        return {
            "recent_mistakes": recent_mistakes,
            "recent_mistakes_total": recent_mistakes_total,
            "prior_mistakes_total": prior_mistakes_total,
            "due_drills": due_drills,
            "recent_games_total": recent_games["total"] or 0,
            "recent_games_analyzed": recent_games["analyzed"] or 0,
        }
