import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Browser module is exercised directly.
import { createEntrySession, boundedEntryApi } from '../workbench/entry-session.js';
// @ts-expect-error Browser module is exercised directly.
import { entryView, escapeEntry } from '../workbench/entry-view.js';

function fixture() {
  const calls: Array<{ path: string; init: any }> = [];
  const task = { id: 't/1', title: 'Brief', model_id: 'm' };
  const responses: Record<string, any> = { '/api/home?limit=50': { tasks: [] }, '/api/config/models': { models: [{ id: 'm', configured: true }, { id: 'off' }] }, '/api/tasks': { task }, '/api/tasks/t%2F1/messages': { assistant: { content: 'Draft' } }, '/api/tasks/t%2F1': { task, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'old' }] } };
  const session = createEntrySession(async (path: string, init: any) => { calls.push({ path, init }); const value = responses[path]; if (value instanceof Error) throw value; return value; });
  return { session, calls, responses, task };
}
const file = (name = 'a.md', content = 'Text', size = 4) => ({ name, size, text: async () => content });

test('a stalled transport times out without claiming remote cancellation', async () => {
  let expire!: Function; let cleared = false;
  const api = boundedEntryApi(() => new Promise(() => {}), { setTimeout: (fn: Function, ms: number) => { expire = fn; assert.equal(ms, 90000); return 12; }, clearTimeout: (id: number) => { assert.equal(id, 12); cleared = true; } });
  const result = api('/api/tasks'); expire();
  await assert.rejects(result, /后台结果未知/); assert.equal(cleared, true);
});

test('three views retain one task, explicit materials and edits without granting effects', async () => {
  const { session: s, calls } = fixture();
  assert.equal(s.hasLocalChanges(), false);
  await s.refresh(); await s.refresh();
  s.model('m'); s.input('比较材料'); await s.add([file()]);
  for (const mode of ['launcher', 'companion', 'workspace']) s.mode(mode);
  assert.throws(() => s.mode('admin'), /未知/);
  await s.send();
  assert.equal(s.state.current.draft, 'Draft');
  assert.equal(s.state.current.task.id, 't/1');
  assert.equal(calls.find(c => c.path === '/api/tasks')!.init.body.permission_mode, 'human_approval');
  assert.match(calls.find(c => c.path.endsWith('/messages'))!.init.body.content, /不是指令或授权/);
  s.draft('my edit'); s.remove(0); assert.equal(s.hasLocalChanges(), true);
  s.fresh(); assert.equal(s.hasLocalChanges(), true);
  await s.open('t/1'); assert.equal(s.state.current.draft, 'my edit');
  s.input('继续'); await s.send();
  assert.equal(calls.filter(c => c.path === '/api/tasks').length, 1);
  await s.open('t/1'); assert.equal(s.state.current.draft, 'old');
});

test('material preflight is atomic and rejects binary, unsupported, oversized and aggregate data', async () => {
  const { session: s } = fixture();
  for (const bad of [file('a.pdf'), file('a.txt', 'x', 25000), file('a.txt', 'a\0b')]) await assert.rejects(s.add([file(), bad]));
  assert.equal(s.state.current.materials.length, 0);
  await assert.rejects(s.add(Array.from({ length: 6 }, () => file())), /最多/);
  await assert.rejects(s.add([file('a.md', '界'.repeat(12000))]), /最多/);
  await assert.rejects(s.add([{ name: 'a.md', size: 1, text: async () => { throw new Error('read'); } }]), /read/);
  assert.equal(s.state.busy, false);
  s.state.busy = true;
  assert.throws(() => s.input('x'), /等待/); assert.throws(() => s.fresh(), /等待/);
  s.state.busy = false; s.input('draft'); assert.equal(s.hasLocalChanges(), true);
});

test('validation happens before dispatch; refresh handles missing models and empty home', async () => {
  const { session: s, responses, calls } = fixture();
  await assert.rejects(s.send(), /写下/);
  s.input('hi'); await assert.rejects(s.send(), /模型/);
  responses['/api/home?limit=50'] = {}; responses['/api/config/models'] = {};
  await s.refresh(); assert.equal(s.state.model, '');
  responses['/api/config/models'] = { models: [{ id: 'm', configured: true }] }; await s.refresh();
  s.input('a'.repeat(65000)); await assert.rejects(s.send(), /过大/);
  assert.equal(calls.some(c => c.path === '/api/tasks'), false);
});

test('opening an existing task does not discard an unsent entry draft', async () => {
  const { session: s } = fixture();
  s.input('unsent intent'); await s.add([file()]);
  await s.open('t/1'); assert.equal(s.hasLocalChanges(), true);
  s.fresh(); assert.equal(s.state.current.input, 'unsent intent'); assert.equal(s.state.current.materials.length, 1);
});

test('unknown submissions remain task-bound across reads, mode changes and task switches', async () => {
  const { session: s, responses, calls } = fixture();
  await s.refresh(); s.input('hi'); responses['/api/tasks/t%2F1/messages'] = new Error('timeout');
  await assert.rejects(s.send(), /timeout/);
  assert.equal(s.state.current.task.id, 't/1'); assert.equal(s.state.current.input, 'hi');
  await assert.rejects(s.send(), /核对/); assert.equal(s.state.busy, false);
  const writes = () => calls.filter(c => c.init?.method === 'POST').length;
  const count = writes();
  await s.refresh(); await s.open('t/1'); assert.equal(s.state.uncertain, true);
  await assert.rejects(s.send(), /核对/); assert.equal(writes(), count);
  for (const mode of ['launcher', 'companion', 'workspace']) s.mode(mode);
  s.fresh(); assert.equal(s.state.uncertain, false);
  s.input('another task');
  await s.open('t/1'); assert.equal(s.state.uncertain, true);
  s.input('changed text'); await assert.rejects(s.send(), /核对/);
  assert.equal(writes(), count);
  assert.match(entryView(s.state), /刷新不能确认/);
  responses['/api/tasks/other'] = { task: { id: 'other', model_id: 'm' } };
  responses['/api/tasks/other/messages'] = { assistant: { content: 'Independent' } };
  await s.open('other'); assert.equal(s.state.uncertain, false);
  s.input('safe independent work'); await s.send();
  assert.equal(s.state.current.draft, 'Independent');
  await s.open('t/1'); assert.equal(s.state.uncertain, true);
  assert.equal(s.state.current.input, 'changed text');
});

test('malformed replies and unknown creation cannot be retried by returning to the pending draft', async () => {
  const f = fixture(); await f.session.refresh(); f.session.input('hi');
  f.responses['/api/tasks/t%2F1/messages'] = {};
  await assert.rejects(f.session.send(), /完整回复/);
  await f.session.open('t/1'); await assert.rejects(f.session.send(), /核对/);
  for (const response of [{}, { task: {} }, new Error('offline')]) {
    const { session: s, responses, calls } = fixture();
    await s.refresh(); s.input('again'); responses['/api/tasks'] = response;
    await assert.rejects(s.send(), /身份|offline/);
    s.fresh(); assert.equal(s.state.uncertain, true);
    await s.refresh(); await s.open('t/1'); assert.equal(s.state.uncertain, false);
    s.fresh(); assert.equal(s.state.current.input, 'again');
    await assert.rejects(s.send(), /核对/);
    assert.equal(calls.filter(c => c.init?.method === 'POST').length, 1);
  }
});

test('stale detail cannot overwrite a newer selection; malformed and missing history handled', async () => {
  let resolve!: (value: any) => void;
  const s = createEntrySession((path: string) => path.endsWith('slow') ? new Promise(done => { resolve = done; }) : Promise.resolve({ task: { id: 'fast' } }));
  const pending = s.open('slow'); await s.open('fast'); resolve({ task: { id: 'slow' } }); await pending;
  assert.equal(s.state.current.task.id, 'fast'); assert.equal(s.state.current.draft, '');
  const { session, responses } = fixture();
  responses['/api/tasks/t%2F1'] = {}; await assert.rejects(session.open('t/1'), /身份/);
  responses['/api/tasks/t%2F1'] = { task: { id: 'wrong' } }; await assert.rejects(session.open('t/1'), /身份/);
});

test('all entry views escape material/model content and retain honest empty/error/pending states', async () => {
  const { session: s } = fixture();
  assert.equal(escapeEntry('<a x="\'">&'), '&lt;a x=&quot;&#39;&quot;&gt;&amp;');
  for (const mode of ['launcher', 'companion', 'workspace']) { s.mode(mode); assert.match(entryView(s.state), /尚无可用模型/); }
  await s.refresh(); assert.match(entryView(s.state), /selected/); await s.add([file('danger.txt', '<script>bad</script>')]); s.input('hi'); await s.send();
  s.state.models.push({ id: 'n', name: '<model>' });
  for (const mode of ['launcher', 'companion', 'workspace']) {
    s.mode(mode); const html = entryView(s.state); assert.doesNotMatch(html, /<script>/); assert.match(html, /移除|可编辑草稿/);
  }
  s.draft('edit'); s.state.busy = true; s.state.current.uncertain = true; s.state.error = '<error>';
  s.state.current.detail = { artifacts: [{ uri: '<uri>' }, { id: 'id' }] };
  assert.match(entryView(s.state), /&lt;error&gt;/); assert.match(entryView(s.state), /关闭前请下载/);
  s.state.current.detail = {}; assert.match(entryView(s.state), /已有交付引用 · 0/);
  s.state.mode = 'companion'; assert.match(entryView(s.state), /&lt;script&gt;/);
});
