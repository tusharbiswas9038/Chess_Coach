import sqlite3
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
        if drills_ok:
            drills_due = self.conn.execute(
                "SELECT COUNT(*) FROM srs_items WHERE due_date <= date('now')"
            ).fetchone()[0]

        return {
            "profile": row(profile),
            "totals": dict(totals),
            "hanging_games": hanging_games,
            "blunders": dict(blunders),
            "recent_games": rows(recent_games),
            "mistake_breakdown": rows(mistake_breakdown),
            "weekly_stats": rows(weekly_stats),
            "drills_due": drills_due,
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

    def get_mistakes_by_phase(self) -> List[Dict[str, Any]]:
        return rows(self.conn.execute("""
            SELECT phase, COUNT(*) AS count
            FROM mistakes
            WHERE phase IS NOT NULL
            GROUP BY phase
            ORDER BY count DESC
        """).fetchall())

    def get_tables_and_counts(self) -> Dict[str, Optional[int]]:
        # Safely retrieve table names. This is less vulnerable as we control `name`.
        # However, for robustness, we'll still use a whitelist for the count query.
        raw_tables = self.conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall()
        
        # Create a whitelist of expected table names to prevent SQL injection
        # in the dynamic COUNT(*) query.
        # This list should be kept up-to-date with your schema.
        # For simplicity, we'll build it from the queried tables, but a hardcoded
        # list might be more secure if sqlite_master itself could be tampered with.
        valid_table_names = {t["name"] for t in raw_tables}

        counts = {}
        for t in raw_tables:
            name = t["name"]
            # Only execute COUNT for known, whitelisted table names
            if name in valid_table_names:
                try:
                    # Use parameter binding if possible, but for table NAMES it's tricky.
                    # String formatting is generally discouraged for identifiers,
                    # but if names are whitelisted, it mitigates the risk.
                    counts[name] = self.conn.execute(f"SELECT COUNT(*) FROM \"{name}\"").fetchone()[0]
                except Exception:
                    counts[name] = None
            else:
                counts[name] = None # Or raise an error if an unknown table is encountered
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
    ) -> Any: # Returns List[Dict] or Dict with total
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
