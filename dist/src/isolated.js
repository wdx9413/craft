import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
export function processExitCode(code) { return code ?? 1; }
function pathAllowed(path, prefixes) {
    const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
    return !!normalized && !normalized.startsWith("/") && !normalized.split("/").includes("..") && prefixes.some((prefix) => prefix === "." || normalized === prefix || normalized.startsWith(`${prefix}/`));
}
function helperFor(platform) {
    return platform === "darwin" ? "/usr/bin/sandbox-exec" : platform === "linux" ? "/usr/bin/bwrap" : null;
}
export async function runLocalProcess(request) {
    const environment = { ...process.env };
    delete environment.NODE_V8_COVERAGE;
    const child = spawn(String(request.helper), request.argv, { cwd: String(request.cwd), env: environment, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    return new Promise((resolveResult) => {
        child.once("error", (error) => resolveResult({ code: 1, stdout, stderr: `${stderr}${error.message}` }));
        child.once("close", (code) => resolveResult({ code: processExitCode(code), stdout, stderr }));
    });
}
export class LocalIsolatedAdapter {
    platform;
    helperAvailable;
    runner;
    constructor(options = {}) { this.platform = options.platform ?? process.platform; this.helperAvailable = options.helperAvailable ?? existsSync; this.runner = options.runner ?? runLocalProcess; }
    async execute(input) {
        const helper = helperFor(this.platform);
        if (!helper || !this.helperAvailable(helper))
            throw new Error("Local isolated execution is unavailable on this platform");
        if (!input.command_allowlist.includes(input.command))
            throw new Error("Local isolated command is not in the allowlist");
        if (input.requires_credential)
            throw new Error("Credential Broker is required; the built-in local broker denies credentials");
        if (input.effect !== "read_only" && !input.compensation)
            throw new Error("Write effects require compensation or human approval");
        const relativeCwd = input.cwd ?? ".";
        if (!pathAllowed(relativeCwd, input.path_allowlist))
            throw new Error("Local isolated path is not in the allowlist");
        const workspace = resolve(input.runtime_root, input.run_id);
        await mkdir(workspace, { recursive: true });
        const cwd = resolve(workspace, relativeCwd);
        const profile = this.platform === "darwin" ? `(version 1) (allow default) (deny network*)${input.effect === "read_only" ? " (deny file-write*)" : ` (allow file-write* (subpath \"${workspace.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}\"))`}` : "bwrap network disabled";
        const argv = this.platform === "darwin" ? ["-p", profile, input.command, ...input.args] : ["--unshare-net", "--", input.command, ...input.args];
        const result = await this.runner({ helper, argv, cwd, profile });
        return { status: result.code === 0 ? "passed" : "failed", helper, workspace, network: "denied", stdout: result.stdout, stderr: result.stderr };
    }
}
//# sourceMappingURL=isolated.js.map