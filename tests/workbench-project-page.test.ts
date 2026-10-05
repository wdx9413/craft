import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Browser JavaScript is exercised without generated declarations.
import { createProjectPage, groupByFolder } from '../workbench/project-page.js';

test('folder union retains opaque identities, duplicate records, orphan tasks and default tasks', () => {
  const first = { project_id: 'a', name: 'A' };
  const known = { id: '1', project_id: 'a' };
  const orphan = { id: '2', project_id: '__proto__' };
  const other = { id: '3', project_id: 'constructor' };
  const defaults = [{ id: '4', project_id: '' }, { id: '5' }];
  const result = groupByFolder([first, { project_id: 'a', name: 'Duplicate' }, { project_id: 'b' }, { name: 'invalid' }], [known, orphan, other, ...defaults]);
  assert.deepEqual(result.map((group: { key: string; name: string; known: boolean }) => [group.key, group.name, group.known]), [['a', 'A', true], ['b', 'b', true], ['__proto__', '__proto__', false], ['constructor', 'constructor', false], ['', '默认', false]]);
  assert.deepEqual(result[0].tasks, [known]);
  assert.deepEqual(result[4].tasks, defaults);
  assert.deepEqual(groupByFolder([], []), []);
  assert.equal(first.name, 'A');
});

test('project page pins one selection and queries a known encoded detail only', async () => {
  const calls: string[] = [];
  const api = async (path: string) => {
    calls.push(path);
    if (path === '/api/projects?limit=200') return { projects: [{ project_id: 'a/b', name: 'AB' }] };
    if (path === '/api/home?limit=25') return { tasks: [{ id: 't', project_id: 'orphan' }] };
    return { brain: { name: 'AB' } };
  };
  const load = createProjectPage(api, 25);
  const result = await load('a/b');
  assert.equal(result.selectedGroup.key, 'a/b');
  assert.deepEqual(result.snapshot, { brain: { name: 'AB' } });
  assert.equal(calls[2], '/api/projects/a%2Fb');
  assert.equal((await load('orphan')).snapshot, null);
  assert.equal((await load('absent')).selectedGroup, null);
  const fallback = createProjectPage(async (path: string) => {
    if (path.startsWith('/api/projects?')) throw new Error('unavailable');
    return {};
  }, 5);
  assert.deepEqual(await fallback(null), { groups: [], selectedGroup: null, snapshot: null });
  const noProjects = createProjectPage(async () => ({}), 5);
  assert.equal((await noProjects(null)).snapshot, null);
  const broken = createProjectPage(async () => { throw new Error('home unavailable'); }, 5);
  await assert.rejects(broken(null), /home unavailable/);
});

test('slow folder detail remains tied to its original selection while another load completes', async () => {
  let resolve!: (value: unknown) => void;
  const load = createProjectPage(async (path: string) => {
    if (path.startsWith('/api/projects?')) return { projects: [{ project_id: 'old' }, { project_id: 'new' }] };
    if (path.startsWith('/api/home?')) return { tasks: [] };
    if (path.endsWith('/old')) return new Promise((done) => { resolve = done; });
    return { name: 'new snapshot' };
  }, 10);
  const old = load('old');
  await Promise.resolve(); await Promise.resolve();
  const fresh = await load('new');
  resolve({ name: 'old snapshot' });
  assert.equal((await old).selectedGroup.key, 'old');
  assert.deepEqual(fresh.snapshot, { name: 'new snapshot' });
});
