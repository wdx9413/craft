import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Browser JavaScript is exercised without generated declarations.
import { createLatestRequest } from '../workbench/latest-request.js';

test('render seam suppresses obsolete results and obsolete errors across same-page selections', async () => {
  const render = createLatestRequest();
  const commits: string[] = [], failures: string[] = [];
  const commit = (value: string) => { commits.push(value); };
  const fail = (error: Error) => { failures.push(error.message); };
  let finish!: (value: string) => void;
  let oldCurrent!: () => boolean;
  const slow = render((ticket: { current: () => boolean }) => {
    oldCurrent = ticket.current; assert.equal(ticket.current(), true);
    return new Promise<string>((resolve) => { finish = resolve; });
  }, commit, fail);
  await render(() => 'new project', commit, fail);
  assert.equal(oldCurrent(), false);
  finish('old project'); await slow;
  let reject!: (error: Error) => void;
  const staleError = render(() => new Promise<string>((_, rejecter) => { reject = rejecter; }), commit, fail);
  await render(() => 'new task', commit, fail);
  reject(new Error('old failure')); await staleError;
  await render(() => { throw new Error('synchronous failure'); }, commit, fail);
  await render(() => Promise.reject(new Error('current failure')), commit, fail);
  assert.deepEqual(commits, ['new project', 'new task']);
  assert.deepEqual(failures, ['synchronous failure', 'current failure']);
});
