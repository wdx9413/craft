import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { runCodebaseLspWorker } from "../capability/craft-codebase/lsp-worker.ts";

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
