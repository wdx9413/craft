process.on("SIGTERM", () => process.exit(0));
process.stdout.write("x".repeat(2 * 1024 * 1024 + 1));
