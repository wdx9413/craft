import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configuredLspWorkerEnvironment, languageIdForFile, MAX_LSP_DOCUMENTS, MAX_RELATION_SYMBOLS, readTrustedLspConfig } from "../capability/craft-codebase/lsp-config.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "craft-lsp-config-")); mkdirSync(join(root, "config"));
  return { root, dir: join(root, "config"), close: () => rmSync(root, { recursive: true, force: true }) };
}
function write(dir: string, value: unknown) { writeFileSync(join(dir, "codebase-lsp.json"), typeof value === "string" ? value : JSON.stringify(value)); }
const valid = (overrides: Record<string, unknown> = {}) => ({ schema_version: 1, adapters: [{ language: "cpp", command: process.execPath, ...overrides }] });

test("trusted LSP configuration accepts an executable and bounds its adapter contract", () => {
  const f = fixture();
  try {
    assert.deepEqual(readTrustedLspConfig(f.dir).adapters, []);
    write(f.dir, valid());
    const first = readTrustedLspConfig(f.dir);
    assert.equal(first.adapters.length, 1); assert.equal(first.adapters[0]!.language, "cpp");
    assert.equal(first.adapters[0]!.max_documents, 100); assert.equal(first.adapters[0]!.relations.length, 6);
    assert.equal(first.adapters[0]!.relation_symbol_limit, 100);
    assert.equal(first.adapters[0]!.request_timeout_ms, 10_000);
    write(f.dir, valid({ max_documents: MAX_LSP_DOCUMENTS }));
    assert.equal(readTrustedLspConfig(f.dir).adapters[0]!.max_documents, MAX_LSP_DOCUMENTS);
    write(f.dir, valid({ analyzer_version: "invalid version", relations: ["calls"], max_documents: 4, relation_symbol_limit: 250, request_timeout_ms: 30_000 }));
    const second = readTrustedLspConfig(f.dir);
    assert.notEqual(first.digest, second.digest); assert.equal(second.adapters[0]!.analyzer_version, "1");
    assert.deepEqual(second.adapters[0]!.relations, ["calls"]); assert.equal(second.adapters[0]!.max_documents, 4);
    assert.equal(second.adapters[0]!.relation_symbol_limit, 250);
    assert.equal(second.adapters[0]!.request_timeout_ms, 30_000);
    write(f.dir, valid({ relation_symbol_limit: 500 }));
    assert.equal(readTrustedLspConfig(f.dir).adapters[0]!.relation_symbol_limit, 500);
    write(f.dir, valid({ relation_symbol_limit: MAX_RELATION_SYMBOLS }));
    assert.equal(readTrustedLspConfig(f.dir).adapters[0]!.relation_symbol_limit, MAX_RELATION_SYMBOLS);
    write(f.dir, { schema_version: 1, adapters: [...(valid() as any).adapters, ...(valid() as any).adapters] });
    const duplicate = readTrustedLspConfig(f.dir);
    assert.equal(duplicate.adapters.length, 1); assert.equal(duplicate.diagnostics[0]?.reason, "duplicate_language");
    assert.equal(languageIdForFile("main.CPP"), "cpp"); assert.equal(languageIdForFile("main.swift"), "swift");
    assert.equal(languageIdForFile("main.ts"), "typescript"); assert.equal(languageIdForFile("main.tsx"), "typescriptreact");
    assert.equal(languageIdForFile("main.js"), "javascript"); assert.equal(languageIdForFile("main.jsx"), "javascriptreact");
    assert.equal(languageIdForFile("Makefile"), undefined); assert.equal(languageIdForFile("src/unknown.zzz"), undefined);
  } finally { f.close(); }
});

test("trusted LSP configuration rejects malformed files and reports invalid adapters safely", () => {
  const f = fixture();
  try {
    write(f.dir, "{"); assert.equal(readTrustedLspConfig(f.dir).adapters.length, 0);
    for (const value of ["null", "false", "12", "\"text\"", "[]"]) {
      write(f.dir, value); assert.equal(readTrustedLspConfig(f.dir).adapters.length, 0);
    }
    write(f.dir, { schema_version: 2, adapters: [] }); assert.equal(readTrustedLspConfig(f.dir).diagnostics[0]?.reason, "invalid_config_shape");
    write(f.dir, { schema_version: 1, adapters: Array.from({ length: 33 }, () => ({})) }); assert.equal(readTrustedLspConfig(f.dir).diagnostics[0]?.reason, "invalid_config_shape");
    const cases: unknown[] = [null, [], { language: 7, command: process.execPath }, { language: "not-real", command: process.execPath }, { language: "cpp", command: "relative" },
      { language: "cpp", command: join(f.root, "missing") }, { language: "cpp", command: process.execPath, args: [3] },
      { language: "cpp", command: process.execPath, args: ["bad\narg"] }, { language: "cpp", command: process.execPath, relations: ["invented"] },
      { language: "cpp", command: process.execPath, max_documents: MAX_LSP_DOCUMENTS + 1 }, { language: "cpp", command: process.execPath, max_documents: 0 },
      { language: "cpp", command: process.execPath, relation_symbol_limit: 0 }, { language: "cpp", command: process.execPath, relation_symbol_limit: MAX_RELATION_SYMBOLS + 1 },
      { language: "cpp", command: process.execPath, analyzer_version: "valid-1.0", args: Array.from({ length: 33 }, () => "x") },
      { language: "cpp", command: process.execPath, args: ["x".repeat(1025)] }, { language: "cpp", command: process.execPath, args: ["bad\0arg"] },
      { language: "cpp", command: process.execPath, relations: Array.from({ length: 7 }, () => "calls") },
      { language: "cpp", command: process.execPath, request_timeout_ms: 0 }, { language: "cpp", command: process.execPath, request_timeout_ms: 120_001 },
      { language: "cpp", command: process.execPath, request_timeout_ms: 1.5 }, { language: "cpp", command: process.execPath, request_timeout_ms: "30000" },
      { language: "cpp", command: process.execPath, max_documents: "2" }, { language: "cpp", command: "x".repeat(1025) },
    ];
    for (const adapter of cases) {
      write(f.dir, { schema_version: 1, adapters: [adapter] });
      const result = readTrustedLspConfig(f.dir);
      assert.equal(result.adapters.length, 0); assert.equal(result.diagnostics.length, 1);
    }
    writeFileSync(join(f.dir, "codebase-lsp.json"), "x".repeat(65 * 1024));
    assert.equal(readTrustedLspConfig(f.dir).diagnostics[0]?.reason, "config_exceeds_budget");
    rmSync(join(f.dir, "codebase-lsp.json")); mkdirSync(join(f.dir, "codebase-lsp.json"));
    assert.equal(readTrustedLspConfig(f.dir).diagnostics[0]?.reason, "config_not_regular_file");
    rmSync(join(f.dir, "codebase-lsp.json"), { recursive: true }); writeFileSync(join(f.root, "actual.json"), JSON.stringify(valid()));
    symlinkSync(join(f.root, "actual.json"), join(f.dir, "codebase-lsp.json"));
    assert.equal(readTrustedLspConfig(f.dir).diagnostics[0]?.reason, "config_not_regular_file");
    rmSync(join(f.dir, "codebase-lsp.json"));
    write(f.dir, valid({ analyzer_version: "v2.1" })); assert.equal(readTrustedLspConfig(f.dir).adapters[0]?.analyzer_version, "v2.1");
    assert.equal(languageIdForFile("."), undefined);
  } finally { f.close(); }
});

test("Go worker caches stay in the owning Codebase data directory", () => {
  const inherited = { PATH: "/usr/bin", GOPLSCACHE: "/host-gopls-cache", GOCACHE: "/host-go-build-cache" };
  const go = configuredLspWorkerEnvironment("go", "/project/.craft_data/codebase", inherited);
  assert.equal(go.GOPLSCACHE, join("/project/.craft_data/codebase", "gopls-cache"));
  assert.equal(go.GOCACHE, join("/project/.craft_data/codebase", "go-build-cache"));
  assert.equal(go.PATH, inherited.PATH);
  assert.equal(inherited.GOPLSCACHE, "/host-gopls-cache");
  assert.equal(inherited.GOCACHE, "/host-go-build-cache");
  assert.equal(configuredLspWorkerEnvironment("cpp", "/project/.craft_data/codebase", inherited), inherited);
});
