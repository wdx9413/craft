import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { hydrateSecretsIntoEnv, readSecrets, storedSecretNames, writeSecret } from "../core/secrets-store.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-secrets-"));
  return craftPaths(root);
}

test("a stored key is written owner-only and never needs a settings.json edit", async () => {
  const paths = await fixture();
  await writeSecret(paths, "MOONSHOT_API_KEY", "  sk-test-123  ");
  assert.deepEqual(readSecrets(paths), { MOONSHOT_API_KEY: "sk-test-123" });
  assert.deepEqual(storedSecretNames(paths), ["MOONSHOT_API_KEY"]);
  const mode = (await stat(paths.secretsFile)).mode & 0o777;
  // POSIX keeps the file owner-only. Windows has no POSIX mode bits (Node reports
  // a synthetic 0o666), so the owner-only guarantee there rests on the per-user
  // %USERPROFILE%\.craft_data location rather than on mode; assert it on POSIX.
  if (process.platform !== "win32") assert.equal(mode, 0o600, "the secrets file must stay owner-only");
  const raw = JSON.parse(await readFile(paths.secretsFile, "utf8"));
  assert.deepEqual(raw, { MOONSHOT_API_KEY: "sk-test-123" });
});

test("an empty value removes the key, and invalid env names are rejected", async () => {
  const paths = await fixture();
  await writeSecret(paths, "OPENAI_API_KEY", "sk-a");
  await writeSecret(paths, "OPENAI_API_KEY", "   ");
  assert.deepEqual(readSecrets(paths), {});
  await assert.rejects(writeSecret(paths, "lowercase", "x"), /uppercase environment-variable/u);
  await assert.rejects(writeSecret(paths, "A-B", "x"), /uppercase environment-variable/u);
  await assert.rejects(writeSecret(paths, "A_B", "x".repeat(9000)), /too long/u);
});

test("a corrupt secrets file reads as empty instead of breaking startup", async () => {
  const paths = await fixture();
  await writeFile(paths.secretsFile, "{ not json", "utf8");
  assert.deepEqual(readSecrets(paths), {});
  assert.deepEqual(storedSecretNames(paths), []);
});

test("hydration fills only missing env vars so a real environment always wins", async () => {
  const paths = await fixture();
  await writeSecret(paths, "DEEPSEEK_API_KEY", "from-file");
  await writeSecret(paths, "ARK_API_KEY", "file-would-lose");
  const env: NodeJS.ProcessEnv = { ARK_API_KEY: "from-env" };
  const adopted = hydrateSecretsIntoEnv(paths, env);
  assert.deepEqual(adopted, ["DEEPSEEK_API_KEY"]);
  assert.equal(env.DEEPSEEK_API_KEY, "from-file");
  assert.equal(env.ARK_API_KEY, "from-env");
});
