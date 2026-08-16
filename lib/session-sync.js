/**
 * SessionManager: mirror Harness user/assistant text into an OpenViking
 * session (id = `String(agent.id)`) and auto-commit it on an interval.
 *
 * Transport semantics are at-least-once: a crash between a successful remote
 * add-message and the atomic state-file write may replay that one message on
 * recovery. Normal exit / HMR / controlled shutdown closes the window via the
 * disposer's flush; crash-exactly-once is never claimed.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { OpenVikingError, isRecord } from "./types.js";
/**
 * Build a commit result with only present optional keys — `undefined` field
 * values are not lossless JSON and would fail the tool output validator.
 */
function commitToolResult(result) {
    return {
        session_id: result.session_id,
        status: result.status,
        ...(result.taskId !== undefined ? { task_id: result.taskId } : {}),
        ...(result.archived !== undefined ? { archived: result.archived } : {}),
        memories_extracted: result.memoriesExtracted,
    };
}
const COMMIT_POLL_INTERVAL_MS = 2_000;
const COMMIT_POLL_TIMEOUT_MS = 180_000;
const SAVE_DEBOUNCE_MS = 300;
const AUTO_COMMIT_TICK_MS = 60_000;
function expandHome(value) {
    if (value === "~")
        return homedir();
    if (value.startsWith("~/"))
        return join(homedir(), value.slice(2));
    return value;
}
function normalizeEndpoint(endpoint) {
    return endpoint.trim().replace(/\/+$/, "");
}
/** True when the message belongs to the OpenViking session keyed by `key`. */
function messageIdOf(event) {
    if (event.type === "user/message" && "id" in event.data) {
        return typeof event.data.id === "string" ? event.data.id : undefined;
    }
    if (event.type === "assistant/message" && "message" in event.data && isRecord(event.data.message) && "id" in event.data.message) {
        return typeof event.data.message.id === "string" ? event.data.message.id : undefined;
    }
    return undefined;
}
/** Whether an event should be mirrored to OpenViking at all. */
function isEligibleEvent(event) {
    if (event.type === "user/message") {
        const data = event.data;
        // Only real human prompts. Plugin-injected context, runtime context and
        // tool results must never be extracted into user preferences.
        return isRecord(data.source) && data.source.kind === "user";
    }
    return event.type === "assistant/message";
}
/** Top-level text blocks only; reasoning/image/tool-call blocks are ignored. */
function extractMessageText(content) {
    if (typeof content === "string")
        return content.trim();
    if (!Array.isArray(content))
        return "";
    const parts = content
        .filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
        .map((part) => part.text);
    return parts.join("\n").trim();
}
/**
 * Remove the recall block this plugin appended (`<relevant-memories>…</relevant-memories>`
 * plus the trailing `Use memread…` guidance) so recalled memories are not
 * extracted into new memories on the next commit.
 */
export function stripRecallBlock(text) {
    const start = text.lastIndexOf("<relevant-memories>");
    if (start === -1)
        return text;
    const end = text.lastIndexOf("</relevant-memories>");
    if (end === -1 || end < start)
        return text;
    const head = text.slice(0, start);
    let tail = text.slice(end + "</relevant-memories>".length);
    // Drop the guidance line that follows the block (injection appends it).
    tail = tail.replace(/^\s*Use `memread`[^\n]*/, "");
    return (head + tail).replace(/[\t ]+$/gm, "").replace(/\n{3,}/g, "\n\n").trimEnd();
}
// ─── SessionManager ─────────────────────────────────────────────────────
export class SessionManager {
    ctx;
    client;
    config;
    statePath;
    agents = new Map();
    states = new Map();
    ensured = new Set();
    /** Per-key single-flight for ensureSession: one GET/POST sequence per key. */
    ensureInFlight = new Map();
    chains = new Map();
    drainScheduled = new Set();
    warningKeys = new Set();
    logger;
    saveTimer;
    autoCommitTimer;
    backgroundAbort = new AbortController();
    closing = false;
    /** Serialized state saves: each save chains on the previous one. */
    saveQueue = Promise.resolve();
    saveSeq = 0;
    /** Resolved once init() has loaded state and adopted existing agents. */
    readyPromise;
    readyResolve;
    initDone = false;
    /** In-flight guard so a slow auto-commit tick cannot overlap the next. */
    autoCommitRunning = false;
    constructor(ctx, client, config) {
        this.ctx = ctx;
        this.client = client;
        this.config = config;
        this.statePath = expandHome(config.stateFile);
        this.logger = ctx.logger("openviking:session-sync");
        this.readyPromise = new Promise((resolve) => (this.readyResolve = resolve));
    }
    /** Load state, adopt already-registered agents, and start the auto-commit timer. */
    async init() {
        try {
            await this.loadState();
            for (const agent of this.ctx.agents.list())
                this.adoptDirect(agent);
            this.startAutoCommit();
        }
        finally {
            this.initDone = true;
            this.readyResolve();
        }
    }
    /**
     * Swap the live configuration slice after a settings change. The state file
     * path is deliberately NOT re-read (it is fixed at construction); identity
     * and the auto-commit schedule follow the new config. The auto-commit timer
     * is restarted only when `autoCommit.enabled` flipped, so a running timer
     * keeps its phase and a disabled one stays off.
     */
    reconfigure(config) {
        this.config = config;
        if (!this.initDone)
            return;
        if (this.config.autoCommit.enabled && !this.autoCommitTimer) {
            this.startAutoCommit();
        }
        else if (!this.config.autoCommit.enabled && this.autoCommitTimer) {
            clearInterval(this.autoCommitTimer);
            this.autoCommitTimer = undefined;
        }
    }
    // ─── adoption ─────────────────────────────────────────────────────────
    /**
     * Idempotently register a live agent and queue ensure+drain. Public adopts
     * are gated behind init() so an `agent/created` event arriving before the
     * state file is loaded cannot create fresh state that loadState later
     * overwrites.
     */
    adopt(agent) {
        if (this.initDone) {
            this.adoptDirect(agent);
            return;
        }
        void this.readyPromise.then(() => this.adoptDirect(agent));
    }
    adoptDirect(agent) {
        const key = String(agent.id);
        if (this.agents.has(key))
            return;
        this.agents.set(key, agent);
        this.queueDrain(agent, { ensure: true });
    }
    forget(agent) {
        this.agents.delete(String(agent.id));
    }
    agentById(sessionId) {
        return this.agents.get(sessionId);
    }
    /** The OpenViking session id for an agent: always `String(agent.id)`. */
    sessionIdOf(agent) {
        return String(agent.id);
    }
    stateFor(key) {
        let state = this.states.get(key);
        if (!state) {
            state = { syncedMessageIds: new Set(), uncommittedMessageIds: new Set() };
            this.states.set(key, state);
        }
        return state;
    }
    // ─── remote session existence ─────────────────────────────────────────
    /**
     * Ensure the remote OpenViking session exists. GET first; only a `NOT_FOUND`
     * error triggers POST `/sessions { session_id }`. Other errors surface for
     * retry at the next call site. Success is cached for the process lifetime;
     * concurrent calls share one GET/POST sequence via a per-key single-flight.
     */
    async ensureSession(agent, signal) {
        const key = String(agent.id);
        if (this.ensured.has(key))
            return;
        const inFlight = this.ensureInFlight.get(key);
        if (inFlight)
            return inFlight;
        const run = (async () => {
            try {
                await this.client.getSession(key, signal);
                this.ensured.add(key);
            }
            catch (error) {
                if (error instanceof OpenVikingError && error.code === "NOT_FOUND") {
                    await this.client.createSession(key, signal);
                    this.ensured.add(key);
                }
                else {
                    throw error;
                }
            }
            finally {
                this.ensureInFlight.delete(key);
            }
        })();
        this.ensureInFlight.set(key, run);
        return run;
    }
    // ─── draining ─────────────────────────────────────────────────────────
    /**
     * Append `fn` to the agent's promise chain and return its promise. All chain
     * work for one agent is strictly serialized: drains, flushes and commits can
     * never interleave.
     */
    runOnChain(key, fn) {
        const prev = this.chains.get(key) ?? Promise.resolve();
        const next = prev.then(fn);
        // Keep the chain alive even when this link rejects internally.
        this.chains.set(key, next.then(() => undefined, () => undefined));
        return next;
    }
    /**
     * Queue a coalesced drain for the agent on its promise chain. Non-waiting:
     * used from `session/event` and `agent/session-start` notifications. While a
     * drain is queued (not yet running), further notifications are ignored: the
     * single queued drain scans the latest event snapshot when it runs. A drain
     * queued before disposal still runs — it captures the agent object, so the
     * disposer can finish accepted work even after forget() removed the entry
     * (forget() only stops *new* drains).
     */
    queueDrain(agent, options = {}) {
        const key = String(agent.id);
        if (this.closing || this.drainScheduled.has(key))
            return;
        this.drainScheduled.add(key);
        void this.runOnChain(key, async () => {
            this.drainScheduled.delete(key);
            try {
                if (options.ensure)
                    await this.ensureSession(agent);
                await this.drainAgentNow(agent);
            }
            catch (error) {
                this.warnOnce("drain", key, error);
            }
        });
    }
    /** Await the agent's drain chain (so in-flight drains settle). */
    async waitForChain(agent) {
        const chain = this.chains.get(String(agent.id));
        if (chain)
            await chain;
    }
    /**
     * Send every eligible, not-yet-synced message in seq order, stopping at the
     * first network failure (later messages retry from the earliest gap). No
     * closing early-return: a drain that started before (or during) disposal
     * still finishes so accepted work is not dropped; dispose queues a final
     * drain that re-scans everything.
     */
    async drainAgentNow(agent, signal) {
        const key = String(agent.id);
        const state = this.stateFor(key);
        for (const event of agent.session.events) {
            if (!isEligibleEvent(event))
                continue;
            const id = messageIdOf(event);
            if (!id)
                continue;
            const dedupeKey = `${event.type === "user/message" ? "user" : "assistant"}:${id}`;
            if (state.syncedMessageIds.has(dedupeKey))
                continue;
            let text;
            if (event.type === "user/message") {
                text = "content" in event.data ? extractMessageText(event.data.content) : "";
                text = stripRecallBlock(text);
            }
            else {
                text =
                    "message" in event.data && isRecord(event.data.message) && "content" in event.data.message
                        ? extractMessageText(event.data.message.content)
                        : "";
            }
            if (!text)
                continue;
            const role = event.type === "user/message" ? "user" : "assistant";
            await this.client.addSessionMessage(key, role, text, signal);
            state.syncedMessageIds.add(dedupeKey);
            state.uncommittedMessageIds.add(dedupeKey);
            this.debouncedSave();
        }
    }
    /**
     * Drain pending messages ON the agent chain: the drain is serialized behind
     * any queued event drains instead of racing them, so no two scans can
     * interleave and duplicate a send.
     */
    async flushSession(agent, signal) {
        await this.runOnChain(String(agent.id), () => this.drainAgentNow(agent, signal));
    }
    // ─── commit ───────────────────────────────────────────────────────────
    /**
     * Commit the agent's OpenViking session. With no explicit session id the
     * current Harness history is flushed first; an explicit id different from
     * the current agent id commits only that OpenViking session (never the local
     * Harness history or state). Ensure + flush + snapshot + POST run ON the
     * agent chain so drains cannot add messages mid-snapshot; the (long) task
     * poll runs off the chain.
     */
    async commitCurrentSession(agent, signal, explicitSessionId) {
        const key = String(agent.id);
        const sessionId = explicitSessionId ?? key;
        if (explicitSessionId && explicitSessionId !== key) {
            return this.commitExplicitSession(sessionId, signal);
        }
        const outcome = await this.runOnChain(key, async () => {
            await this.ensureSession(agent, signal);
            await this.drainAgentNow(agent, signal);
            const state = this.stateFor(key);
            // A commit for this session is already in flight: poll it, never start a
            // concurrent second one.
            if (state.pendingCommit) {
                return { kind: "pending", taskId: state.pendingCommit.taskId };
            }
            const snapshot = [...state.uncommittedMessageIds];
            const commit = await this.client.commitSession(sessionId, signal);
            if (typeof commit.task_id === "string" && commit.task_id) {
                state.pendingCommit = { taskId: commit.task_id, startedAt: Date.now(), messageIds: snapshot };
                this.debouncedSave();
                return { kind: "posted", taskId: commit.task_id, archived: commit.archived ?? false };
            }
            // No task: synchronously completed. Drop exactly the snapshot ids so a
            // later tick does not re-commit them; ids added after the snapshot
            // survive.
            for (const id of snapshot)
                state.uncommittedMessageIds.delete(id);
            state.lastCommitTime = Date.now();
            this.debouncedSave();
            return { kind: "synced", archived: commit.archived ?? false };
        });
        const state = this.stateFor(key);
        if (outcome.kind === "pending") {
            const task = await this.pollTask(outcome.taskId, signal, COMMIT_POLL_TIMEOUT_MS);
            if (!task) {
                return commitToolResult({
                    session_id: sessionId,
                    status: "accepted",
                    taskId: outcome.taskId,
                    memoriesExtracted: 0,
                });
            }
            return this.settleTask(state, task, sessionId, signal);
        }
        if (outcome.kind === "posted") {
            const task = await this.pollTask(outcome.taskId, signal, COMMIT_POLL_TIMEOUT_MS);
            if (!task) {
                return commitToolResult({
                    session_id: sessionId,
                    status: "accepted",
                    taskId: outcome.taskId,
                    archived: outcome.archived,
                    memoriesExtracted: 0,
                });
            }
            return this.settleTask(state, task, sessionId, signal, outcome.archived);
        }
        return commitToolResult({
            session_id: sessionId,
            status: "completed",
            archived: outcome.archived,
            memoriesExtracted: 0,
        });
    }
    /**
     * Commit an OpenViking session that is not this agent's own Harness session
     * (`session_id` differs from the current agent id). No Harness history is
     * flushed and no local state is touched.
     */
    async commitExplicitSession(sessionId, signal) {
        const commit = await this.client.commitSession(sessionId, signal);
        if (typeof commit.task_id !== "string" || !commit.task_id) {
            return commitToolResult({
                session_id: sessionId,
                status: "completed",
                archived: commit.archived ?? false,
                memoriesExtracted: 0,
            });
        }
        const task = await this.pollTask(commit.task_id, signal, COMMIT_POLL_TIMEOUT_MS);
        if (!task) {
            return commitToolResult({
                session_id: sessionId,
                status: "accepted",
                taskId: commit.task_id,
                memoriesExtracted: 0,
            });
        }
        if (task.status === "failed") {
            const message = typeof task.error === "string" && task.error ? task.error : "OpenViking session commit failed";
            throw new OpenVikingError(this.client.endpoint, message, { code: "COMMIT_FAILED" });
        }
        const result = isRecord(task.result) ? task.result : {};
        return commitToolResult({
            session_id: sessionId,
            status: "completed",
            taskId: task.task_id,
            archived: typeof result.archived === "boolean" ? result.archived : commit.archived ?? false,
            memoriesExtracted: totalMemoriesExtracted(result.memories_extracted),
        });
    }
    /** Poll until the task settles; returns undefined on timeout. Throws on failure. */
    async pollTask(taskId, signal, timeoutMs) {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
            if (signal?.aborted)
                throw new DOMException("The operation was aborted", "AbortError");
            const task = await this.client.getTask(taskId, signal);
            if (task.status === "completed" || task.status === "failed")
                return task;
            await sleep(COMMIT_POLL_INTERVAL_MS, signal);
        }
        return undefined;
    }
    /** One status check for a pending commit (auto-commit tick path). */
    async pollPendingOnce(key, state) {
        const pending = state.pendingCommit;
        if (!pending)
            return;
        try {
            const task = await this.client.getTask(pending.taskId, this.backgroundAbort.signal);
            if (task.status === "completed" || task.status === "failed") {
                await this.settleTask(state, task, key, undefined);
            }
        }
        catch (error) {
            if (this.backgroundAbort.signal.aborted)
                return;
            this.warnOnce("commit-poll", key, error);
        }
    }
    async settleTask(state, task, sessionId, signal, fallbackArchived) {
        if (task.status === "failed") {
            const message = typeof task.error === "string" && task.error ? task.error : "OpenViking session commit failed";
            // Clear the pending marker but keep every uncommitted message for retry.
            state.pendingCommit = undefined;
            this.debouncedSave();
            throw new OpenVikingError(this.client.endpoint, message, { code: "COMMIT_FAILED" });
        }
        // completed: drop exactly the snapshot ids, keep ids added during the commit.
        const snapshot = state.pendingCommit?.messageIds ?? [];
        state.pendingCommit = undefined;
        for (const id of snapshot)
            state.uncommittedMessageIds.delete(id);
        state.lastCommitTime = Date.now();
        this.debouncedSave();
        const result = isRecord(task.result) ? task.result : {};
        return commitToolResult({
            session_id: sessionId,
            status: "completed",
            taskId: task.task_id,
            archived: typeof result.archived === "boolean" ? result.archived : fallbackArchived,
            memoriesExtracted: totalMemoriesExtracted(result.memories_extracted),
        });
    }
    // ─── auto commit ──────────────────────────────────────────────────────
    startAutoCommit() {
        if (this.autoCommitTimer || !this.config.autoCommit.enabled)
            return;
        const tickMs = this.config.autoCommitTickMs ?? AUTO_COMMIT_TICK_MS;
        this.autoCommitTimer = setInterval(() => {
            this.autoCommitTick().catch((error) => {
                this.logger.warn("auto-commit tick failed", { error: messageOf(error) });
            });
        }, tickMs);
    }
    async autoCommitTick() {
        if (this.autoCommitRunning)
            return;
        this.autoCommitRunning = true;
        try {
            const intervalMs = this.config.autoCommit.intervalMinutes * 60_000;
            const now = Date.now();
            for (const [key, state] of this.states) {
                if (this.backgroundAbort.signal.aborted)
                    return;
                if (state.pendingCommit) {
                    await this.pollPendingOnce(key, state);
                    continue;
                }
                const timeSince = now - (state.lastCommitTime ?? 0);
                if (state.uncommittedMessageIds.size === 0)
                    continue;
                // oh-my-pi style rhythm: commit once N user turns accumulated; the
                // wall-clock interval is a fallback so idle-but-dirty sessions still
                // flush.
                const uncommittedUserTurns = [...state.uncommittedMessageIds].filter((id) => id.startsWith("user:")).length;
                const turnTrigger = this.config.autoCommit.turns > 0 && uncommittedUserTurns >= this.config.autoCommit.turns;
                if (!turnTrigger) {
                    // With the turn trigger enabled, a never-committed session waits for
                    // the trigger instead of being treated as "last commit long ago".
                    // With turns=0 (trigger disabled) the interval is the only fallback,
                    // so a never-committed session is treated as long overdue and
                    // commits on the first tick.
                    if (this.config.autoCommit.turns > 0 && state.lastCommitTime === undefined)
                        continue;
                    if (state.lastCommitTime !== undefined && timeSince < intervalMs)
                        continue;
                }
                const agent = this.agents.get(key);
                if (!agent) {
                    // No live agent: only already-remote state remains; commit directly.
                    await this.postCommit(state, key, this.backgroundAbort.signal).catch((error) => {
                        if (this.backgroundAbort.signal.aborted)
                            return;
                        this.warnOnce("auto-commit", key, error);
                    });
                    continue;
                }
                // Flush + snapshot + POST serialized on the agent chain.
                await this.runOnChain(key, async () => {
                    if (this.backgroundAbort.signal.aborted)
                        return;
                    await this.ensureSession(agent, this.backgroundAbort.signal);
                    await this.drainAgentNow(agent, this.backgroundAbort.signal);
                    if (this.backgroundAbort.signal.aborted)
                        return;
                    if (state.uncommittedMessageIds.size === 0)
                        return;
                    await this.postCommit(state, key, this.backgroundAbort.signal);
                }).catch((error) => {
                    if (this.backgroundAbort.signal.aborted)
                        return;
                    this.warnOnce("auto-commit", key, error);
                });
            }
        }
        finally {
            this.autoCommitRunning = false;
        }
    }
    /**
     * POST a commit for a snapshot of the current uncommitted ids and record the
     * outcome: a pending task (later polls keep clearing only this snapshot) or
     * a synchronous completion (drop exactly the snapshot ids so a later tick
     * does not re-commit them; ids added after the snapshot survive).
     */
    async postCommit(state, sessionId, signal) {
        const snapshot = [...state.uncommittedMessageIds];
        const commit = await this.client.commitSession(sessionId, signal);
        if (typeof commit.task_id === "string" && commit.task_id) {
            state.pendingCommit = { taskId: commit.task_id, startedAt: Date.now(), messageIds: snapshot };
            this.debouncedSave();
        }
        else {
            for (const id of snapshot)
                state.uncommittedMessageIds.delete(id);
            state.lastCommitTime = Date.now();
            this.debouncedSave();
        }
    }
    /** Run one auto-commit scheduler pass now (the interval timer calls this). */
    runAutoCommitTick() {
        return this.autoCommitTick();
    }
    // ─── persistence ──────────────────────────────────────────────────────
    serialize() {
        const sessions = {};
        for (const [key, state] of this.states) {
            sessions[key] = {
                syncedMessageIds: [...state.syncedMessageIds],
                uncommittedMessageIds: [...state.uncommittedMessageIds],
                ...(state.lastCommitTime !== undefined ? { lastCommitTime: state.lastCommitTime } : {}),
                ...(state.pendingCommit ? { pendingCommit: { ...state.pendingCommit } } : {}),
            };
        }
        return {
            version: 1,
            identity: {
                endpoint: normalizeEndpoint(this.config.endpoint),
                account: this.config.account,
                user: this.config.user,
                agentId: this.config.agentId,
            },
            sessions,
        };
    }
    async loadState() {
        if (!existsSync(this.statePath))
            return;
        let parsed;
        try {
            parsed = JSON.parse(await readFile(this.statePath, "utf8"));
        }
        catch (error) {
            await this.quarantine(".corrupt-");
            this.logger.warn("state file unreadable; starting fresh", { error: messageOf(error), path: this.statePath });
            return;
        }
        if (!this.validateShape(parsed)) {
            await this.quarantine(".corrupt-");
            this.logger.warn("state file failed shape validation; starting fresh", { path: this.statePath });
            return;
        }
        const persisted = parsed;
        const current = {
            endpoint: normalizeEndpoint(this.config.endpoint),
            account: this.config.account,
            user: this.config.user,
            agentId: this.config.agentId,
        };
        const identity = persisted.identity;
        if (identity.endpoint !== current.endpoint ||
            identity.account !== current.account ||
            identity.user !== current.user ||
            identity.agentId !== current.agentId) {
            await this.quarantine(".identity-mismatch-");
            this.logger.warn("state identity mismatch (endpoint/account/user/agentId changed); starting fresh", {
                path: this.statePath,
            });
            return;
        }
        for (const [key, entry] of Object.entries(persisted.sessions)) {
            const state = {
                syncedMessageIds: new Set(Array.isArray(entry.syncedMessageIds) ? entry.syncedMessageIds.filter((v) => typeof v === "string") : []),
                uncommittedMessageIds: new Set(Array.isArray(entry.uncommittedMessageIds)
                    ? entry.uncommittedMessageIds.filter((v) => typeof v === "string")
                    : []),
            };
            if (typeof entry.lastCommitTime === "number")
                state.lastCommitTime = entry.lastCommitTime;
            if (isRecord(entry.pendingCommit)) {
                const pending = entry.pendingCommit;
                if (typeof pending.taskId === "string" && Array.isArray(pending.messageIds)) {
                    state.pendingCommit = {
                        taskId: pending.taskId,
                        startedAt: typeof pending.startedAt === "number" ? pending.startedAt : Date.now(),
                        messageIds: pending.messageIds.filter((v) => typeof v === "string"),
                    };
                }
            }
            this.states.set(key, state);
        }
    }
    validateShape(parsed) {
        return (isRecord(parsed) &&
            parsed.version === 1 &&
            isRecord(parsed.identity) &&
            isRecord(parsed.sessions) &&
            typeof parsed.identity.endpoint === "string" &&
            typeof parsed.identity.account === "string" &&
            typeof parsed.identity.user === "string" &&
            typeof parsed.identity.agentId === "string");
    }
    async quarantine(suffix) {
        try {
            await rename(this.statePath, `${this.statePath}${suffix}${Date.now()}`);
        }
        catch (error) {
            this.logger.warn("failed to quarantine state file", { error: messageOf(error) });
        }
    }
    /** Persist state; saves never overlap — each chains on the previous one. */
    saveState() {
        const run = async () => {
            try {
                await mkdir(dirname(this.statePath), { recursive: true });
                const tempPath = `${this.statePath}.tmp-${Date.now()}-${this.saveSeq++}`;
                await writeFile(tempPath, JSON.stringify(this.serialize(), null, 2), "utf8");
                await rename(tempPath, this.statePath);
            }
            catch (error) {
                this.logger.warn("failed to save state file", { error: messageOf(error), path: this.statePath });
            }
        };
        const next = this.saveQueue.then(run, run);
        this.saveQueue = next;
        return next;
    }
    debouncedSave() {
        if (this.closing)
            return; // the disposer's final save covers everything
        if (this.saveTimer)
            clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            this.saveTimer = undefined;
            this.saveState().catch(() => { });
        }, SAVE_DEBOUNCE_MS);
    }
    warnOnce(operation, key, error) {
        const dedupeKey = `${operation}:${this.client.endpoint}:${messageOf(error)}`;
        if (this.warningKeys.has(dedupeKey))
            return;
        this.warningKeys.add(dedupeKey);
        this.logger.warn(`${operation} failed for session ${key}`, { endpoint: this.client.endpoint, error: messageOf(error) });
    }
    /** Mark closing, stop timers, run a final drain per agent, then save. */
    async dispose() {
        if (this.closing)
            return;
        this.closing = true;
        if (this.autoCommitTimer)
            clearInterval(this.autoCommitTimer);
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }
        // Final drain: one last ensure+drain per live agent, queued on its chain
        // after any pending drains, while the background signal is still live so
        // the sends actually go out.
        const finalDrains = [];
        for (const [key, agent] of [...this.agents]) {
            finalDrains.push(this.runOnChain(key, async () => {
                await this.ensureSession(agent, this.backgroundAbort.signal);
                await this.drainAgentNow(agent, this.backgroundAbort.signal);
            }));
        }
        await Promise.allSettled(finalDrains);
        // Stop background traffic now that the final drains have been attempted.
        this.backgroundAbort.abort();
        const chains = [...this.chains.values()];
        this.chains.clear();
        await Promise.allSettled(chains);
        // The final save chains behind any in-flight save, then drain the queue.
        await this.saveState();
        await this.saveQueue;
    }
}
function totalMemoriesExtracted(memories) {
    if (typeof memories === "number")
        return memories;
    if (!isRecord(memories))
        return 0;
    return Object.entries(memories).reduce((sum, [key, value]) => {
        if (key === "total")
            return sum;
        return sum + (typeof value === "number" ? value : 0);
    }, 0);
}
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("The operation was aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException("The operation was aborted", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
export function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
