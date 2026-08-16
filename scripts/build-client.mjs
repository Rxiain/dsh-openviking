#!/usr/bin/env node
/**
 * Build the browser half of dsh-openviking into the dsh browser bundle
 * format:
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
 *
 * esbuild bundles src/client.tsx to CommonJS with `react` /
 * `react/jsx-runtime` external (the browser loader resolves those against
 * its module table) and keeps bare `require(...)` calls for them; the wrapper
 * turns the module into a loader factory. The bundle id must equal the loader
 * entry name (the package name), which is what the host's client-module
 * registry serves at `/plugins/<name>/client.js`.
 *
 * The type declarations (lib/client.d.ts) come from the tsc pass
 * (tsconfig.client.json), which runs before this script.
 */
import { build } from "esbuild";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const result = await build({
  entryPoints: [join(root, "src", "client-ui.tsx")],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: ["es2022"],
  external: ["react", "react/jsx-runtime", "@deepseek-ai/dsh-client-ui-primitives"],
  jsx: "automatic",
  write: false,
  logLevel: "info",
});
const body = result.outputFiles[0].text.trim();

const wrapped = `window.__ModuleLoader__.load({
	id: "dsh-openviking",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${body}
		return module.exports;
	}
});
`;

writeFileSync(join(root, "lib", "client-ui.js"), wrapped);
console.log("build-client: wrote lib/client-ui.js in the dsh browser bundle format");
