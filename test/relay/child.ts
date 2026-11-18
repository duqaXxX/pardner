/**
 * The relay's child processes for the process tests. A child ends the way `SIGTERM` ends it when its
 * stdin pipe closes (the test process died, so nobody is left to stop it), and a normal exit of the
 * test process kills the children still running.
 */
import { type ChildProcess, spawn } from "node:child_process";

export const MAIN = new URL("../../src/relay/main.ts", import.meta.url).href;

/** Run at the top of a child's `-e` script: the parent's stdin pipe ending (unref'd, so an `init` still exits) raises `SIGTERM`, which `run` already handles. */
export const WATCHDOG = `const stop = () => process.emit("SIGTERM");
process.stdin.on("end", stop).on("error", stop).resume().unref();
`;

const running = new Set<ChildProcess>();
process.on("exit", () => {
  for (const child of running) child.kill("SIGKILL");
});

/** Starts `node -e <WATCHDOG + body>` with a stdin pipe the parent keeps open. */
export function spawnNode(body: string): ChildProcess {
  const child = spawn(process.execPath, ["--input-type=module", "-e", WATCHDOG + body], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  running.add(child);
  child.once("close", () => running.delete(child));
  return child;
}

/** A child that runs the relay's `run` with no `tmutil`, as a user would run `main.ts`; `main` names another entry (a mutant copy, for a test that shows a check can fail). */
export const relayChild = (args: string[], main = MAIN) =>
  spawnNode(`import { run } from ${JSON.stringify(main)};
process.exitCode = await run(${JSON.stringify(args)}, { exec: () => {} });`);
