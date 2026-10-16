import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { JAVA_ANALYZER_VERSION, javaFileUnitDigest, type JavaFileUnit } from "./java-incremental.ts";
import type { RepositoryFile } from "./repository-files.ts";

const MAX_INPUT_BYTES = 24_000_000;
const MAX_OUTPUT_BYTES = 64_000_000;
const MAX_TIMEOUT_MS = 60_000;
type Execute = (command: string, args: string[], input: string) => string;
export type JavaAnalysisResult = { analysis?: JsonObject; diagnostic?: JsonObject };
export type JavaControlFlowResult = { result?: JsonObject; diagnostic?: JsonObject };

export function resolveJavaAnalyzerPath(cwd = process.cwd(), fileExists: (path: string) => boolean = existsSync,
  moduleUrl: string | null = import.meta.url): string | undefined {
  const entry = process.argv[1] ?? "";
  const moduleAnalyzer = moduleUrl ? [join(dirname(fileURLToPath(moduleUrl)), "analyzers", "AnalyzeJava.java")] : [];
  const candidates = [...moduleAnalyzer, join(dirname(entry), "..", "..", "scripts", "codebase", "analyzers", "AnalyzeJava.java"),
    join(cwd, "scripts", "codebase", "analyzers", "AnalyzeJava.java"),
    join(cwd, "capability", "craft-codebase", "analyzers", "AnalyzeJava.java")];
  return candidates.find(fileExists);
}

export function resolveJavaControlFlowAnalyzerPath(cwd = process.cwd(), fileExists: (path: string) => boolean = existsSync,
  moduleUrl: string | null = import.meta.url): string | undefined {
  const entry = process.argv[1] ?? "";
  const moduleAnalyzer = moduleUrl ? [join(dirname(fileURLToPath(moduleUrl)), "analyzers", "AnalyzeJavaControlFlow.java")] : [];
  const candidates = [...moduleAnalyzer, join(dirname(entry), "..", "..", "scripts", "codebase", "analyzers", "AnalyzeJavaControlFlow.java"),
    join(cwd, "scripts", "codebase", "analyzers", "AnalyzeJavaControlFlow.java"),
    join(cwd, "capability", "craft-codebase", "analyzers", "AnalyzeJavaControlFlow.java")];
  return candidates.find(fileExists);
}

function execute(command: string, args: string[], input: string): string {
  return execFileSync(command, args, { encoding: "utf8", input, timeout: MAX_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true, env: { ...Object.fromEntries(["SystemRoot", "WINDIR", "TMP", "TEMP", "TMPDIR", "PATH", "JAVA_HOME"].flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]])) } });
}

function safeRelativeJavaPath(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && !path.includes("\\") && path.split("/").every(part => part !== ".." && part !== "")
    && path.toLowerCase().endsWith(".java");
}

export function analyzeJavaCheckpoint(files: readonly RepositoryFile[], options: {
  cwd?: string; javaPath?: string; javacPath?: string; analyzerPath?: string; execute?: Execute;
  fileExists?: (path: string) => boolean; tempDirectory?: string; toolsJarPath?: string | null; includePaths?: readonly string[];
} = {}): JavaAnalysisResult {
  if (!files.length) return {};
  if (files.some(file => !safeRelativeJavaPath(file.path))) return { diagnostic: { language: "java", status: "failed", reason: "unsafe_java_path" } };
  const totalBytes = files.reduce((total, file) => total + Buffer.byteLength(file.content, "utf8"), 0);
  if (totalBytes > MAX_INPUT_BYTES) return { diagnostic: { language: "java", status: "partial", reason: "input_budget_exceeded" } };
  const analyzerPath = options.analyzerPath ?? resolveJavaAnalyzerPath(options.cwd, options.fileExists);
  if (!analyzerPath) return { diagnostic: { language: "java", status: "unavailable", reason: "analyzer_not_packaged" } };
  const executeCommand = options.execute ?? execute;
  const temporaryRoot = mkdtempSync(join(options.tempDirectory ?? tmpdir(), "craft-java-analysis-"));
  const sourceRoot = join(temporaryRoot, "snapshot");
  const classesRoot = join(temporaryRoot, "classes");
  const result = (() => {
    try {
    for (const file of files) {
      const digest = createHash("sha256").update(file.content, "utf8").digest("hex");
      if (digest !== file.digest) return { diagnostic: { language: "java", status: "failed", reason: "snapshot_digest_mismatch" } };
      const path = join(sourceRoot, ...file.path.split("/"));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.content, { encoding: "utf8", flag: "wx" });
    }
    mkdirSync(classesRoot);
    const toolsJar = options.toolsJarPath === null ? undefined : options.toolsJarPath ?? (process.env.JAVA_HOME
      ? join(process.env.JAVA_HOME, "lib", "tools.jar") : undefined);
    const compilerClasspath = toolsJar && existsSync(toolsJar) ? toolsJar : undefined;
    executeCommand(options.javacPath ?? "javac", ["-proc:none", "-encoding", "UTF-8", ...(compilerClasspath ? ["-classpath", compilerClasspath] : []),
      "-d", classesRoot, analyzerPath], "");
    const runtimeClasspath = [classesRoot, ...(compilerClasspath ? [compilerClasspath] : [])].join(delimiter);
    const request = options.includePaths === undefined ? "*" : Buffer.from(options.includePaths.join(String.fromCharCode(0)), "utf8").toString("base64url");
    const output = executeCommand(options.javaPath ?? "java", ["-cp", runtimeClasspath, "craft.codebase.AnalyzeJava", sourceRoot], request + "\n");
    if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) return { diagnostic: { language: "java", status: "partial", reason: "output_budget_exceeded" } };
    const analysis = JSON.parse(output) as JsonObject;
    if (analysis.format !== "craft-static-analysis-v1" || analysis.analyzer !== "jdk-compiler-tree" || analysis.analyzer_version !== JAVA_ANALYZER_VERSION
      || !Array.isArray(analysis.file_units) || !analysis.diagnostics || typeof analysis.diagnostics !== "object")
      return { diagnostic: { language: "java", status: "failed", reason: "invalid_analyzer_response" } };
    if ((analysis.diagnostics as JsonObject).status === "failed") return { diagnostic: { language: "java", status: "unavailable", reason: "java_analysis_failed" } };
    const filesByPath = new Map(files.map(file => [file.path, file]));
    const fileUnits: JavaFileUnit[] = [];
    for (const raw of analysis.file_units as JsonObject[]) {
      if (typeof raw.path !== "string" || !filesByPath.has(raw.path) || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)
        || raw.source_digest !== filesByPath.get(raw.path)!.digest || typeof raw.package_name !== "string"
        || !Number.isInteger(raw.unresolved_calls) || !Number.isInteger(raw.unresolved_imports)
        || typeof raw.incremental_safe !== "boolean" || raw.budget_limited !== false) {
        return { diagnostic: { language: "java", status: "failed", reason: "invalid_java_file_unit" } };
      }
      const unit = { ...raw, analyzer: "jdk-compiler-tree", analyzer_version: JAVA_ANALYZER_VERSION } as unknown as Omit<JavaFileUnit, "unit_digest">;
      fileUnits.push({ ...unit, unit_digest: javaFileUnitDigest(unit as JavaFileUnit) } as JavaFileUnit);
    }
    const nodes = fileUnits.flatMap(unit => unit.nodes), edges = fileUnits.flatMap(unit => unit.edges);
    return { analysis: { ...analysis, nodes, edges, file_units: fileUnits } };
    } catch (error) {
      let code: string | undefined;
      try { code = (error as NodeJS.ErrnoException).code; } catch { /* A malformed thrown value cannot skip snapshot cleanup. */ }
      const reason = code === "ENOENT" ? "jdk_unavailable" : code === "ETIMEDOUT" ? "analysis_timed_out" : "analysis_failed";
      return { diagnostic: { language: "java", status: "unavailable", reason } };
    }
  })();
  rmSync(temporaryRoot, { recursive: true, force: true });
  return result;
}

/** Build a bounded Java CFG from one digest-verified checkpoint file and indexed declaration span. */
export function analyzeJavaControlFlow(file: RepositoryFile, symbol: { readonly id: string; readonly name: string; readonly startOffset: number }, options: {
  cwd?: string; javaPath?: string; javacPath?: string; analyzerPath?: string; execute?: Execute; fileExists?: (path: string) => boolean;
  tempDirectory?: string;
} = {}): JavaControlFlowResult {
  if (!safeRelativeJavaPath(file.path)) return { diagnostic: { language: "java", status: "failed", reason: "unsafe_java_path" } };
  if (!Number.isSafeInteger(symbol.startOffset) || symbol.startOffset < 0) return { diagnostic: { language: "java", status: "failed", reason: "invalid_symbol_offset" } };
  if (Buffer.byteLength(file.content, "utf8") > MAX_INPUT_BYTES) return { diagnostic: { language: "java", status: "partial", reason: "input_budget_exceeded" } };
  if (createHash("sha256").update(file.content, "utf8").digest("hex") !== file.digest)
    return { diagnostic: { language: "java", status: "failed", reason: "snapshot_digest_mismatch" } };
  const analyzerPath = options.analyzerPath ?? resolveJavaControlFlowAnalyzerPath(options.cwd, options.fileExists);
  if (!analyzerPath) return { diagnostic: { language: "java", status: "unavailable", reason: "analyzer_not_packaged" } };
  const executeCommand = options.execute ?? execute;
  const temporaryRoot = mkdtempSync(join(options.tempDirectory ?? tmpdir(), "craft-java-control-flow-"));
  const sourceRoot = join(temporaryRoot, "snapshot"), classesRoot = join(temporaryRoot, "classes");
  let result: JavaControlFlowResult;
  try {
    const sourcePath = join(sourceRoot, ...file.path.split("/"));
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, file.content, { encoding: "utf8", flag: "wx" });
    mkdirSync(classesRoot);
    const toolsJar = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "lib", "tools.jar") : undefined;
    const compilerClasspath = toolsJar && existsSync(toolsJar) ? toolsJar : undefined;
    executeCommand(options.javacPath ?? "javac", ["-proc:none", "-encoding", "UTF-8", ...(compilerClasspath ? ["-classpath", compilerClasspath] : []),
      "-d", classesRoot, analyzerPath], "");
    const runtimeClasspath = [classesRoot, ...(compilerClasspath ? [compilerClasspath] : [])].join(delimiter);
    const output = executeCommand(options.javaPath ?? "java", ["-cp", runtimeClasspath, "craft.codebase.AnalyzeJavaControlFlow", sourceRoot,
      file.path, symbol.id, symbol.name, String(symbol.startOffset)], "");
    if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) result = { diagnostic: { language: "java", status: "partial", reason: "output_budget_exceeded" } };
    else {
      const parsed = JSON.parse(output) as JsonObject;
      if (parsed.format !== "craft-java-control-flow-v1" || parsed.language !== "java" || !Array.isArray(parsed.blocks)
        || !Array.isArray(parsed.edges) || !Array.isArray(parsed.partial_reasons) || parsed.symbol_id !== symbol.id
        || parsed.source_content_included !== false) result = { diagnostic: { language: "java", status: "failed", reason: "invalid_control_flow_response" } };
      else result = { result: parsed };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason = code === "ENOENT" ? "jdk_unavailable" : code === "ETIMEDOUT" ? "analysis_timed_out" : "analysis_failed";
    result = { diagnostic: { language: "java", status: "unavailable", reason } };
  }
  rmSync(temporaryRoot, { recursive: true, force: true });
  return result!;
}
