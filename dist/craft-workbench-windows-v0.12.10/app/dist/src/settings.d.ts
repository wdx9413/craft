import { type CraftPaths } from "./paths.ts";
export interface CraftSettings {
    schemaVersion: 1;
    locale: "zh-CN" | "en-US";
    theme: "system" | "light" | "dark";
    dataRoot: string;
    workbench: {
        port: number;
        openOnStart: boolean;
    };
    runtime: {
        defaultTier: "small" | "medium" | "large";
        maxSteps: number;
        maxTokens: number;
    };
    privacy: {
        telemetry: boolean;
    };
    updatedAt: string;
}
export type CraftSettingsPatch = Partial<Pick<CraftSettings, "locale" | "theme" | "dataRoot">> & {
    workbench?: Partial<CraftSettings["workbench"]>;
    runtime?: Partial<CraftSettings["runtime"]>;
    privacy?: Partial<CraftSettings["privacy"]>;
};
export declare function defaultSettings(paths?: CraftPaths): CraftSettings;
export declare function normalizeSettings(value: unknown, paths?: CraftPaths): CraftSettings;
export declare function loadSettings(paths?: CraftPaths): Promise<CraftSettings>;
export declare function saveSettings(patch: CraftSettingsPatch, paths?: CraftPaths, now?: Date): Promise<CraftSettings>;
export declare function resetSettings(paths?: CraftPaths, now?: Date): Promise<CraftSettings>;
export declare function loadSettingsSync(paths?: CraftPaths): CraftSettings;
export declare function saveSettingsSync(patch: CraftSettingsPatch, paths?: CraftPaths, now?: Date): CraftSettings;
export declare function resetSettingsSync(paths?: CraftPaths, now?: Date): CraftSettings;
export declare function publicSettings(settings: CraftSettings, paths?: CraftPaths): Record<string, unknown>;
