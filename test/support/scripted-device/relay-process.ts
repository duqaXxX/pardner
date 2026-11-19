/**
 * The relay's process under a script (design 5.2, 5.3): a child that runs `serve` with a seam whose
 * journal `fsync` can be armed to fail, and the acts a script plays on it. Each act that ends the
 * process returns the new target: a link is never reused across a restart.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { MAIN, spawnNode } from "../../relay/child.ts";
import { init, portOf, wait, watch } from "../../relay/process-support.ts";
import { recordedBody } from "../crash/record.ts";
import { Recording } from "../crash/segments.ts";
import { tempDirSync } from "../temp.ts";
import { Defect, type Step, type Target, type World } from "./script.ts";

const STOP_MS = 10_000;
const ROUND = new URL("../../../src/relay/round.ts", import.meta.url).href;
const LIMITS = new URL("../../../src/relay/limits.ts", import.meta.url).href;

/**
 * The child's entry: the real `run` with raised limits (5.4, finding 6), and a `sync` that fails the
 * journal's with `EIO` while `flag` exists (5.3). With `recorder`, `node:fs` is replaced first (crash images 2.2).
 */
const ENTRY = (dir: string, flag: string, recorder?: string, port = 0) => `
import { existsSync, fstatSync, statSync } from "node:fs";
${recorder ?? ""}
const { run } = await import(${JSON.stringify(MAIN)});
const { FIGURES } = await import(${JSON.stringify(LIMITS)});
const { nodeSeam } = await import(${JSON.stringify(ROUND)});
const journal = ${JSON.stringify(join(dir, "journal"))};
const seam = { ...nodeSeam, sync: async (fd) => {
  if (existsSync(${JSON.stringify(flag)}) && fstatSync(fd).ino === statSync(journal).ino)
    throw Object.assign(new Error("EIO"), { code: "EIO", syscall: "fsync" });
  return nodeSeam.sync(fd);
} };
const big = { fine: 1e6, coarse: 1e6, all: 1e6, windowMs: 60_000 };
const figures = { ...FIGURES, rate: big, recovery: big, ban: { ...FIGURES.ban, after: 1e6 } };
process.exitCode = await run(["serve", "--dir", ${JSON.stringify(dir)}, "--listen", "127.0.0.1:${port}"], { seam, figures, exec: () => {} });
`;

/** Makes `to` hold exactly what `from` holds, writing each file over the live one so the journal keeps its inode (5.2). */
function overwrite(from: string, to: string, top = true): boolean {
  let rewrote = false;
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) {
      mkdirSync(join(to, e.name), { recursive: true });
      rewrote = overwrite(join(from, e.name), join(to, e.name), false) || rewrote;
    } else {
      // A file already equal to the copy's is left alone: truncating the journal would show rule 11 a half-written file.
      const bytes = readFileSync(join(from, e.name));
      const live = existsSync(join(to, e.name)) ? readFileSync(join(to, e.name)) : undefined;
      if (!live?.equals(bytes)) {
        writeFileSync(join(to, e.name), bytes);
        rewrote ||= top && e.name === "journal";
      }
    }
  }
  for (const name of readdirSync(to)) {
    if (existsSync(join(from, name))) continue;
    rmSync(join(to, name), { recursive: true, force: true });
    rewrote ||= top && name === "journal";
  }
  return rewrote;
}

/** A relay of its own, in a child process, with the acts of design 5.2. */
export class RelayProcess implements World {
  private serving?: ReturnType<typeof watch>;
  private target: Target = { port: 1, relay: new Uint8Array() };
  private durable?: number;
  private live = false;
  /** The port the next `serve` listens on: 0 lets the system choose, a number keeps an address a client holds. */
  private listen = 0;
  /** Whether the last `put-back-under` rewrote the journal (design 6.2: an equal journal is the journal alone). */
  private rewrote = false;
  private acting = "";
  /** Each copy with the key and secret its directory was made under: a recreate since changes both. */
  private readonly copies = new Map<
    string,
    { path: string; relay: Uint8Array; secret?: Uint8Array }
  >();
  readonly dir: string;
  private readonly flag: string;
  /** The `hold` act's flag file (design 4.1); the recorder in the child reads it, and writes `<hold>.waiting` while a sync waits. */
  private readonly hold: string;
  private readonly root = tempDirSync("pardner-relay-");
  /** The record of the directory's effects, when the run is for the crash images. */
  readonly recording?: Recording;

  /** With `record`, the directory lives in a folder of its own, the recorder's root, and every effect on it is recorded. */
  constructor(record = false) {
    const live = record ? join(this.root, "live") : this.root;
    if (record) {
      mkdirSync(live);
      this.recording = new Recording(live, join(this.root, "record"));
    }
    this.dir = join(live, "relay");
    this.flag = join(this.root, "fail");
    this.hold = join(this.root, "hold");
  }

  private entry() {
    const r = this.recording;
    const hook =
      r &&
      `const { install } = await import(${JSON.stringify(new URL("../crash/record.ts", import.meta.url).href)});\ninstall(${JSON.stringify(r.root)}, ${JSON.stringify(r.file)}, ${JSON.stringify(this.hold)});`;
    return ENTRY(this.dir, this.flag, hook, this.listen);
  }

  /** A change the test makes to the directory: recorded as the writes it is, and taken as durable (design 2.3). */
  private write(change: () => void, opens: false | { base?: number; kept?: boolean } = {}) {
    if (this.recording) this.recording.testWrite(change, opens);
    else change();
  }

  private initialise() {
    const r = this.recording;
    return init(this.dir, r && ((args) => spawnNode(recordedBody(r.root, r.file, args))));
  }

  /** The directory's `init` and the first `serve`. */
  async open(): Promise<Target> {
    return this.created(await this.initialise());
  }

  private async created(made: { key: Uint8Array; secret: Uint8Array }) {
    this.target = { ...made, relay: made.key, port: 1 };
    return this.serve();
  }

  /** Starts `serve`; a directory that is missing leaves a relay that waits and listens on nothing (RD 5.1), at port 1. */
  async serve(): Promise<Target> {
    if (this.live) throw new Defect("serve: a relay process is live");
    // No limit of its own: the watchdog ends the child when the test process dies, and a replay may run long.
    const serving = watch(spawnNode(this.entry()), 0);
    this.serving = serving;
    this.live = true;
    void serving.exit.then(() => {
      this.live = false;
    });
    if (!existsSync(this.dir)) {
      for (let i = 0; !/waiting for init/.test(serving.err()); i++) {
        if (!this.live || i > 500)
          throw new Error(`the relay exited or never waited: ${serving.err()}`);
        await wait(20);
      }
      return { ...this.target, port: 1 };
    }
    this.target = { ...this.target, port: await portOf(serving) };
    return this.target;
  }

  private async end(signal: "SIGTERM" | "SIGKILL", code: number | null) {
    const serving = this.serving;
    assert.ok(serving, "no relay is running");
    // A stop releases the hold first: a round held longer than STOP_MS would not exit in time. A kill leaves it: the held write must stay unsynced.
    if (signal === "SIGTERM") this.release();
    serving.child.kill(signal);
    assert.equal(await this.exited(serving, this.acting), code, serving.err());
    // A process that ends releases every hold: the start's barrier never waits on one a killed process left (design 4.1).
    this.release();
    this.recording?.verify(`the end of the process after ${this.acting}`);
    this.target = { ...this.target, port: 1 };
  }

  /** Removes the `hold` flag and the waiting file of each file it held. */
  private release() {
    rmSync(this.hold, { force: true });
    for (const f of readdirSync(this.root))
      if (f.startsWith("hold.waiting.")) rmSync(join(this.root, f), { force: true });
  }

  /** The exit of `serving`, within `STOP_MS`: a relay that ignores the signal is killed and the act `name` fails. */
  private async exited(serving: ReturnType<typeof watch>, name: string) {
    const late = Symbol();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<typeof late>((resolve) => {
      timer = setTimeout(() => resolve(late), STOP_MS);
    });
    // Cleared once the relay exits: a pending timer would hold the test process open for STOP_MS.
    const code = await Promise.race([serving.exit, limit]).finally(() => clearTimeout(timer));
    if (code !== late) return code;
    serving.child.kill("SIGKILL");
    throw new Error(`${name}: the relay did not exit within ${STOP_MS} ms and was killed`);
  }

  /** What `diskFails` leaves: the exit 75, the flag removed, the journal cut to its length before the failure, `serve` (5.3). */
  private async afterEio() {
    assert.equal(await this.serving?.exit, 75, String(this.serving?.err()));
    rmSync(this.flag, { force: true });
    this.release();
    this.recording?.verify("the exit 75");
    if (this.durable !== undefined) {
      const length = this.durable;
      // The journal is cut to what was synced: the sequence is the one the answers before were about.
      this.write(() => truncateSync(join(this.dir, "journal"), length), false);
    }
    this.durable = undefined;
    return this.serve();
  }

  async act(
    name: string,
    step: Step,
  ): Promise<{ target: Target; ended: boolean; rewrote?: boolean }> {
    const kept = new Set(["copy", "disk-fails", "put-back-under", "hold", "await-hold"]);
    const acts = [
      "stop",
      "kill",
      "serve",
      "restart",
      "restart-same-port",
      "power-cut",
      "disk-fails",
      "after-75",
      "copy",
      "put-back",
      "put-back-under",
      "lose",
      "recreate",
      "hold",
      "await-hold",
    ];
    if (!acts.includes(name)) throw new Defect(`unknown relay act ${name}`);
    const wants = name.startsWith("put-back");
    const copy = this.copies.get(String(step.copy));
    if (wants && !copy) throw new Defect(`no copy named ${step.copy}`);
    if (name === "copy" && this.copies.has(String(step.as)))
      throw new Defect(`the copy ${step.as} exists`);
    if (this.durable !== undefined && name !== "after-75")
      throw new Defect(`${name}: a failing fsync is armed, and only after-75 ends it (5.2)`);
    this.acting = name;
    const target = await this.play(name, step, copy as NonNullable<typeof copy>);
    return {
      target,
      ended: !kept.has(name),
      rewrote: name === "put-back-under" ? this.rewrote : undefined,
    };
  }

  private async play(
    name: string,
    step: Step,
    copy: { path: string; relay: Uint8Array; secret?: Uint8Array },
  ): Promise<Target> {
    switch (name) {
      case "stop":
        await this.end("SIGTERM", 0);
        return this.target;
      case "kill":
        await this.end("SIGKILL", null);
        return this.target;
      case "serve":
        return this.serve();
      case "restart":
        await this.end("SIGTERM", 0);
        return this.serve();
      case "restart-same-port": {
        // The new process listens where the old one did: a client that dials the address it holds finds it.
        const port = this.target.port;
        await this.end("SIGTERM", 0);
        this.listen = port;
        try {
          return await this.serve();
        } finally {
          this.listen = 0;
        }
      }
      case "power-cut":
        await this.end("SIGKILL", null);
        return this.serve();
      case "disk-fails":
        this.durable = statSync(join(this.dir, "journal")).size;
        writeFileSync(this.flag, "");
        return this.target;
      case "after-75":
        return this.afterEio();
      case "hold": {
        const { files } = step;
        const ms = Number(step.ms ?? 300);
        if (!Array.isArray(files) || !files.every((f) => typeof f === "string") || !(ms > 0))
          throw new Defect("hold: files must be a list of names and ms a positive number");
        // Written whole and renamed in: the recorder reads it while a sync runs and never sees half of it.
        // `at` tells this act from an earlier one: each file it names is held once, from its first wait.
        writeFileSync(`${this.hold}.tmp`, JSON.stringify({ files, ms, at: Date.now() }));
        renameSync(`${this.hold}.tmp`, this.hold);
        return this.target;
      }
      case "await-hold": {
        // The recorder says a sync of the file waits by writing `<hold>.waiting`: no timing orders what follows (design 4.1).
        for (let t = 0; t < 5000; t += 5) {
          if (existsSync(`${this.hold}.waiting.${step.file}`)) return this.target;
          await wait(5);
        }
        throw new Defect(`await-hold: no sync of ${step.file} waited within 5 s`);
      }
      case "copy": {
        const to = join(this.root, `copy-${step.as}`);
        execFileSync("cp", ["-R", this.dir, to]);
        this.recording?.copied.set(String(step.as), this.recording.length());
        this.copies.set(String(step.as), {
          path: to,
          relay: this.target.relay,
          secret: this.target.secret,
        });
        return this.target;
      }
      case "put-back":
        await this.end("SIGTERM", 0);
        this.write(
          () => {
            rmSync(this.dir, { recursive: true });
            execFileSync("cp", ["-R", copy.path, this.dir]);
          },
          { base: this.recording?.copied.get(String(step.copy)) },
        );
        this.target = { ...this.target, relay: copy.relay, secret: copy.secret };
        return this.serve();
      case "put-back-under":
        // The relay keeps its connections: the device proved before the copy is still served after it.
        this.write(
          () => {
            this.rewrote = overwrite(copy.path, this.dir);
          },
          { base: this.recording?.copied.get(String(step.copy)), kept: true },
        );
        this.target = { ...this.target, relay: copy.relay, secret: copy.secret };
        return this.target;
      case "lose":
        await this.end("SIGTERM", 0);
        this.write(() => rmSync(this.dir, { recursive: true }));
        return this.serve();
      default:
        await this.end("SIGTERM", 0);
        this.write(() => rmSync(this.dir, { recursive: true, force: true }));
        return this.created(await this.initialise());
    }
  }

  /** The blobs the directory holds at rest (design 6.3): the names in `blobs/`, each a blob's id in hex; only a name of the relay's own form is held (a `tmp-` file is not, RD 3.11). */
  observe(): { blobs: string[] } {
    const dir = join(this.dir, "blobs");
    const names = existsSync(dir) ? readdirSync(dir) : [];
    return { blobs: names.filter((n) => /^[0-9a-f]{64}$/.test(n)).sort() };
  }

  /** Ends whatever is running, for a test's `finally`. */
  async close() {
    if (!this.serving) return;
    this.release();
    this.serving.child.kill("SIGTERM");
    await this.exited(this.serving, "close");
  }
}
