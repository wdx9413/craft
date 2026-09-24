/**
 * Domain kernels grouped by responsibility. Namespace exports deliberately
 * avoid flattening the public API and prevent cross-domain name collisions.
 */
export * as controlPlane from "../control-plane.ts";
export * as execution from "../execution-fabric.ts";
export * as evidence from "../trace-kernel.ts";
export * as knowledge from "../knowledge-index.ts";
export * as integration from "../mcp-registry.ts";
