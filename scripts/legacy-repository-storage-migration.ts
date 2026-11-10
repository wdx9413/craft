import { runLegacyRepositoryStorageMigration } from "../core/legacy-repository-storage-migration-command.ts";

try {
  const result = await runLegacyRepositoryStorageMigration(process.argv.slice(2));
  process.stdout.write(`${result.output}\n`);
  process.exitCode = result.exit_code;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "legacy_repository_migration_failed"}\n`);
  process.exitCode = 2;
}
