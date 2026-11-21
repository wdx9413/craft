import { stableDigest } from "../core/digest.ts";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { hasSharedWriterFence } from "../core/infrastructure/owned-catalog.ts";
import { archiveOwnerHistory, historyArchiveEntries } from "../core/owner-history-archive.ts";
import { importOwnerHistory } from "../core/owner-history-import.ts";
import { switchOwnerStorage, rollbackOwnerStorage, recoverOwnerStorage } from "../core/owner-storage-cutover.ts";
import { defaultSettings } from "../core/settings.ts";
import { openCapabilityService } from "../core/interfaces/mcp/runtime.ts";

async function fixture(options: { identity?: boolean; staged?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "craft-cutover-"));
  const active = join(directory, "active"), staged = join(directory, "staged"), previous = join(directory, "previous");
  const paths = craftPaths(active); mkdirSync(dirname(paths.databaseFile), { recursive: true });
  const db = new DatabaseSync(paths.databaseFile);
  db.exec("CREATE TABLE records(kind TEXT,id TEXT,version INTEGER,payload_json TEXT,created_at TEXT,updated_at TEXT)");
  db.prepare("INSERT INTO records VALUES(?,?,?,?,?,?)").run("knowledge_source", "source", 1,
    JSON.stringify({ scope: "global", status: "active", label: "Original" }), "created", "updated");
  if (options.identity) db.prepare("INSERT INTO records VALUES(?,?,?,?,?,?)").run("project_identity", "identity-fixture", 1, JSON.stringify({ canonical_root: directory }), "created", "updated");
  if (options.staged) db.prepare("INSERT INTO records VALUES(?,?,?,?,?,?)").run("experience_procedure", "staged-fixture", 1, JSON.stringify({ scope: "global", status: "candidate", lifecycle: "candidate" }), "created", "updated");
  const settings = defaultSettings(paths); settings.capabilities.autoInstall = false;
  writeFileSync(join(active, "settings.json"), JSON.stringify(settings));
  const archive = join(directory, "archive"), manifest = await archiveOwnerHistory(paths, archive);
  db.close(); await importOwnerHistory(archive, manifest, staged);
  const verify = async (root: string) => {
    const runtime = await openCapabilityService("knowledge", { CRAFT_DATA_DIR: root });
    try { assert.equal(runtime.store.get("knowledge_source", "source", 1).label, "Original"); }
    finally { runtime.close(); }
  };
  return { directory, active, staged, previous, paths, manifest, verify, close() { rmSync(directory, { recursive: true, force: true }); } };
}

test("cutover fences legacy writers and rollback preserves all post-switch versions", async () => {
  const f = await fixture();
  try {
    const result = await switchOwnerStorage(f.active, f.staged, f.previous, f.manifest, f.verify);
    assert.equal(result.active_root, f.active);
    assert(hasSharedWriterFence(f.active));
    assert.throws(() => new DatabaseSync(f.paths.databaseFile), /unable to open database/u);
    assert(existsSync(join(f.previous, "db", "craft.db")));
    assert.deepEqual(readFileSync(join(f.active, "settings.json")), readFileSync(join(f.previous, "settings.json")));
    const runtime = await openCapabilityService("knowledge", { CRAFT_DATA_DIR: f.active });
    runtime.store.save("knowledge_source", "source", { scope: "global", status: "active", label: "New revision" }); runtime.close();
    const preserved = join(f.directory, "preserved-new");
    await rollbackOwnerStorage(f.active, preserved, async root => {
      const db = new DatabaseSync(craftPaths(root).databaseFile, { readOnly: true });
      try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM records").get()!.n, 1); } finally { db.close(); }
    });
    const recovered = await openCapabilityService("knowledge", { CRAFT_DATA_DIR: preserved });
    try { assert.equal(recovered.store.get("knowledge_source", "source").label, "New revision"); }
    finally { recovered.close(); }
    assert(!hasSharedWriterFence(f.active));
  } finally { f.close(); }
});

test("cutover refuses open old databases and restores the old tree after failed acceptance", async () => {
  const f = await fixture();
  try {
    const db = new DatabaseSync(f.paths.databaseFile);
    try { await assert.rejects(switchOwnerStorage(f.active, f.staged, f.previous, f.manifest, f.verify), /database users to stop/u); }
    finally { db.close(); }
    await assert.rejects(switchOwnerStorage(f.active, f.staged, f.previous, f.manifest, async root => {
      if (root === f.active) throw new Error("acceptance failed");
      await f.verify(root);
    }), /acceptance failed/u);
    assert(existsSync(f.paths.databaseFile)); assert(!existsSync(f.previous));
    assert(!hasSharedWriterFence(f.active));
    await f.verify(f.staged);
    await switchOwnerStorage(f.active, f.staged, f.previous, f.manifest, f.verify);
    assert(hasSharedWriterFence(f.active));
    await assert.rejects(rollbackOwnerStorage(f.active, join(f.directory, "failed-new"), async () => { throw new Error("old acceptance failed"); }), /old acceptance failed/u);
    assert(hasSharedWriterFence(f.active));
  } finally { f.close(); }
});

test("cutover rejects overlapping trees, mismatched imports and conflicting configuration", async () => {
  const f = await fixture();
  try {
    await assert.rejects(switchOwnerStorage(f.active, join(f.active, "staged"), f.previous, f.manifest, f.verify), /separate/u);
    await assert.rejects(switchOwnerStorage(f.active, f.staged, f.previous, { ...f.manifest, source_root: "foreign" }, f.verify), /inputs/u);
    mkdirSync(f.previous);
    await assert.rejects(switchOwnerStorage(f.active, f.staged, f.previous, f.manifest, f.verify), /inputs/u);
    rmSync(f.previous, { recursive: true });
    writeFileSync(join(f.staged, "settings.json"), "different");
    await assert.rejects(switchOwnerStorage(f.active, f.staged, f.previous, f.manifest, f.verify), /configuration conflicts/u);
    rmSync(join(f.staged, "settings.json"));
    mkdirSync(join(f.active, "config")); writeFileSync(join(f.active, "config", "preserved.txt"), "unchanged");
    const priorPath = process.env.PATH; process.env.PATH = "/not-installed-cutover-tools";
    try { await assert.rejects(switchOwnerStorage(f.active, f.staged, f.previous, f.manifest, f.verify), /ENOENT/u); }
    finally { process.env.PATH = priorPath; }
    await switchOwnerStorage(f.active, f.staged, f.previous, f.manifest, f.verify);
    assert.equal(readFileSync(join(f.active, "config", "preserved.txt"), "utf8"), "unchanged");
    const bad = join(f.directory, "invalid"); mkdirSync(bad);
    assert.equal(hasSharedWriterFence(bad), false);
    await assert.rejects(rollbackOwnerStorage(bad, join(f.directory, "preserved"), f.verify), /Invalid/u);
    await assert.rejects(rollbackOwnerStorage(f.active, f.previous, f.verify), /Invalid/u);
    await assert.rejects(rollbackOwnerStorage(f.active, join(f.active, "preserved"), f.verify), /Invalid/u);
    await assert.rejects(rollbackOwnerStorage(f.active, f.directory, f.verify), /Invalid/u);
  } finally { f.close(); }
});


for (const crashPhase of ["prepared", "old_moved", "new_moved"]) test(`restart recovers a process death after cutover ${crashPhase}`, async () => {
  const f = await fixture();
  try {
    const module = new URL("../core/owner-storage-cutover.ts", import.meta.url).href;
    const script = `const {switchOwnerStorage}=await import(${JSON.stringify(module)}); await switchOwnerStorage(${JSON.stringify(f.active)},${JSON.stringify(f.staged)},${JSON.stringify(f.previous)},${JSON.stringify(f.manifest)},async()=>{},async phase=>{if(phase===${JSON.stringify(crashPhase)})process.exit(77)});`;
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], { encoding: "utf8", timeout: 30_000 });
    assert.equal(child.status, 77, child.stderr);
    const verifyOld = async (root: string) => {
      const database = new DatabaseSync(craftPaths(root).databaseFile, { readOnly: true });
      try { assert.equal(database.prepare("SELECT COUNT(*) AS n FROM records").get()!.n, 1); } finally { database.close(); }
    };
    if (crashPhase === "prepared") {
      const cli = fileURLToPath(new URL("../scripts/owner-storage-cutover.ts", import.meta.url));
      const repaired = spawnSync(process.execPath, ["--experimental-strip-types", cli, `--active=${f.active}`, "--recover", "--apply"], { encoding: "utf8", timeout: 30_000 });
      assert.equal(repaired.status, 0, repaired.stderr); assert.equal(JSON.parse(repaired.stdout).mode, "recovered");
    }
    assert.equal((await recoverOwnerStorage(f.active, verifyOld)).status, "aborted");
    assert.equal((await recoverOwnerStorage(f.active, verifyOld)).status, "aborted");
    assert(!hasSharedWriterFence(f.active)); assert(!existsSync(f.previous));
    if (crashPhase !== "prepared") await f.verify(f.staged);
    // An interrupted operation is retryable only after restoring the original authority.
    await switchOwnerStorage(f.active, f.staged, f.previous, f.manifest, f.verify);
    assert.equal((await recoverOwnerStorage(f.active, f.verify)).status, "complete");
  } finally { f.close(); }
});

test("cutover recovery CLI verifies an owner when a completed journal is reopened", async () => {
  const f=await fixture();
  try {
    await switchOwnerStorage(f.active,f.staged,f.previous,f.manifest,f.verify);
    const cli=fileURLToPath(new URL("../scripts/owner-storage-cutover.ts",import.meta.url));
    const recovered=spawnSync(process.execPath,["--experimental-strip-types",cli,`--active=${f.active}`,"--recover","--apply"],{encoding:"utf8",timeout:30_000});
    assert.equal(recovered.status,0,recovered.stderr);assert.equal(JSON.parse(recovered.stdout).mode,"recovered");
  } finally {f.close();}
});

for (const crashPhase of ["prepared", "new_preserved", "old_restored"]) test(`restart cancels interrupted rollback at ${crashPhase} without losing new versions`, async () => {
  const f = await fixture();
  try {
    await switchOwnerStorage(f.active, f.staged, f.previous, f.manifest, f.verify);
    const owner = await openCapabilityService("knowledge", { CRAFT_DATA_DIR: f.active });
    owner.store.save("knowledge_source", "source", { scope: "global", status: "active", label: "After cutover" }); owner.close();
    const preserved = join(f.directory, "interrupted-new");
    const module = new URL("../core/owner-storage-cutover.ts", import.meta.url).href;
    const script = `const {rollbackOwnerStorage}=await import(${JSON.stringify(module)}); await rollbackOwnerStorage(${JSON.stringify(f.active)},${JSON.stringify(preserved)},async()=>{},async phase=>{if(phase===${JSON.stringify(crashPhase)})process.exit(77)});`;
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], { encoding: "utf8", timeout: 30_000 });
    assert.equal(child.status, 77, child.stderr);
    await recoverOwnerStorage(f.active, async root => {
      const restored = await openCapabilityService("knowledge", { CRAFT_DATA_DIR: root });
      try { assert.equal(restored.store.get("knowledge_source", "source").label, "After cutover"); } finally { restored.close(); }
    });
    assert(hasSharedWriterFence(f.active)); assert(existsSync(f.previous)); assert(!existsSync(preserved));
  } finally { f.close(); }
});

test("rollback detects an open project shard and never renames an active owner", async () => {
  const f = await fixture();
  try {
    await switchOwnerStorage(f.active, f.staged, f.previous, f.manifest, f.verify);
    const directory = join(f.active, "projects", "project-one", "knowledge"); mkdirSync(directory, { recursive: true });
    const shard = new DatabaseSync(join(directory, "records.sqlite")); shard.exec("CREATE TABLE state(id TEXT)");
    try { await assert.rejects(rollbackOwnerStorage(f.active, join(f.directory, "preserved-shard"), async()=>{}), /database users to stop/); }
    finally { shard.close(); }
    assert(hasSharedWriterFence(f.active)); assert(existsSync(f.previous));
  } finally { f.close(); }
});

test("cutover recovery CLI handles a missing journal without creating a data space", async () => {
  const directory = mkdtempSync(join(tmpdir(), "craft-no-journal-"));
  try {
    const active = join(directory, "absent");
    await assert.rejects(recoverOwnerStorage(active, async()=>{}), /No cutover recovery journal/);
    const cli = fileURLToPath(new URL("../scripts/owner-storage-cutover.ts", import.meta.url));
    const result = spawnSync(process.execPath, ["--experimental-strip-types", cli, `--active=${active}`, "--recover", "--apply"], { encoding: "utf8", timeout: 30_000 });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /No cutover recovery journal/); assert(!existsSync(active));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("cutover CLI verifies, applies and rolls back an isolated archive fixture", async () => {
  const f = await fixture();
  const cli = fileURLToPath(new URL("../scripts/owner-storage-cutover.ts", import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", cli, ...args], { encoding: "utf8", timeout: 30_000 });
  try {
    const required = [`--active=${f.active}`, `--staged=${f.staged}`, `--previous=${f.previous}`, `--archive=${join(f.directory, "archive")}`, `--manifest=manifest-${f.manifest.digest}.json`];
    const applied = run(...required, "--apply");
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).mode, "switched");
    const preserved = join(f.directory, "preserved-cli-new");
    const rolledBack = run(`--active=${f.active}`, `--preserve-new=${preserved}`, "--rollback", "--apply");
    assert.equal(rolledBack.status, 0, rolledBack.stderr);
    assert.equal(JSON.parse(rolledBack.stdout).mode, "rolled-back");
    for (const args of [
      [`--active=${f.active}`, `--active=${f.active}`],
      [`--active=${f.active}`, "--unknown"],
      ["--recover", `--active=${f.active}`],
      [`--active=${f.active}`, "--rollback", "--apply"],
      ...required.slice(0, 4).map((_, index) => required.filter((__, i) => i !== index)),
    ]) {
      const invalid = run(...args);
      assert.notEqual(invalid.status, 0, `unexpected CLI success for ${args.join(" ")}`);
    }
  } finally { f.close(); }
  const dry = await fixture();
  try {
    const required = [`--active=${dry.active}`, `--staged=${dry.staged}`, `--previous=${dry.previous}`, `--archive=${join(dry.directory, "archive")}`, `--manifest=manifest-${dry.manifest.digest}.json`];
    const dryRun = run(...required);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.equal(JSON.parse(dryRun.stdout).mode, "verified-dry-run");
  } finally { dry.close(); }
});

test("cutover CLI skips identity, staged and unavailable owner history", async () => {
  const cli=fileURLToPath(new URL("../scripts/owner-storage-cutover.ts",import.meta.url));
  const f=await fixture({identity:true,staged:true});
  try {
    const required=[`--active=${f.active}`,`--staged=${f.staged}`,`--previous=${f.previous}`,`--archive=${join(f.directory,"archive")}`,`--manifest=manifest-${f.manifest.digest}.json`];
    const result=spawnSync(process.execPath,["--experimental-strip-types",cli,...required],{encoding:"utf8",timeout:30_000});assert.equal(result.status,0,result.stderr);
  } finally {f.close();}
  const noOwner=await fixture();
  try {
    rmSync(join(noOwner.staged,"knowledge","publication.db"));
    const required=[`--active=${noOwner.active}`,`--staged=${noOwner.staged}`,`--previous=${noOwner.previous}`,`--archive=${join(noOwner.directory,"archive")}`,`--manifest=manifest-${noOwner.manifest.digest}.json`];
    const result=spawnSync(process.execPath,["--experimental-strip-types",cli,...required],{encoding:"utf8",timeout:30_000});assert.equal(result.status,0,result.stderr);
  } finally {noOwner.close();}
});

test("cutover CLI detects imported metadata drift", async () => {
  const cli=fileURLToPath(new URL("../scripts/owner-storage-cutover.ts",import.meta.url));
  const f=await fixture();
  try {
    const archived=[...historyArchiveEntries(join(f.directory,"archive"),f.manifest)].find(entry=>entry.kind==="knowledge_source")!;
    assert.equal(archived.state,"published");assert.equal(archived.unresolved,false);assert.equal(archived.owner,"knowledge");
    const database=new DatabaseSync(join(f.staged,"knowledge","publication.db"));
    assert.equal(database.prepare("UPDATE records SET created_at='changed' WHERE kind='knowledge_source' AND id='source'").run().changes,1);database.close();
    const args=[`--active=${f.active}`,`--staged=${f.staged}`,`--previous=${f.previous}`,`--archive=${join(f.directory,"archive")}`,`--manifest=manifest-${f.manifest.digest}.json`];
    const result=spawnSync(process.execPath,["--experimental-strip-types",cli,...args],{encoding:"utf8",timeout:30_000});assert.notEqual(result.status,0,`${result.stdout}`);assert.match(result.stderr,/metadata mismatch/u);
  } finally {f.close();}
});


test("recovery validates the persisted intent and refuses conflicting authorities", async () => {
  const f = await fixture();
  const write = (value: Record<string, unknown>, digest = true) => {
    const { digest: _, ...identity } = value;
    writeFileSync(`${f.active}.craft-cutover.json`, JSON.stringify(digest ? { ...identity, digest: stableDigest(identity) } : value));
  };
  try {
    await switchOwnerStorage(f.active, f.staged, f.previous, f.manifest, f.verify);
    const original = JSON.parse(readFileSync(`${f.active}.craft-cutover.json`, "utf8"));
    const layout = original.layout;
    for (const invalid of [null, { ...layout, schema: "other" }, { ...layout, active_root: "other" }, { ...layout, archive_digest: 17 }, { ...layout, database_modes: null },
      { ...layout, previous_root: f.active }, { ...layout, previous_root: "relative" }, { ...layout, staged_root: f.previous },
      { ...layout, database_modes: [{ path: join(f.directory, "outside.db"), mode: 0o600 }] },
      { ...layout, database_modes: [{ path: f.paths.databaseFile, mode: -1 }] }, { ...layout, database_modes: [{ path: f.paths.databaseFile, mode: 1.5 }] }]) {
      write({ ...original, layout: invalid }); await assert.rejects(recoverOwnerStorage(f.active, f.verify), /Invalid cutover layout/);
    }
    for (const invalid of [{ ...original, schema: "other" }, { ...original, operation: "other" }, { ...original, preserved_root: f.active }]) {
      write(invalid); await assert.rejects(recoverOwnerStorage(f.active, f.verify), /Invalid cutover journal/);
    }
    write({ ...original, digest: "wrong" }, false); await assert.rejects(recoverOwnerStorage(f.active, f.verify), /Invalid cutover journal/);
    write({ ...original, phase: "new_moved" }); mkdirSync(f.staged);
    await assert.rejects(recoverOwnerStorage(f.active, f.verify), /Ambiguous cutover recovery trees/); rmSync(f.staged, { recursive: true });
    renameSync(f.previous, join(f.directory, "hidden-old"));
    await assert.rejects(recoverOwnerStorage(f.active, f.verify), /missing its original authority/);
    renameSync(join(f.directory, "hidden-old"), f.previous);
    write({ ...original, operation: "rollback", phase: "prepared" });
    await assert.rejects(recoverOwnerStorage(f.active, f.verify), /preservation root is missing/);
    write({ ...original, operation: "rollback", phase: "prepared", preserved_root: join(f.directory, "preserved-test") });
    const preservedTest = join(f.directory, "preserved-test");
    mkdirSync(preservedTest);
    await assert.rejects(recoverOwnerStorage(f.active, f.verify), /Ambiguous rollback recovery trees/);
    rmSync(preservedTest, { recursive: true });
    renameSync(f.previous, join(f.directory, "hidden-old"));
    await assert.rejects(recoverOwnerStorage(f.active, f.verify), /missing its original authority/);
    renameSync(join(f.directory, "hidden-old"), f.previous);
    assert.equal((await recoverOwnerStorage(f.active, f.verify)).status, "aborted");
    write(original);
    const lock = `${f.active}.craft-cutover.lock`;
    writeFileSync(lock, JSON.stringify({ pid: process.pid }));
    await assert.rejects(recoverOwnerStorage(f.active, f.verify), /still running/); unlinkSync(lock);
    writeFileSync(lock, JSON.stringify({ pid: -1 }));
    await assert.rejects(recoverOwnerStorage(f.active, f.verify), /Invalid storage operation lock/); unlinkSync(lock);
    symlinkSync(f.paths.databaseFile, lock);
    await assert.rejects(recoverOwnerStorage(f.active, f.verify), /already active/); unlinkSync(lock);
    const mutexPath = `${f.active}.craft-cutover-mutex.sqlite`;
    const mutex = new DatabaseSync(mutexPath); mutex.exec("BEGIN IMMEDIATE");
    try { await assert.rejects(recoverOwnerStorage(f.active, f.verify), /locked/); }
    finally { mutex.exec("ROLLBACK"); mutex.close(); }
    renameSync(mutexPath, mutexPath + ".preserved"); symlinkSync(join(f.active, ".craft-storage-layout.json"), mutexPath);
    await assert.rejects(recoverOwnerStorage(f.active, f.verify), /Invalid storage maintenance mutex/);
    unlinkSync(mutexPath); renameSync(mutexPath + ".preserved", mutexPath);
    const journalFile = `${f.active}.craft-cutover.json`;
    unlinkSync(journalFile); symlinkSync(join(f.active, ".craft-storage-layout.json"), journalFile);
    await assert.rejects(recoverOwnerStorage(f.active, f.verify), /Invalid cutover journal/); unlinkSync(journalFile);
  } finally { f.close(); }
});

test("maintenance refuses competing operations and retains authority when a phase observer fails", async () => {
  const f = await fixture();
  try {
    await assert.rejects(switchOwnerStorage(f.active, f.staged, f.previous, f.manifest, f.verify, async phase => {
      if (phase === "prepared") {
        await assert.rejects(switchOwnerStorage(f.active, f.staged, f.previous, f.manifest, f.verify), /Unfinished/);
        throw new Error("ObserverUnavailable");
      }
    }), /ObserverUnavailable/);
    assert(existsSync(f.paths.databaseFile));
    await switchOwnerStorage(f.active, f.staged, f.previous, f.manifest, f.verify);
    for (const stopAt of ["prepared", "new_preserved"]) {
      await assert.rejects(rollbackOwnerStorage(f.active, join(f.directory, "cancel-new"), async()=>{}, async phase => {
        if (phase === stopAt) throw new Error("ObserverUnavailable");
      }), /ObserverUnavailable/);
      assert(hasSharedWriterFence(f.active)); assert(existsSync(f.previous));
    }
  } finally { f.close(); }
});


test("cutover rejects linked files, special configuration and invalid writer inventory", async () => {
  const f = await fixture();
  try {
    const linked = join(f.active, "foreign"); symlinkSync(f.staged, linked);
    await assert.rejects(switchOwnerStorage(f.active, f.staged, f.previous, f.manifest, f.verify), /rejects symbolic links/); unlinkSync(linked);
    const config = join(f.active, "config");
    await assert.rejects(switchOwnerStorage(f.active, f.staged, f.previous, f.manifest, f.verify, async phase => {
      if (phase === "prepared") symlinkSync(f.staged, config);
    }), /configuration cannot contain symbolic links/); unlinkSync(config);
    execFileSync("mkfifo", [config]);
    await assert.rejects(switchOwnerStorage(f.active, f.staged, f.previous, f.manifest, f.verify), /requires regular files/); unlinkSync(config);
    const invalid = join(f.directory, "not-directory"); writeFileSync(invalid, "x");
    await assert.rejects(switchOwnerStorage(invalid, f.staged, f.previous, f.manifest, f.verify), /regular directories/);
    const fakeTools = join(f.directory, "tools"); mkdirSync(fakeTools);
    writeFileSync(join(fakeTools, "lsof"), `#!${process.execPath}\nprocess.stdout.write('invalid\\n')`, { mode: 0o700 });
    const path = process.env.PATH; process.env.PATH = fakeTools;
    try { await assert.rejects(switchOwnerStorage(f.active, f.staged, f.previous, f.manifest, f.verify), /inventory is invalid/); }
    finally { process.env.PATH = path; }
  } finally { f.close(); }
});

test("journal persistence failure releases the operation lock without mutating authority", async () => {
  const f = await fixture();
  const original = fs.writeFileSync;
  try {
    fs.writeFileSync = (path, ...args) => {
      if (typeof path === "string" && path.startsWith(`${f.active}.craft-cutover.json.`)) throw new Error("JournalWriteUnavailable");
      return original(path, ...args);
    };
    syncBuiltinESMExports();
    await assert.rejects(switchOwnerStorage(f.active, f.staged, f.previous, f.manifest, f.verify), /JournalWriteUnavailable/);
    assert(existsSync(f.paths.databaseFile)); assert(!existsSync(`${f.active}.craft-cutover.lock`));
  } finally { fs.writeFileSync = original; syncBuiltinESMExports(); f.close(); }
});

for (const mode of ["create-fence", "fence-conflict", "layout-conflict"]) test(`cutover verifies existing fence state: ${mode}`, async () => {
  const f = await fixture();
  try {
    const verify = async (root: string) => {
      await f.verify(root);
      if (root !== f.staged) return;
      const layout = join(root, ".craft-storage-layout.json"); unlinkSync(layout);
      for (const directory of [join(root, "db", "craft.db"), join(root, "craft.db")]) {
        const fence = join(directory, ".craft-write-fence");
        if (mode === "create-fence") unlinkSync(fence);
        if (mode === "layout-conflict") { unlinkSync(fence); writeFileSync(fence, f.manifest.digest); }
      }
      if (mode === "layout-conflict") writeFileSync(layout, JSON.stringify({ schema: "other" }));
    };
    if (mode === "create-fence") {
      const previous = join(f.directory, "separate", "previous"); mkdirSync(dirname(previous));
      await switchOwnerStorage(f.active, f.staged, previous, f.manifest, verify);
      assert(hasSharedWriterFence(f.active));
    } else await assert.rejects(switchOwnerStorage(f.active, f.staged, f.previous, f.manifest, verify), /conflicts/);
  } finally { f.close(); }
});


test("failed staged verification can report a removed staging tree without losing the original", async () => {
  const f = await fixture();
  try {
    await assert.rejects(switchOwnerStorage(f.active, f.staged, f.previous, f.manifest, async root => {
      assert.equal(root, f.staged); rmSync(root, { recursive: true, force: true }); throw new Error("StagingLost");
    }), /StagingLost/);
    assert(existsSync(f.paths.databaseFile)); assert(!existsSync(f.previous));
  } finally { f.close(); }
});


test("a failed guard rollback still closes its database and releases the maintenance lock", async () => {
  const f = await fixture(), original = DatabaseSync.prototype.exec;
  try {
    DatabaseSync.prototype.exec = function(sql: string) {
      if (sql === "ROLLBACK") throw new Error("GuardRollbackUnavailable");
      return original.call(this, sql);
    };
    await assert.rejects(switchOwnerStorage(f.active, f.staged, f.previous, f.manifest, f.verify), /GuardRollbackUnavailable/);
    assert(hasSharedWriterFence(f.active)); assert(!existsSync(`${f.active}.craft-cutover.lock`));
  } finally { DatabaseSync.prototype.exec = original; f.close(); }
});


test("cutover refuses a database shard added after the archived snapshot", async () => {
  const f = await fixture();
  try {
    const added = new DatabaseSync(join(f.active, "new-project.sqlite")); added.exec("CREATE TABLE records(id TEXT)"); added.close();
    await assert.rejects(switchOwnerStorage(f.active, f.staged, f.previous, f.manifest, f.verify), /inventory changed/);
    assert(existsSync(f.paths.databaseFile)); assert(!existsSync(f.previous));
  } finally { f.close(); }
});

test("guard close failures retain committed authority and release the maintenance lock", async () => {
  const f = await fixture(), original = DatabaseSync.prototype.close;
  let failed = false;
  try {
    DatabaseSync.prototype.close = function() {
      original.call(this);
      // Only the original source guard is still open at the completed switch boundary.
      if (!failed && hasSharedWriterFence(f.active) && readFileSync(`${f.active}.craft-cutover.json`, "utf8").includes('"phase":"complete"')) { failed = true; throw new Error("GuardCloseUnavailable"); }
    };
    await assert.rejects(switchOwnerStorage(f.active, f.staged, f.previous, f.manifest, f.verify), /GuardCloseUnavailable/);
    assert(hasSharedWriterFence(f.active)); assert(!existsSync(`${f.active}.craft-cutover.lock`));
  } finally { DatabaseSync.prototype.close = original; f.close(); }
});
