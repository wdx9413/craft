import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Browser adapter tested with a minimal DOM port.
import { mountEntry } from '../workbench/entry-shell.js';

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture() {
  const listeners: Record<string, Function> = {};
  const focus = { count: 0, focus() { this.count++; }, textContent: '' };
  const root: any = { dataset: {}, hidden: true, innerHTML: '', querySelector: () => focus };
  const legacy = { hidden: false };
  const navigated: any[] = [], sizes: any[] = [], revoked: string[] = [];
  let resizeError: unknown = null, apiError: unknown = null;
  const link = { href: '', download: '', clicked: false, click() { this.clicked = true; } };
  const window: any = { Blob, URL: { createObjectURL: () => 'blob:draft', revokeObjectURL: (url: string) => revoked.push(url) }, setTimeout: (fn: Function) => fn(), addEventListener: (name: string, fn: Function) => { listeners[name] = fn; }, document: { createElement: () => link, addEventListener: (name: string, fn: Function) => { listeners[name] = fn; } } };
  const api = async (path: string) => {
    if (apiError) throw apiError;
    if (path === '/api/home?limit=50') return { tasks: [{ id: 't', title: 'Title' }] };
    if (path === '/api/config/models') return { models: [{ id: 'm', configured: true }] };
    if (path.endsWith('/messages')) return { assistant: { content: 'answer' } };
    return { task: { id: 't', title: 'Title', model_id: 'm' } };
  };
  const shell = mountEntry({ root, legacy, api, window, navigate: (...args: any[]) => navigated.push(args), resize: async (mode: string) => { sizes.push(mode); if (resizeError) throw resizeError; } });
  const click = async (action: string, extra = {}, disabled = false) => { root.onclick({ target: { closest: () => ({ disabled, dataset: { entryAction: action, ...extra } }) } }); await settle(); };
  const key = async (key: string, extra = {}) => { const event = { key, preventDefault() {}, stopImmediatePropagation() {}, ...extra }; listeners.keydown(event); await settle(); };
  return { shell, root, legacy, focus, listeners, navigated, sizes, link, revoked, click, key, failResize: (value: unknown) => { resizeError = value; }, failApi: (value: unknown) => { apiError = value; } };
}

test('entry DOM adapter wires modes, task continuation, explicit context and retained edits', async () => {
  const f = fixture(); await f.shell.ready;
  await f.shell.show('launcher'); assert.equal(f.legacy.hidden, true);
  await f.click('companion'); await f.click('workspace'); await f.click('launcher');
  f.root.onclick({ target: { closest: () => null } });
  await f.click('missing'); await f.click('workspace', {}, true);
  f.root.oninput({ target: { dataset: {}, value: '' } });
  f.root.oninput({ target: { dataset: { entryField: 'input' }, value: 'hello' } });
  f.root.oninput({ target: { dataset: { entryField: 'draft' }, value: 'edited' } });
  assert.match(f.focus.textContent, /下载/);
  f.root.onchange({ target: { dataset: { entryField: 'model' }, value: 'm' } });
  f.root.onchange({ target: { dataset: {}, value: '' } });
  f.root.onchange({ target: { dataset: { entryField: 'files' }, files: [{ name: 'a.md', size: 1, text: async () => 'a' }] } }); await settle();
  await f.click('remove', { index: '0' });
  f.root.onsubmit({ preventDefault() {} }); await settle();
  assert.equal(f.shell.session.state.current.draft, 'answer');
  await f.click('download'); assert.equal(f.link.clicked, true); assert.deepEqual(f.revoked, ['blob:draft']);
  await f.click('refresh'); await f.click('detail'); assert.equal(f.navigated.at(-1)[0], 'task');
  assert.equal(f.legacy.hidden, false); assert.equal(f.root.hidden, true);
  await f.click('approvals'); await f.click('legacy'); assert.equal(f.navigated.at(-1)[0], 'settings');
  await f.click('fresh'); await f.click('refresh'); await f.click('task', { task: 't' });
  assert.equal(f.shell.session.state.current.task.id, 't');
});

test('IME-safe shortcuts, failure states, resize failure and unload warning are honest', async () => {
  const f = fixture(); await f.shell.ready;
  let prevented = false;
  const unload = { preventDefault: () => { prevented = true; }, returnValue: 'unchanged' };
  f.listeners.beforeunload(unload); assert.equal(prevented, false);
  await f.key('k', { isComposing: true, ctrlKey: true }); assert.equal(f.sizes.length, 0);
  await f.key('k'); await f.key('Escape');
  await f.key('K', { metaKey: true }); assert.equal(f.shell.session.state.mode, 'launcher');
  await f.key('Escape'); assert.equal(f.shell.session.state.mode, 'workspace'); await f.key('Escape');
  await f.key('k', { ctrlKey: true });
  f.failResize('not supported'); await f.shell.show('companion'); assert.match(f.root.innerHTML, /窗口调整失败/);
  f.failApi(new Error('offline')); await f.click('refresh'); assert.match(f.root.innerHTML, /offline/);
  f.failApi('string failure'); await f.click('refresh'); assert.match(f.root.innerHTML, /string failure/);
  f.shell.session.input('unsent'); f.listeners.beforeunload(unload); assert.equal(prevented, true); assert.equal(unload.returnValue, '');
  f.shell.session.state.busy = true; await f.click('fresh'); assert.match(f.root.innerHTML, /等待/);
});
