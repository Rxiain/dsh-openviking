/**
 * Loopback settings bridge for the `openviking` namespace.
 *
 * Pre-0.1.2 host-apiproxy serves only its hard-coded settings allowlist
 * (WEB_SETTINGS_NAMESPACES), so every third-party namespace answers
 * "settings-not-exposed" at the RPC boundary and the web card can only
 * explain the gap. This bridge re-serves the openviking namespace through
 * the host settings seam over a same-origin, loopback-only HTTP pair. The
 * handlers ride ctx.settings, which keeps the official schema validation,
 * revision fencing, persistence, and event emission for free; the bridge
 * only adds the allowlist gate the apiproxy normally provides. Error codes
 * mirror the official RPC codes so the client controller treats refusals
 * exactly like an apiproxy answer.
 *
 * Hosts whose apiproxy already exposes the namespace never touch the bridge:
 * the browser half uses the official settings scope as its primary transport
 * and falls back here only when the official scope reports the namespace
 * unavailable on a loopback connection.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SettingsDescriptor, SettingsNamespace, SettingsProvider } from "@deepseek-ai/dsh-settings";
import { SettingsConflictError } from "@deepseek-ai/dsh-settings";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import { OPENVIKING_SETTINGS_BRIDGE_PREFIX } from "./bridge-protocol.js";
import type { BridgeDescribeResult, BridgeMutateRequest, BridgeMutateResult, BridgeNamespaceView, BridgeSettingsOp } from "./bridge-protocol.js";

/** Namespace this bridge serves (the plugin's own settings section). */
const SERVED_NAMESPACE = "openviking";

/** Cap on JSON request bodies (a single mutate is tiny). */
const MAX_JSON_BODY_BYTES = 64 * 1024;

/** Loopback literal check plus browser same-origin markers. */
export function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
  const host = request.headers.host;
  if (typeof host !== "string") return false;
  let hostUrl: URL;
  try {
    hostUrl = new URL("http://" + host);
  } catch {
    return false;
  }
  if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "referrer-policy": "no-referrer" });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_JSON_BODY_BYTES) return undefined;
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function toView(descriptor: SettingsDescriptor): BridgeNamespaceView {
  return {
    ns: String(descriptor.ns),
    schema: descriptor.schema,
    value: descriptor.value,
    ...(descriptor.base === undefined ? {} : { base: descriptor.base }),
    ...(descriptor.user === undefined ? {} : { user: descriptor.user }),
    ...(descriptor.secrets === undefined
      ? {}
      : { secrets: descriptor.secrets.map((secret) => ({ path: [...secret.path], set: secret.set })) }),
    revision: descriptor.revision,
  };
}

/** Map a seam failure onto the official-shaped refusal envelope. */
export function bridgeFailureOf(error: unknown): { ok: false; code: string; message: string } {
  if (error instanceof SettingsConflictError) {
    return { ok: false, code: "settings-conflict", message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/is not registered/.test(message)) {
    return { ok: false, code: "settings-rejected", message };
  }
  return { ok: false, code: "settings-rejected", message };
}

/** Dependencies of the bridge handlers. */
export interface BridgeDeps {
  /** The host settings seam (already injected). */
  settings: SettingsProvider;
}

/** The describe and mutate handlers the routes wrap. */
export interface BridgeHandlers {
  describe(): Promise<BridgeDescribeResult>;
  mutate(request: unknown): Promise<BridgeMutateResult>;
}

/**
 * Build the bridge handlers. The served namespace is the plugin's own
 * `openviking` section, intersected with what is actually registered in the
 * seam, so an unknown entry can never surface a form or accept a write.
 * @param deps - the settings seam.
 * @returns the handlers.
 */
export function makeBridgeHandlers(deps: BridgeDeps): BridgeHandlers {
  const view = (): BridgeNamespaceView | undefined => {
    const descriptor = deps.settings.describe({ redactSecrets: true }).find((candidate) => String(candidate.ns) === SERVED_NAMESPACE);
    return descriptor === undefined ? undefined : toView(descriptor);
  };
  return {
    async describe() {
      const namespaces = view() === undefined ? [] : [view()!];
      return { ok: true, value: { namespaces, writable: deps.settings.writable !== false } };
    },
    async mutate(request) {
      const body = request as Partial<BridgeMutateRequest> | null;
      if (body === null || typeof body !== "object" || body.ns !== SERVED_NAMESPACE || !Array.isArray(body.ops)) {
        return { ok: false, code: "settings-rejected", message: "malformed bridge settings request" };
      }
      const expectedRevision = typeof body.expectedRevision === "number" ? body.expectedRevision : undefined;
      try {
        await deps.settings.mutate(SERVED_NAMESPACE, body.ops as unknown as Parameters<SettingsProvider["mutate"]>[1], expectedRevision);
      } catch (error) {
        return bridgeFailureOf(error);
      }
      const fresh = view();
      if (fresh === undefined) {
        return { ok: false, code: "internal", message: `settings namespace "${SERVED_NAMESPACE}" was disposed after the mutate` };
      }
      return { ok: true, value: fresh };
    },
  };
}

/**
 * Build the loopback-only bridge routes.
 * @param deps - handler dependencies.
 * @returns the exact-path route registrations.
 */
export function makeBridgeRoutes(deps: BridgeDeps): WebRoute[] {
  const handlers = makeBridgeHandlers(deps);
  const guard = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: "loopback requests only" });
      return false;
    }
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "method not allowed: " + (req.method ?? "") });
      return false;
    }
    return true;
  };
  return [
    {
      kind: "exact",
      path: OPENVIKING_SETTINGS_BRIDGE_PREFIX + "/describe",
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        writeJson(res, 200, await handlers.describe());
      },
    },
    {
      kind: "exact",
      path: OPENVIKING_SETTINGS_BRIDGE_PREFIX + "/mutate",
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        const body = await readJsonBody(req);
        if (body === undefined) {
          writeJson(res, 400, { ok: false, code: "settings-rejected", message: "unreadable JSON body" });
          return;
        }
        writeJson(res, 200, await handlers.mutate(body));
      },
    },
  ];
}
