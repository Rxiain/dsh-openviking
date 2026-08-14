/**
 * OpenVikingClient: the single HTTP boundary between this plugin and the
 * OpenViking service. No shell `ov` calls, no CLI text parsing.
 *
 * Auth headers and the wrapped-response unwrapping mirror the current
 * `ov_cli/src/client.rs` (`build_headers`, `handle_response`) and the
 * `@tanyouqing/pi-openviking` reference HTTP layer. The API key never enters
 * error messages.
 */
import {
  OpenVikingError,
  OpenVikingTimeoutError,
  isOpenVikingEnvelope,
  isRecord,
  isTempUploadResult,
  type AddMessageResult,
  type AddResourceResult,
  type CommitResult,
  type CreateSessionResult,
  type FsNode,
  type FsStatResult,
  type GlobResult,
  type GrepResult,
  type HealthIdentity,
  type HealthResult,
  type Json,
  type QueueResult,
  type RemoveResult,
  type SearchItem,
  type SearchResult,
  type SessionInfo,
  type TaskResult,
  type TempUploadResult,
} from "./types.js";

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

const JSON_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "application/json",
};

export class OpenVikingClient {
  readonly endpoint: string;
  private readonly apiKey: string;
  private readonly account: string;
  private readonly user: string;
  private readonly agentId: string;
  private readonly timeoutMs: number;

  constructor(options: OpenVikingClientOptions) {
    this.endpoint = options.endpoint.trim().replace(/\/+$/, "");
    this.apiKey = options.apiKey ?? "";
    this.account = options.account ?? "";
    this.user = options.user ?? "";
    this.agentId = options.agentId ?? "";
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** The non-secret identity headers sent on every request. */
  buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers["X-API-Key"] = this.apiKey;
    if (this.account) headers["X-OpenViking-Account"] = this.account;
    if (this.user) headers["X-OpenViking-User"] = this.user;
    if (this.agentId) headers["X-OpenViking-Agent"] = this.agentId;
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
  async request<T extends Json>(method: "GET" | "POST" | "DELETE" | "PUT", path: string, options: RequestOptions = {}): Promise<T> {
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let removeListener: (() => void) | undefined;
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else {
        const forward = (): void => controller.abort();
        options.signal.addEventListener("abort", forward, { once: true });
        removeListener = () => options.signal?.removeEventListener("abort", forward);
      }
    }

    const url = this.buildUrl(path, options.query);
    const hasBody = options.body !== undefined;
    const headers: Record<string, string> = this.buildHeaders();
    if (hasBody) Object.assign(headers, JSON_HEADERS);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: hasBody ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      const body = await this.readBody(response, path);
      return this.unwrap<T>(body, response.status, path);
    } catch (error) {
      // Protocol/validation errors from readBody/unwrap pass through unchanged.
      if (error instanceof OpenVikingError) throw error;
      if (options.signal?.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      if (controller.signal.aborted) {
        throw new OpenVikingTimeoutError(this.endpoint);
      }
      throw new OpenVikingError(this.endpoint, this.networkMessage(error));
    } finally {
      clearTimeout(timer);
      removeListener?.();
    }
  }

  private buildUrl(path: string, query?: Record<string, string | number | boolean | undefined>): string {
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

  private networkMessage(error: unknown): string {
    if (error instanceof Error) {
      return /Failed to fetch|fetch failed|ECONNREFUSED|ENOTFOUND|UND_ERR_CONNECT_TIMEOUT|network/i.test(error.message)
        ? `service unreachable (${error.message})`
        : error.message;
    }
    return "network error";
  }

  private async readBody(response: Response, path: string): Promise<unknown> {
    const text = await response.text();
    if (text.length === 0) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
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

  private unwrap<T>(body: unknown, httpStatus: number, path: string): T {
    // 204 never carries a body. 202 may carry an envelope (e.g. the commit
    // endpoint) or be empty (fire-and-forget); only the empty form is null.
    if (httpStatus === 204) return null as T;
    if (httpStatus === 202 && body === null) return null as T;

    if (httpStatus < 200 || httpStatus >= 300) {
      // FastAPI errors carry `detail`; OpenViking errors carry `error.message`.
      const error = isRecord(body) ? body : {};
      let message = "";
      if (typeof error.message === "string") message = error.message;
      else if (typeof error.detail === "string") message = error.detail;
      if (!message) message = `HTTP ${httpStatus}`;
      const code =
        typeof error.code === "string"
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
      return body as T;
    }

    if (body.status === "error") {
      const error = isRecord(body.error) ? body.error : {};
      const code = typeof error.code === "string" ? error.code : "UNKNOWN";
      const message = typeof error.message === "string" ? error.message : "Unknown OpenViking error";
      throw new OpenVikingError(this.endpoint, message, { code, httpStatus });
    }
    return body.result as T;
  }

  // ─── health ───────────────────────────────────────────────────────────

  async health(signal?: AbortSignal): Promise<HealthResult & HealthIdentity> {
    // `/health` is served at the root (no `/api/v1` prefix) and returns a raw
    // object instead of the `{ status, result }` envelope.
    const result = await this.request<Json>('GET', "/health", { signal });
    if (!isRecord(result)) {
      throw new OpenVikingError(this.endpoint, "health returned a non-object result", { code: "INVALID_RESULT" });
    }
    return result as HealthResult & HealthIdentity;
  }

  // ─── search ───────────────────────────────────────────────────────────

  async find(options: {
    query: string;
    targetUri?: string;
    limit?: number;
    scoreThreshold?: number;
    signal?: AbortSignal;
  }): Promise<SearchResult & { mode?: string }> {
    const body: Record<string, unknown> = { query: options.query, limit: options.limit ?? 10 };
    if (options.targetUri !== undefined) body.target_uri = options.targetUri;
    if (options.scoreThreshold !== undefined) body.score_threshold = options.scoreThreshold;
    const result = await this.request<Json>("POST", "/api/v1/search/find", { body, signal: options.signal });
    return this.asSearchResult(result, "find");
  }

  async search(options: {
    query: string;
    targetUri?: string;
    sessionId?: string;
    limit?: number;
    scoreThreshold?: number;
    signal?: AbortSignal;
  }): Promise<SearchResult & { mode?: string }> {
    const body: Record<string, unknown> = { query: options.query, limit: options.limit ?? 10 };
    if (options.targetUri !== undefined) body.target_uri = options.targetUri;
    if (options.sessionId !== undefined) body.session_id = options.sessionId;
    if (options.scoreThreshold !== undefined) body.score_threshold = options.scoreThreshold;
    const result = await this.request<Json>("POST", "/api/v1/search/search", { body, signal: options.signal });
    return this.asSearchResult(result, "search");
  }

  private asSearchResult(result: unknown, operation: string): SearchResult & { mode?: string } {
    if (!isRecord(result)) {
      throw new OpenVikingError(this.endpoint, `${operation} returned a non-object result`, { code: "INVALID_RESULT" });
    }
    const search: SearchResult = {
      memories: Array.isArray(result.memories) ? (result.memories as SearchItem[]) : [],
      resources: Array.isArray(result.resources) ? (result.resources as SearchItem[]) : [],
      skills: Array.isArray(result.skills) ? (result.skills as SearchItem[]) : [],
    };
    if (typeof result.total === "number") search.total = result.total;
    if (result.query_plan !== undefined) search.query_plan = result.query_plan;
    return search as SearchResult & { mode?: string };
  }

  // ─── content ──────────────────────────────────────────────────────────

  async readContent(level: "abstract" | "overview" | "read", uri: string, signal?: AbortSignal): Promise<Json> {
    return this.request<Json>("GET", `/api/v1/content/${level}`, { query: { uri }, signal });
  }

  // ─── filesystem ───────────────────────────────────────────────────────

  async list(options: {
    uri: string;
    simple?: boolean;
    recursive?: boolean;
    nodeLimit?: number;
    levelLimit?: number;
    signal?: AbortSignal;
  }): Promise<Json> {
    return this.request<Json>("GET", "/api/v1/fs/ls", {
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

  async tree(options: {
    uri: string;
    nodeLimit?: number;
    levelLimit?: number;
    signal?: AbortSignal;
  }): Promise<Json> {
    return this.request<Json>("GET", "/api/v1/fs/tree", {
      query: { uri: options.uri, node_limit: options.nodeLimit, level_limit: options.levelLimit },
      signal: options.signal,
    });
  }

  async stat(uri: string, signal?: AbortSignal): Promise<FsStatResult> {
    const result = await this.request<Json>("GET", "/api/v1/fs/stat", { query: { uri }, signal });
    if (!isRecord(result)) {
      throw new OpenVikingError(this.endpoint, "stat returned a non-object result", { code: "INVALID_RESULT" });
    }
    return result as FsStatResult;
  }

  async remove(options: { uri: string; recursive: boolean; signal?: AbortSignal }): Promise<RemoveResult> {
    const result = await this.request<Json>("DELETE", "/api/v1/fs", {
      query: { uri: options.uri, recursive: options.recursive },
      signal: options.signal,
    });
    return isRecord(result) ? (result as RemoveResult) : { uri: options.uri };
  }

  // ─── search helpers ───────────────────────────────────────────────────

  async grep(options: {
    pattern: string;
    uri: string;
    caseInsensitive?: boolean;
    excludeUri?: string;
    nodeLimit?: number;
    levelLimit?: number;
    signal?: AbortSignal;
  }): Promise<GrepResult> {
    const body: Record<string, unknown> = { pattern: options.pattern, uri: options.uri };
    if (options.caseInsensitive !== undefined) body.case_insensitive = options.caseInsensitive;
    if (options.excludeUri !== undefined) body.exclude_uri = options.excludeUri;
    if (options.nodeLimit !== undefined) body.node_limit = options.nodeLimit;
    if (options.levelLimit !== undefined) body.level_limit = options.levelLimit;
    const result = await this.request<Json>("POST", "/api/v1/search/grep", { body, signal: options.signal });
    if (!isRecord(result)) {
      throw new OpenVikingError(this.endpoint, "grep returned a non-object result", { code: "INVALID_RESULT" });
    }
    return result as GrepResult;
  }

  async glob(options: {
    pattern: string;
    uri: string;
    nodeLimit?: number;
    signal?: AbortSignal;
  }): Promise<GlobResult> {
    const body: Record<string, unknown> = { pattern: options.pattern, uri: options.uri };
    if (options.nodeLimit !== undefined) body.node_limit = options.nodeLimit;
    const result = await this.request<Json>("POST", "/api/v1/search/glob", { body, signal: options.signal });
    if (!isRecord(result)) {
      throw new OpenVikingError(this.endpoint, "glob returned a non-object result", { code: "INVALID_RESULT" });
    }
    return result as GlobResult;
  }

  // ─── resources ────────────────────────────────────────────────────────

  /** Multipart-upload one file; returns the `temp_file_id`. */
  async uploadTempFile(filename: string, bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let removeListener: (() => void) | undefined;
    if (signal) {
      if (signal.aborted) controller.abort();
      else {
        const forward = (): void => controller.abort();
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
      const body = this.unwrap<unknown>(raw, response.status, "/api/v1/resources/temp_upload");
      if (!isTempUploadResult(body)) {
        throw new OpenVikingError(this.endpoint, "temp upload did not return temp_file_id", { code: "INVALID_RESULT" });
      }
      return body.temp_file_id as string;
    } catch (error) {
      if (error instanceof OpenVikingError) throw error;
      if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
      if (controller.signal.aborted) throw new OpenVikingTimeoutError(this.endpoint);
      throw new OpenVikingError(this.endpoint, this.networkMessage(error));
    } finally {
      clearTimeout(timer);
      removeListener?.();
    }
  }

  /**
   * POST a resource. `to`/`parent` are the literal wire fields of OpenViking
   * 0.4.13's running server and tests (the API-doc table says `target`; the
   * running contract wins).
   */
  async addResource(options: {
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
  }): Promise<AddResourceResult> {
    const body: Record<string, unknown> = {};
    if (options.tempFileId !== undefined) body.temp_file_id = options.tempFileId;
    if (options.path !== undefined) body.path = options.path;
    if (options.to !== undefined) body.to = options.to;
    if (options.parent !== undefined) body.parent = options.parent;
    if (options.reason !== undefined) body.reason = options.reason;
    if (options.instruction !== undefined) body.instruction = options.instruction;
    if (options.wait !== undefined) body.wait = options.wait;
    if (options.timeout !== undefined) body.timeout = options.timeout;
    if (options.watchInterval !== undefined) body.watch_interval = options.watchInterval;

    const result = await this.request<Json>("POST", "/api/v1/resources", {
      body,
      signal: options.signal,
      timeoutMs: options.requestTimeoutMs,
    });
    if (!isRecord(result)) {
      throw new OpenVikingError(this.endpoint, "add resource returned a non-object result", { code: "INVALID_RESULT" });
    }
    return result as AddResourceResult;
  }

  async queue(signal?: AbortSignal): Promise<QueueResult> {
    return this.request<Json>("GET", "/api/v1/observer/queue", { signal });
  }

  // ─── sessions ─────────────────────────────────────────────────────────

  /** GET an existing session. Throws `OpenVikingError` with code `NOT_FOUND` when absent. */
  async getSession(sessionId: string, signal?: AbortSignal): Promise<SessionInfo> {
    const result = await this.request<Json>("GET", `/api/v1/sessions/${encodeURIComponent(sessionId)}`, { signal });
    return isRecord(result) ? (result as SessionInfo) : {};
  }

  /** POST a new session with the requested id (idempotent in effect). */
  async createSession(sessionId: string, signal?: AbortSignal): Promise<CreateSessionResult> {
    const result = await this.request<Json>("POST", "/api/v1/sessions", {
      body: { session_id: sessionId },
      signal,
    });
    return isRecord(result) ? (result as CreateSessionResult) : {};
  }

  async addSessionMessage(
    sessionId: string,
    role: "user" | "assistant",
    content: string,
    signal?: AbortSignal,
  ): Promise<AddMessageResult> {
    const result = await this.request<Json>("POST", `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
      body: { role, content },
      signal,
    });
    return isRecord(result) ? (result as AddMessageResult) : {};
  }

  async commitSession(sessionId: string, signal?: AbortSignal): Promise<CommitResult> {
    const result = await this.request<Json>("POST", `/api/v1/sessions/${encodeURIComponent(sessionId)}/commit`, {
      signal,
      timeoutMs: 10_000,
    });
    return isRecord(result) ? (result as CommitResult) : {};
  }

  async getTask(taskId: string, signal?: AbortSignal): Promise<TaskResult> {
    const result = await this.request<Json>("GET", `/api/v1/tasks/${encodeURIComponent(taskId)}`, {
      signal,
      timeoutMs: 5_000,
    });
    return isRecord(result) ? (result as TaskResult) : {};
  }
}
