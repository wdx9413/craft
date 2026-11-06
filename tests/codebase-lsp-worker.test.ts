import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { lspWorkerFailure, runCodebaseLspWorker, runCodebaseLspWorkerSafely } from "../capability/craft-codebase/lsp-worker.ts";

test("bundled MCP worker runs the configured language server against bounded snapshot documents", () => {
  const content = "class Example {}\n";
  const request = { command: process.execPath, args: [resolve("tests/fixtures/lsp-stdio-fixture.cjs"), "ok"], cwd: process.cwd(), analyzer: "fixture-js", analyzer_version: "1",
    documents: [{ path: "example.js", language: "javascript", content, source_digest: createHash("sha256").update(content).digest("hex") }] };
  const output = execFileSync(process.execPath, ["--experimental-strip-types", resolve("bin/craft-mcp.ts"), "--craft-codebase-lsp-worker"], {
    input: JSON.stringify(request), encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  });
  const graph = JSON.parse(output) as { analyzer: string; nodes: Array<{ name: string }> };
  assert.equal(graph.analyzer, "fixture-js"); assert(graph.nodes.some(node => node.name === "Example"));
});

test("LSP worker rejects malformed and oversized requests without exposing request contents", async () => {
  await assert.rejects(runCodebaseLspWorker((async function* () { yield Buffer.from("not json"); })(), () => {}), /request is invalid/u);
  await assert.rejects(runCodebaseLspWorker((async function* () { yield Buffer.alloc(70 * 1024 * 1024 + 1); })(), () => {}), /exceeds budget/u);
});

test("LSP worker applies the request-scoped timeout to language-server calls", async () => {
  const content = "class Example {}\n";
  const request = { command: process.execPath, args: [resolve("tests/fixtures/lsp-stdio-fixture.cjs"), "timeout"], cwd: process.cwd(), analyzer: "fixture-js", analyzer_version: "1",
    request_timeout_ms: 500, documents: [{ path: "example.js", language: "javascript", content, source_digest: createHash("sha256").update(content).digest("hex") }] };
  await assert.rejects(runCodebaseLspWorker((async function* () { yield Buffer.from(JSON.stringify(request)); })(), () => {}), /timed out: textDocument\/documentSymbol/u);
});

test("LSP worker failure records preserve safe category and stage without server messages", () => {
  assert.deepEqual(lspWorkerFailure(new Error("Language server request failed during textDocument/documentSymbol (-32603): private source path")), {
    format: "craft-lsp-worker-failure-v1", reason: "server_request_failed", failure_stage: "textDocument/documentSymbol", protocol_error_code: -32603,
  });
  assert.deepEqual(lspWorkerFailure(new Error("Language server request failed during initialize (999999999999999999999)")), {
    format: "craft-lsp-worker-failure-v1", reason: "server_request_failed", failure_stage: "initialize",
  });
  assert.deepEqual(lspWorkerFailure(new Error("Language server request timed out: textDocument/documentSymbol")), {
    format: "craft-lsp-worker-failure-v1", reason: "request_timeout", failure_stage: "textDocument/documentSymbol",
  });
  assert.deepEqual(lspWorkerFailure(new Error("Unable to start configured language server")), {
    format: "craft-lsp-worker-failure-v1", reason: "server_unavailable",
  });
  assert.deepEqual(lspWorkerFailure(new Error("private adapter failure")), {
    format: "craft-lsp-worker-failure-v1", reason: "analysis_failed",
  });
  assert.deepEqual(lspWorkerFailure("private adapter failure"), { format: "craft-lsp-worker-failure-v1", reason: "analysis_failed" });
  assert.equal(JSON.stringify(lspWorkerFailure(new Error("private adapter failure /Users/private/project"))).includes("private"), false);
});

test("safe LSP worker emits success or sanitized failure as one JSON line", async () => {
  const content = "class Example {}\n";
  const request = (mode: string) => ({ command: process.execPath, args: [resolve("tests/fixtures/lsp-stdio-fixture.cjs"), mode], cwd: process.cwd(), analyzer: "fixture-js", analyzer_version: "1",
    documents: [{ path: "example.js", language: "javascript", content, source_digest: createHash("sha256").update(content).digest("hex") }] });
  for (const mode of ["ok", "request-error"]) {
    const output: string[] = [];
    await runCodebaseLspWorkerSafely((async function* () { yield Buffer.from(JSON.stringify(request(mode))); })(), line => output.push(line));
    const result = JSON.parse(output.join("")) as Record<string, unknown>;
    assert.equal(result.format, mode === "ok" ? "craft-static-analysis-v1" : "craft-lsp-worker-failure-v1");
    if (mode === "request-error") assert.equal(result.failure_stage, "textDocument/documentSymbol");
  }
});

test("bundled MCP worker returns sanitized language-server failure diagnostics", () => {
  const content = "class Example {}\n";
  const request = { command: process.execPath, args: [resolve("tests/fixtures/lsp-stdio-fixture.cjs"), "request-error"], cwd: process.cwd(), analyzer: "fixture-js", analyzer_version: "1",
    documents: [{ path: "example.js", language: "javascript", content, source_digest: createHash("sha256").update(content).digest("hex") }] };
  const output = execFileSync(process.execPath, ["--experimental-strip-types", resolve("bin/craft-mcp.ts"), "--craft-codebase-lsp-worker"], {
    input: JSON.stringify(request), encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  });
  const failure = JSON.parse(output) as Record<string, unknown>;
  assert.deepEqual(failure, { format: "craft-lsp-worker-failure-v1", reason: "server_request_failed", failure_stage: "textDocument/documentSymbol", protocol_error_code: -32603 });
  assert.equal(output.includes("fixture failure"), false);
});
