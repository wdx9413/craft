/** Public integration surface for the separately installed Workbench. */
export { craftPaths } from "./infrastructure/paths.ts";
export { CraftStore } from "./infrastructure/store.ts";
export { CraftService, VERSION } from "./service.ts";
export { WorkbenchWebApp, workbenchBridge } from "./workbench-server.ts";
