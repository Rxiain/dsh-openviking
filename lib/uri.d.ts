/**
 * Canonical `viking://` URI parsing and validation shared by the model tools,
 * the LearnService, and the human command handlers. Local checks are syntactic
 * only: canonicalization, permission, containment, and target-shape authority
 * always stay on the OpenViking service.
 */
export interface VikingUri {
    scope: string;
    segments: string[];
}
/**
 * Parse a canonical `viking://<scope>/<segments...>` URI. The whole first
 * token after the scheme is the scope, so `viking://resources.evil/x` parses
 * as scope `resources.evil` — never as scope `resources`. Rejects missing or
 * malformed scopes, literal `.`/`..` segments, and percent-encoded traversal
 * (`%2e%2e`, `%2e`, `..%2f`, …): every segment is decoded and refused when it
 * decodes to `.`, `..`, or a value containing a path separator.
 */
export declare function parseVikingUri(uri: string, tool: string): VikingUri;
