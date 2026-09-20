import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { JsonObject } from "../src/infrastructure/store.ts";
import {
  MCP_ASSESSED_REVISION,
  MCP_MIGRATION_STATUS,
  MCP_PREFERRED_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSIONS,
  assessMcpMigration,
  createCredentialResolver,
  distributionPlan,
  firstRunReadiness,
  isolationCapability,
  negotiateProtocolVersion,
  readCredentialFile
} from "../src/distribution-and-first-run.ts";

async function workspace(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "craft-v01233-"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("v0.12.34 resolves credentials so an installed overlay outranks the ambient environment", () => {
  const ambient: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: "from-machine", ARK_API_KEY: "keep" };
  const overlay: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: "pasted-in-studio", EMPTY: "" };
  const resolved = createCredentialResolver([ambient, overlay]).env;
  // The overlay is the user's explicit choice, so it wins over the machine value.
  assert.equal(resolved.DEEPSEEK_API_KEY, "pasted-in-studio");
  assert.equal(resolved.ARK_API_KEY, "keep");
  // Empty values are not credentials and must not register as configured.
  assert.equal("EMPTY" in resolved, false);
  assert.deepEqual(createCredentialResolver([]).env, {});
});

test("v0.12.34 reports first-run readiness as a user-facing metric", () => {
  const models: JsonObject[] = [
    { id: "a", apiKeyEnv: "DEEPSEEK_API_KEY" },
    { id: "b", apiKeyEnv: "OPENAI_API_KEY" }
  ];
  const ready = firstRunReadiness({ models, env: { DEEPSEEK_API_KEY: "x" } });
  assert.equal(ready.usable, true);
  assert.equal(ready.configured_count, 1);
  assert.equal(ready.blocked_count, 1);
  assert.equal(ready.remedy, null);
  assert.equal(ready.credential_source, "process_environment");
  assert.equal((ready.models as JsonObject[]).length, 2);

  // An empty string is present but not a credential, so it counts as blocked.
  const blank = firstRunReadiness({ models: [{ id: "a", apiKeyEnv: "DEEPSEEK_API_KEY" }], env: { DEEPSEEK_API_KEY: "" } });
  assert.equal(blank.usable, false);
  assert.equal(blank.configured_count, 0);

  // Nothing configured: the remedy must name the exact variable to set.
  const blocked = firstRunReadiness({ models, env: {}, credential_source: "desktop_launcher" });
  assert.equal(blocked.usable, false);
  assert.match(String(blocked.remedy), /DEEPSEEK_API_KEY/u);
  assert.equal(blocked.credential_source, "desktop_launcher");

  // No models at all is a different failure and needs a different remedy.
  const empty = firstRunReadiness({ models: [] });
  assert.equal(empty.usable, false);
  assert.match(String(empty.remedy), /add a model/u);
  assert.equal(empty.blocked_count, 0);

  // `models` absent or not an array must take the fallback rather than throw.
  assert.deepEqual(firstRunReadiness({}).models, []);
  assert.deepEqual(firstRunReadiness({ models: "not-an-array" }).models, []);
  assert.deepEqual(firstRunReadiness({ models: null }).models, []);
  // An absent `env` falls back to an empty overlay, not to process.env.
  assert.equal(firstRunReadiness({ models: [] , env: undefined }).configured_count, 0);

  // A malformed env name must fail loudly rather than silently report unusable.
  assert.throws(() => firstRunReadiness({ models: [{ id: "x", apiKeyEnv: "lowercase" }] }), /uppercase environment-variable name/u);
  assert.throws(() => firstRunReadiness({ models: [{ id: "", apiKeyEnv: "A" }] }), /model\.id must not be empty/u);
  // A non-string field takes the other side of the type guard.
  assert.throws(() => firstRunReadiness({ models: [{ id: 7, apiKeyEnv: "A" }] }), /model\.id must not be empty/u);
  assert.throws(() => firstRunReadiness({ models: [{ id: "a", apiKeyEnv: 7 }] }), /model\.apiKeyEnv must not be empty/u);

  // The remedy names the first blocked variable deterministically.
  const twoBlocked = firstRunReadiness({ models: [{ id: "a", apiKeyEnv: "AAA_KEY" }, { id: "b", apiKeyEnv: "BBB_KEY" }] });
  assert.equal(twoBlocked.remedy, "set AAA_KEY or paste a key in Studio settings");
  // A usable product reports no remedy even when other models are unconfigured.
  const partly = firstRunReadiness({ models: [{ id: "a", apiKeyEnv: "AAA_KEY" }, { id: "b", apiKeyEnv: "BBB_KEY" }], env: { AAA_KEY: "v" } });
  assert.equal(partly.usable, true);
  assert.equal(partly.remedy, null);
});

test("v0.12.34 negotiates the MCP protocol version and records a downgrade instead of hiding it", () => {
  for (const version of MCP_PROTOCOL_VERSIONS) {
    const negotiation = negotiateProtocolVersion(version);
    assert.equal(negotiation.negotiated, version);
    assert.equal(negotiation.downgraded, false);
    assert.equal(negotiation.reason, "requested_version_supported");
    assert.equal(negotiation.migration_status, MCP_MIGRATION_STATUS);
    assert.equal(negotiation.assessed_revision, MCP_ASSESSED_REVISION);
  }

  // A client that never negotiates is not a downgrade.
  const absent = negotiateProtocolVersion(undefined);
  assert.equal(absent.negotiated, MCP_PREFERRED_PROTOCOL_VERSION);
  assert.equal(absent.requested, null);
  assert.equal(absent.downgraded, false);
  assert.equal(absent.reason, "client_did_not_negotiate");

  // The 2026-07-28 revision is not spoken yet, and asking for it is recorded.
  const future = negotiateProtocolVersion("2026-07-28");
  assert.equal(future.negotiated, MCP_PREFERRED_PROTOCOL_VERSION);
  assert.equal(future.requested, "2026-07-28");
  assert.equal(future.downgraded, true);
  assert.equal(future.reason, "requested_version_unsupported");

  assert.equal(negotiateProtocolVersion("   ").reason, "client_did_not_negotiate");
  assert.equal(negotiateProtocolVersion(42).reason, "client_did_not_negotiate");
});

test("v0.12.34 refuses to adopt the 2026-07-28 revision while MRTR and Tasks are unresolved", () => {
  const blocked = assessMcpMigration({ has_durable_tasks: true });
  assert.equal(blocked.status, "blocked");
  assert.equal((blocked.blocking as string[]).length, 2);
  assert.match(String(blocked.guidance), /not backward compatible/u);

  // A host that speaks MRTR but has an unmapped task model is still blocked.
  const halfWay = assessMcpMigration({ host_supports_mrtr: true, has_durable_tasks: true });
  assert.equal(halfWay.status, "blocked");
  assert.equal((halfWay.blocking as string[]).length, 1);

  const ready = assessMcpMigration({ host_supports_mrtr: true, has_durable_tasks: true, tasks_extension_adopted: true });
  assert.equal(ready.status, "ready");
  assert.deepEqual(ready.blocking, []);
  assert.match(String(ready.guidance), /transport compatibility/u);

  // No durable task model means only the MRTR question remains.
  assert.equal(assessMcpMigration({ host_supports_mrtr: true }).status, "ready");
  assert.equal(assessMcpMigration({}).status, "blocked");
});

test("v0.12.34 states platform isolation honestly, including that Windows is not enforced", () => {
  const darwin = isolationCapability("darwin");
  assert.equal(darwin.enforced, true);
  assert.equal(darwin.autonomous_generated_code, true);
  assert.equal(darwin.mechanism, "sandbox-exec");

  const linux = isolationCapability("linux");
  assert.equal(linux.enforced, true);
  assert.equal(linux.mechanism, "bwrap");

  // The Windows answer must not claim a backend it does not have.
  const win32 = isolationCapability("win32");
  assert.equal(win32.enforced, false);
  assert.equal(win32.mechanism, null);
  assert.equal(win32.autonomous_generated_code, false);
  assert.match(String(win32.note), /require approval/u);

  assert.throws(() => isolationCapability("plan9"), /Unsupported platform/u);
});

test("v0.12.34 answers where a user actually downloads the desktop build", () => {
  const unavailable = distributionPlan({ version: "0.12.34", repository: "wdx9413/craft" });
  assert.equal(unavailable.user_download_available, false);
  assert.equal(unavailable.channel, "developer_command_only");
  assert.equal((unavailable.assets as JsonObject[]).every((asset) => asset.url === null), true);
  assert.deepEqual(unavailable.remainder, ["publish a GitHub release so assets are attached", "build the DMG on a native macOS runner"]);

  const available = distributionPlan({ version: "0.12.34", repository: "wdx9413/craft", release_assets_available: true });
  assert.equal(available.user_download_available, true);
  assert.equal(available.channel, "github_release_asset");
  assert.deepEqual(available.remainder, []);
  const windows = (available.assets as JsonObject[])[0]!;
  assert.match(String(windows.url), /releases\/download\/v0\.12\.34\/craft-workbench-windows-v0\.12\.34\.zip$/u);
  const macos = (available.assets as JsonObject[])[1]!;
  assert.equal(macos.requires_runner, "macos-latest");

  assert.throws(() => distributionPlan({ repository: "a/b" }), /version must not be empty/u);
});

test("v0.12.34 reads a launcher-written credential file and never leaks values into its report", async () => {
  const space = await workspace();
  try {
    const missing = readCredentialFile(path.join(space.root, "absent.env"));
    assert.equal(missing.found, false);
    assert.deepEqual(missing.names, []);
    assert.deepEqual(missing.env, {});

    const file = path.join(space.root, "credentials.env");
    await writeFile(file, "# Craft desktop credentials\n\nDEEPSEEK_API_KEY=sk-secret-value\nARK_API_KEY = ark-value \n", "utf8");
    const parsed = readCredentialFile(file);
    assert.equal(parsed.found, true);
    assert.deepEqual(parsed.names, ["ARK_API_KEY", "DEEPSEEK_API_KEY"]);
    assert.equal((parsed.env as NodeJS.ProcessEnv).DEEPSEEK_API_KEY, "sk-secret-value");
    assert.equal((parsed.env as NodeJS.ProcessEnv).ARK_API_KEY, "ark-value");
    // The report itself carries names only; the secret must not appear in it.
    assert.equal(JSON.stringify(parsed.names).includes("sk-secret-value"), false);

    const malformed = path.join(space.root, "malformed.env");
    await writeFile(malformed, "NOEQUALS\n", "utf8");
    assert.throws(() => readCredentialFile(malformed), /Malformed credential line/u);

    // A line that begins with '=' has no usable name and is malformed too.
    const noName = path.join(space.root, "noname.env");
    await writeFile(noName, "=value\n", "utf8");
    assert.throws(() => readCredentialFile(noName), /Malformed credential line/u);

    // Values containing '=' keep everything after the first separator.
    const embedded = path.join(space.root, "embedded.env");
    await writeFile(embedded, "DEEPSEEK_API_KEY=abc=def\n", "utf8");
    assert.equal((readCredentialFile(embedded).env as NodeJS.ProcessEnv).DEEPSEEK_API_KEY, "abc=def");

    const lower = path.join(space.root, "lower.env");
    await writeFile(lower, "lowercase_key=value\n", "utf8");
    assert.throws(() => readCredentialFile(lower), /uppercase environment-variable name/u);

    const blank = path.join(space.root, "blank.env");
    await writeFile(blank, "DEEPSEEK_API_KEY=\n", "utf8");
    assert.throws(() => readCredentialFile(blank), /must not be empty/u);

    // A credential file with only comments yields no names but is still found.
    const comments = path.join(space.root, "comments.env");
    await writeFile(comments, "# nothing here\n", "utf8");
    const empty = readCredentialFile(comments);
    assert.equal(empty.found, true);
    assert.deepEqual(empty.names, []);
  } finally {
    await space.cleanup();
  }
});

test("v0.12.34 feeds a credential file straight into readiness for a desktop first run", async () => {
  const space = await workspace();
  try {
    const file = path.join(space.root, "credentials.env");
    await writeFile(file, "DEEPSEEK_API_KEY=sk-from-desktop\n", "utf8");
    const credentials = readCredentialFile(file);
    const readiness = firstRunReadiness({
      models: [{ id: "deepseek", apiKeyEnv: "DEEPSEEK_API_KEY" }],
      env: credentials.env,
      credential_source: "desktop_launcher"
    });
    // This is the end-to-end property the release exists to deliver: a key the
    // user pasted makes the product usable without touching process.env.
    assert.equal(readiness.usable, true);
    assert.equal(readiness.configured_count, 1);
    assert.equal(readiness.credential_source, "desktop_launcher");
  } finally {
    await space.cleanup();
  }
});
