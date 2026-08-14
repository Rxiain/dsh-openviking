/**
 * dsh-openviking: OpenViking retrieval, resource management, auto-recall and
 * session memory for DeepSeek Harness.
 *
 * The plugin talks to an existing OpenViking HTTP service (never `ov` CLI, never
 * an embedded server), registers ten structured tools, injects the indexed
 * repository list and relevant memories during normal conversation, mirrors
 * user/assistant text into an OpenViking session and auto-commits it.
 */
import z from "@deepseek-ai/schemastery";
import type { Context } from "@deepseek-ai/cordis";
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "openviking";
/** Services required by this plugin. `agents` guarantees the registry is ready and lets us adopt live agents. */
export declare const inject: string[];
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
    /** Minimum score for non-leaf filler memories (0–1). */
    scoreThreshold: number;
    /** Per-memory content character cap. */
    maxContentChars: number;
    /** Approximate token budget; the injected block is capped at `tokenBudget * 4` chars. */
    tokenBudget: number;
}
export interface AutoCommitConfig {
    /** Periodically commit sessions with uncommitted messages. */
    enabled: boolean;
    /** Minimum minutes between automatic commits. */
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
    }>, Schemastery.ObjectT<{
        enabled: z<boolean, boolean>;
        limit: z<number, number>;
        scoreThreshold: z<number, number>;
        maxContentChars: z<number, number>;
        tokenBudget: z<number, number>;
    }>>;
    autoCommit: z<Schemastery.ObjectS<{
        enabled: z<boolean, boolean>;
        intervalMinutes: z<number, number>;
    }>, Schemastery.ObjectT<{
        enabled: z<boolean, boolean>;
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
    }>, Schemastery.ObjectT<{
        enabled: z<boolean, boolean>;
        limit: z<number, number>;
        scoreThreshold: z<number, number>;
        maxContentChars: z<number, number>;
        tokenBudget: z<number, number>;
    }>>;
    autoCommit: z<Schemastery.ObjectS<{
        enabled: z<boolean, boolean>;
        intervalMinutes: z<number, number>;
    }>, Schemastery.ObjectT<{
        enabled: z<boolean, boolean>;
        intervalMinutes: z<number, number>;
    }>>;
}>>;
/**
 * Mount the plugin. The service may be unreachable: the plugin still loads,
 * normal conversation continues, and automatic layers skip with deduplicated
 * warnings while explicit tool calls throw clear errors.
 */
export declare function apply(ctx: Context, config: Config): void;
