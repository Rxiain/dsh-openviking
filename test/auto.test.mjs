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
  agentSpaces: true,
  refreshSteps: 10,
  startupMapEveryTurns: 5,
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

function userMessages(texts, idStart = 0) {
  return texts.map((text, i) => ({
    role: "user",
    id: `msg-${idStart + i}`,
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
  const recall = createMemoryRecall(ctx, client, { ...RECALL_CONFIG, agentSpaces: false });
  const messages = userMessages(["same query text"]);
  await recall.prepareStep("agent-1", messages);
  await recall.prepareStep("agent-2", messages);
  assert.equal(calls, 2, "each agent performs its own recall");
  await recall.prepareStep("agent-1", messages);
  assert.equal(calls, 2, "same agent caches");
  // The same message's later steps do not re-inject — the first step's block
  // already rides in the message history; the other agent's block is intact.
  assert.equal(recall.takeBlock("agent-1"), "");
  assert.ok(recall.takeBlock("agent-2"));
});

test("recall dedupes per user message: later steps of the same message neither re-search nor re-inject", async () => {
  let searches = 0;
  const { client } = stubClient();
  client.find = () => {
    searches += 1;
    return Promise.resolve({ memories: [], resources: [], skills: [], total: 0 });
  };
  const ctx = stubCtx();
  const recall = createMemoryRecall(ctx, client, { ...RECALL_CONFIG, agentSpaces: false });
  const messages = userMessages(["any memories yet?"]);
  await recall.prepareStep("agent-1", messages);
  assert.equal(recall.takeBlock("agent-1"), "");
  assert.equal(searches, 1);
  // Later step of the SAME message: no re-search, no re-injection.
  await recall.prepareStep("agent-1", messages);
  assert.equal(recall.takeBlock("agent-1"), "");
  assert.equal(searches, 1, "same user message is prepared exactly once");

  // A NEW message (different id, same text): searches again — empty results
  // are not cached across messages so fresh memories can be picked up.
  await recall.prepareStep("agent-1", userMessages(["any memories yet?"], 10));
  assert.equal(searches, 2, "a new user message triggers a fresh search");
});

test("recall injects the block once and leaves it to the message history for later steps", async () => {
  const { client } = stubClient();
  client.find = () => Promise.resolve({
    memories: [{ uri: "viking://user/memories/1", score: 0.9, abstract: "prefers coffee" }],
    resources: [],
    skills: [],
    total: 1,
  });
  const ctx = stubCtx();
  const recall = createMemoryRecall(ctx, client, RECALL_CONFIG);
  const messages = userMessages(["tell me about preferences"]);
  await recall.prepareStep("agent-1", messages);
  assert.match(recall.takeBlock("agent-1"), /<relevant-memories>/);
  // Tool step after the same user message: the block already rode the first
  // step's injection into the message history — no duplicate block.
  await recall.prepareStep("agent-1", messages);
  assert.equal(recall.takeBlock("agent-1"), "");
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
  const recall = createMemoryRecall(ctx, client, { ...RECALL_CONFIG, agentSpaces: false });

  const oldestMessages = userMessages(["query 0"]);
  await recall.prepareStep("agent-1", oldestMessages);
  assert.equal(searches, 1);

  // 16 further distinct queries fill the 16-entry per-agent cache.
  for (let i = 1; i <= 16; i += 1) {
    await recall.prepareStep("agent-1", userMessages([`query ${i}`], i));
  }
  assert.equal(searches, 17);

  // The oldest entry was evicted (FIFO): the identical oldest query
  // re-searches from a new message.
  await recall.prepareStep("agent-1", userMessages(["query 0"], 100));
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
  const recall = createMemoryRecall(ctx, client, { ...RECALL_CONFIG, agentSpaces: false });
  const messages = userMessages(["the same question"]);
  await recall.prepareStep("agent-1", messages);
  assert.equal(searches, 1);

  // Within the TTL the same message's later steps neither re-search nor
  // re-inject (the first step's block already rides in the history).
  await recall.prepareStep("agent-1", messages);
  assert.equal(searches, 1);
  assert.equal(recall.takeBlock("agent-1"), "");

  // Past the TTL a NEW message with the same question re-searches: the
  // expired cache entry is replaced and the fresh block is injected.
  t.mock.timers.tick(5 * 60 * 1000 + 1);
  await recall.prepareStep("agent-1", userMessages(["the same question"], 100));
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

test("recall expands cached memory branches when the global search returns only empty overviews", async () => {
  const { client, calls } = stubClient();
  client.find = (opts) => {
    calls.push({ name: "find", opts });
    if (opts.targetUri === "viking://user/memories/") {
      return Promise.resolve({
        memories: [
          { uri: "viking://user/dsh/memories/entities/.overview.md", level: 1, score: 0.9, abstract: "" },
        ],
        resources: [],
        skills: [],
        total: 1,
      });
    }
    if (opts.targetUri === "viking://user/memories/entities/方法论/") {
      return Promise.resolve({
        memories: [
          {
            uri: "viking://user/dsh/memories/entities/方法论/偶发缺页处置经验.md",
            level: 2,
            score: 0.84,
            abstract: "先冻结写入并记录水位，再交叉核对证据平面，在影子空间回放验证。",
          },
        ],
        resources: [],
        skills: [],
        total: 1,
      });
    }
    return Promise.resolve({ memories: [], resources: [], skills: [], total: 0 });
  };
  client.tree = (opts) => {
    calls.push({ name: "tree", opts });
    return Promise.resolve([
      { uri: "viking://user/memories/entities", isDir: true },
      { uri: "viking://user/memories/entities/方法论", isDir: true },
      { uri: "viking://user/memories/entities/方法论/偶发缺页处置经验.md", isDir: false },
    ]);
  };
  const ctx = stubCtx();
  const recall = createMemoryRecall(ctx, client, RECALL_CONFIG);

  await recall.prepareStep("agent-1", userMessages(["账单附件缺失，如何保全现场、补偿并验证恢复？"]));
  const block = recall.takeBlock("agent-1");

  assert.match(block, /偶发缺页处置经验\.md/);
  assert.match(block, /冻结写入并记录水位/);
  assert.ok(!block.includes("entities/.overview.md"), "empty overview nodes are not injected");
  assert.equal(calls.filter((call) => call.name === "tree").length, 1, "branch discovery runs once");
  assert.ok(
    calls.some(
      (call) => call.name === "find" && call.opts.targetUri === "viking://user/memories/entities/方法论/",
    ),
    "the discovered methodology branch is searched",
  );
});

test("recall treats deeper search leaves as leaves and renders overview content", async () => {
  const { recall } = recallWith(
    {
      memories: [
        {
          uri: "viking://user/dsh/memories/entities/methods/nested/playbook.md",
          level: 3,
          score: 0.2,
          overview: "nested recovery playbook",
        },
      ],
      resources: [],
      skills: [],
      total: 1,
    },
    { agentSpaces: false },
  );

  await recall.prepareStep("agent-1", userMessages(["recovery playbook"]));
  const block = recall.takeBlock("agent-1");
  assert.match(block, /nested recovery playbook/);
  assert.match(block, /nested\/playbook\.md/);
});

test("recall does not let an agent-space leaf suppress user branch fallback", async () => {
  const { client, calls } = stubClient();
  client.find = (opts) => {
    calls.push({ name: "find", opts });
    if (opts.targetUri === "viking://user/memories/") {
      return Promise.resolve({
        memories: [{ uri: "viking://user/memories/entities/.overview.md", level: 1, score: 0.9, abstract: "" }],
        resources: [], skills: [], total: 1,
      });
    }
    if (opts.targetUri === "viking://agent/") {
      return Promise.resolve({
        memories: [{ uri: "viking://agent/cases/unrelated.md", level: 2, score: 0.9, abstract: "unrelated agent case" }],
        resources: [], skills: [], total: 1,
      });
    }
    if (opts.targetUri === "viking://user/memories/entities/方法论/") {
      return Promise.resolve({
        memories: [{ uri: "viking://user/memories/entities/方法论/playbook.md", level: 2, score: 0.8, abstract: "user methodology leaf" }],
        resources: [], skills: [], total: 1,
      });
    }
    return Promise.resolve({ memories: [], resources: [], skills: [], total: 0 });
  };
  client.tree = (opts) => {
    calls.push({ name: "tree", opts });
    return Promise.resolve([
      { uri: "viking://user/memories/entities/方法论", isDir: true },
      { uri: "viking://user/memories/entities/方法论/playbook.md", isDir: false },
    ]);
  };
  const recall = createMemoryRecall(stubCtx(), client, RECALL_CONFIG);
  await recall.prepareStep("agent-1", userMessages(["recover missing attachments safely"]));
  const block = recall.takeBlock("agent-1");
  assert.match(block, /user methodology leaf/);
  assert.ok(calls.some((call) => call.name === "tree"));
});

test("recall expands branches when global leaves are only below-threshold noise", async () => {
  const { client, calls } = stubClient();
  client.find = (opts) => {
    calls.push({ name: "find", opts });
    if (opts.targetUri === "viking://user/memories/") {
      return Promise.resolve({
        memories: [
          { uri: "viking://user/memories/.overview.md", level: 1, score: 0.9, abstract: "" },
          { uri: "viking://user/memories/events/unrelated.md", level: 2, score: 0.01, abstract: "unrelated noise" },
        ],
        resources: [], skills: [], total: 2,
      });
    }
    if (opts.targetUri === "viking://user/memories/entities/方法论/") {
      return Promise.resolve({
        memories: [{ uri: "viking://user/memories/entities/方法论/playbook.md", level: 2, score: 0.8, abstract: "freeze evidence before recovery" }],
        resources: [], skills: [], total: 1,
      });
    }
    return Promise.resolve({ memories: [], resources: [], skills: [], total: 0 });
  };
  client.tree = (opts) => {
    calls.push({ name: "tree", opts });
    return Promise.resolve([
      { uri: "viking://user/memories/entities/方法论", isDir: true },
      { uri: "viking://user/memories/entities/方法论/playbook.md", isDir: false },
    ]);
  };
  const recall = createMemoryRecall(stubCtx(), client, RECALL_CONFIG);
  await recall.prepareStep("agent-1", userMessages(["recover missing attachments safely"]));
  const block = recall.takeBlock("agent-1");
  assert.match(block, /playbook\.md/);
  assert.ok(!block.includes("unrelated noise"));
  assert.ok(calls.some((call) => call.name === "tree"));
});

test("recall bounds branch fallback searches and reuses the tree cache", async () => {
  const { client, calls } = stubClient();
  client.find = (opts) => {
    calls.push({ name: "find", opts });
    return Promise.resolve({
      memories: [{ uri: "viking://user/memories/.overview.md", level: 1, score: 0.9, abstract: "" }],
      resources: [],
      skills: [],
      total: 1,
    });
  };
  client.tree = (opts) => {
    calls.push({ name: "tree", opts });
    return Promise.resolve(
      Array.from({ length: 24 }, (_, index) => [
        { uri: `viking://user/memories/entities/category-${index}`, isDir: true },
        { uri: `viking://user/memories/entities/category-${index}/memory.md`, isDir: false },
      ]).flat(),
    );
  };
  const ctx = stubCtx();
  const recall = createMemoryRecall(ctx, client, { ...RECALL_CONFIG, agentSpaces: false });

  await recall.prepareStep("agent-1", userMessages(["first unmatched query"]));
  await recall.prepareStep("agent-1", userMessages(["second unmatched query"], 10));

  assert.equal(calls.filter((call) => call.name === "tree").length, 1, "tree is reused across queries");
  const branchCalls = calls.filter(
    (call) => call.name === "find" && call.opts.targetUri !== "viking://user/memories/",
  );
  assert.equal(branchCalls.length, 32, "at most 16 branches are searched per query");
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


test("recall searches both user and agent spaces and merges their hits", async () => {
  const { client, calls } = stubClient();
  client.find = (opts) => {
    calls.push({ name: "find", opts });
    if (opts.targetUri === "viking://user/memories/") {
      return Promise.resolve({
        memories: [{ uri: "viking://user/memories/prefs.md", score: 0.9, abstract: "prefers coffee" }],
        resources: [],
        skills: [],
        total: 1,
      });
    }
    return Promise.resolve({
      memories: [{ uri: "viking://agent/abc/memories/cases/x.md", score: 0.8, abstract: "fixed the timeout" }],
      resources: [],
      skills: [{ uri: "viking://agent/skills/deep-dive", score: 0.7, abstract: "deep search playbook" }],
      total: 2,
    });
  };
  const ctx = stubCtx();
  const recall = createMemoryRecall(ctx, client, RECALL_CONFIG);
  await recall.prepareStep("agent-1", userMessages(["how did we fix the timeout?"]));
  const block = recall.takeBlock("agent-1");

  // Two space searches, correct prefixes.
  const uris = calls.map((c) => c.opts.targetUri);
  assert.deepEqual(uris.sort(), ["viking://agent/", "viking://user/memories/"]);
  // Hits from both spaces enter the injected block.
  assert.match(block, /viking:\/\/user\/memories\/prefs.md/);
  assert.match(block, /viking:\/\/agent\/abc\/memories\/cases\/x.md/);
  assert.match(block, /viking:\/\/agent\/skills\/deep-dive/);
});

test("recall agentSpaces=false restricts the search to user memories only", async () => {
  const { recall, calls } = recallWith(
    { memories: [{ uri: "viking://user/memories/1", score: 0.9 }], resources: [], skills: [], total: 1 },
    { agentSpaces: false },
  );
  await recall.prepareStep("agent-1", userMessages(["question?"]));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.targetUri, "viking://user/memories/");
});

test("recall tolerates one failed space and still injects the other", async () => {
  const { client, calls } = stubClient();
  client.find = (opts) => {
    calls.push({ name: "find", opts });
    if (opts.targetUri === "viking://user/memories/") {
      return Promise.reject(new Error("user space down"));
    }
    return Promise.resolve({
      memories: [{ uri: "viking://agent/abc/memories/patterns/p.md", score: 0.85, abstract: "pattern works" }],
      resources: [],
      skills: [],
      total: 1,
    });
  };
  const ctx = stubCtx();
  const recall = createMemoryRecall(ctx, client, RECALL_CONFIG);
  await recall.prepareStep("agent-1", userMessages(["what pattern did we use?"]));
  const block = recall.takeBlock("agent-1");
  assert.match(block, /patterns\/p.md/);
  assert.equal(ctx.warnings.length, 1, "one deduplicated warning for the failed space");
});

test("recall with all spaces failing leaves the slot empty", async () => {
  const { client, calls } = stubClient();
  client.find = (opts) => {
    calls.push({ name: "find", opts });
    return Promise.reject(new Error("total outage"));
  };
  const ctx = stubCtx();
  const recall = createMemoryRecall(ctx, client, RECALL_CONFIG);
  await recall.prepareStep("agent-1", userMessages(["hello there"]));
  assert.equal(recall.takeBlock("agent-1"), "");
  assert.equal(calls.length, 2, "both spaces attempted");
});


test("recall throttled refresh: same message re-searches every refreshSteps and injects only new memories", async () => {
  const { client, calls } = stubClient();
  let userSearches = 0;
  client.find = (opts) => {
    calls.push({ name: "find", opts });
    if (opts.targetUri === "viking://user/memories/") {
      userSearches += 1;
      return Promise.resolve(
        userSearches === 1
          ? { memories: [{ uri: "viking://user/memories/a.md", score: 0.9, abstract: "first memory" }], resources: [], skills: [], total: 1 }
          : {
              memories: [
                { uri: "viking://user/memories/a.md", score: 0.9, abstract: "first memory" },
                { uri: "viking://user/memories/b.md", score: 0.85, abstract: "freshly learned memory" },
              ],
              resources: [], skills: [], total: 2,
            },
      );
    }
    return Promise.resolve({ memories: [], resources: [], skills: [], total: 0 });
  };
  const ctx = stubCtx();
  const recall = createMemoryRecall(ctx, client, { ...RECALL_CONFIG, refreshSteps: 3 });
  const messages = userMessages(["build the plugin"]);
  await recall.prepareStep("agent-1", messages);
  const first = recall.takeBlock("agent-1");
  assert.match(first, /memories\/a.md/);
  assert.ok(!first.includes("memories\/b.md"), "b.md not known yet");
  assert.equal(calls.length, 2, "one dual-space search");

  // Steps 1-2 of the same message: no re-search, no re-injection.
  await recall.prepareStep("agent-1", messages);
  assert.equal(recall.takeBlock("agent-1"), "");
  await recall.prepareStep("agent-1", messages);
  assert.equal(recall.takeBlock("agent-1"), "");
  assert.equal(calls.length, 2);

  // Step 3 hits refreshSteps: re-search; only the NEW memory is injected.
  await recall.prepareStep("agent-1", messages);
  const incremental = recall.takeBlock("agent-1");
  assert.match(incremental, /memories\/b.md/);
  assert.ok(!incremental.includes("memories\/a.md"), "already-seen memories are not re-injected");
  assert.equal(calls.length, 4, "refresh re-searches both spaces");
});

test("recall throttled refresh injects nothing when no new memories appear", async () => {
  const { client, calls } = stubClient();
  client.find = (opts) => {
    calls.push({ name: "find", opts });
    if (opts.targetUri === "viking://user/memories/") {
      return Promise.resolve({ memories: [{ uri: "viking://user/memories/a.md", score: 0.9, abstract: "only memory" }], resources: [], skills: [], total: 1 });
    }
    return Promise.resolve({ memories: [], resources: [], skills: [], total: 0 });
  };
  const ctx = stubCtx();
  const recall = createMemoryRecall(ctx, client, { ...RECALL_CONFIG, refreshSteps: 2 });
  const messages = userMessages(["work on it"]);
  await recall.prepareStep("agent-1", messages);
  assert.match(recall.takeBlock("agent-1"), /memories\/a.md/);
  await recall.prepareStep("agent-1", messages);
  assert.equal(recall.takeBlock("agent-1"), "");
  // Refresh step: re-searches but finds nothing new → 0 tokens injected.
  await recall.prepareStep("agent-1", messages);
  assert.equal(recall.takeBlock("agent-1"), "");
  assert.equal(calls.length, 4, "refresh still searched both spaces");
});

test("recall refreshSteps=0 disables mid-message refresh entirely", async () => {
  const { client, calls } = stubClient();
  client.find = (opts) => {
    calls.push({ name: "find", opts });
    if (opts.targetUri === "viking://user/memories/") {
      return Promise.resolve({ memories: [{ uri: "viking://user/memories/a.md", score: 0.9, abstract: "only memory" }], resources: [], skills: [], total: 1 });
    }
    return Promise.resolve({ memories: [], resources: [], skills: [], total: 0 });
  };
  const ctx = stubCtx();
  const recall = createMemoryRecall(ctx, client, { ...RECALL_CONFIG, refreshSteps: 0 });
  const messages = userMessages(["stay quiet"]);
  await recall.prepareStep("agent-1", messages);
  for (let i = 0; i < 20; i += 1) {
    await recall.prepareStep("agent-1", messages);
  }
  assert.equal(recall.takeBlock("agent-1"), "");
  assert.equal(calls.length, 2, "exactly one dual-space search for the whole message");
});

test("recall throttled refresh never overwrites the full query cache with a partial block", async () => {
  let userSearches = 0;
  const { client, calls } = stubClient();
  client.find = (opts) => {
    calls.push({ name: "find", opts });
    if (opts.targetUri === "viking://user/memories/") {
      userSearches += 1;
      if (userSearches === 1) {
        // First search: only a.md exists.
        return Promise.resolve({ memories: [{ uri: "viking://user/memories/a.md", score: 0.9, abstract: "first memory" }], resources: [], skills: [], total: 1 });
      }
      // Refresh search: b.md was learned mid-message.
      return Promise.resolve({
        memories: [
          { uri: "viking://user/memories/a.md", score: 0.9, abstract: "first memory" },
          { uri: "viking://user/memories/b.md", score: 0.85, abstract: "freshly learned memory" },
        ],
        resources: [], skills: [], total: 2,
      });
    }
    return Promise.resolve({ memories: [], resources: [], skills: [], total: 0 });
  };
  const ctx = stubCtx();
  const recall = createMemoryRecall(ctx, client, { ...RECALL_CONFIG, refreshSteps: 3 });
  const messages = userMessages(["build the plugin"]);
  await recall.prepareStep("agent-1", messages);
  assert.match(recall.takeBlock("agent-1"), /memories\/a.md/);

  // Step 3 hits refreshSteps: the incremental block contains ONLY b.md.
  await recall.prepareStep("agent-1", messages);
  await recall.prepareStep("agent-1", messages);
  await recall.prepareStep("agent-1", messages);
  const incremental = recall.takeBlock("agent-1");
  assert.match(incremental, /memories\/b.md/);
  assert.ok(!incremental.includes("memories\/a.md"), "incremental block carries only new memories");

  // A NEW message with the same text must hit the cache and receive the full
  // FIRST-search block (a.md, complete at the time it was cached) — the
  // partial incremental block (b.md only) must never have overwritten it.
  await recall.prepareStep("agent-1", userMessages(["build the plugin"], 100));
  const cached = recall.takeBlock("agent-1");
  assert.match(cached, /memories\/a.md/, "cached block is the full first search");
  assert.ok(!cached.includes("memories\/b.md"), "cache was not overwritten by the incremental b.md-only block");
  const userFindCalls = calls.filter((c) => c.opts.targetUri === "viking://user/memories/");
  assert.equal(userFindCalls.length, 2, "the new message hits the cache: no third search");
});

test("recall cache hits record injected URIs so a later refresh does not re-inject them", async () => {
  let userSearches = 0;
  const { client, calls } = stubClient();
  client.find = (opts) => {
    calls.push({ name: "find", opts });
    if (opts.targetUri === "viking://user/memories/") {
      userSearches += 1;
      if (userSearches === 1) {
        return Promise.resolve({ memories: [{ uri: "viking://user/memories/a.md", score: 0.9, abstract: "first memory" }], resources: [], skills: [], total: 1 });
      }
      return Promise.resolve({
        memories: [
          { uri: "viking://user/memories/a.md", score: 0.9, abstract: "first memory" },
          { uri: "viking://user/memories/b.md", score: 0.85, abstract: "freshly learned memory" },
        ],
        resources: [], skills: [], total: 2,
      });
    }
    return Promise.resolve({ memories: [], resources: [], skills: [], total: 0 });
  };
  const ctx = stubCtx();
  const recall = createMemoryRecall(ctx, client, { ...RECALL_CONFIG, refreshSteps: 3 });

  // Turn 1: direct search caches the full block (a.md).
  await recall.prepareStep("agent-1", userMessages(["same question"]));
  assert.match(recall.takeBlock("agent-1"), /memories\/a.md/);
  assert.equal(userSearches, 1);

  // Turn 2: NEW message, same text → cache hit, no search. The cached block's
  // URI must be recorded as injected for this message.
  const messages = userMessages(["same question"], 100);
  await recall.prepareStep("agent-1", messages);
  assert.match(recall.takeBlock("agent-1"), /memories\/a.md/);
  assert.equal(userSearches, 1, "cache hit performs no search");

  // Same message reaches refreshSteps: the refresh search returns a.md + b.md,
  // but only b.md may be injected — a.md came in through the cache hit and is
  // already in this message's injected set.
  await recall.prepareStep("agent-1", messages);
  await recall.prepareStep("agent-1", messages);
  await recall.prepareStep("agent-1", messages);
  const incremental = recall.takeBlock("agent-1");
  assert.match(incremental, /memories\/b.md/);
  assert.ok(!incremental.includes("memories\/a.md"), "cache-injected a.md is not re-injected on refresh");
  const userFindCalls = calls.filter((c) => c.opts.targetUri === "viking://user/memories/");
  assert.equal(userFindCalls.length, 2, "turn 2 cache hit + one refresh search");
});


test("procedure recall reserves a playbook slot without changing entity recall", async () => {
  const { client, calls, recall } = recallWith({ memories: [], resources: [], skills: [], total: 0 });
  client.tree = async () => [
    { uri: "viking://user/memories/entities/方法论/integrity-gap", isDir: false },
    { uri: "viking://user/memories/entities/project-owner", isDir: false },
  ];
  client.find = async (opts) => {
    calls.push({ name: "find", opts });
    if (opts.targetUri === "viking://user/memories/entities/方法论/") {
      return { memories: [{ uri: "viking://user/memories/entities/方法论/integrity-gap", level: 2, score: 0.3, abstract: "recover missing billing attachments after accepted sends" }] };
    }
    return { memories: [{ uri: "viking://user/memories/events/unrelated", level: 2, score: 0.98, abstract: "unrelated event" }] };
  };
  await recall.prepareStep("procedure", userMessages(["How do I recover missing billing attachments after an accepted send?"]));
  const block = recall.takeBlock("procedure");
  assert.match(block, /integrity-gap/);
  assert.ok(calls.some((call) => call.opts.targetUri === "viking://user/memories/entities/方法论/"));

  const ordinary = recallWith({ memories: [{ uri: "viking://user/memories/entities/owner", level: 2, score: 0.9, abstract: "owner is Ada" }], resources: [], skills: [], total: 1 });
  await ordinary.recall.prepareStep("entity", userMessages(["Who owns project Atlas?"]));
  assert.equal(ordinary.calls.some((call) => call.name === "tree"), false);
});

test("procedure branch failures fall back to global candidates", async () => {
  const { client, recall } = recallWith({ memories: [{ uri: "viking://user/memories/events/recovery", level: 2, score: 0.9, abstract: "global recovery note" }], resources: [], skills: [], total: 1 });
  client.tree = async () => [{ uri: "viking://user/memories/playbook/failing", isDir: false }];
  client.find = async (opts) => {
    if (opts.targetUri === "viking://user/memories/playbook/") throw new Error("branch unavailable");
    return { memories: [{ uri: "viking://user/memories/events/recovery", level: 2, score: 0.9, abstract: "global recovery note" }] };
  };
  await recall.prepareStep("fallback", userMessages(["What recovery workflow should I follow?"]));
  assert.match(recall.takeBlock("fallback"), /global recovery note/);
});

// ─── session-start memory map ──────────────────────────────────────────

test("recall memory map: session start injects once, then refreshes every N user turns", async () => {
  const { client, calls } = stubClient();
  let statsCalls = 0;
  client.memoryStats = async () => {
    statsCalls += 1;
    return { total_memories: 29, by_category: { entities: 10, events: 13, patterns: 1, tools: 1, skills: 4 } };
  };
  const ctx = stubCtx();
  const recall = createMemoryRecall(ctx, client, { ...RECALL_CONFIG, startupMapEveryTurns: 3 });
  const messages = userMessages(["q"]);

  // Turn 1 (session start): map injected. The build is async, so give the
  // microtask queue a beat before consuming.
  await recall.prepareStep("agent-1", messages);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(recall.takeStartupBlock("agent-1"), /<memory-library>/);
  // Consume-on-read: a second read in the same turn is empty — the map is
  // never injected more than once per build.
  assert.equal(recall.takeStartupBlock("agent-1"), "");

  // Turn 2: not a map turn; the previous map must not leak.
  await recall.prepareStep("agent-1", userMessages(["q2"], 1));
  assert.equal(recall.takeStartupBlock("agent-1"), "");

  // Turn 3: still not a map turn (cadence 3 → turns 1, 4, 7, ...).
  await recall.prepareStep("agent-1", userMessages(["q3"], 2));
  assert.equal(recall.takeStartupBlock("agent-1"), "");

  // Turn 4: cadence reached, map refreshed.
  await recall.prepareStep("agent-1", userMessages(["q4"], 3));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(recall.takeStartupBlock("agent-1"), /<memory-library>/);
  assert.equal(statsCalls, 2, "stats fetched on injection turns only");
});

test("recall memory map cadence 1 = session-start only, 0 = never", async () => {
  const { client } = stubClient();
  let statsCalls = 0;
  client.memoryStats = async () => {
    statsCalls += 1;
    return { total_memories: 29, by_category: { events: 13 } };
  };
  const ctx = stubCtx();
  const recall = createMemoryRecall(ctx, client, { ...RECALL_CONFIG, startupMapEveryTurns: 1 });
  await recall.prepareStep("agent-1", userMessages(["first"]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(recall.takeStartupBlock("agent-1"), /<memory-library>/);
  await recall.prepareStep("agent-1", userMessages(["second"], 1));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(recall.takeStartupBlock("agent-1"), "", "cadence 1 never refreshes after session start");
  assert.equal(statsCalls, 1);

  const { client: quiet } = stubClient();
  quiet.memoryStats = async () => ({ total_memories: 29, by_category: { events: 13 } });
  const off = createMemoryRecall(ctx, quiet, { ...RECALL_CONFIG, startupMapEveryTurns: 0 });
  await off.prepareStep("agent-1", userMessages(["first"]));
  assert.equal(off.takeStartupBlock("agent-1"), "");
});

test("recall memory map stays empty for an empty library or on failure", async () => {
  const { client } = stubClient();
  client.memoryStats = async () => ({ total_memories: 0, by_category: {} });
  client.find = () => Promise.resolve({ memories: [], resources: [], skills: [], total: 0 });
  const ctx = stubCtx();
  const recall = createMemoryRecall(ctx, client, RECALL_CONFIG);
  await recall.prepareStep("agent-1", userMessages(["hello"]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(recall.takeStartupBlock("agent-1"), "");

  const { client: failing } = stubClient();
  failing.memoryStats = async () => { throw new Error("stats down"); };
  failing.find = () => Promise.resolve({ memories: [], resources: [], skills: [], total: 0 });
  const failingRecall = createMemoryRecall(ctx, failing, RECALL_CONFIG);
  await failingRecall.prepareStep("agent-2", userMessages(["hello"]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failingRecall.takeStartupBlock("agent-2"), "");
  assert.equal(ctx.warnings.length, 1, "one deduplicated warning");
});

test("recall memory map: a late async build is discarded once the turn advanced", async () => {
  // Gated stats: the build stays pending until the test resolves the gate.
  let resolveStats;
  const statsGate = new Promise((resolve) => { resolveStats = resolve; });
  const { client } = stubClient();
  client.memoryStats = () => statsGate;
  const ctx = stubCtx();
  const recall = createMemoryRecall(ctx, client, { ...RECALL_CONFIG, startupMapEveryTurns: 1 });

  // Turn 1 triggers the build; the turn advances BEFORE the build completes.
  await recall.prepareStep("agent-1", userMessages(["first"]));
  await recall.prepareStep("agent-1", userMessages(["second"], 1));
  resolveStats({ total_memories: 29, by_category: { events: 13 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(recall.takeStartupBlock("agent-1"), "", "stale map is discarded after the turn advanced");

  // Control: when the turn does NOT advance, the block lands.
  let resolveStats2;
  const statsGate2 = new Promise((resolve) => { resolveStats2 = resolve; });
  const { client: client2 } = stubClient();
  client2.memoryStats = () => statsGate2;
  const recall2 = createMemoryRecall(ctx, client2, { ...RECALL_CONFIG, startupMapEveryTurns: 1 });
  await recall2.prepareStep("agent-1", userMessages(["first"]));
  resolveStats2({ total_memories: 29, by_category: { events: 13 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(recall2.takeStartupBlock("agent-1"), /<memory-library>/, "same-turn build result lands");
});

test("recall forget releases all per-agent state so a reused agent id starts fresh", async () => {
  let searches = 0;
  let statsCalls = 0;
  const { client } = stubClient();
  client.find = () => {
    searches += 1;
    return Promise.resolve({
      memories: [{ uri: "viking://user/memories/1", score: 0.9, abstract: "persistent memory" }],
      resources: [],
      skills: [],
      total: 1,
    });
  };
  client.memoryStats = async () => {
    statsCalls += 1;
    return { total_memories: 29, by_category: { events: 13 } };
  };
  const ctx = stubCtx();
  const recall = createMemoryRecall(ctx, client, { ...RECALL_CONFIG, agentSpaces: false });

  // First turn: recall + startup map (turn 1 is a map turn for cadence 5).
  await recall.prepareStep("agent-1", userMessages(["first question"]));
  assert.match(recall.takeBlock("agent-1"), /memories\/1/);
  assert.equal(searches, 1);
  assert.equal(statsCalls, 1);

  // Same agent + query, new message, BEFORE forget → cache hit, no search,
  // and turn 2 is not a map turn.
  await recall.prepareStep("agent-1", userMessages(["first question"], 1));
  assert.equal(searches, 1, "same agent+query caches before forget");
  assert.match(recall.takeBlock("agent-1"), /memories\/1/);

  // forget wipes every per-agent structure.
  recall.forget("agent-1");

  // Same agent + query after forget: full re-search (cache cleared), the
  // message state is gone (new message id is treated as a brand-new turn, so
  // the startup map builds again), and the block is delivered.
  await recall.prepareStep("agent-1", userMessages(["first question"], 2));
  assert.equal(searches, 2, "forget clears the recall cache, forcing a re-search");
  assert.match(recall.takeBlock("agent-1"), /memories\/1/);
  assert.equal(statsCalls, 2, "forget clears the turn counter: next turn is a map turn again");

  // Forgetting an unknown agent is a harmless no-op.
  recall.forget("ghost-agent");
  await recall.prepareStep("agent-1", userMessages(["first question"], 3));
  assert.match(recall.takeBlock("agent-1"), /memories\/1/);
});


test("recall ignores plugin-sourced context injections when finding the latest user message", async () => {
  let searches = 0;
  const { client } = stubClient();
  client.find = () => {
    searches += 1;
    return Promise.resolve({ memories: [], resources: [], skills: [], total: 0 });
  };
  const ctx = stubCtx();
  const recall = createMemoryRecall(ctx, client, { ...RECALL_CONFIG, agentSpaces: false });

  // Real user turn.
  const real = [{ role: "user", id: "real-1", content: [{ type: "text", text: "帮我查一下" }], source: { kind: "user" } }];
  await recall.prepareStep("agent-1", real);
  assert.equal(searches, 1);

  // Later steps carry plugin context snapshots (runtime context, recall
  // blocks) as user-role messages with source.kind "plugin". These must NOT
  // be treated as new user turns.
  const pluginSnapshot = [
    ...real,
    { role: "user", id: "inject-1", content: [{ type: "text", text: "Current runtime context. snapshot…" }], source: { kind: "plugin", plugin: "runtime" } },
  ];
  await recall.prepareStep("agent-1", pluginSnapshot);
  assert.equal(searches, 1, "plugin injection is not a new user turn");

  const withRecallBlock = [
    ...pluginSnapshot,
    { role: "user", id: "inject-2", content: [{ type: "text", text: "<relevant-memories>…</relevant-memories>" }], source: { kind: "plugin", plugin: "dsh-openviking" } },
  ];
  await recall.prepareStep("agent-1", withRecallBlock);
  assert.equal(searches, 1, "plugin recall block is not a new user turn");

  // A genuinely new real user message still triggers a fresh search.
  const nextTurn = [{ role: "user", id: "real-2", content: [{ type: "text", text: "继续" }], source: { kind: "user" } }];
  await recall.prepareStep("agent-1", nextTurn);
  assert.equal(searches, 2, "new real user message searches again");
});
