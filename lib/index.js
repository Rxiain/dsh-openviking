/**
 * dsh-openviking: OpenViking retrieval, resource management, auto-recall and
 * session memory for DeepSeek Harness.
 *
 * The plugin talks to an existing OpenViking HTTP service (never `ov` CLI, never
 * an embedded server), registers ten structured tools, injects the indexed
 * repository list and relevant memories during normal conversation, mirrors
 * user/assistant text into an OpenViking session and auto-commits it.
 */
import z from "@deepseek-ai/schemastery";
import { OpenVikingClient } from "./client.js";
import { createMemoryRecall } from "./memory-recall.js";
import { createRepoContext } from "./repo-context.js";
import { SessionManager } from "./session-sync.js";
import { registerOpenVikingTools } from "./tools.js";
/** Cordis plugin name used by loader diagnostics. */
export const name = "openviking";
/** Services required by this plugin. `agents` guarantees the registry is ready and lets us adopt live agents. */
export const inject = ["tools", "fs", "systemPrompt", "agents"];
// Schemastery types `default(value: T)` with the complete object type, but
// accepts partial defaults at runtime (inner field defaults fill the rest).
// Each nested shape is cast to its named config interface at this one boundary.
const repoContextShape = z.object({
    enabled: z.boolean().default(true),
    cacheTtlMs: z.number().min(1000).max(3600000).default(60000),
});
const autoRecallShape = z.object({
    enabled: z.boolean().default(true),
    limit: z.natural().min(1).max(50).default(6),
    scoreThreshold: z.number().min(0).max(1).default(0.15),
    maxContentChars: z.natural().min(100).max(5000).default(500),
    tokenBudget: z.natural().min(100).max(10000).default(2000),
});
const autoCommitShape = z.object({
    enabled: z.boolean().default(true),
    intervalMinutes: z.natural().min(1).default(10),
});
export const Config = z.object({
    endpoint: z.string().default("http://localhost:1933"),
    apiKey: z.string().default(""),
    account: z.string().default(""),
    user: z.string().default(""),
    agentId: z.string().default("deepseek-harness"),
    timeoutMs: z.number().min(1000).max(300000).default(30000),
    stateFile: z.string().default("~/.dsh/openviking/state.json"),
    repoContext: repoContextShape.default({}),
    autoRecall: autoRecallShape.default({}),
    autoCommit: autoCommitShape.default({}),
});
/**
 * Reject an invalid endpoint at load time: it must be a non-empty absolute
 * http(s) URL. Throws a clear error before the client is constructed so a
 * misconfigured profile fails fast instead of misbehaving at runtime.
 */
function assertValidEndpoint(endpoint) {
    let url;
    try {
        url = new URL(endpoint);
    }
    catch {
        throw new Error(`openviking: invalid endpoint "${endpoint}": must be a non-empty absolute http(s) URL`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`openviking: invalid endpoint "${endpoint}": must be an absolute http(s) URL`);
    }
}
/**
 * Mount the plugin. The service may be unreachable: the plugin still loads,
 * normal conversation continues, and automatic layers skip with deduplicated
 * warnings while explicit tool calls throw clear errors.
 */
export function apply(ctx, config) {
    assertValidEndpoint(config.endpoint);
    const client = new OpenVikingClient({
        endpoint: config.endpoint,
        apiKey: config.apiKey,
        account: config.account,
        user: config.user,
        agentId: config.agentId,
        timeoutMs: config.timeoutMs,
    });
    const logger = ctx.logger("openviking");
    const sessionManager = new SessionManager(ctx, client, {
        endpoint: config.endpoint,
        apiKey: config.apiKey,
        account: config.account,
        user: config.user,
        agentId: config.agentId,
        timeoutMs: config.timeoutMs,
        stateFile: config.stateFile,
        autoCommit: config.autoCommit,
    });
    const repoContext = createRepoContext(ctx, client, config.repoContext);
    const recall = createMemoryRecall(ctx, client, config.autoRecall);
    // One effect owns the manager lifecycle: init (state load + adoption +
    // auto-commit timer) and the disposer (closing, timer teardown, background
    // abort, chain drain, final state save).
    ctx.effect(async () => {
        await sessionManager.init();
        await repoContext.refresh();
        return async () => {
            await sessionManager.dispose();
        };
    }, "openviking:lifecycle");
    registerOpenVikingTools(ctx, client, sessionManager, { timeoutMs: config.timeoutMs });
    // Synchronous providers: read the per-agent slots only, never perform I/O
    // during prompt assembly. Empty text contributes nothing.
    ctx.systemPrompt.context({
        name: "openviking:repositories",
        order: 120,
        text: () => repoContext.getPrompt(),
    });
    // Auto-recall enters the model context through the context-injection
    // channel (a user-role context message, source.kind "plugin"), never as an
    // edit to the user's own message. The slot is filled by `agent/pre-step`
    // and consumed synchronously here during assembly.
    ctx.systemPrompt.context({
        name: "openviking:memories",
        order: 130,
        text: (assembly) => {
            const agent = assembly.agent;
            return agent ? recall.takeBlock(String(agent.id)) : "";
        },
    });
    ctx.on("agent/created", (payload) => {
        sessionManager.adopt(payload.agent);
    });
    ctx.on("agent/session-start", (payload) => {
        // Non-waiting notification: queue refresh and adoption without blocking.
        repoContext.refresh().catch(() => { });
        sessionManager.adopt(payload.agent);
    });
    ctx.on("agent/disposed", (payload) => {
        sessionManager.forget(payload.agent);
    });
    ctx.on("agent/pre-step", async (payload, next) => {
        const decision = await next();
        if (decision.kind !== "enter")
            return decision;
        // Refresh the repo list (await/reuse in-flight), ensure the remote
        // session exists (deep memsearch during the step), and prepare the
        // auto-recall block for the context provider. The decision messages are
        // returned unchanged — recall enters via the injection channel.
        await Promise.allSettled([
            repoContext.refresh({ signal: payload.signal }),
            sessionManager.ensureSession(payload.agent, payload.signal),
            recall.prepareStep(String(payload.agent.id), decision.messages, payload.signal),
        ]);
        return decision;
    });
    ctx.on("session/event", (session, event) => {
        if (event.type !== "user/message" && event.type !== "assistant/message")
            return;
        const agent = sessionManager.agentById(String(session.id));
        if (!agent)
            return;
        sessionManager.queueDrain(agent);
    });
    logger.info("openviking plugin mounted", { endpoint: client.endpoint, stateFile: config.stateFile });
}
