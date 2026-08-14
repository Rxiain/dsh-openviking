/**
 * Auto-layer tests: repo-context TTL/stale-on-error and
 * memory-recall ranking/dedupe/budget/frozen-message cloning.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRepoContext } from "../lib/repo-context.js";
import { createMemoryRecall, extractLatestUserText } from "../lib/memory-recall.js";
import { stubClient, stubCtx, sleep } from "./helpers.mjs";

const RECALL_CONFIG = {
  enabled: true,
  limit: 6,
  scoreThreshold: 0.15,
  maxContentChars: 500,
  tokenBudget: 2000,
};

// ─── repo context ───────────────────────────────────────────────────────

test("repo context reuses recent data, refreshes stale data, and retains the last success on failure", async () => {
  let fail = false;
  let calls = 0;
  const { client } = stubClient();
  client.list = () => {
    calls += 1;
    if (fail) return Promise.reject(new Error("service down"));
    return Promise.resolve([
      { uri: "viking://resources/alpha", abstract: "Alpha repo" },
      { uri: "viking://resources/", abstract: "root" },
      { uri: "viking://resources/beta" },
      { uri: "viking://user/memories/x" },
    ]);
  };
  const ctx = stubCtx();
  const repos = createRepoContext(ctx, client, { enabled: true, cacheTtlMs: 200 });

  const first = await repos.refresh();
  assert.equal(calls, 1);
  assert.match(first, /\*\*alpha\*\* \(viking:\/\/resources\/alpha\)/);
  assert.match(first, /\*\*beta\*\* \(viking:\/\/resources\/beta\)/);
  assert.ok(!first.includes("user/memories"));
  assert.ok(!first.includes("resources root"));
  const prompt = repos.getPrompt();
  assert.match(prompt, /## OpenViking - Indexed Code Repositories/);
  assert.match(prompt, /Use `memgrep` for exact symbols/);

  const cached = await repos.refresh();
  assert.equal(calls, 1, "TTL hit reuses the cache");

  await sleep(300);
  await repos.refresh({ force: false });
  assert.equal(calls, 2, "TTL expiry triggers a refetch");

  // Service failure: refresh keeps returning the last successful cache and warns.
  fail = true;
  await sleep(300);
  const after = await repos.refresh();
  assert.equal(after, first, "stale cache survives failure");
  assert.equal(calls, 3, "the failed refresh hit the network");
  assert.ok(ctx.warnings.length >= 1, "failure is logged via ctx.logger.warn");
});

test("disabled or empty repo context produces no prompt context", async () => {
  const { client, calls } = stubClient();
  const ctx = stubCtx();
  const repos = createRepoContext(ctx, client, { enabled: false, cacheTtlMs: 60000 });
  assert.equal(await repos.refresh(), undefined);
  assert.equal(repos.getPrompt(), "");
  assert.equal(calls.length, 0);

  // Enabled but empty: the never-populated cache is empty, and an empty repo list stays empty.
  const { client: emptyClient } = stubClient();
  emptyClient.list = () => Promise.resolve([]);
  const ctx2 = stubCtx();
  const emptyRepos = createRepoContext(ctx2, emptyClient, { enabled: true, cacheTtlMs: 60000 });
  assert.equal(emptyRepos.getPrompt(), "");
  await emptyRepos.refresh();
  assert.equal(emptyRepos.getPrompt(), "", "empty repo list renders nothing");
});

// ─── memory recall ──────────────────────────────────────────────────────

function recallWith(results, overrides = {}) {
  const { client, calls } = stubClient();
  client.find = (opts) => {
    calls.push({ name: "find", opts });
    return Promise.resolve(results);
  };
  const ctx = stubCtx();
  const recall = createMemoryRecall(ctx, client, { ...RECALL_CONFIG, ...overrides });
  return { recall, client, calls, ctx };
}

function userMessages(texts) {
  return texts.map((text, i) => ({
    role: "user",
    id: `msg-${i}`,
    content: [{ type: "text", text }],
    source: { kind: "user" },
  }));
}

test("recall searches the memories namespace using the latest non-empty user text", async () => {
  // extractLatestUserText picks the last non-empty user text.
  assert.equal(extractLatestUserText(userMessages(["a", "b"])), "b");
  assert.equal(extractLatestUserText(userMessages(["a", "   "])), "a");
  assert.equal(extractLatestUserText([]), undefined);

  // prepareStep searches only the memories namespace with that text.
  const { recall, calls } = recallWith({
    memories: [{ uri: "viking://user/memories/1", score: 0.9 }],
    resources: [],
    skills: [],
    total: 1,
  });
  await recall.prepareStep("agent-1", userMessages(["older text", "the current question?"]));
  assert.ok(recall.takeBlock("agent-1"));
  assert.equal(calls[0].opts.targetUri, "viking://user/memories/");
  assert.equal(calls[0].opts.query, "the current question?");
  assert.equal(calls[0].opts.limit, 20);
  assert.equal(calls[0].opts.scoreThreshold, 0.15);
});

test("recall stores the block in the agent slot and never touches the user messages", async () => {
  const { recall } = recallWith({
    memories: [{ uri: "viking://user/memories/1", score: 0.9, abstract: "prefers coffee" }],
    resources: [],
    skills: [],
    total: 1,
  });
  const messages = userMessages(["tell me about preferences"]);
  await recall.prepareStep("agent-1", messages);
  const block = recall.takeBlock("agent-1");
  assert.match(block, /<relevant-memories>/);
  assert.match(block, /<memory uri="viking:\/\/user\/memories\/1">/);
  assert.match(block, /Use `memread` with a memory URI/);
  // The user messages are completely untouched.
  assert.equal(messages[0].content[0].text, "tell me about preferences");
});

test("recall skips ineligible input and fails closed when the service fails", async () => {
  const { recall, calls } = recallWith({ memories: [], resources: [], skills: [], total: 0 });
  await recall.prepareStep("agent-1", []);
  await recall.prepareStep("agent-1", userMessages(["   "]));
  await recall.prepareStep("agent-1", userMessages(["already has <relevant-memories> injected"]));
  assert.equal(recall.takeBlock("agent-1"), "");
  assert.equal(calls.length, 0);

  // Service failure also leaves the slot empty (fails closed) and warns once.
  const { client } = stubClient();
  client.find = () => Promise.reject(new Error("boom"));
  const ctx = stubCtx();
  const failingRecall = createMemoryRecall(ctx, client, RECALL_CONFIG);
  await failingRecall.prepareStep("agent-1", userMessages(["hello there"]));
  assert.equal(failingRecall.takeBlock("agent-1"), "");
  assert.equal(ctx.warnings.length, 1);
});

test("recall does not share cached results across agents", async () => {
  let calls = 0;
  const { client } = stubClient();
  client.find = () => {
    calls += 1;
    return Promise.resolve({
      memories: [{ uri: "viking://user/memories/1", score: 0.9, abstract: "shared-ish" }],
      resources: [],
      skills: [],
      total: 1,
    });
  };
  const ctx = stubCtx();
  const recall = createMemoryRecall(ctx, client, RECALL_CONFIG);
  const messages = userMessages(["same query text"]);
  await recall.prepareStep("agent-1", messages);
  await recall.prepareStep("agent-2", messages);
  assert.equal(calls, 2, "each agent performs its own recall");
  await recall.prepareStep("agent-1", messages);
  assert.equal(calls, 2, "same agent caches");
  assert.ok(recall.takeBlock("agent-1"));
  assert.ok(recall.takeBlock("agent-2"));
});

test("recall does not cache empty results: an identical query searches again", async () => {
  let searches = 0;
  const { client } = stubClient();
  client.find = () => {
    searches += 1;
    return Promise.resolve({ memories: [], resources: [], skills: [], total: 0 });
  };
  const ctx = stubCtx();
  const recall = createMemoryRecall(ctx, client, RECALL_CONFIG);
  const messages = userMessages(["any memories yet?"]);
  await recall.prepareStep("agent-1", messages);
  assert.equal(recall.takeBlock("agent-1"), "");
  assert.equal(searches, 1);
  await recall.prepareStep("agent-1", messages);
  assert.equal(recall.takeBlock("agent-1"), "");
  assert.equal(searches, 2, "empty results are not cached, so the identical query searches again");
});

test("recall evicts the oldest per-agent cache entry, forcing a re-search on overflow", async () => {
  let searches = 0;
  const { client } = stubClient();
  client.find = (opts) => {
    searches += 1;
    return Promise.resolve({
      memories: [
        { uri: `viking://user/memories/${searches}`, level: 2, score: 0.9, abstract: `memory body ${searches}` },
      ],
      resources: [],
      skills: [],
      total: 1,
    });
  };
  const ctx = stubCtx();
  const recall = createMemoryRecall(ctx, client, RECALL_CONFIG);

  const oldestMessages = userMessages(["query 0"]);
  await recall.prepareStep("agent-1", oldestMessages);
  assert.equal(searches, 1);

  // 16 further distinct queries fill the 16-entry per-agent cache.
  for (let i = 1; i <= 16; i += 1) {
    await recall.prepareStep("agent-1", userMessages([`query ${i}`]));
  }
  assert.equal(searches, 17);

  // The oldest entry was evicted (FIFO): the identical oldest query re-searches.
  await recall.prepareStep("agent-1", oldestMessages);
  assert.equal(searches, 18, "overflow evicts the oldest entry, forcing a re-search");
  assert.ok(recall.takeBlock("agent-1"));
});

test("recall re-searches and replaces entries after the 5-minute TTL expires", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  let searches = 0;
  const { client } = stubClient();
  client.find = () => {
    searches += 1;
    return Promise.resolve({
      memories: [{ uri: "viking://user/memories/1", level: 2, score: 0.9, abstract: "persistent memory" }],
      resources: [],
      skills: [],
      total: 1,
    });
  };
  const ctx = stubCtx();
  const recall = createMemoryRecall(ctx, client, RECALL_CONFIG);
  const messages = userMessages(["the same question"]);
  await recall.prepareStep("agent-1", messages);
  assert.equal(searches, 1);

  // Within the TTL the identical query reuses the cached block.
  await recall.prepareStep("agent-1", messages);
  assert.equal(searches, 1);
  assert.ok(recall.takeBlock("agent-1"));

  // Past the TTL the expired entry is re-searched and replaced.
  t.mock.timers.tick(5 * 60 * 1000 + 1);
  await recall.prepareStep("agent-1", messages);
  assert.equal(searches, 2, "TTL expiry triggers a re-search");
  assert.ok(recall.takeBlock("agent-1"));
});

test("recall ranks leaves first, dedupes by abstract/uri, and applies the score threshold to fillers", async () => {
  const results = {
    memories: [
      { uri: "viking://user/memories/leaf-1", level: 2, score: 0.5, abstract: "prefers dark mode" },
      { uri: "viking://user/memories/leaf-2", level: 2, score: 0.4, abstract: "prefers dark mode" }, // dedupe dup
      { uri: "viking://user/memories/branch", level: 1, score: 0.9, abstract: "branch note" },
      { uri: "viking://user/memories/low", level: 1, score: 0.05, abstract: "low score filler" },
    ],
    resources: [],
    skills: [],
    total: 4,
  };
  const { recall } = recallWith(results, { limit: 2, scoreThreshold: 0.15 });
  await recall.prepareStep("agent-1", userMessages(["dark mode preferences"]));
  const block = recall.takeBlock("agent-1");
  assert.match(block, /leaf-1/);
  assert.ok(!block.includes("leaf-2"), "duplicate abstract deduped");
  assert.ok(!block.includes("low score filler"), "below-threshold filler excluded");
});

test("recall caps per-item chars and the total block to tokenBudget * 4 chars", async () => {
  const longAbstract = "x".repeat(900);
  const { recall } = recallWith(
    {
      memories: [
        { uri: "viking://user/memories/1", level: 2, score: 0.9, abstract: longAbstract },
        { uri: "viking://user/memories/2", level: 2, score: 0.9, abstract: "second memory body" },
      ],
      resources: [],
      skills: [],
      total: 2,
    },
    { maxContentChars: 100, tokenBudget: 50 }, // budget = 200 chars: entry 1 fits, entry 2 would exceed
  );
  await recall.prepareStep("agent-1", userMessages(["q"]));
  const block = recall.takeBlock("agent-1");
  const inner = block.slice(block.indexOf("<relevant-memories>") + "<relevant-memories>".length, block.indexOf("</relevant-memories>"));
  assert.ok(inner.length <= 200, `entry section length ${inner.length} within budget`);
  assert.match(block, /memories\/1/);
  assert.ok(!block.includes("memory/2"), "second entry dropped when the budget would be exceeded");
  assert.match(block, /x{100}\.\.\./, "per-item content capped and ellipsized");
});
