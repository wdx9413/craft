import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { CraftStore, type JsonObject } from "../common/craft-common-store-local/src/store.ts";
import { craftPaths } from "../common/craft-common-store-local/src/paths.ts";
import { MemoryLedgerKernel } from "../capability/craft-memory/memory-ledger.ts";
import { MemoryGovernanceKernel, latestMemoryConfirmation } from "../capability/craft-memory/memory-governance.ts";
import { MemoryMaintenanceKernel } from "../core/memory-maintenance.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "craft-memory-commit-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const projectRoot = join(root, "project"); mkdirSync(projectRoot);
  store.create("scope_alias", "project-p", { scope: { kind: "project", id: "p" }, alias_kind: "path", alias: projectRoot, status: "active" });
  const ledger = new MemoryLedgerKernel(store), governance = new MemoryGovernanceKernel(store, ledger);
  store.create("knowledge_source", "s", { scope: { kind: "project", id: "p" }, status: "active", trust: "verified" });
  store.create("evidence", "e", { source_type: "human", confidence: "confirmed" });
  function candidate(id = "c", extra: JsonObject = {}) { return store.create("memory_candidate", id, { status: "approved", source_id: "s", kind: "preference", scope: { kind: "project", id: "p" }, content: "Use Python", sensitivity: "internal", confidence: "confirmed", evidence_ids: ["e"], observed_at: "2020-01-01T00:00:00.000Z", effective_from: "2020-01-01T00:00:00.000Z", ...extra }); }
  return { root, projectRoot, store, ledger, governance, candidate, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("approved candidate commits once; replay does not resurrect revoked memory", async () => {
  const f = await fixture(); try {
    f.candidate(); const first = f.governance.remember({ candidate_id: "c" });
    const memory = first.memory as JsonObject;
    assert.equal(first.idempotent, false);
    assert.equal((f.governance.remember({ candidate_id: "c" }).memory as JsonObject).id, memory.id);
    assert.equal(f.store.count("memory_ledger"), 1);
    assert.throws(() => f.governance.remember({ candidate_id: "c", memory_id: "another" }), /identity conflict/);
    f.ledger.transition({ memory_id: memory.id, status: "revoked", reason: "user forgot" });
    assert.equal((f.governance.remember({ candidate_id: "c", memory_id: memory.id }).memory as JsonObject).status, "revoked");
    f.candidate("denied", { status: "candidate" });
    assert.throws(() => f.governance.remember({ candidate_id: "denied" }), /Only approved/);
    f.candidate("explicit"); assert.equal((f.governance.remember({ candidate_id: "explicit", memory_id: "named" }).memory as JsonObject).id, "named");
    f.store.save("knowledge_source", "s", { scope: { kind: "project", id: "p" }, status: "revoked", trust: "verified" });
    assert.throws(() => f.governance.remember({ candidate_id: "c" }), /not active/);
  } finally { f.close(); }
});

test("supersession and candidate association roll back together; orphan content is reused", async () => {
  const f = await fixture(); try {
    for (const id of ["old1", "old2"]) f.ledger.remember({ memory_id: id, source_id: "s", kind: "preference", scope_kind: "project", scope_id: "p", content: id });
    f.candidate("c", { supersedes_memory_ids: ["old1", "old2"] });
    const transition = f.ledger.transition.bind(f.ledger); let calls = 0;
    f.ledger.transition = args => { if (++calls === 2) throw new Error("injected replacement failure"); return transition(args); };
    let file = ""; const write = f.store.contentStore.writeSync.bind(f.store.contentStore);
    f.store.contentStore.writeSync = args => { const ref = write(args); file = ref.path; return ref; };
    assert.throws(() => f.governance.remember({ candidate_id: "c" }), /injected/);
    assert(existsSync(file)); assert.equal(f.store.count("memory_ledger"), 2);
    assert.equal(f.store.get("memory_ledger", "old1").status, "active");
    assert.equal(f.store.get("memory_candidate", "c").ledger_memory_id, undefined);
    f.ledger.transition = transition;
    const result = f.governance.remember({ candidate_id: "c" });
    assert.equal(((result.memory as JsonObject).content_ref as JsonObject).path, file);
    assert.equal((result.superseded as JsonObject[]).length, 2);
    assert.equal(f.store.get("memory_ledger", "old1").status, "superseded");
    f.candidate("retired", { supersedes_memory_ids: ["old1"] });
    assert.equal((f.governance.remember({ candidate_id: "retired" }).superseded as JsonObject[])[0]!.status, "superseded");
    f.candidate("publication"); const save = f.store.save.bind(f.store);
    f.store.save = (kind, id, value, version) => { if (kind === "memory_candidate") throw new Error("publication failure"); return save(kind, id, value, version); };
    assert.throws(() => f.governance.remember({ candidate_id: "publication" }), /publication failure/);
    assert.equal(f.store.count("memory_ledger"), 4);
    f.store.save = save; assert(f.governance.remember({ candidate_id: "publication" }).memory);
    f.candidate("file-failure");
    f.store.contentStore.writeSync = () => { throw new Error("content unavailable"); };
    assert.throws(() => f.governance.remember({ candidate_id: "file-failure" }), /content unavailable/);
    assert.equal(f.store.get("memory_candidate", "file-failure").ledger_memory_id, undefined);
    f.store.contentStore.writeSync = write; assert(f.governance.remember({ candidate_id: "file-failure" }).memory);
  } finally { f.close(); }
});

test("two processes share one candidate commit identity", async () => {
  const f = await fixture(); try {
    f.candidate();
    const script = `import { CraftStore } from './common/craft-common-store-local/src/store.ts'; import { craftPaths } from './common/craft-common-store-local/src/paths.ts'; import { MemoryLedgerKernel } from './capability/craft-memory/memory-ledger.ts'; import { MemoryGovernanceKernel } from './capability/craft-memory/memory-governance.ts'; const s=await new CraftStore(craftPaths(process.argv[1])).open(); const g=new MemoryGovernanceKernel(s,new MemoryLedgerKernel(s)); process.stdout.write(JSON.stringify(g.remember({candidate_id:'c'}).memory.id));s.close();`;
    const run = () => new Promise<string>((resolve, reject) => { const child = spawn(process.execPath, ["--input-type=module", "-e", script, f.root]); let out = "", err = ""; child.stdout.on("data", data => out += data); child.stderr.on("data", data => err += data); child.on("error", reject); child.on("exit", code => code === 0 ? resolve(out) : reject(new Error(err))); });
    const [a, b] = await Promise.all([run(), run()]); assert.equal(a, b); assert.equal(f.store.count("memory_ledger"), 1);
  } finally { f.close(); }
});

test("confirmations affect exact revision only, are time bounded, and never extend expiry", async () => {
  const f = await fixture(); try {
    f.candidate("c", { valid_until: "2021-01-01T00:00:00.000Z" });
    const memory = f.governance.remember({ candidate_id: "c" }).memory as JsonObject;
    assert.equal(latestMemoryConfirmation(f.store, memory, "2099-01-01T00:00:00.000Z"), null);
    const args = { memory_id: memory.id, scope_kind: "project", scope_id: "p", expected_version: memory.version, explicit_consent: true, evidence_ids: ["e"] };
    const confirmation = f.governance.confirm(args).confirmation as JsonObject;
    assert.equal(latestMemoryConfirmation(f.store, memory, "2099-01-01T00:00:00.000Z"), confirmation.created_at);
    assert.equal(latestMemoryConfirmation(f.store, memory, "2020-01-01T00:00:00.000Z"), null);
    assert.equal(latestMemoryConfirmation(f.store, { ...memory, version: 2 }, "2099-01-01T00:00:00.000Z"), null);
    assert.equal(latestMemoryConfirmation(f.store, { ...memory, content_digest: "wrong" }, "2099-01-01T00:00:00.000Z"), null);
    const maintenance = new MemoryMaintenanceKernel(f.store);
    const run = maintenance.run({ maintenance_id: "run", scope_kind: "project", scope_id: "p", now: "2099-01-01T00:00:00.000Z" });
    assert.equal((run.confirmations as JsonObject[]).length, 1);
    assert((run.findings as JsonObject[]).some(item => item.kind === "expired_active"));
    assert.equal(maintenance.run({ maintenance_id: "run", scope_kind: "project", scope_id: "p", now: "2099-01-01T00:00:00.000Z" }).idempotent, true);
    assert.equal(f.store.get("memory_ledger", String(memory.id)).valid_until, "2021-01-01T00:00:00.000Z");
  } finally { f.close(); }
});

test("session finalization archives using either the bound session identity or the explicit Host", async () => {
  const f = await fixture(); try {
    const local = f.governance.sessionFinalize({ session_id: "finalize-local", summary: "Session finished", candidate_ids: [] });
    assert.equal(local.content_free, true);
    assert.equal((local.archive as JsonObject).status, "archived");
    const hosted = f.governance.sessionFinalize({ session_id: "finalize-hosted", session_host: "codex", summary: "Session finished", candidate_ids: [] });
    assert.equal(hosted.content_free, true);
    assert.equal((hosted.archive as JsonObject).status, "archived");
  } finally { f.close(); }
});

test("Memory content writes preserve the verified project root supplied by the Host", async () => {
  const f = await fixture(); try {
    const memory = f.ledger.remember({ memory_id: "root-pinned", source_id: "s", kind: "preference", scope_kind: "project", scope_id: "p",
      content: "Use the registered project root", project_root: f.projectRoot }).memory as JsonObject;
    assert.deepEqual(memory.scope, { kind: "project", id: "p" });
    assert.match(String((memory.content_ref as JsonObject).path), /projects/u);
  } finally { f.close(); }
});

test("Memory maintenance excludes private entries outside the requesting audience", async () => {
  const f = await fixture(); try {
    f.store.create("memory_ledger", "private-maintenance", { scope: { kind: "project", id: "p" },
      scope_envelope: { applicability: { kind: "project", id: "p" }, custody: { kind: "project", id: "p" },
        audience: { mode: "private", principal_ids: ["owner"] }, purpose: "preference", retention: "long_term", tenant_id: null },
      status: "active", source_id: "s", kind: "preference", content_digest: "private-digest" });
    f.store.create("memory_ledger", "shared-maintenance", { scope: { kind: "project", id: "p" },
      scope_envelope: { applicability: { kind: "project", id: "p" }, custody: { kind: "project", id: "p" },
        audience: { mode: "scoped", principal_ids: [] }, purpose: "preference", retention: "long_term", tenant_id: null },
      status: "active", source_id: "s", kind: "preference", content_digest: "shared-digest" });
    f.store.create("memory_ledger", "other-scope-maintenance", { scope: { kind: "global", id: "global" },
      status: "active", source_id: "s", kind: "preference", content_digest: "other-scope-digest" });
    const result = new MemoryMaintenanceKernel(f.store).run({ maintenance_id: "private-maintenance-run", scope_kind: "project", scope_id: "p", principal_id: "other" });
    assert.equal((result.run as JsonObject).finding_count, 1);
    assert.equal((result.findings as JsonObject[]).some(item => item.memory_id === "private-maintenance"), false);
    assert.equal((result.findings as JsonObject[]).some(item => item.memory_id === "shared-maintenance"), true,
      "a matching scoped Audience remains visible while a private Audience is excluded");
    assert.equal((result.findings as JsonObject[]).some(item => item.memory_id === "other-scope-maintenance"), false,
      "maintenance does not inspect a Memory from another project scope");
  } finally { f.close(); }
});

test("maintenance retains legacy fallback and proposes duplicate review with confirmation metadata", async () => {
  const f = await fixture(); try {
    const maintenance = new MemoryMaintenanceKernel(f.store);
    f.store.create("episodic_memory", "legacy", { content_digest: "legacy" });
    assert.equal((maintenance.run({ maintenance_id: "legacy-run" }).confirmations as JsonObject[]).length, 0);
    for (const id of ["a", "b"]) f.store.create("memory_ledger", id, { status: "active", source_id: "s", scope: { kind: "project", id: "p" }, content_digest: "same", content_ref: {}, valid_until: "2021-01-01T00:00:00.000Z" });
    f.store.create("memory_ledger", "restricted", { status: "active", source_id: "s", scope: { kind: "project", id: "p" }, content_digest: "private", sensitivity: "restricted", content_ref: {} });
    const hidden = maintenance.run({ maintenance_id: "restricted-hidden", stage: "deep", scope_kind: "project", scope_id: "p" });
    assert.equal((hidden.findings as JsonObject[]).some(item => item.memory_id === "restricted"), false);
    maintenance.run({ maintenance_id: "restricted-visible", scope_kind: "project", scope_id: "p", allow_restricted: true });
    const run = maintenance.run({ maintenance_id: "duplicate-run", stage: "deep", scope_kind: "project", scope_id: "p" });
    assert((run.findings as JsonObject[]).some(item => item.kind === "duplicate"), "duplicate detection must be visible in the maintenance report");
    const actions = (run.candidate as JsonObject).actions as JsonObject[];
    assert(actions.some(item => item.action === "review_duplicate" && item.requires_review === true));
  } finally { f.close(); }
});

test("Memory maintenance handles unscoped legacy ledger identities without merging scopes", async () => {
  const f = await fixture(); try {
    const now = new Date().toISOString();
    f.store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("memory_ledger", "legacy-unscoped", 1, JSON.stringify({ id: "legacy-unscoped", version: 1, status: "active", content_digest: "shared-content" }), now, now);
    f.store.create("memory_ledger", "global-scoped", { status: "active", scope: { kind: "global", id: "global" }, content_digest: "shared-content" });
    const result = new MemoryMaintenanceKernel(f.store).run({ maintenance_id: "unscoped-legacy", stage: "deep" });
    assert.equal((result.findings as JsonObject[]).some(item => item.kind === "duplicate"), false,
      "identical content in distinct legacy/global storage scopes is not a duplicate");
    assert.equal((result.findings as JsonObject[]).some(item => item.kind === "missing_content_ref" && item.memory_id === "legacy-unscoped"), true);
  } finally { f.close(); }
});

test("two independent processes confirm one exact Memory revision in a single publication transaction", { timeout: 10000 }, async () => {
  const f = await fixture();
  const children: ReturnType<typeof spawn>[] = [];
  try {
    f.candidate(); const memory = f.governance.remember({ candidate_id: "c" }).memory as JsonObject;
    const args = { memory_id: memory.id, expected_version: memory.version, explicit_consent: true, evidence_ids: ["e"], scope_kind: "project", scope_id: "p" };
    const script = `
      import assert from 'node:assert/strict';
      import {CraftStore} from './common/craft-common-store-local/src/store.ts';
      import {craftPaths} from './common/craft-common-store-local/src/paths.ts';
      import {MemoryGovernanceKernel} from './capability/craft-memory/memory-governance.ts';
      import {MemoryLedgerKernel} from './capability/craft-memory/memory-ledger.ts';
      import {DatabaseSync} from 'node:sqlite';
      const store=await new CraftStore(craftPaths(process.argv[1])).open();
      const ledger=new MemoryLedgerKernel(store), governance=new MemoryGovernanceKernel(store,ledger);
      const probe=new DatabaseSync(store.paths.databaseFile);probe.exec('PRAGMA busy_timeout=0');
      let depth=0, serial=0, confirmationTransaction=0;
      const transaction=store.transaction.bind(store);
      store.transaction=operation=>transaction(database=>{if(depth===0)serial++;depth++;try{return operation(database);}finally{depth--;}});
      function inPublication(){
        assert(depth>0,'Memory read and confirmation publication share a transaction');
        if(confirmationTransaction===0)confirmationTransaction=serial;
        assert.equal(serial,confirmationTransaction,'one transaction covers every confirmation phase');
        let blocked=false;
        try{probe.exec('BEGIN IMMEDIATE');probe.exec('ROLLBACK');}catch(error){if(error.errcode===5)blocked=true;else throw error;}
        assert(blocked,'another database connection cannot acquire the writer lock');
      }
      const get=ledger.get.bind(ledger);ledger.get=args=>{inPublication();return get(args);};
      const find=store.find.bind(store);store.find=(...args)=>{if(args[0]==='memory_confirmation')inPublication();return find(...args);};
      const create=store.create.bind(store);store.create=(...args)=>{if(args[0]==='memory_confirmation')inPublication();return create(...args);};
      process.stdout.write('READY\\n');
      process.stdin.once('data',()=>{
        try{const result=governance.confirm(JSON.parse(process.argv[2]));process.stdout.write(JSON.stringify({id:result.confirmation.id,version:result.confirmation.memory_version})+'\\n');probe.close();store.close();process.exit(0);}
        catch(error){process.stderr.write(String(error.stack));probe.close();store.close();process.exit(1);}
      });process.stdin.resume();
    `;
    function worker() {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, f.root, JSON.stringify(args)], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
      children.push(child);
      let output = "", errors = "";
      let readyResolve!: () => void, readyReject!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      child.stdout.on("data", value => { output += String(value); if (output.includes("READY\n")) readyResolve(); });
      child.stderr.on("data", value => { errors += String(value); });
      const result = new Promise<JsonObject>((resolve, reject) => {
        child.on("error", error => { readyReject(error); reject(error); });
        child.on("exit", code => {
          if (code !== 0) { const error = new Error(errors || `confirmation child exit ${code}`); readyReject(error); reject(error); return; }
          resolve(JSON.parse(output.trim().split("\n").at(-1)!));
        });
      });
      void result.catch(() => {});
      return { child, ready, result };
    }
    const first = worker(), second = worker();
    await Promise.all([first.ready, second.ready]);
    first.child.stdin.write("go"); second.child.stdin.write("go");
    const [a, b] = await Promise.all([first.result, second.result]);
    assert.equal(a.id, b.id); assert.equal(a.version, memory.version); assert.equal(b.version, memory.version);
    assert.equal(f.store.count("memory_confirmation"), 1);
  } finally { for (const child of children) child.kill(); f.close(); }
});
