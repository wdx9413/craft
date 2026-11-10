import assert from "node:assert/strict";
import test from "node:test";
import { auditLayerGraph } from "../scripts/ci/layer-graph.ts";

test("public common packages cannot import a higher Craft layer", () => {
  const findings = auditLayerGraph({
    "common/craft-common-store-local/src/store.ts": "import '../../craft-common-base/src/base.ts';",
    "common/craft-common-base/src/base.ts": "import '../../craft-common-log/src/log.ts';",
    "common/craft-common-log/src/log.ts": "import '../../../core/kernel.ts';",
    "core/kernel.ts": "export const kernel = true;",
  });
  assert.equal(findings.filter(item => item.kind === "upward").length, 3);
});

test("layer audit follows compatibility barrels and both static and dynamic imports", () => {
  const sources = {
    "core/kernel.ts": `import { Service } from './service.js'; import('./application/service.ts');`,
    "core/service.ts": `export * from './application/service.ts';`,
    "core/application/service.ts": `export class Service {}`,
  };
  const findings = auditLayerGraph(sources);
  assert.equal(findings.filter((item) => item.kind === "upward").length, 2);
  assert.deepEqual(findings[0].path, ["core/kernel.ts", "core/service.ts", "core/application/service.ts"]);
});
test("runtime cycles are rejected while type-only dependencies remain runtime-free", () => {
  assert.deepEqual(auditLayerGraph({ "core/a.ts": `export { type B } from './b.ts';`, "core/b.ts": `import './a.ts'; export type B = number;` }), []);
  assert.equal(auditLayerGraph({ "core/a.ts": `export {} from './b.ts';`, "core/b.ts": `import './a.ts';` }).filter((item) => item.kind === "cycle").length, 1);
  assert.equal(auditLayerGraph({ "core/a.ts": `export { type B, value } from './b.ts';`, "core/b.ts": `import './a.ts'; export type B = number; export const value = 1;` }).filter((item) => item.kind === "cycle").length, 1);
  assert.equal(auditLayerGraph({ "core/a.ts": `export * as b from './b.ts';`, "core/b.ts": `import './a.ts';` }).filter((item) => item.kind === "cycle").length, 1);
  assert.equal(auditLayerGraph({ "core/a.ts": `import './b.ts';`, "core/b.ts": `export * from './a.ts';` }).filter((item) => item.kind === "cycle").length, 1);
  assert.deepEqual(auditLayerGraph({ "core/a.ts": `import type { B } from './b.ts';`, "core/b.ts": `import { type A } from './a.ts'; export type B = number;` }), []);
  assert.deepEqual(auditLayerGraph({ "core/a.ts": `export type { B } from './b.ts';`, "core/b.ts": `import type { A } from './a.ts';` }), []);
  assert.equal(auditLayerGraph({ "core/a.ts": `export * from './b.ts';`, "core/b.ts": `export * from './a.ts';` }).filter((item) => item.kind === "cycle").length, 1);
});
test("frontend cannot import backend, adapters cannot be imported by kernels, and CLI may compose", () => {
  const findings = auditLayerGraph({
    "workbench/a.js": `import { x } from '../core/x.ts';`, "core/x.ts": `import '../adapters/x.ts';`, "adapters/x.ts": `export const x = 1;`,
  });
  assert.deepEqual(findings.map((item) => item.kind), ["frontend", "upward"]);
  assert.deepEqual(auditLayerGraph({ "core/cli.ts": `import './application/x';`, "core/application/x.ts": `export const x = 1;` }), []);
});
test("external imports stay external; unresolved and nonliteral imports fail closed", () => {
  const unresolved = auditLayerGraph({ "core/x.ts": `import fs from 'node:fs'; import './missing'; const x = import(name); export {};`, "capability/craft-eval/run.ts": `import '../../core/x.ts';` });
  assert.deepEqual(unresolved.map((item) => item.kind), ["unresolved", "unresolved"]);
  assert.equal(auditLayerGraph({ "core/x.ts": `const x = import();` })[0].kind, "unresolved");
  assert.deepEqual(auditLayerGraph({ "core/a.ts": `import value, { type A } from './b';`, "core/b/index.ts": `export default 1;` }), []);
  assert.deepEqual(auditLayerGraph({ "core/a.ts": `import * as b from './b.ts';`, "core/b.ts": `export const b = 1;` }), []);
  assert.deepEqual(auditLayerGraph({ "core/infrastructure/a.ts": `export * from './b.ts';;`, "core/infrastructure/b.ts": `export const b = 1;` }), []);
});

test("interface modules may read infrastructure and empty barrels do not invent destinations", () => {
  assert.deepEqual(auditLayerGraph({ "core/a.ts": `import type { A } from './types.js';`, "core/types.d.ts": `export type A = string;` }), []);
  assert.deepEqual(auditLayerGraph({
    "core/interfaces/a.ts": `import '../infrastructure/b.ts'; import '../empty.ts';`,
    "core/infrastructure/b.ts": `export const b = 1;`,
    "core/empty.ts": `export {};`,
  }), []);
});

test("type-only named imports follow only their real re-export, including aliases and star chains", () => {
  const sources = {
    "core/kernel.ts": `import type { Safe as Local } from './mixed.ts'; import { type Safe } from './mixed.ts';`,
    "core/mixed.ts": `export { Domain as Safe } from './star.ts'; export { Command } from './application/command.ts';`,
    "core/star.ts": `export type * from './domain.ts';`,
    "core/domain.ts": `export type Domain = string;`,
    "core/application/command.ts": `export class Command {}`,
  };
  assert.deepEqual(auditLayerGraph(sources), []);
  const runtime = auditLayerGraph({ ...sources, "core/kernel.ts": `import { Safe } from './mixed.ts';` });
  assert.deepEqual(runtime.filter((item) => item.kind === "upward").map((item) => item.path.at(-1)), ["core/application/command.ts"]);
  const unsafe = auditLayerGraph({ ...sources, "core/kernel.ts": `import type { Command } from './mixed.ts';` });
  assert.deepEqual(unsafe.filter((item) => item.kind === "upward").map((item) => item.path.at(-1)), ["core/application/command.ts"]);
  const unknown = auditLayerGraph({ ...sources, "core/kernel.ts": `import type { Unknown } from './mixed.ts';` });
  assert.deepEqual(unknown, []);
});

test("declared Craft package exports participate in direction, cycle and deep-import checks", () => {
  const exports = {
    "craft-common-base": "common/craft-common-base/src/index.ts",
    "craft-common-log": "common/craft-common-log/src/index.ts",
    "@craft/capability-knowledge": "capability/craft-knowledge/capability.ts",
  };
  assert.deepEqual(auditLayerGraph({
    "core/consumer.ts": "import { base } from 'craft-common-base';",
    "common/craft-common-base/src/index.ts": "export const base = 1;",
  }, exports), []);
  const reverse = auditLayerGraph({
    "common/craft-common-base/src/index.ts": "import '@craft/capability-knowledge';",
    "capability/craft-knowledge/capability.ts": "export const knowledge = 1;",
  }, exports);
  assert.equal(reverse[0]?.kind, "upward");
  const cycle = auditLayerGraph({
    "common/craft-common-base/src/index.ts": "import 'craft-common-log';",
    "common/craft-common-log/src/index.ts": "import 'craft-common-base';",
  }, exports);
  assert(cycle.some(item => item.kind === "cycle"));
  const deep = auditLayerGraph({ "core/consumer.ts": "import 'craft-common-base/internal';" }, exports);
  assert.deepEqual(deep, [{ kind: "unresolved", path: ["core/consumer.ts", "craft-common-base/internal"] }]);
});
