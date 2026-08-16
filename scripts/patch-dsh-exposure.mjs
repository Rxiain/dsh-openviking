#!/usr/bin/env node
/**
 * Patch the dsh host API-proxy exposure so the `openviking` settings
 * namespace is served to the web client.
 *
 * WHY: the upstream harness gates which settings namespaces reach the
 * browser in a hardcoded whitelist (`WEB_SETTINGS_NAMESPACES` in
 * packages/host/apiproxy). The dsh installation under /usr/lib is
 * root-owned, so instead of editing it this script copies the
 * dsh-host-apiproxy package into the profile's own node_modules (the
 * loader's first resolution anchor for bare module names) and adds the
 * `openviking` entry there. The copy is a real directory, so the loader
 * picks it up; the installation copy is never touched.
 *
 * Re-run after any `dsh plugin --profile <name> add|remove` (pnpm prunes
 * the profile node_modules), after a dsh upgrade, or after the web profile
 * stops exposing the OpenViking card.
 */
import { cpSync, existsSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const WHITELIST_OLD = [
  "agent-loop",
  "shell",
  "locale",
  "permission",
  "ui-conversation",
  "ui-theme",
  "web-search-deepseek",
];
const WHITELIST_NEW = [...WHITELIST_OLD, "openviking"];

/** Resolve the dsh installation's own copy of a package from its bin path. */
function resolveFromDshInstall(packageName) {
  const dshBin = execFileSync("which", ["dsh"], { encoding: "utf8" }).trim();
  if (!dshBin) throw new Error("dsh CLI not found on PATH; patch the apiproxy whitelist manually");
  const dshEntry = readlinkSync(dshBin);
  const dshPkgRoot = resolve(dirname(resolve(dirname(dshBin), dshEntry)), "..");
  const requireFromDsh = createRequire(join(dshPkgRoot, "package.json"));
  return dirname(requireFromDsh.resolve(`${packageName}/package.json`));
}

const isPatched = (source) => source.includes('"openviking"') || source.includes("'openviking'");

/** Patch one compiled apiproxy file: append `openviking` to the whitelist. */
function patchWhitelist(file) {
  const source = readFileSync(file, "utf8");
  if (isPatched(source)) return false;
  // The whitelist array holds only strings, so `[^\]]*` cannot overrun it.
  const match = source.match(/const WEB_SETTINGS_NAMESPACES = \[[^\]]*\]/);
  if (!match) throw new Error(`could not locate WEB_SETTINGS_NAMESPACES in ${file}`);
  const quote = match[0].includes("'") ? "'" : '"';
  const entries = [...WHITELIST_OLD, "openviking"].map((entry) => `${quote}${entry}${quote}`);
  const replacement = `const WEB_SETTINGS_NAMESPACES = [\n\t${entries.join(",\n\t")}\n];`;
  writeFileSync(file, source.replace(match[0], replacement));
  return true;
}

function main() {
  const args = process.argv.slice(2);
  const profile = args.includes("--profile") ? args[args.indexOf("--profile") + 1] : "web";
  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  const profileDir = join(home, "profiles", profile);
  if (!existsSync(join(profileDir, "package.json"))) {
    throw new Error(`profile ${profile} does not exist at ${profileDir}`);
  }

  const pkgName = "@deepseek-ai/dsh-host-apiproxy";
  const sourceDir = resolveFromDshInstall(pkgName);
  const targetDir = join(profileDir, "node_modules", "@deepseek-ai", "dsh-host-apiproxy");

  if (existsSync(targetDir)) {
    const already = ["lib/index.js", "lib/types/api-proxy.js"]
      .map((rel) => join(targetDir, rel))
      .filter((file) => existsSync(file) && isPatched(readFileSync(file, "utf8"))).length;
    if (already >= 1) {
      console.log(`patch-dsh-exposure: ${targetDir} already exposes "openviking" (${already}/2 files)`);
      return;
    }
    console.log(`patch-dsh-exposure: refreshing stale copy at ${targetDir}`);
  }
  cpSync(sourceDir, targetDir, { recursive: true, force: true, dereference: true });
  const patched = ["lib/index.js", "lib/types/api-proxy.js"].map((rel) => {
    const file = join(targetDir, rel);
    return existsSync(file) ? patchWhitelist(file) : false;
  });
  const count = patched.filter(Boolean).length;
  console.log(`patch-dsh-exposure: copied ${pkgName} into ${targetDir} and added "openviking" to WEB_SETTINGS_NAMESPACES (${count} file${count === 1 ? "" : "s"} patched)`);
  console.log(`patch-dsh-exposure: restart the profile: dsh --profile ${profile}`);
}

main();
