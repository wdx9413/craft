import { type HostDriver, type HostExecutor, type HostOutputObserver } from "./host-driver.ts";
import { type HostProfile } from "./host-registry.ts";
import { CraftStore, type JsonObject } from "./store.ts";
/**
 * Runs any user-declared model CLI through one declarative profile.
 *
 * The contract is deliberately narrow: the profile names the executable and an
 * argv template, Craft pipes the prompt on stdin unless the template asks for
 * `{prompt}`, and success is "exit code 0 within the timeout". Anything richer
 * (structured event streams, budget caps, tool allowlists) stays with a built-in
 * driver, because guessing at an unknown CLI's protocol would be worse than
 * refusing to run it.
 */
export declare class GenericCliHostKernel implements HostDriver {
    readonly host: string;
    readonly dispatchKind: string;
    readonly profile: HostProfile;
    readonly store: CraftStore;
    executor: HostExecutor;
    constructor(store: CraftStore, profile: HostProfile, executor?: HostExecutor);
    private receiptKind;
    prepare(args: JsonObject): JsonObject;
    execute(args: JsonObject, options?: {
        signal?: AbortSignal;
        observe?: HostOutputObserver;
    }): Promise<JsonObject>;
}
