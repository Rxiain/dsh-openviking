/**
 * OpenVikingClient: the single HTTP boundary between this plugin and the
 * OpenViking service. No shell `ov` calls, no CLI text parsing.
 *
 * Auth headers and the wrapped-response unwrapping mirror the current
 * `ov_cli/src/client.rs` (`build_headers`, `handle_response`) and the
 * `@tanyouqing/pi-openviking` reference HTTP layer. The API key never enters
 * error messages.
 */
import { type AddMessageResult, type AddResourceResult, type AddSkillResult, type WriteContentResult, type CommitResult, type CreateSessionResult, type FsStatResult, type GlobResult, type GrepResult, type HealthIdentity, type HealthResult, type Json, type MemoryStats, type QueueResult, type RemoveResult, type SearchResult, type SessionInfo, type TaskResult } from "./types.js";
export interface OpenVikingClientOptions {
    /** Base URL of the OpenViking HTTP service (trailing `/` tolerated). */
    endpoint: string;
    /** `X-API-Key` header value; empty string omits the header. */
    apiKey?: string;
    /** `X-OpenViking-Account` header value; empty string omits the header. */
    account?: string;
    /** `X-OpenViking-User` header value; empty string omits the header. */
    user?: string;
    /** `X-OpenViking-Agent` header value; empty string omits the header. */
    agentId?: string;
    /** Per-request timeout in milliseconds. */
    timeoutMs?: number;
}
export interface RequestOptions {
    /** Query parameters appended to the URL. */
    query?: Record<string, string | number | boolean | undefined>;
    /** JSON body; only sent (with `Content-Type: application/json`) when present. */
    body?: unknown;
    /** External cancellation forwarded one-way into the request controller. */
    signal?: AbortSignal;
    /** Overrides the client timeout for this request (e.g. `memadd wait=true`). */
    timeoutMs?: number;
}
export declare class OpenVikingClient {
    private options;
    constructor(options: OpenVikingClientOptions);
    /** Normalized service base URL of the CURRENT options (live after reconfigure). */
    get endpoint(): string;
    private get apiKey();
    private get account();
    private get user();
    private get agentId();
    private get timeoutMs();
    /**
     * Swap the request-facing options (endpoint, headers, timeout). Called when
     * the settings section commits a change; subsequent requests use the new
     * values while the instance identity stays stable.
     */
    reconfigure(options: OpenVikingClientOptions): void;
    /** The non-secret identity headers sent on every request. */
    buildHeaders(): Record<string, string>;
    /**
     * Perform one request and unwrap the OpenViking envelope.
     *
     * - A timeout `AbortController` is created per request; the external signal
     *   is forwarded one-way into it. The timer and external listener are
     *   cleared only after the WHOLE operation (fetch + body read + unwrap)
     *   completes or throws, so a server that stalls the body still hits the
     *   timeout and caller cancellation reaches the body read.
     * - HTTP non-2xx, `status: "error"`, invalid JSON, and missing required
     *   result fields all throw an {@link OpenVikingError} carrying endpoint,
     *   HTTP status and OpenViking `error.code`/`error.message` — never the key.
     */
    request<T extends Json>(method: "GET" | "POST" | "DELETE" | "PUT", path: string, options?: RequestOptions): Promise<T>;
    private buildUrl;
    private networkMessage;
    private readBody;
    private unwrap;
    health(signal?: AbortSignal): Promise<HealthResult & HealthIdentity>;
    find(options: {
        query: string;
        targetUri?: string;
        limit?: number;
        scoreThreshold?: number;
        signal?: AbortSignal;
    }): Promise<SearchResult & {
        mode?: string;
    }>;
    search(options: {
        query: string;
        targetUri?: string;
        sessionId?: string;
        limit?: number;
        scoreThreshold?: number;
        signal?: AbortSignal;
    }): Promise<SearchResult & {
        mode?: string;
    }>;
    private asSearchResult;
    readContent(level: "abstract" | "overview" | "read", uri: string, signal?: AbortSignal): Promise<Json>;
    list(options: {
        uri: string;
        simple?: boolean;
        recursive?: boolean;
        nodeLimit?: number;
        levelLimit?: number;
        signal?: AbortSignal;
    }): Promise<Json>;
    tree(options: {
        uri: string;
        nodeLimit?: number;
        levelLimit?: number;
        signal?: AbortSignal;
    }): Promise<Json>;
    stat(uri: string, signal?: AbortSignal): Promise<FsStatResult>;
    remove(options: {
        uri: string;
        recursive: boolean;
        signal?: AbortSignal;
    }): Promise<RemoveResult>;
    grep(options: {
        pattern: string;
        uri: string;
        caseInsensitive?: boolean;
        excludeUri?: string;
        nodeLimit?: number;
        levelLimit?: number;
        signal?: AbortSignal;
    }): Promise<GrepResult>;
    glob(options: {
        pattern: string;
        uri: string;
        nodeLimit?: number;
        signal?: AbortSignal;
    }): Promise<GlobResult>;
    /** Multipart-upload one file; returns the `temp_file_id`. */
    uploadTempFile(filename: string, bytes: Uint8Array, signal?: AbortSignal): Promise<string>;
    /**
     * POST a resource. `to`/`parent` are the literal wire fields of OpenViking
     * 0.4.13's running server and tests (the API-doc table says `target`; the
     * running contract wins).
     */
    addResource(options: {
        tempFileId?: string;
        path?: string;
        to?: string;
        parent?: string;
        reason?: string;
        instruction?: string;
        wait?: boolean;
        timeout?: number;
        watchInterval?: number;
        /** Client-side request timeout in ms (e.g. `max(timeoutMs, wait timeout)`). */
        requestTimeoutMs?: number;
        signal?: AbortSignal;
    }): Promise<AddResourceResult>;
    /**
     * POST a skill to `/api/v1/skills` (OpenViking >= 0.4.13 layout; earlier
     * 0.3.x checkouts exposed `/api/v1/resources/skills` instead). `data` is an
     * inline skill dict (`name`, `description`, `content`, optional
     * `tags`/`allowed_tools`) — never a host filesystem path. The service
     * writes the skill, generates the L1 overview and indexes the vector entry.
     */
    addSkill(data: Record<string, unknown>, options?: {
        wait?: boolean;
        signal?: AbortSignal;
    }): Promise<AddSkillResult>;
    /**
     * GET a skill by name (`/api/v1/skills/{name}`, OpenViking >= 0.4.13).
     * Resolves the skill through the service (0.4.13 stores skills under the
     * user scope, e.g. `viking://user/dsh/skills/<name>`), so existence can be
     * checked without knowing the storage layout. Throws `OpenVikingError` with
     * code `NOT_FOUND` when the skill does not exist.
     */
    getSkill(skillName: string, signal?: AbortSignal): Promise<Json>;
    /**
     * PUT a skill to `/api/v1/skills/{name}` (OpenViking >= 0.4.13): replace
     * an existing agent skill with new content. The service snapshots a backup
     * of the previous skill first and restores it when the update fails, so an
     * interrupted update never leaves a half-written playbook behind.
     */
    updateSkill(skillName: string, data: Record<string, unknown>, options?: {
        wait?: boolean;
        signal?: AbortSignal;
    }): Promise<AddSkillResult>;
    /**
     * POST `/api/v1/content/write`: replace or append text to an existing
     * viking:// file. The service keeps the memory `MEMORY_FIELDS` metadata
     * block intact, re-embeds the single file and enqueues a semantic refresh
     * for the containing memory directory. Only existing files can be written
     * (the service has no create-memory endpoint; new memories are produced by
     * session commits).
     */
    writeContent(uri: string, content: string, options?: {
        mode?: "replace" | "append";
        wait?: boolean;
        signal?: AbortSignal;
    }): Promise<WriteContentResult>;
    queue(signal?: AbortSignal): Promise<QueueResult>;
    /** GET `/api/v1/stats/memories`: category counts for the calling user. */
    memoryStats(signal?: AbortSignal): Promise<MemoryStats>;
    /** GET an existing session. Throws `OpenVikingError` with code `NOT_FOUND` when absent. */
    getSession(sessionId: string, signal?: AbortSignal): Promise<SessionInfo>;
    /** POST a new session with the requested id (idempotent in effect). */
    createSession(sessionId: string, signal?: AbortSignal): Promise<CreateSessionResult>;
    addSessionMessage(sessionId: string, role: "user" | "assistant", content: string, signal?: AbortSignal): Promise<AddMessageResult>;
    commitSession(sessionId: string, signal?: AbortSignal): Promise<CommitResult>;
    getTask(taskId: string, signal?: AbortSignal): Promise<TaskResult>;
}
