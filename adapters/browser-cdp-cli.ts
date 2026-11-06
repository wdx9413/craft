import { BrowserCdpAdapter } from "./browser-cdp.ts";
import { connectCdp } from "./cdp-session.ts";

function option(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

let session: Awaited<ReturnType<typeof connectCdp>> | undefined;
try {
const body = await new Promise<string>((resolve, reject) => {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; if (Buffer.byteLength(input) > 65_536) reject(new Error("CDP request exceeds limit")); });
  process.stdin.on("end", () => resolve(input));
  process.stdin.on("error", reject);
});
  session = await connectCdp(Number(option("--port")), option("--target"));
  process.stdout.write(`${JSON.stringify(await new BrowserCdpAdapter(session).execute(JSON.parse(body)))}\n`);
} catch { process.stderr.write("Browser adapter failed; reconcile uncertain effects before retry.\n"); process.exitCode = 1; }
finally { session?.close(); }
