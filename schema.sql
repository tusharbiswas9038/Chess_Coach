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
    phase           TEXT CHECK(phase IN ('opening','middlegame','endgame'))
);

CREATE INDEX idx_moves_game_id ON moves(game_id);
CREATE UNIQUE INDEX idx_moves_game_ply_unique ON moves(game_id, ply);
CREATE INDEX idx_moves_classification ON moves(classification);
CREATE INDEX idx_moves_hanging ON moves(is_hanging_piece) WHERE is_hanging_piece = 1;

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
    is_critical     INTEGER DEFAULT 0  -- biggest eval swing in game?
);
CREATE INDEX idx_mistakes_game_critical_loss ON mistakes(game_id, is_critical, eval_loss DESC);

-- ── SRS DRILL QUEUE ───────────────────────────────────────────────
CREATE TABLE srs_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    mistake_id      INTEGER REFERENCES mistakes(id) ON DELETE CASCADE,
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
