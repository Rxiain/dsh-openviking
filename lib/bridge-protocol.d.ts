/**
 * Settings-bridge protocol shared by the host and browser halves of
 * dsh-openviking. Dependency-free by construction: both halves import it and
 * the browser bundle must never drag in host runtime dependencies.
 *
 * Pre-0.1.2 host-apiproxy serves only its hard-coded settings allowlist
 * (WEB_SETTINGS_NAMESPACES), so every third-party namespace answers
 * "settings-not-exposed" and the web card can only explain the gap. This
 * bridge re-serves the openviking namespace through the host settings seam
 * over a same-origin, loopback-only HTTP pair. On hosts whose apiproxy
 * already exposes the namespace, the official settings scope stays the
 * primary transport and this bridge never activates.
 */
/** Bridge route prefix (same-origin, loopback-only). */
export declare const OPENVIKING_SETTINGS_BRIDGE_PREFIX = "/api/dsh-openviking";
/** Wire view of the served namespace (mirrors the official apiproxy view). */
export interface BridgeNamespaceView {
    /** The settings namespace name. */
    ns: string;
    /** Serialized schemastery schema (schema.toJSON()). */
    schema: unknown;
    /** Current resolved value (secrets redacted). */
    value: unknown;
    /** Registrant's composition base layer, when declared. */
    base?: unknown;
    /** Raw user section, when present and well-formed. */
    user?: unknown;
    /** Schema-declared secret positions (present under redaction). */
    secrets?: {
        path: string[];
        set: boolean;
    }[];
    /** Monotonic revision of the user section this view was read at. */
    revision: number;
}
/** Describe result, shaped like an official RPC result envelope. */
export type BridgeDescribeResult = {
    ok: true;
    value: {
        namespaces: BridgeNamespaceView[];
        writable: boolean;
    };
} | {
    ok: false;
    code: string;
    message: string;
};
/** One path-addressed settings edit, mirroring the official mutate op. */
export interface BridgeSettingsOp {
    op: "set" | "unset";
    path: string[];
    value?: unknown;
}
/** Mutate request body. */
export interface BridgeMutateRequest {
    ns: string;
    ops: BridgeSettingsOp[];
    expectedRevision?: number;
}
/** Mutate result: the namespace's fresh view, or a refusal. */
export type BridgeMutateResult = {
    ok: true;
    value: BridgeNamespaceView;
} | {
    ok: false;
    code: string;
    message: string;
};
