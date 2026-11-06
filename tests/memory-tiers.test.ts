import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { JsonObject } from "../common/craft-common-store-local/src/store.ts";
import { digestJson } from "../common/craft-common-base/src/digest.ts";
import { CraftService } from "../core/service.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths, projectStorageDirectory } from "../core/infrastructure/paths.ts";
import { MemoryCapture } from "../capability/craft-memory/memory-capture.ts";
import { MemoryContribution } from "../capability/craft-memory/contribution.ts";

test("idempotent Memory capture restores a project observation after an interrupted write", async t => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-retry-")), project = join(root, "project");
  mkdirSync(project);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const service = new CraftService(store);
    service.knowledgeMemoryInstallBuiltins();
    store.create("scope_alias", "project", { scope: { kind: "project", id: "retry-project" }, alias_kind: "path", alias: project, status: "active" });
    const args = { session_id: "retry-session", project_scope_id: "retry-project", project_root: project,
      topic: "retry-fact", kind: "preference", content: "保留经过核验的项目约定" };
    const create = store.create.bind(store);
    const injected = t.mock.method(store, "create", (kind: string, id: string, payload: JsonObject) => {
      if (kind === "memory_observation") throw new Error("injected observation failure");
      return create(kind, id, payload);
    });
    assert.throws(() => service.memoryCaptureObservedFact(args), /injected observation failure/u);
    injected.mock.restore();
    assert.equal(store.list("memory_observation", 100).length, 0);
    const retried = service.memoryCaptureObservedFact(args);
    assert.equal(retried.already_retained, true);
    assert.deepEqual(retried.promotions, []);
    assert.equal(store.list("memory_observation", 100).length, 1);
    service.memoryCaptureObservedFact(args);
    assert.equal(store.list("memory_observation", 100).length, 1);
    assert.throws(() => service.memoryCaptureObservedFact({ ...args, candidate_id: "different-candidate" }), /observation intent idempotency conflict/u);
    const remove = store.remove.bind(store);
    const interrupted = t.mock.method(store, "remove", (kind: string, id: string) => {
      if (kind === "memory_candidate") throw new Error("injected cleanup interruption");
      return remove(kind, id);
    });
    assert.throws(() => service.memorySessionArchive({ session_id: args.session_id }), /injected cleanup interruption/u);
    interrupted.mock.restore();
    assert.equal(store.list("memory_ledger", 10, row => (row.scope as JsonObject)?.kind === "session").length, 0);
    service.memorySessionArchive({ session_id: args.session_id });
    assert.equal(store.list("memory_observation", 100).length, 1);
    const withoutRoot = { ...args, session_id: "without-root", project_root: undefined, topic: "other-fact", content: "另一个约定" };
    service.memoryCaptureObservedFact(withoutRoot);
    assert.equal(service.memoryCaptureObservedFact(withoutRoot).already_retained, true);
    const withoutProject = { session_id: "without-project", topic: "temporary", content: "会话临时约定" };
    service.memoryCaptureUserStatement(withoutProject);
    assert.equal(service.memoryCaptureUserStatement(withoutProject).already_retained, true);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("session archive restores a committed project observation after capture interruption", async t => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-archive-observation-")), project = join(root, "project");
  mkdirSync(project);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const service = new CraftService(store);
    service.knowledgeMemoryInstallBuiltins();
    store.create("scope_alias", "project", { scope: { kind: "project", id: "archive-project" }, alias_kind: "path", alias: project, status: "active" });
    const args = { session_id: "archive-session", project_scope_id: "archive-project", project_root: project,
      topic: "archive-fact", kind: "preference", content: "会话归档前保留项目观察", valid_until: "2999-01-01T00:00:00.000Z" };
    const create = store.create.bind(store);
    const injected = t.mock.method(store, "create", (kind: string, id: string, payload: JsonObject) => {
      if (kind === "memory_observation") throw new Error("injected observation failure");
      return create(kind, id, payload);
    });
    assert.throws(() => service.memoryCaptureObservedFact(args), /injected observation failure/u);
    injected.mock.restore();
    assert.equal(store.list("memory_observation", 100).length, 0);
    const displaced = join(root, "project-unavailable");
    renameSync(project, displaced);
    try {
      assert.throws(() => service.memorySessionArchive({ session_id: args.session_id }), /project.*(root|registered|unavailable)/iu);
      assert.equal(store.list("memory_observation_intent", 100).length, 1);
      assert.equal(store.list("memory_ledger", 10, row => (row.scope as JsonObject)?.kind === "session").length, 1);
    } finally { renameSync(displaced, project); }
    service.memorySessionArchive({ session_id: args.session_id });
    const observations = store.list("memory_observation", 100);
    assert.equal(observations.length, 1);
    assert.equal(observations[0]!.project_id, args.project_scope_id);
    assert.equal(observations[0]!.valid_until, args.valid_until);
    assert.equal(store.list("memory_observation_intent", 100).length, 0);
    assert.equal(service.memorySessionArchive({ session_id: args.session_id }).idempotent, true);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("session archive recovers an observation without a topic", async t => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-archive-no-topic-")), project = join(root, "project");
  mkdirSync(project);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const service = new CraftService(store);
    service.knowledgeMemoryInstallBuiltins();
    store.create("scope_alias", "project", { scope: { kind: "project", id: "no-topic-project" }, alias_kind: "path", alias: project, status: "active" });
    const create = store.create.bind(store);
    const fault = t.mock.method(store, "create", (kind: string, id: string, payload: JsonObject) => {
      if (kind === "memory_observation") throw new Error("interrupted");
      return create(kind, id, payload);
    });
    assert.throws(() => service.memoryCaptureObservedFact({ session_id: "no-topic-session", project_scope_id: "no-topic-project", project_root: project,
      content: "不带主题的会话事实" }), /interrupted/u);
    fault.mock.restore();
    assert.equal(service.memorySessionArchive({ session_id: "no-topic-session" }).status, "archived");
    assert.equal(store.list("memory_observation", 10)[0]?.topic, "");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("session archive does not restore an observation from revoked session Memory", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-archive-revoked-")), project = join(root, "project");
  mkdirSync(project);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const service = new CraftService(store);
    service.knowledgeMemoryInstallBuiltins();
    store.create("scope_alias", "project", { scope: { kind: "project", id: "revoked-project" }, alias_kind: "path", alias: project, status: "active" });
    service.memoryCaptureObservedFact({ session_id: "revoked-session", project_scope_id: "revoked-project", project_root: project, content: "已经撤销的事实" });
    const intent = store.list("memory_observation_intent", 10)[0]!;
    const candidate = store.get("memory_candidate", String(intent.candidate_id));
    const memory = store.get("memory_ledger", String(candidate.ledger_memory_id));
    const observation = store.list("memory_observation", 10)[0]!;
    store.remove("memory_observation", String(observation.id));
    store.save("memory_ledger", String(memory.id), { ...memory, status: "revoked" });
    assert.equal(service.memorySessionArchive({ session_id: "revoked-session" }).status, "archived");
    assert.equal(store.list("memory_observation", 10).length, 0);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("session archive refuses mismatched observation intents without deleting session Memory", async () => {
  for (const [field, value] of [["content_digest", "wrong"], ["kind", "wrong"], ["topic", "wrong"], ["evidence_id", "wrong"], ["project_id", "wrong"]] as const) {
    const root = mkdtempSync(join(tmpdir(), "craft-memory-invalid-intent-")), project = join(root, "project");
    mkdirSync(project);
    const store = await new CraftStore(craftPaths(join(root, "data"))).open();
    try {
      const service = new CraftService(store);
      service.knowledgeMemoryInstallBuiltins();
      store.create("scope_alias", "project", { scope: { kind: "project", id: "intent-project" }, alias_kind: "path", alias: project, status: "active" });
      service.memoryCaptureObservedFact({ session_id: "intent-session", project_scope_id: "intent-project", project_root: project,
        topic: "intent-fact", kind: "preference", content: "归档验证项目观察" });
      const intent = store.list("memory_observation_intent", 10)[0]!;
      store.save("memory_observation_intent", String(intent.id), { ...intent, [field]: value });
      assert.throws(() => service.memorySessionArchive({ session_id: "intent-session" }), /SESSION_ARCHIVE_OBSERVATION_UNVERIFIED/u);
      assert.equal(store.list("memory_ledger", 10, row => (row.scope as JsonObject)?.kind === "session").length, 1);
      assert.equal(store.list("memory_observation_intent", 10).length, 1);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  }
});

test("session archive rejects an altered existing observation", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-altered-observation-")), project = join(root, "project");
  mkdirSync(project);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const service = new CraftService(store);
    service.knowledgeMemoryInstallBuiltins();
    store.create("scope_alias", "project", { scope: { kind: "project", id: "observation-project" }, alias_kind: "path", alias: project, status: "active" });
    service.memoryCaptureObservedFact({ session_id: "observation-session", project_scope_id: "observation-project", project_root: project,
      topic: "observation-fact", content: "归档前核对既有观察" });
    const observation = store.list("memory_observation", 10)[0]!;
    store.save("memory_observation", String(observation.id), { ...observation, content_digest: "tampered" });
    assert.throws(() => service.memorySessionArchive({ session_id: "observation-session" }), /existing observation identity changed/u);
    assert.equal(store.list("memory_observation_intent", 10).length, 1);
    assert.equal(store.list("memory_ledger", 10, row => (row.scope as JsonObject)?.kind === "session").length, 1);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("session archive fails closed when committed Memory or its capture Evidence is missing or altered", async () => {
  for (const missing of ["evidence", "memory", "evidence_changed", "memory_changed", "candidate_evidence"]) {
    const root = mkdtempSync(join(tmpdir(), "craft-memory-archive-missing-")), project = join(root, "project");
    mkdirSync(project);
    const store = await new CraftStore(craftPaths(join(root, "data"))).open();
    try {
      const service = new CraftService(store);
      service.knowledgeMemoryInstallBuiltins();
      store.create("scope_alias", "project", { scope: { kind: "project", id: "missing-project" }, alias_kind: "path", alias: project, status: "active" });
      service.memoryCaptureObservedFact({ session_id: "missing-session", project_scope_id: "missing-project", project_root: project,
        topic: "missing-fact", content: "归档前核验支持证据" });
      const intent = store.list("memory_observation_intent", 10)[0]!;
      const candidate = store.get("memory_candidate", String(intent.candidate_id));
      if (missing === "evidence") store.remove("evidence", String(intent.evidence_id));
      else if (missing === "memory") store.remove("memory_ledger", String(candidate.ledger_memory_id));
      else if (missing === "evidence_changed") {
        const evidence = store.get("evidence", String(intent.evidence_id));
        store.save("evidence", String(intent.evidence_id), { ...evidence, metadata: { capture_digest: "changed" } });
      } else if (missing === "memory_changed") {
        const memory = store.get("memory_ledger", String(candidate.ledger_memory_id));
        store.save("memory_ledger", String(memory.id), { ...memory, content_digest: "changed" });
      } else store.save("memory_candidate", String(candidate.id), { ...candidate, evidence_ids: [] });
      assert.throws(() => service.memorySessionArchive({ session_id: "missing-session" }), /SESSION_ARCHIVE_OBSERVATION_UNVERIFIED/u);
      assert.equal(store.list("memory_observation_intent", 10).length, 1);
      assert.equal(store.find("memory_candidate", String(candidate.id))?.status, "approved");
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  }
});

test("session archive refuses candidate and Memory references from another session", async () => {
  for (const changed of ["candidate", "memory"]) {
    const root = mkdtempSync(join(tmpdir(), "craft-memory-foreign-session-")), project = join(root, "project");
    mkdirSync(project);
    const store = await new CraftStore(craftPaths(join(root, "data"))).open();
    try {
      const service = new CraftService(store);
      service.knowledgeMemoryInstallBuiltins();
      store.create("scope_alias", "project", { scope: { kind: "project", id: "foreign-project" }, alias_kind: "path", alias: project, status: "active" });
      const base = { project_scope_id: "foreign-project", project_root: project, topic: "foreign-fact", content: "按会话验证来源" };
      service.memoryCaptureObservedFact({ ...base, session_id: "first-session" });
      service.memoryCaptureObservedFact({ ...base, session_id: "second-session" });
      const intents = store.list("memory_observation_intent", 10);
      const first = intents.find(item => (item.scope as JsonObject).id === "first-session")!;
      const second = intents.find(item => (item.scope as JsonObject).id === "second-session")!;
      const candidate = store.get("memory_candidate", String(first.candidate_id));
      const otherCandidate = store.get("memory_candidate", String(second.candidate_id));
      if (changed === "candidate") store.save("memory_observation_intent", String(first.id), { ...first, candidate_id: otherCandidate.id });
      else store.save("memory_candidate", String(candidate.id), { ...candidate, ledger_memory_id: otherCandidate.ledger_memory_id });
      assert.throws(() => service.memorySessionArchive({ session_id: "first-session" }), /session scope changed/u);
      assert.equal(store.listSessionMemoryPage("memory_observation_intent", "first-session").records.length, 1);
      assert.equal(store.listSessionMemoryPage("memory_observation_intent", "second-session").records.length, 1);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  }
});

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
    assert.equal(ledgerFiles.pathFor({ kind: "project", id: "project-1" }, projectRoots[0]), join(projectStorageDirectory(store.paths, projectRoots[0]!), "memory", "memory.md"));
    assert.equal(ledgerFiles.pathFor({ kind: "project", id: "project-1" }), join(projectStorageDirectory(store.paths, projectRoots[0]!), "memory", "memory.md"));
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

    const projectFile = join(projectStorageDirectory(store.paths, projectRoots[0]!), "memory", "memory.md");
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

test("revoking one project supporter retires global Memory and old observations cannot revive it", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "craft-memory-promotion-exit-"));
  const projectRoots = [1, 2, 3].map(index => mkdtempSync(join(tmpdir(), `craft-memory-support-${index}-`)));
  const store = await new CraftStore(craftPaths(dataRoot)).open();
  const service = new CraftService(store);
  const sessions: string[] = [];
  try {
    service.knowledgeMemoryInstallBuiltins();
    projectRoots.forEach((root, index) => store.create("scope_alias", `support-${index}`, {
      scope: { kind: "project", id: `support-${index}` }, alias_kind: "path", alias: root, status: "active",
    }));
    const capture = (projectIndex: number) => {
      const sessionId = `support-session-${randomUUID()}`;
      sessions.push(sessionId);
      return service.memoryCaptureObservedFact({ session_id: sessionId, project_scope_id: `support-${projectIndex}`,
        project_root: projectRoots[projectIndex], kind: "preference", topic: "promotion-exit", content: "Keep the verified dependency" });
    };
    const factDigest = digestJson("Keep the verified dependency");
    store.create("memory_ledger", "unrelated-project-ledger", { scope: { kind: "project", id: "support-0" },
      content_digest: factDigest, kind: "working", topic: "other-topic", status: "active" });
    store.create("memory_ledger", "unrelated-global-ledger", { scope: { kind: "global", id: "global" },
      content_digest: factDigest, kind: "working", topic: "other-topic", status: "active" });
    for (let projectIndex = 0; projectIndex < 3; projectIndex += 1) { capture(projectIndex); capture(projectIndex); }
    const promotedFact = (item: JsonObject) => item.kind === "preference" && item.topic === "promotion-exit";
    const project = store.list("memory_ledger", 100, item => item.status === "active" && promotedFact(item) && (item.scope as JsonObject | undefined)?.id === "support-0")[0]!;
    const global = store.list("memory_ledger", 100, item => item.status === "active" && promotedFact(item) && (item.scope as JsonObject | undefined)?.kind === "global")[0]!;
    const unrelatedKind = store.create("memory_observation", "unrelated-support-kind", { scope: { kind: "project", id: "support-0" },
      project_id: "support-0", session_digest: "unrelated-kind", content_digest: project.content_digest,
      kind: "working", topic: "promotion-exit", status: "active" });
    const unrelatedTopic = store.create("memory_observation", "unrelated-support-topic", { scope: { kind: "project", id: "support-0" },
      project_id: "support-0", session_digest: "unrelated-topic", content_digest: project.content_digest,
      kind: "preference", topic: "other-topic", status: "active" });
    assert.equal(global.status, "active");
    assert.throws(() => service.memoryLedgerTransition({ memory_id: project.id, expected_version: 0, status: "revoked", reason: "incorrect project fact" }), /expected_version|Concurrent update/u);
    assert.equal(store.get("memory_ledger", String(global.id)).status, "active");
    service.memoryLedgerTransition({ memory_id: project.id, expected_version: project.version, status: "revoked", reason: "incorrect project fact" });
    assert.equal(store.get("memory_ledger", String(global.id)).status, "revoked");
    const retiredGlobal = store.get("memory_ledger", String(global.id));
    const { id: _retiredId, version: _retiredVersion, created_at: _retiredCreated, updated_at: _retiredUpdated, ...retiredPayload } = retiredGlobal;
    store.save("memory_ledger", String(global.id), { ...retiredPayload, status: "active" });
    assert.equal(service.memoryLedgerTransition({ memory_id: project.id, status: "revoked", reason: "incorrect project fact" }).idempotent, true);
    assert.equal(store.get("memory_ledger", String(global.id)).status, "revoked", "idempotent replay reconciles an older stale global record");
    assert.throws(() => service.memoryLedgerTransition({ memory_id: project.id, status: "revoked", reason: "different reason" }), /active entry/u);
    assert.doesNotMatch(readFileSync(join(dataRoot, "memory", "memory.md"), "utf8"), /Keep the verified dependency/u);
    assert.deepEqual(store.list("memory_observation", 100, item => item.project_id === "support-0" && item.status === "active").map(item => item.id).sort(),
      [unrelatedKind.id, unrelatedTopic.id].sort());
    assert.equal((capture(0).promotions as JsonObject[]).length, 0);
    const renewed = capture(0).promotions as JsonObject[];
    assert.deepEqual(renewed.map(item => item.tier), ["project", "global"]);
    assert.equal(store.list("memory_ledger", 100, item => item.status === "active" && promotedFact(item) && (item.scope as JsonObject | undefined)?.kind === "global").length, 1);
    // A legacy or out-of-band status write must not leave a stale promoted fact readable.
    const renewedProject = store.list("memory_ledger", 100, item => item.status === "active" && promotedFact(item) && (item.scope as JsonObject | undefined)?.id === "support-0")[0]!;
    const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...projectPayload } = renewedProject;
    store.save("memory_ledger", String(renewedProject.id), { ...projectPayload, status: "revoked" });
    assert.equal(store.list("memory_ledger", 100, item => item.status === "active" && promotedFact(item) && (item.scope as JsonObject | undefined)?.kind === "global").length, 1);
    assert.equal((service.memoryLedgerList({ scope_kind: "global", scope_id: "global" }).memories as JsonObject[]).length, 0);
    const contribution = await new MemoryContribution(store).contribute({ query: "verified", scope_kind: "global", scope_id: "global", max_items: 5, max_chars: 5_000 });
    assert.equal(contribution.items.length, 0);
    service.memoryGovernance.ledger.files.sync({ kind: "global", id: "global" });
    assert.doesNotMatch(readFileSync(join(dataRoot, "memory", "memory.md"), "utf8"), /Keep the verified dependency/u);
  } finally {
    sessions.forEach(sessionId => service.memorySessionArchive({ session_id: sessionId }));
    store.close();
    rmSync(dataRoot, { recursive: true, force: true });
    projectRoots.forEach(root => rmSync(root, { recursive: true, force: true }));
  }
});

test("revoking a session supporter retires its project promotion and preserves the other session", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "craft-memory-session-support-exit-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "craft-memory-session-support-project-"));
  const store = await new CraftStore(craftPaths(dataRoot)).open();
  const service = new CraftService(store);
  const sessions = [randomUUID(), randomUUID(), randomUUID()];
  try {
    service.knowledgeMemoryInstallBuiltins();
    store.create("scope_alias", "session-support-project", { scope: { kind: "project", id: "session-support" }, alias_kind: "path", alias: projectRoot, status: "active" });
    const capture = (sessionId: string) => service.memoryCaptureObservedFact({ session_id: sessionId, project_scope_id: "session-support", project_root: projectRoot,
      kind: "preference", topic: "session-support-topic", content: "Verify a session source before promotion" });
    capture(sessions[0]!);
    assert.equal((capture(sessions[1]!).promotions as JsonObject[])[0]?.tier, "project");
    const project = store.list("memory_ledger", 100, item => item.status === "active" && (item.scope as JsonObject | undefined)?.id === "session-support")[0]!;
    const sessionMemory = store.listScoped("memory_ledger", [{ kind: "session", id: sessions[0]! }], 10)[0]!;
    service.memoryLedgerTransition({ memory_id: sessionMemory.id, status: "revoked", reason: "source corrected" });
    assert.equal(store.get("memory_ledger", String(project.id)).status, "revoked");
    assert.doesNotMatch(readFileSync(join(projectStorageDirectory(store.paths, projectRoot), "memory", "memory.md"), "utf8"), /Verify a session source/u);
    assert.equal(store.list("memory_observation", 100, item => item.status === "active" && item.project_id === "session-support").length, 1);
    assert.equal((capture(sessions[2]!).promotions as JsonObject[])[0]?.tier, "project");
    const latestSession = store.listScoped("memory_ledger", [{ kind: "session", id: sessions[2]! }], 10)[0]!;
    const malformed = store.create("memory_observation", "missing-project-observation", { scope: { kind: "project", id: "session-support" },
      session_digest: digestJson(sessions[2]!), content_digest: latestSession.content_digest,
      kind: "preference", topic: "session-support-topic", status: "active" });
    assert.throws(() => service.memoryLedgerTransition({ memory_id: latestSession.id, status: "revoked", reason: "malformed observation" }), /project scope is missing/u);
    assert.equal(store.get("memory_ledger", String(latestSession.id)).status, "active", "invalid support must roll back the transition");
    assert.equal(store.get("memory_observation", String(malformed.id)).status, "active");
  } finally {
    sessions.forEach(sessionId => service.memorySessionArchive({ session_id: sessionId }));
    store.close();
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("automatic Memory promotion verifies current independent support records", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "craft-memory-support-validation-"));
  const projectRoots = [1, 2, 3].map(index => mkdtempSync(join(tmpdir(), `craft-memory-validation-${index}-`)));
  const store = await new CraftStore(craftPaths(dataRoot)).open();
  const service = new CraftService(store);
  try {
    service.knowledgeMemoryInstallBuiltins();
    projectRoots.forEach((root, index) => store.create("scope_alias", `validation-${index}`, {
      scope: { kind: "project", id: `validation-${index}` }, alias_kind: "path", alias: root, status: "active",
    }));
    const content = "Validated support fact", contentDigest = digestJson(content);
    const observations = ["one", "two"].map(name => store.create("memory_observation", `observation-${name}`, {
      scope: { kind: "project", id: "validation-0" }, project_id: "validation-0", session_digest: `session-${name}`,
      content_digest: contentDigest, kind: "preference", topic: "support-validation", status: "active",
    }));
    const refs = observations.map(item => ({ kind: "memory_observation", id: String(item.id), version: Number(item.version) }));
    const ledger = service.memoryGovernance.ledger;
    const args = { proposed_by: "automatic-memory-promotion", promotion_support_refs: refs, scope_kind: "project", scope_id: "validation-0",
      content, kind: "preference", topic: "support-validation" };
    assert.deepEqual(ledger.validatePromotionSupport(args), refs);
    for (const invalid of [
      { proposed_by: "manual" }, { promotion_support_refs: undefined }, { scope_kind: "session" },
      { promotion_support_refs: [null, refs[1]] }, { promotion_support_refs: [[refs[0]], refs[1]] },
      { promotion_support_refs: [{ ...refs[0], kind: "memory_ledger" }, refs[1]] },
      { promotion_support_refs: [{ ...refs[0], version: 2 }, refs[1]] },
      { promotion_support_refs: [refs[0], refs[0]] }, { promotion_support_refs: [refs[0]] },
      { scope_id: "another-project" }, { content: "different fact" }, { kind: "working" }, { topic: "other-topic" },
    ]) assert.throws(() => ledger.validatePromotionSupport({ ...args, ...invalid }), /promotion support|promotion scope|support reference|independent|threshold/u);
    const expired = store.create("memory_observation", "expired-observation", { ...observations[0], id: undefined, version: undefined,
      session_digest: "expired-session", valid_until: "2000-01-01T00:00:00.000Z" });
    assert.throws(() => ledger.validatePromotionSupport({ ...args, promotion_support_refs: [refs[0], { kind: "memory_observation", id: expired.id, version: expired.version }] }), /no longer active/u);
    const malformedDate = store.create("memory_observation", "malformed-date-observation", { scope: { kind: "project", id: "validation-0" },
      project_id: "validation-0", session_digest: "invalid-date-session", content_digest: contentDigest,
      kind: "preference", topic: "support-validation", status: "active", valid_until: "not-a-date" });
    assert.throws(() => ledger.validatePromotionSupport({ ...args, promotion_support_refs: [refs[0], { kind: "memory_observation", id: malformedDate.id, version: malformedDate.version }] }), /no longer active/u);
    const invalidDateType = store.create("memory_observation", "invalid-date-type", { scope: { kind: "project", id: "validation-0" },
      project_id: "validation-0", session_digest: "invalid-type-session", content_digest: contentDigest,
      kind: "preference", topic: "support-validation", status: "active", valid_until: 42 });
    assert.throws(() => ledger.validatePromotionSupport({ ...args, promotion_support_refs: [refs[0], { kind: "memory_observation", id: invalidDateType.id, version: invalidDateType.version }] }), /no longer active/u);
    const missingSession = store.create("memory_observation", "missing-session-digest", { scope: { kind: "project", id: "validation-0" },
      project_id: "validation-0", content_digest: contentDigest, kind: "preference", topic: "support-validation", status: "active" });
    assert.throws(() => ledger.validatePromotionSupport({ ...args, promotion_support_refs: [refs[0], { kind: "memory_observation", id: missingSession.id, version: missingSession.version }] }), /independent/u);
    const emptySession = store.create("memory_observation", "empty-session-digest", { scope: { kind: "project", id: "validation-0" },
      project_id: "validation-0", session_digest: "", content_digest: contentDigest,
      kind: "preference", topic: "support-validation", status: "active" });
    assert.equal(ledger.promotionSupported({ scope: { kind: "project", id: "validation-0" }, content_digest: contentDigest,
      kind: "preference", topic: "support-validation", promotion_support_refs: [refs[0],
        { kind: "memory_observation", id: emptySession.id, version: emptySession.version }] }), false);
    const projects = projectRoots.map((_, index) => store.create("memory_ledger", `validation-project-${index}`, {
      scope: { kind: "project", id: `validation-${index}` }, content_digest: contentDigest, kind: "preference", topic: "support-validation", status: "active",
    }));
    const globalRefs = projects.map(item => ({ kind: "memory_ledger", id: String(item.id), version: Number(item.version) }));
    assert.equal(ledger.validatePromotionSupport({ ...args, scope_kind: "global", scope_id: "global", promotion_support_refs: globalRefs }).length, 3);
    assert.throws(() => ledger.validatePromotionSupport({ ...args, scope_kind: "global", scope_id: "global", promotion_support_refs: globalRefs.slice(0, 2) }), /threshold/u);
    const originalFind = store.find.bind(store);
    (store as unknown as { find: typeof store.find }).find = ((kind: string, id: string, version?: number, hydrateContent?: boolean) => {
      const found = originalFind(kind, id, version, hydrateContent);
      return kind === "memory_ledger" && id === projects[0]!.id && found ? { ...found, scope: { kind: "project" } } : found;
    }) as typeof store.find;
    try {
      assert.throws(() => ledger.validatePromotionSupport({ ...args, scope_kind: "global", scope_id: "global", promotion_support_refs: globalRefs }), /independent/u);
      assert.equal(ledger.promotionSupported({ scope: { kind: "global", id: "global" }, content_digest: contentDigest,
        kind: "preference", topic: "support-validation", promotion_support_refs: globalRefs }), false);
    } finally { store.find = originalFind; }
    const legacyProject = store.create("memory_ledger", "legacy-promoted-project", { scope: { kind: "project", id: "validation-0" },
      source_id: "builtin.evidence-wiki", content_digest: contentDigest, kind: "preference", topic: "support-validation", status: "active" });
    const legacyProjectCandidateId = `memory_candidate_project_${digestJson({ contentDigest, projectId: "validation-0", kind: "preference", topic: "support-validation" }).slice(-32)}`;
    store.create("memory_candidate", legacyProjectCandidateId, { scope: { kind: "project", id: "validation-0" },
      proposed_by: "automatic-memory-promotion", ledger_memory_id: legacyProject.id, status: "approved" });
    assert.equal(ledger.promotionSupported(legacyProject), true, "an unrelated malformed observation must not invalidate two legitimate legacy supporters");
    assert.equal(ledger.promotionSupported({ ...legacyProject, promotion_support_refs: [refs[0],
      { kind: "memory_observation", id: missingSession.id, version: missingSession.version }] }), false,
    "an explicitly referenced observation without session identity must fail closed");
    const { id: _missingId, version: _missingVersion, created_at: _missingCreated, updated_at: _missingUpdated, ...missingPayload } = missingSession;
    store.save("memory_observation", String(missingSession.id), { ...missingPayload, status: "revoked" });
    assert.equal(ledger.promotionSupported(legacyProject), true, "expired and malformed extra observations do not disqualify two current sessions");
    store.create("memory_observation", "other-kind-observation", { scope: { kind: "project", id: "validation-0" },
      project_id: "validation-0", session_digest: "other-kind-session", content_digest: contentDigest,
      kind: "working", topic: "support-validation", status: "active" });
    store.create("memory_observation", "other-topic-observation", { scope: { kind: "project", id: "validation-0" },
      project_id: "validation-0", session_digest: "other-topic-session", content_digest: contentDigest,
      kind: "preference", topic: "another-topic", status: "active" });
    assert.equal(ledger.promotionSupported(legacyProject), true);
    const wrongScopeObservation = store.create("memory_observation", "wrong-scope-observation", { scope: { kind: "project", id: "validation-1" },
      project_id: "validation-1", session_digest: "wrong-scope-session", content_digest: contentDigest,
      kind: "preference", topic: "support-validation", status: "active" });
    assert.equal(ledger.promotionSupported({ ...legacyProject, promotion_support_refs: [refs[0], { kind: "memory_observation", id: wrongScopeObservation.id, version: wrongScopeObservation.version }] }), false);
    const spoofedScopeObservation = store.create("memory_observation", "spoofed-scope-observation", { scope: { kind: "global", id: "global" },
      project_id: "validation-0", session_digest: "spoofed-scope-session", content_digest: contentDigest,
      kind: "preference", topic: "support-validation", status: "active" });
    const spoofedRef = { kind: "memory_observation", id: String(spoofedScopeObservation.id), version: Number(spoofedScopeObservation.version) };
    assert.throws(() => ledger.validatePromotionSupport({ ...args, promotion_support_refs: [refs[0], spoofedRef] }), /independent/u);
    assert.equal(ledger.promotionSupported({ ...legacyProject, promotion_support_refs: [refs[0], spoofedRef] }), false);
    const spoofedDigest = digestJson("Scoped observation fact");
    store.create("memory_observation", "spoofed-capture-observation", { scope: { kind: "global", id: "global" },
      project_id: "validation-0", session_digest: "spoofed-capture-session", content_digest: spoofedDigest,
      kind: "preference", topic: "scope-spoof", status: "active" });
    const scopedSessionId = `scoped-observation-${randomUUID()}`;
    const scopedCapture = service.memoryCaptureObservedFact({ session_id: scopedSessionId, project_scope_id: "validation-0",
      project_root: projectRoots[0], content: "Scoped observation fact", kind: "preference", topic: "scope-spoof" });
    assert.equal((scopedCapture.promotions as JsonObject[]).length, 0);
    service.memorySessionArchive({ session_id: scopedSessionId });
    const legacyGlobal = store.create("memory_ledger", "legacy-promoted-global", { scope: { kind: "global", id: "global" },
      source_id: "builtin.evidence-wiki", content_digest: contentDigest, kind: "preference", topic: "support-validation", status: "active" });
    const legacyGlobalCandidateId = `memory_candidate_global_${digestJson({ contentDigest, kind: "preference", topic: "support-validation" }).slice(-32)}`;
    store.create("memory_candidate", legacyGlobalCandidateId, { scope: { kind: "global", id: "global" },
      proposed_by: "automatic-memory-promotion", ledger_memory_id: legacyGlobal.id, status: "approved" });
    assert.equal(ledger.promotionSupported(legacyGlobal), true);
    const globalAsSupport = store.create("memory_ledger", "invalid-global-support", { scope: { kind: "global", id: "global" },
      content_digest: contentDigest, kind: "preference", topic: "support-validation", status: "active" });
    assert.equal(ledger.promotionSupported({ ...legacyGlobal, promotion_support_refs: [globalRefs[0], globalRefs[1],
      { kind: "memory_ledger", id: globalAsSupport.id, version: globalAsSupport.version }] }), false);
    for (const bad of [
      { ...legacyGlobal, promotion_support_refs: [null] },
      { ...legacyGlobal, promotion_support_refs: [{ ...globalRefs[0], version: 99 }] },
      { ...legacyGlobal, promotion_support_refs: [{ ...globalRefs[0], kind: "memory_observation" }] },
      { ...legacyGlobal, promotion_support_refs: [{ ...globalRefs[0], id: "absent" }] },
      { ...legacyGlobal, kind: "working", promotion_support_refs: globalRefs },
      { ...legacyGlobal, topic: "other", promotion_support_refs: globalRefs },
      { ...legacyGlobal, scope: { kind: "session", id: "invalid" }, promotion_support_refs: globalRefs },
    ]) assert.equal(ledger.promotionSupported(bad), false);
    const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...projectPayload } = projects[0]!;
    store.save("memory_ledger", String(projects[0]!.id), { ...projectPayload, status: "revoked" });
    const { id: _legacyId, version: _legacyVersion, created_at: _legacyCreated, updated_at: _legacyUpdated, ...legacyPayload } = legacyProject;
    store.save("memory_ledger", String(legacyProject.id), { ...legacyPayload, status: "revoked" });
    assert.equal(ledger.promotionSupported(legacyGlobal), false);
    assert.throws(() => ledger.get({ memory_id: legacyGlobal.id, scope_kind: "global", scope_id: "global" }), /promotion support/u);
    const noTopicContent = "Fact without a topic", noTopicDigest = digestJson(noTopicContent);
    for (const name of ["a", "b"]) store.create("memory_observation", `no-topic-${name}`, { scope: { kind: "project", id: "validation-0" },
      project_id: "validation-0", session_digest: `no-topic-session-${name}`, content_digest: noTopicDigest, kind: "preference", status: "active" });
    const noTopicProject = store.create("memory_ledger", "no-topic-project", { scope: { kind: "project", id: "validation-0" },
      source_id: "builtin.evidence-wiki", content_digest: noTopicDigest, kind: "preference", status: "active" });
    const noTopicCandidateId = `memory_candidate_project_${digestJson({ contentDigest: noTopicDigest, projectId: "validation-0", kind: "preference", topic: "" }).slice(-32)}`;
    store.create("memory_candidate", noTopicCandidateId, { scope: { kind: "project", id: "validation-0" },
      proposed_by: "automatic-memory-promotion", ledger_memory_id: noTopicProject.id, status: "approved" });
    assert.equal(ledger.promotionSupported(noTopicProject), true);
    service.memoryLedgerTransition({ memory_id: noTopicProject.id, status: "revoked", reason: "no-topic correction" });
    assert.equal(store.list("memory_observation", 100, item => item.content_digest === noTopicDigest && item.status === "active").length, 0);
    const nestedDigest = digestJson("Nested support fact");
    const nestedProjects = [0, 1, 2].map(index => {
      const supporters = [0, 1].map(session => store.create("memory_observation", `nested-observation-${index}-${session}`, {
        scope: { kind: "project", id: `validation-${index}` }, project_id: `validation-${index}`,
        session_digest: `nested-session-${index}-${session}`, content_digest: nestedDigest,
        kind: "preference", topic: "nested-support", status: "active",
      }));
      const project = store.create("memory_ledger", `nested-project-${index}`, {
        scope: { kind: "project", id: `validation-${index}` }, content_digest: nestedDigest,
        kind: "preference", topic: "nested-support", status: "active",
        promotion_support_refs: supporters.map(item => ({ kind: "memory_observation", id: item.id, version: item.version })),
      });
      return { project, supporters };
    });
    const nestedRefs = nestedProjects.map(({ project }) => ({ kind: "memory_ledger", id: String(project.id), version: Number(project.version) }));
    const nestedGlobal = { scope: { kind: "global", id: "global" }, content_digest: nestedDigest,
      kind: "preference", topic: "nested-support", status: "active", promotion_support_refs: nestedRefs };
    assert.equal(ledger.promotionSupported(nestedGlobal), true);
    const brokenObservation = nestedProjects[0]!.supporters[0]!;
    const { id: _nestedId, version: _nestedVersion, created_at: _nestedCreated, updated_at: _nestedUpdated, ...nestedPayload } = brokenObservation;
    store.save("memory_observation", String(brokenObservation.id), { ...nestedPayload, status: "revoked" });
    assert.equal(store.get("memory_ledger", String(nestedProjects[0]!.project.id)).status, "active");
    assert.equal(ledger.promotionSupported(nestedProjects[0]!.project), false);
    assert.equal(ledger.promotionSupported(nestedGlobal), false, "a global promotion cannot rely on an unsupported active project promotion");
    assert.throws(() => ledger.validatePromotionSupport({ ...args, scope_kind: "global", scope_id: "global", content: "Nested support fact",
      topic: "nested-support", promotion_support_refs: nestedRefs }), /no longer active/u);
  } finally {
    store.close();
    rmSync(dataRoot, { recursive: true, force: true });
    projectRoots.forEach(root => rmSync(root, { recursive: true, force: true }));
  }
});
