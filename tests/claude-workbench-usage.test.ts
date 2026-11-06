import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { claudeWorkbenchUsage } from '../core/interfaces/claude-workbench-usage.ts';

test('Claude usage exposes supported plan windows and closes the discovery process', async () => {
  let closed = 0;
  const launch = (() => ({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 20, resets_at: '2030-01-01T00:00:00Z' } }, session: { total_cost_usd: 123 }, account: 'private' }), close: () => { closed++; } })) as unknown as Parameters<typeof claudeWorkbenchUsage>[1];
  const result = await claudeWorkbenchUsage(tmpdir(), launch, () => '/fake/claude');
  assert.deepEqual(result, { available: true, windows: [{ id: 'five_hour', used_percent: 20, resets_at: '2030-01-01T00:00:00Z' }] });
  assert.equal(closed, 1); assert.equal(JSON.stringify(result).includes('private'), false);
});

test('Claude usage handles absent capability and invalid directories', async () => {
  let closed = false;
  const launch = (() => ({ close: () => { closed = true; } })) as unknown as Parameters<typeof claudeWorkbenchUsage>[1];
  assert.deepEqual(await claudeWorkbenchUsage(tmpdir(), launch, () => '/fake/claude'), { available: false, windows: [] });
  assert.equal(closed, true);
  await assert.rejects(claudeWorkbenchUsage('relative', launch, () => '/fake/claude'), /absolute/);
});
