process.stdin.resume();
process.stdin.on("end", () => process.stdout.write(JSON.stringify({ ok: true, analysis: { value: 1 } })));
