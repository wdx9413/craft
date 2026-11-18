# Craft Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver one Craft Notes capability for required Device Notes and evidence-gated Directory/File Note candidates, with human confirmation, scoped retrieval, compatibility and review UI.

**Architecture:** `@craft/capability-file-dir-desc` remains the compatibility package and owns a typed `CraftNotesRegistry` backed by the existing CraftStore. Craft adapts old `file_dir_desc` APIs and new Notes operations onto it; Workbench reviews candidates; Craft Context returns only confirmed, scope-matched Notes through existing egress controls. Eval exercises the public service/MCP contract, and Marketplace payloads are rebuilt only from a versioned source snapshot.

**Tech Stack:** TypeScript, Node built-in test runner, CraftStore, existing MCP/Workbench adapters, existing DataSec checks, craft-eval.

**Spec:** `docs/superpowers/specs/2026-11-17-craft-notes-design.md`

## Global Constraints

- Preserve `@craft/capability-file-dir-desc`, `file_dir_desc`, and existing `craft_file_dir_desc_*` callers during migration.
- Device Notes are user supplied or confirmed; Directory/File candidates never enter default retrieval before confirmation.
- Directory/File thresholds are 3 distinct tasks across 2 Host sessions in a rolling 30-day window; same-task retries and scanner activity do not count.
- File Notes never read file bytes or content; available size/mtime is a review signal only.
- Credentials are rejected through DataSec; scoped Notes do not bypass model egress policy.
- Reuse CraftStore; do not introduce another database or a standalone Host plugin.
- Preserve all pre-existing dirty work in every repository; do not commit, push or publish.
- New or modified logic requires 100% line and branch coverage in its owning unit tests plus service-level acceptance coverage.

## Review Focus

- Repeated delivery of the same Task/Session must count once and never promote a candidate by retry.
- A missing Device Note must block device creation/reactivation and new Note writes while preserving existing read-only lookups.
- A file note must never read file bytes; a changed size/mtime must mark `needs_review`, while unavailable remote metadata stays `path_only`.
- Candidate, revoked, cross-device and cross-project Notes must not leak into unrelated Context responses.
- Credential-like Note content and unavailable external-egress authorization must fail closed without losing safe local read access.

---

### Task 1: Unify the capability source and device APIs

**Files:**
- Create: `craft-capability/capability/craft-file-dir-desc/notes.ts`
- Modify: `craft-capability/capability/craft-file-dir-desc/file-dir-desc.ts`
- Modify: `craft-capability/capability/craft-file-dir-desc/index.ts`
- Modify: `craft-capability/capability/craft-file-dir-desc/package.json`
- Modify: `craft-capability/capability/craft-file-dir-desc/README.md`
- Create: `craft-capability/tests/craft-notes.test.ts`

**Interfaces:**
- `NoteSubjectType = "device" | "directory" | "file"`.
- `NoteStatus = "candidate" | "confirmed" | "needs_review" | "revoked"`.
- `CraftNoteRecord` contains `id`, `subject_type`, `subject_key`, `text`, `status`, `version`, `evidence_refs`, `verified_at`, `created_at`, and `updated_at`.
- `CraftNotesRegistry.createDevice(args: JsonObject): CraftNoteRecord`; `observeDirectory(args: JsonObject): JsonObject`; `observeFileReference(args: JsonObject): JsonObject`; `candidateList(args: JsonObject): {items: CraftNoteRecord[]}`; `confirm(args: JsonObject): CraftNoteRecord`; `revoke(args: JsonObject): CraftNoteRecord`; `resolve(args: JsonObject): {items: CraftNoteRecord[]}`; and `list(args: JsonObject): {items: CraftNoteRecord[]}`.
- `observeFileReference` accepts optional caller-supplied `{size, modified_at}` metadata only; the registry never opens or reads files.
- `FileDirDescRegistry` remains a compatibility facade that preserves the existing method names and response shapes while delegating to `CraftNotesRegistry`.
- Persist one typed `craft_note` record per Note and deduplicated content-free `craft_note_usage` evidence keyed by subject, task and session. Never persist prompt/file bodies.

- [ ] **Step 1: Add failing capability tests** for required Device Note, threshold boundaries, duplicate Task/Session evidence, candidate visibility, explicit pin, credential rejection, revoke, device/path isolation, File metadata-only review and legacy projections.
- [ ] **Step 2: Run the focused tests** with Node's TypeScript test runner and verify the new behavior fails before implementation.
- [ ] **Step 3: Implement `CraftNotesRegistry`** with strict input normalization, typed identity, fixed threshold constants, candidate lifecycle, metadata-only file staleness, and DataSec validation.
- [ ] **Step 4: Implement the `FileDirDescRegistry` compatibility facade** and export both interfaces from the existing package root.
- [ ] **Step 5: Add package test/build scripts and make every export point to an emitted file.**
- [ ] **Step 6: Run the capability tests, typecheck and package build**; the new capability logic must meet 100% line and branch coverage.

### Task 2: Add idempotent legacy migration and Craft service APIs

**Files:**
- Create: `craft/core/craft-notes-migration.ts`
- Modify: `craft/core/application/craft-service.ts`
- Modify: `craft/core/application/actions/action-handlers.ts`
- Modify: `craft/core/mcp/tool-catalog.ts`
- Modify: `craft/core/mcp/tool-schema.ts`
- Modify: `craft/tests/file-dir-desc.test.ts`
- Create: `craft/tests/craft-notes-service.test.ts`

**Interfaces:**
- `CraftService.craftNotesCreateDevice(args)`, `craftNotesObserveDirectory(args)`, `craftNotesObserveFile(args)`, `craftNotesCandidateList(args)`, `craftNotesConfirm(args)`, `craftNotesRevoke(args)`, and `craftNotesResolve(args)` delegate to the capability registry.
- New public names use `craft_notes_*`; old `craft_file_dir_desc_*` names remain registered and adapt to the same service.
- `migrateFileDirDescNotes(store, options)` is idempotent, preserves IDs and evidence, and never reads files.

- [ ] **Step 1: Add failing migration/service tests** for a second migration run, stable IDs, old promoted recall, observed/revoked status, missing device note, compatibility methods and new MCP schemas.
- [ ] **Step 2: Implement the migration** as a bounded transaction over existing records, marking legacy records and retaining originals for rollback/audit.
- [ ] **Step 3: Add service delegates and public MCP actions** with exact read/write annotations and validation.
- [ ] **Step 4: Run the focused CraftStore/MCP tests and coverage gate** for each new branch.

### Task 3: Bind candidate evidence and scoped Context retrieval

**Files:**
- Modify: `craft/core/application/craft-service.ts`
- Modify: `craft/core/application/use-cases/repository-context.ts`
- Modify: `craft/core/application/use-cases/learning-cycle.ts`
- Modify: `craft/core/application/coordinators/cognitive-search.ts`
- Modify: `craft/tests/context-readiness-doctor.test.ts`
- Create: `craft/tests/craft-notes-context.test.ts`

**Interfaces:**
- `observeDirectory` receives a canonical device/path plus completed `task_id`, `session_id`, Host, timestamp and outcome reference.
- `observeFileReference` accepts only explicitly bound file paths from completed Task/Procedure evidence or a confirmed Codebase usage reference; there is no general file-open listener.
- `resolveNotesForContext(args)` returns only confirmed, non-revoked Notes whose device/project/path matches the current task, within the existing Context budget and DataSec/egress policy.

- [ ] **Step 1: Add failing tests** proving failed/incomplete Tasks, same-task retries, scanning, unrelated devices/projects, candidates, revoked Notes and denied egress do not create or return Notes.
- [ ] **Step 2: Implement deduplicated evidence capture** using existing Task, Session, Procedure and Codebase identifiers; do not persist raw prompts or file contents.
- [ ] **Step 3: Integrate the bounded projection** without adding an unbounded Context member or global injection path; explicit local lookup remains available when model egress is denied.
- [ ] **Step 4: Run the Context/candidate focused tests and 100% coverage gates.**

### Task 4: Add Workbench device onboarding and candidate review

**Files:**
- Modify: `craft/core/interfaces/workbench-server.ts`
- Modify: `craft-workbench/web/mod-pages.js`
- Modify: `craft-workbench/web/app.css`
- Modify: `craft-workbench/web/app.js`
- Modify: `craft-workbench/tests/mod-pages.test.ts`
- Create: `craft-workbench/tests/craft-notes-pages.test.ts`

**Interfaces:**
- Add authenticated `/api/workbench/notes/devices`, `/api/workbench/notes/candidates`, `/api/workbench/notes/:id/confirm`, `/api/workbench/notes/:id/revoke`, and `/api/workbench/notes/resolve` routes.
- Preserve `/api/workbench/file-dir-desc/*` endpoints as compatibility routes.
- UI shows Device Note completion, Directory/File candidate reason and evidence, content-free metadata freshness, sensitivity, and confirm/edit/revoke controls.

- [ ] **Step 1: Add failing route/UI tests** for authorization, missing description, stale candidate version, confirm/revoke, legacy review and empty/error states.
- [ ] **Step 2: Implement authenticated routes** delegating to CraftService and preserving origin/token checks.
- [ ] **Step 3: Replace the old directory-only panel with a Craft Notes page** containing device, directory and file sections plus a bounded candidate review queue.
- [ ] **Step 4: Run focused Workbench tests and 100% coverage gates for new UI modules.**

### Task 5: Add public service Eval coverage and package consistency

**Files:**
- Modify: `craft-eval/src/cases.ts`
- Modify: `craft-eval/src/suite.ts`
- Create: `craft-eval/tests/craft-notes.test.ts`
- Modify: `craft-capability/README.md`
- Modify: `craft/README.md`
- Modify: `craft-marketplace/catalog/recommended-plugins.json`
- Modify: `craft-marketplace/scripts/resolve-plugin-host.mjs`
- Modify: `craft-marketplace/plugins/craft-context` generated payload through the existing source pack/sync scripts
- Modify: `craft-marketplace/release.json` only after a new versioned source snapshot exists

**Interfaces:**
- Eval calls the public Craft service/MCP contract; it does not mock the Notes registry when claiming service-level acceptance.
- Marketplace labels the product `craft-notes`, does not claim standalone installability, and only marks a Host available when the exact manifest exists.

- [ ] **Step 1: Add failing Eval cases** for all three object types, thresholds, confirmation, migration, stale File Note, egress denial and old tool compatibility.
- [ ] **Step 2: Implement deterministic service-level Eval fixtures** with verified Task/Session IDs and no prompt/file body capture.
- [ ] **Step 3: Update package documentation/catalog names** while retaining compatibility package/storage/tool identifiers.
- [ ] **Step 4: Build the Craft Context payload from the exact Craft source snapshot, sync through the existing Marketplace script, and record source commit/tree digest.** Do not publish remotely.
- [ ] **Step 5: Run capability, Craft, Workbench, Eval and Marketplace focused suites; then run cross-repo package/build/coverage gates.**

## Completion Criteria

- Device, Directory and File Notes share one lifecycle and evidence model; only a user-confirmed Note enters default retrieval.
- Legacy Directory APIs and IDs remain compatible, and migration can be repeated without duplicating or losing data.
- Notes are scope matched, credential checked and egress governed; no file body or universal file-open telemetry is collected.
- Workbench can add a Device Note and review, edit, confirm or revoke candidates.
- Public Eval covers threshold, isolation, migration and security behavior; source and Marketplace bundle are version aligned and traceable.
- All changed code passes the required focused tests and 100% incremental line/branch coverage; unrelated dirty work remains untouched.
