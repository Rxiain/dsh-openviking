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
    const logger = ctx.logger("openviking:memory-recall");
    // Per-agent one-shot slot for the current step's block.
    const blocks = new Map();
    // Per-agent query dedupe with TTL: private recall results must never leak
    // across agents, and empty/stale outcomes must not be reused forever.
    const recallCache = new Map();
    const warningKeys = new Set();
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
        blocks.set(agentKey, "");
        if (!config.enabled)
            return;
        const query = extractLatestUserText(messages);
        if (!query)
            return;
        const cached = recallCache.get(agentKey)?.get(query);
        if (cached !== undefined && Date.now() - cached.timestamp < RECALL_CACHE_TTL_MS) {
            blocks.set(agentKey, cached.block);
            return;
        }
        let rawResults = [];
        try {
            const result = await client.find({
                query: query.slice(0, AUTO_RECALL_QUERY_CHARS),
                targetUri: "viking://user/memories/",
                limit: AUTO_RECALL_SEARCH_LIMIT,
                scoreThreshold: config.scoreThreshold,
                signal,
            });
            rawResults = [...(result.memories ?? []), ...(result.resources ?? []), ...(result.skills ?? [])];
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
        const processed = postProcessMemories(ranked, config.maxContentChars);
        const block = formatMemoryBlock(processed, config.tokenBudget);
        if (!block)
            return;
        setCache(agentKey, query, block);
        blocks.set(agentKey, block);
        logger.info("auto recall prepared", { session: agentKey, count: processed.length });
    }
    function takeBlock(agentKey) {
        return blocks.get(agentKey) ?? "";
    }
    return { prepareStep, takeBlock };
}
/** Latest user text from the message list; undefined when absent or already injected. */
export function extractLatestUserText(messages) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (!message || message.role !== "user")
            continue;
        const text = contentToText(message.content).trim();
        if (!text)
            continue;
        if (text.includes("<relevant-memories>"))
            return undefined;
        return text;
    }
    return undefined;
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
