import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as JsonObject).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`; return JSON.stringify(value); }
function file(filePath: string, body: string): JsonObject { return { path: filePath, content_base64: Buffer.from(body).toString("base64") }; }
function packageDigest(items: JsonObject[]): string { const manifest = items.map((item) => { const content = Buffer.from(String(item.content_base64), "base64"); return { path: String(item.path), size: content.length, digest: `sha256:${createHash("sha256").update(content).digest("hex")}` }; }); return `sha256:${createHash("sha256").update(canonical(manifest)).digest("hex")}`; }
function signedPage(privateKey: KeyObject, entries: JsonObject[]) { const envelope = { source_id: "team-hub", revision: 1, previous_digest: "genesis", issued_at: "2026-09-10T00:00:00.000Z", entries }; return { ...envelope, signature: sign(null, Buffer.from(canonical(envelope)), privateKey).toString("base64") }; }
function record(result: JsonObject, key: string): JsonObject { return result[key] as JsonObject; }

test("governed capability intake keeps a signed external candidate non-executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-governed-intake-")); const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  try {
    const keys = generateKeyPairSync("ed25519"); const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const source = record(service.hubSourceRegister({ source_id: "team-hub", endpoint: "https://hub.example/catalog", publisher: "Example team", public_key_pem: publicKey }), "source");
    const files = [file("SKILL.md", "# Meeting brief\nSummarize only supplied notes.\n")];
    const entry = { entry_id: "meeting-brief", status: "active", content_digest: packageDigest(files), release_id: "meeting-brief-1", release_version: 1, name: "Meeting brief", description: "Summarize supplied notes", tags: ["meetings", "writing"] };
    const ingested = service.hubCatalogIngest(signedPage(keys.privateKey, [entry]));
    assert.equal(record(ingested, "receipt").signature_verified, true); assert.equal(record(ingested, "source").id, source.id);
    const found = record(service.hubCatalogSearch({ query: "meeting", limit: 5 }), "entries") as unknown as JsonObject[];
    assert.deepEqual(found.map((item) => item.entry_id), ["meeting-brief"]);

    const staged = record(await service.capabilityMaterializeStage({ materialization_id: "meeting-brief-intake", source_id: "team-hub", entry_id: "meeting-brief", files }), "materialization");
    assert.equal(staged.status, "quarantined");
    const evidence = service.evidenceRecord({ evidence_id: "meeting-brief-review", source_type: "human", claim: "Reviewer inspected the exact quarantined package." });
    const reviewed = record(service.capabilityMaterializeReview({ materialization_id: staged.id, decision: "approve", reviewer: "reviewer", review_ref: "review:meeting-brief", evidence_ids: [evidence.id] }), "materialization");
    assert.equal(reviewed.status, "approved");
    const activated = service.capabilityMaterializeActivate({ materialization_id: reviewed.id, asset_id: "meeting-brief-candidate", asset_type: "skill", effect: "read_only" });
    assert.equal(record(activated, "asset").trust, "candidate"); assert.equal(record(activated, "asset").execution_authority, false); assert.equal(activated.executable, false);
    assert.equal(service.hubCatalogSearch({ query: "unlisted" }).scanned_remote, false);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
