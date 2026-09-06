import { spawn } from 'node:child_process'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'craft-adapter'
export const inject = ['tools']

function callCraft(command, args, dataDir) {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env }
    if (dataDir) environment.CRAFT_DATA_DIR = dataDir
    const child = spawn(command, ['--from', 'craft-agent-harness==0.1.0', 'craft-mcp'], {
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0 && !stdout) return reject(new Error(stderr || `craft-mcp exited ${code}`))
      const messages = stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
      const response = messages.find(item => item.id === 2)
      if (!response) return reject(new Error(stderr || 'Craft returned no tool response'))
      if (response.error) return reject(new Error(response.error.message))
      resolve(response.result?.structuredContent ?? response.result)
    })
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'dsh-craft-adapter', version: '0.1.0' } },
    }) + '\n')
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: args.tool, arguments: JSON.parse(args.arguments_json || '{}') } }) + '\n')
    child.stdin.end()
  })
}

export function apply(ctx, config = {}) {
  ctx.tools.register(defineTool({
    name: 'craft_call',
    description: 'Call a Craft MCP tool for capability search, durable tasks, workflows, evaluations, or orchestration. Tool names use the craft_ prefix.',
    parameters: {
      tool: { type: 'string', required: true, description: 'Craft MCP tool name, for example craft_capability_search.' },
      arguments_json: { type: 'string', required: false, description: 'JSON object containing the tool arguments.' },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      return callCraft(config.uvxCommand || 'uvx', args, config.dataDir)
    },
  }))
}
