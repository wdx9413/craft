import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { CraftStore, JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { analyzeLspSnapshot } from "./lsp-stdio-client.ts";
import { languageIdForFile, readTrustedLspConfig } from "./lsp-config.ts";

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
