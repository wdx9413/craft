import type { JsonObject } from "./infrastructure/store.ts";
import type { GeneralEvolutionKernel } from "./general-evolution.ts";

/** Thin office adapter; principal/scope enforcement is delegated to the kernel + caller. */
export class OfficeAdapter {
  readonly kernel: GeneralEvolutionKernel;
  constructor(kernel: GeneralEvolutionKernel) { this.kernel = kernel; }

  capture(args: JsonObject): JsonObject {
    if (typeof args.principal_id === "string" && typeof args.scope === "object") {
      return this.kernel.captureDomainStatement({ ...args, domain: "office",
        scope: { ...(args.scope as JsonObject), principal_id: args.principal_id } });
    }
    return this.kernel.captureDomainStatement({ ...args, domain: "office" });
  }
}
