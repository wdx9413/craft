import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { defaultSettings, normalizeSettings, saveSettingsSync } from "../core/settings.ts";
import { normalizeContextSync, contextSyncKey, contextSyncProjection, DEFAULT_CONTEXT_SYNC } from "../core/context-sync-protocol.ts";
import { LocalDirContextSyncAdapter, RemoteContextSyncAdapter, contextSyncDocument, runContextSync } from "../core/context-sync-adapter.ts";

function temporaryPaths() {
  return craftPaths(mkdtempSync(join(tmpdir(), "craft-context-sync-")));
}

test("外部知识库同步默认关闭、本地权威、凭据不落配置", () => {
  const paths = temporaryPaths();
  try {
    const sync = defaultSettings(paths).contextSync;
    assert.equal(sync.enabled, false);
    assert.equal(sync.protocol, "local_dir");
    assert.equal(sync.conflict, "local_wins");
    assert.equal(sync.remoteRoot, "craft_data");
    const projection = contextSyncProjection(sync);
    assert.equal(projection.local_authoritative, true);
    assert.equal(projection.credentials_stored, false);
  } finally { rmSync(paths.root, { recursive: true, force: true }); }
});

test("协议校验拒绝非法 protocol/URL/凭据名/路径穿越", () => {
  assert.throws(() => normalizeContextSync({ protocol: "s3" }), /protocol is unsupported/u);
  assert.throws(() => normalizeContextSync({ protocol: "webdav", endpoint: "not-a-url" }), /valid HTTP\(S\) URL/u);
  assert.throws(() => normalizeContextSync({ tokenEnv: "bad-env" }), /environment variable name/u);
  assert.throws(() => normalizeContextSync({ remoteRoot: "../escape" }), /bounded relative path/u);
  assert.throws(() => normalizeContextSync({ intervalMs: 5 }), /between 10000 and 86400000/u);
  assert.throws(() => normalizeContextSync({ conflict: "merge" }), /conflict is unsupported/u);
  const webdav = normalizeContextSync({ protocol: "webdav", endpoint: "https://dav.example.com/remote", kinds: ["knowledge"] });
  assert.equal(webdav.protocol, "webdav");
  assert.deepEqual(webdav.kinds, ["knowledge"]);
  assert.equal(contextSyncKey(webdav, { kind: "knowledge", name: "a.md", digest: "", updatedAt: "" }), "craft_data/knowledge/a.md");
});

test("settings 持久化 contextSync 且重新加载仍然有效", () => {
  const paths = temporaryPaths();
  try {
    const saved = saveSettingsSync({ contextSync: { enabled: true, protocol: "local_dir", endpoint: paths.root, intervalMs: 30_000 } }, paths);
    assert.equal(saved.contextSync.enabled, true);
    assert.equal(saved.contextSync.intervalMs, 30_000);
    const reloaded = normalizeSettings(JSON.parse(readFileSync(paths.settingsFile, "utf8")), paths);
    assert.equal(reloaded.contextSync.enabled, true);
  } finally { rmSync(paths.root, { recursive: true, force: true }); }
});

test("本地目录 adapter 把三类知识写到 craft_data/<kind>/ 并可重放幂等", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-sync-vault-"));
  try {
    const target = normalizeContextSync({ enabled: true, protocol: "local_dir", endpoint: root });
    const entry = { kind: "knowledge" as const, name: "claim-1.md", digest: "", updatedAt: "" };
    const doc = contextSyncDocument(target, entry, "---\ncraft_kind: knowledge\n---\n\n# A\n\nbody\n");
    const status = await runContextSync(target, [doc]);
    assert.equal(status.ok, true);
    assert.equal(status.pushed, 1);
    const file = join(root, "craft_data", "knowledge", "claim-1.md");
    assert.equal(existsSync(file), true);
    assert.match(readFileSync(file, "utf8"), /craft_kind: knowledge/u);
    const again = await runContextSync(target, [doc]);
    assert.equal(again.pushed, 0, "相同摘要不重复写");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("冲突策略 local_wins 覆盖、remote_wins/manual 跳过", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-sync-conflict-"));
  try {
    const dir = join(root, "craft_data", "memory");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "m1.md");
    writeFileSync(file, "remote old", "utf8");
    const doc = contextSyncDocument(normalizeContextSync({ enabled: true, protocol: "local_dir", endpoint: root }),
      { kind: "memory", name: "m1.md", digest: "", updatedAt: "" }, "local new");
    const local = await runContextSync(normalizeContextSync({ enabled: true, protocol: "local_dir", endpoint: root, conflict: "local_wins" }), [doc]);
    assert.equal(local.conflicts, 1);
    assert.equal(readFileSync(file, "utf8"), "local new");
    writeFileSync(file, "remote old again", "utf8");
    const remote = await runContextSync(normalizeContextSync({ enabled: true, protocol: "local_dir", endpoint: root, conflict: "remote_wins" }), [doc]);
    assert.equal(remote.pushed, 0);
    assert.equal(readFileSync(file, "utf8"), "remote old again");
    const manual = await runContextSync(normalizeContextSync({ enabled: true, protocol: "local_dir", endpoint: root, conflict: "manual" }), [doc]);
    assert.equal(manual.pushed, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("远端协议没有 token 时诚实失败，不静默吞掉", async () => {
  const target = normalizeContextSync({ enabled: true, protocol: "http_object", endpoint: "https://store.example.com", tokenEnv: "CTX_TOKEN" });
  const adapter = new RemoteContextSyncAdapter(target, {} as NodeJS.ProcessEnv, (async () => { throw new Error("should not fetch"); }) as never);
  await assert.rejects(() => adapter.put(contextSyncDocument(target, { kind: "knowledge", name: "a.md", digest: "", updatedAt: "" }, "x")), /CTX_TOKEN/u);
});

test("本地 adapter 拒绝写到 remoteRoot 之外或含路径穿越的 key", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-sync-escape-"));
  try {
    const target = normalizeContextSync({ enabled: true, protocol: "local_dir", endpoint: root });
    const adapter = new LocalDirContextSyncAdapter(target);
    await assert.rejects(() => adapter.put({ key: "other/place/a.md", body: "x", digest: "sha256:x" }), /out-of-root key/u);
    await assert.rejects(() => adapter.put({ key: "craft_data/knowledge/../../escape.md", body: "x", digest: "sha256:x" }), /out-of-root key/u);
    // 正常 key 仍可写。
    await adapter.put({ key: "craft_data/knowledge/ok.md", body: "ok", digest: "sha256:ok" });
    assert.equal(existsSync(join(root, "craft_data", "knowledge", "ok.md")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
