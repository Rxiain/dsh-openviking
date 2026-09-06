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
import type { IncomingMessage } from "node:http";
import type { SettingsProvider } from "@deepseek-ai/dsh-settings";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type { BridgeDescribeResult, BridgeMutateResult } from "./bridge-protocol.js";
/** Loopback literal check plus browser same-origin markers. */
export declare function isLoopbackRequest(request: IncomingMessage): boolean;
/** Map a seam failure onto the official-shaped refusal envelope. */
export declare function bridgeFailureOf(error: unknown): {
    ok: false;
    code: string;
    message: string;
};
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
export declare function makeBridgeHandlers(deps: BridgeDeps): BridgeHandlers;
/**
 * Build the loopback-only bridge routes.
 * @param deps - handler dependencies.
 * @returns the exact-path route registrations.
 */
export declare function makeBridgeRoutes(deps: BridgeDeps): WebRoute[];
