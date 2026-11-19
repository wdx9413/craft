import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { ModRuntime } from "../core/mod-runtime.ts";

test("trust-all with a mixed pending set rejects self-evolved Mods and trusts only reviewed human Mods", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-mod-trust-boundary-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const runtime = new ModRuntime(store);
  try {
    const stage = async (id: string) => {
      const packageRoot = join(root, id);
      await mkdir(packageRoot);
      await writeFile(join(packageRoot, "register.mjs"), "export function register(on) { on(\"craft.session.lifecycle@1\", () => ({ kind: \"continue\" })); }\n");
      const result = runtime.stage({ manifest: { id, name: id, version: "1.0.0", entry: "register.mjs",
        capabilities: ["event.observe"], hooks: [{ event: "craft.session.lifecycle@1", capability: "event.observe" }] }, package_root: packageRoot });
      return result.mod as JsonObject;
    };

    const human = await stage("human-helper");
    const evolved = await stage("evolved-helper");
    store.save("runtime_mod", String(evolved.id), { ...evolved, origin: "self_evolved" });
    const humanReview = runtime.review({ mod_id: human.id }) as JsonObject;
    const evolvedReview = runtime.review({ mod_id: evolved.id }) as JsonObject;
    const humanDigestReview = { mod_id: human.id, code_digest: humanReview.code_digest, permission_digest: humanReview.permission_digest };
    const evolvedDigestReview = { mod_id: evolved.id, code_digest: evolvedReview.code_digest, permission_digest: evolvedReview.permission_digest };

    assert.throws(() => runtime.trustAll({ actor: "user:test", reviews: [humanDigestReview, evolvedDigestReview] }),
      /exactly match the currently pending human-authored Mod set/u);
    assert.equal(store.find("runtime_mod", String(human.id))?.trust_status, "review_required");
    assert.equal(store.find("runtime_mod", String(evolved.id))?.trust_status, "review_required");

    const result = runtime.trustAll({ actor: "user:test", reviews: [humanDigestReview] });
    assert.equal(result.count, 1);
    assert.equal(store.find("runtime_mod", String(human.id))?.trust_status, "trusted");
    assert.equal(store.find("runtime_mod", String(evolved.id))?.trust_status, "review_required");
    assert.equal(store.find("runtime_mod", String(evolved.id))?.enabled, false);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
