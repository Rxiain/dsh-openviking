import { isRecord } from "./types.js";
const AUTO_RECALL_SEARCH_LIMIT = 20;
const AUTO_RECALL_QUERY_CHARS = 4000;
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
        let rawResults = [];
        const queryText = query.slice(0, AUTO_RECALL_QUERY_CHARS);
        try {
            // Two spaces, one recall: user memories (preferences/entities/events)
            // plus the agent space (cases/patterns/tools/skills memories and shared
            // skill playbooks). The agent-space search uses the `viking://agent/`
            // prefix — not a per-agent hash — because the service's tenant filter
            // pins memory/skill hits to the calling user's and agent's owner spaces,
            // so a broad prefix can never leak another tenant's memories.
            const searches = [
                client.find({
                    query: queryText,
                    targetUri: "viking://user/memories/",
                    limit: AUTO_RECALL_SEARCH_LIMIT,
                    scoreThreshold: config.scoreThreshold,
                    signal,
                }),
                ...(config.agentSpaces
                    ? [
                        client.find({
                            query: queryText,
                            targetUri: "viking://agent/",
                            limit: AUTO_RECALL_SEARCH_LIMIT,
                            scoreThreshold: config.scoreThreshold,
                            signal,
                        }),
                    ]
                    : []),
            ];
            const settled = await Promise.allSettled(searches);
            for (const outcome of settled) {
                if (outcome.status === "fulfilled") {
                    const result = outcome.value;
                    rawResults.push(...(result.memories ?? []), ...(result.resources ?? []), ...(result.skills ?? []));
                    continue;
                }
                if (signal?.aborted)
                    return;
                const message = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
                const dedupeKey = `recall:${client.endpoint}:${message}`;
                if (!warningKeys.has(dedupeKey)) {
                    warningKeys.add(dedupeKey);
                    logger.warn("auto recall space search failed; skipping that space", {
                        endpoint: client.endpoint,
                        error: message,
                    });
                }
            }
            // All spaces failed: keep the previous behaviour of an empty step.
            if (settled.length > 0 && settled.every((o) => o.status === "rejected"))
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
        // Empty search results are never cached: a later identical query must be
        // able to pick up newly created memories.
        if (rawResults.length === 0)
            return;
        const ranked = pickMemoriesForInjection(rawResults, config.limit, query, config.scoreThreshold);
        // No injection-worthy memories: the empty outcome is not cached either.
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
        logger.info("auto recall prepared", { session: agentKey, count: processed.length, incremental });
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
            // If the agent has since moved to a later turn (or was forgotten), the
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
function isLeafLikeMemory(item) {
    return item.level === 2 || item.is_leaf === true;
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
        const key = getMemoryDedupeKey(item);
        if (seen.has(key))
            continue;
        seen.add(key);
        deduped.push(item);
    }
    const leaves = deduped.filter((item) => isLeafLikeMemory(item));
    if (leaves.length >= limit)
        return leaves.slice(0, limit);
    const picked = [...leaves];
    const used = new Set(leaves.map((item) => item.uri));
    for (const item of deduped) {
        if (picked.length >= limit)
            break;
        if (used.has(item.uri))
            continue;
        if (recallClampScore(item.score) < scoreThreshold)
            continue;
        picked.push(item);
    }
    return picked;
}
function postProcessMemories(items, maxContentChars) {
    return items.map((item) => {
        const abstract = (item.abstract ?? "").trim();
        const content = (item.content ?? "").trim();
        // Prefer the condensed abstract (reference default) over the full body.
        let displayContent = "";
        if (abstract)
            displayContent = abstract;
        else if (content)
            displayContent = content;
        if (displayContent.length > maxContentChars)
            displayContent = `${displayContent.slice(0, maxContentChars)}...`;
        return { ...item, content: displayContent, abstract: abstract || undefined };
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
