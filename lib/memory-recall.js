import { isRecord } from "./types.js";
const AUTO_RECALL_SEARCH_LIMIT = 20;
const AUTO_RECALL_QUERY_CHARS = 4000;
const AUTO_RECALL_BRANCH_LIMIT = 16;
const AUTO_RECALL_BRANCH_TIMEOUT_MS = 3_000;
const AUTO_RECALL_TREE_TTL_MS = 5 * 60 * 1000;
const RECALL_STOPWORDS = new Set([
    "what",
    "when",
    "where",
    "which",
    "who",
    "whom",
    "whose",
    "why",
    "how",
    "did",
    "does",
    "is",
    "are",
    "was",
    "were",
    "the",
    "and",
    "for",
    "with",
    "from",
    "that",
    "this",
    "your",
    "you",
]);
const RECALL_TOKEN_RE = /[a-z0-9]{2,}/gi;
const PREFERENCE_QUERY_RE = /prefer|preference|favorite|favourite|like|偏好|喜欢|爱好|更倾向/i;
const TEMPORAL_QUERY_RE = /when|what time|date|day|month|year|yesterday|today|tomorrow|last|next|什么时候|何时|哪天|几月|几年|昨天|今天|明天|上周|下周|上个月|下个月|去年|明年/i;
const PROCEDURE_INTENT_RE = /\b(workflow|workflows|audit|auditing|recover|recovery|restore|restoration|compensat(?:e|ion)|replay|replay(?:ing)?|verif(?:y|ication)|remediat(?:e|ion)|diagnos(?:e|is)|migrat(?:e|ion)|runbook|playbook|procedure|process|steps?|how do i|how can i|what steps)\b|审计|审核|恢复|补偿|重放|回放|验证|核验|修复|补救|诊断|迁移|流程|步骤|怎么做|如何处理|排查/i;
const PROCEDURE_PATH_RE = /(?:^|[\\/])(?:方法论|方法|流程|剧本|playbook|playbooks|method|methods|pattern|patterns|case|cases|runbook|runbooks|workflow|workflows|skill|skills)(?:[\\/]|$)/i;
export function hasProcedureIntent(query) {
    return PROCEDURE_INTENT_RE.test(query);
}
// Bounds for the per-agent recall cache: at most RECALL_CACHE_MAX_PER_AGENT
// entries per agent (oldest evicted on overflow, FIFO) and entries expire
// after RECALL_CACHE_TTL_MS, so stale or unbounded results are never reused.
const RECALL_CACHE_MAX_PER_AGENT = 16;
const RECALL_CACHE_TTL_MS = 5 * 60 * 1000;
export function createMemoryRecall(ctx, client, config) {
    // Accept a plain object (tests, direct callers) or a thunk (live settings).
    const getConfig = typeof config === "function" ? config : () => config;
    const logger = ctx.logger("openviking:memory-recall");
    // Per-agent one-shot slot for the current step's block.
    const blocks = new Map();
    // Per-agent query dedupe with TTL: private recall results must never leak
    // across agents, and empty/stale outcomes must not be reused forever.
    const recallCache = new Map();
    const warningKeys = new Set();
    const agentStates = new Map();
    let memoryBranches;
    let procedureMemoryBranches;
    let memoryBranchesFetchedAt = 0;
    let memoryBranchesInflight;
    let procedureMemoryBranchesInflight;
    async function discoverMemoryBranches(procedureOnly, signal) {
        const now = Date.now();
        const cached = procedureOnly ? procedureMemoryBranches : memoryBranches;
        if (cached !== undefined && now - memoryBranchesFetchedAt < AUTO_RECALL_TREE_TTL_MS)
            return cached;
        const inflight = procedureOnly ? procedureMemoryBranchesInflight : memoryBranchesInflight;
        if (inflight)
            return inflight;
        const load = (async () => {
            try {
                const result = await client.tree({ uri: "viking://user/memories/", nodeLimit: 200, levelLimit: 3, signal });
                const branches = new Set();
                if (Array.isArray(result)) {
                    for (const node of result) {
                        if (!isRecord(node) || node.isDir !== false || typeof node.uri !== "string")
                            continue;
                        const slash = node.uri.lastIndexOf("/");
                        if (slash <= "viking://user/memories".length)
                            continue;
                        const branch = `${node.uri.slice(0, slash + 1)}`;
                        if (!procedureOnly || PROCEDURE_PATH_RE.test(branch))
                            branches.add(branch);
                    }
                }
                const discovered = [...branches].sort((a, b) => b.length - a.length || a.localeCompare(b)).slice(0, AUTO_RECALL_BRANCH_LIMIT);
                if (procedureOnly)
                    procedureMemoryBranches = discovered;
                else
                    memoryBranches = discovered;
                memoryBranchesFetchedAt = Date.now();
                return discovered;
            }
            catch (error) {
                if (!signal?.aborted) {
                    const message = error instanceof Error ? error.message : String(error);
                    const dedupeKey = `tree:${client.endpoint}:${message}`;
                    if (!warningKeys.has(dedupeKey)) {
                        warningKeys.add(dedupeKey);
                        logger.warn("memory branch discovery failed; skipping fallback", { endpoint: client.endpoint, error: message });
                    }
                }
                return cached ?? [];
            }
            finally {
                if (procedureOnly)
                    procedureMemoryBranchesInflight = undefined;
                else
                    memoryBranchesInflight = undefined;
            }
        })();
        if (procedureOnly)
            procedureMemoryBranchesInflight = load;
        else
            memoryBranchesInflight = load;
        return load;
    }
    function hasRenderableLeaf(items, queryText, scoreThreshold) {
        const query = buildRecallQueryProfile(queryText);
        return items.some((item) => isLeafLikeMemory(item) && hasMemoryText(item) && localRelevanceScore(item, query) >= scoreThreshold);
    }
    function hasEmptyBranch(item) {
        return !isLeafLikeMemory(item) && ("abstract" in item || "overview" in item || "content" in item) && !hasMemoryText(item);
    }
    function hasMemoryText(item) {
        const hasTextField = "abstract" in item || "overview" in item || "content" in item;
        return !hasTextField || Boolean((item.abstract ?? item.overview ?? item.content ?? "").trim());
    }
    /** Store a non-empty block for (agent, query), evicting the oldest entry on overflow. */
    function setCache(agentKey, query, block) {
        let agentCache = recallCache.get(agentKey);
        if (!agentCache) {
            agentCache = new Map();
            recallCache.set(agentKey, agentCache);
        }
        // Re-insert so the refreshed entry counts as the newest, then evict the
        // oldest (first-inserted) entry while the agent exceeds its bound.
        agentCache.delete(query);
        agentCache.set(query, { block, timestamp: Date.now() });
        while (agentCache.size > RECALL_CACHE_MAX_PER_AGENT) {
            const first = agentCache.keys().next();
            if (first.done)
                break;
            agentCache.delete(first.value);
        }
    }
    async function prepareStep(agentKey, messages, signal) {
        // Clear first: a block only lives for the step that computed it.
        const config = getConfig();
        blocks.set(agentKey, "");
        if (!config.enabled)
            return;
        const latest = extractLatestUserMessage(messages);
        if (!latest)
            return;
        // One search + one injection per user message; later tool steps of the
        // same message neither re-search nor re-inject (the block already rides
        // in the message history). Large tasks can still pick up memories written
        // mid-flight: every `refreshSteps` steps a throttled re-search runs and
        // only genuinely new memories are injected incrementally.
        const existing = agentStates.get(agentKey);
        const isNewMessage = !existing || existing.lastMessageId !== latest.id;
        let incremental = false;
        const state = isNewMessage
            ? { lastMessageId: latest.id, stepCount: 0, injectedUris: new Set() }
            : existing;
        if (isNewMessage) {
            agentStates.set(agentKey, state);
            // Memory-map cadence in user turns (session start + every N turns).
            maybeRefreshStartupMap(agentKey);
        }
        else {
            state.stepCount += 1;
            const refresh = config.refreshSteps;
            if (refresh <= 0 || state.stepCount < refresh)
                return;
            incremental = true; // throttled refresh: search, inject only new URIs
        }
        const query = latest.text;
        // A throttled refresh must see memories written mid-flight, so it bypasses
        // the query cache; first-searches still reuse the 5-minute cache.
        const cached = !incremental ? recallCache.get(agentKey)?.get(query) : undefined;
        if (cached !== undefined && Date.now() - cached.timestamp < RECALL_CACHE_TTL_MS) {
            blocks.set(agentKey, cached.block);
            // The cached block's memories were injected for this message: mark their
            // URIs as seen so a later throttled refresh of the same message never
            // re-injects them (they would otherwise look "new" to the incremental
            // filter and duplicate the block).
            for (const uri of extractMemoryUris(cached.block))
                state.injectedUris.add(uri);
            return;
        }
        const procedural = hasProcedureIntent(query);
        const generalResults = [];
        const procedureResults = [];
        let procedureBranches = 0;
        let procedureFailures = 0;
        let procedureTimedOut = 0;
        const queryText = query.slice(0, AUTO_RECALL_QUERY_CHARS);
        try {
            // Fetch a bounded candidate pool without server-side score filtering.
            // Local ranking combines semantic score with lexical overlap, allowing
            // exact project terms to qualify without hard-coded identifier shapes.
            const searches = [
                client.find({ query: queryText, targetUri: "viking://user/memories/", limit: AUTO_RECALL_SEARCH_LIMIT, scoreThreshold: 0, signal }),
                ...(config.agentSpaces
                    ? [client.find({ query: queryText, targetUri: "viking://agent/", limit: AUTO_RECALL_SEARCH_LIMIT, scoreThreshold: 0, signal })]
                    : []),
            ];
            const settled = await Promise.allSettled(searches);
            const userResults = [];
            for (const [index, outcome] of settled.entries()) {
                if (outcome.status === "fulfilled") {
                    const result = outcome.value;
                    const items = [...(result.memories ?? []), ...(result.resources ?? []), ...(result.skills ?? [])];
                    generalResults.push(...items);
                    if (index === 0)
                        userResults.push(...items);
                    continue;
                }
                if (signal?.aborted)
                    return;
                const message = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
                const dedupeKey = `recall:${client.endpoint}:${message}`;
                if (!warningKeys.has(dedupeKey)) {
                    warningKeys.add(dedupeKey);
                    logger.warn("auto recall space search failed; skipping that space", { endpoint: client.endpoint, error: message });
                }
            }
            const needsBranchFallback = userResults.some(hasEmptyBranch) && !hasRenderableLeaf(userResults, query, config.scoreThreshold);
            if (procedural || needsBranchFallback) {
                const branches = await discoverMemoryBranches(procedural, signal);
                procedureBranches = procedural ? branches.length : 0;
                const branchResults = await Promise.allSettled(branches.map(async (targetUri) => {
                    const controller = new AbortController();
                    const abort = () => controller.abort();
                    let timedOut = false;
                    if (signal?.aborted)
                        abort();
                    else
                        signal?.addEventListener("abort", abort, { once: true });
                    const timeout = setTimeout(() => {
                        if (procedural) {
                            timedOut = true;
                            procedureTimedOut += 1;
                        }
                        controller.abort();
                    }, AUTO_RECALL_BRANCH_TIMEOUT_MS);
                    try {
                        return await client.find({ query: queryText, targetUri, limit: AUTO_RECALL_SEARCH_LIMIT, scoreThreshold: 0, signal: controller.signal });
                    }
                    catch (error) {
                        if (timedOut)
                            throw Object.assign(new Error("procedure branch timed out"), { procedureTimeout: true });
                        throw error;
                    }
                    finally {
                        clearTimeout(timeout);
                        signal?.removeEventListener("abort", abort);
                    }
                }));
                for (const outcome of branchResults) {
                    if (outcome.status === "fulfilled") {
                        const result = outcome.value;
                        const items = [...(result.memories ?? []), ...(result.resources ?? []), ...(result.skills ?? [])];
                        if (procedural)
                            procedureResults.push(...items);
                        else
                            generalResults.push(...items);
                    }
                    else if (procedural &&
                        !signal?.aborted &&
                        !(outcome.reason && typeof outcome.reason === "object" && "procedureTimeout" in outcome.reason)) {
                        procedureFailures += 1;
                    }
                }
            }
            if (settled.every((outcome) => outcome.status === "rejected") && generalResults.length === 0 && procedureResults.length === 0)
                return;
        }
        catch (error) {
            if (signal?.aborted)
                return;
            const message = error instanceof Error ? error.message : String(error);
            const dedupeKey = `recall:${client.endpoint}:${message}`;
            if (!warningKeys.has(dedupeKey)) {
                warningKeys.add(dedupeKey);
                logger.warn("auto recall failed; skipping silently", { endpoint: client.endpoint, error: message });
            }
            return;
        }
        if (generalResults.length === 0 && procedureResults.length === 0)
            return;
        const generalRanked = pickMemoriesForInjection(generalResults, config.limit, query, config.scoreThreshold);
        const procedureRanked = procedural ? pickMemoriesForInjection(procedureResults, 1, query, config.scoreThreshold) : [];
        const ranked = selectRecallLanes(procedureRanked, generalRanked, config.limit);
        if (ranked.length === 0)
            return;
        let processed = postProcessMemories(ranked, config.maxContentChars);
        if (incremental) {
            // Throttled refresh: keep only memories the model has not seen yet in
            // this message. No new memories → no injection at all (0 tokens).
            processed = processed.filter((item) => {
                const uri = typeof item.uri === "string" ? item.uri : "";
                return uri !== "" && !state.injectedUris.has(uri);
            });
            if (processed.length === 0)
                return;
        }
        const block = formatMemoryBlock(processed, config.tokenBudget);
        if (!block)
            return;
        // Only FULL results enter the query cache. An incremental (throttled
        // refresh) block holds just the newly injected subset — caching it would
        // let a later same-query message hit a truncated block instead of the
        // complete recall.
        if (!incremental)
            setCache(agentKey, query, block);
        for (const item of processed) {
            if (typeof item.uri === "string" && item.uri)
                state.injectedUris.add(item.uri);
        }
        blocks.set(agentKey, block);
        logger.info("auto recall prepared", {
            session: agentKey,
            count: processed.length,
            incremental,
            procedural,
            procedureBranches,
            procedureCandidates: procedureRanked.length,
            selectedLanes: ranked.map((item) => procedureRanked.some((candidate) => candidate.uri === item.uri) ? "procedure" : "general"),
            procedureFailures,
            procedureTimedOut,
            fallback: procedural && procedureRanked.length === 0,
        });
    }
    function takeBlock(agentKey) {
        return blocks.get(agentKey) ?? "";
    }
    // ─── session-start memory map ─────────────────────────────────────────
    const startupBlocks = new Map();
    // Per-agent user-turn count driving the memory-map cadence.
    const startupTurnCounts = new Map();
    /**
     * Memory-map cadence, evaluated on every NEW user message: turn 1 of a
     * session always injects; with `startupMapEveryTurns` >= 2 the map is
     * refreshed on turns 1, 1+N, 1+2N, ... so long sessions see fresh category
     * counts as memories accumulate. Cadence 1 = session-start injection only;
     * 0 = never. The map itself is a cheap category overview (oh-my-pi's
     * Memory Guidance) built asynchronously; details are fetched on demand.
     */
    function maybeRefreshStartupMap(agentKey) {
        const every = getConfig().startupMapEveryTurns;
        if (every <= 0)
            return;
        const count = (startupTurnCounts.get(agentKey) ?? 0) + 1;
        startupTurnCounts.set(agentKey, count);
        const due = every === 1 ? count === 1 : (count - 1) % every === 0;
        if (!due) {
            // Not a map turn: never leak the previous turn's block.
            startupBlocks.delete(agentKey);
            return;
        }
        // Snapshot the turn that triggered this build: the result may only land
        // while the agent is still on that same turn (see buildStartupMapAsync).
        void buildStartupMapAsync(agentKey, count);
    }
    async function buildStartupMapAsync(agentKey, triggerTurn) {
        try {
            const stats = await client.memoryStats();
            // Turn-generation check: the map belongs to the turn that triggered it.
            // late result must be discarded — a stale map would otherwise be set
            // here and injected into a turn it never belonged to. When the turn has
            // NOT advanced the check passes and the block lands as usual.
            if (startupTurnCounts.get(agentKey) !== triggerTurn)
                return;
            const byCategory = stats.by_category ?? {};
            const entries = Object.entries(byCategory)
                .filter(([, count]) => typeof count === "number" && count > 0)
                .sort((a, b) => b[1] - a[1]);
            const total = stats.total_memories ?? entries.reduce((sum, [, count]) => sum + count, 0);
            if (total <= 0)
                return;
            const lines = ["<memory-library>", `OpenViking 记忆库:共 ${total} 条记忆`];
            for (const [category, count] of entries) {
                lines.push(`- ${category}: ${count}`);
            }
            lines.push("检索:memsearch/memfind 语义搜索,memread 读详情;有新经验用 memlearn 主动沉淀。");
            lines.push("</memory-library>");
            startupBlocks.set(agentKey, lines.join("\n"));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const dedupeKey = `startup:${client.endpoint}:${message}`;
            if (!warningKeys.has(dedupeKey)) {
                warningKeys.add(dedupeKey);
                logger.warn("memory map build failed; skipping", { endpoint: client.endpoint, error: message });
            }
        }
    }
    function takeStartupBlock(agentKey) {
        // Consume-on-read: the map is injected at most once. The build is async,
        // so the block may land a step late — but it must never ride along into
        // later steps of the same turn (that is what the session log showed:
        // repeated <memory-library> injections in one turn).
        const block = startupBlocks.get(agentKey);
        if (block !== undefined)
            startupBlocks.delete(agentKey);
        return block ?? "";
    }
    /** Release every per-agent structure this recall holds for `agentKey`. */
    function forget(agentKey) {
        blocks.delete(agentKey);
        recallCache.delete(agentKey);
        agentStates.delete(agentKey);
        startupBlocks.delete(agentKey);
        startupTurnCounts.delete(agentKey);
    }
    return { prepareStep, takeBlock, takeStartupBlock, forget };
}
/** Latest REAL user message (id + text); undefined when absent or already injected.
 * Plugin-sourced context injections (runtime snapshots, our own recall/map
 * blocks) ride into later steps' message lists as user-role messages with
 * source.kind "plugin" — they must never be mistaken for a new user turn, or
 * the per-message dedupe would be defeated on every step. */
function extractLatestUserMessage(messages) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (!message || message.role !== "user")
            continue;
        const source = message.source;
        if (!isRecord(source) || source.kind !== "user")
            continue;
        const text = contentToText(message.content).trim();
        if (!text)
            continue;
        if (text.includes("<relevant-memories>"))
            return undefined;
        return { id: String(message.id), text };
    }
    return undefined;
}
/** Latest user text from the message list; undefined when absent or already injected. */
export function extractLatestUserText(messages) {
    return extractLatestUserMessage(messages)?.text;
}
function contentToText(content) {
    return content
        .filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join(" ");
}
function buildRecallQueryProfile(query) {
    const text = query.trim();
    const allTokens = text.toLowerCase().match(RECALL_TOKEN_RE) ?? [];
    return {
        tokens: allTokens.filter((token) => !RECALL_STOPWORDS.has(token)),
        wantsPreference: PREFERENCE_QUERY_RE.test(text),
        wantsTemporal: TEMPORAL_QUERY_RE.test(text),
    };
}
function recallClampScore(value) {
    if (typeof value !== "number" || Number.isNaN(value))
        return 0;
    return Math.max(0, Math.min(1, value));
}
function isLeafLikeMemory(item) {
    return (typeof item.level === "number" && item.level >= 2) || item.is_leaf === true;
}
function lexicalOverlapBoost(tokens, text) {
    if (tokens.length === 0 || !text)
        return 0;
    const haystack = ` ${text.toLowerCase()} `;
    let matched = 0;
    for (const token of tokens.slice(0, 8)) {
        if (haystack.includes(` ${token} `) || haystack.includes(token))
            matched += 1;
    }
    return Math.min(0.2, (matched / Math.min(tokens.length, 4)) * 0.2);
}
function isEventMemory(item) {
    const category = (item.category ?? "").toLowerCase();
    return category === "events" || Boolean(item.uri?.includes("/events/"));
}
function isPreferencesMemory(item) {
    return (item.category === "preferences" ||
        Boolean(item.uri?.includes("/preferences/")) ||
        Boolean(item.uri?.endsWith("/preferences")));
}
function hasMemoryText(item) {
    const hasTextField = "abstract" in item || "overview" in item || "content" in item;
    return !hasTextField || Boolean((item.abstract ?? item.overview ?? item.content ?? "").trim());
}
function rankForInjection(item, query) {
    const baseScore = recallClampScore(item.score);
    const abstract = (item.abstract ?? item.overview ?? "").trim();
    const leafBoost = isLeafLikeMemory(item) ? 0.12 : 0;
    const eventBoost = query.wantsTemporal && isEventMemory(item) ? 0.1 : 0;
    const preferenceBoost = query.wantsPreference && isPreferencesMemory(item) ? 0.08 : 0;
    const overlapBoost = lexicalOverlapBoost(query.tokens, `${item.uri ?? ""} ${abstract}`);
    return baseScore + leafBoost + eventBoost + preferenceBoost + overlapBoost;
}
function normalizeDedupeText(text) {
    return text.toLowerCase().replace(/\s+/g, " ").trim();
}
function isEventOrCaseMemory(item) {
    const category = (item.category ?? "").toLowerCase();
    const uri = (item.uri ?? "").toLowerCase();
    return category === "events" || category === "cases" || uri.includes("/events/") || uri.includes("/cases/");
}
function localRelevanceScore(item, query) {
    const searchableText = `${item.uri ?? ""} ${item.title ?? ""} ${item.abstract ?? item.overview ?? item.content ?? ""}`;
    return recallClampScore(item.score) + lexicalOverlapBoost(query.tokens, searchableText);
}
function getMemoryDedupeKey(item) {
    const abstract = normalizeDedupeText(item.abstract ?? item.overview ?? "");
    const category = (item.category ?? "").toLowerCase() || "unknown";
    if (abstract && !isEventOrCaseMemory(item))
        return `abstract:${category}:${abstract}`;
    return `uri:${item.uri ?? ""}`;
}
function pickMemoriesForInjection(items, limit, queryText, scoreThreshold = 0) {
    const query = buildRecallQueryProfile(queryText);
    const sorted = [...items].sort((a, b) => rankForInjection(b, query) - rankForInjection(a, query));
    const deduped = [];
    const seen = new Set();
    for (const item of sorted) {
        if (!hasMemoryText(item))
            continue;
        const key = getMemoryDedupeKey(item);
        if (seen.has(key))
            continue;
        seen.add(key);
        deduped.push(item);
    }
    return deduped
        .filter((item) => localRelevanceScore(item, query) >= scoreThreshold)
        .slice(0, limit);
}
function selectRecallLanes(procedure, general, limit) {
    if (limit <= 0)
        return [];
    const selected = [];
    const usedUris = new Set();
    const reserved = procedure[0];
    if (reserved?.uri) {
        selected.push(reserved);
        usedUris.add(reserved.uri);
    }
    for (const item of general) {
        if (selected.length >= limit)
            break;
        if (!item.uri || usedUris.has(item.uri))
            continue;
        selected.push(item);
        usedUris.add(item.uri);
    }
    return selected;
}
function postProcessMemories(items, maxContentChars) {
    return items
        .filter((item) => hasMemoryText(item))
        .map((item) => {
        const abstract = (item.abstract ?? "").trim();
        const overview = (item.overview ?? "").trim();
        const content = (item.content ?? "").trim();
        // Prefer the condensed abstract, then the overview, then full content.
        let displayContent = abstract || overview || content;
        if (displayContent.length > maxContentChars)
            displayContent = `${displayContent.slice(0, maxContentChars)}...`;
        return { ...item, content: displayContent, abstract: abstract || undefined, overview: overview || undefined };
    });
}
const MEMORY_URI_RE = /<memory uri="([^"]+)">/g;
/** Extract the URIs of all `<memory uri="...">` entries inside a formatted block. */
function extractMemoryUris(block) {
    const uris = [];
    for (const match of block.matchAll(MEMORY_URI_RE)) {
        if (match[1])
            uris.push(match[1]);
    }
    return uris;
}
function formatMemoryBlock(items, tokenBudget) {
    if (items.length === 0)
        return "";
    const maxBlockChars = tokenBudget * 4;
    let usedChars = 0;
    const lines = ["<relevant-memories>"];
    for (const item of items) {
        if (!item.uri)
            continue;
        const title = item.title ? `${item.title}\n` : "";
        const content = item.content ?? "";
        const entry = `<memory uri="${item.uri}">\n${title}${content}\n</memory>`;
        if (usedChars + entry.length + 1 > maxBlockChars)
            break;
        lines.push(entry);
        usedChars += entry.length + 1;
    }
    if (usedChars === 0)
        return "";
    lines.push("</relevant-memories>");
    lines.push('Use `memread` with a memory URI and level="overview" or level="read" for more details.');
    return lines.join("\n");
}
