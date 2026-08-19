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
export function parseVikingUri(uri: string, tool: string): VikingUri {
  const match = /^viking:\/\/([^/]+)(?:\/(.*))?$/.exec(uri);
  if (!match) {
    throw new Error(`${tool}: invalid URI format — must start with "viking://" followed by a scope`);
  }
  const isTraversal = (raw: string): boolean => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      decoded = raw; // malformed escapes (e.g. "%zz") cannot decode to traversal
    }
    return decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\");
  };
  const scope = match[1]!;
  if (isTraversal(scope)) {
    throw new Error(`${tool}: invalid URI — traversal segments ('.' or '..') are not allowed`);
  }
  const segments = match[2] === undefined ? [] : match[2].split("/").filter((segment) => segment !== "");
  for (const segment of segments) {
    if (isTraversal(segment)) {
      throw new Error(`${tool}: invalid URI — traversal segments ('.' or '..') are not allowed`);
    }
  }
  return { scope, segments };
}
