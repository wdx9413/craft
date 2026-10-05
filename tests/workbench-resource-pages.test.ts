import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Browser JavaScript is exercised without generated declarations.
import { createResourcePages } from '../workbench/resource-pages.js';

type Button = { onclick?: () => void; getAttribute: (name: string) => string };
const button = (id: string): Button => ({ getAttribute: () => id });
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('Memory and Workflow pages render persisted rows and wire governed edit/retire actions', async () => {
  let data: Record<string, unknown> = {};
  const calls: unknown[] = [], edits: unknown[] = [], refreshes: string[] = [], notifications: string[] = [], errors: string[] = [];
  let retireFails = false;
  const esc = (value: unknown) => String(value ?? '').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const pages = createResourcePages({
    api: async (path: string, init?: unknown) => {
      calls.push([path, init]);
      if (path.endsWith('/retire') && retireFails) throw new Error('retire denied');
      return data;
    },
    presentation: {
      icon: (name: string) => `<svg>${name}</svg>`, esc,
      head: (title: string, _sub: string, right: string) => `<h2>${title}</h2>${right}`,
      emptyState: (title: string) => `<p>${title}</p>`, asideBlock: (_title: string, _right: string, body: string) => body,
      catalogRows: (items: Record<string, unknown>[], _icon: string, title: (item: unknown) => string, sub: (item: unknown) => string) => items.map((item) => title(item) + sub(item)).join(''),
      countChip: (count: number) => String(count), label: (_labels: unknown, _status: unknown, fallback: unknown) => fallback,
      STATUS_LABELS: {}, shortTime: (value: unknown) => value || ''
    },
    editors: { memory: (item?: unknown) => { edits.push(['memory', item]); }, workflow: (item?: unknown) => { edits.push(['workflow', item]); } },
    refresh: (page: string) => { refreshes.push(page); }, notify: (message: string) => { notifications.push(message); }, fail: (error: Error) => { errors.push(error.message); }
  });
  const emptyMemory = await pages.memory();
  assert.ok(emptyMemory.html.includes('还没有可展示的记忆'));
  const emptyWorkflow = await pages.workflows();
  assert.ok(emptyWorkflow.html.includes('还没有工作流运行'));
  const missingRoot = { querySelector: () => null, querySelectorAll: () => [] };
  emptyMemory.mounts[0](missingRoot); emptyWorkflow.mounts[0](missingRoot);

  const memory = { id: 'memory/1', content: '<unsafe>', kind: 'fact', scope: 'user', source: 'human' };
  data = { items: [memory, { id: 'fallback' }] };
  const memoryView = await pages.memory();
  assert.ok(memoryView.html.includes('&lt;unsafe&gt;'));
  assert.ok(memoryView.html.includes('fallback'));
  const add = button(''), edit = button('memory/1'), missing = button('absent'), retire = button('memory/1');
  memoryView.mounts[0]({ querySelector: () => add, querySelectorAll: (selector: string) => selector.includes('retire') ? [retire] : [missing, edit] });
  add.onclick!(); missing.onclick!(); edit.onclick!(); retire.onclick!(); await flush();
  assert.deepEqual(edits, [['memory', undefined], ['memory', memory]]);
  assert.deepEqual(calls.at(-1), ['/api/workbench/memory/memory%2F1/retire', { method: 'POST', body: {} }]);
  assert.deepEqual(refreshes, ['memory']); assert.deepEqual(notifications, ['记忆已停用']);
  retireFails = true; retire.onclick!(); await flush(); assert.deepEqual(errors, ['retire denied']);

  const workflow = { id: 'w', name: 'Workflow', description: 'summary' };
  data = { workflows: [workflow, { id: 'fallback' }], runs: [{ workflow_id: 'w', status: 'passed', updated_at: 'now' }, { id: 'r' }] };
  const workflowView = await pages.workflows();
  assert.ok(workflowView.html.includes('Workflow')); assert.ok(workflowView.html.includes('没有说明')); assert.ok(workflowView.html.includes('passed · now'));
  const workflowAdd = button(''), workflowEdit = button('w');
  workflowView.mounts[0]({ querySelector: () => workflowAdd, querySelectorAll: () => [missing, workflowEdit] });
  workflowAdd.onclick!(); missing.onclick!(); workflowEdit.onclick!();
  assert.deepEqual(edits.slice(-2), [['workflow', undefined], ['workflow', workflow]]);
  data = { items: [], workflows: [], runs: [] };
  assert.ok((await pages.memory()).html.includes('还没有可展示的记忆'));
  assert.ok((await pages.workflows()).html.includes('还没有工作流运行'));
});
