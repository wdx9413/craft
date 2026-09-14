/**
 * Backward-compatible entrypoint for the application facade.
 *
 * The implementation lives in `application/craft-service.ts`; keeping this
 * stable export avoids breaking existing adapters and third-party imports.
 */
export * from "./application/craft-service.ts";
