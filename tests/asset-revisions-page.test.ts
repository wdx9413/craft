import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error Browser module exercised directly.
import { createAssetRevisionPage } from "../workbench/asset-revisions.js";
const esc = (v: unknown) => String(v).replaceAll('<', '&lt;');
function screen() {
  const elements = new Map<string, any>();
  const root: any = { querySelector: (key: string) => {
    if (!elements.has(key)) elements.set(key, { innerHTML: '', textContent: '', disabled: false, elements: Object.fromEntries(Object.entries({ scope: 'project:demo', member: 'knowledge', asset_id: 'k', kind: '', reason: 'Review', version: '1' }).map(([key, value]) => [key, { value }])), querySelector: root.querySelector });
    return elements.get(key);
  } };
  return { root, get: root.querySelector, submit: (key: string) => root.querySelector(key).onsubmit({ preventDefault() {}, target: root.querySelector(key) }) };
}
const history = { current: { record_version: 2, state: '<candidate>' }, versions: [{ record_version: 1, state: '<candidate>', created_at: 'now' }] };
const deferred = () => { let resolve!: (v: any) => void, reject!: (e: Error) => void; const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test("version page requires a reviewed diff, preserves restoration idempotency and escapes content", async () => {
  const ui = screen(), errors: string[] = [], calls: any[] = []; let broken = false, activation = 'governed_candidate';
  const page = await createAssetRevisionPage({ api: async (url: string, options: any) => {
    calls.push(options.body); if (broken) throw new Error('offline');
    return url.endsWith('restore') ? { restoration: { restored_id: 'candidate', activation } } : options.body.action === 'history' ? { ...history, has_more: true } : options.body.action === 'diff' ? { changes: [{ field: 'content', after: '<script>' }] } : { followed: 'unknown' };
  }, esc, fail: (e: Error) => errors.push(e.message) })();
  page.mounts[0](ui.root); ui.get('#asset-query').elements.scope.value = 'bad'; await ui.submit('#asset-query'); assert.equal(errors.length, 1);
  ui.get('#asset-query').elements.scope.value = 'project:demo'; ui.get('#asset-query').elements.kind.value = 'knowledge_claim'; await ui.submit('#asset-query');
  assert.match(ui.get('#asset-results').innerHTML, /&lt;candidate>/); assert.match(ui.get('#asset-results').innerHTML, /最近版本/);
  const before = calls.length; await ui.submit('#asset-restore'); assert.equal(calls.length, before);
  await ui.submit('#asset-compare'); assert.match(ui.get('#asset-diff').innerHTML, /&lt;script>/);
  broken = true; await ui.submit('#asset-restore'); const request = calls.at(-1).request_id; assert.equal(ui.get('button').disabled, false);
  broken = false; await ui.submit('#asset-restore'); assert.equal(calls.at(-1).request_id, request); assert.equal(calls.at(-1).expected_version, 2); assert.match(ui.get('#asset-status').textContent, /待审核/);
  await ui.submit('#asset-compare'); activation = 'rebuilt_current_checkpoint'; await ui.submit('#asset-restore'); assert.match(ui.get('#asset-status').textContent, /当前快照/);
  broken = true; await ui.submit('#asset-compare'); assert.equal(errors.at(-1), 'offline'); await ui.submit('#asset-query'); assert.match(ui.get('#asset-results').textContent, /读取未完成/);
});

test("scope and comparison changes suppress late read/write completions and failures", async () => {
  for (const mode of ['query-ok', 'query-error', 'diff-ok', 'diff-error', 'restore-ok', 'restore-error', 'comparison-ok', 'comparison-error']) {
    const ui = screen(), errors: string[] = [], pending = deferred(); let pause = false;
    const page = await createAssetRevisionPage({ api: async (url: string, options: any) => {
      if (pause) { pause = false; return pending.promise; }
      return url.endsWith('restore') ? { restoration: { restored_id: 'x', activation: 'governed_candidate' } } : options.body.action === 'history' ? history : options.body.action === 'diff' ? { changes: [] } : {};
    }, esc, fail: (e: Error) => errors.push(e.message) })();
    page.mounts[0](ui.root); await ui.submit('#asset-query'); await ui.submit('#asset-compare');
    pause = true;
    const old = ui.submit(mode.startsWith('query') ? '#asset-query' : mode.startsWith('diff') || mode.startsWith('comparison') ? '#asset-compare' : '#asset-restore');
    if (mode.startsWith('comparison')) await ui.submit('#asset-compare'); else await ui.submit('#asset-query');
    if (mode.endsWith('error')) pending.reject(new Error('stale')); else pending.resolve(mode.startsWith('query') ? history : mode.startsWith('restore') ? { restoration: { restored_id: 'old' } } : { changes: [] });
    await old; assert.deepEqual(errors, []);
  }
});
