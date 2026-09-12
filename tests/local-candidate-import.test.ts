import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService, VERSION } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

test("local package import is explicit, descendant-only, idempotent, and never enables content", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-local-import-")); const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  try {
    store.create("wiki_candidate_publication_package", "package", { status: "prepared", manual_import_required: true, execution_authority: false, content: "# Reviewed skill\n" }); const input = { import_id: "import", package_id: "package", target_root: root, relative_path: "skills/reviewed.md", reviewer: "human", confirmed: true };
    await assert.rejects(service.wikiCandidateLocalImport({ ...input, confirmed: false }), /confirmed/); const imported = await service.wikiCandidateLocalImport(input); assert.equal((imported.import as JsonObject).enabled, false); assert.equal(await readFile(join(root, "skills", "reviewed.md"), "utf8"), "# Reviewed skill\n"); assert.equal((await service.wikiCandidateLocalImport(input)).idempotent, true); assert.equal((service.wikiCandidateLocalImportGet({ import_id: "import" }).import as JsonObject).status, "imported"); await assert.rejects(service.wikiCandidateLocalImport({ ...input, reviewer: " " }), /reviewer/); await assert.rejects(service.wikiCandidateLocalImport({ ...input, relative_path: "other.md" }), /idempotency/); await assert.rejects(service.wikiCandidateLocalImport({ ...input, import_id: "escape", relative_path: "../escape.md" }), /descendant/); await assert.rejects(service.wikiCandidateLocalImport({ ...input, import_id: "not-markdown", relative_path: "note.txt" }), /Markdown/); await writeFile(join(root, "exists.md"), "old"); await assert.rejects(service.wikiCandidateLocalImport({ ...input, import_id: "exists", relative_path: "exists.md" }), /overwrite/); assert.match(String(((await service.wikiCandidateLocalImport({ ...input, import_id: undefined, relative_path: "generated.md" })).import as JsonObject).id), /^wiki_candidate_local_import_/); store.create("wiki_candidate_publication_package", "bad", { status: "prepared", manual_import_required: false, execution_authority: false, content: "x" }); await assert.rejects(service.wikiCandidateLocalImport({ ...input, import_id: "bad", package_id: "bad" }), /manual/); store.create("wiki_candidate_publication_package", "executable", { status: "prepared", manual_import_required: true, execution_authority: true, content: "x" }); await assert.rejects(service.wikiCandidateLocalImport({ ...input, import_id: "executable", package_id: "executable" }), /manual/);
    const mcp = new McpServer(service, "full"); for (const [name, arguments_] of [["craft_wiki_candidate_local_import", { ...input, import_id: "mcp", relative_path: "mcp.md" }], ["craft_wiki_candidate_local_import_get", { import_id: "mcp" }]] as [string, JsonObject][]) assert.equal(((await mcp.handle({ id: name, method: "tools/call", params: { name, arguments: arguments_ } }))?.result as JsonObject).isError, false); assert.equal(VERSION, "0.11.59");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
