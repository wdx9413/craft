import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { analyzeJavaCheckpoint, analyzeJavaControlFlow, resolveJavaAnalyzerPath, resolveJavaControlFlowAnalyzerPath } from "../capability/craft-codebase/java-analysis.ts";
import type { RepositoryFile } from "../capability/craft-codebase/repository-files.ts";

const source = (path: string, content: string, digest = createHash("sha256").update(content, "utf8").digest("hex")): RepositoryFile =>
  ({ path, content, digest, language: "java" });

test("JDK analysis resolves Java declarations, imports, references, types, inheritance, implementation and calls", () => {
  const files = [
    source("core/Base.java", "package core;\npublic class Base { public void run() {} }\n"),
    source("core/Runner.java", "package core;\npublic interface Runner { void run(); }\n"),
    source("app/Worker.java", "package app;\nimport core.Base;\nimport core.Runner;\npublic class Worker extends Base implements Runner { public void process() { run(); } public Base echo(Base input) { return input; } }\n"),
  ];
  const result = analyzeJavaCheckpoint(files);
  assert(result.analysis, JSON.stringify(result.diagnostic));
  const nodes = result.analysis.nodes as Array<Record<string, unknown>>;
  const edges = result.analysis.edges as Array<Record<string, unknown>>;
  const base = nodes.find(node => node.path === "core/Base.java" && node.name === "Base")!;
  const run = nodes.find(node => node.path === "core/Base.java" && node.name === "run")!;
  const runner = nodes.find(node => node.path === "core/Runner.java" && node.name === "Runner")!;
  const worker = nodes.find(node => node.path === "app/Worker.java" && node.name === "Worker")!;
  const process = nodes.find(node => node.path === "app/Worker.java" && node.name === "process")!;
  const echo = nodes.find(node => node.path === "app/Worker.java" && node.name === "echo")!;
  assert(base && run && runner && worker && process && echo);
  assert.equal(base.kind, "symbol");
  assert.equal(base.declaration_kind, "class");
  assert(edges.some(edge => edge.kind === "imports" && edge.to_node_id === base.id));
  assert(edges.some(edge => edge.kind === "extends" && edge.from_node_id === worker.id && edge.to_node_id === base.id));
  assert(edges.some(edge => edge.kind === "implements" && edge.from_node_id === worker.id && edge.to_node_id === runner.id));
  assert(edges.some(edge => edge.kind === "calls" && edge.from_node_id === process.id && edge.to_node_id === run.id));
  assert(edges.some(edge => edge.kind === "references" && edge.from_node_id === process.id && edge.to_node_id === run.id));
  assert(edges.some(edge => edge.kind === "type_definition" && edge.from_node_id === echo.id && edge.to_node_id === base.id));
  assert.equal((result.analysis.diagnostics as Record<string, unknown>).external_resolution, false);
  assert.equal((result.analysis.file_units as unknown[]).length, 3);
  assert.equal(nodes.every(node => node.source_digest === files.find(file => file.path === node.path)?.digest), true);
  assert.equal(nodes.every(node => (node.span as Record<string, number>).end_offset <= files.find(file => file.path === node.path)!.content.length), true);
  const changedUnit = analyzeJavaCheckpoint(files, { includePaths: ["core/Base.java"] });
  assert(changedUnit.analysis, JSON.stringify(changedUnit.diagnostic));
  assert.deepEqual((changedUnit.analysis.file_units as Array<Record<string, unknown>>).map(unit => unit.path), ["core/Base.java"]);
  const selectedDiagnostics = changedUnit.analysis.diagnostics as Record<string, unknown>;
  assert.equal(selectedDiagnostics.selected_file_count, 1);
  assert.equal(selectedDiagnostics.compiler_input_file_count, 3);
});

test("Java syntax diagnostics remain visible without discarding parsed snapshot symbols", () => {
  const result = analyzeJavaCheckpoint([source("Main.java", "class Main { void run( { }\n")]);
  assert(result.analysis, JSON.stringify(result.diagnostic));
  const diagnostics = result.analysis.diagnostics as Record<string, unknown>;
  assert(Number(diagnostics.syntax_errors) > 0);
  assert(Number(diagnostics.compiler_errors) >= Number(diagnostics.syntax_errors));
  assert((result.analysis.nodes as Array<Record<string, unknown>>).some(node => node.name === "Main"));
  assert.equal((result.analysis.file_units as Array<Record<string, unknown>>)[0]!.incremental_safe, false);
});

test("Java compiler errors make only their owning snapshot units unsafe for incremental reuse", () => {
  const files = [
    source("broken/Broken.java", "package broken; class Broken { void fail() { missing(); } }\n"),
    source("safe/Safe.java", "package safe; class Safe { void pass() {} }\n"),
  ];
  const result = analyzeJavaCheckpoint(files);
  assert(result.analysis, JSON.stringify(result.diagnostic));
  const diagnostics = result.analysis.diagnostics as Record<string, unknown>;
  const units = result.analysis.file_units as Array<Record<string, unknown>>;
  assert(Number(diagnostics.compiler_errors) > 0);
  assert.equal(diagnostics.unmapped_compiler_errors, 0);
  assert.equal(units.find(unit => unit.path === "broken/Broken.java")!.incremental_safe, false);
  assert.equal(units.find(unit => unit.path === "safe/Safe.java")!.incremental_safe, true);
});

test("Java analysis fails closed for empty, unsafe, stale, over-budget and unavailable inputs", () => {
  let executions = 0;
  const execute = () => { executions++; return "{}"; };
  assert.deepEqual(analyzeJavaCheckpoint([]), {});
  assert.deepEqual(analyzeJavaCheckpoint([source("../outside.java", "class Outside {}")], { analyzerPath: "/helper", execute }),
    { diagnostic: { language: "java", status: "failed", reason: "unsafe_java_path" } });
  assert.deepEqual(analyzeJavaCheckpoint([source("Main.java", "class Main {}", "wrong")], { analyzerPath: "/helper", execute }),
    { diagnostic: { language: "java", status: "failed", reason: "snapshot_digest_mismatch" } });
  assert.deepEqual(analyzeJavaCheckpoint([source("Main.java", "x".repeat(24_000_001))], { analyzerPath: "/helper", execute }),
    { diagnostic: { language: "java", status: "partial", reason: "input_budget_exceeded" } });
  assert.deepEqual(analyzeJavaCheckpoint([source("Main.java", "class Main {}")], { fileExists: () => false }),
    { diagnostic: { language: "java", status: "unavailable", reason: "analyzer_not_packaged" } });
  assert.equal(executions, 0);
});

test("JDK control-flow analysis exposes digest-pinned branches, loops, returns and exceptional exit without source", () => {
  const content = "class Main { void route(boolean flag, int count) { if (count < 0) throw new IllegalArgumentException(); if (flag) { count++; } else { count--; } while (count > 0) { count--; } return; } }\n";
  const file = source("Main.java", content);
  const result = analyzeJavaControlFlow(file, { id: "java_route_symbol", name: "route", startOffset: content.indexOf("route") });
  assert(result.result, JSON.stringify(result.diagnostic));
  const blocks = result.result.blocks as Array<Record<string, unknown>>;
  const edges = result.result.edges as Array<Record<string, unknown>>;
  assert.equal(result.result.status, "complete");
  assert.equal(result.result.source_content_included, false);
  assert.equal(result.result.symbol_id, "java_route_symbol");
  assert(blocks.some(block => block.kind === "condition"));
  assert(blocks.some(block => block.kind === "loop_condition"));
  assert(blocks.some(block => block.kind === "return"));
  assert(edges.some(edge => edge.loop_back === true));
  assert(edges.some(edge => edge.kind === "exception" && edge.to_block_id === result.result!.exception_exit_block_id));
  assert.equal(Object.hasOwn(result.result, "source"), false);
});

test("Java try, switch and synchronized control flow is explicitly partial", () => {
  const content = "class Main { void route(int value) { try { value++; } catch (RuntimeException ignored) { value = 0; } switch (value) { case 1: value++; break; default: value--; } synchronized (this) { value++; } } }\n";
  const result = analyzeJavaControlFlow(source("Main.java", content), { id: "java_partial_symbol", name: "route", startOffset: content.indexOf("route") });
  assert(result.result, JSON.stringify(result.diagnostic));
  assert.equal(result.result.status, "partial");
  assert.deepEqual(result.result.partial_reasons, ["SWITCH", "SYNCHRONIZED", "TRY"]);
  assert.equal(result.result.source_content_included, false);
});

test("Java control-flow adapter rejects unsafe, stale and missing analyzer inputs before execution", () => {
  const file = source("Main.java", "class Main { void route() {} }\n");
  let executions = 0;
  const options = { analyzerPath: "/helper", execute: () => { executions++; return "{}"; } };
  const symbol = { id: "java_route_symbol", name: "route", startOffset: 18 };
  assert.deepEqual(analyzeJavaControlFlow(source("../Main.java", file.content), symbol, options),
    { diagnostic: { language: "java", status: "failed", reason: "unsafe_java_path" } });
  assert.deepEqual(analyzeJavaControlFlow(file, { ...symbol, startOffset: -1 }, options),
    { diagnostic: { language: "java", status: "failed", reason: "invalid_symbol_offset" } });
  assert.deepEqual(analyzeJavaControlFlow(source("Main.java", file.content, "wrong"), symbol, options),
    { diagnostic: { language: "java", status: "failed", reason: "snapshot_digest_mismatch" } });
  assert.deepEqual(analyzeJavaControlFlow(source("Main.java", "x".repeat(24_000_001)), symbol, options),
    { diagnostic: { language: "java", status: "partial", reason: "input_budget_exceeded" } });
  assert.deepEqual(analyzeJavaControlFlow(file, symbol, { fileExists: () => false }),
    { diagnostic: { language: "java", status: "unavailable", reason: "analyzer_not_packaged" } });
  assert.equal(executions, 0);
});

test("Java control-flow analyzer resolves both bundled and repository-local paths", () => {
  assert.equal(resolveJavaControlFlowAnalyzerPath("/workspace", path => path.endsWith("/capability/craft-codebase/analyzers/AnalyzeJavaControlFlow.java"), "file:///workspace/capability/craft-codebase/java-analysis.ts"),
    "/workspace/capability/craft-codebase/analyzers/AnalyzeJavaControlFlow.java");
  assert.equal(resolveJavaControlFlowAnalyzerPath("/workspace", path => path === "/workspace/capability/craft-codebase/analyzers/AnalyzeJavaControlFlow.java", null),
    "/workspace/capability/craft-codebase/analyzers/AnalyzeJavaControlFlow.java");
  assert.equal(resolveJavaControlFlowAnalyzerPath("/workspace", () => false, null), undefined);
  const previousEntry = process.argv[1];
  try {
    process.argv.splice(1, 1);
    assert.equal(resolveJavaControlFlowAnalyzerPath("/workspace", path => path === "/workspace/capability/craft-codebase/analyzers/AnalyzeJavaControlFlow.java", null),
      "/workspace/capability/craft-codebase/analyzers/AnalyzeJavaControlFlow.java");
  } finally { process.argv.splice(1, 0, previousEntry!); }
});

test("Java control-flow adapter executes a valid response without tools.jar and cleans its temporary snapshot", () => {
  const content = "class Main { void route() {} }\n", file = source("Main.java", content);
  const symbol = { id: "java_route_symbol", name: "route", startOffset: content.indexOf("route") };
  const temporaryRoot = mkdtempSync(join(tmpdir(), "craft-java-flow-adapter-test-"));
  const priorJavaHome = process.env.JAVA_HOME;
  delete process.env.JAVA_HOME;
  let runtimeArgs: string[] | undefined;
  try {
    const result = analyzeJavaControlFlow(file, symbol, { analyzerPath: "/helper", tempDirectory: temporaryRoot,
      javacPath: "/jdk/bin/javac", javaPath: "/jdk/bin/java", execute: (command, args) => {
        if (command.endsWith("javac")) { assert.equal(args.includes("-classpath"), false); return ""; }
        runtimeArgs = args;
        return JSON.stringify({ format: "craft-java-control-flow-v1", language: "java", symbol_id: symbol.id,
          blocks: [], edges: [], partial_reasons: [], source_content_included: false });
      } });
    assert(result.result);
    assert.equal(runtimeArgs?.[0], "-cp");
    assert.equal(runtimeArgs?.[2], "craft.codebase.AnalyzeJavaControlFlow");
    assert.equal(runtimeArgs?.[1]?.includes("tools.jar"), false);
    assert.deepEqual(readdirSync(temporaryRoot), []);
  } finally {
    if (priorJavaHome === undefined) delete process.env.JAVA_HOME;
    else process.env.JAVA_HOME = priorJavaHome;
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("Java control-flow helper failures and invalid responses remain bounded diagnostics", () => {
  const content = "class Main { void route() {} }\n", file = source("Main.java", content);
  const symbol = { id: "java_route_symbol", name: "route", startOffset: content.indexOf("route") };
  const failure = (code: string) => analyzeJavaControlFlow(file, symbol, { analyzerPath: "/helper", execute: () => {
    throw Object.assign(new Error("private command output"), { code });
  } });
  assert.deepEqual(failure("ENOENT"), { diagnostic: { language: "java", status: "unavailable", reason: "jdk_unavailable" } });
  assert.deepEqual(failure("ETIMEDOUT"), { diagnostic: { language: "java", status: "unavailable", reason: "analysis_timed_out" } });
  assert.deepEqual(failure("EIO"), { diagnostic: { language: "java", status: "unavailable", reason: "analysis_failed" } });
  const invalid = analyzeJavaControlFlow(file, symbol, { analyzerPath: "/helper", execute: (_command, args) => args[0] === "-proc:none" ? "" : "not-json" });
  assert.deepEqual(invalid, { diagnostic: { language: "java", status: "unavailable", reason: "analysis_failed" } });
  const malformed = analyzeJavaControlFlow(file, symbol, { analyzerPath: "/helper", execute: (_command, args) => args[0] === "-proc:none" ? "" : JSON.stringify({ format: "other" }) });
  assert.deepEqual(malformed, { diagnostic: { language: "java", status: "failed", reason: "invalid_control_flow_response" } });
  const oversized = analyzeJavaControlFlow(file, symbol, { analyzerPath: "/helper", execute: (_command, args) => args[0] === "-proc:none" ? "" : "x".repeat(64 * 1024 * 1024 + 1) });
  assert.deepEqual(oversized, { diagnostic: { language: "java", status: "partial", reason: "output_budget_exceeded" } });
});

test("Java helper and runtime failures become bounded diagnostics", () => {
  const file = source("Main.java", "class Main {}");
  const failure = (code: string) => analyzeJavaCheckpoint([file], { analyzerPath: "/helper", execute: () => {
    throw Object.assign(new Error("private command output"), { code });
  } });
  assert.deepEqual(failure("ENOENT"), { diagnostic: { language: "java", status: "unavailable", reason: "jdk_unavailable" } });
  assert.deepEqual(failure("ETIMEDOUT"), { diagnostic: { language: "java", status: "unavailable", reason: "analysis_timed_out" } });
  assert.deepEqual(failure("EIO"), { diagnostic: { language: "java", status: "unavailable", reason: "analysis_failed" } });
  const invalid = analyzeJavaCheckpoint([file], { analyzerPath: "/helper", execute: (_command, args) => args[0] === "-proc:none" ? "" : JSON.stringify({ format: "other" }) });
  assert.deepEqual(invalid, { diagnostic: { language: "java", status: "failed", reason: "invalid_analyzer_response" } });
  const failed = analyzeJavaCheckpoint([file], { analyzerPath: "/helper", execute: (_command, args) => args[0] === "-proc:none" ? "" : JSON.stringify({
    format: "craft-static-analysis-v1", analyzer: "jdk-compiler-tree", analyzer_version: "craft-java-javac-v1",
    file_units: [], diagnostics: { status: "failed" },
  }) });
  assert.deepEqual(failed, { diagnostic: { language: "java", status: "unavailable", reason: "java_analysis_failed" } });
});

test("Java analyzer resolution, JDK 8 compiler classpath and response budgets are bounded", () => {
  const moduleAnalyzer = resolveJavaAnalyzerPath("/work", path => path.includes("/module/analyzers/"), "file:///module/index.js");
  assert.equal(moduleAnalyzer, "/module/analyzers/AnalyzeJava.java");
  const scriptAnalyzer = resolveJavaAnalyzerPath("/work", path => path.includes("scripts/codebase/analyzers/"), null);
  assert(scriptAnalyzer?.includes("scripts/codebase/analyzers/AnalyzeJava.java"));
  assert.equal(resolveJavaAnalyzerPath("/work", () => false, null), undefined);
  const originalEntry = process.argv[1];
  try {
    process.argv[1] = undefined as unknown as string;
    assert.equal(resolveJavaAnalyzerPath("/work", () => false, null), undefined);
    assert.equal(resolveJavaControlFlowAnalyzerPath("/work", () => false, null), undefined);
  }
  finally { process.argv[1] = originalEntry!; }

  const file = source("Main.java", "class Main {}");
  const originalJavaHome = process.env.JAVA_HOME;
  const run = (toolsJarPath: string | null | undefined, output = JSON.stringify({ format: "craft-static-analysis-v1", analyzer: "jdk-compiler-tree", nodes: [], edges: [], diagnostics: {} })) => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "craft-java-test-"));
    const toolsJar = join(tempDirectory, "tools.jar"); writeFileSync(toolsJar, "test");
    const commands: Array<{ command: string; args: string[] }> = [];
    try {
      const result = analyzeJavaCheckpoint([file], { analyzerPath: "/helper", tempDirectory, toolsJarPath,
        javacPath: "/custom/javac", javaPath: "/custom/java", execute: (command, args) => { commands.push({ command, args }); return output; } });
      return { result, commands };
    } finally { rmSync(tempDirectory, { recursive: true, force: true }); }
  };
  try {
    delete process.env.JAVA_HOME;
    const withoutTools = run(null);
    assert.deepEqual(withoutTools.commands.map(item => item.command), ["/custom/javac", "/custom/java"]);
    assert.equal(withoutTools.commands[0]!.args.includes("-classpath"), false);
    const withTools = run(join(tmpdir(), "unused"));
    assert.equal(withTools.commands[0]!.args.includes("-classpath"), false);
    const existingTools = run("/etc/hosts");
    assert.equal(existingTools.commands[0]!.args.includes("-classpath"), true);
    assert.equal(existingTools.commands[1]!.args[1]!.includes(delimiter === ":" ? "/etc/hosts" : "\\etc\\hosts"), true);
    const envHome = join(tmpdir(), `craft-java-home-${process.pid}`);
    mkdirSync(join(envHome, "lib"), { recursive: true }); writeFileSync(join(envHome, "lib", "tools.jar"), "test");
    process.env.JAVA_HOME = envHome;
    const envTools = run(undefined);
    assert.equal(process.env.JAVA_HOME, envHome);
    assert.equal(envTools.commands[0]!.args.includes("-classpath"), true);
    assert(envTools.commands[0]!.args.includes(join(envHome, "lib", "tools.jar")));
    delete process.env.JAVA_HOME;
    rmSync(envHome, { recursive: true, force: true });
    const oversized = run(null, "x".repeat(64_000_001));
    assert.deepEqual(oversized.result, { diagnostic: { language: "java", status: "partial", reason: "output_budget_exceeded" } });
    for (const invalid of [
      { format: "craft-static-analysis-v1", analyzer: "other", nodes: [], edges: [], diagnostics: {} },
      { format: "craft-static-analysis-v1", analyzer: "jdk-compiler-tree", nodes: {}, edges: [], diagnostics: {} },
      { format: "craft-static-analysis-v1", analyzer: "jdk-compiler-tree", nodes: [], edges: {}, diagnostics: {} },
      { format: "craft-static-analysis-v1", analyzer: "jdk-compiler-tree", nodes: [], edges: [], diagnostics: null },
    ]) assert.deepEqual(run(null, JSON.stringify(invalid)).result, { diagnostic: { language: "java", status: "failed", reason: "invalid_analyzer_response" } });
    const invalidUnit = analyzeJavaCheckpoint([file], { analyzerPath: "/helper", execute: (_command, args) => args[0] === "-proc:none" ? "" : JSON.stringify({
      format: "craft-static-analysis-v1", analyzer: "jdk-compiler-tree", analyzer_version: "craft-java-javac-v1",
      file_units: [{ path: "Main.java", source_digest: "wrong", package_name: "", nodes: [], edges: [], unresolved_calls: 0,
        unresolved_imports: 0, incremental_safe: true, budget_limited: false }], diagnostics: {},
    }) });
    assert.deepEqual(invalidUnit, { diagnostic: { language: "java", status: "failed", reason: "invalid_java_file_unit" } });
    assert.deepEqual(analyzeJavaCheckpoint([file], { analyzerPath: "/helper", execute: () => {
      const error = new Error("private command output");
      Object.defineProperty(error, "code", { get: () => { throw new Error("unexpected diagnostic accessor failure"); } });
      throw error;
    } }).diagnostic, { language: "java", status: "unavailable", reason: "analysis_failed" });
  } finally { if (originalJavaHome === undefined) delete process.env.JAVA_HOME; else process.env.JAVA_HOME = originalJavaHome; }
});
