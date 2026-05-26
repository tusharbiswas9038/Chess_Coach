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
    context_digest   TEXT
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
