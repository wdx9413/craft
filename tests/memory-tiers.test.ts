import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { JsonObject } from "../common/craft-common-store-local/src/store.ts";
import { digestJson } from "../common/craft-common-base/src/digest.ts";
import { CraftService } from "../core/service.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { MemoryCapture } from "../capability/craft-memory/memory-capture.ts";

test("Memory begins in a session, promotes by repeat counts, and archive removes only temporary content", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "craft-memory-tiers-"));
  const projectRoots = ["project-a", "project-b", "project-c"].map(name => mkdtempSync(join(tmpdir(), `craft-${name}-`)));
  const sessionIds = new Map<string, string>();
  const sessionKey = (id: string) => { const existing = sessionIds.get(id); if (existing) return existing; const value = `${id}-${randomUUID().slice(0, 12)}`; sessionIds.set(id, value); return value; };
  const store = await new CraftStore(craftPaths(dataRoot)).open();
  const service = new CraftService(store);
  const ledgerFiles = service.memoryGovernance.ledger.files;
  try {
    service.knowledgeMemoryInstallBuiltins();
    assert.throws(() => service.memoryCaptureObservedFact({ content: "Invalid scope kind", session_id: "scope-kind-mismatch", project_scope_id: "project-1", scope_kind: "user" }), /must start in session scope/u);
    assert.throws(() => service.memoryCaptureObservedFact({ content: "Invalid scope id", session_id: "scope-id-mismatch", project_scope_id: "project-1", scope_id: "another-session" }), /scope_id must match session_id/u);
    assert.throws(() => ledgerFiles.isSessionArchived(" "), /session_id must not be empty/u);
    const implicitSessionId = sessionKey("implicit-session-scope");
    const implicitSession = service.memoryCaptureUserStatement({ content: "Implicit session scope", session_id: implicitSessionId, topic: "implicit-session" });
    assert.deepEqual((implicitSession.candidate as JsonObject).scope, { kind: "session", id: implicitSessionId });
    assert.equal(existsSync(ledgerFiles.pathFor({ kind: "session", id: implicitSessionId })!), true);
    service.memorySessionArchive({ session_id: implicitSessionId });
    projectRoots.forEach((root, index) => {
      const projectId = `project-${index + 1}`;
      store.create("scope_alias", `path-${projectId}`, { scope: { kind: "project", id: projectId }, alias_kind: "path", alias: root, status: "active" });
    });

    const capture = (inputSessionId: string, projectId: string) => { const sessionId = sessionKey(inputSessionId); return service.memoryCaptureUserStatement({
      content: "Prefer small diffs", kind: "preference", topic: "work-style", scope_kind: "session", scope_id: sessionId,
      session_id: sessionId, project_scope_id: projectId, project_root: projectRoots[Number(projectId.at(-1)) - 1], valid_until: "2999-01-01T00:00:00.000Z",
    }); };
    assert.equal(ledgerFiles.pathFor({ kind: "global", id: "global" }), join(dataRoot, "memory", "memory.md"));
    assert.equal(ledgerFiles.pathFor({ kind: "user", id: "local" }), join(dataRoot, "memory", "memory.md"));
    assert.equal(ledgerFiles.pathFor({ kind: "project", id: "missing-project" }), null);
    assert.equal(ledgerFiles.pathFor({ kind: "workspace", id: "workspace" }), null);
    const outside = join(dataRoot, "outside-content.md");
    writeFileSync(outside, "must survive session cleanup");
    store.create("scope_alias", "file-alias", { scope: { kind: "project", id: "file-project" }, alias_kind: "path", alias: outside, status: "active" });
    assert.equal(ledgerFiles.pathFor({ kind: "project", id: "file-project" }), null);
    store.create("scope_alias", "missing-dir-alias", { scope: { kind: "project", id: "missing-dir-project" }, alias_kind: "path", alias: join(dataRoot, "not-a-directory"), status: "active" });
    assert.equal(ledgerFiles.pathFor({ kind: "project", id: "missing-dir-project" }), null);
    assert.equal(ledgerFiles.sync({ kind: "project", id: "missing-project" }).status, "unavailable");
    assert.equal(ledgerFiles.pathFor({ kind: "project", id: "project-1" }, projectRoots[0]), join(realpathSync(projectRoots[0]!), ".craft_data", "memory", "memory.md"));
    assert.equal(ledgerFiles.pathFor({ kind: "project", id: "project-1" }), join(realpathSync(projectRoots[0]!), ".craft_data", "memory", "memory.md"));
    assert.throws(() => ledgerFiles.archiveSession(" "), /must not be empty/u);
    const first = capture("session-a1", "project-1");
    assert.equal((first.promotions as unknown[]).length, 0);
    assert.equal(existsSync(ledgerFiles.pathFor({ kind: "session", id: sessionKey("session-a1") })!), true);
    assert.equal((capture("session-a2", "project-1").promotions as Array<Record<string, unknown>>)[0]?.tier, "project");
    assert.equal((capture("session-a3", "project-1").promotions as unknown[]).length, 0);
    assert.equal(capture("session-a3", "project-1").already_retained, true);

    capture("session-b1", "project-2");
    capture("session-b2", "project-2");
    capture("session-c1", "project-3");
    const thirdProject = capture("session-c2", "project-3");
    assert.deepEqual((thirdProject.promotions as Array<Record<string, unknown>>).map(item => item.tier), ["project", "global"]);
    assert.equal((capture("session-c3", "project-3").promotions as unknown[]).length, 0);
    const retainedProject = store.list("memory_ledger", 100, row => row.status === "active" && row.content_digest === digestJson("Prefer small diffs")
      && (row.scope as JsonObject | undefined)?.kind === "project" && (row.scope as JsonObject | undefined)?.id === "project-1")[0];
    const retainedGlobal = store.list("memory_ledger", 100, row => row.status === "active" && row.content_digest === digestJson("Prefer small diffs")
      && (row.scope as JsonObject | undefined)?.kind === "global")[0];
    assert.equal(retainedProject?.valid_until, "2999-01-01T00:00:00.000Z");
    assert.equal(retainedGlobal?.valid_until, "2999-01-01T00:00:00.000Z");
    const retainedBodies = [retainedProject, retainedGlobal].map(record => {
      assert.ok(record?.content_ref);
      const reference = record.content_ref as JsonObject;
      assert.equal(existsSync(String(reference.path)), true);
      return store.contentStore.readCompatSync(reference as never).body;
    });
    assert.deepEqual(retainedBodies, ["Prefer small diffs", "Prefer small diffs"]);

    const expiredCapture = (inputSessionId: string) => { const sessionId = sessionKey(inputSessionId); return service.memoryCaptureUserStatement({ content: "Expired transient fact", kind: "preference", topic: "expired-fact",
      scope_kind: "session", scope_id: sessionId, session_id: sessionId, project_scope_id: "project-1", project_root: projectRoots[0],
      valid_until: "2000-01-01T00:00:00.000Z" }); };
    assert.equal((expiredCapture("expired-session-1").promotions as unknown[]).length, 0);
    assert.equal((expiredCapture("expired-session-2").promotions as unknown[]).length, 0);
    const expiredObservations = store.list("memory_observation", 100, row => row.content_digest === digestJson("Expired transient fact"));
    assert.equal(expiredObservations.length, 2);
    assert.ok(expiredObservations.every(row => row.valid_until === "2000-01-01T00:00:00.000Z"));

    const captureAnotherFact = (inputSessionId: string, projectId: string) => { const sessionId = sessionKey(inputSessionId); return service.memoryCaptureObservedFact({ content: "Quartz fruit is locally preferred",
      kind: "preference", topic: "fruit-preference", scope_kind: "session", scope_id: sessionId, session_id: sessionId, project_scope_id: projectId,
      project_root: projectRoots[Number(projectId.at(-1)) - 1] }); };
    captureAnotherFact("session-na1", "project-1");
    assert.equal((captureAnotherFact("session-na2", "project-1").promotions as Array<Record<string, unknown>>)[0]?.tier, "project");
    captureAnotherFact("session-nb1", "project-2");
    assert.equal((captureAnotherFact("session-nb2", "project-2").promotions as Array<Record<string, unknown>>)[0]?.tier, "project");
    captureAnotherFact("session-nc1", "project-3");
    assert.deepEqual((captureAnotherFact("session-nc2", "project-3").promotions as Array<Record<string, unknown>>).map(item => item.tier), ["project", "global"]);

    const projectFile = join(projectRoots[0]!, ".craft_data", "memory", "memory.md");
    const globalFile = join(dataRoot, "memory", "memory.md");
    assert.match(readFileSync(projectFile, "utf8"), /Prefer small diffs/u);
    assert.match(readFileSync(globalFile, "utf8"), /Prefer small diffs/u);

    const archivedId = sessionKey("session-a1");
    const archived = service.memorySessionArchive({ session_id: archivedId });
    assert.equal(archived.content_deleted, true);
    assert.equal(service.memorySessionArchive({ session_id: archivedId }).idempotent, true);
    assert.equal(existsSync(ledgerFiles.pathFor({ kind: "session", id: archivedId })!), false);
    assert.equal(store.listScoped("memory_ledger", [{ kind: "session", id: archivedId }], 100).length, 0);
    assert.equal(store.list("memory_ledger", 100, row => row.status === "active" && (row.scope as Record<string, unknown>)?.kind === "global").length, 2);
    assert.deepEqual([retainedProject, retainedGlobal].map(record => {
      const reference = record?.content_ref as JsonObject;
      assert.equal(existsSync(String(reference.path)), true);
      return store.contentStore.readCompatSync(reference as never).body;
    }), retainedBodies);
    const beforeArchivedReplay = { evidence: store.count("evidence"), candidates: store.count("memory_candidate"), ledger: store.count("memory_ledger") };
    const replayed = service.memoryCaptureObservedFact({ content: "Late event after archive", kind: "preference", topic: "late-event",
      scope_kind: "session", scope_id: archivedId, session_id: archivedId, project_scope_id: "project-1", project_root: projectRoots[0] });
    assert.equal(replayed.status, "archived");
    assert.equal(replayed.next_action, "session_archive_is_terminal");
    assert.deepEqual({ evidence: store.count("evidence"), candidates: store.count("memory_candidate"), ledger: store.count("memory_ledger") }, beforeArchivedReplay);
    assert.equal(existsSync(ledgerFiles.pathFor({ kind: "session", id: archivedId })!), false);

    const hostileSession = sessionKey("hostile-session");
    store.create("memory_ledger", "hostile-path", { scope: { kind: "session", id: hostileSession }, status: "active", content_ref: { path: outside } });
    store.create("memory_ledger", "missing-path", { scope: { kind: "session", id: hostileSession }, status: "active" });
    store.create("memory_ledger", "gone-path", { scope: { kind: "session", id: hostileSession }, status: "active", content_ref: { path: join(store.paths.memoryContentDir, "gone.md") } });
    service.memorySessionArchive({ session_id: hostileSession });
    assert.equal(existsSync(outside), true);
    const invalidUnlinkPath = join(store.paths.memoryContentDir, "unlink-directory");
    mkdirSync(invalidUnlinkPath, { recursive: true });
    const invalidUnlinkSession = sessionKey("invalid-unlink-session");
    store.create("memory_ledger", "invalid-unlink", { scope: { kind: "session", id: invalidUnlinkSession }, status: "active", content_ref: { path: invalidUnlinkPath } });
    assert.throws(() => service.memorySessionArchive({ session_id: invalidUnlinkSession }));
    rmSync(invalidUnlinkPath, { recursive: true, force: true });
    store.remove("memory_ledger", "invalid-unlink");

    store.create("memory_ledger", "user-memory-without-topic", { scope: { kind: "user", id: "local" }, status: "active", kind: "preference", content: "a user preference" });
    store.create("memory_ledger", "user-memory-without-label", { scope: { kind: "user", id: "local" }, status: "active", content: "legacy content" });
    store.create("memory_ledger", "global-memory-without-label", { scope: { kind: "global", id: "global" }, status: "active", topic: "", kind: "", content: "legacy global" });
    store.create("memory_ledger", "global-memory-without-content", { scope: { kind: "global", id: "global" }, status: "active", topic: "empty-body", kind: "preference", content: null });
    assert.equal(ledgerFiles.sync({ kind: "user", id: "local" }).status, "written");
    assert.match(readFileSync(globalFile, "utf8"), /user-memory-without-label/u);
    assert.match(readFileSync(globalFile, "utf8"), /global-memory-without-label/u);

    const idempotentEvidence = service.evidenceRecord({ evidence_id: "evidence-idempotent-projection", source_type: "human", confidence: "bounded", claim: "Idempotent projection", locator: "test:idempotent" });
    const idempotentMemory = { memory_id: "idempotent-projection", source_id: "builtin.evidence-wiki", kind: "preference", scope_kind: "global", scope_id: "global",
      content: "Idempotent global entry", topic: "idempotent-entry", confidence: "bounded", evidence_ids: [idempotentEvidence.id], observed_at: "2026-01-01T00:00:00.000Z", effective_from: "2026-01-01T00:00:00.000Z" };
    service.memoryGovernance.ledger.remember(idempotentMemory);
    const idempotentResult = service.memoryGovernance.ledger.remember(idempotentMemory);
    assert.equal(idempotentResult.idempotent, true);
    assert.equal((idempotentResult.projection as JsonObject).status, "written");

    const captureKernel = new MemoryCapture(service.memoryGovernance, () => service.knowledgeMemoryInstallBuiltins(), args => service.evidenceRecord(args)) as unknown as {
      captureUserStatement(args: JsonObject): JsonObject;
      promoteRepeatedFact(input: { sessionId: string; projectId: string; candidate: JsonObject }): JsonObject[];
      resolveRepeatedConflict(promoted: JsonObject, evidenceIds: string[]): JsonObject;
    };
    captureKernel.captureUserStatement({ content: "Local fallback scope", kind: "episodic", scope_kind: "user", topic: "local-fallback" });
    const globalFallback = captureKernel.captureUserStatement({ content: "Global fallback scope", kind: "episodic", scope_kind: "global", topic: "global-fallback" });
    assert.deepEqual((globalFallback.candidate as JsonObject).scope, { kind: "global", id: "global" });
    const standaloneSessionId = sessionKey("session-without-project");
    const standaloneSession = captureKernel.captureUserStatement({ content: "Session without a project", kind: "episodic", scope_kind: "session", scope_id: standaloneSessionId, topic: "standalone-session" });
    assert.equal((standaloneSession.promotions as unknown[]).length, 0);
    const noRootSessionId = sessionKey("project-session-without-root");
    const projectWithoutRoot = captureKernel.captureUserStatement({ content: "Project session without explicit root", kind: "episodic", scope_kind: "session", scope_id: noRootSessionId,
      project_scope_id: "project-2", topic: "project-session-without-root" });
    assert.equal((projectWithoutRoot.promotions as unknown[]).length, 0);
    assert.deepEqual(captureKernel.promoteRepeatedFact({ sessionId: "invalid", projectId: "project-1", candidate: {} }), []);
    assert.deepEqual(captureKernel.promoteRepeatedFact({ sessionId: "invalid", projectId: "project-1", candidate: { content_digest: "sha256:bad", scope: { kind: "global" } } }), []);
    const directCandidate = (contentDigest: string, projectId: string, sessionId: string, topic?: string, withEvidence = true) => {
      const evidence = service.evidenceRecord({ evidence_id: `evidence-${sessionId}`, source_type: "human", confidence: "bounded", claim: "Repeated Memory evidence", locator: `test:${sessionId}` });
      return captureKernel.promoteRepeatedFact({ sessionId, projectId, candidate: { content_digest: digestJson(contentDigest), scope: { kind: "session", id: sessionId }, kind: "preference",
        content: contentDigest, source_id: "builtin.evidence-wiki", sensitivity: "internal", ...(withEvidence ? { evidence_ids: [evidence.id] } : {}), ...(topic ? { topic } : {}) } });
    };
    assert.deepEqual(directCandidate("sha256:orphan", "project-1", "no-scope"), []);
    for (const [projectId, prefix] of [["project-1", "nt-a"], ["project-2", "nt-b"], ["project-3", "nt-c"]]) {
      directCandidate("sha256:no-topic", projectId, `${prefix}1`);
      const promoted = directCandidate("sha256:no-topic", projectId, `${prefix}2`);
      if (projectId === "project-3") {
        assert.deepEqual(promoted.map(item => item.tier), ["project", "global"]);
        assert.equal(promoted[1]?.auto_committed, true, JSON.stringify(promoted[1]));
      }
    }
    store.create("memory_ledger", "project-conflict", { scope: { kind: "project", id: "project-1" }, status: "active", kind: "preference",
      topic: "conflict-topic", content: "Previous conflicting preference", content_digest: "sha256:old-conflict", confidence: "bounded", evidence_ids: [] });
    directCandidate("sha256:conflict-promotion", "project-1", "conflict1", "conflict-topic");
    const conflictedPromotion = directCandidate("sha256:conflict-promotion", "project-1", "conflict2", "conflict-topic");
    const projectResolution = conflictedPromotion[0]!;
    assert.equal(projectResolution.auto_committed, true);
    assert.equal((projectResolution.candidate as JsonObject).status, "approved");
    assert.equal(projectResolution.conflict_resolution, "supersede");
    assert.equal(((projectResolution.candidate as JsonObject).conflict_resolution as JsonObject).resolution, "supersede");
    assert.equal(((projectResolution.candidate as JsonObject).conflict_resolution as JsonObject).actor, "automatic-repeat-evidence");
    assert.equal((projectResolution.memory_file as JsonObject).status, "written");
    assert.equal((store.get("memory_ledger", "project-conflict")).status, "superseded");
    assert.equal((store.get("memory_ledger", "project-conflict")).replacement_id, (projectResolution.memory as JsonObject).id);
    assert.equal((projectResolution.superseded as JsonObject[])[0]?.id, "project-conflict");
    directCandidate("no-evidence fact", "project-2", "ne1", "no-evidence", false);
    const noEvidencePromotion = directCandidate("no-evidence fact", "project-2", "ne2", "no-evidence", false);
    assert.equal((noEvidencePromotion[0]?.candidate as JsonObject).status, "candidate");
    store.create("memory_ledger", "no-evidence-conflict", { scope: { kind: "project", id: "project-2" }, status: "active", kind: "preference",
      topic: "no-evidence-conflict", content: "Prior unsupported preference", content_digest: "sha256:no-evidence-old", confidence: "bounded", evidence_ids: [] });
    directCandidate("unsupported conflicting fact", "project-2", "nec1", "no-evidence-conflict", false);
    const noEvidenceConflict = directCandidate("unsupported conflicting fact", "project-2", "nec2", "no-evidence-conflict", false);
    assert.equal((noEvidenceConflict[0]?.candidate as JsonObject).status, "conflict_pending");
    assert.equal((noEvidenceConflict[0]?.auto_committed), false);
    const missingEvidenceConflict = { candidate: { id: "missing-evidence-candidate", status: "conflict_pending" } };
    assert.equal(captureKernel.resolveRepeatedConflict(missingEvidenceConflict, ["evidence-does-not-exist"]), missingEvidenceConflict);
    assert.deepEqual(captureKernel.resolveRepeatedConflict({}, []), {});
    directCandidate("observation without evidence", "project-2", "oe1", "observation-evidence", false);
    directCandidate("observation without evidence", "project-2", "oe2", "observation-evidence", false);

    const aggregationEvidence = service.evidenceRecord({ evidence_id: "evidence-aggregation", source_type: "human", confidence: "bounded", claim: "Repeated project evidence", locator: "test:aggregation" });
    const aggregationContent = "project evidence with one legacy gap";
    const aggregationDigest = digestJson(aggregationContent);
    const aggregationProjects: Array<[string, number]> = [["project-1", 1], ["project-2", 2], ["project-3", 3]];
    for (const [projectId, index] of aggregationProjects) {
      store.create("memory_ledger", `aggregation-${index}`, { scope: { kind: "project", id: projectId }, status: "active", kind: "preference", topic: "aggregation-topic",
        content: aggregationContent, content_digest: aggregationDigest, confidence: "bounded", ...(index < 3 ? { evidence_ids: [aggregationEvidence.id] } : {}) });
    }
    directCandidate(aggregationContent, "project-1", "aggregation-trigger1", "aggregation-topic");
    const aggregationResult = directCandidate(aggregationContent, "project-1", "aggregation-trigger2", "aggregation-topic");
    assert.equal(aggregationResult[0]?.tier, "global");

    const observationContent = "observation with legacy evidence gap";
    const observationDigest = digestJson(observationContent);
    store.create("memory_observation", "observation-without-evidence", { content_digest: observationDigest, project_id: "project-2", session_digest: digestJson("old-session"),
      kind: "preference", topic: "observation-evidence", content_free: true, status: "active", evidence_ids: null });
    directCandidate(observationContent, "project-2", "observation-current-session", "observation-evidence", false);

    const globalConflictContent = "blocked cross-project promotion";
    const globalConflictDigest = digestJson(globalConflictContent);
    for (const [projectId, index] of aggregationProjects) {
      const projectEvidence = service.evidenceRecord({ evidence_id: `evidence-global-conflict-${index}`, source_type: "human", confidence: "bounded", claim: "Independent project support", locator: `test:global-conflict-${index}` });
      store.create("memory_ledger", `global-conflict-project-${index}`, { scope: { kind: "project", id: projectId }, status: "active", kind: "preference", topic: "global-conflict",
        content: globalConflictContent, content_digest: globalConflictDigest, confidence: "bounded", evidence_ids: [projectEvidence.id] });
    }
    const globalConflictEvidence = service.evidenceRecord({ evidence_id: "evidence-global-conflict-baseline", source_type: "human", confidence: "bounded", claim: "Existing global support", locator: "test:global-conflict-baseline" });
    store.create("memory_ledger", "global-conflicting-preference", { scope: { kind: "global", id: "global" }, status: "active", kind: "preference", topic: "global-conflict",
      content: "Existing global preference", content_digest: "sha256:different-global-content", confidence: "bounded", evidence_ids: [globalConflictEvidence.id] });
    directCandidate(globalConflictContent, "project-1", "global-conflict-trigger1", "global-conflict");
    const globalResolution = directCandidate(globalConflictContent, "project-1", "global-conflict-trigger2", "global-conflict");
    assert.equal(globalResolution[0]?.tier, "global");
    assert.equal(globalResolution[0]?.auto_committed, true);
    assert.equal((globalResolution[0]?.candidate as JsonObject).status, "approved");
    assert.equal((globalResolution[0]?.memory_file as JsonObject).status, "written");
    assert.equal(store.get("memory_ledger", "global-conflicting-preference").status, "superseded");
    assert.equal(store.get("memory_ledger", "global-conflicting-preference").replacement_id, (globalResolution[0]?.memory as JsonObject).id);

    service.memoryPolicySave({ mode: "propose", updated_by: "test" });
    store.create("memory_ledger", "policy-blocked-conflict", { scope: { kind: "project", id: "project-2" }, status: "active", kind: "preference",
      topic: "policy-blocked", content: "Previous policy preference", content_digest: "sha256:policy-old", confidence: "bounded", evidence_ids: [] });
    directCandidate("policy-blocked-content", "project-2", "policy-blocked1", "policy-blocked");
    const policyBlocked = directCandidate("policy-blocked-content", "project-2", "policy-blocked2", "policy-blocked");
    assert.equal((policyBlocked[0]?.candidate as JsonObject).status, "conflict_pending");
    assert.equal(policyBlocked[0]?.auto_committed, false);
    assert.equal(store.get("memory_ledger", "policy-blocked-conflict").status, "active");

    const policyBlockedGlobalContent = "global candidate remains reviewable";
    const policyBlockedGlobalDigest = digestJson(policyBlockedGlobalContent);
    for (const [projectId, index] of aggregationProjects) {
      const projectEvidence = service.evidenceRecord({ evidence_id: `evidence-policy-global-${index}`, source_type: "human", confidence: "bounded", claim: "Project support", locator: `test:policy-global-${index}` });
      store.create("memory_ledger", `policy-global-project-${index}`, { scope: { kind: "project", id: projectId }, status: "active", kind: "preference", topic: "policy-global",
        content: policyBlockedGlobalContent, content_digest: policyBlockedGlobalDigest, confidence: "bounded", evidence_ids: [projectEvidence.id] });
    }
    store.create("memory_ledger", "policy-global-conflict", { scope: { kind: "global", id: "global" }, status: "active", kind: "preference", topic: "policy-global",
      content: "Previous global candidate", content_digest: "sha256:policy-global-old", confidence: "bounded", evidence_ids: [] });
    directCandidate(policyBlockedGlobalContent, "project-1", "policy-global1", "policy-global");
    const policyBlockedGlobal = directCandidate(policyBlockedGlobalContent, "project-1", "policy-global2", "policy-global");
    assert.equal(policyBlockedGlobal[0]?.tier, "global");
    assert.equal((policyBlockedGlobal[0]?.candidate as JsonObject).status, "conflict_pending");
    assert.equal(policyBlockedGlobal[0]?.auto_committed, false);
    assert.equal(store.get("memory_ledger", "policy-global-conflict").status, "active");

    service.memoryPolicySave({ mode: "governed", min_confidence: "confirmed", updated_by: "test" });
    store.create("memory_ledger", "confidence-blocked-conflict", { scope: { kind: "project", id: "project-2" }, status: "active", kind: "preference",
      topic: "confidence-blocked", content: "Previous confidence preference", content_digest: "sha256:confidence-old", confidence: "bounded", evidence_ids: [] });
    directCandidate("confidence-blocked-content", "project-2", "confidence-blocked1", "confidence-blocked");
    const confidenceBlocked = directCandidate("confidence-blocked-content", "project-2", "confidence-blocked2", "confidence-blocked");
    assert.equal((confidenceBlocked[0]?.candidate as JsonObject).status, "conflict_pending");
    assert.equal(confidenceBlocked[0]?.auto_committed, false);
  } finally {
    for (const sessionId of ["session-a1", "session-a2", "session-a3", "session-b1", "session-b2", "session-c1", "session-c2", "session-c3", "session-na1", "session-na2", "session-nb1", "session-nb2", "session-nc1", "session-nc2", "expired-session-1", "expired-session-2", "hostile-session", "invalid-unlink-session", "session-without-project", "project-session-without-root"]) ledgerFiles.archiveSession(sessionKey(sessionId));
    store.close();
    rmSync(dataRoot, { recursive: true, force: true });
    projectRoots.forEach(root => rmSync(root, { recursive: true, force: true }));
    // Guard against surprising path fallback behavior in fixture runs.
    assert.equal(join("/tmp", ".craft_data", "memory").startsWith("/tmp/"), true);
  }
});

test("Memory active reads, topic hints and file projections exclude expired, future and conflicting facts", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "craft-memory-temporal-tiers-"));
  const store = await new CraftStore(craftPaths(dataRoot)).open();
  const service = new CraftService(store);
  try {
    service.knowledgeMemoryInstallBuiltins();
    const remember = (id: string, topic: string, content: string, dates: { valid_until?: string; effective_from?: string } = {}, scopeKind = "global", scopeId = "global") =>
      service.memoryLedgerRemember({ memory_id: id, source_id: "builtin.evidence-wiki", kind: "preference", scope_kind: scopeKind, scope_id: scopeId,
        topic, content, confidence: "bounded", sensitivity: "internal", observed_at: "2026-01-01T00:00:00.000Z", ...dates });
    remember("expired-pref", "expired-topic", "coding expired preference", { valid_until: "2020-01-01T00:00:00.000Z" });
    remember("future-pref", "future-topic", "coding future preference", { effective_from: "2999-01-01T00:00:00.000Z" });
    remember("conflict-a", "conflict-topic", "coding alpha preference");
    remember("conflict-b", "conflict-topic", "coding beta preference");
    remember("current-pref", "current-topic", "coding style small diffs");

    const listed = service.memoryLedgerList({ scope_kind: "global", scope_id: "global" });
    assert.deepEqual((listed.memories as JsonObject[]).map(item => item.id), ["current-pref"]);
    const historical = service.memoryLedgerList({ scope_kind: "global", scope_id: "global", include_history: true });
    assert.equal((historical.memories as JsonObject[]).length, 5);
    const projection = readFileSync(join(dataRoot, "memory", "memory.md"), "utf8");
    assert.match(projection, /coding style small diffs/u);
    assert.doesNotMatch(projection, /expired preference|future preference|alpha preference|beta preference/u);
    const suggestions = service.memoryGovernance.topicSuggestions({ scope_kind: "global", scope_id: "global", content: "coding preference" });
    assert.deepEqual((suggestions.suggestions as JsonObject[]).map(item => item.memory_id), ["current-pref"]);
    remember("user-pref-a", "shared-user-topic", "coding user scope alpha", {}, "user", "user-a");
    remember("user-pref-b", "shared-user-topic", "coding user scope beta", {}, "user", "user-b");
    const combinedProjection = readFileSync(join(dataRoot, "memory", "memory.md"), "utf8");
    assert.match(combinedProjection, /coding user scope alpha/u);
    assert.match(combinedProjection, /coding user scope beta/u);
    const scheduled = service.memoryMaintenanceSchedule({ stage: "light", lease_id: "temporal-memory-exit" });
    assert.equal(((scheduled.receipt as JsonObject).expired_memory), 1);
    assert.equal(store.get("memory_ledger", "expired-pref").status, "expired");
  } finally {
    store.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
