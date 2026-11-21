import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import "../scripts/release/copy-capability-runtime.ts";

test("build copies every installed capability and Common runtime into distributable directories", async () => {
  for (const file of [
    "dist/capability/craft-codebase/capability.js",
    "dist/capability/craft-codebase/analyzers/analyze-python.py",
    "dist/capability/craft-context/capability.js",
    "dist/capability/craft-knowledge/capability.js",
    "dist/capability/craft-memory/capability.js",
    "dist/capability/craft-experience/capability.js",
    "dist/capability/craft-notes/index.js",
    "dist/common/craft-common-base/dist/index.js",
    "dist/common/craft-common-log/dist/index.js",
    "dist/common/craft-common-store-local/dist/store.js",
  ]) await access(new URL(`../${file}`, import.meta.url));
});
