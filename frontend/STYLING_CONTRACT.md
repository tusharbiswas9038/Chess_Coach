# Frontend Styling Contract

## Ownership Map
- **Tailwind + daisyUI (`frontend/css/tailwind.input.css`)**:
  - Design tokens (`@theme`, `@layer base :root`)
  - Generic primitives (`btn`, `badge`, `input/select/textarea`, alerts, progress)
  - Premium layout primitives (`panel`, `panel-primary`, `panel-quiet`, `analytics-panel`)
  - Product primitives (`metric-card`, `action-card`, `active-pill`, `eval-pill`, `quality-pill`, `catalog-card`)
  - Workspace primitives (`workspace-hero`, `hero-banner`, `filter-bar`, `split-analysis-layout`, `wizard-shell`, `wizard-stepper`, `stepper-rail`)
  - Chess UI shells (`board-stage`, `engine-panel`, `engine-eval-bar`, `mini-board-thumb`, `mastery-bar`)
  - Most layout, spacing, typography, and responsive behavior (`max-sm`, `max-md`, etc.)
- **Custom runtime CSS (`frontend/css/app.css` imports)**:
  - `layout.css`: behavior/state hooks only (sidebar collapsed, reduced motion behavior)
  - `features.css`: chess-domain visuals and interaction semantics only
  - `responsive.css`: residual responsive exceptions only
- **Removed legacy stubs**:
  - `frontend/css/modules/components.css`
  - `frontend/css/modules/views.css`
  - `frontend/css/modules/tokens.css`
  - These were retired after the stable-cycle checkpoint; do not recreate.

## When To Add Custom CSS
Add custom CSS only if **both** are true:
1. Tailwind/daisy composition cannot express the behavior cleanly, and
2. The rule is chess-domain specific or one of the allowed responsive residuals.

If the style is generic UI (card spacing, headings, badges, button variants, empty/loading/error wrappers), keep it in utility/daisy composition, not in residual CSS modules.

Aceternity-style glow/elevation effects are implemented locally in `tailwind.input.css`. Do not add an Aceternity dependency unless the project explicitly needs a specific upstream component.

## Required Pre-Merge Migration Audit Gate
Run this command before merging frontend styling changes:

```bash
rg -n "@media \\(max-width|\\.btn-table-action|\\.card-top-gap|\\.journal-|\\.confidence-|\\.pagination|\\.back-btn|\\.toast\\b|\\.skeleton" frontend/css/modules frontend/js frontend/index.html
```

Expected result:
- No new generic primitive or legacy semantic class reintroduced in runtime CSS/markup.
- `@media (max-width: ...)` rules exist only in `frontend/css/modules/responsive.css`.

Project gate command:

```bash
npm run frontend:gate
```
