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
export const OPENVIKING_SETTINGS_BRIDGE_PREFIX = "/api/dsh-openviking";
