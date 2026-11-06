import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { claudeWorkbenchModels } from '../core/interfaces/claude-workbench-models.ts';

test('Claude model discovery returns bounded CLI catalog and always closes the process', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'craft-models-')); let closed = 0; let options: any;
  const launch: any = (args: any) => { options = args.options; return { supportedModels: async () => [{ value:'default', displayName:'默认', description:'当前模型' }, { value:'sonnet', displayName:'Sonnet' }, {value:'bad\nmodel'}], close: () => closed++ }; };
  try {
    const result = await claudeWorkbenchModels(dir, launch, () => '/claude');
    assert.deepEqual(result.models.map(m => [m.id,m.is_default]), [['default',true],['sonnet',false]]);
    assert.equal(options.pathToClaudeCodeExecutable, '/claude'); assert.equal(options.persistSession, false); assert.equal(closed, 1);
    const oversized: any = () => ({ supportedModels: async () => Array.from({length:101}, (_, i) => ({value: String(i)})), close: () => closed++ });
    assert.equal((await claudeWorkbenchModels(dir, oversized, () => '/claude')).truncated, true);
    const invalid: any = () => ({ supportedModels: async () => null, close: () => closed++ });
    await assert.rejects(claudeWorkbenchModels(dir, invalid, () => '/claude'), /Invalid/);
    const failure: any = () => ({ supportedModels: async () => { throw new Error('disconnected'); }, close: () => closed++ });
    await assert.rejects(claudeWorkbenchModels(null, failure, () => '/claude'), /disconnected/);
    const hanging: any = (args: any) => { void args.prompt.next(); args.options.stderr('ignored'); return { supportedModels: () => new Promise(() => {}), close: () => closed++ }; };
    await assert.rejects(claudeWorkbenchModels(dir, hanging, () => '/claude', 5), /timed out/);
    assert.equal(closed, 5);
    writeFileSync(join(dir, 'file'), 'x');
    await assert.rejects(claudeWorkbenchModels('relative', launch, () => '/claude'), /absolute/);
    await assert.rejects(claudeWorkbenchModels(join(dir,'file'), launch, () => '/claude'), /directory/);
  } finally { rmSync(dir, { recursive:true, force:true }); }
});
