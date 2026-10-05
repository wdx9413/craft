# Craft UX Contract

This document defines intended interaction contracts and their current implementation owners, not completed browser or native-platform acceptance. The unified entry is the primary surface; the existing Workbench remains the advanced management surface. Acceptance evidence and unresolved gaps are tracked in [design QA](design-qa.md) and the [implementation record](docs/research/desktop-unified-entry-implementation-2026-09-28.md).

## Unified entry (2026-09-28)

User-approved presentation: launcher as entry, companion and artifact workspace in the same implementation. `workbench/entry-session.js` owns transient view state; existing Task/message APIs remain authoritative. `entry-shell.js` is the DOM adapter and `entry-view.js` escapes all external text. Native resize is guarded by the bundled main-window identity and never changes permission.

| Capability | Canonical owner | Contract |
| --- | --- | --- |
| Entry and view changes | entry-session / entry-shell | Same Task and drafts across modes; Ctrl/Cmd+K is IME-safe; Escape returns from launcher to workspace |
| Explicit materials | entry-session | Markdown/TXT/CSV/JSON only, 5 files, each 24 KiB, combined JSON 32 KiB; picker only; no ambient screen/file access |
| Model selection | Existing model config API | Native select popup is OS-owned; only configured models; no silent provider fallback |
| Submission | Existing Task/message APIs | Human-approval task default; conversation only; model fee and history retention disclosed before sending |
| Errors and unknown result | entry-session draft state / entry-shell status region | Preserve input; 90s wait timeout does not imply remote cancellation. Unknown completion stays bound to the submitted draft; switching views/tasks or reading history cannot clear it. This entry stops resubmission and hands off to task details for manual investigation, not automatic replay |
| Draft editing | entry-session memory | Plain text, no model HTML. Edits persist only within current window and may be downloaded; not a saved Artifact or Acceptance |
| Advanced functions | Existing Workbench | Settings, all capability pages, approvals and task details remain accessible |

Material removal affects the next submitted payload, not previous task history. Restart can recover server task messages but not unsubmitted materials or local edits. No cross-application capture, durable draft revisions, rich Office editing or new execution authority is implied. Browser and native acceptance remain blocked; the module tests are not that proof.

The unknown-completion guard currently lasts for the entry session only. Server-side operation identity, idempotent submission and reconciliation across reloads/clients are still required for durable duplicate prevention; a history read or an old assistant reply is not a terminal receipt for the uncertain request. No force-retry control is provided by this entry.

## Product context

- Audience: people operating local Craft tasks and capability sources.
- Primary jobs: create or continue a task conversation, inspect factual task activity, configure a model and manage local context.
- Current interface copy is primarily `zh-CN`; `en-US` is a localization target, not a verified complete locale.
- Accessibility target: WCAG 2.2 AA; conformance has not been established by the current module tests.

## Business-context sources

| Domain / scope | Authoritative source | Source type | Reviewed date |
|---|---|---|---|
| Runtime vocabulary and lifecycle | `CONTEXT.md` | domain context | 2026-09-17 |
| Desktop/package boundaries | [Desktop runtime](desktop/src-tauri/src/lib.rs), [sidecar preparation](desktop/scripts/prepare-sidecar.mjs) | implementation contract, native acceptance pending | 2026-09-28 |
| Model credentials | [settings](core/settings.ts), [model gateway](core/model-gateway.ts), [configuration state](workbench/model-setup.js) | security implementation | 2026-09-28 |
| Browser/Desktop request transport | [runtime client](workbench/runtime-client.js), [native bridge](desktop/src-tauri/src/runtime_bridge.rs), [HTTP interface](core/interfaces/workbench-server.ts) | source and Node-port tests; native acceptance pending | 2026-09-28 |

## Visual contract

- Project `DESIGN.md`: `DESIGN.md`.
- Token ownership: existing runtime CSS is canonical.
- Runtime source: [workbench/app.css](workbench/app.css), served by [core/interfaces/workbench-server.ts](core/interfaces/workbench-server.ts) and copied into the Tauri sidecar by [desktop/scripts/prepare-sidecar.mjs](desktop/scripts/prepare-sidecar.mjs). `core/workbench-server.ts` is a compatibility re-export, not the implementation owner.
- Themes: light (default), dark and system-following; reduced motion is always respected.

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Form | Workbench field/form patterns and model setup state | [app.js](workbench/app.js), [model-setup.js](workbench/model-setup.js), [app.css](workbench/app.css) | create / edit | server and state tests; keyboard acceptance pending |
| Scrollbar | Global Workbench stylesheet | [app.css](workbench/app.css) | geometry exceptions only | rendered verification pending |
| Toast | Workbench toast host | [app.js](workbench/app.js) | success / warning / info / error | interaction acceptance pending |
| CRUD | Workbench HTTP interface, shared browser/Desktop transport | [workbench-server.ts](core/interfaces/workbench-server.ts), [runtime-client.js](workbench/runtime-client.js) | model create / edit / delete | [HTTP interface tests](tests/workbench-ui-server.test.ts), [transport tests](tests/workbench-runtime-client.test.ts) |
| Desktop observation | UIA discovery, then visual/OCR fallback | `adapters/windows-uia.ps1`, `adapters/windows-vision-cli.ts` | semantic / visual fallback | adapter contract tests |

## Component behavior

Buttons and icon buttons use native `<button>` elements, pointer cursors, hover/active treatment and visible focus. Inputs are labeled; secret inputs are masked. With the unified entry mounted, its capture-phase Ctrl/Cmd+K handler opens the launcher and takes precedence over the legacy Workbench command-palette shortcut; Escape in the launcher returns to the workspace. The legacy palette remains accessible from Workbench controls. Async results must not overwrite a newer selection. Textareas are non-resizable where rendered. Product dialogs must not use browser `alert`, `confirm` or `prompt`; the lifecycle-only unload warning is separate.

## Flow ledger

| Operation | Trigger | Pending | Success destination | Success feedback | Failure recovery | Focus outcome | Source ref |
|---|---|---|---|---|---|---|---|
| Add model | Workbench sheet | Save disabled while request runs | Settings | toast | preserve sheet values | sheet control | [app.js](workbench/app.js), [model-setup.js](workbench/model-setup.js) |
| Edit model | Settings row | Save disabled while request runs | Settings | toast | preserve sheet values | sheet control | [app.js](workbench/app.js), [model-setup.js](workbench/model-setup.js) |
| Remove model | App-owned confirmation sheet | confirmation action | Settings | toast | keep confirmation open | cancel action | [app.js](workbench/app.js) |
| New task (advanced Workbench) | rail action / composer | local form state | task conversation | first model reply, not acceptance | retain input and show error | task composer | [app.js](workbench/app.js) |
| Continue task (advanced Workbench) | task conversation composer | disable send while model responds | same task thread | append user/model turns | retain input and show error | task composer | [app.js](workbench/app.js) |
| Install plugin manifest | Plugins page file picker | parse JSON locally, then persist local descriptor | Plugins | toast | preserve file choice and show parse/server error | upload trigger | [app.js](workbench/app.js) |
| Install local skill | Skills page file picker | read bounded `SKILL.md`, persist inspectable instruction | Skills and task capability picker | toast | preserve file choice and show error | upload trigger | [app.js](workbench/app.js) |
| Import connector config | Connectors page file picker | parse JSON locally, register as user-approved source | Connectors | toast | preserve file choice and show error | upload trigger | [app.js](workbench/app.js) |
| Edit memory | Memory inline editor | save a replacement record; do not rewrite prior memory | Memory | toast | retain entered content and show error | inline editor | [app.js](workbench/app.js) |
| Edit knowledge page | Knowledge inline editor | save a new local Markdown revision | Knowledge | toast | retain entered content and show error | inline editor | [app.js](workbench/app.js) |
| Edit workflow | Workflow inline editor | save a draft version; no automatic execution | Workflows | toast | retain entered JSON and show error | inline editor | [app.js](workbench/app.js) |
| In-app webpage | View menu / URL sheet | validate `http(s)` before opening | isolated `embedded` WebView | toast | preserve URL and show error | URL field | `workbench/app.js`, `desktop/src-tauri/src/lib.rs` |
| Managed browser login | View menu / URL sheet | validate `http(s)` before opening | visible, independent Edge profile | toast, then user completes login | preserve URL and show error | URL field | `workbench/app.js`, `desktop/src-tauri/src/lib.rs`, `adapters/browser-cdp.ts` |
| Observe self-drawn desktop UI (Windows adapter contract; native acceptance pending) | user selects an already-running application | UIA tree first; bundled local OCR match only when UIA is incomplete | evidence-only visual fallback | show candidate and confidence | no unique/fresh match: recapture or hand off | candidate review | [UIA helper](adapters/windows-uia.ps1), [vision CLI](adapters/windows-vision-cli.ts) |
| Visual desktop click (Windows contract; native acceptance pending) | explicit user release | recapture and require exactly one OCR target | same target window | receipt | reject stale/ambiguous/low-confidence target | Craft approval | [vision kernel](core/windows-desktop-vision.ts), [vision adapter](adapters/windows-vision-cli.ts) |

## Navigation and responsive behavior

In the advanced Workbench, the rail and contextual panel are independently collapsible. The central content owns reading scroll, while rail, conversation and contextual panel have their own scroll regions. Within that surface, Escape closes the active menu, command palette or inline sheet and restores the relevant control. The unified entry uses the separate view and shortcut contract above. Dense content truncates only where an accessible full value remains available.

## Overlays and feedback

Sheets and the command palette are app-owned overlays. Toasts are single-system acknowledgements and never the only copy of a corrective error. Destructive model removal uses an explicit app-owned confirmation with a real verb.

## Async and resilience

Browser-hosted Workbench requests remain same-origin and token-scoped. Bundled Desktop uses `workbench_request`; Rust retains the token and forwards bounded `/api/` requests to the loopback backend. This is an implementation contract, not evidence of native execution on both platforms. Failed mutations preserve field values and return an inline/toast error; uncertain completion must not be presented as safe to replay. Advanced Workbench uploads are text-only and bounded to 48 KiB; unified-entry materials use the stricter per-file and aggregate limits above. A `plugin.json` installs a local descriptor only; it never executes uploaded code. Uploaded skills are explicit task context, while tools and connectors still require their own provenance, activation and approval. A conversation turn has no tool authority: it may call the selected model but cannot claim or cause file/external effects. The UI must not commit a stale request result after a newer navigation or selection.

## Validation

Model identifiers, HTTP(S) endpoints and environment-variable names are validated before persistence; keys are never persisted in `settings.json`. Forms own their validation feedback and prevent duplicate submissions.

## Verification

- Static: `git diff --check`, `pnpm run typecheck`, strict design audit.
- Runtime interfaces: `node --test tests/workbench-ui-server.test.ts tests/workbench-server.test.ts tests/workbench-runtime-client.test.ts` (loopback tests need local listening permission).
- Unified-entry state/DOM-port checks: `node --test --experimental-test-coverage --test-coverage-include='workbench/entry-*.js' --test-coverage-lines=100 --test-coverage-functions=100 --test-coverage-branches=100 tests/entry-session.test.ts tests/entry-shell.test.ts`. DOM ports do not replace browser/native acceptance.
- Visual: inspect light/dark, rail collapsed, command palette, model sheet, focused control and narrow viewport in the packaged desktop app.
