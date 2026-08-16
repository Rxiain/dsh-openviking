/**
 * OpenVikingClient: the single HTTP boundary between this plugin and the
 * OpenViking service. No shell `ov` calls, no CLI text parsing.
 *
 * Auth headers and the wrapped-response unwrapping mirror the current
 * `ov_cli/src/client.rs` (`build_headers`, `handle_response`) and the
 * `@tanyouqing/pi-openviking` reference HTTP layer. The API key never enters
 * error messages.
 */
import { OpenVikingError, OpenVikingTimeoutError, isOpenVikingEnvelope, isRecord, isTempUploadResult, } from "./types.js";
const JSON_HEADERS = {
    "Content-Type": "application/json",
};
export class OpenVikingClient {
    options;
    constructor(options) {
        this.options = options;
    }
    /** Normalized service base URL of the CURRENT options (live after reconfigure). */
    get endpoint() {
        return this.options.endpoint.trim().replace(/\/+$/, "");
    }
    get apiKey() {
        return this.options.apiKey ?? "";
    }
    get account() {
        return this.options.account ?? "";
    }
    get user() {
        return this.options.user ?? "";
    }
    get agentId() {
        return this.options.agentId ?? "";
    }
    get timeoutMs() {
        return this.options.timeoutMs ?? 30_000;
    }
    /**
     * Swap the request-facing options (endpoint, headers, timeout). Called when
     * the settings section commits a change; subsequent requests use the new
     * values while the instance identity stays stable.
     */
    reconfigure(options) {
        this.options = options;
    }
    /** The non-secret identity headers sent on every request. */
    buildHeaders() {
        const headers = {};
        if (this.apiKey)
            headers["X-API-Key"] = this.apiKey;
        if (this.account)
            headers["X-OpenViking-Account"] = this.account;
        if (this.user)
            headers["X-OpenViking-User"] = this.user;
        if (this.agentId)
            headers["X-OpenViking-Agent"] = this.agentId;
        return headers;
    }
    // ─── low-level request ────────────────────────────────────────────────
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
    async request(method, path, options = {}) {
        const controller = new AbortController();
        const timeoutMs = options.timeoutMs ?? this.timeoutMs;
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let removeListener;
        if (options.signal) {
            if (options.signal.aborted)
                controller.abort();
            else {
                const forward = () => controller.abort();
                options.signal.addEventListener("abort", forward, { once: true });
                removeListener = () => options.signal?.removeEventListener("abort", forward);
            }
        }
        const url = this.buildUrl(path, options.query);
        const hasBody = options.body !== undefined;
        const headers = this.buildHeaders();
        if (hasBody)
            Object.assign(headers, JSON_HEADERS);
        try {
            const response = await fetch(url, {
                method,
                headers,
                body: hasBody ? JSON.stringify(options.body) : undefined,
                signal: controller.signal,
            });
            const body = await this.readBody(response, path);
            return this.unwrap(body, response.status, path);
        }
        catch (error) {
            // Protocol/validation errors from readBody/unwrap pass through unchanged.
            if (error instanceof OpenVikingError)
                throw error;
            if (options.signal?.aborted) {
                throw new DOMException("The operation was aborted", "AbortError");
            }
            if (controller.signal.aborted) {
                throw new OpenVikingTimeoutError(this.endpoint);
            }
            throw new OpenVikingError(this.endpoint, this.networkMessage(error));
        }
        finally {
            clearTimeout(timer);
            removeListener?.();
        }
    }
    buildUrl(path, query) {
        const url = new URL(`${this.endpoint}${path}`);
        if (query) {
            for (const [key, value] of Object.entries(query)) {
                if (value !== undefined && value !== null) {
                    url.searchParams.set(key, String(value));
                }
            }
        }
        return url.toString();
    }
    networkMessage(error) {
        if (error instanceof Error) {
            return /Failed to fetch|fetch failed|ECONNREFUSED|ENOTFOUND|UND_ERR_CONNECT_TIMEOUT|network/i.test(error.message)
                ? `service unreachable (${error.message})`
                : error.message;
        }
        return "network error";
    }
    async readBody(response, path) {
        const text = await response.text();
        if (text.length === 0)
            return null;
        try {
            return JSON.parse(text);
        }
        catch {
            if (!response.ok) {
                throw new OpenVikingError(this.endpoint, `HTTP ${response.status}`, {
                    code: "INVALID_ERROR_RESPONSE",
                    httpStatus: response.status,
                });
            }
            throw new OpenVikingError(this.endpoint, `invalid JSON response for ${path}`, {
                code: "INVALID_JSON",
                httpStatus: response.status,
            });
        }
    }
    unwrap(body, httpStatus, path) {
        // 204 never carries a body. 202 may carry an envelope (e.g. the commit
        // endpoint) or be empty (fire-and-forget); only the empty form is null.
        if (httpStatus === 204)
            return null;
        if (httpStatus === 202 && body === null)
            return null;
        if (httpStatus < 200 || httpStatus >= 300) {
            // FastAPI errors carry `detail`; OpenViking errors carry `error.message`.
            const error = isRecord(body) ? body : {};
            let message = "";
            if (typeof error.message === "string")
                message = error.message;
            else if (typeof error.detail === "string")
                message = error.detail;
            if (!message)
                message = `HTTP ${httpStatus}`;
            const code = typeof error.code === "string"
                ? error.code
                : isRecord(error.error) && typeof error.error.code === "string"
                    ? error.error.code
                    : httpStatus === 404
                        ? "NOT_FOUND"
                        : "HTTP_ERROR";
            throw new OpenVikingError(this.endpoint, message, { code, httpStatus });
        }
        if (!isOpenVikingEnvelope(body)) {
            // A raw non-envelope body (never produced by the current service but
            // tolerated for forward compatibility) passes through unchanged.
            return body;
        }
        if (body.status === "error") {
            const error = isRecord(body.error) ? body.error : {};
            const code = typeof error.code === "string" ? error.code : "UNKNOWN";
            const message = typeof error.message === "string" ? error.message : "Unknown OpenViking error";
            throw new OpenVikingError(this.endpoint, message, { code, httpStatus });
        }
        return body.result;
    }
    // ─── health ───────────────────────────────────────────────────────────
    async health(signal) {
        // `/health` is served at the root (no `/api/v1` prefix) and returns a raw
        // object instead of the `{ status, result }` envelope.
        const result = await this.request('GET', "/health", { signal });
        if (!isRecord(result)) {
            throw new OpenVikingError(this.endpoint, "health returned a non-object result", { code: "INVALID_RESULT" });
        }
        return result;
    }
    // ─── search ───────────────────────────────────────────────────────────
    async find(options) {
        const body = { query: options.query, limit: options.limit ?? 10 };
        if (options.targetUri !== undefined)
            body.target_uri = options.targetUri;
        if (options.scoreThreshold !== undefined)
            body.score_threshold = options.scoreThreshold;
        const result = await this.request("POST", "/api/v1/search/find", { body, signal: options.signal });
        return this.asSearchResult(result, "find");
    }
    async search(options) {
        const body = { query: options.query, limit: options.limit ?? 10 };
        if (options.targetUri !== undefined)
            body.target_uri = options.targetUri;
        if (options.sessionId !== undefined)
            body.session_id = options.sessionId;
        if (options.scoreThreshold !== undefined)
            body.score_threshold = options.scoreThreshold;
        const result = await this.request("POST", "/api/v1/search/search", { body, signal: options.signal });
        return this.asSearchResult(result, "search");
    }
    asSearchResult(result, operation) {
        if (!isRecord(result)) {
            throw new OpenVikingError(this.endpoint, `${operation} returned a non-object result`, { code: "INVALID_RESULT" });
        }
        const search = {
            memories: Array.isArray(result.memories) ? result.memories : [],
            resources: Array.isArray(result.resources) ? result.resources : [],
            skills: Array.isArray(result.skills) ? result.skills : [],
        };
        if (typeof result.total === "number")
            search.total = result.total;
        if (result.query_plan !== undefined)
            search.query_plan = result.query_plan;
        return search;
    }
    // ─── content ──────────────────────────────────────────────────────────
    async readContent(level, uri, signal) {
        return this.request("GET", `/api/v1/content/${level}`, { query: { uri }, signal });
    }
    // ─── filesystem ───────────────────────────────────────────────────────
    async list(options) {
        return this.request("GET", "/api/v1/fs/ls", {
            query: {
                uri: options.uri,
                simple: options.simple ?? false,
                recursive: options.recursive ?? false,
                node_limit: options.nodeLimit,
                level_limit: options.levelLimit,
            },
            signal: options.signal,
        });
    }
    async tree(options) {
        return this.request("GET", "/api/v1/fs/tree", {
            query: { uri: options.uri, node_limit: options.nodeLimit, level_limit: options.levelLimit },
            signal: options.signal,
        });
    }
    async stat(uri, signal) {
        const result = await this.request("GET", "/api/v1/fs/stat", { query: { uri }, signal });
        if (!isRecord(result)) {
            throw new OpenVikingError(this.endpoint, "stat returned a non-object result", { code: "INVALID_RESULT" });
        }
        return result;
    }
    async remove(options) {
        const result = await this.request("DELETE", "/api/v1/fs", {
            query: { uri: options.uri, recursive: options.recursive },
            signal: options.signal,
        });
        return isRecord(result) ? result : { uri: options.uri };
    }
    // ─── search helpers ───────────────────────────────────────────────────
    async grep(options) {
        const body = { pattern: options.pattern, uri: options.uri };
        if (options.caseInsensitive !== undefined)
            body.case_insensitive = options.caseInsensitive;
        if (options.excludeUri !== undefined)
            body.exclude_uri = options.excludeUri;
        if (options.nodeLimit !== undefined)
            body.node_limit = options.nodeLimit;
        if (options.levelLimit !== undefined)
            body.level_limit = options.levelLimit;
        const result = await this.request("POST", "/api/v1/search/grep", { body, signal: options.signal });
        if (!isRecord(result)) {
            throw new OpenVikingError(this.endpoint, "grep returned a non-object result", { code: "INVALID_RESULT" });
        }
        return result;
    }
    async glob(options) {
        const body = { pattern: options.pattern, uri: options.uri };
        if (options.nodeLimit !== undefined)
            body.node_limit = options.nodeLimit;
        const result = await this.request("POST", "/api/v1/search/glob", { body, signal: options.signal });
        if (!isRecord(result)) {
            throw new OpenVikingError(this.endpoint, "glob returned a non-object result", { code: "INVALID_RESULT" });
        }
        return result;
    }
    // ─── resources ────────────────────────────────────────────────────────
    /** Multipart-upload one file; returns the `temp_file_id`. */
    async uploadTempFile(filename, bytes, signal) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let removeListener;
        if (signal) {
            if (signal.aborted)
                controller.abort();
            else {
                const forward = () => controller.abort();
                signal.addEventListener("abort", forward, { once: true });
                removeListener = () => signal.removeEventListener("abort", forward);
            }
        }
        const form = new FormData();
        form.append("file", new Blob([bytes], { type: "application/octet-stream" }), filename);
        try {
            const response = await fetch(`${this.endpoint}/api/v1/resources/temp_upload`, {
                method: "POST",
                headers: this.buildHeaders(),
                body: form,
                signal: controller.signal,
            });
            const raw = await this.readBody(response, "/api/v1/resources/temp_upload");
            const body = this.unwrap(raw, response.status, "/api/v1/resources/temp_upload");
            if (!isTempUploadResult(body)) {
                throw new OpenVikingError(this.endpoint, "temp upload did not return temp_file_id", { code: "INVALID_RESULT" });
            }
            return body.temp_file_id;
        }
        catch (error) {
            if (error instanceof OpenVikingError)
                throw error;
            if (signal?.aborted)
                throw new DOMException("The operation was aborted", "AbortError");
            if (controller.signal.aborted)
                throw new OpenVikingTimeoutError(this.endpoint);
            throw new OpenVikingError(this.endpoint, this.networkMessage(error));
        }
        finally {
            clearTimeout(timer);
            removeListener?.();
        }
    }
    /**
     * POST a resource. `to`/`parent` are the literal wire fields of OpenViking
     * 0.4.13's running server and tests (the API-doc table says `target`; the
     * running contract wins).
     */
    async addResource(options) {
        const body = {};
        if (options.tempFileId !== undefined)
            body.temp_file_id = options.tempFileId;
        if (options.path !== undefined)
            body.path = options.path;
        if (options.to !== undefined)
            body.to = options.to;
        if (options.parent !== undefined)
            body.parent = options.parent;
        if (options.reason !== undefined)
            body.reason = options.reason;
        if (options.instruction !== undefined)
            body.instruction = options.instruction;
        if (options.wait !== undefined)
            body.wait = options.wait;
        if (options.timeout !== undefined)
            body.timeout = options.timeout;
        if (options.watchInterval !== undefined)
            body.watch_interval = options.watchInterval;
        const result = await this.request("POST", "/api/v1/resources", {
            body,
            signal: options.signal,
            timeoutMs: options.requestTimeoutMs,
        });
        if (!isRecord(result)) {
            throw new OpenVikingError(this.endpoint, "add resource returned a non-object result", { code: "INVALID_RESULT" });
        }
        return result;
    }
    /**
     * POST a skill to `/api/v1/skills` (OpenViking >= 0.4.13 layout; earlier
     * 0.3.x checkouts exposed `/api/v1/resources/skills` instead). `data` is an
     * inline skill dict (`name`, `description`, `content`, optional
     * `tags`/`allowed_tools`) — never a host filesystem path. The service
     * writes the skill, generates the L1 overview and indexes the vector entry.
     */
    async addSkill(data, options = {}) {
        const body = { data };
        if (options.wait !== undefined)
            body.wait = options.wait;
        const result = await this.request("POST", "/api/v1/skills", {
            body,
            signal: options.signal,
        });
        if (!isRecord(result)) {
            throw new OpenVikingError(this.endpoint, "add skill returned a non-object result", { code: "INVALID_RESULT" });
        }
        return result;
    }
    /**
     * GET a skill by name (`/api/v1/skills/{name}`, OpenViking >= 0.4.13).
     * Resolves the skill through the service (0.4.13 stores skills under the
     * user scope, e.g. `viking://user/dsh/skills/<name>`), so existence can be
     * checked without knowing the storage layout. Throws `OpenVikingError` with
     * code `NOT_FOUND` when the skill does not exist.
     */
    async getSkill(skillName, signal) {
        return this.request("GET", `/api/v1/skills/${encodeURIComponent(skillName)}`, { signal });
    }
    /**
     * PUT a skill to `/api/v1/skills/{name}` (OpenViking >= 0.4.13): replace
     * an existing agent skill with new content. The service snapshots a backup
     * of the previous skill first and restores it when the update fails, so an
     * interrupted update never leaves a half-written playbook behind.
     */
    async updateSkill(skillName, data, options = {}) {
        const body = { data };
        if (options.wait !== undefined)
            body.wait = options.wait;
        const result = await this.request("PUT", `/api/v1/skills/${encodeURIComponent(skillName)}`, {
            body,
            signal: options.signal,
        });
        if (!isRecord(result)) {
            throw new OpenVikingError(this.endpoint, "update skill returned a non-object result", { code: "INVALID_RESULT" });
        }
        return result;
    }
    /**
     * POST `/api/v1/content/write`: replace or append text to an existing
     * viking:// file. The service keeps the memory `MEMORY_FIELDS` metadata
     * block intact, re-embeds the single file and enqueues a semantic refresh
     * for the containing memory directory. Only existing files can be written
     * (the service has no create-memory endpoint; new memories are produced by
     * session commits).
     */
    async writeContent(uri, content, options = {}) {
        const body = {
            uri,
            content,
            mode: options.mode ?? "replace",
            wait: options.wait ?? false,
        };
        const result = await this.request("POST", "/api/v1/content/write", {
            body,
            signal: options.signal,
        });
        if (!isRecord(result)) {
            throw new OpenVikingError(this.endpoint, "write content returned a non-object result", { code: "INVALID_RESULT" });
        }
        return result;
    }
    async queue(signal) {
        return this.request("GET", "/api/v1/observer/queue", { signal });
    }
    /** GET `/api/v1/stats/memories`: category counts for the calling user. */
    async memoryStats(signal) {
        const result = await this.request("GET", "/api/v1/stats/memories", { signal });
        return isRecord(result) ? result : {};
    }
    // ─── sessions ─────────────────────────────────────────────────────────
    /** GET an existing session. Throws `OpenVikingError` with code `NOT_FOUND` when absent. */
    async getSession(sessionId, signal) {
        const result = await this.request("GET", `/api/v1/sessions/${encodeURIComponent(sessionId)}`, { signal });
        return isRecord(result) ? result : {};
    }
    /** POST a new session with the requested id (idempotent in effect). */
    async createSession(sessionId, signal) {
        const result = await this.request("POST", "/api/v1/sessions", {
            body: { session_id: sessionId },
            signal,
        });
        return isRecord(result) ? result : {};
    }
    async addSessionMessage(sessionId, role, content, signal) {
        const result = await this.request("POST", `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
            body: { role, content },
            signal,
        });
        return isRecord(result) ? result : {};
    }
    async commitSession(sessionId, signal) {
        const result = await this.request("POST", `/api/v1/sessions/${encodeURIComponent(sessionId)}/commit`, {
            signal,
            timeoutMs: 10_000,
        });
        return isRecord(result) ? result : {};
    }
    async getTask(taskId, signal) {
        const result = await this.request("GET", `/api/v1/tasks/${encodeURIComponent(taskId)}`, {
            signal,
            timeoutMs: 5_000,
        });
        return isRecord(result) ? result : {};
    }
}
