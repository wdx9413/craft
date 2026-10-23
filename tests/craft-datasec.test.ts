import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { mock } from "node:test";
import { DEFAULT_RULES, Sanitizer, type Json } from "../capability/craft-datasec/rules.ts";
import { TokenVault } from "../capability/craft-datasec/vault.ts";
import { blank, blankResult, FAILURE, handleHook, type Event, type HookInput, type Host } from "../capability/craft-datasec/hook.ts";
import { allReleaseProducts, externalDistributionContract, externalMarketplaceProducts, releaseManifest, releaseProduct, releaseProductNames } from "../core/release-catalog.ts";

// Synthetic values are assembled to keep literal PII-shaped data out of the source fixture.
const phone = ["138", "1234", "5678"].join("");
const identity = ["110105", "19900307", "6754"].join("");
const bank = ["622202", "1234567890123"].join("");
const project = resolve(import.meta.dirname, "..");
test("independent Datasec is discoverable in release catalogs without joining the Context runtime", () => {
  assert.equal(releaseProduct("craft-datasec")!.surface, "standalone-hooks");
  assert.equal(releaseProduct("unknown"), undefined);
  assert.deepEqual(releaseProductNames(), ["craft", "craft-context", "craft-datasec"]);
  assert.equal(allReleaseProducts().length, 3);
  assert.deepEqual(externalMarketplaceProducts().map(product => product.name), ["craft-context", "craft-datasec"]);
  const contract = externalDistributionContract();
  assert.equal(contract.products.find(product => product.name === "craft-datasec")!.version, "0.1.2");
  assert.equal(contract.products.find(product => product.name === "craft-context")!.hook_member, "context");
  assert(releaseManifest().plugins.some(product => product.name === "craft-datasec"));
});

function fixture() {
  const temp = mkdtempSync(join(tmpdir(), "craft-datasec-test-"));
  return { temp, root: join(temp, "vault"), close() { rmSync(temp, { recursive: true, force: true }); } };
}
function run(host: Host, event: Event, input: HookInput, root: string, rules = DEFAULT_RULES): any {
  return handleHook(host, event, { hook_event_name: event, session_id: "fixture-session", ...input }, root, rules);
}
function invoke(args: string[], raw: string, root?: string, config?: string, bundle = false) {
  return spawnSync(process.execPath, ["--experimental-strip-types", resolve(project, bundle ? "plugins/craft-datasec/dist/hook.mjs" : "bin/craft-datasec-hook.ts"), ...args], {
    encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1", CRAFT_DATASEC_DIR: root, CRAFT_DATASEC_RULES: config }, input: raw,
  });
}

test("all default categories redact locally, preserve field names, and make optional names configurable", () => {
  const samples: Record<string, string> = {
    phone: `+86 ${phone.slice(0, 3)} ${phone.slice(3, 7)} ${phone.slice(7)}`,
    identity, ipv4: ["192", "168", "1", "100"].join("."), bank,
    api_key: '"api_key": "fictional_access_key_abcdefghijklmnop"', password: "password=FictionalPassword!",
    jwt: "eyJfictionalHeaderPart.eyJfictionalPayloadPart.fictionalSignaturePart",
    private_key: "-----BEGIN OPENSSH PRIVATE KEY-----\nfictional\n-----END OPENSSH PRIVATE KEY-----",
  };
  for (const [name, text] of Object.entries(samples)) {
    const sanitizer = new Sanitizer(DEFAULT_RULES, rule => `<${rule}>`);
    assert(sanitizer.text(text).includes(`<${name}>`), name);
    assert.equal(sanitizer.count, 1, name);
  }
  const text = '姓名：张三';
  assert.equal(new Sanitizer(DEFAULT_RULES, () => "hidden").text(text), text);
  const names = DEFAULT_RULES.map(rule => ({ ...rule, enabled: true }));
  assert.equal(new Sanitizer(names, () => "hidden").text(text), "姓名：hidden");
  assert.equal(new Sanitizer(DEFAULT_RULES, () => "hidden").text(`"password": "fictional"`), '"password": "hidden"');
  assert.equal(new Sanitizer(DEFAULT_RULES, () => "hidden").text(`const mobile = "${phone}";`), 'const mobile = "hidden";');
});

test("default email rule keeps the first local character and domain without storing a mapping", () => {
  const email = ["w1231321312", "123.com"].join("@");
  const masked = ["w*", "123.com"].join("@");
  const sanitizer = new Sanitizer(DEFAULT_RULES, () => { throw new Error("email must not create a token"); });
  assert.equal(sanitizer.text(`contact ${email}`), `contact ${masked}`);
  assert.equal(sanitizer.text(["a", "example.com"].join("@")), ["a*", "example.com"].join("@"));
  assert.equal(sanitizer.count, 2);
  assert.throws(() => new Sanitizer([{ name: "email", pattern: "local" }], () => "hidden").text("local"), /Invalid email rule match/);

  const f = fixture();
  try {
    const result = run("claude", "PostToolUse", { tool_response: { stdout: email } }, f.root);
    assert.equal(result.hookSpecificOutput.updatedToolOutput.stdout, masked);
    assert.equal(existsSync(f.root), false);
  } finally { f.close(); }
});

test("boundaries, overlap priority, captures, zero-width patterns and existing placeholders are safe", () => {
  const rules = [{ name: "short", pattern: "secret" }, { name: "long", pattern: "secret-value" }, { name: "empty", pattern: "^" }, { name: "optional", pattern: "(missing)?safe", group: 1 }];
  const sanitizer = new Sanitizer(rules, name => `[${name}]`);
  assert.equal(sanitizer.text("secret-value safe"), "[long] safe");
  assert.equal(sanitizer.count, 1);
  const standard = new Sanitizer(DEFAULT_RULES, () => "hidden");
  assert.equal(standard.text(`9${phone}0 999.1.1.1`), `9${phone}0 999.1.1.1`);
  const token = `[CRAFT_DATASEC_phone_${"a".repeat(10)}${phone}${"a".repeat(11)}]`;
  assert.equal(standard.text(token), token);
  assert.equal(standard.text("no matches"), "no matches");
  for (const rule of [{ name: "bad-name", pattern: "a" }, { name: "fine", pattern: "" }, { name: "fine", pattern: "a", group: -1 }, { name: "fine", pattern: "a", group: 0.5 }, { name: "fine", pattern: "[" }]) {
    assert.throws(() => new Sanitizer([rule], () => "hidden"));
  }
  assert.throws(() => new Sanitizer([], () => "hidden"));
});

test("nested JSON masks strings, numeric PII and sensitive keys while retaining non-sensitive values", () => {
  const sanitizer = new Sanitizer(DEFAULT_RULES, () => "hidden");
  assert.deepEqual(sanitizer.value({ [phone]: [phone, Number(phone), 42, true, false, null, { normal: "safe" }] }), {
    hidden: ["hidden", "hidden", 42, true, false, null, { normal: "safe" }],
  });
  assert.equal(sanitizer.count, 3);
});

test("private session mappings are stable, isolated, reversible and never change source files", () => {
  const f = fixture();
  try {
    const source = join(f.temp, "JsonUtilTest.java"); writeFileSync(source, phone);
    const vault = new TokenVault(f.root, "first");
    const token = vault.token("phone", phone);
    assert.equal(vault.token("phone", phone), token);
    assert.equal(new TokenVault(f.root, "first").token("phone", phone), token);
    assert.notEqual(new TokenVault(f.root, "other").token("phone", phone), token);
    assert.notEqual(vault.token("password", phone), token);
    assert.equal(vault.restore(`before ${token} after`), `before ${phone} after`);
    assert.equal(readFileSync(source, "utf8"), phone);
    assert.equal(lstatSync(f.root).mode & 0o777, 0o700);
    const directory = join(f.root, createHash("sha256").update("first").digest("hex"));
    assert.equal(lstatSync(join(directory, "key")).mode & 0o777, 0o600);
    assert(readdirSync(directory).every(name => !name.startsWith(".write-")));
    assert.throws(() => vault.restore("[CRAFT_DATASEC_phone_broken]"));
    assert.throws(() => vault.restore(`[CRAFT_DATASEC_phone_${"f".repeat(32)}]`));
    assert.throws(() => new TokenVault(f.root, ""));
    vault.flush(); vault.flush();
    const db = new DatabaseSync(join(directory, "mappings.sqlite"));
    db.prepare("UPDATE mappings SET value = ? WHERE token = ?").run("tampered", token); db.close();
    assert.throws(() => vault.restore(token), /Invalid mapping/);
    chmodSync(join(directory, "key"), 0o644);
    assert.throws(() => new TokenVault(f.root, "first"), /Unsafe vault file/);
    vault.close(); vault.close();
  } finally { f.close(); }
});

test("vault rejects public directories, symlinks, corrupt keys, wrong owners and failed publication", () => {
  const f = fixture();
  try {
    mkdirSync(f.root, { mode: 0o755 }); assert.throws(() => new TokenVault(f.root, "session"));
    chmodSync(f.root, 0o700);
    const link = join(f.temp, "link"); symlinkSync(f.root, link); assert.throws(() => new TokenVault(link, "session"));
    new TokenVault(f.root, "session");
    const key = join(f.root, createHash("sha256").update("session").digest("hex"), "key");
    writeFileSync(key, "corrupt"); assert.throws(() => new TokenVault(f.root, "session"), /Invalid vault key/);
    const owner = mock.method(process as { getuid: () => number }, "getuid", () => -1);
    assert.throws(() => new TokenVault(f.root, "session"), /Unsafe vault directory/); owner.mock.restore();
    const linkMock = mock.method(fs, "linkSync", () => { throw Object.assign(new Error("test IO failure"), { code: "EIO" }); }); syncBuiltinESMExports();
    assert.throws(() => new TokenVault(f.root, "io"), /test IO failure/);
    linkMock.mock.restore(); syncBuiltinESMExports();
  } finally { mock.restoreAll(); syncBuiltinESMExports(); f.close(); }
});

test("mapping database initialization and transactions fail safely and retain retryable pending records", () => {
  const f = fixture();
  try {
    const directory = join(f.root, createHash("sha256").update("sql").digest("hex"));
    const vault = new TokenVault(f.root, "sql");
    const db = new DatabaseSync(join(directory, "mappings.sqlite"));
    db.exec("CREATE TRIGGER reject_mapping BEFORE INSERT ON mappings BEGIN SELECT RAISE(FAIL, 'fixture rejection'); END;");
    const token = vault.token("phone", phone);
    assert.throws(() => vault.flush(), /fixture rejection/);
    assert.equal(db.prepare("SELECT count(*) AS total FROM mappings").get()!.total, 0);
    db.exec("DROP TRIGGER reject_mapping"); vault.flush();
    assert.equal(vault.restore(token), phone);
    assert.equal(lstatSync(join(directory, "mappings.sqlite")).mode & 0o777, 0o600);
    db.close(); vault.close();
    writeFileSync(join(directory, "mappings.sqlite"), "not a sqlite database");
    assert.throws(() => new TokenVault(f.root, "sql"));
  } finally { f.close(); }
});

for (const host of ["claude", "codex"] as const) {
  test(`${host} hook masks results and restores only local edits, without asynchronous reviews`, () => {
    const f = fixture();
    try {
      const original = { type: "text", file: { filePath: "JsonUtilTest.java", content: `mobile="${phone}"`, numLines: 1 } };
      const result = run(host, "PostToolUse", { tool_name: "Read", tool_response: original }, f.root);
      const safe = host === "claude" ? result.hookSpecificOutput.updatedToolOutput : JSON.parse(result.reason);
      assert(!JSON.stringify(result).includes(phone));
      assert.equal(safe.type, "text"); assert.equal(safe.file.filePath, original.file.filePath);
      const token = safe.file.content.match(/\[CRAFT_DATASEC_.*?\]/)[0];
      const args = { file_path: "JsonUtilTest.java", old_string: safe.file.content, new_string: [safe.file.content + ";", 1, false, null, { [token]: token }] };
      const edit = run(host, "PreToolUse", { tool_name: "Edit", tool_input: args }, f.root);
      assert.equal(edit.hookSpecificOutput.permissionDecision, "allow");
      assert.equal(edit.hookSpecificOutput.updatedInput.old_string, original.file.content);
      assert.deepEqual(edit.hookSpecificOutput.updatedInput.new_string, [original.file.content + ";", 1, false, null, { [phone]: phone }]);
      assert.equal(run(host, "PreToolUse", { tool_name: "Bash", tool_input: { command: `echo ${token}` } }, f.root).hookSpecificOutput.permissionDecision, "deny");
      assert.equal(run(host, "PreToolUse", { tool_name: "Write", tool_input: { content: "[CRAFT_DATASEC_unknown]" } }, f.root).hookSpecificOutput.permissionDecision, "deny");
      assert.deepEqual(run(host, "PostToolUse", { tool_response: safe }, f.root), {});
      assert.equal(original.file.content, `mobile="${phone}"`);
      if (host === "codex") { assert.equal(result.continue, undefined); assert.equal(result.decision, "block"); }
    } finally { f.close(); }
  });
  test(`${host} prompts pass through without scanning, blocking, echoing or storing their content`, () => {
    const f = fixture();
    try {
      assert.deepEqual(run(host, "UserPromptSubmit", {}, f.root), {});
      assert.deepEqual(run(host, "UserPromptSubmit", { prompt: "read the file" }, f.root), {});
      const result = run(host, "UserPromptSubmit", { prompt: phone }, f.root);
      assert.deepEqual(result, {}); assert(!existsSync(f.root));
      assert.deepEqual(run(host, "UserPromptSubmit", { prompt: phone }, f.root, []), {});
    } finally { f.close(); }
  });
  test(`${host} safe calls are unchanged; binary Read, bad rules, missing identity and malformed events are guarded`, () => {
    const f = fixture();
    try {
      for (const tool_input of [undefined, null, [], "text", {}, { file_path: 42 }, { file_path: "safe.java" }] as Array<Json | undefined>) {
        assert.deepEqual(run(host, "PreToolUse", { tool_name: "Read", tool_input }, f.root), {});
      }
      assert.deepEqual(run(host, "PreToolUse", {}, f.root), {});
      assert.equal(run(host, "PreToolUse", { tool_name: "Read", tool_input: { file_path: "file.XLSX" } }, f.root).hookSpecificOutput.permissionDecision, "deny");
      assert.deepEqual(run(host, "PostToolUse", { tool_response: null }, f.root), {});
      const missing = run(host, "PostToolUse", {}, f.root);
      assert(JSON.stringify(missing).includes(FAILURE));
      const failed = run(host, "PostToolUse", { session_id: undefined, tool_response: { type: "text", stdout: phone, count: 12, data: [false, null], [phone]: phone } }, f.root);
      assert(!JSON.stringify(failed).includes(phone)); assert.equal(failed.continue, false);
      assert(JSON.stringify(run(host, "PostToolUse", { tool_response: phone }, f.root, [])).includes(FAILURE));
      assert.equal(run(host, "PreToolUse", { hook_event_name: "bad" }, f.root).hookSpecificOutput.permissionDecision, "deny");
      assert.deepEqual(run(host, "UserPromptSubmit", { hook_event_name: "bad" }, f.root), {});
    } finally { f.close(); }
  });
}

test("error fallback removes strings, numbers and unsafe object keys but retains schema discriminators", () => {
  assert.deepEqual(blank({ stdout: phone, type: "text", file: { filePath: phone }, [phone]: [Number(phone), true, null] }), {
    stdout: "", type: "text", file: { filePath: "" }, hidden_3: [0, true, null],
  });
  assert.equal(blankResult("anything"), "");
  let deep: Json = phone;
  for (let i = 0; i < 70; i++) deep = i % 2 ? { child: deep } : [deep];
  assert(!JSON.stringify(blankResult(deep)).includes(phone));
  const f = fixture();
  try {
    const response = run("claude", "PostToolUse", { tool_response: deep }, f.root);
    assert.equal(response.continue, false); assert(!JSON.stringify(response).includes(phone));
  } finally { f.close(); }
});

test("resource-close errors propagate to the process-level safe fallback rather than returning a partial result", () => {
  const f = fixture();
  const close = mock.method(TokenVault.prototype, "close", () => { throw new Error("fixture close failure"); });
  try {
    assert.throws(() => run("claude", "PostToolUse", { tool_response: phone }, f.root), /fixture close failure/);
  } finally { close.mock.restore(); f.close(); }
});

test("process entry validates events/configuration and never echoes bad input or errors", () => {
  const f = fixture();
  try {
    assert.equal(invoke([], "", f.root).status, 2);
    assert.equal(invoke(["wrong", "PostToolUse"], "", f.root).status, 2);
    for (const host of ["claude", "codex"]) {
      for (const event of ["PreToolUse", "UserPromptSubmit", "PostToolUse"]) {
        for (const raw of ["not-json", "null", "[]", "1"]) {
          const result = invoke([host, event], raw, f.root);
          assert.equal(result.status, 0, result.stderr);
          if (event === "UserPromptSubmit") assert.deepEqual(JSON.parse(result.stdout), {});
          else assert(JSON.stringify(JSON.parse(result.stdout)).includes(FAILURE));
        }
      }
    }
    const input = JSON.stringify({ hook_event_name: "PostToolUse", session_id: "cli", tool_response: { stdout: phone, stderr: "" } });
    const good = invoke(["claude", "PostToolUse"], input, f.root);
    assert.equal(good.status, 0, good.stderr); assert(!good.stdout.includes(phone));
    const config = join(f.temp, "rules.json"); writeFileSync(config, JSON.stringify([{ name: "custom", pattern: "fictional" }]));
    const custom = invoke(["claude", "PostToolUse"], input.replace(phone, "fictional"), f.root, config);
    assert(!custom.stdout.includes('"fictional"'));
    for (const data of ["bad", "null", "{}"]) {
      writeFileSync(config, data);
      const failed = invoke(["claude", "PostToolUse"], input, f.root, config);
      assert(JSON.parse(failed.stdout).systemMessage.includes(FAILURE)); assert(!failed.stdout.includes(phone));
    }
    assert(JSON.parse(invoke(["codex", "PreToolUse"], "{}", f.root, join(f.temp, "missing")).stdout).hookSpecificOutput.permissionDecision === "deny");
    for (const host of ["claude", "codex"]) {
      const prompt = JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: phone });
      for (const configPath of [undefined, config, join(f.temp, "missing")]) {
        const passed = invoke([host, "UserPromptSubmit"], prompt, f.root, configPath);
        assert.equal(passed.status, 0, passed.stderr);
        assert.deepEqual(JSON.parse(passed.stdout), {});
      }
    }
    const clean = invoke(["claude", "UserPromptSubmit"], JSON.stringify({ hook_event_name: "UserPromptSubmit" }));
    assert.deepEqual(JSON.parse(clean.stdout), {});
  } finally { f.close(); }
});

test("concurrent hook processes publish complete stable mappings without a shared write lock", async () => {
  const f = fixture();
  try {
    const payload = JSON.stringify({ hook_event_name: "PostToolUse", session_id: "concurrent", tool_response: { stdout: phone, stderr: "" } });
    const outputs = await Promise.all(Array.from({ length: 6 }, () => new Promise<string>((done, reject) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", resolve(project, "bin/craft-datasec-hook.ts"), "claude", "PostToolUse"], { env: { ...process.env, NODE_NO_WARNINGS: "1", CRAFT_DATASEC_DIR: f.root }, stdio: ["pipe", "pipe", "pipe"] });
      let out = ""; child.stdout.on("data", chunk => out += chunk); child.on("error", reject);
      child.on("close", code => code === 0 ? done(out) : reject(new Error(`child exit ${code}`))); child.stdin.end(payload);
    })));
    assert(outputs.every(out => out === outputs[0]));
    const safe = JSON.parse(outputs[0]).hookSpecificOutput.updatedToolOutput.stdout;
    assert.equal(new TokenVault(f.root, "concurrent").restore(safe), phone);
  } finally { f.close(); }
});

test("independent plugin builds and executes both packaged hook manifests without Context or MCP", () => {
  const build = spawnSync(process.execPath, ["--experimental-strip-types", resolve(project, "capability/craft-datasec/build.ts")], { encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);
  const f = fixture();
  try {
    for (const host of ["claude", "codex"] as const) {
      const directory = resolve(project, "plugins/craft-datasec");
      const manifest = JSON.parse(readFileSync(join(directory, `.${host}-plugin/plugin.json`), "utf8"));
      assert.equal(manifest.name, "craft-datasec"); assert.equal(manifest.mcpServers, undefined);
      const hooks = JSON.parse(readFileSync(join(directory, manifest.hooks), "utf8")).hooks;
      for (const [event, groups] of Object.entries(hooks)) {
        const handler = (groups as any)[0].hooks[0];
        assert(!handler.async); assert.equal(handler.timeout, 10);
        const variable = host === "claude" ? "CLAUDE_PLUGIN_ROOT" : "PLUGIN_ROOT";
        assert.equal(handler.command, `node --disable-warning=ExperimentalWarning "\${${variable}}/dist/hook.mjs" ${host} ${event}`);
        const payload = JSON.stringify({ hook_event_name: event, session_id: "packaged", prompt: phone, tool_response: { stdout: phone, stderr: "" } });
        const child = invoke([host, event], payload, f.root, undefined, true);
        assert.equal(child.status, 0, child.stderr); assert(!child.stdout.includes(phone)); JSON.parse(child.stdout);
      }
      const bundle = readFileSync(join(directory, "dist/hook.mjs"), "utf8");
      assert(!bundle.includes("craft-context")); assert(!bundle.includes("CraftStore"));
    }
  } finally { f.close(); }
});
