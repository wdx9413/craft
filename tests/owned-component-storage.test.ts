import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { backupStorage, restoreStorage } from "../core/storage-backup.ts";
import { initializeOwnedCatalog } from "../core/infrastructure/owned-catalog.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { sessionStorageScopeId, craftPaths } from "../core/infrastructure/paths.ts";
import { serveMcpHttp } from "../core/interfaces/mcp-http.ts";
import { openMcpRuntime } from "../core/interfaces/mcp/runtime.ts";
import { mcpStorageLaunch } from "../core/interfaces/mcp/owned-storage.ts";

const databaseExists = (path: string) => lstatSync(path, { throwIfNoEntry: false })?.isFile() === true;

type Owner = "knowledge" | "memory" | "experience" | "codebase" | "notes" | "eval" | "context";
type Call = readonly [string, Record<string, unknown>];

function ownedMcp<T>(owner: Owner, root: string, calls: readonly Call[]): T[] {
  const input = calls.map(([name, args], index) => JSON.stringify({
    jsonrpc: "2.0", id: index + 1, method: "tools/call", params: { name, arguments: args },
  })).join("\n") + "\n";
  const execution = spawnSync(process.execPath, ["--experimental-strip-types",
    fileURLToPath(new URL("../bin/craft-mcp.ts", import.meta.url)), "--product", owner], {
    input, encoding: "utf8", timeout: 20_000,
    env: { ...process.env, CRAFT_DATA_DIR: root, CRAFT_STORAGE_OWNER: owner, CRAFT_CONTINUOUS_LEARNING: "0" },
  });
  assert.equal(execution.error, undefined);
  assert.equal(execution.status, 0, execution.stderr);
  return execution.stdout.trim().split("\n").map(line => {
    const reply = JSON.parse(line);
    assert.equal(reply.error, undefined, line);
    assert.equal(reply.result.isError, false, line);
    return reply.result.structuredContent;
  });
}

type KnowledgeReply = { id?: string; claim?: { version: number; status: string; content: string; content_ref: { path: string } } };

test("the Knowledge MCP publishes, reads, retires and restores Claim revisions without craft.db", async () => {
  const directory = mkdtempSync(join(tmpdir(), "craft-owner-knowledge-"));
  const root = join(directory, "knowledge-space");
  try {
    const claimId = "sample-convention";
    const content = "Run the fixture test before accepting the sample change.";
    const [, evidence, saved, read, expired] = ownedMcp<KnowledgeReply>("knowledge", root, [
      ["craft_knowledge_bootstrap_install", {}],
      ["craft_evidence_record", { evidence_id: "fixture-evidence", source_type: "program", claim: "Fixture test completed.",
        metadata: { capability_owner: "knowledge", scope: "global" } }],
      ["craft_knowledge_claim_save", { claim_id: claimId, kind: "rule", content, evidence_ids: ["fixture-evidence"], scope: "global" }],
      ["craft_knowledge_claim_get", { claim_id: claimId, scope_kind: "global", scope_id: "global" }],
      ["craft_knowledge_claim_review", { claim_id: claimId, expected_version: 1, status: "expired", reviewer: "fixture",
        reason: "This convention has expired." }],
    ]);
    assert.equal(evidence?.id, "fixture-evidence");
    assert.equal(saved?.claim?.version, 1);
    assert.equal(read?.claim?.content, content);
    assert.equal(expired?.claim?.version, 2);
    assert.equal(expired?.claim?.status, "expired");
    const paths = craftPaths(root);
    assert.equal(databaseExists(paths.databaseFile), false);
    assert.equal(databaseExists(paths.legacyDatabaseFile), false);
    assert.equal(existsSync(join(paths.knowledgeDir, "publication.db")), true);
    await assert.rejects(new CraftStore(paths).open(), /owned by a standalone product/u);
    assert(read?.claim?.content_ref.path);
    assert.equal(existsSync(read.claim.content_ref.path), true);

    const backup = join(directory, "closed-snapshot");
    const restored = join(directory, "staged-restore");
    const manifest = await backupStorage(root, backup);
    assert(manifest.entries.some(item => item.path === "knowledge/publication.db"));
    assert(manifest.entries.some(item => item.path === "knowledge/.craft-storage-owner"));
    assert(!manifest.entries.some(item => item.path === "db/craft.db"));
    await restoreStorage(backup, restored);
    renameSync(root, join(directory, "displaced-original"));
    renameSync(restored, root);
    const [latest, first] = ownedMcp<KnowledgeReply>("knowledge", root, [
      ["craft_knowledge_claim_get", { claim_id: claimId, scope_kind: "global", scope_id: "global" }],
      ["craft_knowledge_claim_get", { claim_id: claimId, version: 1, scope_kind: "global", scope_id: "global" }],
    ]);
    assert.equal(latest?.claim?.status, "expired");
    assert.equal(first?.claim?.version, 1);
    assert.equal(first?.claim?.content, content);
    assert.equal(databaseExists(paths.databaseFile), false);
    renameSync(join(paths.knowledgeDir, "publication.db"), join(directory, "held-catalog.db"));
    assert.throws(() => mcpStorageLaunch(paths, "component-knowledge-daily", "knowledge"), /restore its verified backup/u);
    await assert.rejects(new CraftStore(paths).open(), /owned by a standalone product/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an owned catalog keeps existing shared data spaces and mismatched products out", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-owner-guard-"));
  const mode = "component-knowledge-daily", paths = craftPaths(root);
  try {
    assert.equal(mcpStorageLaunch(paths, mode, undefined).paths, paths);
    assert.throws(() => mcpStorageLaunch(paths, "syscall", "knowledge"), /matching standalone/u);
    assert.throws(() => mcpStorageLaunch(paths, mode, "memory"), /matching standalone/u);
    mkdirSync(paths.databaseDir);
    writeFileSync(paths.databaseFile, "", { mode: 0o400 });
    assert.throws(() => mcpStorageLaunch(paths, mode, "knowledge"), /verified migration/u);
    rmSync(paths.databaseFile);
    rmdirSync(paths.databaseDir);
    writeFileSync(paths.legacyDatabaseFile, "");
    assert.throws(() => mcpStorageLaunch(paths, mode, "knowledge"), /verified migration/u);
    rmSync(paths.legacyDatabaseFile);

    assert.equal(mcpStorageLaunch(paths, mode, "knowledge").paths.databaseDir, paths.knowledgeDir);
    assert.throws(() => mcpStorageLaunch(paths, "component-knowledge-owned", undefined), /requires an owned data space/u);
    const reserved = join(root, "reserved");
    initializeOwnedCatalog(reserved, "knowledge");
    assert.doesNotThrow(() => initializeOwnedCatalog(reserved, "knowledge"));
    assert.throws(() => mcpStorageLaunch(craftPaths(reserved), mode, "knowledge"), /restore its verified backup/u);
    const target = join(root, "foreign");
    mkdirSync(target);
    assert.throws(() => mcpStorageLaunch(paths, mode, "knowledge"), /new, empty data space/u);
    const linkedRoot = join(root, "linked-root");
    symlinkSync(target, linkedRoot);
    assert.throws(() => mcpStorageLaunch(craftPaths(linkedRoot), mode, "knowledge"), /regular directory/u);
    symlinkSync(target, paths.knowledgeDir);
    assert.throws(() => mcpStorageLaunch(paths, mode, "knowledge"), /regular directory/u);
    unlinkSync(paths.knowledgeDir);
    mkdirSync(paths.knowledgeDir);
    const catalog = join(paths.knowledgeDir, "publication.db");
    writeFileSync(catalog, "");
    assert.throws(() => mcpStorageLaunch(paths, mode, "knowledge"), /no storage owner marker/u);
    rmSync(catalog);
    mkdirSync(catalog);
    assert.throws(() => mcpStorageLaunch(paths, mode, "knowledge"), /regular directory/u);
    assert.throws(() => mcpStorageLaunch(paths, mode, undefined), /requires an owned data space/u);
    writeFileSync(join(root, ".craft-storage-owner"), "unknown version");
    assert.throws(() => mcpStorageLaunch(paths, mode, undefined), /owner marker is invalid/u);
    writeFileSync(join(root, ".craft-storage-owner"), "x".repeat(65));
    assert.throws(() => mcpStorageLaunch(paths, mode, undefined), /owner marker is invalid/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Memory, Experience and Codebase run their local operations in separate catalogs", () => {
  const directory = mkdtempSync(join(tmpdir(), "craft-owned-products-"));
  const memoryRoot = join(directory, "memory-data"), experienceRoot = join(directory, "experience-data");
  const codebaseRoot = join(directory, "codebase-data"), repository = join(directory, "repository");
  try {
    const [captured, recalled] = ownedMcp<{ memory?: { id: string; content: string }; auto_committed?: boolean }>("memory", memoryRoot, [
      ["craft_memory_capture_user_statement", { memory_id: "local-preference", session_id: "unit-session", session_host: "codex",
        kind: "preference", topic: "formatting", content: "I prefer short headings in engineering notes." }],
      ["craft_memory_ledger_get", { memory_id: "local-preference", scope_kind: "session", scope_id: "unit-session", session_host: "codex" }],
    ]);
    assert.equal(captured?.auto_committed, true);
    assert.equal(recalled?.memory?.content, "I prefer short headings in engineering notes.");

    const [, observed, listed] = ownedMcp<{ observation?: { id: string }; observations?: Array<{ id: string }> }>("experience", experienceRoot, [
      ["craft_evidence_record", { evidence_id: "fixture", source_type: "program", confidence: "bounded", claim: "Local verification ran." }],
      ["craft_experience_observe", { observation_id: "fixture-observation", scenario_key: "unit-verification", source_kind: "program",
        source_id: "fixture-task", source_digest: "fixture-digest", outcome: "passed", scope: "global", evidence_ids: ["fixture"], sanitized: true }],
      ["craft_experience_patterns_list", { scenario_key: "unit-verification" }],
    ]);
    assert.equal(observed?.observation?.id, "fixture-observation");
    assert.deepEqual(listed?.observations?.map(item => item.id), ["fixture-observation"]);

    mkdirSync(repository);
    execFileSync("git", ["init", "-q", repository]);
    writeFileSync(join(repository, "project.ts"), "export function ownedStorageFixture(): number { return 1; }\n");
    execFileSync("git", ["-C", repository, "add", "--", "project.ts"]);
    const [indexed] = ownedMcp<{ status: string }>("codebase", codebaseRoot, [
      ["craft_codebase_repository_ensure", { project_root: repository }],
    ]);
    assert.equal(indexed?.status, "ready");
    for (const [owner, root] of [["memory", memoryRoot], ["experience", experienceRoot], ["codebase", codebaseRoot]] as const) {
      assert.equal(databaseExists(craftPaths(root).databaseFile), false);
      assert.equal(existsSync(join(root, owner, "publication.db")), true);
    }

  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Notes, Eval and Context can write their own records with only their independent MCP", () => {
  const directory = mkdtempSync(join(tmpdir(), "craft-owned-auxiliary-"));
  const notesRoot = join(directory, "notes-data"), evalRoot = join(directory, "eval-data");
  const contextRoot = join(directory, "context-data"), project = join(directory, "project");
  try {
    mkdirSync(project);
    const [, observed] = ownedMcp<{ note?: { id: string; version: number } }>("notes", notesRoot, [
      ["craft_notes_create_device", { id: "local", note: "A fixture device." }],
      ["craft_notes_observe_directory", { device_id: "local", path: project, note: "Directory for local fixtures.", pin: true }],
    ]);
    const note = observed?.note;
    assert(note);
    const [confirmed, resolved, revoked, duringRevocation] = ownedMcp<{ status?: string; items?: Array<{ id: string }> }>("notes", notesRoot, [
      ["craft_notes_confirm", { id: note.id, expected_version: note.version }],
      ["craft_notes_resolve", { device_id: "local", path: project }],
      ["craft_notes_revoke", { id: note.id, expected_version: note.version + 1, revoked_by: "fixture", reason: "Retired." }],
      ["craft_notes_resolve", { device_id: "local", path: project }],
    ]);
    assert.equal(confirmed?.status, "confirmed");
    assert(resolved?.items?.some(item => item.id === note.id));
    assert.equal(revoked?.status, "revoked");
    assert(!duringRevocation?.items?.some(item => item.id === note.id));

    const [defined, loaded] = ownedMcp<{ id?: string; contract?: { id: string; contract_digest: string } }>("eval", evalRoot, [
      ["craft_evaluation_contract_define", { contract_id: "fixture-contract", capability_id: "fixture", capability_version: 1,
        input_contract: "fixture input", output_contract: "fixture output" }],
      ["craft_evaluation_contract_get", { contract_id: "fixture-contract" }],
    ]);
    assert.equal(defined?.contract?.id, "fixture-contract");
    assert.equal(loaded?.contract?.contract_digest, defined?.contract?.contract_digest);

    const [resolvedContext] = ownedMcp<{ receipt?: { id: string; content_stored?: boolean } }>("context", contextRoot, [
      ["craft_context_resolution_resolve", { query: "Bounded fixture request.", scope_kind: "global", scope_id: "global" }],
    ]);
    const receipt = resolvedContext?.receipt;
    assert(receipt?.id);
    const [readContext] = ownedMcp<{ receipt?: { id: string } }>("context", contextRoot, [
      ["craft_context_resolution_get", { receipt_id: receipt.id }],
    ]);
    assert.equal(readContext?.receipt?.id, receipt.id);

    for (const [owner, root] of [["notes", notesRoot], ["eval", evalRoot], ["context", contextRoot]] as const) {
      assert.equal(databaseExists(craftPaths(root).databaseFile), false);
      assert.equal(existsSync(join(root, owner, "publication.db")), true);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the MCP runtime can reopen a catalog after a startup configuration error", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-owned-startup-"));
  try {
    const env = { CRAFT_DATA_DIR: root, CRAFT_STORAGE_OWNER: "knowledge" };
    const mode = "component-knowledge-daily";
    const first = await openMcpRuntime(mode, env);
    first.close();
    const paths = craftPaths(root);
    writeFileSync(paths.configFile, "{");
    await assert.rejects(openMcpRuntime(mode, env), SyntaxError);
    rmSync(paths.configFile);
    const restarted = await openMcpRuntime(mode, env);
    restarted.close();
    assert(!databaseExists(paths.databaseFile));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the local HTTP transport opens the same owned catalog as stdio", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-owned-http-"));
  const previous = { root: process.env.CRAFT_DATA_DIR, owner: process.env.CRAFT_STORAGE_OWNER };
  process.env.CRAFT_DATA_DIR = root;
  process.env.CRAFT_STORAGE_OWNER = "eval";
  let runtime: Awaited<ReturnType<typeof serveMcpHttp>> | undefined;
  try {
    runtime = await serveMcpHttp({ mode: "component-eval-owned", port: 0 });
    const address = runtime.server.address();
    assert(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { result: { tools: Array<{ name: string }> } };
    assert(body.result.tools.some(tool => tool.name === "craft_evaluation_contract_define"));
    assert(!body.result.tools.some(tool => tool.name === "craft_task_open"));
    assert.equal(existsSync(join(root, "eval", "publication.db")), true);
    assert.equal(databaseExists(craftPaths(root).databaseFile), false);
  } finally {
    runtime?.close();
    if (previous.root === undefined) delete process.env.CRAFT_DATA_DIR; else process.env.CRAFT_DATA_DIR = previous.root;
    if (previous.owner === undefined) delete process.env.CRAFT_STORAGE_OWNER; else process.env.CRAFT_STORAGE_OWNER = previous.owner;
    rmSync(root, { recursive: true, force: true });
  }
});

test("different capability owners share a data space without sharing publication commits", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-multiple-owners-"));
  const env = { CRAFT_DATA_DIR: root };
  try {
    const knowledge = await openMcpRuntime("component-knowledge-daily", { ...env, CRAFT_STORAGE_OWNER: "knowledge" });
    knowledge.close();
    const memory = await openMcpRuntime("component-memory-daily", { ...env, CRAFT_STORAGE_OWNER: "memory" });
    memory.close();
    const reopened = await openMcpRuntime("component-knowledge-daily", { ...env, CRAFT_STORAGE_OWNER: "knowledge" });
    reopened.close();
    assert(existsSync(join(root, "knowledge", "publication.db")));
    assert(existsSync(join(root, "memory", "publication.db")));
    assert(!databaseExists(craftPaths(root).databaseFile));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Context recalls an independently written Memory through its owner and rejects a revoked reference", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-owner-recall-"));
  const environment = { CRAFT_DATA_DIR: root };
  const memory = await openMcpRuntime("component-memory-daily", { ...environment, CRAFT_STORAGE_OWNER: "memory" });
  let context: Awaited<ReturnType<typeof openMcpRuntime>> | undefined;
  const call = async (server: typeof memory.server, name: string, args: Record<string, unknown>) => {
    const response = await server.handle({ jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: args } });
    assert(response);
    assert.equal(response.error, undefined, JSON.stringify(response));
    const result = response.result as { isError: boolean; structuredContent: Record<string, unknown> };
    assert.equal(result.isError, false, JSON.stringify(result));
    return result.structuredContent;
  };
  try {
    await call(memory.server, "craft_memory_capture_user_statement", {
      memory_id: "separate-memory", content: "I prefer short fixture explanations.", session_id: "owner-recall-session",
      session_host: "codex", kind: "preference", topic: "explanation-length",
    });
    context = await openMcpRuntime("component-context-agent", { ...environment, CRAFT_STORAGE_OWNER: "context" });
    const args = { query: "short fixture explanations", scope_kind: "session", scope_id: "owner-recall-session",
      session_scope_id: "owner-recall-session", session_host: "codex", members: ["memory"] };
    const resolved = await call(context.server, "craft_context_resolution_resolve", args);
    assert.match(JSON.stringify(resolved), /separate-memory/u);
    await call(memory.server, "craft_memory_ledger_transition", {
      memory_id: "separate-memory", expected_version: 1, status: "revoked", reason: "No longer preferred.",
    });
    const after = await call(context.server, "craft_context_resolution_resolve", args);
    assert(!JSON.stringify(after).includes('"memory_id":"separate-memory"'));
    assert(!databaseExists(craftPaths(root).databaseFile));
  } finally {
    context?.close();
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Memory owner resolves exact portable references and reports stale or foreign references", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-owner-reference-"));
  const runtime = await openMcpRuntime("component-memory-daily", { CRAFT_DATA_DIR: root, CRAFT_STORAGE_OWNER: "memory" });
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await runtime.server.handle({ jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: args } });
    const result = response?.result as { isError: boolean; structuredContent: Record<string, unknown> };
    assert.equal(result.isError, false, JSON.stringify(response));
    return result.structuredContent;
  };
  try {
    await call("craft_memory_capture_user_statement", { memory_id: "portable-memory", content: "Prefer brief fixture output.",
      session_id: "portable-session", session_host: "codex", kind: "preference", topic: "output" });
    const args = { asset_id: "portable-memory", scope_kind: "session", scope_id: sessionStorageScopeId("codex", "portable-session") };
    const created = await call("craft_memory_asset_inspect", { ...args, action: "reference", version: 1 });
    const reference = created.reference as Record<string, unknown>;
    assert.equal(reference.owner, "memory");
    assert(!JSON.stringify(reference).includes(root));
    const resolve = (ref = reference) => call("craft_memory_asset_inspect", { ...args, action: "resolve", reference: ref });
    assert.equal((await resolve()).status, "resolved");
    assert.equal((await resolve({ ...reference, owner: "knowledge" })).status, "denied");
    assert.equal((await resolve({ ...reference, scope: { kind: "session", id: "foreign" } })).status, "denied");
    assert.equal((await resolve({ ...reference, id: "missing" })).status, "missing");
    assert.equal((await resolve({ ...reference, version: 999 })).status, "version_mismatch");
    assert.equal((await resolve({ ...reference, digest: "tampered" })).status, "digest_mismatch");
    await call("craft_memory_ledger_transition", { memory_id: "portable-memory", expected_version: 1, status: "revoked", reason: "Retire preference." });
    assert.equal((await resolve()).status, "revoked");
  } finally { runtime.close(); rmSync(root, { recursive: true, force: true }); }
});
