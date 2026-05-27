-- schema.sql

PRAGMA journal_mode = WAL;   -- concurrent reads during analysis
PRAGMA foreign_keys = ON;

-- ── GAMES ──────────────────────────────────────────────────────────
CREATE TABLE games (
    id              TEXT PRIMARY KEY,  -- Chess.com game UUID
    pgn             TEXT NOT NULL,
    url             TEXT,
    date            TEXT NOT NULL,     -- ISO 8601
    time_control    TEXT,              -- "600" = 10min
    color           TEXT CHECK(color IN ('white','black')) NOT NULL,
    result          TEXT CHECK(result IN ('win','loss','draw')) NOT NULL,
    termination     TEXT,              -- "checkmate","timeout","resignation"
    white_username  TEXT,
    black_username  TEXT,
    white_rating    INTEGER,
    black_rating    INTEGER,
    opponent_rating INTEGER,
    opening_eco     TEXT,              -- ECO code e.g. "B20"
    opening_name    TEXT,
    analyzed        INTEGER DEFAULT 0, -- 0=pending, 1=done, 2=error
    mistake_count   INTEGER DEFAULT 0, -- New: total mistakes in game
    created_at      TEXT DEFAULT (datetime('now'))
);

-- ── MOVES ──────────────────────────────────────────────────────────
CREATE TABLE moves (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id         TEXT REFERENCES games(id) ON DELETE CASCADE,
    ply             INTEGER NOT NULL,  -- half-moves from start
    move_number     INTEGER,           -- full move number
    color           TEXT CHECK(color IN ('white','black')),
    san             TEXT NOT NULL,     -- "Nf3"
    uci             TEXT NOT NULL,     -- "g1f3"
    fen_before      TEXT NOT NULL,
    fen_after       TEXT NOT NULL,
    eval_before     INTEGER,           -- centipawns, from player's perspective
    eval_after      INTEGER,
    eval_delta      INTEGER,           -- eval_after - eval_before (negative = bad)
    best_move_uci   TEXT,              -- Stockfish's recommendation
    best_move_san   TEXT,
    best_move_eval  INTEGER,
    depth           INTEGER,           -- Stockfish depth used
    clock_before    INTEGER,           -- seconds remaining before move
    clock_after     INTEGER,
    classification  TEXT CHECK(classification IN (
                        'best','excellent','good','inaccuracy',
                        'mistake','blunder','miss','book'
                    )),
    is_hanging_piece INTEGER DEFAULT 0,  -- 1 if player left piece en prise
    tactic_theme    TEXT,              -- "fork","pin","skewer","back_rank", NULL
    phase           TEXT CHECK(phase IN ('opening','middlegame','endgame')),
    analysis_depth_policy TEXT,        -- "light","base","opening_branch","critical"
    candidate_alternatives TEXT,       -- JSON list of top Stockfish alternatives
    plan_text       TEXT,              -- deterministic coaching guidance for critical moments
    practical_impact TEXT,             -- "low","moderate","high","decisive"
    time_pressure_flag INTEGER DEFAULT 0
);

CREATE INDEX idx_moves_game_id ON moves(game_id);
CREATE UNIQUE INDEX idx_moves_game_ply_unique ON moves(game_id, ply);
CREATE INDEX idx_moves_classification ON moves(classification);
CREATE INDEX idx_moves_hanging ON moves(is_hanging_piece) WHERE is_hanging_piece = 1;
CREATE INDEX idx_moves_ply ON moves(ply);

-- ── MISTAKES (denormalized for fast queries) ───────────────────────
CREATE TABLE mistakes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id         TEXT REFERENCES games(id) ON DELETE CASCADE,
    move_id         INTEGER REFERENCES moves(id) ON DELETE CASCADE,
    type            TEXT NOT NULL,     -- "hanging_piece","missed_tactic","blunder"
    theme           TEXT,              -- "fork","pin","skewer"
    phase           TEXT,
    fen             TEXT NOT NULL,     -- position where mistake occurred
    played_move     TEXT NOT NULL,     -- what was played
    best_move       TEXT NOT NULL,     -- what should have been played
    eval_loss       INTEGER,           -- centipawns lost
    is_critical     INTEGER DEFAULT 0, -- biggest eval swing in game?
    mistake_subtype TEXT,              -- v2 subtype: missed_tactic, conversion_miss, etc.
    confidence      REAL,              -- deterministic classifier confidence 0..1
    practical_impact TEXT,
    time_pressure_flag INTEGER DEFAULT 0,
    candidate_alternatives TEXT,       -- JSON alternatives for critical moment review
    plan_text       TEXT
);
CREATE INDEX idx_mistakes_game_critical_loss ON mistakes(game_id, is_critical, eval_loss DESC);

-- ── SRS DRILL QUEUE ───────────────────────────────────────────────
CREATE TABLE srs_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    mistake_id      INTEGER REFERENCES mistakes(id) ON DELETE CASCADE,
    puzzle_id       INTEGER REFERENCES puzzles(id) ON DELETE SET NULL,
    fen             TEXT NOT NULL,
    correct_move    TEXT NOT NULL,     -- UCI
    theme           TEXT,
    -- SM-2 fields
    interval_days   REAL DEFAULT 1,
    ease_factor     REAL DEFAULT 2.5,
    repetitions     INTEGER DEFAULT 0,
    due_date        TEXT DEFAULT (date('now')),
    last_reviewed   TEXT,
    last_result     TEXT CHECK(last_result IN ('easy','good','hard','fail'))
);

CREATE INDEX idx_srs_due ON srs_items(due_date);
CREATE INDEX idx_srs_due_puzzle ON srs_items(due_date, puzzle_id);
CREATE INDEX idx_srs_last_result_due ON srs_items(last_result, due_date);

-- ── PUZZLES GENERATED FROM OWN MISTAKES ──────────────────────────
CREATE TABLE puzzles (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    signature      TEXT NOT NULL UNIQUE,
    fen            TEXT NOT NULL,
    best_move      TEXT NOT NULL,
    motif          TEXT,
    phase          TEXT,
    difficulty     TEXT NOT NULL DEFAULT 'medium',
    source_count   INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT DEFAULT (datetime('now')),
    updated_at     TEXT DEFAULT (datetime('now'))
);

CREATE TABLE puzzle_sources (
    puzzle_id      INTEGER NOT NULL REFERENCES puzzles(id) ON DELETE CASCADE,
    mistake_id     INTEGER NOT NULL REFERENCES mistakes(id) ON DELETE CASCADE,
    PRIMARY KEY (puzzle_id, mistake_id)
);
CREATE INDEX idx_puzzles_motif_difficulty ON puzzles(motif, difficulty);
CREATE INDEX idx_puzzles_phase_motif ON puzzles(phase, motif);

-- ── OPENING REPERTOIRE + TRAINING ────────────────────────────────
CREATE TABLE repertoire_lines (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    color          TEXT NOT NULL CHECK(color IN ('white','black')),
    eco            TEXT,
    name           TEXT NOT NULL,
    line_moves     TEXT NOT NULL,     -- SAN/PGN-style move sequence for recall
    notes          TEXT,
    priority       INTEGER NOT NULL DEFAULT 3 CHECK(priority BETWEEN 1 AND 5),
    active         INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT DEFAULT (datetime('now')),
    updated_at     TEXT DEFAULT (datetime('now'))
);

CREATE TABLE repertoire_nodes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    line_id        INTEGER NOT NULL REFERENCES repertoire_lines(id) ON DELETE CASCADE,
    ply            INTEGER NOT NULL,
    move_san       TEXT,
    move_uci       TEXT,
    fen_after      TEXT,
    note           TEXT,
    trap_warning   TEXT,
    is_key_node    INTEGER NOT NULL DEFAULT 0,
    UNIQUE(line_id, ply)
);

CREATE TABLE opening_training_history (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    line_id        INTEGER REFERENCES repertoire_lines(id) ON DELETE SET NULL,
    node_id        INTEGER REFERENCES repertoire_nodes(id) ON DELETE SET NULL,
    trained_at     TEXT DEFAULT (datetime('now')),
    result         TEXT NOT NULL CHECK(result IN ('remembered','missed','skipped')),
    recall_ms      INTEGER,
    notes          TEXT
);

CREATE INDEX idx_repertoire_lines_color_active_priority ON repertoire_lines(color, active, priority DESC, updated_at DESC);
CREATE INDEX idx_repertoire_lines_eco_color ON repertoire_lines(eco, color);
CREATE INDEX idx_opening_training_history_line_time ON opening_training_history(line_id, trained_at DESC);

-- ── ANALYTICS SNAPSHOTS (SQLite-friendly materialized insights) ──
CREATE TABLE analytics_snapshots (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    computed_at    TEXT DEFAULT (datetime('now')),
    source         TEXT NOT NULL DEFAULT 'job',
    window_days    INTEGER NOT NULL DEFAULT 30,
    payload_json   TEXT NOT NULL
);

CREATE TABLE insight_slice_stats (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id    INTEGER NOT NULL REFERENCES analytics_snapshots(id) ON DELETE CASCADE,
    dimension      TEXT NOT NULL,      -- color, phase, opening_family, opponent_rating, result
    bucket         TEXT NOT NULL,
    games          INTEGER NOT NULL DEFAULT 0,
    analyzed       INTEGER NOT NULL DEFAULT 0,
    wins           INTEGER NOT NULL DEFAULT 0,
    losses         INTEGER NOT NULL DEFAULT 0,
    draws          INTEGER NOT NULL DEFAULT 0,
    mistakes       INTEGER NOT NULL DEFAULT 0,
    blunders       INTEGER NOT NULL DEFAULT 0,
    avg_eval_loss  REAL,
    win_pct        REAL,
    confidence     TEXT NOT NULL DEFAULT 'low'
);

CREATE TABLE trend_deltas (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id    INTEGER NOT NULL REFERENCES analytics_snapshots(id) ON DELETE CASCADE,
    metric         TEXT NOT NULL,
    window_days    INTEGER NOT NULL,
    current_value  REAL NOT NULL DEFAULT 0,
    previous_value REAL NOT NULL DEFAULT 0,
    delta_value    REAL NOT NULL DEFAULT 0,
    direction      TEXT NOT NULL CHECK(direction IN ('up','down','flat')),
    confidence     TEXT NOT NULL DEFAULT 'low',
    sample_size    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_analytics_snapshots_computed_at ON analytics_snapshots(computed_at DESC);
CREATE INDEX idx_insight_slice_snapshot_dimension ON insight_slice_stats(snapshot_id, dimension, bucket);
CREATE INDEX idx_trend_deltas_snapshot_metric ON trend_deltas(snapshot_id, metric, window_days);

-- ── DAILY DRILL SESSIONS ─────────────────────────────────────────
CREATE TABLE drill_sessions (
    date        TEXT PRIMARY KEY,
    item_ids    TEXT NOT NULL,        -- JSON ordered SRS item IDs for the day
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
);

-- ── COACH QUALITY LOOP ────────────────────────────────────────────
CREATE TABLE coach_sessions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at       TEXT DEFAULT (datetime('now')),
    mode             TEXT NOT NULL DEFAULT 'quick_answer',
    user_message     TEXT NOT NULL,
    assistant_reply  TEXT NOT NULL,
    context_digest   TEXT,
    user_rating      INTEGER       -- thumbs feedback for memory weighting (NULL=unrated)
);

CREATE TABLE coach_feedback (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id       INTEGER REFERENCES coach_sessions(id) ON DELETE CASCADE,
    created_at       TEXT DEFAULT (datetime('now')),
    rating           INTEGER CHECK(rating BETWEEN 1 AND 5),
    feedback         TEXT
);
CREATE INDEX idx_coach_sessions_created_mode ON coach_sessions(created_at DESC, mode);

-- ── PLAYER PROFILE (single row, upserted) ─────────────────────────
CREATE TABLE player_profile (
    id                      INTEGER PRIMARY KEY DEFAULT 1,
    username                TEXT NOT NULL,
    current_rating          INTEGER,
    peak_rating             INTEGER,
    games_analyzed          INTEGER DEFAULT 0,
    hanging_piece_rate      REAL,      -- pct of games with >= 1 hanging piece
    blunder_per_game        REAL,      -- rolling avg
    accuracy_avg            REAL,
    favorite_opening_white  TEXT,
    favorite_opening_black  TEXT,
    style_tactical          REAL,      -- 0.0-1.0
    style_attacking         REAL,
    style_solid             REAL,
    weak_phase              TEXT,      -- "opening","middlegame","endgame"
    top_mistake_theme       TEXT,      -- "hanging_piece","fork_missed"
    last_synced             TEXT,
    updated_at              TEXT DEFAULT (datetime('now'))
);

-- ── PLAYER MODEL SNAPSHOTS (append-only coaching profile history) ──
CREATE TABLE player_model_snapshots (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    computed_at             TEXT DEFAULT (datetime('now')),
    source                  TEXT NOT NULL DEFAULT 'job',
    games_analyzed          INTEGER NOT NULL DEFAULT 0,
    window_days             INTEGER NOT NULL DEFAULT 90,
    current_rating          INTEGER,
    blunders_per_game       REAL,
    hanging_piece_rate      REAL,
    weak_phase              TEXT,
    top_mistake_type        TEXT,
    top_mistake_theme       TEXT,
    favorite_opening_white  TEXT,
    favorite_opening_black  TEXT,
    style_tactical          REAL,
    style_attacking         REAL,
    style_solid             REAL,
    behavioral_tags         TEXT,
    stability_score         REAL,
    payload_json            TEXT NOT NULL
);

-- ── GAME JOURNAL ──────────────────────────────────────────────────
CREATE TABLE journal_entries (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id         TEXT REFERENCES games(id) ON DELETE CASCADE UNIQUE,
    summary_md      TEXT NOT NULL,     -- Markdown coaching report
    coach_note      TEXT,              -- Ollama-generated insight
    critical_fen    TEXT,              -- position of biggest eval swing
    critical_move   TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
);

-- ── SESSION LOG ───────────────────────────────────────────────────
CREATE TABLE sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    date            TEXT NOT NULL,
    games_played    INTEGER DEFAULT 0,
    accuracy_avg    REAL,
    result_sequence TEXT,              -- "W,L,L,W" for tilt detection
    tilt_detected   INTEGER DEFAULT 0
);

CREATE INDEX idx_games_date ON games(date DESC);
CREATE INDEX idx_games_analyzed ON games(analyzed);
CREATE INDEX idx_games_analyzed_date ON games(analyzed, date DESC);
CREATE INDEX idx_games_color_result_analyzed_date ON games(color, result, analyzed, date DESC);
CREATE INDEX idx_games_opening_eco_color_analyzed ON games(opening_eco, color, analyzed);
CREATE INDEX idx_games_opponent_rating_date ON games(opponent_rating DESC, date DESC);
CREATE INDEX idx_mistakes_type_phase ON mistakes(type, phase);
CREATE INDEX idx_mistakes_game_type_eval_loss ON mistakes(game_id, type, eval_loss DESC);
CREATE INDEX idx_mistakes_subtype_phase_eval_loss ON mistakes(mistake_subtype, phase, eval_loss DESC);
CREATE INDEX idx_mistakes_game_id ON mistakes(game_id);
CREATE INDEX idx_mistakes_type ON mistakes(type);
CREATE INDEX idx_sessions_date ON sessions(date DESC);
CREATE INDEX idx_player_model_snapshots_computed_at ON player_model_snapshots(computed_at DESC);

-- ── DB MIGRATIONS TRACKING ────────────────────────────────────────
-- Used by api/db_migrations.py to apply idempotent schema/index fixes.
CREATE TABLE IF NOT EXISTS schema_migrations (
    id          TEXT PRIMARY KEY,
    applied_at  TEXT DEFAULT (datetime('now'))
);

-- ── JOB LEDGER (durable record of background jobs) ─────────────────
CREATE TABLE IF NOT EXISTS job_ledger (
    job_id        TEXT PRIMARY KEY,
    kind          TEXT NOT NULL,
    payload_json  TEXT,
    status        TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed')),
    enqueued_at   TEXT NOT NULL DEFAULT (datetime('now')),
    started_at    TEXT,
    finished_at   TEXT,
    duration_ms   INTEGER,
    error         TEXT,
    retry_count   INTEGER NOT NULL DEFAULT 0,
    max_retries   INTEGER NOT NULL DEFAULT 0,
    next_retry_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_ledger_status_enqueued ON job_ledger(status, enqueued_at);
CREATE INDEX IF NOT EXISTS idx_job_ledger_finished ON job_ledger(finished_at DESC);

-- ── REPERTOIRE NODE SRS (SM-2 schedule for opening recall) ─────────
CREATE TABLE IF NOT EXISTS repertoire_node_srs (
    node_id        INTEGER PRIMARY KEY REFERENCES repertoire_nodes(id) ON DELETE CASCADE,
    line_id        INTEGER REFERENCES repertoire_lines(id) ON DELETE CASCADE,
    interval_days  REAL NOT NULL DEFAULT 1,
    ease_factor    REAL NOT NULL DEFAULT 2.5,
    repetitions    INTEGER NOT NULL DEFAULT 0,
    due_date       TEXT NOT NULL DEFAULT (date('now')),
    last_reviewed  TEXT,
    last_result    TEXT CHECK(last_result IN ('remembered','missed','skipped')),
    updated_at     TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_repertoire_node_srs_due ON repertoire_node_srs(due_date, last_result);

-- ── MISTAKE MOTIFS (rule-based recurring-pattern clusters) ─────────
CREATE TABLE IF NOT EXISTS mistake_motifs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    computed_at     TEXT NOT NULL DEFAULT (datetime('now')),
    window_days     INTEGER NOT NULL DEFAULT 30,
    cluster_key     TEXT NOT NULL,
    subtype         TEXT,
    phase           TEXT,
    opening_family  TEXT,
    occurrences     INTEGER NOT NULL DEFAULT 0,
    avg_eval_loss   REAL,
    latest_date     TEXT,
    example_game_id TEXT,
    example_played  TEXT,
    example_best    TEXT,
    coach_label     TEXT,
    labeled_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_mistake_motifs_recent ON mistake_motifs(computed_at DESC, occurrences DESC);
CREATE INDEX IF NOT EXISTS idx_mistake_motifs_key ON mistake_motifs(cluster_key, computed_at DESC);

-- ── WHAT-IF ATTEMPTS (interactive Stockfish queries from review board) ──
CREATE TABLE IF NOT EXISTS whatif_attempts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    fen             TEXT NOT NULL,
    attempted_uci   TEXT NOT NULL,
    best_uci        TEXT,
    eval_before     INTEGER,
    eval_after      INTEGER,
    delta_cp        INTEGER,
    depth           INTEGER
);
CREATE INDEX IF NOT EXISTS idx_whatif_attempts_recent ON whatif_attempts(created_at DESC);
