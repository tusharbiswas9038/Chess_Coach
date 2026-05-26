import sqlite3
import chess
from datetime import date, timedelta
from typing import Any, List, Dict, Optional

from api.db import db_conn

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

    def get_blunder_heatmap_data(self, phase: Optional[str] = None) -> Dict[str, int]:
        params: List[Any] = []
        phase_clause = ""
        if phase:
            phase_clause = " AND phase = ? "
            params.append(phase)
        blunders = self.conn.execute("""
            SELECT fen, played_move FROM mistakes
            WHERE (
                type IN ('blunder', 'hanging_piece')
                OR mistake_subtype IN ('tactical_blunder', 'missed_tactic')
            )
            """ + phase_clause + """
        """, params).fetchall()

        heatmap: Dict[str, int] = {}
        for blunder in blunders:
            try:
                board = chess.Board(blunder["fen"])
                move = chess.Move.from_uci(blunder["played_move"])
                target_square = chess.square_name(move.to_square)
                heatmap[target_square] = heatmap.get(target_square, 0) + 1
            except Exception:
                continue
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
