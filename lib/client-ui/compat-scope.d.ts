/**
 * Version-tolerant settings scope for the openviking web card.
 *
 * The official settings scope answers "unavailable" for every third-party
 * namespace on pre-0.1.2 hosts (the apiproxy allowlist is hard-coded there),
 * which would turn the card into a read-only explanation. This module wraps
 * scope: when it reports the namespace ready, the wrapper is a pass-through;
 * when it reports unavailable on a loopback connection, a bridge controller
 * takes over and serves the same SettingsScope contract from the host-side
 * bridge routes (/api/dsh-openviking). Remote browsers (non-loopback) never
 * use the bridge, matching the official process-local policy.
 *
 * The bridge controller additionally carries an optional batch surface
 * (`mutate`): one POST applies every planned write together, so the card
 * saves atomically when the bridge is the active transport; the official
 * path writes per-field (its writes are out of our reach).
 */
import type { SettingsScope } from "@deepseek-ai/dsh-client-ui-settings/client";
import type { BridgeDescribeResult, BridgeMutateRequest, BridgeMutateResult } from "../bridge-protocol.js";
/** The settings wire face the bridge controller consumes. */
export interface BridgeSettingsFace {
    settings: {
        describe: (payload: Record<string, never>) => Promise<{
            result: BridgeDescribeResult;
        }>;
        mutate: (payload: BridgeMutateRequest) => Promise<{
            result: BridgeMutateResult;
        }>;
    };
}
/** The compat scope contract the card consumes: the official scope plus an
 * explicit refresh (the official controller no longer exposes `load`). */
export type CompatSettingsScope<T> = SettingsScope<T> & {
    load(): Promise<void>;
};
/**
 * Build the fetch-backed settings face for the bridge routes. Network and
 * HTTP failures collapse into an ok:false envelope so the controller keeps
 * its unavailable state instead of throwing into plugin activation.
 * @param fetchFn - the fetch implementation (the global fetch on loopback).
 * @returns the settings face.
 */
export declare function createBridgeApi(fetchFn: typeof fetch): BridgeSettingsFace;
/** Options for the compat scope wrapper. */
export interface CompatScopeOptions<T> {
    /** Namespace identity (for the bridge fallback). */
    namespace: string;
    /** The official settings scope (primary transport). */
    primary: SettingsScope<T>;
    /** The fetch implementation; undefined on non-loopback connections (no fallback). */
    fetchFn?: typeof fetch;
}
/**
 * Wrap the official scope with the bridge fallback. The official scope stays
 * the primary transport wherever it works; the bridge controller is started
 * only when the primary settles as unavailable and a fetch face exists.
 * @param options - namespace, the official scope, and the optional fetch face.
 * @returns the compat scope (SettingsScope + load + optional batch mutate).
 */
export declare function createCompatScope<T>(options: CompatScopeOptions<T>): CompatSettingsScope<T>;
