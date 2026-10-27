import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

// Runs the built `towhee` command, the same file the Docker image starts, so a broken build fails here.
const bin = new URL("../dist/bin.js", import.meta.url).pathname;
let child: ChildProcess | undefined;
let dir: string | undefined;
afterEach(() => {
  child?.kill("SIGKILL");
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function output(proc: ChildProcess): () => string {
  let text = "";
  proc.stdout?.on("data", (d) => (text += d));
  proc.stderr?.on("data", (d) => (text += d));
  return () => text;
}

it("starts from env, serves /health and shuts down cleanly on SIGTERM", async () => {
  dir = mkdtempSync(join(tmpdir(), "towhee-bin-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  child = spawn(process.execPath, [bin], {
    env: { ...process.env, TOWHEE_SECRET: "b".repeat(32), PORT: String(port), TOWHEE_HOST: "127.0.0.1", TOWHEE_DATA: join(dir, "data", "t.sqlite") },
  });
  const log = output(child);
  let ok = false;
  for (let i = 0; i < 100 && !ok; i++) {
    ok = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false);
    if (!ok) await new Promise((r) => setTimeout(r, 50));
  }
  expect(ok, log()).toBe(true);
  expect(log()).toContain(`listening on ws://127.0.0.1:${port}`);
  const exited = new Promise<number | null>((resolve) => child!.on("exit", (code) => resolve(code)));
  child.kill("SIGTERM");
  expect(await exited).toBe(0);
  expect(log()).toContain("shutting down");
});

it("exits with a clear message when no key is set", async () => {
  child = spawn(process.execPath, [bin], { env: { PATH: process.env.PATH } });
  const log = output(child);
  const code = await new Promise<number | null>((resolve) => child!.on("exit", (c) => resolve(c)));
  expect(code).toBe(1);
  expect(log()).toContain("Set TOWHEE_SECRET");
});
