import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Browser JavaScript is tested directly without generated declarations.
import { createModelSetup } from '../workbench/model-setup.js';

const presets = [
  { key: 'local', label: 'Local', baseUrl: 'http://localhost:8000/v1', protocol: 'openai-compatible', env: 'LOCAL_KEY', models: ['model'] },
  { key: 'custom', label: 'Custom', baseUrl: '', protocol: 'anthropic', env: 'CUSTOM_KEY', models: [] },
];
function fixture() {
  const calls: Array<{ path: string; init: { method: string; body: Record<string, unknown> } }> = [];
  const setup = createModelSetup(presets, async (path: string, init: { method: string; body: Record<string, unknown> }) => { calls.push({ path, init }); });
  return { setup, calls };
}

test('first-run defaults, metadata-only drafts, navigation and provider selection are owned by the setup Module', async () => {
  const { setup, calls } = fixture();
  assert.throws(() => setup.view(), /打开/); assert.throws(() => setup.change({ type: 'back' }), /打开/);
  await assert.rejects(setup.save(), /打开/);
  setup.open(); assert.equal(setup.view().step, 1);
  assert.throws(() => setup.change({ type: 'next' }), /选择服务商/);
  setup.change({ type: 'back' }); assert.equal(setup.view().step, 1);
  setup.open({ isFirstRun: true, pastedKey: 'private-key', apiKey: 'private-key' });
  assert.equal(setup.view().step, 1); assert.ok(!JSON.stringify(setup.view()).includes('private-key'));
  assert.throws(() => setup.change({ type: 'select', key: 'missing' }), /不存在/);
  setup.change({ type: 'select', key: 'custom' }); assert.equal(setup.view().model, '');
  setup.change({ type: 'select', key: 'local' }); assert.equal(setup.view().step, 2);
  assert.throws(() => setup.change({ type: 'next', model: '  ' }), /模型/);
  setup.change({ type: 'next', model: ' custom-model ' }); assert.equal(setup.view().step, 3);
  setup.change({ type: 'back' }); assert.equal(setup.view().step, 2);
  setup.change({ type: 'fields', name: ' My model ', baseUrl: 'http://localhost:8000/v1///', env: ' key_env ' });
  setup.change({ type: 'fields' });
  assert.equal(setup.view().baseUrl, 'http://localhost:8000/v1');
  assert.throws(() => setup.change({ type: 'javascript' }), /操作无效/);
  const view = setup.view(); view.model = 'tampered'; assert.equal(setup.view().model, 'custom-model');
  setup.change({ type: 'next', model: 'custom-model' });
  const result = await setup.save(); assert.equal(result.current, true); assert.equal(result.editing, false);
  assert.deepEqual(calls[0], { path: '/api/config/models', init: { method: 'POST', body: { id: 'local', name: 'My model',
    protocol: 'openai-compatible', baseUrl: 'http://localhost:8000/v1', model: 'custom-model', apiKeyEnv: 'key_env', supportsTools: true } } });
  setup.open({ preset: 'local' }); setup.change({ type: 'next' }); assert.equal(setup.view().step, 2);
  setup.change({ type: 'next', model: 'model' }); setup.change({ type: 'fields', name: '' });
  assert.equal((await setup.save()).name, 'Local');
});

test('editing preserves public provider metadata and cannot retain nested credentials', async () => {
  const { setup, calls } = fixture();
  setup.open({ editing: { id: 'custom-id', name: 'Edited', model: 'existing', baseUrl: 'https://service.test/v1', protocol: 'anthropic', apiKeyEnv: 'EXISTING_KEY', apiKey: 'secret' } });
  assert.equal(setup.view().step, 2); assert.equal(setup.view().preset, 'custom');
  assert.ok(!JSON.stringify(setup.view()).includes('secret'));
  setup.change({ type: 'next', model: 'existing' });
  const result = await setup.save(); assert.equal(result.editing, true);
  assert.equal(calls[0].path, '/api/config/models/custom-id'); assert.equal(calls[0].init.method, 'PATCH');
  assert.equal(calls[0].init.body.baseUrl, 'https://service.test/v1'); assert.equal(calls[0].init.body.apiKeyEnv, 'EXISTING_KEY');
  setup.open({ preset: 'local', step: 3, name: 'Explicit', model: 'explicit', baseUrl: 'https://override.test', protocol: 'anthropic', env: 'OVERRIDE' });
  assert.equal(setup.view().model, 'explicit');
});

test('invalid transitions and unsafe endpoints never reach the persistence Interface', async () => {
  const { setup, calls } = fixture();
  for (const input of [{ step: 4 }, { preset: 'missing' }]) assert.throws(() => setup.open(input), /无效/);
  setup.open(); await assert.rejects(setup.save(), /标识/);
  setup.open({ preset: 'local' }); await assert.rejects(setup.save(), /模型/);
  for (const patch of [
    { editing: { id: 'Bad ID' } }, { baseUrl: 'file:///tmp/secret' }, { baseUrl: 'https://name:pass@service.test/' },
    { baseUrl: 'https://:pass@service.test/' }, { baseUrl: 'https://service.test/?token=secret' }, { baseUrl: 'https://service.test/#secret' },
    { baseUrl: 'https://' }, { protocol: 'shell' }, { env: '1BAD' },
  ]) {
    setup.open({ preset: 'local', model: 'model', ...patch }); await assert.rejects(setup.save());
  }
  assert.equal(calls.length, 0);
});

test('single-flight saves isolate late success and failure from another opened wizard', async () => {
  let resolveFirst!: () => void, rejectSecond!: (error: Error) => void;
  let resolveThird!: () => void;
  let count = 0;
  const setup = createModelSetup(presets, () => {
    count++;
    if (count === 1) return new Promise<void>((resolve) => { resolveFirst = resolve; });
    if (count === 2) return new Promise<void>((_resolve, reject) => { rejectSecond = reject; });
    return new Promise<void>((resolve) => { resolveThird = resolve; });
  });
  const open = () => setup.open({ preset: 'local', model: 'model' });
  open(); const first = setup.save(); await assert.rejects(setup.save(), /正在保存/); assert.equal(count, 1);
  setup.change({ type: 'fields', name: 'Updated while saving' });
  await assert.rejects(setup.save(), /正在保存/);
  open(); const second = setup.save(); resolveFirst(); assert.equal((await first).current, false);
  await assert.rejects(setup.save(), /正在保存/);
  open(); const third = setup.save(); rejectSecond(new Error('late secret failure'));
  assert.deepEqual(await second, { current: false, status: 'failed' }); resolveThird(); assert.equal((await third).current, true);
  const failure = createModelSetup(presets, async () => { throw new Error('persist refused'); });
  failure.open({ preset: 'local', model: 'model' }); await assert.rejects(failure.save(), /persist refused/);
  await assert.rejects(failure.save(), /persist refused/);
});

test('editing the same wizard during persistence invalidates its old UI result without issuing a second write', async () => {
  let release!: () => void;
  let calls = 0;
  const setup = createModelSetup(presets, () => {
    calls++;
    return calls === 1 ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve();
  });
  setup.open({ preset: 'local', model: 'model' });
  const request = setup.save();
  setup.change({ type: 'fields', name: 'new draft' });
  await assert.rejects(setup.save(), /正在保存/);
  assert.equal(calls, 1);
  release(); assert.equal((await request).current, false);
  const latest = await setup.save(); assert.equal(latest.current, true); assert.equal(latest.name, 'new draft');
});
