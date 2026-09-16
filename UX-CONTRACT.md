# Craft Studio UX Contract

## Product context

- Audience: people operating local Craft tasks and capability sources.
- Primary jobs: create or resume work, inspect task state, configure a model and manage local context.
- Active locales: `zh-CN`, `en-US`; current Studio navigation is `zh-CN`.
- Accessibility target: WCAG 2.2 AA.

## Business-context sources

| Domain / scope | Authoritative source | Source type | Reviewed date |
|---|---|---|---|
| Runtime vocabulary and lifecycle | `CONTEXT.md` | domain context | 2026-09-17 |
| Desktop/package boundaries | `scripts/package-desktop.ts`, `scripts/windows-launcher.cs` | implementation contract | 2026-09-17 |
| Model credentials | `src/settings.ts`, `src/model-gateway.ts` | security implementation | 2026-09-17 |

## Visual contract

- Project `DESIGN.md`: `DESIGN.md`.
- Token ownership: existing runtime CSS is canonical.
- Runtime source: `studio/app.css`, served by `src/workbench-server.ts` and copied by `scripts/package-desktop.ts`.
- Themes: light and dark; reduced motion is always respected.

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Form | Studio field/form patterns | `studio/app.js` + `app.css` | create / edit | server test + keyboard review |
| Scrollbar | Global Studio stylesheet | `studio/app.css` | geometry exceptions only | stylesheet assertion |
| Toast | Studio toast host | `studio/app.js` | success / warning / info / error | interaction review |
| CRUD | Same-origin Studio API | `src/workbench-server.ts` | model create / edit / delete | `tests/studio-server.test.ts` |

## Component behavior

Buttons and icon buttons use native `<button>` elements, pointer cursors, hover/active treatment and visible focus. Inputs are labeled; secret inputs are masked. Search opens the command palette with Ctrl/Cmd+K, supports Escape to close, and should not race stale async results. Textareas are non-resizable where rendered. No product flow uses browser `alert`, `confirm` or `prompt`.

## Flow ledger

| Operation | Trigger | Pending | Success destination | Success feedback | Failure recovery | Focus outcome | Source ref |
|---|---|---|---|---|---|---|---|
| Add model | Studio sheet | Save disabled while request runs | Settings | toast | preserve sheet values | sheet control | `studio/app.js` |
| Edit model | Settings row | Save disabled while request runs | Settings | toast | preserve sheet values | sheet control | `studio/app.js` |
| Remove model | App-owned confirmation sheet | confirmation action | Settings | toast | keep confirmation open | cancel action | `studio/app.js` |
| New task | rail action / composer | local form state | active task | status update | inline error | composer | `studio/app.js` |

## Navigation and responsive behavior

The rail is collapsible. The central content owns reading scroll, while rail and contextual panel have their own scroll regions. Keyboard escape closes the command palette or the active inline sheet and restores the relevant control. Dense content truncates only where an accessible full value remains available.

## Overlays and feedback

Sheets and the command palette are app-owned overlays. Toasts are single-system acknowledgements and never the only copy of a corrective error. Destructive model removal uses an explicit app-owned confirmation with a real verb.

## Async and resilience

Requests remain same-origin and token-scoped. Failed mutations preserve field values and return an inline/toast error. The UI must not commit a stale request result after a newer navigation or selection.

## Validation

Model identifiers, HTTP(S) endpoints and environment-variable names are validated before persistence; keys are never persisted in `settings.json`. Forms own their validation feedback and prevent duplicate submissions.

## Verification

- Static: `git diff --check`, `pnpm run typecheck`, strict design audit.
- Runtime: `node --test --test-isolation=none tests/studio-server.test.ts`.
- Visual: inspect light/dark, rail collapsed, command palette, model sheet, focused control and narrow viewport in the packaged desktop app.
