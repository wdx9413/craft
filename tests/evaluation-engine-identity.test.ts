import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { Readable } from "node:stream";
import { evaluationEngineIdentity, evaluationExecutable } from "../core/evaluation-engine-identity.ts";

test("evaluation engine identity resolves the actual executable and hashes environment without exposing its values", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-engine-identity-")), oldPath = process.env.PATH;
  const variable = "CRAFT_ENGINE_IDENTITY_TEST_VALUE", previous = process.env[variable];
  try {
    const native = await realpath(process.execPath);
    process.env.PATH = ["relative", join(root, "absent"), dirname(process.execPath)].join(delimiter);
    assert.equal(await evaluationExecutable(basename(process.execPath)), native);
    assert.equal(await evaluationExecutable(process.execPath), native);
    await assert.rejects(evaluationExecutable("../command"), /absolute or a PATH/);
    await assert.rejects(evaluationExecutable("craft-missing-engine-executable"), /was not found/);
    delete process.env.PATH;
    await assert.rejects(evaluationExecutable("craft-missing-engine-executable"), /was not found/);
    assert.equal(await evaluationEngineIdentity({}), null);
    assert.equal(await evaluationEngineIdentity({ host: { kind: "unsupported", binary: process.execPath } }), null);
    const subject = { host: { kind: "claude", binary: process.execPath } };
    process.env[variable] = "first"; const first = await evaluationEngineIdentity(subject);
    process.env[variable] = "second"; const second = await evaluationEngineIdentity(subject);
    assert.ok(first && second); assert.equal(first.executable, native); assert.match(first.sha256, /^[a-f0-9]{64}$/);
    assert.equal(first.sha256, second.sha256); assert.notEqual(first.environment_digest, second.environment_digest);
    assert.equal(JSON.stringify(first).includes('"first"'), false);
    await assert.rejects(evaluationEngineIdentity({ host: { kind: "codex", binary: root } }), /regular-file identity budget/);
    const oversized = join(root, "oversized"); const file = await open(oversized, "w");
    try { await file.truncate(257 * 1024 * 1024); } finally { await file.close(); }
    await assert.rejects(evaluationEngineIdentity({ host: { kind: "codex", binary: oversized } }), /regular-file identity budget/);
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("evaluation engine fingerprint rejects a changing file and enforces its stream byte limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-engine-mutation-")), path = join(root, "engine");
  const original = fs.createReadStream;
  fs.writeFileSync(path, "initial");
  try {
    fs.createReadStream = ((file, options) => {
      const stream = original(file, options);
      stream.once("open", () => { fs.appendFileSync(path, "mutated"); });
      return stream;
    }) as typeof fs.createReadStream;
    syncBuiltinESMExports();
    await assert.rejects(evaluationEngineIdentity({ host: { kind: "claude", binary: path } }), /changed while fingerprinting/);
    // A synthetic oversized stream chunk exercises the counter without allocating 257 MiB.
    const chunk = Buffer.from("x"); Object.defineProperty(chunk, "length", { value: 257 * 1024 * 1024 });
    fs.createReadStream = (() => Readable.from([chunk])) as unknown as typeof fs.createReadStream;
    syncBuiltinESMExports();
    await assert.rejects(evaluationEngineIdentity({ host: { kind: "claude", binary: path } }), /identity byte budget/);
  } finally { fs.createReadStream = original; syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }); }
});
