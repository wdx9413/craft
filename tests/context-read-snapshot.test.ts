import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { ContextResolutionKernel } from "../core/context-resolution.ts";
import { assertContextReadCurrent, ContextAccessChangedError } from "../common/craft-common-store-local/src/context-access-guard.ts";

async function fixture(count: number) {
  const root = mkdtempSync(join(tmpdir(), "craft-read-snapshot-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const ids = Array.from({ length: count }, (_, i) => `m${String(i).padStart(3, "0")}`);
  store.saveBatch(ids.map(id => ({ kind: "memory_ledger", id, payload: { scope: { kind: "project", id: "p" }, status: "active", content: "alpha" } })));
  return { root, store, ids, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("scoped metadata pages remain unique when another process inserts and deletes between pages", async () => {
  const f = await fixture(601);
  try {
    const writer = `import {CraftStore} from './core/infrastructure/store.ts';import {craftPaths} from './core/infrastructure/paths.ts';const store=await new CraftStore(craftPaths(process.argv[1])).open();store.transaction(db=>{db.prepare("DELETE FROM records WHERE kind='memory_ledger' AND id=?").run(process.argv[2]);store.create('memory_ledger','new',{scope:{kind:'project',id:'p'},status:'active',content:'alpha'});});store.close();`;
    let inserted = false;
    const records = f.store.listScoped("memory_ledger", [{ kind: "project", id: "p" }], 1000, item => {
      if (!inserted) { inserted = true; execFileSync(process.execPath, ["--input-type=module", "-e", writer, f.root, String(item.id)], { cwd: process.cwd(), stdio: "pipe" }); }
      return true;
    });
    assert.equal(records.length, 601); assert.equal(new Set(records.map(item => item.id)).size, 601);
    assert.deepEqual(new Set(records.map(item => item.id)), new Set(f.ids));
    assert(!records.some(item => item.id === "new"));
    const next = f.store.listScoped("memory_ledger", [{ kind: "project", id: "p" }], 1000);
    assert.equal(next.length, 601); assert(next.some(item => item.id === "new"));
  } finally { f.close(); }
});

test("historical pages keep their initial revision watermark across cross-process updates", async () => {
  const f = await fixture(601);
  try {
    const writer = `import {CraftStore} from './core/infrastructure/store.ts';import {craftPaths} from './core/infrastructure/paths.ts';const store=await new CraftStore(craftPaths(process.argv[1])).open();store.save('memory_ledger','m000',{scope:{kind:'project',id:'p'},status:'revoked',content:'new'});store.close();`;
    let updated = false;
    const records = f.store.listScoped("memory_ledger", [{ kind: "project", id: "p" }], 1000, () => {
      if (!updated) { updated = true; execFileSync(process.execPath, ["--input-type=module", "-e", writer, f.root], { stdio: "pipe" }); }
      return true;
    }, { history: true });
    assert.equal(records.length, 601); assert.equal(new Set(records.map(item => `${item.id}@${item.version}`)).size, 601);
    assert.equal(records.find(item => item.id === "m000")!.version, 1);
    const next = f.store.listScoped("memory_ledger", [{ kind: "project", id: "p" }], 1000, undefined, { history: true });
    assert.equal(next.length, 602); assert(next.some(item => item.id === "m000" && item.version === 2));
  } finally { f.close(); }
});

test("all read-fence batches share a short publication lock and later reads reject a committed writer", async t => {
  const f = await fixture(251), attempting = join(f.root, "attempting"), committed = join(f.root, "committed");
  const code = `import {CraftStore} from './core/infrastructure/store.ts';import {craftPaths} from './core/infrastructure/paths.ts';import {writeFileSync} from 'node:fs';const store=await new CraftStore(craftPaths(process.argv[1])).open();process.stdout.write('READY');process.stdin.once('data',()=>{writeFileSync(process.argv[2],'attempting');store.save('memory_ledger','m000',{scope:{kind:'project',id:'p'},status:'revoked',content:'alpha'});writeFileSync(process.argv[3],'committed');store.close();process.exit(0);});process.stdin.resume();`;
  const writer = spawn(process.execPath, ["--input-type=module", "-e", code, f.root, attempting, committed], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(writer, "exit");
  let stderr = ""; writer.stderr.on("data", data => { stderr += String(data); });
  try {
    const [ready] = await once(writer.stdout, "data"); assert.equal(String(ready), "READY");
    const prepare = f.store.database.prepare.bind(f.store.database), sleeping = new Int32Array(new SharedArrayBuffer(4));
    let queries = 0;
    t.mock.method(f.store.database, "prepare", (sql: string) => {
      const statement = prepare(sql);
      if (sql.startsWith("WITH pinned(kind,id,version)")) {
        const get = statement.get.bind(statement);
        t.mock.method(statement, "get", (...parameters: Parameters<typeof statement.get>) => {
          const result = get(...parameters);
          if (++queries === 1) {
            writer.stdin.write("go");
            const deadline = Date.now() + 1000;
            while (!existsSync(attempting) && Date.now() < deadline) Atomics.wait(sleeping, 0, 0, 5);
            assert(existsSync(attempting), "writer reached its update attempt");
            Atomics.wait(sleeping, 0, 0, 100);
            assert(!existsSync(committed), "writer remains blocked between fence batches");
          }
          return result;
        });
      }
      return statement;
    });
    const receipt: JsonObject = { read_refs: f.ids.map(id => ({ kind: "memory_ledger", id, version: 1 })) };
    assertContextReadCurrent(f.store, receipt); assert.equal(queries, 2);
    const [exitCode] = await exited; assert.equal(exitCode, 0, stderr);
    assert.equal(readFileSync(committed, "utf8"), "committed");
    assert.equal(f.store.get("memory_ledger", "m000").status, "revoked");
    assert.throws(() => assertContextReadCurrent(f.store, receipt), ContextAccessChangedError);
  } finally { writer.kill(); t.mock.restoreAll(); await exited; f.close(); }
});


test("scope-stack aliases pin the version actually used before the read fence is constructed", async t => {
  const f = await fixture(1);
  try {
    f.store.create("knowledge_source", "source", { status: "active", trust: "verified" });
    f.store.save("memory_ledger", "m000", { scope: { kind: "project", id: "p" }, source_id: "source", status: "active", kind: "preference", sensitivity: "internal", content: "alpha", content_digest: "d" });
    const kernel = new ContextResolutionKernel(f.store);
    const alias = kernel.scopes.bindAlias({ scope_kind: "project", scope_id: "p", alias_kind: "path", alias: "path" }).alias as JsonObject;
    const original = kernel.scopes.resolveStack.bind(kernel.scopes);
    const writer = `import {CraftStore} from './core/infrastructure/store.ts';import {craftPaths} from './core/infrastructure/paths.ts';const store=await new CraftStore(craftPaths(process.argv[1])).open();const alias=store.get('scope_alias',process.argv[2]);store.save('scope_alias',String(alias.id),{...alias,status:'revoked'});store.close();`;
    let revoked = false;
    t.mock.method(kernel.scopes, "resolveStack", (...args: Parameters<typeof original>) => {
      const result = original(...args);
      if (!revoked) { revoked = true; execFileSync(process.execPath, ["--input-type=module", "-e", writer, f.root, String(alias.id)], { stdio: "pipe" }); }
      return result;
    });
    await assert.rejects(kernel.resolve({ query: "alpha", scope_kind: "project", scope_id: "path" }), ContextAccessChangedError);
    const next = await kernel.resolve({ query: "alpha", scope_kind: "project", scope_id: "path" });
    assert.equal((next.items as unknown[]).length, 0);
  } finally { t.mock.restoreAll(); f.close(); }
});
