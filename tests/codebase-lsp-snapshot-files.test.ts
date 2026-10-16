import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stageLspSnapshotFiles } from "../capability/craft-codebase/lsp-snapshot-files.ts";

test("LSP snapshot staging writes only contained source and digest-pinned workspace files", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "craft-lsp-snapshot-files-"));
  const snapshotRoot = join(temporaryRoot, "snapshot");
  mkdirSync(snapshotRoot);
  try {
    const source = "package main\nfunc main() {}\n";
    const module = "module example.test/project\n\ngo 1.22\n";
    const digest = createHash("sha256").update(module).digest("hex");
    stageLspSnapshotFiles(snapshotRoot, [{ path: "src/main.go", content: source }], [{ path: "go.mod", content: module, digest }]);
    assert.equal(readFileSync(join(snapshotRoot, "src", "main.go"), "utf8"), source);
    assert.equal(readFileSync(join(snapshotRoot, "go.mod"), "utf8"), module);

    assert.throws(() => stageLspSnapshotFiles(snapshotRoot, [{ path: "..", content: "escape" }]), /invalid_snapshot_path/u);
    assert.equal(existsSync(join(temporaryRoot, "escape")), false);
    assert.throws(() => stageLspSnapshotFiles(snapshotRoot, [], [{ path: "../outside.mod", content: module, digest }]), /invalid_snapshot_path/u);
    assert.throws(() => stageLspSnapshotFiles(snapshotRoot, [], [{ path: "go.sum", content: "changed", digest }]), /LSP workspace context digest mismatch/u);
    assert.equal(existsSync(join(snapshotRoot, "go.sum")), false);
  } finally { rmSync(temporaryRoot, { recursive: true, force: true }); }
});
