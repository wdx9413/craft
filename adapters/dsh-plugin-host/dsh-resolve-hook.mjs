/**
 * stdout-clean resolve hook for DSH's packaged CLI.
 *
 * Preloaded with `node --import`, it only retries host-owned package specifiers
 * against the app.asar anchor. It never writes to stdout, so ACP and MCP framing
 * stay clean. The anchor path arrives through CRAFT_DSH_ENTRY_ANCHOR.
 */
import { registerHooks } from "node:module";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const anchor = process.env.CRAFT_DSH_ENTRY_ANCHOR;

if (anchor) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (!specifier.startsWith("@deepseek-ai/") && !specifier.startsWith("@modelcontextprotocol/")) throw error;
        if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
        try {
          return nextResolve(specifier, { ...context, parentURL: pathToFileURL(anchor).href });
        } catch (hostError) {
          error.message += `\n  host fallback from ${dirname(anchor)} also failed: ${hostError.message}`;
          error.cause ??= hostError;
          throw error;
        }
      }
    },
  });
}
