import type { JsonObject } from "./infrastructure/store.ts";

/** Safe, machine-readable operation failure. Details must never contain source content or credentials. */
export class CraftOperationError extends Error {
  readonly code: string;
  readonly stage: string;
  readonly safeDetails: JsonObject;

  constructor(code: string, stage: string, message: string, safeDetails: JsonObject = {}) {
    super(message);
    this.name = "CraftOperationError";
    this.code = code;
    this.stage = stage;
    this.safeDetails = safeDetails;
  }
}
