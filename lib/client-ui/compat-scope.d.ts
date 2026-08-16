/**
 * rc.6-compatible settings scope for the openviking web card.
 *
 * The official settings scope answers "unavailable" for every third-party
 * namespace on rc.6 hosts (the apiproxy allowlist is hard-coded), which would
 * turn the card into a read-only explanation. This module wraps the official
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
import type { SettingsScope } from "@deepseek-ai/dsh-client-runtime/client";
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
/** One durable write a batched scope mutation performs. */
export interface BridgeBatchOp {
    field: string;
    op: "set" | "unset";
    value?: unknown;
}
/** Per-field outcome of one batched scope mutation. */
export interface BridgeBatchFieldResult {
    field: string;
    landed: boolean;
}
/** Result of one batched scope mutation. */
export interface BridgeBatchResult {
    /** Whether the whole mutate was accepted. */
    ok: boolean;
    /** Per-field success, in the request order (always present when ok). */
    fields: BridgeBatchFieldResult[];
    /** Host rejection code (mutate refused). */
    code?: string;
    /** Host rejection message (mutate refused). */
    message?: string;
}
/** The optional batch surface the bridge scope adds over the SettingsScope contract. */
export interface BatchedSettingsScope {
    /** One atomic mutation of every planned write; present only on the bridge path. */
    mutate?(writes: BridgeBatchOp[]): Promise<BridgeBatchResult>;
}
/** The compat scope contract the card consumes. */
export type CompatSettingsScope<T> = SettingsScope<T> & {
    load(): Promise<void>;
} & BatchedSettingsScope;
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
