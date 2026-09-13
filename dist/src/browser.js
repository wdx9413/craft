import { spawn } from "node:child_process";
/** Return the platform-specific command used to open a URL, without executing it. */
export function getBrowserInvocation(platform, url) {
    switch (platform) {
        case "win32": return { command: "cmd.exe", args: ["/c", "start", "", url] };
        case "darwin": return { command: "open", args: [url] };
        case "linux":
        case "freebsd":
        case "openbsd":
        case "sunos":
            return { command: "xdg-open", args: [url] };
        default: return undefined;
    }
}
const defaultBrowserSpawner = (command, args) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", () => undefined);
    return child;
};
/** Open a URL in the user's default browser; return false when unavailable or disabled. */
export function openBrowser(url, platform = process.platform, spawnBrowser = defaultBrowserSpawner) {
    if (process.env.CRAFT_NO_BROWSER === "1")
        return false;
    const invocation = getBrowserInvocation(platform, url);
    if (!invocation)
        return false;
    try {
        spawnBrowser(invocation.command, invocation.args).unref();
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=browser.js.map