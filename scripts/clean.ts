import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputs = [resolve(projectRoot, "dist"), resolve(projectRoot, "adapters", "deepseek-harness", "dist")];

for (const output of outputs) {
  if (!output.startsWith(`${projectRoot}\\`) && !output.startsWith(`${projectRoot}/`)) {
    throw new Error(`Refusing to clean outside the project: ${output}`);
  }
  await rm(output, { recursive: true, force: true });
}
