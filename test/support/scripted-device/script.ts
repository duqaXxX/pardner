/**
 * Scripts and their interpreter (design 4.2). A script is JSON lines, one step each, with names for
 * what the relay never names: a device (`app1`), a recovery key (`sheet1`), an epoch (`e1`), a blob
 * (`b2`), a connection (`c1`), an item (`m14`), a relay's incarnation (`I1`). The interpreter builds
 * real bytes with the package, keeps the map from names to ids and keys, and compares each outcome
 * with the step's `expect`, in the protocol's words: `result 0`, `result 1 or 2`, `refused 1`,
 * `no answer`, `served`, `blob`, or an object for a read and a recovery log.
 *
 * A refusal must come from the rule it tests: the bytes of every item the interpreter built are
 * decoded with the package before they are sent, and one that does not decode stops the run as a
 * `Defect`, unless the step is marked `"decoding": true`.
 *
 * Ops: `export` (builds an item as `submit` does and hands its bytes to the run's `exported`, sending nothing: the bytes of a driver under test), `together` (design 4.1 of the crash images: `lists` of steps that run at once, a step with `pipe` not waited for), `prove` (`enrol`, `recovery` or `head` for an upload, else active), `submit` (`entry`: add,
 * remove, reset, create, epoch, message), `put-blob`, `get-blob`, `read`, `give-seal`,
 * `recovery-log`, `upload-done`, `close`, `follow` (the next push on a kept connection, checked as a read: the same `expect`), and `relay` (`act`: an act on the relay's process, 5.2, played by
 * the run's `World`; a link is never reused across a restart, so every act that ends the process closes
 * every connection, and a script proves again). A proof of upload or of recovery is not answered: its step expects
 * `silent` and sets `wait`, the ms the link waits. `conn` defaults to `c1`, `as` names what a step builds.
 *
 * Forms of a step (each forgery has its positive twin in the scripts): `bots` (names of devices made
 * of kind `bot`, before the step builds), `seq` and `prevOf` (an entry or epoch at a stale position:
 * an item's name, or `null` for none), `resend` (the bytes a step named by `as` sent, sent again),
 * `proofBy` (on an add or a reset's new device), `deviceHeadLength` and `memberHeadLength` (an epoch's
 * heads, past the log), `wrongSeal` (an epoch whose seals hold another key than its commitment),
 * `fileKeys` (a message file whose key is not the blob's: `{"b1":"wrong"}`), `unread` (an `upload-done`
 * of a head at that `n` which no read gave). A `give-seal` to a recovery key names it as `recipient`. An epoch step's `recipients` seals it to those devices and recovery keys in place of the log's (and `extra`'s).
 * A put-back from a copy gives the interpreter's logs and person back as they were when the copy was taken.
 */
import { createNodePlatform } from "../../../src/platform-node/platform.ts";
import {
  type DeviceEntry,
  type DeviceKeys,
  decodeDeviceEntry,
  encodeDeviceEntry,
  encodeDevicePossession,
  type LoggedEntry,
  recipientsOf,
} from "../../../src/protocol/device-log.ts";
import {
  decodeHistorySeal,
  type EpochEntry,
  encodeEpochEntry,
  encodeHistorySeal,
  epochCommitment,
  sealEpochKey,
} from "../../../src/protocol/epochs.ts";
import { sealBlobUnderKey } from "../../../src/protocol/files.ts";
import { deviceId, recoveryKeyId, relayKeyId, signedId } from "../../../src/protocol/ids.ts";
import { encodeMemberEntry } from "../../../src/protocol/member-log.ts";
import { sealMessage } from "../../../src/protocol/messages.ts";
import type { Bytes, Platform } from "../../../src/protocol/platform.ts";
import type { RelayHead } from "../../../src/protocol/proofs.ts";
import {
  DECODERS,
  dial,
  type Held,
  type Link,
  NoConnection,
  type Outcome,
  type Pass,
} from "./link.ts";

/** What an outcome says in the words `expect` uses. */
export type Said = { type: string; code?: number; reason?: number };
export type Step = { op: string; line: number; [field: string]: unknown };
/** An outcome the script got as it expected, with what a checker needs to ask the same question of another relay (design 5.2). */
export type Observed = {
  step: Step;
  outcome: Said | Pass;
  target: Target;
  person: Bytes;
  /** The id of the item a `submit` built. */
  id?: Bytes;
  /** The device the step ran as, with its key name. */
  me?: { id: Bytes; sign: string; device: DeviceKeys };
  /** For a `give-seal`: the device it was given to (none for a recovery key), the epoch's id, and the seal's maker. */
  recipient?: { id: Bytes; sign: string; device: DeviceKeys };
  epoch?: Bytes;
  maker?: Bytes;
  /** For a `put-blob`: the blob's id. For an `upload-done`: the head and its signature. */
  blob?: Bytes;
  head?: { head: RelayHead; sig: Bytes };
};
/** What a run is pointed at: a relay's port, its public key, and the secret of its enrolment. */
export type Target = { port: number; relay: Bytes; secret?: Bytes };

/** The relay's process under a run: plays an act, and returns where the relay is afterwards. */
export interface World {
  act(name: string, step: Step): Promise<{ target: Target; ended: boolean; rewrote?: boolean }>;
}

/** A step whose outcome was not the one it expected. */
export class Failure extends Error {}
/** A step the interpreter could not build as the script meant: a defect of the script or of the interpreter. */
export class Defect extends Error {}

/** The steps of a script: one JSON object a line, blank lines skipped, each with its line number. */
export function parse(source: string): Step[] {
  return source.split("\n").flatMap((raw, i) => {
    if (raw.trim() === "") return [];
    let step: Step;
    try {
      step = JSON.parse(raw) as Step;
    } catch {
      throw new Defect(`line ${i + 1}: not JSON`);
    }
    if (typeof step.op !== "string") throw new Defect(`line ${i + 1}: a step names its op`);
    return [{ ...step, line: i + 1 }];
  });
}

const text = new TextEncoder();
const hex = (b: Bytes) => Buffer.from(b).toString("hex");
const same = (a: Bytes, b: Bytes) => Buffer.from(a).equals(b);
const KIND = { add: 1, remove: 1, reset: 1, create: 2, epoch: 3, message: 4 } as const;
const NO_LINK = {
  refused: "nothing listens",
  handshake: "no handshake",
  pin: "wrong key",
  hello: "no hello",
} as const;

/** What an outcome is called in a script's `expect`. */
function words(o: Said): string {
  if (o.type === "result") return `result ${o.code}`;
  if (o.type === "refused") return `refused ${o.reason}`;
  return o.type === "closed" ? "no answer" : o.type;
}

/** `expect` as the words it allows: `result 1 or 2` allows `result 1` and `result 2`. */
function allowed(expect: string): string[] {
  const [first = "", ...more] = expect.split(" or ");
  const word = first.split(" ")[0];
  return [first, ...more.map((m) => (/^\d+$/.test(m) ? `${word} ${m}` : m))];
}

/** Runs `steps` against the relay `target`; the first step that fails stops the run, and every connection is closed. */
export async function run(
  steps: Step[],
  first: Target,
  platform: Platform = createNodePlatform(),
  world?: World,
  observe?: (seen: Observed) => void,
  exported?: (kind: 1 | 2 | 3 | 4, item: { signed: Bytes; sig: Bytes }) => void,
) {
  let target = first;
  const links = new Map<string, { link: Link; device: string }>();
  const every: { name: string; link: Link }[] = [];
  const keys = new Map<string, ReturnType<typeof keyOf>>();
  const recoveries = new Set<string>();
  const items = new Map<string, Bytes>();
  const heads = new Map<string, { n: number; chain: Bytes; sig: Bytes }>();
  const blobs = new Map<string, ReturnType<typeof sealBlobUnderKey>>();
  const epochs = new Map<string, { id: Bytes; key: Bytes; prev?: Bytes }>();
  const incarnations = new Map<string, string>();
  const dlog: LoggedEntry[] = [];
  const mlog: Bytes[] = [];
  const elog: Bytes[] = [];
  const resent = new Map<string, ReturnType<typeof sign>>();
  const taken = new Map<
    string,
    { logs: [LoggedEntry[], Bytes[], Bytes[]]; person: Bytes; record: Held }
  >();
  // The ids of the relay directory's sequence, kept across links and starts (design 6.2) and handed to each new link.
  const emptied = (): Held => ({ ids: new Map(), checked: { n: 0, chain: new Uint8Array(32) } });
  let record = emptied();
  // Links before this index hold ids of a sequence the record no longer is (a put-back, a recreate).
  let since = 0;
  // Whether the record is a copy's put back under a running relay, whose probe is then the copy's own (5.2).
  let underCopy = false;
  const forged = new Uint8Array(64).fill(9);
  let person: Bytes = new Uint8Array(32);

  function keyOf(name: string) {
    const signing = platform.makeKeyPair(`${name}.s`, "sign");
    const receiving = platform.makeKeyPair(`${name}.r`, "receive");
    if (!signing.ok || !receiving.ok) throw new Defect(`the key ${name} is already held`);
    const pair = { signing: signing.value, receiving: receiving.value };
    return {
      sign: `${name}.s`,
      pair,
      device: { kind: "app" as "app" | "bot", ...pair },
      id: deviceId(platform, pair.signing, pair.receiving),
      recoveryId: recoveryKeyId(platform, pair.signing, pair.receiving),
    };
  }
  const key = (name: unknown) => {
    if (typeof name !== "string") throw new Defect("a step names a device or a key");
    if (!keys.has(name)) keys.set(name, keyOf(name));
    return keys.get(name) as ReturnType<typeof keyOf>;
  };
  const signer = (name: string) => (recoveries.has(name) ? key(name).recoveryId : key(name).id);
  const named = (name: unknown, length = 16) =>
    platform.sha256(text.encode(String(name))).slice(0, length);
  const sign = (by: string, bytes: Bytes) => {
    const sig = platform.sign(key(by).sign, bytes);
    if (!sig.ok) throw new Defect(`no key named ${by}`);
    return { signed: bytes, sig: sig.value };
  };
  const possession = (by: string, device: ReturnType<typeof keyOf>) => {
    const made = platform.sign(key(by).sign, encodeDevicePossession(person, device.device));
    if (!made.ok) throw new Defect(`no key named ${by}`);
    return made.value;
  };
  const conn = (step: Step) => {
    const c = links.get(String(step.conn ?? "c1"));
    if (!c) throw new Defect(`line ${step.line}: no connection ${step.conn ?? "c1"}`);
    return c;
  };
  /** Takes what every link so far holds into `record`: one directory has one sequence. */
  const absorb = () => {
    for (const { link } of every.slice(since)) {
      const held = link.held();
      for (const [i, id] of held.ids) {
        const known = record.ids.get(i);
        if (known && !same(known, id))
          throw new Failure(`position ${i} was given as two different items by one directory`);
        record.ids.set(i, id);
      }
      if (held.checked.n > record.checked.n) record = { ...record, checked: held.checked };
    }
    return record;
  };
  const copyOf = (held: Held): Held => ({ ids: new Map(held.ids), checked: held.checked });
  const fail = (step: Step, why: string) => new Failure(`line ${step.line}: ${why}`);
  /** Whether `outcome` is the step's `expect`; `silent` only where the relay is not to answer (a proof of upload or of recovery). */
  /** Tells `observe` an outcome the step wanted. */
  const seen = (step: Step, outcome: Said | Pass, id?: Bytes) => {
    if (!observe) return;
    // A prove names the device that proves; any other step runs as the device of its connection (a `submit add` names the added one).
    const name = step.op === "prove" ? step.device : links.get(String(step.conn ?? "c1"))?.device;
    const me = typeof name === "string" ? key(name) : undefined;
    const to =
      typeof step.recipient === "string" && !recoveries.has(step.recipient)
        ? key(step.recipient)
        : undefined;
    observe({
      step,
      outcome,
      target,
      person,
      id,
      me,
      recipient: to,
      epoch: epochs.get(String(step.epoch))?.id,
      maker: typeof step.maker === "string" ? key(step.maker).id : me?.id,
      blob: step.op === "put-blob" ? blobs.get(String(step.as))?.id : undefined,
      head: step.op === "upload-done" ? relayHead(step) : undefined,
    });
  };
  const wanted = (step: Step, outcome: Said, silentOk = false, id?: Bytes) => {
    const got = words(outcome);
    if (got === "silent" && !silentOk)
      throw fail(step, "the relay did not answer, which 6.1 maps to nothing");
    if (typeof step.expect !== "string" || !allowed(step.expect).includes(got))
      throw fail(step, `expected ${JSON.stringify(step.expect)}, got ${got}`);
    seen(step, outcome, id);
  };

  const reference = (re: unknown) => {
    const r = re as { device: string; name: string } | undefined;
    return r && { device: key(r.device).id, name: named(r.name) };
  };
  const relayHead = (step: Step) => {
    if (step.unread !== undefined)
      return {
        head: {
          relay: relayKeyId(platform, target.relay),
          n: Number(step.unread),
          chain: named("unread", 32),
        },
        sig: forged,
      };
    const h = heads.get(String(step.head));
    if (!h) throw new Defect(`no head ${step.head}`);
    return {
      head: { relay: relayKeyId(platform, target.relay), n: h.n, chain: h.chain },
      sig: step.forged ? forged : h.sig,
    };
  };

  /** A head over `log`: its own length and last id, or `length` of the step, past the log, with a last id nothing holds. */
  function past<T>(log: T[], length: unknown, id = (x: T) => x as Bytes) {
    const n = length === undefined ? log.length : Number(length);
    return { length: n, last: n <= log.length ? id(log[n - 1] as T) : named("past", 32) };
  }
  /** The `prev` a step asks for: `undefined` leaves `last`, `null` is none, a name is that item. */
  const placed = (prevOf: unknown, last: Bytes | undefined) => {
    if (prevOf === undefined) return last;
    if (prevOf === null) return undefined;
    const id = items.get(String(prevOf));
    if (!id) throw new Defect(`no item ${prevOf}`);
    return id;
  };

  /** The signed bytes of the item a `submit` step builds, signed by `by`, as the device `device`. */
  function build(step: Step, by: string, device: string) {
    const entry = String(step.entry);
    const head = {
      person,
      seq: step.seq === undefined ? dlog.length : Number(step.seq),
      prev: placed(step.prevOf, dlog.at(-1)?.id),
      signer: signer(by),
    };
    if (entry === "add") {
      const other = key(step.device);
      const proof = possession(String(step.proofBy ?? step.device), other);
      const body = { kind: "add", device: other.device, proof };
      return sign(by, encodeDeviceEntry({ ...head, ...body } as DeviceEntry));
    }
    if (entry === "remove") {
      const body = { kind: "remove", device: key(step.device).id };
      return sign(by, encodeDeviceEntry({ ...head, ...body } as DeviceEntry));
    }
    if (entry === "reset") {
      const fresh = step.newDevice === undefined ? undefined : key(step.newDevice);
      if (step.recovery !== undefined) recoveries.add(String(step.recovery));
      const body = {
        kind: "reset",
        set: ((step.set ?? []) as string[]).map((n) => key(n).id),
        newDevice: fresh && {
          device: fresh.device,
          proof: possession(String(step.proofBy ?? step.newDevice), fresh),
        },
        recovery: step.recovery === undefined ? undefined : key(step.recovery).pair,
      };
      return sign(by, encodeDeviceEntry({ ...head, ...body } as DeviceEntry));
    }
    const signers = { signerPerson: person, signerDevice: key(device).id };
    if (entry === "create") {
      const nonce = named(step.nonce ?? "n0");
      return sign(by, encodeMemberEntry({ seq: 0, kind: "create", nonce, ...signers }));
    }
    const channel = mlog[0] as Bytes;
    if (entry === "epoch") {
      const prev = placed(step.prevOf, elog.at(-1));
      const epochKey = platform.random(32);
      const extra = ((step.extra ?? []) as string[]).map((n) => ({
        id: key(n).id,
        receiving: key(n).pair.receiving,
      }));
      const seen = dlog.slice(0, Number(step.deviceLength ?? dlog.length));
      // `recipients` names the devices and recovery keys the epoch is sealed to, as a device whose own log differs from the relay's builds it; left out, they are the log's.
      const sealed =
        step.recipients === undefined
          ? [...recipientsOf(platform, seen), ...extra]
          : (step.recipients as string[]).map((n) => ({
              id: signer(n),
              receiving: key(n).pair.receiving,
            }));
      const seals = sealed.map((r) => {
        const under = step.wrongSeal ? platform.random(32) : epochKey;
        const sealed = sealEpochKey(platform, channel, prev, r.id, r.receiving, under);
        if (!sealed.ok) throw new Defect("an epoch key could not be sealed");
        return sealed.value;
      });
      const e: EpochEntry = {
        channel,
        seq: step.seq === undefined ? elog.length : Number(step.seq),
        prev,
        memberHead: past(mlog, step.memberHeadLength),
        deviceHeads: [{ person, ...past(seen, step.deviceHeadLength, (x) => x.id) }],
        seals,
        commitment: epochCommitment(platform, channel, prev, epochKey),
        ...signers,
      };
      const built = sign(by, encodeEpochEntry(e));
      epochs.set(String(step.as), {
        id: signedId(platform, built.signed),
        key: epochKey,
        ...(prev && { prev }),
      });
      return built;
    }
    const epoch = epochs.get(String(step.epoch));
    if (entry !== "message" || !epoch)
      throw new Defect(`line ${step.line}: no entry or epoch to build`);
    const wrong = (step.fileKeys ?? {}) as Record<string, string>;
    const files = ((step.files ?? []) as string[]).map((n) => {
      const b = blobs.get(n);
      if (!b) throw new Defect(`no blob ${n}`);
      const fileKey = wrong[n] === undefined ? b.key : named(`${n}.${wrong[n]}`, 32);
      return { blob: b.id, fileKey, size: 1, type: "x", name: n };
    });
    const header = {
      channel,
      counter: Number(step.counter ?? 1),
      epoch: epoch.id,
      sender: key(step.sender ?? device).id,
      run: named(step.run ?? "run1"),
      incarnation: named(step.incarnation ?? "I1"),
      time: 1_700_000_000_000,
      kind: Number(step.kind ?? 1),
      to: step.to === undefined ? undefined : key(step.to).id,
      re: reference(step.re),
      name: named(step.name ?? step.as),
    };
    return sign(
      by,
      sealMessage(platform, epoch.key, header, { files, content: String(step.content ?? "{}") }),
    );
  }

  async function prove(step: Step) {
    const name = String(step.conn ?? "c1");
    links.get(name)?.link.close();
    const ms = Number(step.wait ?? 5000);
    let link: Link;
    try {
      link = await dial(platform, target.port, target.relay, 5000, copyOf(absorb()));
    } catch (e) {
      if (!(e instanceof NoConnection)) throw e;
      return wanted(step, { type: NO_LINK[e.reason] });
    }
    links.set(name, { link, device: String(step.device) });
    every.push({ name, link });
    const me = key(step.device);
    if (step.recovery !== undefined) {
      recoveries.add(String(step.recovery));
      const r = key(step.recovery);
      const sheet = { id: r.recoveryId, sign: r.sign };
      return wanted(step, await link.proveRecovery(person, sheet, me, ms), true);
    }
    if (step.head !== undefined) {
      const { head, sig } = relayHead(step);
      return wanted(step, await link.proveUpload(me, head, sig, ms), true);
    }
    if (step.enrol !== undefined) {
      recoveries.add(String(step.enrol));
      const genesis = sign(
        String(step.device),
        encodeDeviceEntry({
          seq: 0,
          kind: "genesis",
          device: me.device,
          recovery: key(step.enrol).pair,
          signer: me.id,
        }),
      );
      person = platform.sha256(genesis.signed);
      const secret = step.secret === "wrong" ? new Uint8Array(32).fill(7) : target.secret;
      if (!secret) throw new Defect("no enrolment secret was given");
      link.enrol(secret, genesis);
      const served = await link.proveActive(person, me.id, me.sign, ms);
      const entry = decodeDeviceEntry(genesis.signed);
      if (served.type === "served" && entry.ok) dlog.push({ entry: entry.value, id: person });
      if (typeof step.as === "string") items.set(step.as, person);
      return wanted(step, served);
    }
    return wanted(step, await link.proveActive(person, me.id, me.sign, ms));
  }

  async function submit(step: Step) {
    const c = conn(step);
    const by = String(step.by ?? c.device);
    const again = typeof step.resend === "string" ? resent.get(step.resend) : undefined;
    if (typeof step.resend === "string" && !again)
      throw new Defect(`line ${step.line}: nothing named ${step.resend} was sent`);
    const built = again ?? build(step, by, String(step.sender ?? c.device));
    if (typeof step.as === "string") resent.set(step.as, built);
    const kind = KIND[step.entry as keyof typeof KIND];
    const bytes = step.truncate
      ? { ...built, signed: built.signed.slice(0, Number(step.truncate)) }
      : built;
    const decoded = DECODERS[kind](bytes.signed);
    if (!step.decoding && !decoded.ok)
      throw new Defect(
        `line ${step.line}: the ${step.entry} does not decode, so a refusal proves nothing`,
      );
    const id = signedId(platform, bytes.signed);
    if (typeof step.as === "string") items.set(step.as, id);
    const answer = await c.link.submit(kind, bytes);
    wanted(step, answer, false, id);
    if (answer.type !== "result" || answer.code !== 0) return;
    // The same bytes sent again may be answered `result 0` and are no new position.
    const held = (log: Bytes[]) => log.some((x) => same(x, id));
    if (kind === 1 && decoded.ok && !held(dlog.map((x) => x.id)))
      dlog.push({ entry: decoded.value as DeviceEntry, id });
    if (kind === 2 && !held(mlog)) mlog.push(id);
    if (kind === 3 && !held(elog)) elog.push(id);
  }

  async function read(step: Step) {
    return passed(step, await conn(step).link.read(Number(step.from ?? 0)));
  }

  /** The next push of the kept connection's follow (design 7), checked as a read is. */
  async function follow(step: Step) {
    return passed(step, await conn(step).link.follow(Number(step.wait ?? 2000)));
  }

  /** What a read or a push answered, against the step's `expect`. */
  function passed(step: Step, got: Outcome) {
    if (typeof step.expect === "string") return wanted(step, got);
    if (got.type !== "pass") throw fail(step, `expected a read, got ${words(got)}`);
    if (got.problems.length > 0) throw fail(step, `the read broke ${got.problems.join("; ")}`);
    const want = step.expect as {
      items?: string[];
      n?: number;
      seals?: number;
      inc?: string;
      chained?: boolean;
    };
    const names = want.items ?? [];
    if (got.items.length !== names.length)
      throw fail(step, `${got.items.length} items, expected ${names.length}`);
    names.forEach((n, i) => {
      const id = items.get(n);
      if (!id || !same((got.items[i] as { id: Bytes }).id, id))
        throw fail(step, `item ${i} is not ${n}`);
    });
    if (want.n !== undefined && got.head.n !== want.n)
      throw fail(step, `n is ${got.head.n}, expected ${want.n}`);
    if (want.chained !== undefined && got.chainChecked !== want.chained)
      throw fail(step, `the chain was ${got.chainChecked ? "" : "not "}checked`);
    if (want.seals !== undefined && got.seals.length !== want.seals)
      throw fail(step, `${got.seals.length} seals, expected ${want.seals}`);
    if (want.inc !== undefined) {
      if (!got.incarnation) throw fail(step, "the read carries no incarnation");
      const seen = incarnations.get(want.inc) ?? hex(got.incarnation);
      if (!incarnations.has(want.inc) && [...incarnations.values()].includes(seen))
        throw fail(step, `${want.inc} is an incarnation another name holds`);
      incarnations.set(want.inc, seen);
      if (seen !== hex(got.incarnation)) throw fail(step, `the incarnation is not ${want.inc}`);
    }
    if (typeof step.head === "string") heads.set(step.head, got.head);
    seen(step, got);
  }

  /** An act on the relay's process (5.2); `probe` is a read on a connection already served, which must meet rule 11 and end the process with 75. */
  async function act(step: Step) {
    if (!world) throw new Defect(`line ${step.line}: no relay process to act on`);
    const name = String(step.act);
    if (name === "probe") {
      const got = await conn(step).link.read(0);
      if (got.type !== "closed") throw fail(step, `the probe was answered: ${words(got)}`);
    }
    const absorbed = absorb();
    const kept = underCopy;
    underCopy = false;
    const done = await world.act(name === "probe" ? "after-75" : name, step);
    target = done.target;
    if (name === "copy")
      taken.set(String(step.as), {
        logs: [[...dlog], [...elog], [...mlog]],
        person,
        record: copyOf(absorbed),
      });
    const copy = name.startsWith("put-back") ? taken.get(String(step.copy)) : undefined;
    if (copy) {
      dlog.splice(0, dlog.length, ...copy.logs[0]);
      elog.splice(0, elog.length, ...copy.logs[1]);
      mlog.splice(0, mlog.length, ...copy.logs[2]);
      person = copy.person;
      // Over an equal journal the sequence did not change: the links keep what they hold.
      if (name === "put-back" || done.rewrote !== false) {
        record = copyOf(copy.record);
        since = every.length;
        underCopy = name === "put-back-under";
      }
    }
    // A failed fsync cuts the journal to a length the interpreter does not know (design 6.2): the record is read again.
    if ((name === "probe" || name === "after-75") && !kept) {
      record = emptied();
      since = every.length;
    }
    if (!done.ended) return;
    for (const { link } of links.values()) link.close();
    links.clear();
    if (name === "recreate") {
      for (const log of [dlog, mlog, elog]) log.length = 0;
      person = new Uint8Array(32);
      record = emptied();
      since = every.length;
    }
  }

  /**
   * A `together` step (design 4.1): its `lists` run at once, one per connection. In a list a step with
   * `"pipe": true` is sent and not waited for, so the next is sent before its answer; the others run in order.
   * What a list does inside is evaluated in order, since each step builds and sends before its first wait.
   */
  async function together(step: Step) {
    const run = async (list: Step[]) => {
      const sent: Promise<unknown>[] = [];
      for (const s of list) {
        const one = play({ ...s, line: step.line });
        // A failure of a step nobody waits for yet is kept, and thrown once the list is done.
        if (s.pipe)
          sent.push(
            one.then(
              () => undefined,
              (e) => e ?? new Error("failed"),
            ),
          );
        else await one;
      }
      const failed = (await Promise.all(sent)).find(Boolean);
      if (failed) throw failed;
    };
    // Every list ends before the first failure is thrown: a sibling does not go on acting under a torn-down run.
    const ended = await Promise.allSettled((step.lists as Step[][]).map(run));
    const failed = ended.find((r) => r.status === "rejected");
    if (failed) throw failed.reason;
  }

  async function play(step: Step) {
    for (const n of (step.bots ?? []) as string[]) key(n).device.kind = "bot";
    switch (step.op) {
      case "relay":
        return act(step);
      case "together":
        return together(step);
      case "prove":
        return prove(step);
      case "submit":
        return submit(step);
      case "export": {
        const c = conn(step);
        const built = build(step, String(step.by ?? c.device), String(step.sender ?? c.device));
        if (!exported) throw new Defect(`line ${step.line}: no one takes an exported item`);
        if (typeof step.as === "string") items.set(step.as, signedId(platform, built.signed));
        return exported(KIND[step.entry as keyof typeof KIND], built);
      }
      case "read":
        return read(step);
      case "follow":
        return follow(step);
      case "put-blob": {
        const file = text.encode(String(step.text ?? step.as));
        const b = sealBlobUnderKey(platform, named(`${step.as}.key`, 32), file);
        blobs.set(String(step.as), b);
        const claim = step.claim === undefined ? b.id : named(step.claim, 32);
        const size = step.size === undefined ? b.blob.length : Number(step.size);
        const put = conn(step).link.putBlob(claim, b.blob, Number(step.chunk ?? 1024), size);
        return wanted(step, await put);
      }
      case "get-blob": {
        const b = blobs.get(String(step.blob));
        const id = step.claim === undefined ? (b?.id as Bytes) : named(step.claim, 32);
        const got = await conn(step).link.getBlob(id);
        wanted(step, got);
        if ("bytes" in got && b && !same(got.bytes, b.blob))
          throw fail(step, "the blob came back changed");
        return;
      }
      case "give-seal": {
        const c = conn(step);
        const maker = String(step.maker ?? c.device);
        const to = key(step.recipient);
        const toId = signer(String(step.recipient));
        const epoch = epochs.get(String(step.epoch));
        if (!epoch) throw new Defect(`no epoch ${step.epoch}`);
        const channel = mlog[0] as Bytes;
        const sealed = sealEpochKey(
          platform,
          channel,
          epoch.prev,
          toId,
          to.pair.receiving,
          epoch.key,
        );
        if (!sealed.ok) throw new Defect("a seal could not be made");
        const seal = { ...sealed.value, channel, epoch: epoch.id, maker: key(maker).id };
        const signed = sign(String(step.by ?? maker), encodeHistorySeal(seal));
        if (!decodeHistorySeal(signed.signed).ok) throw new Defect("the seal does not decode");
        return wanted(step, await c.link.giveSeal(seal, signed.sig));
      }
      case "recovery-log": {
        const got = await conn(step).link.recoveryLog();
        if (typeof step.expect === "string") return wanted(step, got);
        if (got.type !== "recovered") throw fail(step, `expected a log, got ${words(got)}`);
        const want = (step.expect as { log: string[] }).log;
        const ids = got.entries.map((e) => signedId(platform, e.signed));
        const match = want.every((n, i) =>
          same(ids[i] ?? new Uint8Array(), items.get(n) ?? new Uint8Array(1)),
        );
        if (got.code !== 0 || ids.length !== want.length || !match)
          throw fail(step, `the log is not ${want.join(", ")}`);
        return;
      }
      case "upload-done": {
        const { head, sig } = relayHead(step);
        return wanted(step, await conn(step).link.uploadDone(head, sig));
      }
      case "close":
        return links.get(String(step.conn ?? "c1"))?.link.close();
      default:
        throw new Defect(`line ${step.line}: unknown op ${step.op}`);
    }
  }

  try {
    for (const step of steps) {
      try {
        await play(step);
      } catch (e) {
        if (e instanceof Defect && !/^line \d+/.test(e.message))
          throw new Defect(`line ${step.line}: ${e.message}`);
        throw e;
      }
    }
    // What a relay says that it never should, and a frame nobody waited for, is a difference of its own.
    await Promise.all(every.map(({ link }) => link.settle()));
    for (const { name, link } of every) {
      const odd = [
        ...link.problems,
        ...link.late.map((f) => `a late ${f.type}`),
        ...link.unread().map((o) => `an unread ${o.type}`),
      ];
      if (odd.length > 0) throw new Failure(`connection ${name}: ${odd.join("; ")}`);
    }
  } finally {
    for (const { link } of every) link.close();
  }
}
