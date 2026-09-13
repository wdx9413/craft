export type BrowserInvocation = {
    command: string;
    args: string[];
};
export type BrowserSpawner = (command: string, args: string[]) => {
    unref(): void;
};
/** Return the platform-specific command used to open a URL, without executing it. */
export declare function getBrowserInvocation(platform: NodeJS.Platform, url: string): BrowserInvocation | undefined;
/** Open a URL in the user's default browser; return false when unavailable or disabled. */
export declare function openBrowser(url: string, platform?: NodeJS.Platform, spawnBrowser?: BrowserSpawner): boolean;
