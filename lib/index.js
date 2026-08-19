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
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { makeBridgeRoutes } from "./settings-bridge.js";
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
export const SETTINGS_NAMESPACE = settingsNamespace("openviking");
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
 * misconfigured profile fails fast instead of misbehaving at runtime. Also
 * used as the settings-section validator, so a UI save of a malformed
 * endpoint is refused by the seam instead of stored.
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
export function apply(ctx, config) {
    assertValidEndpoint(config.endpoint);
    const logger = ctx.logger("openviking");
    // The authoritative configuration source. While a settings service is
    // mounted, `installSettingsSection` points it at the resolved settings
    // scope (schema defaults → composed entry config → user document); without
    // one it stays on the composition entry, so every deployment behaves
    // exactly as composed. Subsystems read through `current()` so a committed
    // settings change can be applied live.
    let current = () => config;
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
    // Optional-settings consumer wiring: register the `openviking` namespace
    // with this entry as its base layer. No-op when no settings service is
    // mounted (tests, minimal compositions). `validate` refuses a save whose
    // resolved endpoint is not an absolute http(s) URL at the seam boundary.
    installSettingsSection(ctx, SETTINGS_NAMESPACE, Config, config, {
        setSource: (next) => {
            current = next;
        },
        onChange: () => {
            const cfg = current();
            client.reconfigure({
                endpoint: cfg.endpoint,
                apiKey: cfg.apiKey,
                account: cfg.account,
                user: cfg.user,
                agentId: cfg.agentId,
                timeoutMs: cfg.timeoutMs,
            });
            sessionManager.reconfigure(sessionSyncConfigOf(cfg));
        },
        validate: (value) => assertValidEndpoint(value.endpoint),
    });
    // Loopback settings bridge: the rc.6 host-apiproxy refuses third-party
    // namespaces at the RPC boundary, so this deployment re-serves the
    // openviking section through the host settings seam on same-origin,
    // loopback-only routes for the web card. Mounted only when a settings
    // service AND a web server are present (headless profiles never see it);
    // the browser half keeps the official settings scope as its primary
    // transport and falls back to the bridge only when the namespace is not
    // exposed.
    ctx.inject(["settings"], (sctx) => {
        const webServer = sctx.get("webServer");
        if (webServer === undefined)
            return;
        sctx.effect(() => {
            const disposers = makeBridgeRoutes({ settings: sctx.settings }).map((route) => webServer.register(route));
            return () => {
                for (const dispose of disposers)
                    dispose();
            };
        }, "openviking: settings bridge");
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
    ctx.on("agent/created", (payload) => {
        sessionManager.adopt(payload.agent);
    });
    ctx.on("agent/session-start", (payload) => {
        repoContext.refresh().catch(() => { });
        sessionManager.adopt(payload.agent);
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
                    source: { kind: "plugin", plugin: "dsh-openviking" },
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
