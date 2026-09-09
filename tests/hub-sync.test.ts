import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as JsonObject).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`; return JSON.stringify(value); }
async function fixture() { const root = await mkdtemp(path.join(tmpdir(), "craft-hub-")); const store = await new CraftStore(craftPaths(root)).open(); return { store, service: new CraftService(store) }; }
function record(result: JsonObject, key: string): JsonObject { return result[key] as JsonObject; }
function signedPage(privateKey: KeyObject, sourceId: string, revision: number, previousDigest: string, entries: JsonObject[], issuedAt = "2026-09-09T00:00:00.000Z") {
  const envelope = { source_id: sourceId, revision, previous_digest: previousDigest, issued_at: issuedAt, entries };
  return { ...envelope, signature: sign(null, Buffer.from(canonical(envelope)), privateKey).toString("base64") };
}

test("signed Hub sync advances a trusted cursor, updates local metadata, and propagates withdrawals", async () => {
  const f = await fixture(); const keys = generateKeyPairSync("ed25519"); const pem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const source = record(f.service.hubSourceRegister({ source_id: "hub", endpoint: "https://hub.example/catalog", publisher: "org", public_key_pem: pem }), "source");
  assert.equal(f.service.hubSourceRegister({ source_id: "hub", endpoint: "https://hub.example/catalog", publisher: "org", public_key_pem: pem }).idempotent, true);
  const active = { entry_id: "skill-1", status: "active", content_digest: "sha256:one", release_id: "release-1", release_version: 1, name: "Video storyboard", description: "Create shots", tags: ["video"] };
  const active2 = { ...active, entry_id: "skill-2", release_id: "release-2", name: "Video helper", description: "Assist", tags: ["creative"] };
  const active3 = { ...active, entry_id: "skill-3", release_id: "release-3", name: "Video planner", description: "Plan", tags: ["creative"] };
  const firstArgs = { receipt_id: "receipt-1", ...signedPage(keys.privateKey, String(source.id), 1, "genesis", [active, active2, active3]) };
  const first = f.service.hubCatalogIngest(firstArgs); assert.equal(record(first, "receipt").signature_verified, true);
  assert.equal(f.service.hubCatalogIngest(firstArgs).idempotent, true);
  const found = record(f.service.hubCatalogSearch({ query: "video storyboard", limit: 5 }), "entries") as unknown;
  assert.equal((found as JsonObject[]).length, 3); assert.equal(f.service.hubCatalogSearch({ query: "missing" }).scanned_remote, false);
  const cursor = record(first, "source"); const withdrawn = { entry_id: "skill-1", status: "withdrawn", content_digest: "sha256:withdrawn" };
  const second = f.service.hubCatalogIngest(signedPage(keys.privateKey, "hub", 2, String(cursor.cursor_digest), [withdrawn]));
  assert.match(String(record(second, "receipt").id), /^hub_sync_/); assert.deepEqual(f.service.hubCatalogSearch({ query: "storyboard" }).entries, []);
  const disabled = f.service.hubSourceDisable({ source_id: "hub", reason: "retired" }); assert.equal(record(disabled, "source").status, "disabled");
  assert.equal(f.service.hubSourceDisable({ source_id: "hub", reason: "retired" }).idempotent, true);
  assert.throws(() => f.service.hubCatalogIngest(signedPage(keys.privateKey, "hub", 3, String(record(second, "source").cursor_digest), [])), /not active/);
  f.store.close();
});

test("Hub sync rejects untrusted sources, malformed pages, forks, replay conflicts, and payload-shaped entries", async () => {
  const f = await fixture(); const keys = generateKeyPairSync("ed25519"); const other = generateKeyPairSync("ed25519"); const pem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const register = (extra: JsonObject = {}) => f.service.hubSourceRegister({ endpoint: "https://hub.example/", publisher: "org", public_key_pem: pem, ...extra });
  assert.throws(() => register({ endpoint: "http://hub.example" }), /HTTPS/); assert.throws(() => register({ endpoint: "https://u:p@hub.example" }), /HTTPS/);
  assert.throws(() => register({ public_key_pem: "bad" }), /invalid/); const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(() => register({ public_key_pem: rsa.publicKey.export({ type: "spki", format: "pem" }).toString() }), /Ed25519/);
  const source = record(register({ source_id: "hub" }), "source"); assert.match(String(source.id), /^hub$/);
  assert.match(String(record(register({ endpoint: "https://second.example/" }), "source").id), /^hub_source_/);
  assert.throws(() => register({ source_id: "hub", publisher: "other" }), /idempotency conflict/);
  const base = (entries: unknown, extra: JsonObject = {}) => ({ source_id: "hub", revision: 1, previous_digest: "genesis", issued_at: "2026-09-09T00:00:00.000Z", entries, signature: "bad", ...extra });
  assert.throws(() => f.service.hubCatalogIngest(base({})), /at most 1000/); assert.throws(() => f.service.hubCatalogIngest(base(new Array(1001).fill({}))), /at most 1000/);
  assert.throws(() => f.service.hubCatalogIngest(base([[]])), /entry must be an object/);
  assert.throws(() => f.service.hubCatalogIngest(base([{ entry_id: "x", status: "maybe", content_digest: "d" }])), /status is unsupported/);
  assert.throws(() => f.service.hubCatalogIngest(base([{ entry_id: "x", status: "active", content_digest: "d" }])), /release_id/);
  const complete = { entry_id: "x", status: "active", content_digest: "d", release_id: "r", release_version: 1, name: "n", description: "d" };
  assert.throws(() => f.service.hubCatalogIngest(base([{ ...complete, tags: "bad" }])), /array with at most/);
  assert.throws(() => f.service.hubCatalogIngest(base([{ ...complete, tags: ["a", "a"] }])), /unique values/);
  assert.throws(() => f.service.hubCatalogIngest(base([{ ...complete }])), /verification failed/);
  const duplicate = { entry_id: "x", status: "withdrawn", content_digest: "d" }; assert.throws(() => f.service.hubCatalogIngest(base([duplicate, duplicate])), /must be unique/);
  assert.throws(() => f.service.hubCatalogIngest(base([], { issued_at: "bad" })), /ISO timestamp/);
  assert.throws(() => f.service.hubCatalogIngest(base([], { signature: "" })), /signature/);
  const wrongSignature = signedPage(other.privateKey, "hub", 1, "genesis", []); assert.throws(() => f.service.hubCatalogIngest(wrongSignature), /verification failed/);
  const valid = signedPage(keys.privateKey, "hub", 1, "genesis", []); f.service.hubCatalogIngest({ receipt_id: "r", ...valid });
  assert.throws(() => f.service.hubCatalogIngest({ receipt_id: "r", ...signedPage(keys.privateKey, "hub", 1, "genesis", [{ entry_id: "z", status: "withdrawn", content_digest: "d" }]) }), /idempotency conflict/);
  assert.throws(() => f.service.hubCatalogIngest(signedPage(keys.privateKey, "hub", 3, String(record(f.service.hubSourceDisable({ source_id: "hub", reason: "x" }), "source").cursor_digest), [])), /not active/);
  f.store.save("hub_source", "hub", { ...f.store.get("hub_source", "hub"), status: "active" });
  assert.throws(() => f.service.hubCatalogIngest(signedPage(keys.privateKey, "hub", 3, "wrong", [])), /advance exactly once/);
  assert.throws(() => f.service.hubCatalogIngest(signedPage(keys.privateKey, "hub", 2, "wrong", [])), /previous digest/);
  assert.throws(() => f.service.hubCatalogSearch({ query: " ", limit: 1 }), /query/); assert.throws(() => f.service.hubCatalogSearch({ query: "x", limit: 0 }), /limit/);
  f.store.close();
});
