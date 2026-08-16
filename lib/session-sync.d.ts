import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { OpenVikingClient } from "./client.js";
export interface AutoCommitConfig {
    enabled: boolean;
    /**
     * Commit after this many uncommitted USER turns (oh-my-pi's retain rhythm:
     * every N user turns, not wall-clock only). 0 disables the turn trigger.
     */
    turns: number;
    /** Wall-clock fallback: commit sessions with uncommitted messages older than this. */
    intervalMinutes: number;
}
export interface SessionSyncConfig {
    endpoint: string;
    apiKey: string;
    account: string;
    user: string;
    agentId: string;
    timeoutMs: number;
    stateFile: string;
    autoCommit: AutoCommitConfig;
    /** Auto-commit scheduler tick interval (test override; default 60s). */
    autoCommitTickMs?: number;
}
export interface CommitToolResult {
    session_id: string;
    status: "accepted" | "completed" | "failed";
    task_id?: string;
    archived?: boolean;
    memories_extracted: number;
}
/**
 * Remove the recall block this plugin appended (`<relevant-memories>…</relevant-memories>`
 * plus the trailing `Use memread…` guidance) so recalled memories are not
 * extracted into new memories on the next commit.
 */
export declare function stripRecallBlock(text: string): string;
export declare class SessionManager {
    private readonly ctx;
    private readonly client;
    private config;
    private readonly statePath;
    private readonly agents;
    private readonly states;
    private readonly ensured;
    /** Per-key single-flight for ensureSession: one GET/POST sequence per key. */
    private readonly ensureInFlight;
    private readonly chains;
    private readonly drainScheduled;
    private readonly warningKeys;
    private readonly logger;
    private saveTimer?;
    private autoCommitTimer?;
    private readonly backgroundAbort;
    private closing;
    /** Serialized state saves: each save chains on the previous one. */
    private saveQueue;
    private saveSeq;
    /** Resolved once init() has loaded state and adopted existing agents. */
    private readonly readyPromise;
    private readyResolve;
    private initDone;
    /** In-flight guard so a slow auto-commit tick cannot overlap the next. */
    private autoCommitRunning;
    constructor(ctx: Context, client: OpenVikingClient, config: SessionSyncConfig);
    /** Load state, adopt already-registered agents, and start the auto-commit timer. */
    init(): Promise<void>;
    /**
     * Swap the live configuration slice after a settings change. The state file
     * path is deliberately NOT re-read (it is fixed at construction); identity
     * and the auto-commit schedule follow the new config. The auto-commit timer
     * is restarted only when `autoCommit.enabled` flipped, so a running timer
     * keeps its phase and a disabled one stays off.
     */
    reconfigure(config: SessionSyncConfig): void;
    /**
     * Idempotently register a live agent and queue ensure+drain. Public adopts
     * are gated behind init() so an `agent/created` event arriving before the
     * state file is loaded cannot create fresh state that loadState later
     * overwrites.
     */
    adopt(agent: Agent): void;
    private adoptDirect;
    forget(agent: Agent): void;
    agentById(sessionId: string): Agent | undefined;
    /** The OpenViking session id for an agent: always `String(agent.id)`. */
    sessionIdOf(agent: Agent): string;
    private stateFor;
    /**
     * Ensure the remote OpenViking session exists. GET first; only a `NOT_FOUND`
     * error triggers POST `/sessions { session_id }`. Other errors surface for
     * retry at the next call site. Success is cached for the process lifetime;
     * concurrent calls share one GET/POST sequence via a per-key single-flight.
     */
    ensureSession(agent: Agent, signal?: AbortSignal): Promise<void>;
    /**
     * Append `fn` to the agent's promise chain and return its promise. All chain
     * work for one agent is strictly serialized: drains, flushes and commits can
     * never interleave.
     */
    private runOnChain;
    /**
     * Queue a coalesced drain for the agent on its promise chain. Non-waiting:
     * used from `session/event` and `agent/session-start` notifications. While a
     * drain is queued (not yet running), further notifications are ignored: the
     * single queued drain scans the latest event snapshot when it runs. A drain
     * queued before disposal still runs — it captures the agent object, so the
     * disposer can finish accepted work even after forget() removed the entry
     * (forget() only stops *new* drains).
     */
    queueDrain(agent: Agent, options?: {
        ensure?: boolean;
    }): void;
    /** Await the agent's drain chain (so in-flight drains settle). */
    waitForChain(agent: Agent): Promise<void>;
    /**
     * Send every eligible, not-yet-synced message in seq order, stopping at the
     * first network failure (later messages retry from the earliest gap). No
     * closing early-return: a drain that started before (or during) disposal
     * still finishes so accepted work is not dropped; dispose queues a final
     * drain that re-scans everything.
     */
    drainAgentNow(agent: Agent, signal?: AbortSignal): Promise<void>;
    /**
     * Drain pending messages ON the agent chain: the drain is serialized behind
     * any queued event drains instead of racing them, so no two scans can
     * interleave and duplicate a send.
     */
    flushSession(agent: Agent, signal?: AbortSignal): Promise<void>;
    /**
     * Commit the agent's OpenViking session. With no explicit session id the
     * current Harness history is flushed first; an explicit id different from
     * the current agent id commits only that OpenViking session (never the local
     * Harness history or state). Ensure + flush + snapshot + POST run ON the
     * agent chain so drains cannot add messages mid-snapshot; the (long) task
     * poll runs off the chain.
     */
    commitCurrentSession(agent: Agent, signal?: AbortSignal, explicitSessionId?: string): Promise<CommitToolResult>;
    /**
     * Commit an OpenViking session that is not this agent's own Harness session
     * (`session_id` differs from the current agent id). No Harness history is
     * flushed and no local state is touched.
     */
    commitExplicitSession(sessionId: string, signal?: AbortSignal): Promise<CommitToolResult>;
    /** Poll until the task settles; returns undefined on timeout. Throws on failure. */
    private pollTask;
    /** One status check for a pending commit (auto-commit tick path). */
    private pollPendingOnce;
    private settleTask;
    private startAutoCommit;
    private autoCommitTick;
    /**
     * POST a commit for a snapshot of the current uncommitted ids and record the
     * outcome: a pending task (later polls keep clearing only this snapshot) or
     * a synchronous completion (drop exactly the snapshot ids so a later tick
     * does not re-commit them; ids added after the snapshot survive).
     */
    private postCommit;
    /** Run one auto-commit scheduler pass now (the interval timer calls this). */
    runAutoCommitTick(): Promise<void>;
    private serialize;
    private loadState;
    private validateShape;
    private quarantine;
    /** Persist state; saves never overlap — each chains on the previous one. */
    private saveState;
    private debouncedSave;
    private warnOnce;
    /** Mark closing, stop timers, run a final drain per agent, then save. */
    dispose(): Promise<void>;
}
export declare function messageOf(error: unknown): string;
