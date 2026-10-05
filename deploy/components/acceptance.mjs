// Run against a staged deployment. Never prints the Bearer token or response bodies.
import assert from 'node:assert/strict'
const url = new URL(process.env.CRAFT_REMOTE_URL ?? '')
assert.equal(url.protocol, 'https:', 'HTTPS endpoint required')
const product = process.env.CRAFT_REMOTE_PRODUCT
assert(['context', 'knowledge', 'memory', 'experience', 'codebase'].includes(product), 'CRAFT_REMOTE_PRODUCT is required')
const check = ['context', 'codebase'].includes(product) ? { name: 'craft_info', arguments: {} } : { name: 'craft_component_readiness_get', arguments: { component: product } }
const token = process.env.CRAFT_REMOTE_TOKEN
assert(token, 'CRAFT_REMOTE_TOKEN is required')
const send = (message, authorized) => fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { accept: 'application/json', 'content-type': 'application/json', ...(authorized ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(message) })
assert.equal((await send({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, false)).status, 401)
for (const message of [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'craft-deployment-acceptance', version: '1' } } },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: check },
]) {
  const response = await send(message, true); assert.equal(response.status, 200)
  const result = await response.json(); assert(!result.error && result.result && result.result.isError !== true)
  if (message.id === 2) assert(result.result.tools.some(tool => tool.name === check.name))
}
console.log(JSON.stringify({ level: 'tool_call_verified', https: true, anonymous_denied: true, host_session_verified: false }))
