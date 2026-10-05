import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Browser module exercised directly.
import { createContextWorkflowPages } from "../workbench/context-workflows.js";

function screen() {
  const elements = new Map<string, any>();
  const root: any = { querySelector: (key: string) => {
    if (!elements.has(key)) elements.set(key, { innerHTML: "", textContent: "", disabled: false, elements: { scope: { value: "project:demo" }, name: { value: "Report" } }, querySelector: root.querySelector, querySelectorAll: root.querySelectorAll });
    return elements.get(key);
  }, querySelectorAll: (key: string) => elements.get(key) ?? [] };
  const submit = (key: string) => root.querySelector(key).onsubmit({ preventDefault() {}, target: root.querySelector(key) });
  const set = (key: string, value: any) => elements.set(key, value);
  return { root, submit, set, get: root.querySelector };
}
const esc = (value: unknown) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const deferred = () => { let resolve!: (value: any) => void, reject!: (error: Error) => void; const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test("retiring uses current scoped version, refreshes on success and preserves failures", async () => {
  for (const member of ['memory', 'knowledge', 'experience']) {
    for (const mode of ['ok', 'error', 'stale-ok', 'stale-error']) {
      const ui = screen(), errors: string[] = [], calls: any[] = [], pending = deferred();
      const item = { id: 'r', created_at: 'now', execution_context: true, task_ids: [], references: [{ member, id: 'x', version: 1, current_version: 3, current_status: 'active', source_id: 'source', author: 'user' }], budget: { omitted_count: 0 } };
      const button: any = { getAttribute: () => '0', disabled: false };
      ui.set('[data-retire]', member === 'experience' ? [] : [button]);
      const page = await createContextWorkflowPages({ api: async (url: string, args: any) => { calls.push([url, args]); return args ? pending.promise : { count: 1, receipts: [item] }; }, esc, fail: (e: Error) => errors.push(e.message) }).usage();
      page.mounts[0](ui.root); await ui.submit('#usage-query');
      if (member === 'experience') { assert(!ui.get('#usage-results').innerHTML.includes('data-retire')); continue; }
      const action = button.onclick(); assert.equal(calls.at(-1)[1].body.expected_version, 3); assert.equal(calls.at(-1)[1].body.scope_id, 'demo');
      if (mode.startsWith('stale')) await ui.submit('#usage-query');
      if (mode.endsWith('error')) pending.reject(new Error('conflict')); else pending.resolve({});
      await action;
      if (mode === 'error') { assert.equal(button.disabled, false); assert.deepEqual(errors, ['conflict']); }
      else assert.deepEqual(errors, []);
    }
  }
});

test("usage renders escaped evidence, uncertainty, empty and legacy states and rejects stale reads", async () => {
  const ui = screen(), errors: string[] = [], calls: string[] = [];
  let result: any = { count: 0, receipts: [], truncated: false };
  const page = await createContextWorkflowPages({ api: async (url: string) => { calls.push(url); return result; }, esc, fail: (e: Error) => errors.push(e.message) }).usage();
  page.mounts[0](ui.root);
  ui.get('#usage-query').elements.scope.value = 'bad'; await ui.submit('#usage-query'); assert.equal(errors.length, 1);
  ui.get('#usage-query').elements.scope.value = 'project:'; await ui.submit('#usage-query'); assert.equal(errors.length, 2);
  ui.get('#usage-query').elements.scope.value = 'project:/a b'; await ui.submit('#usage-query');
  assert.match(calls[0]!, /scope_id=%2Fa%20b/); assert.match(ui.get('#usage-results').innerHTML, /0 条/);
  result = { count: 2, truncated: true, receipts: [{ id: '<id>', created_at: '<time>', execution_context: true, outcome_verified: true, task_ids: ['t'], references: [{ member: 'memory', id: '<script>', version: 2, digest: 'd', reason: '<tag>', current_status: 'revoked', source_id: 'source', author: 'user' }], legacy_references_incomplete: false, budget: { omitted_count: 1 } },
    { id: 'old', created_at: 'now', execution_context: false, task_ids: [], references: [{ member: 'knowledge', id: 'k', version: 1, current_status: 'unknown', author: 'unknown' }], legacy_references_incomplete: true, budget: {} }] };
  await ui.submit('#usage-query'); const html = ui.get('#usage-results').innerHTML;
  assert.match(html, /&lt;script&gt;/); assert(!html.includes('<script>')); assert.match(html, /历史诊断/); assert.match(html, /尚无证据/); assert.match(html, /有程序证据/); assert.match(html, /旧回执/); assert.match(html, /前 100/);
  const first = deferred(), second = deferred(); let index = 0;
  const racing = await createContextWorkflowPages({ api: () => [first.promise, second.promise][index++], esc, fail: (e: Error) => errors.push(e.message) }).usage();
  racing.mounts[0](ui.root); const old = ui.submit('#usage-query'), fresh = ui.submit('#usage-query'); second.resolve({ count: 0, receipts: [] }); await fresh; first.resolve(result); await old; assert.match(ui.get('#usage-results').innerHTML, /0 条/);
  for (const stale of [false, true]) {
    const pending = deferred(); const failed = await createContextWorkflowPages({ api: () => pending.promise, esc, fail: (e: Error) => errors.push(e.message) }).usage(); failed.mounts[0](ui.root);
    const request = ui.submit('#usage-query'); const other = stale ? ui.submit('#usage-query') : null; pending.reject(new Error('offline')); await request; await other;
    assert.match(ui.get('#usage-results').textContent, /读取未完成/);
  }
});

test("interview opens existing drafts, saves exact versions, handles conflicts and suppresses stale responses", async () => {
  const ui = screen(), errors: string[] = [], calls: any[] = [];
  const draft = { design: { id: 'd', version: 1, name: '<draft>', answers: { example: 'ok' } }, questions: [{ key: 'failure', question: 'Failure?' }] };
  let saved: any = { ...draft, design: { ...draft.design, version: 2 }, next_question: { question: 'Failure?' }, markdown: '<draft>' };
  let listing: any = { question_catalog: [{ key: 'example', question: 'Example?' }, { key: 'failure', question: 'Failure?' }], designs: [draft, { ...draft, design: { ...draft.design, id: 'other' } }], truncated: true };
  let failure = false;
  const page = await createContextWorkflowPages({ api: async (url: string, args: any) => { calls.push([url, args]); if (failure) throw new Error('conflict'); return args ? saved : listing; }, esc, fail: (e: Error) => errors.push(e.message) }).designs();
  const existing: any = { getAttribute: () => '0' };
  ui.set('[data-design]', [existing]); ui.set('[data-answer]', [{ getAttribute: () => 'example', value: 'edited' }]);
  page.mounts[0](ui.root); await ui.submit('#design-scope'); assert.match(ui.get('#design-content').innerHTML, /&lt;draft&gt;/);
  existing.onclick(); assert.match(ui.get('#design-editor').innerHTML, /Example/); await ui.submit('#design-form');
  assert.equal(calls.at(-1)[1].body.expected_version, 1); assert.deepEqual(calls.at(-1)[1].body.answers, { example: 'edited' });
  assert.match(ui.get('#design-status').textContent, /下一步/); assert.match(ui.get('#design-brief').innerHTML, /&lt;draft&gt;/);
  saved = { ...saved, design: { ...saved.design, answers: { example: 'ok', failure: 'stop' } }, questions: [], next_question: null };
  ui.get('#design-new').onclick(); await ui.submit('#design-form'); assert.equal(calls.at(-1)[1].body.design_id, undefined); assert.match(ui.get('#design-status').textContent, /待人工复核/);
  failure = true; await ui.submit('#design-form'); assert.equal(ui.get('button').disabled, false); assert.equal(errors.at(-1), 'conflict'); await ui.submit('#design-scope'); assert.match(ui.get('#design-content').textContent, /读取未完成/);
  failure = false; listing = { ...listing, truncated: false }; await ui.submit('#design-scope');
  // Changing scope invalidates pending list and save completions, including errors.
  for (const operation of ['list-success', 'list-error', 'save-success', 'save-error', 'editor-success', 'editor-error']) {
    const pending = deferred(); let count = 0;
    const racing = await createContextWorkflowPages({ api: async (_url: string, args: any) => {
      count++;
      if (!operation.startsWith('list')) return args ? pending.promise : listing;
      return count === 1 ? pending.promise : listing;
    }, esc, fail: (e: Error) => errors.push(e.message) }).designs();
    racing.mounts[0](ui.root);
    let old;
    if (!operation.startsWith('list')) { await ui.submit('#design-scope'); ui.get('#design-new').onclick(); old = ui.submit('#design-form'); }
    else old = ui.submit('#design-scope');
    if (operation.startsWith('editor')) ui.get('#design-new').onclick();
    else await ui.submit('#design-scope');
    if (operation.endsWith('error')) pending.reject(new Error('stale')); else pending.resolve(!operation.startsWith('list') ? saved : listing);
    await old; assert.notEqual(errors.at(-1), 'stale');
  }
});
