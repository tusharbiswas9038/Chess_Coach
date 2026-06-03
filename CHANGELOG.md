# Changelog

History organized by polish horizon. Each horizon is a tight, themed batch of changes that lands together with smoke-tested verification. Older horizons stay summarized; recent ones carry more detail. Dates are when work landed locally; this is a self-hosted project so there are no published releases.

The original product audit framed this app as "self-hosted single-user, no SaaS pivot." Every horizon follows that constraint. Multi-tenant, billing, marketing pages, and React Native rewrites are explicitly out of scope.

---

## H18.1 — Button system + hover identity sweep (2026-05-29)

Tail end of H18. The button surface had drifted: per-view inconsistencies (Sync/Analyze missing on some pages, yellow flash on dashboard refresh), no hover differentiation, daisyUI's default focus ring fighting the green-as-action rule, and CSS edits not landing in browsers because the service worker was running stale-while-revalidate on the shell.

- **Hover identity matrix.** Five hover roles, each with its own colour story so a user can read the kind of action from the hover alone:
  - Ghost / topbar (`btn-ghost`, `topbar-action-btn`) → **neutral lift** (no saturated colour). Routine actions like Sync, Analyze, filter toggles.
  - Primary (`btn-primary`) → **green CTA** with glow ring. Save, Generate, Add a line.
  - Filter chips (`preset-btn`) → **purple wash** (analytics tone, data-vis adjacency).
  - Flip-board (`flip-btn`) → **teal-blue** ring + tint.
  - Drill quality (`quality-btn[data-q]`) → **per-grade** red/yellow/blue/green matching the SM-2 grade.
  - Documented in `frontend/STYLING_CONTRACT.md` "Button & Hover System".
- **`--hover-*` token group** in `@layer base :root` — `--hover-bg`, `--hover-border`, `--hover-fg`, `--hover-shadow` for ghost; `--hover-cta-*` for primary; `--hover-chip-*` for chips; `--focus-ring` for all roles. Future theme swaps touch one block.
- **DaisyUI cascade workaround.** DaisyUI emits `.btn:hover` in `@layer utilities` which beats `@layer components` regardless of specificity. Hover declarations now use `!important` *and* set daisyUI's own variables (`--btn-bg`, `--btn-fg`, `--btn-border`, `--btn-color`) at the same selector so the cascade can't fight us. Documented in STYLING_CONTRACT so the next contributor doesn't burn an hour rediscovering it.
- **Service worker shell strategy → `networkFirstShell`** (`frontend/sw.js`). Was stale-while-revalidate; CSS/JS edits used to land on the *second* reload, not the first. Bumped `CACHE_VERSION` to `v4` to invalidate older shell caches on next sw boot.
- **CSP `connect-src` allows Google Fonts.** SW prefetched Manrope from `fonts.gstatic.com` / `fonts.googleapis.com`; CSP was rejecting the connection. Added both hosts to `connect-src` in `config.py`.
- **No-inline-style rule for Lit components.** CSP forbids `'unsafe-inline'`; `cc-kpi-card` and `cc-skeleton` previously wrote `style="color: …"` / `style="width: …"` and the styles silently dropped. Replaced with class+attribute selectors (`cc-kpi-icon-{tone}`, `cc-skel-text-line[data-line="N"]`) defined in `tailwind.input.css`. Added to COMPONENT_CONTRACTS conventions.
- **`<cc-section-header variant="toolbar">`** — 20px title for hero-banner panels that pair the header with action buttons. Documented.
- **Topbar buttons standardized.** All views now show Sync + Analyze in the topbar; the per-view allowlist in `navigation.js:updateTopbarActionsForView` was hiding them on mistakes/drills/coach. Mobile Actions menu inline `style.display = 'none'` was also unconditionally set at startup, beating the CSS toggle and breaking the click handler — removed.
- **Dashboard yellow-flash on refresh** — `dashboard.js` was adding `btn-warning` to the Sync button when work was pending, which painted yellow on first paint and then re-painted ghost on hydration. Removed the class addition; kept the tooltip.
- **`view-hero` shell standardized.** All 8 views wrap their hero in `<section class="view-hero">` with `<cc-section-header>`. Coach view's hero was previously nested inside the wizard-shell 2-col grid and read as empty space; lifted out.
- **Auth-first SPA bootstrap.** `app.js` now renders the login gate before binding navigation/actions or loading protected views. A shell startup error can no longer leave production users on a blank page before `/api/auth/session` completes.
- **Docs refreshed:** STYLING_CONTRACT (Button & Hover System), COMPONENT_CONTRACTS (toolbar variant + no-inline-style rule), CHANGELOG.

---

## H18 — Phase C completion: offline drills, cc-stat-pill, more headers (2026-05-28)

Closes Phase C from the H14 redesign blueprint. Three work streams ran in parallel via subagents; orchestrator finished what didn't land cleanly.

- **Residual polish (closes PROJECT_INTELLIGENCE §13 #1–#3, #4).** Plain `<span class="quality-pill">` markup in `review.js` `renderReviewModeConfig` (phase + classification badges) migrated to `<cc-stat-pill tone="quality">`; sites carrying extra utility classes (`text-[var(--warning)]`), `mtag-*` classifiers, or `title` attributes stay inline by design — those need a richer pill component to migrate cleanly. Dashboard drill-goal + streak KPIs migrated to `<cc-kpi-card>`; `updateDrillProgressKpi` now does `setAttribute('value' | 'sub', …)` instead of element-ID textContent writes. New `variant="toolbar"` on `<cc-section-header>` (20px title) absorbs the drills hero. Pure `buildNextSteps` lifted out of `dashboard.js` into `dashboard-next-steps.js` (continues the H13 split trend; dashboard.js 769 → 688 lines).
- **Offline drill buffering.** New `frontend/js/modules/offline-queue.js` — IndexedDB wrapper with one `drill-results` store, `enqueueDrillResult` / `flushDrillResults` / `pendingDrillCount`. Distinguishes transient network errors from real HTTP errors via `isTransientNetworkError` (uses `navigator.onLine` and the `TypeError without .status` heuristic for fetch failures). `drills.js` `submitQuality` now enqueues on transient failure and toasts "Saved offline — will sync when reconnected." `app.js` listens for the `online` event and opportunistically flushes; successful flushes toast the count. No-IndexedDB browsers (Safari private) no-op gracefully.
- **`<cc-stat-pill>` Lit primitive** in `frontend/js/components/cc-stat-pill.js`. Props: `tone` (`active`/`quality`/`eval`/`opening`), `label`, optional `value`. Light DOM, side-effect registered. Migrated 6 inline pills: 3 dashboard hero (Analytics/Drills/Coach) + 3 review hero (You/Opponent/opening ECO).
- **More `<cc-section-header>` migrations.** Coach hero and games hero migrated. Mistakes and openings already done in H17. Drills hero intentionally skipped — its custom `drill-toolbar-title` typography (20px) doesn't fit the standard hero variants without a visible regression.
- **Tailwind ratchet drift down.** Cap stays 25, current 22 → **19** (cc-stat-pill migrations removed three inline `active-pill` literal references that the gate counted).
- **Docs refreshed** per AGENTS.md contract: CHANGELOG, PROJECT_INTELLIGENCE, COMPONENT_CONTRACTS.

Three Lit migrations + the matching dashboard-motifs cleanup.

- **Mistakes KPIs migrated to `<cc-kpi-card>`.** Three inline `.kpi-card` blocks replaced with cc-kpi-card elements. JS now sets `value`, `sub`, `severity` attributes on the elements; severity-toned subs ("8.2 per game · high blunder rate") flow through formatStat when `games.analyzed > 0` and fall back to the static educational copy otherwise.
- **`<cc-section-header>` Lit primitive** in `frontend/js/components/cc-section-header.js`. Props: `kicker`, `title`, `subtitle`, `variant` (hero/card/compact). Light DOM, no slot — when callers need an action button next to the header, they wrap both in a flex container at the call site (avoids the slot-redistribution gotcha that comes with light-DOM Lit). Mistakes and openings hero sections migrated as proof.
- **`<cc-motif-row>` Lit primitive** in `frontend/js/components/cc-motif-row.js`. Props: `subtype`, `phase`, `family`, `occurrences`, `avg-eval-loss`, `latest-date`, `coach-label`, `example-game-id`. Emits an `open-game` CustomEvent (with `detail.gameId`) instead of using the previous `data-open-game-id` button delegation. Dashboard motifs panel migrated — `dashboard-motifs.js` now maps API payload into element attributes and listens for `open-game` instead of carrying the row markup itself.
- **Docs refreshed** per AGENTS.md contract: CHANGELOG, PROJECT_INTELLIGENCE, COMPONENT_CONTRACTS.

First half of Phase C from the H14 redesign blueprint. Visible coach voice across KPIs and PWA install discovery.

- **`<cc-kpi-card>` Lit primitive** in `frontend/js/components/cc-kpi-card.js`. Props: `label`, `value`, `sub`, `icon`, `tone`, `severity`, `icon-tone`. Severity wins over tone when both are given. Light DOM, side-effect registered. Documented in `frontend/design/COMPONENT_CONTRACTS.md`.
- **Dashboard KPI grid migrated.** 5 of 7 cards now `<cc-kpi-card>`; the 2 with dynamically-updated children (drill goal, streak) stay inline because their handlers depend on `kpi-drill-goal-value`, `kpi-streak-value`, `kpi-streak-sub` IDs. Hanging-rate, blunders/game, win-rate now drive `severity` from `formatStat` so the kpi-sub line reads "piece-safety leak" / "high blunder rate" / "winning more than losing" instead of static "target: below 3" copy.
- **`formatStat` wired into coach context** (`frontend/js/modules/views/coach.js`). The hanging / blunders / drills-due rows now show value + coach-voice label + severity-toned color. Rating and games-analyzed rows stay raw (they're identifiers, not metrics with severity bands).
- **`formatStat` wired into mistakes KPIs**. Subs gained `id`s (`m-blunders-sub`, `m-hanging-sub`, `m-mistakes-sub`). When `games.analyzed > 0`, JS computes blunders/game and mistakes/game from totals, runs them through `formatStat`, and rewrites the sub from "eval swing > 300cp" to "8.2 per game · high blunder rate". Falls back to the static educational copy when there's no data yet.
- **PWA install-prompt chip** in `frontend/js/modules/install-prompt.js`. Captures `beforeinstallprompt`, counts unique calendar days in localStorage (`cc.pwa.sessions`, `cc.pwa.lastDay`), reveals `#btn-install-app` after 3 distinct days. Click triggers `.prompt()`; dismissed users get marked declined and the chip stops appearing. Listens for `appinstalled` to hide cleanly. Quiet failures when localStorage is off or the browser doesn't support the event (Safari).

Quick-wins from Phase B of the H14 redesign blueprint. Visual upgrade pass; no new infrastructure.

- **`formatStat(metric, value)` helper** in `frontend/js/modules/ui.js` — translates raw stats into coach-voice trios `{value, label, severity}`. Supports `hanging_piece_rate`, `blunders_per_game`, `win_rate`, `mistakes_per_game`, `time_pressure_blunder_rate`, `drills_due`, `streak`. Plus `statSeverityToneClass(severity)` for centralized color mapping. Falls through gracefully on unknown metrics.
- **Progressive disclosure on form-heavy views.**
  - Openings repertoire form is hidden by default behind an "Add a line" button. The form expands on click, on weak-node `data-add-weak-node`, on training-list/repertoire-list `data-focus-repertoire-form` paths, and collapses back after a successful save.
  - Games filter panel is hidden by default behind a "Filters" toggle that displays `· N active` when any field diverges from the resting defaults. Presets and saved-filter slots stay primary.
- **Drill micro-feedback.**
  - Correct answer pulses the destination square green for ~360ms (`drill-correct-pulse` keyframe).
  - Streak counter scales briefly on increment (`streak-bump` keyframe).
  - Wrong answer breaking a streak ≥5 appends "(Streak of N broken — back to building.)" to the feedback note.
  - Both keyframes collapse via `prefers-reduced-motion: reduce`.
- **View-transition motion.** `navigation.showView` wraps the active-class swap in `document.startViewTransition` when supported and reduced-motion is off. CSS owns the timing — 120ms fade-out / 160ms fade-in with a 4px upward translate. Falls through unwrapped when the API is missing.
- **Docs refreshed** per AGENTS.md contract: CHANGELOG, PROJECT_INTELLIGENCE.

Quick-wins phase from the redesign blueprint.

- **PWA installable** — `manifest.webmanifest` with two app shortcuts (Drills, Coach), service worker with 3-tier strategy (shell stale-while-revalidate, fonts cache-first, drill-queue network-first-with-fallback). Service worker served at root scope from `/sw.js`.
- **Token pipeline** — `frontend/design/tokens.json` as single source of design truth; `build-tokens.mjs` generates `theme.ts` (RN-shape, `as const`). Style Dictionary deferred until needed.
- **Lit components** — `<cc-empty-state>` and `<cc-skeleton>` introduced as the first declarative primitives. Light DOM, props/events that map cleanly to RN. Loaded via jsdelivr (already in CSP).
- **Dashboard calm-down** — focus mode now defaults on for new sessions. Session-flow widget and charts row tagged `dashboard-secondary` so focus mode meaningfully reduces above-the-fold from 7+ sections to 4.
- **Color discipline** — STYLING_CONTRACT.md gains a "green = action; blue/purple = data-vis only" section. No bulk recolor — discipline applies to new code.
- **Vite deferred** — re-evaluation criteria documented; current ES-modules-over-the-wire still right for a single-developer self-hosted tool.

## H13 — Frontend module split + cache-warm (2026-05-28)

- `dashboard.js` 970 → 770 lines via two extractions: `dashboard-motifs.js` (87L) and `dashboard-insights.js` (139L).
- `loadGameDetail` cache-warms the critical-mistake position via a fire-and-forget what-if 250ms after render.

## H12 — What-if completeness (2026-05-28)

- **LRU cache** keyed on `(fen, uci, depth)`, capped at 256 entries. Cache hits return in 0ms (was ~100ms warm).
- **Click-to-move parity** for what-if on the review board, mirroring the drills click flow.
- **`review-whatif.js`** (171 lines) extracted from review.js. review.js dropped 890 → 684 lines.

## H11 — Long-lived Stockfish + depth slider (2026-05-28)

- Engine is a module-level singleton with `threading.Lock` and `EngineTerminatedError` retry-respawn. Cold call 2300ms → 380ms; warm 2300ms → 100ms.
- Depth slider (8–22, clamped server-side). UI exposes Quick (10) / Standard (14) / Deep (18).
- `.hero-display` (32px/1.05/700) and `.text-2xs` extracted.
- Inline-Tailwind cap dropped 32 → 25.

## H10 — Best-move arrow + persistence (2026-05-28)

- Best-move arrow overlay rendered on the review board's grid via SVG with auto-orient marker.
- `whatif_attempts` table (migration 015) logs every call with rolling 500-row cap. Coach context surfaces `RECENT WHAT-IF EXPLORATIONS`.
- Audit gate refined to recognize `var()` inside `calc()` as token-using.

## H9 — Drag-DnD review board, promotion UI (2026-05-28)

- `<cc-promotion-picker>`-equivalent overlay (Q/R/B/N) wired into both drag and click flows.
- Auth-form CSS extracted (`max-w-[420px] + rounded-[24px] + bg-[linear-gradient(...)]` → `.auth-card`, 5 literals out).
- Chart-height tokens consolidated.
- What-if drag now lives on the review board with depth slider, best-move arrow, and exploration history.

## H8 — Promotion correctness, focus mode, ratchet (2026-05-28)

- Dashboard focus mode toggle introduced. Slow-query threshold tightened 500ms → 250ms.
- Inline-Tailwind cap 60 → 50 (tracking + text-md classes).

## H7 — Drag-and-drop drill board (2026-05-28)

- `frontend/js/modules/board.js` gained pointer-event drag layer with 6px threshold, drop-target highlight, click-to-move fallback.
- "Refresh Motif Labels" admin button. Chat-pane heights consolidated. Inline-Tailwind cap 65 → 60.

## H6 — Heatmap perf fix + motif label policy (2026-05-28)

- `get_blunder_heatmap_data` rewritten — was 770ms parsing 11k FENs through python-chess; now **12ms** by computing UCI to-square in SQL with `GROUP BY`. **65× speedup, identical output.**
- Motif label carry-forward on recompute when `cluster_key` matches; `POST /api/product/motifs/clear-labels` for manual refresh.
- `label_pending_motifs` refactored to single async batch with bounded concurrency.
- Tap-target classes (`.tap-40`, `.tap-44`).

## H5 — LLM motif labeling + slow-query instrumentation (2026-05-28)

- `mistake_motifs.coach_label` (migration 014) generated by 7B model with sanitizer (handles bullets, quotes, length cap).
- SRS queue priority unions recent-failure motifs with the latest motif snapshot subtypes.
- Slow-query span timer with counters at `/api/metrics`. Caught the heatmap regression that H6 then fixed.
- `text-[13px]` → `text-sm` (13 occurrences). Audit excludes `var()` references from the literal count.

## H4 — Job retry, auth hardening, dashboard motifs panel (2026-05-28)

- `job_ledger` extended with `retry_count`, `max_retries`, `next_retry_at`. Transient-only retries on sync/analyze with 5s/30s/120s/600s backoff.
- Production startup refuses to boot if `ADMIN_PASSWORD_HASH` unset; `ADMIN_TOKEN`-as-password fallback gated to dev.
- Dashboard motifs panel reads `/api/product/motifs/latest` with example-game deep links.
- Bottom-nav arbitrary-value cluster consolidated into `.bottom-nav-*` classes.

## H3 — Ollama timeouts, retention, URL state, accessibility (2026-05-27)

- Per-mode Ollama timeouts (chat 60s, batch 30s, generate 60s). Circuit breaker opens after 3 failures in 60s, cooldown 30s.
- db-maintenance retention: `player_model_snapshots` 90d, `analytics_snapshots` 90d, `coach_sessions` 365d, `rate_limit_events` 24h.
- URL state on `/games?...` and `/games/:id` deep links.
- Skip-link, ARIA labels on canvas charts, dynamic heatmap text alternative, focus trap on onboarding modal.

## H2 — Repertoire ↔ SRS bridge, motif clustering, weekly reflection (2026-05-27)

- `repertoire_node_srs` table — opening recall results drive an SM-2 schedule. Coach context surfaces missed nodes.
- Rule-based motif clustering on `(subtype, phase, eco_family)` with min-3-occurrences threshold (`mistake_motifs` table).
- Weekly report includes "Did Last Week's Plan Land?" reflection on prior `Study Plan` section.
- Coach feedback chips (`coach_sessions.user_rating`).

## H1 — Coach memory, durable jobs, in-app reports, onboarding (2026-05-27)

The first horizon after the original audit. Foundations.

- **Coach memory:** last 6–8 `coach_sessions` injected as a memoryful preamble in the system prompt.
- **Job durability:** new `job_ledger` table records every enqueue/start/finish; orphan rows reconciled on startup so analysis isn't silently lost.
- **In-app weekly report view** at `/reports`; markdown rendered client-side.
- **First-run onboarding modal** detects empty profile/games and walks through username confirm + sync + dashboard tour.
- **Time-pressure profile** in coach context (blunder rate <60s vs ≥60s on clock).
- **Hanging-piece-rate bug fix** — formula was `total_hanging / analyzed_games` producing >100%; now `COUNT(DISTINCT game_id) / analyzed_games`, capped at 1.0.

---

## H0 — Pre-audit baseline

The codebase shipped before H1 already had: Chess.com sync, Stockfish analysis, mistake classification, basic SRS, mode-aware coach prompts, drag-and-drop nav, dark-first design system, repository/service split, FastAPI middleware stack, migrations 001–009. PROJECT_INTELLIGENCE.md was the original audit document; all subsequent horizons are polish on top of that foundation.

---

## How to update this changelog

After each horizon lands and smoke passes:
1. Add a new section at the top with the horizon number, theme, and date.
2. Bullet the user-visible or operationally-significant changes. Skip refactor-only churn unless it changes a contract.
3. Note migrations by number, perf wins with before/after, breaking changes loudly.
4. Don't rewrite history — corrections go in a new entry.

See AGENTS.md for the full doc-maintenance contract.
