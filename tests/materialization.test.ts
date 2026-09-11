import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as JsonObject).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`; return JSON.stringify(value); }
function file(filePath: string, body: string | Buffer): JsonObject { return { path: filePath, content_base64: Buffer.from(body).toString("base64") }; }
function packageDigest(items: JsonObject[]): string { const manifest = items.map((item) => { const content = Buffer.from(String(item.content_base64), "base64"); return { path: String(item.path).replaceAll("\\", "/"), size: content.length, digest: `sha256:${createHash("sha256").update(content).digest("hex")}` }; }); return `sha256:${createHash("sha256").update(canonical(manifest)).digest("hex")}`; }
async function fixture(items: JsonObject[], entryId = "entry") { const root = await mkdtemp(path.join(tmpdir(), "craft-materialize-")); const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  store.create("hub_source", "hub", { status: "active", cursor_revision: 1 }); store.create("hub_catalog_entry", `hub:${entryId}`, { source_id: "hub", entry_id: entryId, status: "active", source_revision: 1, name: "Capability", content_digest: packageDigest(items) }); store.create("evidence", "e1", { claim: "reviewed" }); return { root, store, service }; }
function record(result: JsonObject, key: string): JsonObject { return result[key] as JsonObject; }

test("materialization quarantines exact content and registers only a reviewed non-executable candidate", async () => {
  const items = [file("SKILL.md", "# Safe\n"), file("scripts/run.ts", "export const ok = true;\n")]; const f = await fixture(items);
  const staged = record(await f.service.capabilityMaterializeStage({ materialization_id: "m", source_id: "hub", entry_id: "entry", files: items }), "materialization");
  assert.equal(staged.status, "quarantined"); assert.equal(staged.risk_level, "low"); await access(path.join(String(staged.package_root), "SKILL.md"));
  assert.equal((await f.service.capabilityMaterializeStage({ materialization_id: "m", source_id: "hub", entry_id: "entry", files: items })).idempotent, true);
  const changed = [file("SKILL.md", "# Changed\n")]; f.store.create("hub_catalog_entry", "hub:changed", { source_id: "hub", entry_id: "changed", status: "active", source_revision: 1, name: "Changed", content_digest: packageDigest(changed) });
  await assert.rejects(() => f.service.capabilityMaterializeStage({ materialization_id: "m", source_id: "hub", entry_id: "changed", files: changed }), /idempotency conflict/);
  const approved = record(f.service.capabilityMaterializeReview({ materialization_id: "m", decision: "approve", reviewer: "human", review_ref: "review-1", evidence_ids: ["e1"] }), "materialization");
  const activated = f.service.capabilityMaterializeActivate({ materialization_id: "m", asset_id: "asset", asset_type: "skill", effect: "read_only" }); const asset = record(activated, "asset");
  assert.equal(asset.trust, "candidate"); assert.equal(asset.execution_authority, false); assert.equal(activated.executable, false); assert.equal(record(activated, "materialization").status, "candidate_registered");
  assert.throws(() => f.service.capabilityMaterializeReview({ materialization_id: approved.id, decision: "reject", reviewer: "x", review_ref: "x" }), /not awaiting/);
  assert.throws(() => f.service.capabilityMaterializeActivate({ materialization_id: "m", asset_id: "asset2", asset_type: "skill", effect: "read_only" }), /approved/);
  f.store.close();
});

test("materialization findings, review, withdrawal, bounds, and idempotency fail closed", async () => {
  const risky = [file("capability.json", "{\"name\":\"x\"}"), file("note.txt", "Bearer abcdefghijklmnop")]; const f = await fixture(risky);
  const auto = record(await f.service.capabilityMaterializeStage({ source_id: "hub", entry_id: "entry", files: risky }), "materialization"); assert.match(String(auto.id), /^materialization_/); assert.equal(auto.risk_level, "high");
  assert.throws(() => f.service.capabilityMaterializeReview({ materialization_id: auto.id, decision: "approve", reviewer: "r", review_ref: "x", evidence_ids: ["e1"] }), /security approval/);
  const approved = record(f.service.capabilityMaterializeReview({ materialization_id: auto.id, decision: "approve", reviewer: "r", review_ref: "x", evidence_ids: ["e1"], security_approval_ref: "security-1" }), "materialization"); assert.equal(approved.status, "approved");
  f.store.save("hub_catalog_entry", "hub:entry", { ...f.store.get("hub_catalog_entry", "hub:entry"), status: "withdrawn" });
  assert.throws(() => f.service.capabilityMaterializeActivate({ materialization_id: auto.id, asset_id: "a", asset_type: "skill", effect: "read_only" }), /withdrawn or changed/);
  await assert.rejects(() => f.service.capabilityMaterializeStage({ source_id: "hub", entry_id: "entry", files: risky }), /entry is not active/);
  f.store.save("hub_source", "hub", { ...f.store.get("hub_source", "hub"), status: "disabled" });
  await assert.rejects(() => f.service.capabilityMaterializeStage({ source_id: "hub", entry_id: "entry", files: risky }), /source is not active/);
  f.store.save("hub_source", "hub", { ...f.store.get("hub_source", "hub"), status: "active" });
  f.store.save("hub_catalog_entry", "hub:entry", { ...f.store.get("hub_catalog_entry", "hub:entry"), status: "active", content_digest: "sha256:changed" });
  assert.throws(() => f.service.capabilityMaterializeActivate({ materialization_id: auto.id, asset_id: "a", asset_type: "skill", effect: "read_only" }), /withdrawn or changed/);
  f.store.save("hub_catalog_entry", "hub:entry", { ...f.store.get("hub_catalog_entry", "hub:entry"), content_digest: packageDigest(risky) });
  const invalidCases: [JsonObject[], RegExp][] = [
    [[], /between 1 and 200/], [["bad"] as unknown as JsonObject[], /file must be an object/],
    [[{ path: "../x", content_base64: "eA==" }], /path is unsafe/], [[{ path: "CON", content_base64: "eA==" }], /path is unsafe/],
    [[{ path: "SKILL.md", content_base64: "%%%" }], /base64 is invalid/], [[file("SKILL.md", Buffer.alloc(1_048_577))], /exceeds 1 MiB/],
    [[file("SKILL.md", "a"), file("skill.md", "b")], /unique across platforms/],
    [[file("readme.txt", "x")], /requires a capability descriptor/], [[file("SKILL.md", "changed")], /digest does not match/],
  ];
  for (const [files, expected] of invalidCases) await assert.rejects(() => f.service.capabilityMaterializeStage({ source_id: "hub", entry_id: "entry", files }), expected);
  const tooMany = Array.from({ length: 201 }, (_, index) => file(`f${index}.txt`, "x")); await assert.rejects(() => f.service.capabilityMaterializeStage({ source_id: "hub", entry_id: "entry", files: tooMany }), /between 1 and 200/);
  const large = [file("SKILL.md", "x"), ...Array.from({ length: 6 }, (_, index) => file(`f${index}.txt`, Buffer.alloc(900_000)))]; await assert.rejects(() => f.service.capabilityMaterializeStage({ source_id: "hub", entry_id: "entry", files: large }), /exceeds 5 MiB/);
  assert.throws(() => f.service.capabilityMaterializeReview({ materialization_id: auto.id, decision: "maybe", reviewer: "r", review_ref: "x" }), /not awaiting|decision/);
  const rejectItems = [file("plugin.json", "{}")]; const g = await fixture(rejectItems, "reject"); const rejectedStage = record(await g.service.capabilityMaterializeStage({ materialization_id: "reject-m", source_id: "hub", entry_id: "reject", files: rejectItems }), "materialization");
  assert.throws(() => g.service.capabilityMaterializeReview({ materialization_id: rejectedStage.id, decision: "maybe", reviewer: "r", review_ref: "x" }), /decision/);
  assert.throws(() => g.service.capabilityMaterializeReview({ materialization_id: rejectedStage.id, decision: "approve", reviewer: "r", review_ref: "x" }), /requires Evidence/);
  assert.equal(record(g.service.capabilityMaterializeReview({ materialization_id: rejectedStage.id, decision: "reject", reviewer: "r", review_ref: "x" }), "materialization").status, "rejected");
  assert.throws(() => g.service.capabilityMaterializeActivate({ materialization_id: rejectedStage.id, asset_id: "a", asset_type: "bad", effect: "bad" }), /approved/);
  for (const [critical, expected] of [[[file("SKILL.md", "x"), file("bad.exe", "x")], /critical finding/], [[file("SKILL.md", "x"), file("package.json", "{")], /critical finding/]] as [JsonObject[], RegExp][]) {
    const c = await fixture(critical); await assert.rejects(() => c.service.capabilityMaterializeStage({ source_id: "hub", entry_id: "entry", files: critical }), expected); c.store.close();
  }
  await assert.rejects(() => g.service.capabilityMaterializeStage({ source_id: " ", entry_id: "reject", files: rejectItems }), /source_id/);
  const escaped = await fixture(rejectItems); escaped.store.create("hub_source", "..", { status: "active" }); escaped.store.create("hub_catalog_entry", "..:entry", { source_id: "..", entry_id: "entry", status: "active", source_revision: 1, name: "x", content_digest: packageDigest(rejectItems) });
  await assert.rejects(() => escaped.service.capabilityMaterializeStage({ source_id: "..", entry_id: "entry", files: rejectItems }), /escaped the cache root/); escaped.store.close();
  const blocked = await fixture(rejectItems); const blockedCache = path.join(blocked.root, "cache-file"); await writeFile(blockedCache, "block"); blocked.store.paths.cacheDir = blockedCache;
  await assert.rejects(() => blocked.service.capabilityMaterializeStage({ source_id: "hub", entry_id: "entry", files: rejectItems })); blocked.store.close();
  const occupied = await fixture(rejectItems); const destination = path.join(occupied.store.paths.cacheDir, "hub-packages", "hub", "entry", packageDigest(rejectItems).slice(7));
  await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, "occupied");
  await assert.rejects(() => occupied.service.capabilityMaterializeStage({ source_id: "hub", entry_id: "entry", files: rejectItems })); occupied.store.close();
  f.store.close(); g.store.close();
});

test("approved materialization still validates active source, type, effect, and current digest", async () => {
  const items = [file("capability.json", "{}"), file("package.json", "{\"scripts\":{\"build\":\"tsc\"}}")]; const f = await fixture(items); const staged = record(await f.service.capabilityMaterializeStage({ materialization_id: "m", source_id: "hub", entry_id: "entry", files: items }), "materialization");
  f.service.capabilityMaterializeReview({ materialization_id: staged.id, decision: "approve", reviewer: "r", review_ref: "x", evidence_ids: ["e1"], security_approval_ref: "s" });
  f.store.save("hub_source", "hub", { ...f.store.get("hub_source", "hub"), status: "disabled" }); assert.throws(() => f.service.capabilityMaterializeActivate({ materialization_id: "m", asset_id: "a", asset_type: "skill", effect: "read_only" }), /source is not active/);
  f.store.save("hub_source", "hub", { ...f.store.get("hub_source", "hub"), status: "active" }); assert.throws(() => f.service.capabilityMaterializeActivate({ materialization_id: "m", asset_id: "a", asset_type: "bad", effect: "read_only" }), /unsupported/); assert.throws(() => f.service.capabilityMaterializeActivate({ materialization_id: "m", asset_id: "a", asset_type: "skill", effect: "bad" }), /unsupported/);
  f.store.create("capability_asset", "a", { name: "old", trust: "candidate", health: "stale" });
  assert.equal(record(f.service.capabilityMaterializeActivate({ materialization_id: "m", asset_id: "a", asset_type: "skill", effect: "local_write", name: "Custom" }), "asset").version, 2);
  f.store.close();
});
