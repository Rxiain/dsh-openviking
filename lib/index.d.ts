/**
 * dsh-openviking: OpenViking retrieval, resource management, auto-recall and
 * session memory for DeepSeek Harness.
 *
 * The plugin talks to an existing OpenViking HTTP service (never `ov` CLI, never
 * an embedded server), registers the structured tools, injects the indexed
 * repository list and user/assistant text into an OpenViking session, and
 * auto-commits it.
 *
 * Configuration is exposed through the user-settings seam (`ctx.settings`,
 * namespace `openviking`): the dsh web UI's Plugins → Plugin configuration
 * page edits the same schema this file validates, layered over the profile's
 * composed entry config. Request-facing fields (endpoint, headers, timeouts)
 * apply live; the session state file is read at boot.
 */
import z from "@deepseek-ai/schemastery";
import type { Context } from "@deepseek-ai/cordis";
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "openviking";
/** Services required by this plugin. `agents` guarantees the registry is ready and lets us adopt live agents. */
export declare const inject: string[];
/** User-settings namespace carrying this plugin's configuration. */
export declare const SETTINGS_NAMESPACE = "openviking";
export interface RepoContextConfig {
    /** Inject the indexed-repository list into the system prompt. */
    enabled: boolean;
    /** TTL of the in-process repository cache in milliseconds. */
    cacheTtlMs: number;
}
export interface AutoRecallConfig {
    /** Auto-inject relevant memories before each model step. */
    enabled: boolean;
    /** Maximum memories injected per step. */
    limit: number;
    /** Minimum local relevance: semantic score plus bounded lexical overlap (0–1). */
    scoreThreshold: number;
    /** Per-memory content character cap. */
    maxContentChars: number;
    /** Approximate token budget; the injected block is capped at `tokenBudget * 4` chars. */
    tokenBudget: number;
    /** Also search the agent space (`viking://agent/`) for cases/patterns/tools/skills memories and skill playbooks. */
    agentSpaces: boolean;
    /** Re-search mid-message every N tool steps and inject only new memories (0 disables). */
    refreshSteps: number;
    /** Memory map: inject on session start, refresh every N user turns (2+); 1 = start only, 0 = never. */
    startupMapEveryTurns: number;
}
export interface AutoCommitConfig {
    /** Periodically commit sessions with uncommitted messages. */
    enabled: boolean;
    /**
     * Commit after this many uncommitted USER turns (oh-my-pi style rhythm:
     * retain every N user turns instead of only wall-clock). 0 disables the
     * turn trigger and falls back to `intervalMinutes` alone.
     */
    turns: number;
    /** Wall-clock fallback: commit any session with uncommitted messages older than this. */
    intervalMinutes: number;
}
export interface Config {
    /** OpenViking HTTP service base URL. */
    endpoint: string;
    /** `X-API-Key` value; empty omits the header. */
    apiKey: string;
    /** `X-OpenViking-Account` value; empty omits the header. */
    account: string;
    /** `X-OpenViking-User` value; empty omits the header. */
    user: string;
    /** `X-OpenViking-Agent` value; empty omits the header. */
    agentId: string;
    /** Per-request timeout in milliseconds (1000–300000). */
    timeoutMs: number;
    /** Session-sync state file; `~` is expanded. */
    stateFile: string;
    repoContext: RepoContextConfig;
    autoRecall: AutoRecallConfig;
    autoCommit: AutoCommitConfig;
}
export declare const Config: z<Schemastery.ObjectS<{
    endpoint: z<string, string>;
    apiKey: z<string, string>;
    account: z<string, string>;
    user: z<string, string>;
    agentId: z<string, string>;
    timeoutMs: z<number, number>;
    stateFile: z<string, string>;
    repoContext: z<Schemastery.ObjectS<{
        enabled: z<boolean, boolean>;
        cacheTtlMs: z<number, number>;
    }>, Schemastery.ObjectT<{
        enabled: z<boolean, boolean>;
        cacheTtlMs: z<number, number>;
    }>>;
    autoRecall: z<Schemastery.ObjectS<{
        enabled: z<boolean, boolean>;
        limit: z<number, number>;
        scoreThreshold: z<number, number>;
        maxContentChars: z<number, number>;
        tokenBudget: z<number, number>;
        agentSpaces: z<boolean, boolean>;
        refreshSteps: z<number, number>;
        startupMapEveryTurns: z<number, number>;
    }>, Schemastery.ObjectT<{
        enabled: z<boolean, boolean>;
        limit: z<number, number>;
        scoreThreshold: z<number, number>;
        maxContentChars: z<number, number>;
        tokenBudget: z<number, number>;
        agentSpaces: z<boolean, boolean>;
        refreshSteps: z<number, number>;
        startupMapEveryTurns: z<number, number>;
    }>>;
    autoCommit: z<Schemastery.ObjectS<{
        enabled: z<boolean, boolean>;
        turns: z<number, number>;
        intervalMinutes: z<number, number>;
    }>, Schemastery.ObjectT<{
        enabled: z<boolean, boolean>;
        turns: z<number, number>;
        intervalMinutes: z<number, number>;
    }>>;
}>, Schemastery.ObjectT<{
    endpoint: z<string, string>;
    apiKey: z<string, string>;
    account: z<string, string>;
    user: z<string, string>;
    agentId: z<string, string>;
    timeoutMs: z<number, number>;
    stateFile: z<string, string>;
    repoContext: z<Schemastery.ObjectS<{
        enabled: z<boolean, boolean>;
        cacheTtlMs: z<number, number>;
    }>, Schemastery.ObjectT<{
        enabled: z<boolean, boolean>;
        cacheTtlMs: z<number, number>;
    }>>;
    autoRecall: z<Schemastery.ObjectS<{
        enabled: z<boolean, boolean>;
        limit: z<number, number>;
        scoreThreshold: z<number, number>;
        maxContentChars: z<number, number>;
        tokenBudget: z<number, number>;
        agentSpaces: z<boolean, boolean>;
        refreshSteps: z<number, number>;
        startupMapEveryTurns: z<number, number>;
    }>, Schemastery.ObjectT<{
        enabled: z<boolean, boolean>;
        limit: z<number, number>;
        scoreThreshold: z<number, number>;
        maxContentChars: z<number, number>;
        tokenBudget: z<number, number>;
        agentSpaces: z<boolean, boolean>;
        refreshSteps: z<number, number>;
        startupMapEveryTurns: z<number, number>;
    }>>;
    autoCommit: z<Schemastery.ObjectS<{
        enabled: z<boolean, boolean>;
        turns: z<number, number>;
        intervalMinutes: z<number, number>;
    }>, Schemastery.ObjectT<{
        enabled: z<boolean, boolean>;
        turns: z<number, number>;
        intervalMinutes: z<number, number>;
    }>>;
}>>;
/**
 * Mount the plugin. The service may be unreachable: the plugin still loads,
 * normal conversation continues, and automatic layers skip with deduplicated
 * warnings while explicit tool calls throw clear errors.
 */
export declare function apply(ctx: Context, config: Config): void;
