/**
 * Publishes every public package whose current version isn't on npm yet.
 *
 * In the Release workflow it runs after the "Version packages" PR merges and authenticates with
 * npm Trusted Publishing (GitHub OIDC): no token, and each version gets a provenance statement.
 * Locally (`pnpm release`) it uses your own npm login; npm asks for your 2FA code. That's how the
 * very first version of each package goes out, since a trusted publisher can only be added to a
 * package that already exists.
 *
 * Each package is packed with pnpm (which rewrites `workspace:*` ranges to real versions) and the
 * tarball is published with npm, which handles OIDC. In CI it creates a git tag for each version
 * and prints a "New tag:" line; changesets/action pushes those tags and makes a GitHub Release for
 * each (it doesn't create the tags itself when the publish command is custom).
 */
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: runs directly from the Release workflow, not through turbo, so there is no cache to key
const inCI = process.env.GITHUB_ACTIONS === "true";
/** `--dry-run`: pack everything and list what would publish, without publishing. */
const dryRun = process.argv.includes("--dry-run");

function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status})`);
  return r;
}

function isPublished(name: string, version: string) {
  const r = spawnSync("npm", ["view", `${name}@${version}`, "version"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() === version;
}

/** Creates the release tag at HEAD unless it already exists (a rerun after a partial publish). */
function tag(name: string) {
  const exists = spawnSync("git", ["rev-parse", "-q", "--verify", `refs/tags/${name}`], { cwd: root }).status === 0;
  if (!exists) run("git", ["tag", name], { cwd: root });
}

const packages = readdirSync(join(root, "packages"))
  .map((dir) => join(root, "packages", dir))
  .flatMap((dir) => {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      return pkg.private ? [] : [{ dir, name: pkg.name as string, version: pkg.version as string }];
    } catch {
      return [];
    }
  });

const pending = packages.filter((p) => !isPublished(p.name, p.version));
if (pending.length === 0) {
  console.log("Nothing to publish: every package version is already on npm.");
  process.exit(0);
}

const out = mkdtempSync(join(tmpdir(), "towhee-publish-"));
const failed: string[] = [];
for (const p of pending) {
  try {
    console.log(`\nPublishing ${p.name}@${p.version}`);
    const before = new Set(readdirSync(out));
    run("pnpm", ["pack", "--pack-destination", out], { cwd: p.dir });
    const tarball = readdirSync(out).find((f) => !before.has(f));
    if (!tarball) throw new Error("pnpm pack produced no tarball");
    if (dryRun) {
      console.log(`(dry run) would publish ${tarball}`);
      continue;
    }
    const args = ["publish", join(out, tarball), "--access", "public", ...(inCI ? ["--provenance"] : [])];
    const r = spawnSync("npm", args, { stdio: ["inherit", "inherit", "pipe"], encoding: "utf8" });
    process.stderr.write(r.stderr ?? "");
    // `npm view` lags a few minutes behind a fresh publish, so a rerun can retry a version that
    // already went out. npm refuses those; that's success, not failure.
    if (r.status !== 0 && /cannot publish over (the )?previously (published|staged) version/i.test(r.stderr ?? "")) {
      console.log(`${p.name}@${p.version} is already on npm.`);
      continue;
    }
    if (r.status !== 0) throw new Error(`npm ${args.join(" ")} failed (exit ${r.status})`);
    if (inCI) tag(`${p.name}@${p.version}`);
    console.log(`New tag: ${p.name}@${p.version}`);
  } catch (error) {
    console.error(`::error title=Publish failed::${p.name}@${p.version}: ${(error as Error).message}`);
    failed.push(`${p.name}@${p.version}`);
  }
}


if (failed.length) {
  console.error(`\nFailed: ${failed.join(", ")}`);
  if (inCI) console.error("If this is the first version of a package, publish it once locally (pnpm release) and add the trusted publisher on npmjs.com.");
  process.exit(1);
}
