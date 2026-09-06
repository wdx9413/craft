export declare const name = "craft-adapter";
export declare const inject: string[];
type AdapterConfig = {
    npxCommand?: string;
    packageSpec?: string;
    dataDir?: string;
};
type Context = {
    tools: {
        register(tool: unknown): void;
    };
};
export declare function apply(ctx: Context, config?: AdapterConfig): void;
export {};
