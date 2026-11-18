/**
 * The relay's two commands (design 2.2). `serve` takes the lock, starts, listens for TLS, and waits
 * for a signal.
 */
import { writeSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createNodePlatform } from "../platform-node/platform.ts";
import { makeCertificate } from "./certificate.ts";
import { HeldElsewhere, relayPublicKey } from "./directory.ts";
import { ExclusionFailed, type Exec, nodeExec } from "./exclusion.ts";
import { PartialBytes } from "./frames-in.ts";
import { InitFailed, init } from "./init.ts";
import { FIGURES, Limits } from "./limits.ts";
import { createLog, errorFields } from "./log.ts";
import { Proofs } from "./proofs.ts";
import { nodeSeam, type Seam, StorageFailed } from "./round.ts";
import { createServer } from "./server.ts";
import { start } from "./start.ts";

/** What `run` takes from the process: replaced by a test. */
export interface MainDeps {
  exec: Exec;
  seam: Seam;
  out: (text: string) => void;
  err: (line: string) => void;
  /** Calls `handler` on `SIGTERM` or `SIGINT`; returns what undoes it. */
  signals: (handler: () => void) => () => void;
  /** The period of the check that removes the unnamed blobs past their time (design 3.11). */
  expireMs: number;
  /** The period of the line that counts refused proofs and dropped connections (design 7). */
  tallyMs: number;
  /** The limits' figures: a replay that reconnects often raises them (scripted device design 5.4). */
  figures: typeof FIGURES;
}

const USAGE = "usage: init --dir <directory> | serve --dir <directory> --listen <host>:<port>";
const WAIT_MS = 1000;
const EXPIRE_MS = 60 * 60 * 1000;
const TALLY_MS = 60_000;

function parse(argv: string[]): { command: string; dir?: string; listen?: string } | string {
  const [command = "", ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i];
    const value = rest[i + 1];
    if ((name !== "--dir" && name !== "--listen") || value === undefined) return USAGE;
    flags[name.slice(2)] = value;
  }
  const { dir, listen } = flags;
  if (command !== "init" && command !== "serve") return USAGE;
  if (dir === undefined || !isAbsolute(dir)) return "--dir is required and absolute";
  if (command === "init") return listen === undefined ? { command, dir: resolve(dir) } : USAGE;
  const port = /^.+:(\d{1,5})$/.exec(listen ?? "")?.[1];
  if (port === undefined || Number(port) > 65535) return "--listen is required, as <host>:<port>";
  return { command, dir: resolve(dir), listen };
}

/** Runs the command in `argv` and returns the exit code (design 2.4). */
export async function run(argv: string[], given: Partial<MainDeps> = {}): Promise<number> {
  const deps: MainDeps = {
    exec: nodeExec,
    seam: nodeSeam,
    out: (text) => void writeSync(1, text),
    err: (line) => void writeSync(2, `${line}\n`),
    signals: (handler) => {
      process.once("SIGTERM", handler);
      process.once("SIGINT", handler);
      return () => {
        process.off("SIGTERM", handler);
        process.off("SIGINT", handler);
      };
    },
    expireMs: EXPIRE_MS,
    tallyMs: TALLY_MS,
    figures: FIGURES,
    ...given,
  };
  const log = createLog(deps.err);
  const parsed = parse(argv);
  if (typeof parsed === "string") {
    log.error(parsed);
    return 1;
  }
  const { dir } = parsed as { dir: string };
  if (parsed.command === "init") {
    try {
      await init(dir, { exec: deps.exec, out: deps.out });
      return 0;
    } catch (error) {
      log.error(
        error instanceof InitFailed || error instanceof ExclusionFailed
          ? error.message
          : `init failed (${errorFields(error)})`,
      );
      return 1;
    }
  }
  const platform = createNodePlatform();
  let signalled: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => (signalled = resolve));
  const onSignal = () => signalled(0);
  const unwatch = deps.signals(onSignal);
  // Signals keep no event loop alive: this handle does, until the process is told to stop.
  const alive = setInterval(() => {}, 2 ** 30);
  let server: ReturnType<typeof createServer> | undefined;
  let expiry: NodeJS.Timeout | undefined;
  let tally: NodeJS.Timeout | undefined;
  try {
    let said = "";
    for (;;) {
      let started: Awaited<ReturnType<typeof start>>;
      try {
        started = await start(dir, { seam: deps.seam, log, exec: deps.exec, platform });
      } catch (error) {
        if (error instanceof HeldElsewhere) log.error("another relay holds the directory");
        else if (error instanceof ExclusionFailed) log.error(error.message);
        else if (error instanceof StorageFailed) return 75;
        else log.error(`start failed (${errorFields(error)})`);
        return 1;
      }
      if (started.state !== "waiting") {
        log.info(started.state === "serving" ? "serving" : "failed closed: serving nothing");
        // A failed-closed relay listens too (design 5.1): every proof is answered `refused 6`.
        try {
          const limits = new Limits(deps.seam.now, deps.figures);
          // Counts only, once a minute and only when not zero: no address, no id (design 7).
          tally = setInterval(() => {
            const { refused, dropped } = limits.take();
            if (refused + dropped > 0) {
              log.info(`limits: ${refused} proofs refused, ${dropped} connections dropped`);
            }
          }, deps.tallyMs);
          const proofs = new Proofs({
            platform,
            relayPublic: relayPublicKey(started.key),
            limits,
            log,
            serving:
              started.state === "serving"
                ? {
                    seq: started.seq,
                    journal: started.journal,
                    rounds: started.rounds,
                    seam: deps.seam,
                    dir,
                    lock: started.lock,
                    incarnation: started.incarnation,
                    seals: started.seals,
                    blobs: started.blobs,
                  }
                : null,
          });
          if (started.state === "serving") {
            expiry = setInterval(() => proofs.expire(), deps.expireMs);
          }
          server = createServer({
            session: (peer) => proofs.session(peer),
            key: started.key,
            cert: makeCertificate(started.key, platform.random(16)),
            limits,
            budget: new PartialBytes(),
            log,
            random: platform.random,
            now: deps.seam.now,
          });
        } catch (error) {
          log.error(`the relay key cannot serve (${errorFields(error)})`);
          return 1;
        }
        const [, host = "", port = ""] = /^\[?(.+?)\]?:(\d+)$/.exec(parsed.listen ?? "") ?? [];
        try {
          log.info(`listening on port ${await server.listen(host, Number(port))}`);
        } catch (error) {
          log.error(`listen failed (${errorFields(error)})`);
          return 1;
        }
        return await done;
      }
      if (started.why !== said) log.info(`waiting for init: ${started.why}`);
      said = started.why;
      const woke = await Promise.race([
        done,
        new Promise<null>((r) => setTimeout(() => r(null), WAIT_MS)),
      ]);
      if (woke !== null) return woke;
    }
  } finally {
    await server?.close();
    clearInterval(alive);
    clearInterval(expiry);
    clearInterval(tally);
    unwatch();
  }
}

if (import.meta.main) process.exit(await run(process.argv.slice(2)));
