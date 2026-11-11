import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { defaultSettings, normalizeSettings, saveSettingsSync } from "../core/settings.ts";
import { GitHubIssueSourceAdapter } from "../core/message-github-source.ts";

function temporaryPaths() {
  const root = mkdtempSync(join(tmpdir(), "craft-message-sources-"));
  return craftPaths(root);
}

test("message source defaults are disabled, pull-only and credential-free", () => {
  const paths = temporaryPaths();
  try {
    const sources = defaultSettings(paths).messageSources;
    assert.equal(sources.enabled, false);
    assert.equal(sources.intervalMs, 60_000);
    assert.deepEqual(sources.dropDirs, []);
    assert.deepEqual(sources.githubRepos, []);
    assert.equal(sources.githubApiBaseUrl, "https://api.github.com");
    assert.equal(sources.githubTokenEnv, "GITHUB_TOKEN");
    assert.equal(sources.githubState, "issues");
  } finally { rmSync(paths.root, { recursive: true, force: true }); }
});

test("message source config validates repos, state, interval and token env", () => {
  const paths = temporaryPaths();
  try {
    const sources = normalizeSettings({ messageSources: {
      enabled: true, intervalMs: 5_000, dropDirs: ["/tmp/drop"],
      githubRepos: ["wdx9413/craft"], githubState: "pull_requests", githubTokenEnv: "GH_PAT",
    } }, paths).messageSources;
    assert.equal(sources.enabled, true);
    assert.equal(sources.intervalMs, 5_000);
    assert.deepEqual(sources.githubRepos, ["wdx9413/craft"]);
    assert.equal(sources.githubState, "pull_requests");
    assert.equal(sources.githubTokenEnv, "GH_PAT");
    assert.throws(() => normalizeSettings({ messageSources: { githubRepos: ["bad-repo"] } }, paths), /owner\/repo/u);
    assert.throws(() => normalizeSettings({ messageSources: { githubState: "closed" } }, paths), /issues, pull_requests or all/u);
    assert.throws(() => normalizeSettings({ messageSources: { intervalMs: 10 } }, paths), /between 1000 and 3600000/u);
    assert.throws(() => normalizeSettings({ messageSources: { githubTokenEnv: "bad-env-name" } }, paths), /environment variable name/u);
  } finally { rmSync(paths.root, { recursive: true, force: true }); }
});

test("message source settings persist across save and reload", () => {
  const paths = temporaryPaths();
  try {
    const saved = saveSettingsSync({ messageSources: { enabled: true, githubRepos: ["wdx9413/craft"] } }, paths);
    assert.equal(saved.messageSources.enabled, true);
    assert.deepEqual(saved.messageSources.githubRepos, ["wdx9413/craft"]);
  } finally { rmSync(paths.root, { recursive: true, force: true }); }
});

test("GitHub source is read-only, bounded and resolves issues into inbox messages", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify([
      { number: 7, title: "Need review", body: "Please inspect", user: { login: "alice" }, updated_at: "2026-11-12T00:00:00Z" },
      { number: 8, title: "A PR", body: "changes", user: { login: "bob" }, pull_request: { url: "x" } },
    ]), { status: 200, headers: { "content-type": "application/json" } });
  };
  const adapter = new GitHubIssueSourceAdapter({
    repo: "wdx9413/craft", fetchImpl: fetchImpl as never,
    env: { GITHUB_TOKEN: "test-token" } as NodeJS.ProcessEnv, state: "issues",
  });
  const messages = await adapter.poll();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].externalId, "github:wdx9413/craft#7");
  assert.match(messages[0].subject, /Issue #7/u);
  assert.equal(calls[0].init.method, "GET");
  assert.match(String((calls[0].init.headers as Record<string, string>).Authorization), /^Bearer /u);
});

test("GitHub source fails loudly without a token and never stores it", async () => {
  const adapter = new GitHubIssueSourceAdapter({ repo: "wdx9413/craft", fetchImpl: (async () => { throw new Error("should not fetch"); }) as never, env: {} as NodeJS.ProcessEnv });
  await assert.rejects(() => adapter.poll(), /GITHUB_TOKEN/u);
});
