import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import type { RepositoryFile } from "./repository-files.ts";
import { pythonFileUnitDigest, type PythonFileUnit } from "./python-incremental.ts";
import { analyzePythonFallback } from "./python-fallback.ts";

const MAX_INPUT_CHARS = 24_000_000;
const MAX_OUTPUT_BYTES = 64_000_000;
const MAX_TIMEOUT_MS = 60_000;
type Execute = (command: string, args: string[], input: string) => string;
export type PythonAnalysisResult = { analysis?: JsonObject; diagnostic?: JsonObject };
export type PythonControlFlowResult = { result?: JsonObject; diagnostic?: JsonObject };
export type PythonDataFlowResult = { result?: JsonObject; diagnostic?: JsonObject };

export function resolvePythonAnalyzerPath(cwd = process.cwd(), fileExists: (path: string) => boolean = existsSync,
  moduleUrl: string | null = import.meta.url): string | undefined {
  const entry = process.argv[1] ?? "";
  const moduleAnalyzer = moduleUrl ? [join(dirname(fileURLToPath(moduleUrl)), "analyzers", "analyze-python.py")] : [];
  const candidates = [...moduleAnalyzer, join(dirname(entry), "..", "..", "scripts", "codebase", "analyze-python.py"),
    join(cwd, "scripts", "codebase", "analyze-python.py"),
    join(cwd, "capability", "craft-codebase", "analyzers", "analyze-python.py")];
  return candidates.find(fileExists);
}

function execute(command: string, args: string[], input: string): string {
  return execFileSync(command, args, { encoding: "utf8", input, timeout: MAX_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true, env: { ...Object.fromEntries(["SystemRoot", "WINDIR", "TMP", "TEMP", "TMPDIR", "PATH"].flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]])) } });
}

export function analyzePythonCheckpoint(files: readonly RepositoryFile[], options: {
  cwd?: string; pythonPath?: string; analyzerPath?: string; execute?: Execute; fileExists?: (path: string) => boolean;
  includePaths?: readonly string[]; includeFileUnits?: boolean;
  cachedFileUnits?: readonly PythonFileUnit[];
} = {}): PythonAnalysisResult {
  if (!files.length) return {};
  const analyzerPath = options.analyzerPath ?? resolvePythonAnalyzerPath(options.cwd, options.fileExists);
  if (!analyzerPath) return { diagnostic: { language: "python", status: "unavailable", reason: "analyzer_not_packaged" } };
  const input = JSON.stringify({ documents: files.map(file => ({ path: file.path, content: file.content, source_digest: file.digest })),
    ...(options.includePaths ? { include_paths: options.includePaths } : {}), ...(options.includeFileUnits ? { include_file_units: true } : {}),
    ...(options.cachedFileUnits ? { cached_file_units: options.cachedFileUnits } : {}) });
  if (Buffer.byteLength(input, "utf8") > MAX_INPUT_CHARS) return { diagnostic: { language: "python", status: "partial", reason: "input_budget_exceeded" } };
  try {
    const output = (options.execute ?? execute)(options.pythonPath ?? "python3", ["-I", analyzerPath, "-"], input);
    if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) return { diagnostic: { language: "python", status: "partial", reason: "output_budget_exceeded" } };
    const analysis = JSON.parse(output) as JsonObject;
    if (analysis.format !== "craft-static-analysis-v1" || !Array.isArray(analysis.nodes) || !Array.isArray(analysis.edges)
      || (analysis.file_units !== undefined && !Array.isArray(analysis.file_units))) {
      return { diagnostic: { language: "python", status: "failed", reason: "invalid_analyzer_response" } };
    }
    if (Array.isArray(analysis.file_units)) analysis.file_units = (analysis.file_units as PythonFileUnit[]).map(unit => ({ ...unit, unit_digest: pythonFileUnitDigest(unit) }));
    return { analysis };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { analysis: analyzePythonFallback(files),
      diagnostic: { language: "python", status: "partial", reason: "python_runtime_unavailable_regex_fallback" } };
    const reason = code === "ETIMEDOUT" ? "analysis_timed_out" : "analysis_failed";
    return { diagnostic: { language: "python", status: "unavailable", reason } };
  }
}

/** Run the bounded Python CFG adapter against one digest-pinned checkpoint file. */
export function analyzePythonControlFlow(file: RepositoryFile, symbol: { readonly id: string; readonly name: string; readonly startOffset: number }, options: {
  cwd?: string; pythonPath?: string; analyzerPath?: string; execute?: Execute; fileExists?: (path: string) => boolean;
} = {}): PythonControlFlowResult {
  const analyzerPath = options.analyzerPath ?? resolvePythonAnalyzerPath(options.cwd, options.fileExists);
  if (!analyzerPath) return { diagnostic: { language: "python", status: "unavailable", reason: "analyzer_not_packaged" } };
  const input = JSON.stringify({ operation: "control_flow_query", documents: [{ path: file.path, content: file.content, source_digest: file.digest }],
    symbol: { id: symbol.id, name: symbol.name, start_offset: symbol.startOffset } });
  if (Buffer.byteLength(input, "utf8") > MAX_INPUT_CHARS) return { diagnostic: { language: "python", status: "partial", reason: "input_budget_exceeded" } };
  try {
    const output = (options.execute ?? execute)(options.pythonPath ?? "python3", ["-I", analyzerPath, "-"], input);
    if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) return { diagnostic: { language: "python", status: "partial", reason: "output_budget_exceeded" } };
    const result = JSON.parse(output) as JsonObject;
    if (result.format !== "craft-python-control-flow-v1" || result.language !== "python"
      || !Array.isArray(result.blocks) || !Array.isArray(result.edges) || !Array.isArray(result.partial_reasons)) {
      return { diagnostic: { language: "python", status: "failed", reason: "invalid_control_flow_response" } };
    }
    return { result };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason = code === "ENOENT" ? "python_runtime_unavailable" : code === "ETIMEDOUT" ? "analysis_timed_out" : "analysis_failed";
    return { diagnostic: { language: "python", status: "unavailable", reason } };
  }
}

/** Run the bounded Python may-reaching definitions adapter against one digest-pinned checkpoint file. */
export function analyzePythonDataFlow(file: RepositoryFile, symbol: { readonly id: string; readonly name: string; readonly startOffset: number }, variable: string, options: {
  cwd?: string; pythonPath?: string; analyzerPath?: string; execute?: Execute; fileExists?: (path: string) => boolean;
} = {}): PythonDataFlowResult {
  const analyzerPath = options.analyzerPath ?? resolvePythonAnalyzerPath(options.cwd, options.fileExists);
  if (!analyzerPath) return { diagnostic: { language: "python", status: "unavailable", reason: "analyzer_not_packaged" } };
  const input = JSON.stringify({ operation: "data_flow_query", documents: [{ path: file.path, content: file.content, source_digest: file.digest }],
    symbol: { id: symbol.id, name: symbol.name, start_offset: symbol.startOffset }, variable });
  if (Buffer.byteLength(input, "utf8") > MAX_INPUT_CHARS) return { diagnostic: { language: "python", status: "partial", reason: "input_budget_exceeded" } };
  try {
    const output = (options.execute ?? execute)(options.pythonPath ?? "python3", ["-I", analyzerPath, "-"], input);
    if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) return { diagnostic: { language: "python", status: "partial", reason: "output_budget_exceeded" } };
    const result = JSON.parse(output) as JsonObject;
    if (result.format !== "craft-python-data-flow-v1" || result.language !== "python"
      || !Array.isArray(result.candidates) || !Array.isArray(result.definitions) || !Array.isArray(result.uses)
      || !Array.isArray(result.flows) || !Array.isArray(result.partial_reasons)) {
      return { diagnostic: { language: "python", status: "failed", reason: "invalid_data_flow_response" } };
    }
    return { result };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason = code === "ENOENT" ? "python_runtime_unavailable" : code === "ETIMEDOUT" ? "analysis_timed_out" : "analysis_failed";
    return { diagnostic: { language: "python", status: "unavailable", reason } };
  }
}
