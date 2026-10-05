import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareRuntimeArtifact } from "../../scripts/release/runtime-artifact.ts";

// The product graph owns dist/core, dist/capability, dist/bin and dist/workbench.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
await prepareRuntimeArtifact(root);
