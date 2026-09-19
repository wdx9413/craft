import assert from "node:assert/strict";
import test from "node:test";
import { defineHostProfile, hostProfilesFromConfig, mergeHostProfiles, resolveHostProfile, hostModelFor, renderHostArgv, defaultDispatchKind, BUILTIN_HOST_PROFILES, ARGV_PLACEHOLDERS } from "../src/host-registry.ts";
import type { JsonObject } from "../src/infrastructure/store.ts";

test("defineHostProfile validates and normalizes a declared host", () => {
  const profile = defineHostProfile({ host: "deepseek-cli", kind: "agent-cli", command: "deepseek", output_format: "text", argv_template: ["-p", "{prompt}"] });
  assert.equal(profile.host, "deepseek-cli");
  assert.equal(profile.label, "deepseek-cli");
  assert.equal(profile.dispatch_kind, "deepseek_cli_dispatch");
  assert.equal(profile.builtin, false);
  assert.deepEqual(profile.argv_template, ["-p", "{prompt}"]);
});

test("defineHostProfile accepts explicit label and dispatch_kind", () => {
  const profile = defineHostProfile({ host: "deepseek-cli", kind: "agent-cli", label: "DeepSeek Driver", command: "deepseek", dispatch_kind: "deepseek_custom", output_format: "text", argv_template: ["-p", "{prompt}"] });
  assert.equal(profile.label, "DeepSeek Driver");
  assert.equal(profile.dispatch_kind, "deepseek_custom");
});

test("defineHostProfile accepts empty models list with null default", () => {
  const profile = defineHostProfile({ host: "simple-cli", kind: "agent-cli", command: "simple", output_format: "text", argv_template: ["-p", "{prompt}"] });
  assert.deepEqual(profile.models, []);
  assert.equal(profile.default_model, null);
});

test("defineHostProfile rejects invalid names", () => {
  assert.throws(() => defineHostProfile({ host: "", kind: "agent-cli", command: "x", output_format: "text", argv_template: ["x"] }), /host must not be empty/);
  assert.throws(() => defineHostProfile({ host: "BadName", kind: "agent-cli", command: "x", output_format: "text", argv_template: ["x"] }), /Unsupported host name/);
});

test("defineHostProfile rejects unsupported kinds and output formats", () => {
  assert.throws(() => defineHostProfile({ host: "x", kind: "unknown", command: "x", output_format: "text", argv_template: ["x"] }), /Unsupported host kind/);
  assert.throws(() => defineHostProfile({ host: "x", kind: "agent-cli", command: "x", output_format: "codex-jsonl", argv_template: ["x"] }), /text output format/);
});

test("defineHostProfile requires a non-empty argv_template for declared hosts", () => {
  assert.throws(() => defineHostProfile({ host: "x", kind: "agent-cli", command: "x", output_format: "text", argv_template: [] }), /non-empty argv_template/);
  assert.throws(() => defineHostProfile({ host: "x", kind: "agent-cli", command: "x", output_format: "text" }), /non-empty argv_template/);
});

test("defineHostProfile validates dispatch_kind and default_model", () => {
  assert.throws(() => defineHostProfile({ host: "x", kind: "agent-cli", command: "x", output_format: "text", argv_template: ["x"], dispatch_kind: "123" }), /Unsupported host dispatch kind/);
  assert.throws(() => defineHostProfile({ host: "x", kind: "agent-cli", command: "x", output_format: "text", argv_template: ["x"], models: ["a"], default_model: "b" }), /default_model must be one/);
  const ok = defineHostProfile({ host: "x", kind: "agent-cli", command: "x", output_format: "text", argv_template: ["x"], models: ["a", "b"], default_model: "a" });
  assert.equal(ok.default_model, "a");
});

test("hostProfilesFromConfig parses and validates an array", () => {
  assert.deepEqual(hostProfilesFromConfig(undefined), []);
  assert.deepEqual(hostProfilesFromConfig(null), []);
  const profiles = hostProfilesFromConfig([{ host: "a", kind: "agent-cli", command: "x", output_format: "text", argv_template: ["x"] }]);
  assert.equal(profiles.length, 1);
  assert.throws(() => hostProfilesFromConfig("bad"), /array/);
  assert.throws(() => hostProfilesFromConfig([{ host: "a", kind: "agent-cli", command: "x", output_format: "text", argv_template: ["x"] }, { host: "a", kind: "agent-cli", command: "y", output_format: "text", argv_template: ["y"] }]), /repeat/);
});

test("mergeHostProfiles refuses to shadow builtins", () => {
  const declared = defineHostProfile({ host: "custom", kind: "agent-cli", command: "x", output_format: "text", argv_template: ["x"] });
  const merged = mergeHostProfiles([declared]);
  assert.equal(merged.length, BUILTIN_HOST_PROFILES.length + 1);
  assert.throws(() => mergeHostProfiles([{ ...declared, host: "codex-cli" }]), /shadow/);
});

test("resolveHostProfile finds or fails closed", () => {
  const profile = resolveHostProfile(BUILTIN_HOST_PROFILES, "codex-cli");
  assert.equal(profile.host, "codex-cli");
  assert.throws(() => resolveHostProfile(BUILTIN_HOST_PROFILES, "missing"), /Unknown host profile/);
});

test("hostModelFor resolves explicit, default, and rejects unknown", () => {
  const p = defineHostProfile({ host: "x", kind: "agent-cli", command: "x", output_format: "text", argv_template: ["x"], models: ["a", "b"], default_model: "a" });
  assert.equal(hostModelFor(p, "b"), "b");
  assert.equal(hostModelFor(p, null), "a");
  assert.equal(hostModelFor(p, undefined), "a");
  assert.throws(() => hostModelFor(p, "c"), /does not declare model/);
  // profile with no declared models returns the explicit value without checking
  const noModels = defineHostProfile({ host: "y", kind: "agent-cli", command: "y", output_format: "text", argv_template: ["x"] });
  assert.equal(hostModelFor(noModels, "anything"), "anything");
});

test("renderHostArgv substitutes placeholders and reports prompt_in_argv", () => {
  const r1 = renderHostArgv(["{prompt}", "{workspace}"], { prompt: "hi", workspace: "/ws", model: "m", sandbox: "s" });
  assert.deepEqual(r1.argv, ["hi", "/ws"]);
  assert.equal(r1.prompt_in_argv, true);
  const r2 = renderHostArgv(["{model}", "{sandbox}"], { prompt: "hi", workspace: "/ws", model: "m", sandbox: "s" });
  assert.deepEqual(r2.argv, ["m", "s"]);
  assert.equal(r2.prompt_in_argv, false);
  assert.throws(() => renderHostArgv(["{unknown}"], { prompt: "", workspace: "", model: "", sandbox: "" }), /Unsupported argv placeholder/);
  // token without known placeholder stays as-is (no placeholder token)
  const r3 = renderHostArgv(["plain-token"], { prompt: "p", workspace: "w", model: "m", sandbox: "s" });
  assert.deepEqual(r3.argv, ["plain-token"]);
  assert.equal(r3.prompt_in_argv, false);
  // missing key in values falls back to empty string
  const r4 = renderHostArgv(["{prompt}"], { });
  assert.deepEqual(r4.argv, [""]);
  assert.equal(r4.prompt_in_argv, true);
});

test("defaultDispatchKind replaces hyphens with underscores", () => {
  assert.equal(defaultDispatchKind("my-host"), "my_host_dispatch");
});
