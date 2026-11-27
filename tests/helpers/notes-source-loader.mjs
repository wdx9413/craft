import { registerHooks } from "node:module";

const sources = new Map([
  ["craft-common-store-local/paths", new URL("../../../craft-common/packages/craft-common-store-local/src/paths.ts", import.meta.url).href],
  ["craft-common-store-local/store", new URL("../../../craft-common/packages/craft-common-store-local/src/store.ts", import.meta.url).href],
]);
registerHooks({ resolve(specifier, context, nextResolve) {
  const url = sources.get(specifier);
  return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
} });
