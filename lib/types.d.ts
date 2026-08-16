/**
 * Narrow runtime types for the OpenViking HTTP service surface this plugin
 * actually reads. Response fields that are passed through untouched stay
 * `JsonValue` so the plugin never fabricates a complete service schema.
 */
import type { JsonValue } from "@deepseek-ai/dsh-session";
/** Any lossless JSON value (re-exported for consumer ergonomics). */
export type Json = JsonValue;
/** One normalized error from the OpenViking wrapper (`status: "error"`). */
export interface OpenVikingErrorInfo {
    code?: string;
    message?: string;
}
/** OpenViking HTTP envelope: `{ status: "ok", result }` or `{ status: "error", error }`. */
export interface OpenVikingEnvelope {
    status?: string;
    result?: JsonValue;
    error?: OpenVikingErrorInfo | null;
}
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export declare function isOpenVikingEnvelope(value: unknown): value is OpenVikingEnvelope;
/** One search hit returned by `/api/v1/search/find` and `/api/v1/search/search`. */
export interface SearchItem {
    uri?: string;
    title?: string;
    abstract?: string;
    overview?: string;
    content?: string;
    category?: string;
    level?: number;
    is_leaf?: boolean;
    score?: number;
}
/** The canonical find/search result. Extra fields (`query_plan`, …) pass through. */
export interface SearchResult {
    memories?: SearchItem[];
    resources?: SearchItem[];
    skills?: SearchItem[];
    total?: number;
    query_plan?: unknown;
}
/** One filesystem node from `/api/v1/fs/ls`. */
export interface FsNode {
    uri?: string;
    abstract?: string;
    overview?: string;
    isDir?: boolean;
    name?: string;
    type?: string;
}
/** `/api/v1/fs/stat` result — the fields `memread` auto-resolution reads. */
export interface FsStatResult {
    uri?: string;
    isDir?: boolean;
    type?: string;
    name?: string;
    abstract?: string;
    overview?: string;
}
/** `/api/v1/search/grep` result. */
export interface GrepResult {
    matches?: JsonValue[];
    count?: number;
    match_count?: number;
    files_scanned?: number;
}
/** `/api/v1/search/glob` result. */
export interface GlobResult {
    matches?: JsonValue[];
    count?: number;
}
/** `/api/v1/observer/queue` result (opaque passthrough). */
export type QueueResult = JsonValue;
/** `/api/v1/resources/temp_upload` result. */
export interface TempUploadResult {
    temp_file_id?: string;
}
export declare function isTempUploadResult(value: unknown): value is TempUploadResult;
/** `/api/v1/resources` (add resource) result. */
export interface AddResourceResult {
    uri?: string;
    root_uri?: string;
    queue?: JsonValue;
}
/** `/api/v1/content/write` result — write/append to an existing file. */
export interface WriteContentResult {
    uri?: string;
    root_uri?: string;
    context_type?: string;
    mode?: string;
    written_bytes?: number;
    semantic_updated?: boolean;
    vector_updated?: boolean;
    queue_status?: JsonValue;
}
/** `/api/v1/stats/memories` result (category counts for the calling user). */
export interface MemoryStats {
    total_memories?: number;
    by_category?: Record<string, number>;
    hotness_distribution?: Record<string, number>;
    staleness?: Record<string, number>;
}
/** `/api/v1/resources/skills` result. */
export interface AddSkillResult {
    status?: string;
    uri?: string;
    name?: string;
    auxiliary_files?: number;
}
/** `/api/v1/fs` DELETE result. */
export interface RemoveResult {
    uri?: string;
}
/** `/api/v1/sessions` POST result. */
export interface CreateSessionResult {
    session_id?: string;
}
/** `/api/v1/sessions/{id}` GET result. */
export interface SessionInfo {
    session_id?: string;
    message_count?: number;
}
/** `/api/v1/sessions/{id}/messages` POST result. */
export interface AddMessageResult {
    session_id?: string;
    message_count?: number;
}
/** `/api/v1/sessions/{id}/commit` POST result. */
export interface CommitResult {
    session_id?: string;
    status?: string;
    task_id?: string | null;
    archive_uri?: string | null;
    archived?: boolean;
}
/** `/api/v1/tasks/{id}` GET result. */
export interface TaskResult {
    task_id?: string;
    status?: "pending" | "running" | "completed" | "failed" | string;
    result?: JsonValue;
    error?: string | null;
    resource_id?: string;
    task_type?: string;
}
/** `/api/v1/health` result. */
export interface HealthResult {
    status?: string;
    healthy?: boolean;
    version?: string;
}
/** Normalized identity fields of the running service (from `/health`). */
export interface HealthIdentity {
    auth_mode?: string;
    account_id?: string;
    user_id?: string;
    role?: string;
}
/**
 * The normalized OpenViking error this plugin surfaces to tools and logs.
 * `code`/`message` come from the service wrapper; `status` is the HTTP status.
 * Never carries the API key.
 */
export declare class OpenVikingError extends Error {
    readonly code?: string;
    readonly httpStatus?: number;
    readonly endpoint: string;
    constructor(endpoint: string, message: string, options?: {
        code?: string;
        httpStatus?: number;
    });
}
/** A request that exceeded the configured timeout (or an explicit wait timeout). */
export declare class OpenVikingTimeoutError extends OpenVikingError {
    constructor(endpoint: string);
}
