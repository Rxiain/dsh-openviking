/**
 * dsh-openviking: OpenViking retrieval, resource management, auto-recall and
 * session memory for DeepSeek Harness.
 *
 * The plugin talks to an existing OpenViking HTTP service (never `ov` CLI, never
 * an embedded server), registers ten structured tools, injects the indexed
 * repository list and relevant memories during normal conversation, mirrors
 * user/assistant text into an OpenViking session and auto-commits it.
 *
 * Configuration is exposed through the user-settings seam (`ctx.settings`,
 * namespace `openviking`): the dsh web UI's Plugins → Plugin configuration
 * page edits the same schema this file validates, layered over the profile's
 * composed entry config. Request-facing fields (endpoint, headers, timeouts)
 * apply live; the session state file is read at boot.
 */
import z from "@deepseek-ai/schemastery";
import type { Context } from "@deepseek-ai/cordis";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { makeBridgeRoutes } from "./settings-bridge.js";
import { OpenVikingClient } from "./client.js";
import { createMemoryRecall } from "./memory-recall.js";
import { createRepoContext } from "./repo-context.js";
import { SessionManager, type SessionSyncConfig } from "./session-sync.js";
import { registerOpenVikingTools } from "./tools.js";

/** Cordis plugin name used by loader diagnostics. */
export const name = "openviking";

/** Services required by this plugin. `agents` guarantees the registry is ready and lets us adopt live agents. */
export const inject = ["tools", "fs", "systemPrompt", "agents"];

/** User-settings namespace carrying this plugin's configuration. */
export const SETTINGS_NAMESPACE = settingsNamespace("openviking");

export interface RepoContextConfig {
  /** Inject the indexed-repository list into the system prompt. */
  enabled: boolean;
  /** TTL of the in-process repository cache in milliseconds. */
  cacheTtlMs: number;
}

export interface AutoRecallConfig {
  /** Auto-inject relevant memories before each model step. */
  enabled: boolean;
  /** Maximum memories injected per step. */
  limit: number;
  /** Minimum score for non-leaf filler memories (0–1). */
  scoreThreshold: number;
  /** Per-memory content character cap. */
  maxContentChars: number;
  /** Approximate token budget; the injected block is capped at `tokenBudget * 4` chars. */
  tokenBudget: number;
  /** Also search the agent space (`viking://agent/`) for cases/patterns/tools/skills memories and skill playbooks. */
  agentSpaces: boolean;
  /** Re-search mid-message every N tool steps and inject only new memories (0 disables). */
  refreshSteps: number;
  /** Memory map: inject on session start, refresh every N user turns (2+); 1 = start only, 0 = never. */
  startupMapEveryTurns: number;
}

export interface AutoCommitConfig {
  /** Periodically commit sessions with uncommitted messages. */
  enabled: boolean;
  /**
   * Commit after this many uncommitted USER turns (oh-my-pi style rhythm:
   * retain every N user turns instead of only wall-clock). 0 disables the
   * turn trigger and falls back to `intervalMinutes` alone.
   */
  turns: number;
  /** Wall-clock fallback: commit any session with uncommitted messages older than this. */
  intervalMinutes: number;
}

export interface Config {
  /** OpenViking HTTP service base URL. */
  endpoint: string;
  /** `X-API-Key` value; empty omits the header. */
  apiKey: string;
  /** `X-OpenViking-Account` value; empty omits the header. */
  account: string;
  /** `X-OpenViking-User` value; empty omits the header. */
  user: string;
  /** `X-OpenViking-Agent` value; empty omits the header. */
  agentId: string;
  /** Per-request timeout in milliseconds (1000–300000). */
  timeoutMs: number;
  /** Session-sync state file; `~` is expanded. */
  stateFile: string;
  repoContext: RepoContextConfig;
  autoRecall: AutoRecallConfig;
  autoCommit: AutoCommitConfig;
}

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
  repoContext: repoContextShape.default({} as RepoContextConfig),
  autoRecall: autoRecallShape.default({} as AutoRecallConfig),
  autoCommit: autoCommitShape.default({} as AutoCommitConfig),
});

/**
 * Reject an invalid endpoint at load time: it must be a non-empty absolute
 * http(s) URL. Throws a clear error before the client is constructed so a
 * misconfigured profile fails fast instead of misbehaving at runtime. Also
 * used as the settings-section validator, so a UI save of a malformed
 * endpoint is refused by the seam instead of stored.
 */
function assertValidEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`openviking: invalid endpoint "${endpoint}": must be a non-empty absolute http(s) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`openviking: invalid endpoint "${endpoint}": must be an absolute http(s) URL`);
  }
}

/** Project the full plugin config onto the SessionManager's config slice. */
function sessionSyncConfigOf(config: Config): SessionSyncConfig {
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
export function apply(ctx: Context, config: Config): void {
  assertValidEndpoint(config.endpoint);
  const logger = ctx.logger("openviking");

  // The authoritative configuration source. While a settings service is
  // mounted, `installSettingsSection` points it at the resolved settings
  // scope (schema defaults → composed entry config → user document); without
  // one it stays on the composition entry, so every deployment behaves
  // exactly as composed. Subsystems read through `current()` so a committed
  // settings change can be applied live.
  let current: () => Config = () => config;

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
    if (webServer === undefined) return;
    sctx.effect(() => {
      const disposers = makeBridgeRoutes({ settings: sctx.settings }).map((route) => webServer.register(route));
      return () => {
        for (const dispose of disposers) dispose();
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
    // Non-waiting notifications: queue refresh and adoption only; the memory
    // map is driven by user turns inside `agent/pre-step`.
    repoContext.refresh().catch(() => {});
    sessionManager.adopt(payload.agent);
  });

  ctx.on("agent/disposed", (payload) => {
    sessionManager.forget(payload.agent);
    // Release all per-agent recall state (slots, caches, map cadence) so a
    // disposed agent's memory never lingers in the recall layer.
    recall.forget(String(payload.agent.id));
  });

  ctx.on(
    "agent/pre-step",
    async (payload, next) => {
      const decision = await next();
      if (decision.kind !== "enter") return decision;

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
    },
  );

  ctx.on("session/event", (session, event) => {
    if (event.type !== "user/message" && event.type !== "assistant/message") return;
    const agent = sessionManager.agentById(String(session.id));
    if (!agent) return;
    sessionManager.queueDrain(agent);
  });

  logger.info("openviking plugin mounted", { endpoint: client.endpoint, stateFile: current().stateFile });
}
