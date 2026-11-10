import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { normalizeLspSymbols } from "../../capability/craft-codebase/lsp-adapter.ts";
import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";

const documents = Array.from({ length: 100 }, (_, file) => {
  const content = Array.from({ length: 100 }, (_, symbol) => `symbol${symbol}`).join("\n");
  return { path: `file${file}.py`, language: "python", content, source_digest: createHash("sha256").update(content).digest("hex"),
    symbols: Array.from({ length: 100 }, (_, symbol) => ({ name: `symbol${symbol}`, range: { start: { line: symbol, character: 0 }, end: { line: symbol, character: `symbol${symbol}`.length } } })) };
});
const fixture = { analyzer: "benchmark-lsp", analyzer_version: "1", documents };
const nodes = normalizeLspSymbols(fixture).nodes as JsonObject[];
const relations = Array.from({ length: 20_000 }, (_, index) => {
  const from = nodes[index % nodes.length]!, to = nodes[(index * 31 + 97) % nodes.length]!;
  const fromSpan = from.span as JsonObject, toSpan = to.span as JsonObject;
  return { kind: "references", from: { path: from.path, start_offset: fromSpan.start_offset },
    to: { path: to.path, start_offset: toSpan.start_offset }, source_span: fromSpan };
});
const input = { ...fixture, relations };
function measure(normalize: typeof normalizeLspSymbols): { median_ms: number; samples_ms: number[]; result: JsonObject } {
  normalize({ ...fixture, documents: documents.slice(0, 2) });
  const samples: number[] = []; let result: JsonObject = {};
  for (let attempt = 0; attempt < 3; attempt++) {
    const started = performance.now(); result = normalize(input); samples.push(performance.now() - started);
  }
  return { median_ms: [...samples].sort((a, b) => a - b)[1]!, samples_ms: samples, result };
}
const current = measure(normalizeLspSymbols);
const baselinePath = process.argv[2];
const baseline = baselinePath ? measure((await import(pathToFileURL(resolve(baselinePath)).href) as { normalizeLspSymbols: typeof normalizeLspSymbols }).normalizeLspSymbols) : null;
if (baseline) assert.deepEqual(current.result, baseline.result, "Benchmark must preserve the complete normalized output");
process.stdout.write(`${JSON.stringify({ node: process.versions.node, symbols: nodes.length, relations: relations.length,
  samples: 3, current: { median_ms: current.median_ms, samples_ms: current.samples_ms },
  baseline: baseline ? { median_ms: baseline.median_ms, samples_ms: baseline.samples_ms } : null,
  speedup: baseline ? baseline.median_ms / current.median_ms : null, output_equivalent: baseline !== null }, null, 2)}\n`);
