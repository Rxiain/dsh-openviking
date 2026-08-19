/** Human slash command: `/memlearn`. */
import type { Context } from "@deepseek-ai/cordis";
import type { CommandDefinition } from "@deepseek-ai/dsh-commands";
import type { OpenVikingClient } from "./client.js";
import type { LearnService, LearnResult } from "./learn-service.js";
export interface OpenVikingCommandDeps {
    client: OpenVikingClient;
    learn: LearnService;
    /** Live per-request timeout in milliseconds (thunk reads current settings). */
    timeoutMs: () => number;
}
/** Optional command registry surface (absent when the host lacks the capability). */
type CommandRegistryLike = {
    register(definition: CommandDefinition): () => void;
};
export declare const MEMLEARN_USAGE: string;
/** Render any `/memlearn` failure (validation, service, or network) as text. */
export declare function formatMemlearnError(error: unknown): string;
export declare function formatMemlearnSuccess(result: LearnResult): string;
export declare function registerCommandsOn(commands: CommandRegistryLike, deps: OpenVikingCommandDeps): Array<() => void>;
export declare function registerOpenVikingCommands(ctx: Context, deps: OpenVikingCommandDeps): void;
export {};
