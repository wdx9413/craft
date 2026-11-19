import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CONCEPT_KINDS, RELATION_KINDS } from "craft-common-ontology";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { CraftService } from "../core/service.ts";
import { McpServer } from "../core/mcp.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";

test("Ontology registration and effective classification are reachable through the public Craft MCP surface", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-ontology-service-"));
  const store = await new CraftStore(craftPaths(join(root, ".craft_data"))).open();
  try {
    const service = new CraftService(store), server = new McpServer(service);
    const surface = await server.handle({ jsonrpc: "2.0", id: "ontology-tools", method: "tools/list" }) as JsonObject;
    const available = ((surface.result as JsonObject).tools as JsonObject[]).map(item => String(item.name));
    for (const name of ["craft_ontology_classification_projection_build", "craft_ontology_activation_set", "craft_ontology_activation_resolve",
      "craft_ontology_activation_feedback", "craft_ontology_activation_rollback", "craft_ontology_activation_revoke"])
      assert(available.includes(name), `${name} must be exposed`);
    const invalidFeedback = await server.handle({ jsonrpc: "2.0", id: "feedback", method: "tools/call", params: {
      name: "craft_ontology_activation_feedback", arguments: { active_pointer_id: "missing", evaluation_id: "missing" } } }) as JsonObject;
    assert.equal((invalidFeedback.result as JsonObject).isError, true, "feedback must fail closed without an active verified pointer");
    const registered = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "craft_ontology_version_register", arguments: {
      ontology: { version: "service-v1", concept_kinds: [...CONCEPT_KINDS], relation_kinds: [...RELATION_KINDS] }, scope: { kind: "project", id: "project-a" } } } }) as JsonObject;
    assert.equal((registered.result as JsonObject).isError, false);
    const registeredContent = (registered.result as JsonObject).structuredContent as JsonObject;
    const registeredOntology = registeredContent.ontology as JsonObject;
    const claim = store.create("knowledge_claim", "public-claim", { kind: "fact", concept_kind: "fact", content: "Keep source and body stable.", scope: "global" });
    const read = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "craft_ontology_classification_get", arguments: { claim_id: claim.id } } }) as JsonObject;
    const result = (read.result as JsonObject).structuredContent as JsonObject;
    assert.equal((read.result as JsonObject).isError, false);
    assert.deepEqual(result.effective_classification, { ontology_version: "legacy", concept_kind: "fact", revision_id: null });
    const projection = await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "craft_ontology_classification_projection_build", arguments: {
      ontology_id: registeredOntology.id,
      scope: { kind: "project", id: "project-a" } } } }) as JsonObject;
    assert.equal((projection.result as JsonObject).isError, false);
    const resolved = await server.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "craft_ontology_activation_resolve", arguments: {
      project_scope_id: "project-a" } } }) as JsonObject;
    assert.equal((((resolved.result as JsonObject).structuredContent as JsonObject).status), "compatibility_baseline");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
