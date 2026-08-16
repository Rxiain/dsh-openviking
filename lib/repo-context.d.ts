/**
 * RepoContext: an in-process TTL cache of `viking://resources/` direct
 * children, injected into the model prompt as dynamic context.
 *
 * The `systemPrompt.context` provider is synchronous and only reads the cache;
 * refresh happens best-effort in `apply()`, queued on `agent/session-start`,
 * and awaited once per `agent/pre-step` before the final decision returns.
 * Failures keep the last successful cache and log one deduplicated warning.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { OpenVikingClient } from "./client.js";
export interface RepoContextConfig {
    enabled: boolean;
    cacheTtlMs: number;
}
export interface RepoContext {
    /** Best-effort refresh; resolves to the current cache text (maybe stale). */
    refresh(options?: {
        force?: boolean;
        signal?: AbortSignal;
    }): Promise<string | undefined>;
    /** Synchronous prompt text; "" when disabled, empty, or never populated. */
    getPrompt(): string;
}
export declare function createRepoContext(ctx: Context, client: OpenVikingClient, config: RepoContextConfig | (() => RepoContextConfig)): RepoContext;
