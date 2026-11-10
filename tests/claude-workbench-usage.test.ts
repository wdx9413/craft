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

test('Claude usage consumes the prompt stream, accepts a null workspace and tolerates stderr', async () => {
  let consumed = false, stderrSeen = false, closed = false;
  const launch = ((args: { prompt: AsyncIterable<unknown>; options: { stderr?: (line: string) => void } }) => {
    void (async () => { consumed = true; for await (const _item of args.prompt) { /* abortable */ } })();
    args.options.stderr?.('discovery diagnostic');
    stderrSeen = true;
    return {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ rate_limits_available: false, rate_limits: null }),
      close: () => { closed = true; },
    };
  }) as unknown as Parameters<typeof claudeWorkbenchUsage>[1];
  const result = await claudeWorkbenchUsage(null, launch, () => '/fake/claude');
  assert.deepEqual(result, { available: false, windows: [] });
  assert.equal(consumed, true, 'the abortable prompt stream must be consumed and closed');
  assert.equal(stderrSeen, true);
  assert.equal(closed, true);
});

test('Claude usage discovery times out instead of hanging forever', async () => {
  let closed = false;
  const launch = (() => ({
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => new Promise<never>(() => {}),
    close: () => { closed = true; },
  })) as unknown as Parameters<typeof claudeWorkbenchUsage>[1];
  await assert.rejects(claudeWorkbenchUsage(tmpdir(), launch, () => '/fake/claude', 1), /timed out/u);
  assert.equal(closed, true);
});
