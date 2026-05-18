# Frontend Styling Contract

## Ownership Map
- **Tailwind + daisyUI (`frontend/css/tailwind.input.css`)**:
  - Design tokens (`@theme`, `@layer base :root`)
  - Generic primitives (`btn`, `badge`, `input/select/textarea`, alerts, progress)
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
