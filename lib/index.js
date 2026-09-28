/**
 * dsh-openviking: OpenViking retrieval, resource management, auto-recall and
 * session memory for DeepSeek Harness.
 *
 * The plugin talks to an existing OpenViking HTTP service (never `ov` CLI, never
 * an embedded server), registers the structured tools, injects the indexed
 * repository list and user/assistant text into an OpenViking session, and
 * auto-commits it.
 *
 * Configuration is exposed through the user-settings seam (`ctx.settings`,
 * namespace `openviking`): the dsh web UI's Plugins → Plugin configuration
 * page edits the same schema this file validates, layered over the profile's
 * composed entry config. Request-facing fields (endpoint, headers, timeouts)
 * apply live; the session state file is read at boot.
 */
import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm/message";
import { OpenVikingClient } from "./client.js";
import { registerOpenVikingCommands } from "./commands.js";
import { createLearnService } from "./learn-service.js";
import { createMemoryRecall } from "./memory-recall.js";
import { createRepoContext } from "./repo-context.js";
import { SessionManager } from "./session-sync.js";
import { registerOpenVikingTools } from "./tools.js";
/** Cordis plugin name used by loader diagnostics. */
export const name = "openviking";
/** Services required by this plugin. `agents` guarantees the registry is ready and lets us adopt live agents. */
export const inject = ["tools", "fs", "systemPrompt", "agents"];
/** User-settings namespace carrying this plugin's configuration. */
export const SETTINGS_NAMESPACE = "openviking";
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
    agentSpaces: z.boolean().default(true),
    refreshSteps: z.natural().min(0).max(100).default(10),
    startupMapEveryTurns: z.natural().min(0).max(100).default(5),
});
const autoCommitShape = z.object({
    enabled: z.boolean().default(true),
    turns: z.natural().min(0).max(100).default(3),
    intervalMinutes: z.natural().min(1).default(10),
});
export const Config = z.object({
    endpoint: z.string().pattern(/^https?:\/\//).default("http://localhost:1933").volatile(),
    apiKey: z.string().default("").volatile(),
    account: z.string().default("").volatile(),
    user: z.string().default("").volatile(),
    agentId: z.string().default("deepseek-harness").volatile(),
    timeoutMs: z.number().min(1000).max(300000).default(30000).volatile(),
    stateFile: z.string().default("~/.dsh/openviking/state.json"),
    repoContext: repoContextShape.default({}).volatile(),
    autoRecall: autoRecallShape.default({}).volatile(),
    autoCommit: autoCommitShape.default({}).volatile(),
});
/**
 * Read a schemastery volatile reference to its current value, or pass a plain
 * value through. `.volatile()` marks a config field as live-editable: the
 * resolved config carries a stable reference whose `.get()` returns the
 * current value (and `cosmokit.updateVolatile` swaps it in place on a write).
 * This unwrap reads through so callers always see today's value.
 */
function unwrapVolatile(value) {
    if (value !== null &&
        typeof value === "object" &&
        typeof value.get === "function") {
        return value.get();
    }
    return value;
}
/** Resolve every volatile field of the config to its current plain value. */
function unwrapConfig(config) {
    return {
        ...config,
        endpoint: unwrapVolatile(config.endpoint),
        apiKey: unwrapVolatile(config.apiKey),
        account: unwrapVolatile(config.account),
        user: unwrapVolatile(config.user),
        agentId: unwrapVolatile(config.agentId),
        timeoutMs: unwrapVolatile(config.timeoutMs),
        repoContext: unwrapVolatile(config.repoContext),
        autoRecall: unwrapVolatile(config.autoRecall),
        autoCommit: unwrapVolatile(config.autoCommit),
    };
}
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
/** Project the full plugin config onto the SessionManager's config slice. */
function sessionSyncConfigOf(config) {
    return {
        endpoint: config.endpoint,
        apiKey: config.apiKey,
        account: config.account,
        user: config.user,
        agentId: config.agentId,
        timeoutMs: config.timeoutMs,
        stateFile: config.stateFile,
        autoCommit: config.autoCommit,
    };
}
/**
 * Mount the plugin. The service may be unreachable: the plugin still loads,
 * normal conversation continues, and automatic layers skip with deduplicated
 * warnings while explicit tool calls throw clear errors.
 */
export function apply(ctx, rawConfig) {
    // Resolve volatile references to their current plain values. `.volatile()`
    // fields arrive as stable references; unwrapping at every read boundary
    // keeps `current()` and the initial client/session construction on today's
    // value even when a settings write swaps the reference in place.
    const config = unwrapConfig(rawConfig);
    assertValidEndpoint(config.endpoint);
    const logger = ctx.logger("openviking");
    // The authoritative configuration source: a lazy unwrap of the volatile
    // references (which cordis swaps in place on a settings write) or the
    // stored snapshot applied by the settings listener below. Subsystems read
    // through `current()` so a committed settings change applies live.
    let current = () => unwrapConfig(rawConfig);
    const client = new OpenVikingClient({
        endpoint: config.endpoint,
        apiKey: config.apiKey,
        account: config.account,
        user: config.user,
        agentId: config.agentId,
        timeoutMs: config.timeoutMs,
    });
    const sessionManager = new SessionManager(ctx, client, sessionSyncConfigOf(config));
    const repoContext = createRepoContext(ctx, client, () => current().repoContext);
    const recall = createMemoryRecall(ctx, client, () => current().autoRecall);
    // DSH 0.1.7+ derives the settings namespace from the registered Cordis
    // entry's exported `Config` schema automatically (it walks plugin fibers
    // on Loader start, not at apply-time). Volatile fields are declared in
    // the schema so writes do not require a plugin restart; non-volatile
    // fields (stateFile) re-read on the next start. We listen on
    // `settings/document-updated` to apply volatile updates as they land.
    ctx.on("settings/document-updated", (namespace) => {
        if (namespace !== "openviking")
            return;
        // Optional service: `settings` (SettingsForms) is not in `inject` so the
        // plugin also mounts on spines without the settings stack (unit tests,
        // minimal hosts). `ctx.get` bypasses the inject gate and yields undefined
        // when absent; the volatile refs still update via the Loader path.
        const settings = ctx.get("settings");
        const descriptor = settings
            ?.describe({ redactSecrets: true })
            .find((entry) => String(entry.ns) === "openviking");
        if (descriptor === undefined || descriptor.value === undefined)
            return;
        const stored = unwrapConfig(descriptor.value);
        current = () => stored;
        client.reconfigure({
            endpoint: stored.endpoint,
            apiKey: stored.apiKey,
            account: stored.account,
            user: stored.user,
            agentId: stored.agentId,
            timeoutMs: stored.timeoutMs,
        });
        sessionManager.reconfigure(sessionSyncConfigOf(stored));
    });
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
    registerOpenVikingTools(ctx, client, sessionManager, { timeoutMs: () => current().timeoutMs });
    // Human slash commands: registered only when the DSH command registry is
    // mounted (deferred through the nested inject when it mounts after us).
    // Model tools, session hooks, and auto-commit behavior are untouched.
    registerOpenVikingCommands(ctx, {
        client,
        learn: createLearnService(client),
        timeoutMs: () => current().timeoutMs,
    });
    // Synchronous providers: read the per-agent slots only, never perform I/O
    // during prompt assembly. Empty text contributes nothing.
    ctx.systemPrompt.context({
        name: "openviking:repositories",
        order: 120,
        text: () => repoContext.getPrompt(),
    });
    // Session-start memory map: a compact category overview injected once per
    // session (oh-my-pi's Memory Guidance), so the agent knows what the library
    // holds and how to fetch details before the first user message arrives.
    ctx.systemPrompt.context({
        name: "openviking:memories-startup",
        order: 125,
        text: (assembly) => {
            const agent = assembly.agent;
            return agent ? recall.takeStartupBlock(String(agent.id)) : "";
        },
    });
    // DSH 0.1.6+ replaced the synchronous `agent/session-start` hook with an
    // async, serial `agent/created` that fires before the first model
    // request. The first model request now waits for every creation listener
    // to settle, so this handler is async-safe — `repoContext.refresh()`
    // surfaces in the next pre-step rather than blocking the spawn path.
    ctx.on("agent/created", async (payload) => {
        sessionManager.adopt(payload.agent);
        void repoContext.refresh().catch(() => { });
    });
    ctx.on("agent/disposed", (payload) => {
        sessionManager.forget(payload.agent);
        recall.forget(String(payload.agent.id));
    });
    ctx.on("agent/pre-step", async (payload, next) => {
        const decision = await next();
        if (decision.kind !== "enter" || payload.signal.aborted)
            return decision;
        await Promise.allSettled([
            repoContext.refresh({ signal: payload.signal }),
            sessionManager.ensureSession(payload.agent, payload.signal),
            recall.prepareStep(String(payload.agent.id), decision.messages, payload.signal),
        ]);
        if (payload.signal.aborted)
            return decision;
        const block = recall.takeBlock(String(payload.agent.id));
        if (!block)
            return decision;
        return {
            kind: "enter",
            messages: [
                ...decision.messages,
                createUserMessage({
                    content: [{ type: "text", text: block }],
                    source: { kind: "dsh-openviking", plugin: "dsh-openviking" },
                }),
            ],
        };
    }, { prepend: true });
    ctx.on("session/event", (session, event) => {
        if (event.type !== "user/message" && event.type !== "assistant/message")
            return;
        const agent = sessionManager.agentById(String(session.id));
        if (!agent)
            return;
        sessionManager.queueDrain(agent);
    });
    logger.info("openviking plugin mounted", { endpoint: client.endpoint, stateFile: current().stateFile });
}
