/**
 * A run's record and what the harness adds to it (crash images design 2.3, 5.2): the closes where the
 * record is checked against the real directory, the writes the test process makes, and the answers
 * the device received, each bound to the record's length at its arrival.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { DeviceKeys } from "../../../src/protocol/device-log.ts";
import type { Bytes } from "../../../src/protocol/platform.ts";
import type { RelayHead } from "../../../src/protocol/proofs.ts";
import type { Observed } from "../scripted-device/script.ts";
import { loadBase } from "./folder.ts";
import { digest, emptyBase, parse, type Rec, replay, type State } from "./replay.ts";

export type Device = { id: Bytes; sign: string; device: DeviceKeys };
/** What the device was told, in the words of design 5.2's table. */
export type Said =
  | { kind: "item"; id: Bytes }
  | {
      kind: "read";
      items: { position: number; id: Bytes }[];
      head: { n: number; chain: Bytes; sig: Bytes };
      me?: Device;
    }
  | { kind: "served"; enrol: boolean; person: Bytes; relay: Bytes; me?: Device }
  /** A seal given: `recipient` is none when it went to a recovery key, whose reads the checker cannot make. */
  | { kind: "seal"; epoch: Bytes; maker: Bytes; recipient?: Device; person: Bytes; relay: Bytes }
  | { kind: "blob"; id: Bytes }
  | { kind: "closed"; head?: { head: RelayHead; sig: Bytes }; me?: Device; relay: Bytes };
/** An answer, bound to the record's length `L` when it arrived and to the generation of the directory. */
export type Answer = { L: number; gen: number } & Said;

/** The paths of a state, each with its node: what two states are compared by, entry by entry. */
function paths(s: State): Map<string, { data?: Buffer; mode?: number }> {
  const out = new Map<string, { data?: Buffer; mode?: number }>();
  const walk = (ino: number, path: string) => {
    const n = s.get(ino);
    if (!n || !("entries" in n)) return;
    for (const [name, child] of [...n.entries].sort()) {
      const c = s.get(child);
      out.set(`${path}${name}`, { data: c && "data" in c ? c.data : undefined, mode: c?.mode });
      walk(child, `${path}${name}/`);
    }
  };
  walk(0, "");
  return out;
}

/** The records of a write the test made, from the states before and after: removals, then new folders and files, parents first. */
export function writesBetween(before: State, after: State): Rec[] {
  const [a, b] = [paths(before), paths(after)];
  const recs: Rec[] = [];
  const gone = [...a.keys()].filter((p) => !b.has(p) || !!a.get(p)?.data !== !!b.get(p)?.data);
  for (const p of gone)
    if (!gone.some((q) => p.startsWith(`${q}/`))) recs.push({ op: "remove", path: p });
  for (const [p, n] of b) {
    const old = a.get(p);
    const kept = old !== undefined && !gone.includes(p);
    if (kept && old.mode !== n.mode && n.mode !== undefined)
      recs.push({ op: "chmod", path: p, mode: n.mode });
    if (n.data === undefined && !kept) recs.push({ op: "mkdir", path: p, mode: n.mode });
    else if (n.data !== undefined && !(kept && old?.data?.equals(n.data)))
      recs.push({
        op: "writefile",
        path: p,
        data: n.data.toString("base64"),
        mode: kept ? undefined : n.mode,
      });
  }
  return recs;
}

/** The record of one run, with the folder it describes (`root`) and the file the recorder appends to. */
export class Recording {
  /** The record's lengths at which a test write made the directory another sequence: answers before one do not bind after it. */
  readonly generations: number[] = [];
  /** The stretches of records the harness wrote: a cut inside one is a power cut during a copy by hand, outside the design (2.3). */
  readonly synthetic: [number, number][] = [];
  /** For each generation: the record length at the `copy` act whose directory became its base, and whether the relay kept its connections (a put-back under it). */
  readonly opened: { base?: number; kept?: boolean }[] = [];
  /** The record length at each `copy` act, by name. */
  readonly copied = new Map<string, number>();
  /** The script's device (design 4.1) of each lineage, by the generation it began in: the one its first `prove` step names. The checker reads as it. */
  readonly devices = new Map<number, Device>();
  readonly answers: Answer[] = [];

  readonly root: string;
  readonly file: string;

  constructor(root: string, file: string) {
    this.root = root;
    this.file = file;
  }

  records(): Rec[] {
    return existsSync(this.file) ? parse(readFileSync(this.file, "utf8")) : [];
  }

  /** The record's length: the bound of an answer that has just arrived (design 5.2). */
  length(): number {
    return existsSync(this.file) ? readFileSync(this.file).filter((c) => c === 10).length : 0;
  }

  /** A segment's close: the record rebuilds the real directory, or the run stops and no image is built (design 2.3, 6). */
  verify(when: string): void {
    const rebuilt = digest(replay(this.records(), emptyBase()));
    if (rebuilt !== digest(loadBase(this.root)))
      throw new Error(`the record does not rebuild the directory at ${when}`);
  }

  /**
   * A change of the directory by the test process: checked before, written down after, and taken as
   * durable (design 2.3). `another` is whether the directory is another sequence afterwards (a copy put
   * back, a directory lost) and the answers before no longer bind (`opens` says what it was made from), or
   * the same one (`false`: a journal cut to what was synced).
   */
  testWrite(change: () => void, opens: false | { base?: number; kept?: boolean } = {}): void {
    this.verify("a write by the test");
    const before = loadBase(this.root);
    change();
    const recs = writesBetween(before, loadBase(this.root));
    const mine = recs.map((r) => `${JSON.stringify(r)}\n`);
    appendFileSync(this.file, mine.join(""));
    // The records the test wrote, found by their text: the child may have written some of its own meanwhile (design 2.3).
    const lines = readFileSync(this.file, "utf8").split("\n");
    const at = lines.findLastIndex((_, i) => mine.every((m, j) => `${lines[i + j]}\n` === m));
    const first = mine.length === 0 ? this.length() : at;
    const own = mine.map((_, j) => first + j);
    appendFileSync(this.file, `${JSON.stringify({ op: "durable", recs: own })}\n`);
    this.synthetic.push([first, first + own.length + 1]);
    if (opens) {
      this.generations.push(this.length());
      this.opened.push(opens);
    }
    this.verify("the record of a write by the test");
  }

  /** Binds what the device was told to the record's length now (design 5.2). */
  observe({
    step,
    outcome,
    id,
    me,
    person,
    target,
    recipient,
    epoch,
    maker,
    blob,
    head,
  }: Observed): void {
    const at = { L: this.length(), gen: this.generations.length };
    if (step.op === "prove" && me) {
      // A lineage begins at the start and at each directory made anew (`lose`, `recreate`): a put-back goes on with the same one.
      const begun = this.opened.findLastIndex((o) => o.base === undefined) + 1;
      if (!this.devices.has(begun)) this.devices.set(begun, me);
    }
    const o = outcome as { type: string; code?: number };
    if (o.type === "result" && o.code === 11)
      this.answers.push({ ...at, kind: "closed", head, me, relay: target.relay });
    else if (step.op === "give-seal" && o.type === "result" && o.code === 0 && epoch && maker)
      this.answers.push({
        ...at,
        kind: "seal",
        epoch,
        maker,
        recipient,
        person,
        relay: target.relay,
      });
    else if (step.op === "put-blob" && o.type === "result" && o.code === 0 && blob)
      this.answers.push({ ...at, kind: "blob", id: blob });
    else if (step.op === "submit" && o.type === "result" && o.code === 0 && id)
      this.answers.push({ ...at, kind: "item", id });
    else if (outcome.type === "pass" && "items" in outcome)
      this.answers.push({
        ...at,
        kind: "read",
        items: outcome.items.map((i) => ({ position: i.position, id: i.id })),
        head: outcome.head,
        me,
      });
    else if (o.type === "served")
      this.answers.push({
        ...at,
        kind: "served",
        enrol: step.enrol !== undefined,
        person,
        relay: target.relay,
        me,
      });
  }
}
