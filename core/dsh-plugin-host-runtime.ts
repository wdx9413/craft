import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { V01226Runtime } from "./generic-adapter-runtime.ts";
import { callMcpAdapter, listMcpAdapterTools } from "./mcp-adapter-client.ts";
import { dshArguments, resolveDshLaunch, type DshLaunch } from "./dsh-executable.ts";
import type { CraftSettings } from "./settings.ts";

export const DSH_CORDIS_ADAPTER_ID = "dsh.cordis-host";

export type DshPluginProfile = { launch: DshLaunch; profile: string; profileDirectory: string; bridge: string; installed_tools: JsonObject[] };

function bridgePackagePath(): string {
  const candidates = [
    resolve(process.cwd(), "adapters", "dsh-plugin-host"),
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "adapters", "dsh-plugin-host"),
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "adapters", "dsh-plugin-host"),
  ];
  const found = candidates.find((candidate) => existsSync(join(candidate, "package.json")));
  if (!found) throw new Error("craft-dsh-plugin-host package was not found");
  return found;
}

function profilePackage(profile: string, bridgePath: string): JsonObject {
  return {
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: { "craft-dsh-plugin-host": `link:${bridgePath}` },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "craft-dsh-plugin-host"] } },
  };
}

function dshEnvironment(launch: DshLaunch): NodeJS.ProcessEnv {
  return { ...process.env, ...launch.env, DSH_HOME: launch.dshHome };
}

async function packageNameFromSpec(spec: string): Promise<string> {
  const link = /^(?:link|file):(.+)$/u.exec(spec.trim())?.[1];
  if (link) {
    const manifestPath = join(resolve(link), "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { name?: unknown };
    if (typeof manifest.name !== "string" || !manifest.name.trim()) throw new Error("local DSH plugin package has no name");
    return manifest.name;
  }
  const value = spec.trim();
  if (value.startsWith("@")) {
    const slash = value.indexOf("/");
    const at = value.indexOf("@", slash + 1);
    return at === -1 ? value : value.slice(0, at);
  }
  const at = value.indexOf("@");
  return at === -1 ? value : value.slice(0, at);
}

function runDsh(launch: DshLaunch, args: string[], timeoutMs = 600_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    execFile(launch.executable, dshArguments(launch, args), {
      cwd: process.cwd(), env: dshEnvironment(launch), timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024, windowsHide: true, shell: false,
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`DSH plugin command failed: ${String(stderr).slice(-2000) || error.message}`));
      else resolveRun({ stdout, stderr });
    });
  });
}

/**
 * Isolated DSH Cordis profile. The user's DSH Desktop profile is never edited.
 */
export class DshPluginHostRuntime {
  readonly store: CraftStore;
  readonly settings: () => CraftSettings;
  readonly run: typeof runDsh;
  constructor(store: CraftStore, settings: () => CraftSettings, run: typeof runDsh = runDsh) {
    this.store = store;
    this.settings = settings;
    this.run = run;
  }

  status(): JsonObject {
    try {
      const settings = this.settings();
      const launch = resolveDshLaunch(settings);
      const profile = settings.workbench.dshPluginProfile;
      const profileDirectory = join(launch.dshHome, "profiles", profile);
      const bridge = bridgePackagePath();
      const manifest = this.store.find("adapter_manifest", DSH_CORDIS_ADAPTER_ID);
      return { status: "available", dsh_home: launch.dshHome, profile, profile_directory: profileDirectory,
        bridge_path: bridge, adapter_registered: Boolean(manifest), adapter_id: DSH_CORDIS_ADAPTER_ID,
        launcher_mode: launch.mode, installed_tools: this.installedTools(profileDirectory) };
    } catch (error) {
      return { status: "unavailable", adapter_id: DSH_CORDIS_ADAPTER_ID,
        detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Reflect DSH tool plugins installed in the isolated profile. These are
   * bundle entries in package.json; they become real tools inside DSH ACP
   * sessions. The Cordis bridge cannot proxy their execution (fiber-scoped
   * registration), so the catalog is the honest surface here.
   */
  installedTools(profileDirectory: string): JsonObject[] {
    try {
      const manifestPath = join(profileDirectory, "package.json");
      if (!existsSync(manifestPath)) return [];
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as JsonObject;
      const bundles = (((manifest.dsh as JsonObject | undefined)?.profile as JsonObject | undefined)?.bundles as unknown[] ?? [])
        .filter((entry): entry is string => typeof entry === "string");
      return bundles
        .filter((bundle) => bundle !== "@deepseek-ai/dsh-base" && bundle !== "craft-dsh-plugin-host")
        .map((bundle) => ({ name: bundle, kind: "dsh-tool-plugin" }));
    } catch {
      return [];
    }
  }

  async ensureProfile(): Promise<DshPluginProfile> {
    const settings = this.settings();
    const launch = resolveDshLaunch(settings);
    const profile = settings.workbench.dshPluginProfile;
    const profileDirectory = join(launch.dshHome, "profiles", profile);
    const bridge = bridgePackagePath();
    await mkdir(profileDirectory, { recursive: true });
    const packagePath = join(profileDirectory, "package.json");
    const expected = profilePackage(profile, bridge);
    const current = existsSync(packagePath) ? JSON.parse(await readFile(packagePath, "utf8")) as JsonObject : null;
    const merged = current ? {
      ...current,
      dependencies: { ...(current.dependencies as JsonObject ?? {}), "craft-dsh-plugin-host": `link:${bridge}` },
      dsh: {
        ...(current.dsh as JsonObject ?? {}),
        profile: {
          ...((current.dsh as JsonObject | undefined)?.profile as JsonObject ?? {}),
          bundles: [...new Set([
            ...(((current.dsh as JsonObject | undefined)?.profile as JsonObject | undefined)?.bundles as string[] ?? []),
            "@deepseek-ai/dsh-base",
            "craft-dsh-plugin-host",
          ])],
        },
      },
    } : expected;
    if (!current || JSON.stringify(current) !== JSON.stringify(merged)) {
      await writeFile(packagePath, `${JSON.stringify(merged, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    }
    const patchPath = join(profileDirectory, "cordis.patch.yml");
    if (!existsSync(patchPath)) await writeFile(patchPath, "[]\n", { encoding: "utf8", mode: 0o600 });
    const markerPath = join(profileDirectory, ".craft-bridge-installed");
    if (!existsSync(markerPath)) {
      await this.run(launch, ["plugin", "--profile", profile, "add", `link:${bridge}`]);
      await writeFile(markerPath, `${bridge}\n`, { encoding: "utf8", mode: 0o600 });
    }
    const manifest = new V01226Runtime(this.store).adapterRegister({
      adapter_id: DSH_CORDIS_ADAPTER_ID,
      version: "1.0.0",
      kind: "mcp",
      platforms: ["win32", "darwin", "linux"],
      entry: launch.executable,
      transport: "stdio",
      capabilities: ["dsh-tools"],
      permissions: ["dsh-plugin-host"],
      effects: ["read_only", "local_write", "external_write", "destructive"],
      metadata: {
        runtime: "dsh-cordis",
        command: launch.executable,
        args: dshArguments(launch, ["--profile", profile]),
        env: { ...launch.env, DSH_HOME: launch.dshHome },
        cwd: process.cwd(),
        transport: "stdio",
        plugin_profile: profile,
        bridge_path: bridge,
      },
    });
    return { launch, profile, profileDirectory, bridge, installed_tools: this.installedTools(profileDirectory), ...manifest };
  }

  async install(spec: string): Promise<JsonObject> {
    if (typeof spec !== "string" || !spec.trim() || spec.length > 4096 || spec.includes("\0")) throw new Error("DSH plugin spec is invalid");
    const { launch, profile, profileDirectory, bridge } = await this.ensureProfile();
    const result = await this.run(launch, ["plugin", "--profile", profile, "add", spec.trim()]);
    const packageName = await packageNameFromSpec(spec);
    const manifestPath = join(profileDirectory, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as JsonObject;
    const dsh = { ...(manifest.dsh as JsonObject ?? {}) };
    const profileConfig = { ...(dsh.profile as JsonObject ?? {}) };
    const bundles = [...new Set([...(profileConfig.bundles as string[] ?? []), packageName])];
    profileConfig.bundles = bundles;
    dsh.profile = profileConfig;
    manifest.dsh = dsh;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return { installed: true, spec: spec.trim(), profile, profile_directory: profileDirectory, bridge_path: bridge,
      stdout_digest: Buffer.byteLength(result.stdout), stderr_digest: Buffer.byteLength(result.stderr) };
  }

  async listTools(): Promise<JsonObject> {
    await this.ensureProfile();
    return listMcpAdapterTools(this.store.get("adapter_manifest", DSH_CORDIS_ADAPTER_ID));
  }

  async call(tool: string, args: JsonObject, timeoutMs?: number, outputLimit?: number): Promise<JsonObject> {
    await this.ensureProfile();
    return callMcpAdapter(this.store.get("adapter_manifest", DSH_CORDIS_ADAPTER_ID), {
      adapter_id: DSH_CORDIS_ADAPTER_ID, tool, arguments: args,
      ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }),
      ...(outputLimit === undefined ? {} : { output_limit: outputLimit }),
    });
  }
}
