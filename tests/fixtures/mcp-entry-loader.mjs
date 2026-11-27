const modules = {
  '../core/mcp-stdio.ts': `export async function serveMcpStdio({afterStart}) { const mode=process.env.CRAFT_TEST_ENTRY; const service=mode==='missing' ? undefined : {capabilityOwned: mode!=='standalone',storageOwner:mode==='runtime'?'runtime':'experience',ownerServices:new Map()}; const stop=await afterStart({service}); await stop?.(); }`,
  '../core/interfaces/mcp/product-launch.ts': `export function resolveMcpProductMode(){return 'component-context-test'}`,
  '../core/interfaces/learning-worker-supervisor.ts': `export async function startContextLearningWorker(){if(process.env.CRAFT_TEST_ENTRY==='learning-failure')throw Error('failure'); return async()=>process.stdout.write('learning-stopped\\n')}`,
  '../core/interfaces/experience-asset-worker.ts': `export async function startExperienceAssetWorker(service){process.stdout.write('asset:'+Boolean(service)+'\\n');if(process.env.CRAFT_TEST_ENTRY==='asset-failure')throw Error('failure');return async()=>process.stdout.write('asset-stopped\\n')}`,
  '../core/interfaces/trace-retention-worker.ts': `export const TRACE_RETENTION_WORKER_FLAG='--trace-worker';export async function runTraceRetentionMaintenance(){};export function startConfiguredTraceRetentionWorker(service){process.stdout.write('runtime:'+Boolean(service)+'\\n');return ()=>process.stdout.write('trace-stopped\\n')}`,
  '@craft/capability-codebase/lsp-worker': `export const CODEBASE_LSP_WORKER_FLAG='--lsp-worker';export async function runCodebaseLspWorker(){};export function runCodebaseLspWorkerSafely(){}`,
  '../core/interfaces/context-supervisor.ts': `export async function startContextSupervisor(){return async()=>process.stdout.write('supervisor-stopped\\n')}`,
};
export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.includes('/bin/craft-mcp') && modules[specifier]) return {url:'data:text/javascript,'+encodeURIComponent(modules[specifier]),shortCircuit:true};
  return nextResolve(specifier, context);
}
