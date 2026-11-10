import { runCodebaseStorageMigrationCommand } from "../core/codebase-storage-migration-command.ts";

const result = await runCodebaseStorageMigrationCommand(process.argv.slice(2));
process.stdout.write(`${result.output}\n`);
process.exitCode = result.exit_code;
