process.stdout.write(JSON.stringify({ ok: false, error: "bounded worker failure" }));
process.exitCode = 1;
