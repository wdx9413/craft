import type { CraftStore, JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { stableDigest } from "../../common/craft-common-base/src/digest.ts";
import type { RepositoryFile } from "./repository-files.ts";

const ANALYZER_VERSION = "2";

/** Durable per-file symbol cache; relations are deliberately left to semantic analyzers. */
export function basicAnalysis(store: CraftStore, workspaceId: string, files: RepositoryFile[]): JsonObject {
  const nodes: JsonObject[] = []; let analyzed = 0; let reused = 0; let omitted = 0;
  for (const file of files) {
    const cacheId = `codebase_file_${stableDigest({ workspaceId, path: file.path }).slice(-24)}`;
    const cached = store.find("codebase_file_analysis", cacheId);
    if (cached?.source_digest === file.digest && cached.analyzer_version === ANALYZER_VERSION) { nodes.push(...cached.nodes as JsonObject[]); omitted += Number(cached.omitted_symbols); reused++; continue; }
    const node = (kind: string, name: string, start: number, end: number): JsonObject => ({ id: `codebase_node_${stableDigest({ workspaceId, path: file.path, digest: file.digest, kind, name, start }).slice(-24)}`, kind, name, path: file.path, source_digest: file.digest, language: file.language, span: { start_offset: start, end_offset: end } });
    const parsed = [node("file", file.path, 0, 0)];
    const pattern = /\b(?:function|class|interface|type|enum|const|let|var|def|func|struct|fn|trait|module)\s+([\p{L}_$][\p{L}\p{N}_$]*)/gu;
    let fileOmitted = 0;
    for (const match of file.content.matchAll(pattern)) {
      if (parsed.length >= 16 || match[1]!.length > 200) { fileOmitted++; continue; }
      const start = match.index + match[0].lastIndexOf(match[1]!);
      parsed.push(node("symbol", match[1]!, start, start + match[1]!.length));
    }
    omitted += fileOmitted;
    store.save("codebase_file_analysis", cacheId, { workspace_id: workspaceId, path: file.path, analyzer_version: ANALYZER_VERSION, source_digest: file.digest, nodes: parsed, omitted_symbols: fileOmitted });
    nodes.push(...parsed); analyzed++;
  }
  let bytes = 0;
  const bounded = nodes.filter(node => { const size = JSON.stringify(node).length; if (bytes + size > 1_500_000) { omitted++; return false; } bytes += size; return true; });
  return { format: "craft-static-analysis-v1", analyzer: "craft-basic-symbols", analyzer_version: ANALYZER_VERSION, nodes: bounded, edges: [], diagnostics: [{ kind: "basic_analysis", certainty: "partial", relations: "not_analyzed", analyzed_files: analyzed, reused_files: reused, omitted_symbols: omitted }] };
}
