import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { startExperienceAssetWorker } from "../core/interfaces/experience-asset-worker.ts";
import { ProcedureDefinitionStore } from "../capability/craft-experience/procedure-definition.ts";
import { fixture } from "./helpers/procedure-invocation-fixture.ts";

test("asset worker defers work, prevents reentry, contains failures and stops", async () => {
  const f = await fixture();
  let tick: (() => void) | undefined, calls = 0, failures = 0, cancelled = 0, unrefs = 0;
  const timer = { unref: () => { unrefs++; } } as unknown as NodeJS.Timeout;
  const hook = mock.method(ProcedureDefinitionStore.prototype, "maintain", () => {
    calls++; tick!(); throw new Error("invalid definition");
  });
  try {
    const stop = await startExperienceAssetWorker(f.service, {
      set_interval: (callback, ms) => { assert.equal(ms, 60_000); tick = callback; return timer; },
      clear_interval: handle => { assert.equal(handle, timer); cancelled++; },
      on_failure: error => { assert.match(String(error), /invalid definition/); failures++; },
    });
    assert.equal(calls, 0); assert.equal(unrefs, 1);
    tick!(); tick!(); assert.equal(calls, 2); assert.equal(failures, 2);
    await stop(); await stop(); tick!(); assert.equal(calls, 2); assert.equal(cancelled, 1);
  } finally { hook.mock.restore(); await f.close(); }
});

test("asset worker honors disable and supports default timers without blocking shutdown", async () => {
  const f = await fixture();
  try {
    await (await startExperienceAssetWorker(undefined))();
    await (await startExperienceAssetWorker(f.service, { enabled: false }))();
    await (await startExperienceAssetWorker(f.service))();
    let tick: (() => void) | undefined;
    const hook = mock.method(ProcedureDefinitionStore.prototype, "maintain", () => { throw new Error("contained"); });
    try {
      const stop = await startExperienceAssetWorker(f.service, { set_interval: callback => { tick = callback; return {} as NodeJS.Timeout; }, clear_interval: () => undefined });
      assert.doesNotThrow(() => tick!()); await stop();
    } finally { hook.mock.restore(); }
  } finally { await f.close(); }
});

test("only one MCP process owns Experience asset migration and lock failure stays fail-open", async () => {
  const f = await fixture();
  let scheduled = 0, unrefs = 0, cancelled = 0, failures = 0;
  const timer = { unref: () => { unrefs++; } } as unknown as NodeJS.Timeout;
  try {
    const options = { set_interval: () => { scheduled++; return timer; }, clear_interval: () => { cancelled++; } };
    const first = await startExperienceAssetWorker(f.service, options);
    const concurrent = await startExperienceAssetWorker(f.service, options);
    assert.equal(scheduled, 1);
    assert.equal(unrefs, 1);
    await first();
    const afterRelease = await startExperienceAssetWorker(f.service, options);
    assert.equal(scheduled, 2);
    await concurrent();
    await afterRelease();
    assert.equal(cancelled, 2);
    const skipped = await startExperienceAssetWorker(f.service, { ...options, acquire_lock: async () => null });
    await skipped();
    const failed = await startExperienceAssetWorker(f.service, { ...options, acquire_lock: async () => { throw new Error("lock unavailable"); }, on_failure: () => { failures++; } });
    await failed();
    assert.equal(scheduled, 2);
    assert.equal(failures, 1);
    let releasedAfterScheduleFailure = 0;
    const scheduleFailed = await startExperienceAssetWorker(f.service, {
      acquire_lock: async () => async () => { releasedAfterScheduleFailure++; },
      set_interval: () => { throw new Error("timer unavailable"); },
      on_failure: () => { failures++; },
    });
    await scheduleFailed();
    assert.equal(releasedAfterScheduleFailure, 1);
    const releaseFailed = await startExperienceAssetWorker(f.service, {
      acquire_lock: async () => async () => { throw new Error("release failed"); },
      ...options,
      on_failure: () => { failures++; },
    });
    await releaseFailed();
    assert.equal(failures, 3);
  } finally { await f.close(); }
});
