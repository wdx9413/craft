import assert from "node:assert/strict";
import test from "node:test";
import type { CraftStore, JsonObject } from "../core/infrastructure/store.ts";
import { hostSessionMemoryArgs } from "../core/application/use-cases/session-memory-scope.ts";
import { sessionStorageScopeId } from "../common/craft-common-store-local/src/paths.ts";

test("Host session Memory scope is partitioned and bound without changing other scopes", () => {
  const project: JsonObject = { scope_kind: "project", scope_id: "p" };
  assert.equal(hostSessionMemoryArgs(project), project);
  const unscoped: JsonObject = { scope_kind: "session" };
  assert.equal(hostSessionMemoryArgs(unscoped), unscoped);

  const calls: string[] = [];
  const store = {
    bindSessionStorageHost(session: string, host: string) { calls.push(`bind:${session}:${host}`); },
    resolveSessionStorageScopeId(session: string, host?: string) { calls.push(`resolve:${session}:${host ?? ""}`); return "host:codex:session"; },
  } as unknown as CraftStore;
  const hosted = hostSessionMemoryArgs({ scope_kind: "session", scope_id: "session", session_host: "codex" }, store);
  assert.equal(hosted.scope_id, "host:codex:session");
  assert.deepEqual(calls, ["bind:session:codex", "resolve:session:codex"]);

  const sameStore = { bindSessionStorageHost() {}, resolveSessionStorageScopeId() { return "session"; } } as unknown as CraftStore;
  const same = { scope_kind: "session", scope_id: "session", session_host: "codex" };
  assert.equal(hostSessionMemoryArgs(same, sameStore), same);
  assert.equal(hostSessionMemoryArgs({ scope_kind: "session", scope_id: "session", session_host: "codex" }).scope_id,
    sessionStorageScopeId("codex", "session"));

  const unhostedSession = { scope_kind: "session", scope_id: "session" };
  const unhostedStore = { resolveSessionStorageScopeId(session: string, host?: string) {
    assert.equal(session, "session"); assert.equal(host, undefined); return undefined;
  } } as unknown as CraftStore;
  assert.equal(hostSessionMemoryArgs(unhostedSession, unhostedStore), unhostedSession);

  const unresolvedStore = { bindSessionStorageHost() {}, resolveSessionStorageScopeId() { return undefined; } } as unknown as CraftStore;
  assert.equal(hostSessionMemoryArgs({ scope_kind: "session", scope_id: "session", session_host: "codex" }, unresolvedStore).scope_id,
    sessionStorageScopeId("codex", "session"));
});
