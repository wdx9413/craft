import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { CraftStore, JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { projectStorageDirectory } from "../../common/craft-common-store-local/src/paths.ts";
import { analyzeLspSnapshot, type LspRelationTarget } from "./lsp-stdio-client.ts";
import { configuredLspWorkerEnvironment, languageIdForFile, readTrustedLspConfig } from "./lsp-config.ts";

type SnapshotFile = { readonly path: string; readonly digest: string; readonly content: string; readonly language: string };
type SourceReader = (root: string, entry: JsonObject) => SnapshotFile;

export async function queryCheckpointDiagnostics(input: { store: CraftStore; checkpoint: JsonObject; path: string; limit: number; readSource: SourceReader }): Promise<{ query: JsonObject; payload: JsonObject }> {
  const path = input.path.trim();
  const entries = Array.isArray(input.checkpoint.entries) ? input.checkpoint.entries as JsonObject[] : [];
  const targetEntry = entries.find(entry => entry.path === path);
  if (!targetEntry) throw new Error("Codebase diagnostic path is outside the checkpoint");
  const languageId = languageIdForFile(path);
  if (!languageId) throw new Error("No language-server mapping for diagnostic path");
  const config = readTrustedLspConfig(input.store.paths.configDir);
  const adapter = config.adapters.find(candidate => candidate.language === languageId);
  if (!adapter) throw new Error("No explicitly trusted language-server adapter is configured for this file");
  const languageGroup = new Set(["typescript", "typescriptreact", "javascript", "javascriptreact"]);
  const compatibleLanguages = languageGroup.has(languageId) ? languageGroup : new Set([languageId]);
  const candidates = entries.filter(entry => compatibleLanguages.has(languageIdForFile(String(entry.path)) ?? ""));
  const selectedEntries = [targetEntry, ...candidates.filter(entry => entry.path !== path).sort((left, right) => String(left.path).localeCompare(String(right.path)))].slice(0, adapter.max_documents);
  const omittedDocuments = Math.max(0, candidates.length - selectedEntries.length);
  const snapshotFiles = selectedEntries.map(entry => input.readSource(String(input.checkpoint.snapshot_root), entry));
  const root = mkdtempSync(join(tmpdir(), "craft-codebase-diagnostics-"));
  try {
    for (const file of snapshotFiles) {
      const target = resolve(root, file.path), pathFromRoot = relative(root, target);
      if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`)) throw new Error("Codebase diagnostic snapshot path is unsafe");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content, { flag: "wx" });
    }
    const result = await analyzeLspSnapshot({ command: adapter.command, args: adapter.args, cwd: root,
      analyzer: `lsp-${adapter.language}`, analyzer_version: adapter.analyzer_version, diagnostics_only: true,
      request_timeout_ms: adapter.request_timeout_ms,
      documents: snapshotFiles.map(file => ({ path: file.path, language: languageIdForFile(file.path)!, content: file.content, source_digest: file.digest })) });
    const currentConfig = readTrustedLspConfig(input.store.paths.configDir);
    if (currentConfig.digest !== config.digest) throw new Error("Trusted language-server configuration changed during diagnostics query");
    const allItems = result.language_diagnostics as JsonObject[];
    const targetItems = allItems.filter(item => item.path === path);
    const diagnostics = targetItems.slice(0, input.limit);
    const serverDiagnostics = result.diagnostics as JsonObject;
    const omittedCount = Number(serverDiagnostics.omitted_count) + omittedDocuments + Math.max(0, targetItems.length - diagnostics.length);
    const status = serverDiagnostics.status === "complete" && omittedCount === 0 ? "complete" : "partial";
    const query: JsonObject = { path, source_digest: String(targetEntry.digest), adapter_config_digest: config.digest,
      diagnostic_status: status, diagnostic_count: diagnostics.length, omitted_count: omittedCount, limit: input.limit };
    return { query, payload: { path, source_digest: String(targetEntry.digest), diagnostic_status: status,
      diagnostics, diagnostic_count: diagnostics.length, omitted_count: omittedCount, content_included: false, source_snapshot_only: true } };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

export async function queryCheckpointCallers(input: { store: CraftStore; checkpoint: JsonObject; project_root: string; target: JsonObject; limit: number; readSource: SourceReader }): Promise<{ query: JsonObject; payload: JsonObject }> {
  const path = typeof input.target.path === "string" ? input.target.path : "";
  const entries = Array.isArray(input.checkpoint.entries) ? input.checkpoint.entries as JsonObject[] : [];
  const targetEntry = entries.find(entry => entry.path === path);
  if (!targetEntry) throw new Error("Codebase caller path is outside the checkpoint");
  if (targetEntry.digest !== input.target.source_digest) throw new Error("Codebase caller target source digest does not match the checkpoint");
  const languageId = languageIdForFile(path);
  if (!languageId) throw new Error("No language-server mapping for caller path");
  const config = readTrustedLspConfig(input.store.paths.configDir);
  const adapter = config.adapters.find(candidate => candidate.language === languageId);
  if (!adapter) throw new Error("No explicitly trusted language-server adapter is configured for this file");
  const startOffset = Number((input.target.span as JsonObject | undefined)?.start_offset);
  const name = typeof input.target.name === "string" ? input.target.name : "";
  if (!name || !Number.isSafeInteger(startOffset) || startOffset < 0) throw new Error("Codebase caller target is invalid");
  const relationTarget: LspRelationTarget = { path, name, start_offset: startOffset };
  const candidates = entries.filter(entry => languageIdForFile(String(entry.path)) === languageId);
  const selectedEntries = [targetEntry, ...candidates.filter(entry => entry.path !== path).sort((left, right) => String(left.path).localeCompare(String(right.path)))].slice(0, adapter.max_documents);
  const omittedDocuments = Math.max(0, candidates.length - selectedEntries.length);
  const snapshotFiles = selectedEntries.map(entry => input.readSource(String(input.checkpoint.snapshot_root), entry));
  const root = mkdtempSync(join(tmpdir(), "craft-codebase-callers-"));
  try {
    for (const file of snapshotFiles) {
      const target = resolve(root, file.path), pathFromRoot = relative(root, target);
      if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`)) throw new Error("Codebase caller snapshot path is unsafe");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content, { flag: "wx" });
    }
    const result = await analyzeLspSnapshot({ command: adapter.command, args: adapter.args, cwd: root,
      analyzer: `lsp-${adapter.language}`, analyzer_version: adapter.analyzer_version, relations: ["calls"], relation_symbol_limit: 1,
      relation_targets: [relationTarget], request_timeout_ms: adapter.request_timeout_ms,
      documents: snapshotFiles.map(file => ({ path: file.path, language: languageIdForFile(file.path)!, content: file.content, source_digest: file.digest })) },
    adapter.request_timeout_ms, configuredLspWorkerEnvironment(adapter.language, join(projectStorageDirectory(input.store.paths, input.project_root), "codebase")));
    const currentConfig = readTrustedLspConfig(input.store.paths.configDir);
    if (currentConfig.digest !== config.digest) throw new Error("Trusted language-server configuration changed during callers query");
    const analysis = result.diagnostics as JsonObject;
    const nodes = result.nodes as JsonObject[];
    const targetNode = nodes.find(node => node.path === path && node.name === name && Number((node.span as JsonObject).start_offset) === startOffset);
    const nodeById = new Map(nodes.map(node => [String(node.id), node]));
    const edges = (result.edges as JsonObject[]).filter(edge => edge.kind === "calls" && edge.to_node_id === targetNode?.id);
    const callers = edges.map(edge => ({ caller: nodeById.get(String(edge.from_node_id))!, edge })).slice(0, input.limit);
    const missingTarget = targetNode === undefined;
    const targetCallable = targetNode !== undefined && [6, 9, 12].includes(Number(targetNode.symbol_kind));
    const omittedCount = omittedDocuments + Number(analysis.relation_omitted_count) + Math.max(0, edges.length - callers.length);
    const status = !missingTarget && !targetCallable ? "unsupported"
      : analysis.relations === "analyzed" && !missingTarget && omittedCount === 0 ? "analyzed" : "partial";
    const query: JsonObject = { path, name, start_offset: startOffset, source_digest: String(targetEntry.digest),
      checkpoint_id: String(input.checkpoint.id), adapter_config_digest: config.digest, analyzer: `lsp-${adapter.language}`,
      analyzer_version: adapter.analyzer_version, relation_status: status, relation_query_failures: Number(analysis.relation_query_failures),
      target_callable: targetCallable, caller_count: callers.length, omitted_count: omittedCount, limit: input.limit };
    return { query, payload: { path, name, source_digest: String(targetEntry.digest), relation_status: status,
      callers: callers.map(({ caller, edge }) => ({ symbol_id: caller.id, path: caller.path, name: caller.name,
        source_digest: caller.source_digest, span: caller.span, source_span: edge.source_span })),
      target_callable: targetCallable, relation_query_failures: Number(analysis.relation_query_failures), caller_count: callers.length,
      omitted_count: omittedCount, content_included: false, source_snapshot_only: true } };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
