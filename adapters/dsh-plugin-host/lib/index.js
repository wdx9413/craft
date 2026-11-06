import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export const name = "craft-dsh-plugin-host";
export const inject = ["tools"];

const debug = (message) => {
  if (process.env.CRAFT_DSH_BRIDGE_DEBUG === "1") process.stderr.write(`[craft-dsh-plugin-host] ${message}\n`);
};

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function apply(ctx) {
  const tools = ctx.get("tools");
  // DSH's sandbox facade only exposes register/schemas/get; execute is
  // intentionally withheld so a plugin cannot bypass ToolRuntime policy. The
  // bridge therefore keeps a resident Cordis process for the isolated profile
  // and reflects tools registered in this plugin's own fiber. DSH base tools
  // live in a separate fiber and are not reachable from here.
  if (!tools || typeof tools.register !== "function" || typeof tools.schemas !== "function") {
    throw new Error("craft-dsh-plugin-host requires the DSH tools registry");
  }

  const server = new Server(
    { name: "craft-dsh-plugin-host", version: "0.12.131" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const schemas = tools.schemas();
    debug(`tools/list -> ${schemas.map((s) => s.name).join(",")}`);
    return {
      tools: schemas.map((schema) => ({
        name: schema.name,
        description: schema.description ?? "",
        inputSchema: schema.parameters ?? { type: "object", properties: {} },
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const schema = tools.schemas().find((s) => s.name === toolName);
    if (!schema) throw new Error(`unknown DSH tool: ${toolName}`);
    if (typeof tools.execute !== "function") {
      throw new Error(`DSH tool '${toolName}' is registered in the DSH runtime and must be invoked from inside a DSH ACP session; Craft cannot call it directly`);
    }
    const callId = `craft-dsh-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return tools.execute({
      callId,
      rootCallId: callId,
      name: toolName,
      arguments: object(request.params.arguments),
      agent: ctx,
      signal: new AbortController().signal,
    });
  });

  let closed = false;
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    await server.close().catch(() => undefined);
  };
  if (typeof ctx.effect === "function") ctx.effect(() => cleanup);
  // Do not await connect: Cordis blocks remaining profile bundles until apply
  // resolves, and the bridge must stay resident while they load.
  void server.connect(new StdioServerTransport()).catch((error) => {
    process.stderr.write(`[craft-dsh-plugin-host] ${error?.stack ?? error}\n`);
  });
}
