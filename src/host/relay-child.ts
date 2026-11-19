/**
 * `pardner relay init` and `serve` run the relay's own entry file as a child process (relay design
 * 2.1: nothing outside `src/relay/` imports the relay, so the process that serves loads its code
 * alone). The child shares the terminal; this returns its exit code.
 */
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { join } from "node:path";

/** What a relay runs: the Node and the real path of the relay's entry file. */
export interface RelayProgram {
  node: string;
  entry: string;
}

/**
 * The relay's folder: `~/.local/share/pardner-relay` for the default instance (`name` null),
 * `pardner-relay-<name>` for a named one.
 */
export function relayDirOf(name: string | null, home: string): string {
  const suffix = name === null ? "" : `-${name}`;
  return join(home, ".local", "share", `pardner-relay${suffix}`);
}

/**
 * Runs `program` with `args` and resolves to the child's exit code, or 128 plus the number of the
 * signal that ended it. The terminal's `SIGINT` already reaches the child, whose handlers are
 * `once`: a second one forwarded from here would kill it by the default action, so it is ignored
 * here. `SIGTERM` is forwarded.
 */
export function runRelayChild(
  program: RelayProgram,
  args: readonly string[],
  err: (text: string) => void,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(program.node, [program.entry, ...args], { stdio: "inherit" });
    const ignore = () => {};
    const forward = () => void child.kill("SIGTERM");
    process.on("SIGINT", ignore);
    process.on("SIGTERM", forward);
    let ended = false;
    const end = (code: number) => {
      if (ended) return;
      ended = true;
      process.off("SIGINT", ignore);
      process.off("SIGTERM", forward);
      resolve(code);
    };
    child.on("error", (error) => {
      err(`pardner relay: the relay could not be started: ${error.message}\n`);
      end(1);
    });
    child.on("close", (code, signal) =>
      end(code ?? 128 + (signal === null ? 0 : (constants.signals[signal] ?? 0))),
    );
  });
}
