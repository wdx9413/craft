import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
function digest(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
/**
 * One bounded, cancellable child process with output caps. Every host driver
 * shares it, so sandboxing, output limiting and cancellation behave identically
 * whether the host is Codex, Claude, or a user-declared model CLI.
 */
export const executeHostProcess = async (request) => new Promise((accept, reject) => {
    const child = spawn(request.executable, request.argv, { cwd: request.cwd, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let outputLimited = false;
    let timedOut = false;
    let cancelled = false;
    const append = (current, chunk) => { const next = current + chunk.toString("utf8"); if (Buffer.byteLength(next) <= request.outputLimit)
        return next; outputLimited = true; return Buffer.from(next).subarray(0, request.outputLimit).toString("utf8"); };
    const observed = (stream, chunk) => request.observe?.({ stream, bytes: chunk.length, digest: digest(chunk.toString("utf8")) });
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); observed("stdout", chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); observed("stderr", chunk); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, request.timeoutMs);
    const abort = () => { cancelled = true; child.kill(); };
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted)
        abort();
    child.once("close", (exitCode, signal) => { clearTimeout(timer); request.signal?.removeEventListener("abort", abort); accept({ exitCode, signal, stdout, stderr, timedOut, cancelled, outputLimited }); });
    child.stdin.end(request.stdin);
});
//# sourceMappingURL=host-driver.js.map