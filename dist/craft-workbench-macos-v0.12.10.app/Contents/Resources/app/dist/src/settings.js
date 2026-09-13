import { access, readFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { resolve } from "node:path";
import { atomicPrivateJson, craftPaths, ensureLayout } from "./paths.js";
function number(value, name, fallback, min, max) {
    if (value === undefined)
        return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max)
        throw new Error(`${name} must be an integer between ${min} and ${max}`);
    return parsed;
}
function boolean(value, name, fallback) {
    if (value === undefined)
        return fallback;
    if (typeof value !== "boolean")
        throw new Error(`${name} must be a boolean`);
    return value;
}
function text(value, name, fallback) {
    if (value === undefined)
        return fallback;
    if (typeof value !== "string" || !value.trim())
        throw new Error(`${name} must be a non-empty string`);
    return value.trim();
}
export function defaultSettings(paths = craftPaths()) {
    return { schemaVersion: 1, locale: "zh-CN", theme: "system", dataRoot: paths.root,
        workbench: { port: 4173, openOnStart: true }, runtime: { defaultTier: "medium", maxSteps: 32, maxTokens: 12000 },
        privacy: { telemetry: false }, updatedAt: new Date(0).toISOString() };
}
export function normalizeSettings(value, paths = craftPaths()) {
    const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const workbench = input.workbench && typeof input.workbench === "object" && !Array.isArray(input.workbench) ? input.workbench : {};
    const runtime = input.runtime && typeof input.runtime === "object" && !Array.isArray(input.runtime) ? input.runtime : {};
    const privacy = input.privacy && typeof input.privacy === "object" && !Array.isArray(input.privacy) ? input.privacy : {};
    const dataRoot = resolve(text(input.dataRoot, "dataRoot", paths.root));
    const locale = text(input.locale, "locale", "zh-CN");
    if (locale !== "zh-CN" && locale !== "en-US")
        throw new Error("locale must be zh-CN or en-US");
    const theme = text(input.theme, "theme", "system");
    if (theme !== "system" && theme !== "light" && theme !== "dark")
        throw new Error("theme must be system, light, or dark");
    const defaultTier = text(runtime.defaultTier, "runtime.defaultTier", "medium");
    if (defaultTier !== "small" && defaultTier !== "medium" && defaultTier !== "large")
        throw new Error("runtime.defaultTier must be small, medium, or large");
    const updatedAt = text(input.updatedAt, "updatedAt", new Date(0).toISOString());
    if (Number.isNaN(Date.parse(updatedAt)))
        throw new Error("updatedAt must be an ISO timestamp");
    return { schemaVersion: 1, locale: locale, theme: theme, dataRoot,
        workbench: { port: number(workbench.port, "workbench.port", 4173, 0, 65535), openOnStart: boolean(workbench.openOnStart, "workbench.openOnStart", true) },
        runtime: { defaultTier: defaultTier, maxSteps: number(runtime.maxSteps, "runtime.maxSteps", 32, 1, 10000), maxTokens: number(runtime.maxTokens, "runtime.maxTokens", 12000, 1, 100000000) },
        privacy: { telemetry: boolean(privacy.telemetry, "privacy.telemetry", false) }, updatedAt };
}
export async function loadSettings(paths = craftPaths()) {
    await ensureLayout(paths);
    try {
        await access(paths.settingsFile);
        return normalizeSettings(JSON.parse(await readFile(paths.settingsFile, "utf8")), paths);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            return defaultSettings(paths);
        const settings = defaultSettings(paths);
        await atomicPrivateJson(paths.settingsFile, settings);
        return settings;
    }
}
export async function saveSettings(patch, paths = craftPaths(), now = new Date()) {
    const current = await loadSettings(paths);
    const next = normalizeSettings({ ...current, ...patch,
        workbench: { ...current.workbench, ...(patch.workbench ?? {}) }, runtime: { ...current.runtime, ...(patch.runtime ?? {}) },
        privacy: { ...current.privacy, ...(patch.privacy ?? {}) }, updatedAt: now.toISOString() }, paths);
    await atomicPrivateJson(paths.settingsFile, next);
    return next;
}
export async function resetSettings(paths = craftPaths(), now = new Date()) {
    const next = { ...defaultSettings(paths), updatedAt: now.toISOString() };
    await atomicPrivateJson(paths.settingsFile, next);
    return next;
}
function syncWrite(path, value) {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
}
export function loadSettingsSync(paths = craftPaths()) {
    if (!existsSync(paths.settingsFile)) {
        const settings = defaultSettings(paths);
        syncWrite(paths.settingsFile, settings);
        return settings;
    }
    try {
        return normalizeSettings(JSON.parse(readFileSync(paths.settingsFile, "utf8")), paths);
    }
    catch {
        return defaultSettings(paths);
    }
}
export function saveSettingsSync(patch, paths = craftPaths(), now = new Date()) {
    const current = loadSettingsSync(paths);
    const next = normalizeSettings({ ...current, ...patch,
        workbench: { ...current.workbench, ...(patch.workbench ?? {}) }, runtime: { ...current.runtime, ...(patch.runtime ?? {}) },
        privacy: { ...current.privacy, ...(patch.privacy ?? {}) }, updatedAt: now.toISOString() }, paths);
    syncWrite(paths.settingsFile, next);
    return next;
}
export function resetSettingsSync(paths = craftPaths(), now = new Date()) {
    const next = { ...defaultSettings(paths), updatedAt: now.toISOString() };
    syncWrite(paths.settingsFile, next);
    return next;
}
export function publicSettings(settings, paths = craftPaths()) {
    return { ...settings, settingsFile: paths.settingsFile, dataRoot: settings.dataRoot, restartRequiredForDataRoot: settings.dataRoot !== paths.root,
        secretsStored: false, note: "Credentials remain in environment variables or host stores; settings.json never contains API keys." };
}
//# sourceMappingURL=settings.js.map