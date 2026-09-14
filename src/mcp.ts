/**
 * Backward-compatible entrypoint for the MCP interface.
 *
 * The implementation lives in `interfaces/mcp-server.ts` so protocol code is
 * kept separate from application and domain code.
 */
export * from "./interfaces/mcp-server.ts";
