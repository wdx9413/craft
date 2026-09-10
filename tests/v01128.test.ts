import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService, VERSION } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";
await import("./v01129.test.ts");

test("v0.11.28 installs cross-domain acceptance Kits without treating subjective approval as program proof", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-kits-")); const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  try {
    const installed = service.domainKitInstallBuiltins().kits as JsonObject[]; assert.deepEqual(installed.map((kit) => kit.id).sort(), ["builtin.content-delivery", "builtin.developer-delivery", "builtin.sales-delivery", "builtin.video-delivery"]);
    const content = service.domainKitGet({ kit_id: "builtin.content-delivery" }) as JsonObject; assert.equal(content.domain, "content"); assert.equal(((content.criteria as JsonObject[])[1].method), "human");
    const sales = service.domainKitGet({ kit_id: "builtin.sales-delivery" }) as JsonObject; assert.equal(sales.domain, "sales"); assert.equal(((sales.criteria as JsonObject[])[0].evaluator as JsonObject).path_field, "proposal_path");
    assert.equal((service.domainKitInstallBuiltins().kits as JsonObject[]).length, 4);
    const mcp = new McpServer(service, "full"); const result = await mcp.handle({ id: "kits", method: "tools/call", params: { name: "craft_domain_kit_list", arguments: {} } }); assert.equal(((result?.result as JsonObject).structuredContent as JsonObject).kits instanceof Array, true);
    assert.equal(VERSION, "0.11.32");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
