import { defineTool } from "@deepseek-ai/dsh-tools";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenVikingError, isRecord } from "./types.js";
// ─── schema building blocks ─────────────────────────────────────────────
const searchItemSchema = { type: "json" };
const searchResultsSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        mode: { type: "string", required: true },
        query: { type: "string", required: true },
        memories: { type: "array", required: true, items: searchItemSchema },
        resources: { type: "array", required: true, items: searchItemSchema },
        skills: { type: "array", required: true, items: searchItemSchema },
        total: { type: "integer", required: true },
        query_plan: { type: "json" },
    },
};
// ─── shared helpers ─────────────────────────────────────────────────────
function text(...lines) {
    return [{ type: "text", text: lines.join("\n") }];
}
function jsonText(value) {
    return text(JSON.stringify(value, null, 2));
}
/**
 * Parse a canonical `viking://<scope>/<segments...>` URI. The whole first
 * token after the scheme is the scope, so `viking://resources.evil/x` parses
 * as scope `resources.evil` — never as scope `resources`. Rejects missing or
 * malformed scopes, literal `.`/`..` segments, and percent-encoded traversal
 * (`%2e%2e`, `%2e`, `..%2f`, …): every segment is decoded and refused when it
 * decodes to `.`, `..`, or a value containing a path separator.
 */
function parseVikingUri(uri, tool) {
    const match = /^viking:\/\/([^/]+)(?:\/(.*))?$/.exec(uri);
    if (!match) {
        throw new Error(`${tool}: invalid URI format — must start with "viking://" followed by a scope`);
    }
    const isTraversal = (raw) => {
        let decoded;
        try {
            decoded = decodeURIComponent(raw);
        }
        catch {
            decoded = raw; // malformed escapes (e.g. "%zz") cannot decode to traversal
        }
        return decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\");
    };
    const scope = match[1];
    if (isTraversal(scope)) {
        throw new Error(`${tool}: invalid URI — traversal segments ('.' or '..') are not allowed`);
    }
    const segments = match[2] === undefined ? [] : match[2].split("/").filter((segment) => segment !== "");
    for (const segment of segments) {
        if (isTraversal(segment)) {
            throw new Error(`${tool}: invalid URI — traversal segments ('.' or '..') are not allowed`);
        }
    }
    return { scope, segments };
}
/** `to`/`parent` targets must be an explicit path under `viking://resources/`. */
function requireResourcesTarget(uri, field) {
    const parsed = parseVikingUri(uri, "memadd");
    if (parsed.scope !== "resources" || parsed.segments.length === 0) {
        throw new Error(`memadd: \`${field}\` must be under viking://resources/.`);
    }
}
function stringifyContent(content) {
    return typeof content === "string" ? content : JSON.stringify(content, null, 2);
}
function formatSearchResults(value) {
    const memories = value.memories ?? [];
    const resources = value.resources ?? [];
    const skills = value.skills ?? [];
    const allResults = [...memories, ...resources, ...skills];
    if (allResults.length === 0)
        return "No results found matching the query.";
    const out = {
        total: value.total,
        memories,
        resources,
        skills,
        query: value.query,
        mode: value.mode,
    };
    if (value.query_plan !== undefined)
        out.query_plan = value.query_plan;
    return JSON.stringify(out, null, 2);
}
function isRemoteUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
    }
    catch {
        return false;
    }
}
function isFileUrl(value) {
    try {
        return new URL(value).protocol === "file:";
    }
    catch {
        return false;
    }
}
/** `{ line, uri, content }` service matches → `SearchFileMatches[]` view groups. */
function grepFiles(matches) {
    const byUri = new Map();
    if (Array.isArray(matches)) {
        for (const match of matches) {
            if (!isRecord(match))
                continue;
            const uri = typeof match.uri === "string" ? match.uri : "";
            if (!uri)
                continue;
            const lineNumber = typeof match.line === "number" ? match.line : 0;
            const line = typeof match.content === "string" ? match.content : "";
            const list = byUri.get(uri) ?? [];
            list.push({ lineNumber, line });
            byUri.set(uri, list);
        }
    }
    return [...byUri.entries()].map(([path, matchesOfFile]) => ({ path, matches: matchesOfFile }));
}
/** Service glob matches (strings or `{ uri }` objects) → flat path list. */
function globPaths(matches) {
    if (!Array.isArray(matches))
        return [];
    const paths = [];
    for (const match of matches) {
        if (typeof match === "string")
            paths.push(match);
        else if (isRecord(match) && typeof match.uri === "string")
            paths.push(match.uri);
    }
    return paths;
}
/** Runtime narrowing of the presentation-meta `files` payload back to view groups. */
function asSearchFileMatches(value) {
    if (!Array.isArray(value))
        return [];
    const out = [];
    for (const entry of value) {
        if (!isRecord(entry) || typeof entry.path !== "string" || !Array.isArray(entry.matches))
            continue;
        const matches = [];
        for (const match of entry.matches) {
            if (isRecord(match) && typeof match.lineNumber === "number" && typeof match.line === "string") {
                matches.push({ lineNumber: match.lineNumber, line: match.line });
            }
        }
        out.push({ path: entry.path, matches });
    }
    return out;
}
// ─── tool factories ─────────────────────────────────────────────────────
export function createOpenVikingTools(ctx, client, sessionManager, config) {
    void config;
    const memfind = defineTool({
        name: "memfind",
        description: "Fast OpenViking semantic find across memories, indexed repositories, and skills. Use when you need quick relevant results without session-aware deep search.",
        parameters: {
            query: { type: "string", required: true, description: "Natural language query, question, or task description." },
            target_uri: { type: "string", description: "Optional Viking URI scope." },
            limit: { type: "number", description: "Maximum number of results. Defaults to 10." },
            score_threshold: { type: "number", description: "Optional minimum score threshold." },
        },
        output: {
            schema: searchResultsSchema,
            render: (_args, value) => text(formatSearchResults(value)),
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const result = await client.find({
                query: args.query,
                targetUri: args.target_uri,
                limit: args.limit ?? 10,
                scoreThreshold: args.score_threshold,
                signal: exec.signal,
            });
            return canonicalSearchValue("fast", args.query, result);
        },
    });
    const memsearch = defineTool({
        name: "memsearch",
        description: "Search OpenViking memories, indexed repositories, and skills. Use this for semantic or conceptual questions. Narrow target_uri whenever possible.",
        parameters: {
            query: { type: "string", required: true, description: "Natural language query, question, or task description." },
            target_uri: { type: "string", description: "Optional Viking URI scope, e.g. viking://resources/ or viking://user/memories/." },
            mode: {
                type: "string",
                enum: ["auto", "fast", "deep"],
                description: "auto chooses based on query complexity; fast uses /find; deep uses /search with session context when available.",
            },
            session_id: { type: "string", description: "Optional explicit OpenViking session ID for context-aware search." },
            limit: { type: "number", description: "Maximum number of results. Defaults to 10." },
            score_threshold: { type: "number", description: "Optional minimum score threshold." },
        },
        output: {
            schema: searchResultsSchema,
            render: (_args, value) => text(formatSearchResults(value)),
        },
        async execute(args, exec) {
            const currentSessionId = exec.agent ? String(exec.agent.id) : undefined;
            const sessionId = args.session_id ?? currentSessionId;
            const mode = resolveSearchMode(args.mode, args.query, sessionId);
            if (mode === "deep") {
                // The deep endpoint needs an existing remote session; ensure ours
                // before depending on it (explicit ids are the caller's concern).
                if (exec.agent && !args.session_id)
                    await sessionManager.ensureSession(exec.agent, exec.signal);
                const result = await client.search({
                    query: args.query,
                    targetUri: args.target_uri,
                    sessionId,
                    limit: args.limit ?? 10,
                    scoreThreshold: args.score_threshold,
                    signal: exec.signal,
                });
                return canonicalSearchValue("deep", args.query, result);
            }
            const result = await client.find({
                query: args.query,
                targetUri: args.target_uri,
                limit: args.limit ?? 10,
                scoreThreshold: args.score_threshold,
                signal: exec.signal,
            });
            return canonicalSearchValue("fast", args.query, result);
        },
    });
    const memread = defineTool({
        name: "memread",
        description: "Read a specific viking:// URI. Use after memsearch, memfind, membrowse, memgrep, or memglob returns a URI.",
        parameters: {
            uri: { type: "string", required: true, description: "Complete Viking URI to read." },
            level: {
                type: "string",
                enum: ["auto", "abstract", "overview", "read"],
                description: "Read level. Defaults to auto.",
            },
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    uri: { type: "string", required: true },
                    level: { type: "string", required: true },
                    content: { type: "json", required: true },
                },
            },
            render: (_args, value) => text(stringifyContent(value.content)),
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            parseVikingUri(args.uri, "memread");
            const level = await resolveReadLevel(client, args.uri, args.level ?? "auto", exec.signal);
            const content = await client.readContent(level, args.uri, exec.signal);
            return { uri: args.uri, level, content };
        },
    });
    const membrowse = defineTool({
        name: "membrowse",
        description: "Browse OpenViking filesystem structure. Use list/tree/stat to discover exact URIs before reading.",
        parameters: {
            uri: { type: "string", required: true, description: "Viking URI to inspect, e.g. viking://resources/ or viking://user/memories/." },
            view: { type: "string", enum: ["list", "tree", "stat"], description: "Browse view. Defaults to list." },
            recursive: { type: "boolean", description: "For list view only, recursively list descendants." },
            simple: { type: "boolean", description: "For list view only, return simpler URI-oriented output." },
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    uri: { type: "string", required: true },
                    view: { type: "string", required: true },
                    result: { type: "json", required: true },
                },
            },
            render: (_args, value) => jsonText({ uri: value.uri, view: value.view, result: value.result }),
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            parseVikingUri(args.uri, "membrowse");
            const view = args.view ?? "list";
            let result;
            if (view === "stat") {
                const stat = await client.stat(args.uri, exec.signal);
                result = stat;
            }
            else if (view === "tree") {
                result = await client.tree({ uri: args.uri, signal: exec.signal });
            }
            else {
                result = await client.list({ uri: args.uri, recursive: args.recursive, simple: args.simple, signal: exec.signal });
            }
            return { uri: args.uri, view, result };
        },
    });
    const memgrep = defineTool({
        name: "memgrep",
        description: "Search exact text or regex-like patterns in OpenViking content. Use this for symbols, function names, classes, error strings, or known keywords.",
        parameters: {
            pattern: { type: "string", required: true, description: "Pattern or exact keyword to search for." },
            uri: { type: "string", description: "Starting Viking URI. Defaults to viking://resources/." },
            case_insensitive: { type: "boolean", description: "Whether search should ignore case." },
            exclude_uri: { type: "string", description: "Optional URI prefix to exclude from matches." },
            node_limit: { type: "number", description: "Optional maximum number of matches." },
            level_limit: { type: "number", description: "Optional maximum traversal depth." },
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    matches: { type: "array", required: true, items: { type: "json" } },
                    count: { type: "integer", required: true },
                    match_count: { type: "integer" },
                    files_scanned: { type: "integer" },
                },
            },
            render: (_args, value) => jsonText(value),
            presentationMeta: (_args, value) => ({
                shape: "matches",
                files: grepFiles(value.matches),
                total: typeof value.count === "number" ? value.count : 0,
                truncated: false,
            }),
        },
        isConcurrencySafe: () => true,
        presentResult: (_args, result) => {
            const meta = result.meta;
            if (!isRecord(meta) || meta.shape !== "matches")
                return undefined;
            return {
                card: "search",
                shape: "matches",
                files: asSearchFileMatches(meta.files),
                truncated: meta.truncated === true,
                total: typeof meta.total === "number" ? meta.total : 0,
            };
        },
        async execute(args, exec) {
            const uri = args.uri ?? "viking://resources/";
            parseVikingUri(uri, "memgrep");
            const result = await client.grep({
                pattern: args.pattern,
                uri,
                caseInsensitive: args.case_insensitive,
                excludeUri: args.exclude_uri,
                nodeLimit: args.node_limit,
                levelLimit: args.level_limit,
                signal: exec.signal,
            });
            return {
                matches: result.matches ?? [],
                count: typeof result.count === "number" ? result.count : 0,
                ...(result.match_count !== undefined ? { match_count: result.match_count } : {}),
                ...(result.files_scanned !== undefined ? { files_scanned: result.files_scanned } : {}),
            };
        },
    });
    const memglob = defineTool({
        name: "memglob",
        description: "List files by glob pattern in OpenViking. Use this to enumerate candidate files before memread.",
        parameters: {
            pattern: { type: "string", required: true, description: "Glob pattern, e.g. **/*.py or **/test_*.ts." },
            uri: { type: "string", description: "Starting Viking URI. Defaults to viking://resources/." },
            node_limit: { type: "number", description: "Optional maximum number of matches." },
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    matches: { type: "array", required: true, items: { type: "json" } },
                    count: { type: "integer", required: true },
                },
            },
            render: (_args, value) => jsonText(value),
            presentationMeta: (_args, value) => ({
                shape: "paths",
                paths: globPaths(value.matches),
                total: typeof value.count === "number" ? value.count : 0,
                truncated: false,
            }),
        },
        isConcurrencySafe: () => true,
        presentResult: (_args, result) => {
            const meta = result.meta;
            if (!isRecord(meta) || meta.shape !== "paths")
                return undefined;
            return {
                card: "search",
                shape: "paths",
                paths: Array.isArray(meta.paths) ? meta.paths.filter((p) => typeof p === "string") : [],
                truncated: meta.truncated === true,
                total: typeof meta.total === "number" ? meta.total : 0,
            };
        },
        async execute(args, exec) {
            const uri = args.uri ?? "viking://resources/";
            parseVikingUri(uri, "memglob");
            const result = await client.glob({
                pattern: args.pattern,
                uri,
                nodeLimit: args.node_limit,
                signal: exec.signal,
            });
            return { matches: result.matches ?? [], count: typeof result.count === "number" ? result.count : 0 };
        },
    });
    const memadd = defineTool({
        name: "memadd",
        description: "Add a remote URL or local file resource to OpenViking under viking://resources/. Local files are uploaded through OpenViking temp upload before indexing.",
        parameters: {
            path: {
                type: "string",
                required: true,
                description: "Remote http(s) URL, local file path, or file:// URL to add. Relative local paths resolve from the calling agent's cwd.",
            },
            to: { type: "string", description: "Exact target URI under viking://resources/. Cannot be used with parent." },
            parent: { type: "string", description: "Parent URI under viking://resources/. Cannot be used with to." },
            reason: { type: "string", description: "Reason for adding this resource." },
            instruction: { type: "string", description: "Optional processing instruction." },
            wait: { type: "boolean", description: "Whether OpenViking should wait for semantic processing." },
            timeout: { type: "number", description: "Timeout seconds when wait=true." },
            watch_interval: { type: "number", description: "Minutes between scheduled refreshes. Requires to." },
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    source: { type: "string", enum: ["remote", "local"], required: true },
                    root_uri: { type: "string", required: true },
                    queue: { type: "json", required: true },
                },
            },
            render: (_args, value) => jsonText(value),
        },
        async execute(args, exec) {
            if (args.to !== undefined && args.parent !== undefined) {
                throw new Error("memadd: use either `to` or `parent`, not both.");
            }
            if (args.to !== undefined)
                requireResourcesTarget(args.to, "to");
            if (args.parent !== undefined)
                requireResourcesTarget(args.parent, "parent");
            let tempFileId;
            let source;
            if (isRemoteUrl(args.path)) {
                source = "remote";
            }
            else {
                source = "local";
                tempFileId = await uploadLocalFile(ctx, client, args.path, exec);
            }
            const waitTimeoutMs = args.wait ? Math.max(config.timeoutMs, (args.timeout ?? 300) * 1000) : undefined;
            const addResult = await client.addResource({
                tempFileId,
                path: source === "remote" ? args.path : undefined,
                to: args.to,
                parent: args.parent,
                reason: args.reason,
                instruction: args.instruction,
                wait: args.wait,
                timeout: args.timeout,
                watchInterval: args.watch_interval,
                requestTimeoutMs: waitTimeoutMs,
                signal: exec.signal,
            });
            const rootUri = typeof addResult.root_uri === "string" ? addResult.root_uri : addResult.uri;
            if (typeof rootUri !== "string") {
                throw new OpenVikingError(client.endpoint, "add resource did not return root_uri", { code: "INVALID_RESULT" });
            }
            const queue = await client.queue(exec.signal);
            return { source, root_uri: rootUri, queue };
        },
    });
    const memremove = defineTool({
        name: "memremove",
        description: "Remove a viking:// resource. The user must explicitly confirm deletion before this tool is called. Set confirm=true, otherwise deletion is refused.",
        parameters: {
            uri: { type: "string", required: true, description: "Viking URI to remove." },
            recursive: { type: "boolean", description: "Recursively remove a directory." },
            confirm: { type: "boolean", required: true, description: "Must be true after explicit user confirmation." },
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    uri: { type: "string", required: true },
                    recursive: { type: "boolean", required: true },
                    removed: { type: "boolean", required: true },
                },
            },
            render: (_args, value) => jsonText(value),
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            if (args.confirm !== true) {
                throw new Error("Refusing to delete without confirm=true");
            }
            parseVikingUri(args.uri, "memremove");
            await client.remove({ uri: args.uri, recursive: args.recursive === true, signal: exec.signal });
            return { uri: args.uri, recursive: args.recursive === true, removed: true };
        },
    });
    const memqueue = defineTool({
        name: "memqueue",
        description: "Return OpenViking observer queue status for embedding and semantic processing after resource indexing operations.",
        parameters: {},
        output: {
            schema: { type: "json" },
            render: (_args, value) => jsonText(value),
        },
        isConcurrencySafe: () => true,
        async execute(_args, exec) {
            return client.queue(exec.signal);
        },
    });
    const memcommit = defineTool({
        name: "memcommit",
        description: "Commit the current Harness session to OpenViking and extract persistent memories. Use before ending a conversation or after important preferences/decisions are discussed.",
        parameters: {
            session_id: {
                type: "string",
                description: "Optional explicit OpenViking session ID. Omit to use the current agent's session.",
            },
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    session_id: { type: "string", required: true },
                    status: { type: "string", enum: ["accepted", "completed", "failed"], required: true },
                    task_id: { type: "string" },
                    archived: { type: "boolean" },
                    memories_extracted: { type: "integer", required: true },
                },
            },
            render: (_args, value) => jsonText(value),
        },
        async execute(args, exec) {
            if (!exec.agent && args.session_id === undefined) {
                throw new Error("memcommit: no agent session is available. Start or resume a normal session, or pass session_id.");
            }
            if (exec.agent && (args.session_id === undefined || args.session_id === String(exec.agent.id))) {
                return sessionManager.commitCurrentSession(exec.agent, exec.signal, args.session_id);
            }
            return sessionManager.commitExplicitSession(args.session_id, exec.signal);
        },
    });
    return [memsearch, memfind, memread, membrowse, memcommit, memgrep, memglob, memadd, memremove, memqueue];
}
/** Register all ten tools on `ctx.tools`. */
export function registerOpenVikingTools(ctx, client, sessionManager, config) {
    for (const tool of createOpenVikingTools(ctx, client, sessionManager, config)) {
        ctx.tools.register(tool);
    }
}
// ─── helpers ────────────────────────────────────────────────────────────
function canonicalSearchValue(mode, query, result) {
    const memories = (result.memories ?? []);
    const resources = (result.resources ?? []);
    const skills = (result.skills ?? []);
    const value = {
        mode,
        query,
        memories,
        resources,
        skills,
        total: typeof result.total === "number" ? result.total : memories.length + resources.length + skills.length,
    };
    if (result.query_plan !== undefined)
        value.query_plan = result.query_plan;
    return value;
}
function resolveSearchMode(requestedMode, query, sessionId) {
    if (requestedMode === "fast" || requestedMode === "deep")
        return requestedMode;
    if (sessionId)
        return "deep";
    const normalized = query.trim();
    const wordCount = normalized ? normalized.split(/\s+/).length : 0;
    return normalized.includes("?") || normalized.length >= 80 || wordCount >= 8 ? "deep" : "fast";
}
async function resolveReadLevel(client, uri, requested, signal) {
    if (requested !== "auto")
        return requested;
    try {
        const info = await client.stat(uri, signal);
        return info.isDir === true ? "overview" : "read";
    }
    catch {
        return "read";
    }
}
/** Read a local UTF-8 text file through `ctx.fs` and upload it as a temp file. */
async function uploadLocalFile(ctx, client, inputPath, exec) {
    const cwd = exec.agent?.session?.header?.cwd ?? process.cwd();
    const localPath = isFileUrl(inputPath) ? fileURLToPath(inputPath) : inputPath;
    const target = await ctx.fs.resolve(localPath, { cwd, signal: exec.signal });
    const info = await ctx.fs.stat(target, exec.signal);
    if (!info) {
        throw new OpenVikingError(client.endpoint, `memadd: local file not found: ${target.displayPath}`, { code: "FS_NOT_FOUND" });
    }
    if (info.type !== "file") {
        throw new OpenVikingError(client.endpoint, `memadd: local upload supports files only; directory ${target.displayPath} is not supported — compress it first`, { code: "FS_NOT_REGULAR_FILE" });
    }
    const text = await ctx.fs.readText(target, exec.signal);
    const bytes = new TextEncoder().encode(text);
    const filename = basename(target.displayPath);
    return client.uploadTempFile(filename, bytes, exec.signal);
}
