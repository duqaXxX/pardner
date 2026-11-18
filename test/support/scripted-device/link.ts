/**
 * A device's connection to the relay, on the protocol package (design 4.1): TLS 1.3 with the relay's
 * key pinned, the hello, the exporter binding and the ways in. What the relay says, `refused`
 * and a closed connection included, comes back as an outcome; what it never should say is a
 * `problem` of the link. Nothing here maps an outcome to the model's words (design 6.1).
 */
import { X509Certificate } from "node:crypto";
import { connect as tls } from "node:tls";
import { type DeviceKeys, decodeDeviceEntry } from "../../../src/protocol/device-log.ts";
import { decodeEpochEntry } from "../../../src/protocol/epochs.ts";
import { decodeFrame, encodeFrame, type Frame, frameLength } from "../../../src/protocol/frames.ts";
import { relayKeyId, signedId } from "../../../src/protocol/ids.ts";
import { EXPORTER_LABEL } from "../../../src/protocol/labels.ts";
import { decodeMemberEntry } from "../../../src/protocol/member-log.ts";
import { decodeMessage } from "../../../src/protocol/messages.ts";
import type { Bytes, Platform } from "../../../src/protocol/platform.ts";
import {
  chainLink,
  checkHead,
  encodeProof,
  type Proof,
  type RelayHead,
} from "../../../src/protocol/proofs.ts";

type Of<T extends Frame["type"]> = Extract<Frame, { type: T }>;

/** What a wait ends with when the relay says no frame: it closed the connection, stayed silent, or sent bytes that are no frame. */
export type Gone = { type: "closed" } | { type: "silent" } | { type: "undecodable" };
export type Outcome = Frame | Gone | Pass;
export type Item = { position: number; kind: 1 | 2 | 3 | 4; signed: Bytes; sig: Bytes; id: Bytes };
/**
 * A read, or one push of a follow, taken whole. `read` is true for the answer to a `read` (it starts
 * with its `position`). `problems` lists each rule of 6.2 and 6.3 it broke: no gap, seals before the
 * items, items that decode, a head that is the relay's and a chain that holds, and an item that
 * differs from the one held for its position.
 */
export type Pass = {
  type: "pass";
  read: boolean;
  incarnation?: Bytes;
  seals: Of<"seals">["items"];
  items: Item[];
  head: Of<"head">;
  /** Whether the chain was checked: the link holds the id of every position below the head. */
  chainChecked: boolean;
  problems: string[];
};

/**
 * What a link holds of the sequence (design 6.2): the id of each position seen and the last chain
 * checked. A replay keeps it per relay directory and hands it to the next link, so that a head is
 * checked after a restart with no read from 0. A caller that cuts `ids` below `checked.n` must drop
 * `checked`: a chain checked over positions the link no longer holds is not one it can go on from.
 */
export type Held = { ids: Map<number, Bytes>; checked: { n: number; chain: Bytes } };

export const DECODERS = {
  1: decodeDeviceEntry,
  2: decodeMemberEntry,
  3: decodeEpochEntry,
  4: decodeMessage,
} as const;

/** Why there is no link: nothing listens, the TLS handshake failed or never answered, the key is not the pinned one, or the relay did not open with `hello`. */
export class NoConnection extends Error {
  readonly reason: "refused" | "handshake" | "pin" | "hello";
  constructor(reason: "refused" | "handshake" | "pin" | "hello", why: string) {
    super(`${reason}: ${why}`);
    this.reason = reason;
  }
}

/** Dials `port`, pins `relay` (its 65-byte key) and reads the hello within `patience` ms each; the link is ready for a proof, and starts from `held` when it is given one. */
export async function dial(
  platform: Platform,
  port: number,
  relay: Bytes,
  patience = 5000,
  held?: Held,
) {
  const socket = tls({
    host: "127.0.0.1",
    port,
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
    rejectUnauthorized: false,
  });
  socket.on("error", () => {});
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new NoConnection("handshake", "no answer")), patience);
      const fail = (reason: "refused" | "handshake", why: string) => {
        clearTimeout(timer);
        reject(new NoConnection(reason, why));
      };
      socket.once("secureConnect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("close", () => fail("handshake", "closed"));
      socket.once("error", (e: NodeJS.ErrnoException) =>
        fail(e.code === "ECONNREFUSED" ? "refused" : "handshake", e.message),
      );
    });
    const jwk = new X509Certificate(socket.getPeerCertificate().raw).publicKey.export({
      format: "jwk",
    });
    const key = Buffer.concat([
      Buffer.of(4),
      Buffer.from(jwk.x ?? "", "base64url"),
      Buffer.from(jwk.y ?? "", "base64url"),
    ]);
    if (!key.equals(relay)) throw new NoConnection("pin", "the certificate holds another key");
  } catch (e) {
    socket.destroy();
    throw e;
  }

  let proven = false;
  let buffer = Buffer.alloc(0);
  let closed = false;
  let refused = false;
  const stream: Outcome[] = [];
  /** Frames a settling read found before its own answer. */
  const strays: Outcome[] = [];
  // A request's frames, by each id that may answer it, until its `result` (a blob get: its last chunk).
  type Pending = { frames: Frame[]; done: (r: Frame[] | Outcome) => void };
  const pending = new Map<number, Pending>();
  /** Frames that carry a request id nobody waits for: a `result` after `silent`, or after a put already answered. */
  const late: Frame[] = [];
  // Each wait takes the first outcome it accepts; a pass of the other sort stays for the wait that wants it.
  const waiting: { accept: (o: Outcome) => boolean; resolve: (o: Outcome) => void }[] = [];
  /** What the relay sent that it never should: a frame after `refused`. */
  const problems: string[] = [];
  // What the link holds of the sequence: the id of each position seen, the last chain checked, and
  // the pass being assembled. A push is taken when it arrives (design 7) and waits for `follow`.
  const ids = new Map(held?.ids);
  const zero = new Uint8Array(32);
  let checked = held?.checked ?? { n: 0, chain: zero as Bytes };
  let cursor = 0;
  let asked = 0;
  // Reads sent whose `position` has not come: while one is, a cut pass is the relay's normal way.
  let outstanding = 0;
  type Building = Pick<Pass, "read" | "incarnation" | "seals" | "items" | "problems"> & {
    from: number;
    covered: boolean;
  };
  let cur: Building | undefined;
  const start = (read: boolean, from: number, incarnation?: Bytes): Building =>
    (cur = {
      read,
      from,
      incarnation,
      seals: [],
      items: [],
      problems: [],
      covered: outstanding > 0,
    });
  const finish = (head: Of<"head">) => {
    const pass = cur ?? start(false, cursor);
    cur = undefined;
    const own = pass.problems;
    // A read from beyond the length is answered with no item and the head's own `n` (design 6.2).
    const end = pass.from + pass.items.length;
    if (pass.from <= head.n ? head.n !== end : pass.items.length > 0)
      own.push(`head names ${head.n}, not ${end}`);
    const signed: RelayHead = { relay: relayKeyId(platform, relay), n: head.n, chain: head.chain };
    if (!checkHead(platform, relay, signed, head.sig)) own.push("the head is not the relay's");
    // The chain goes on from the last one checked, never from 0 again (design 9: a thousand reads a seed).
    const base = checked.n <= head.n ? checked : { n: 0, chain: zero };
    let chain = base.chain;
    let chainChecked = true;
    for (let i = base.n; i < head.n && chainChecked; i++) {
      const x = ids.get(i);
      if (x) chain = chainLink(platform, chain, x);
      else chainChecked = false;
    }
    if (chainChecked && Buffer.from(chain).equals(head.chain)) checked = { n: head.n, chain };
    else if (chainChecked) own.push("the chain does not hold");
    cursor = end;
    // A push nobody takes is audited at the end of a run, so its problems are the link's too.
    if (!pass.read) problems.push(...own);
    return { type: "pass" as const, ...pass, head, chainChecked };
  };
  /** Takes the frames of a read or a push; false for a frame that is neither. */
  const assemble = (frame: Frame): boolean => {
    if (frame.type === "position") {
      // A read ends the follow before it at its next yield, which leaves a pass without its head: that is
      // dropped, unless no read was outstanding while the pass arrived (then the relay left it so).
      const cut = cur && !cur.read && cur.items.length + cur.seals.length > 0 && !cur.covered;
      outstanding = Math.max(0, outstanding - 1);
      start(true, frame.from, frame.incarnation);
      if (cut) cur?.problems.push("the pass before ended without its head");
      cursor = frame.from;
      if (frame.from !== asked) cur?.problems.push(`position names ${frame.from}, not ${asked}`);
    } else if (frame.type === "seals") {
      const b = cur ?? start(false, cursor);
      b.covered ||= outstanding > 0;
      if (b.items.length > 0) b.problems.push("seals after an item");
      b.seals.push(...frame.items);
    } else if (frame.type === "item") {
      const b = cur ?? start(false, cursor);
      b.covered ||= outstanding > 0;
      const at = b.from + b.items.length;
      if (frame.position !== at) b.problems.push(`item at ${frame.position}, expected ${at}`);
      if (!DECODERS[frame.kind](frame.signed).ok) b.problems.push(`item ${at} does not decode`);
      const item = { ...frame, id: signedId(platform, frame.signed) };
      const known = ids.get(frame.position);
      if (known && !Buffer.from(known).equals(item.id))
        b.problems.push(`item ${frame.position} differs from the one held`);
      ids.set(frame.position, item.id);
      b.items.push(item);
    } else if (frame.type === "head") push(finish(frame));
    else return false;
    return true;
  };
  const push = (o: Outcome) => {
    const w = waiting.findIndex((x) => x.accept(o));
    if (w >= 0) waiting.splice(w, 1)[0]?.resolve(o);
    else stream.push(o);
  };
  const end = (gone: Gone) => {
    closed = true;
    for (const p of new Set(pending.values())) p.done(gone);
    // What ended the connection ends every wait, whatever it wanted, and stays for the next one.
    stream.push(gone);
    for (const w of waiting.splice(0)) w.resolve(gone);
  };
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (!closed && buffer.length >= 4) {
      const size = frameLength(buffer.subarray(0, 4), proven);
      const bad = () => {
        socket.destroy();
        end({ type: "undecodable" });
      };
      if (!size.ok) return bad();
      if (buffer.length < 4 + size.value) return;
      const got = decodeFrame(buffer.subarray(0, 4 + size.value), proven, "device");
      buffer = buffer.subarray(4 + size.value);
      if (!got.ok) return bad();
      if (refused) problems.push(`${got.value.type} after refused`);
      refused ||= got.value.type === "refused";
      const frame = got.value;
      if (frame.type === "refused") for (const p of new Set(pending.values())) p.done(frame);
      if (!("request" in frame)) assemble(frame) || push(frame);
      else {
        const p = pending.get(frame.request);
        if (!p) late.push(frame);
        else {
          p.frames.push(frame);
          const last = frame.type === "blob" && frame.offset + frame.chunk.length >= frame.size;
          if (frame.type === "result" || last) p.done(p.frames);
        }
      }
    }
  });
  socket.once("close", () => {
    if (!closed) end({ type: "closed" });
  });

  /** The first outcome `accept` takes, or what ended the wait: `silent` after `ms`. */
  const take = (accept: (o: Outcome) => boolean, ms: number): Promise<Outcome> => {
    const at = stream.findIndex(accept);
    if (at >= 0) return Promise.resolve(stream.splice(at, 1)[0] as Outcome);
    if (closed) return Promise.resolve({ type: "closed" });
    return new Promise((resolve) => {
      const w = {
        accept,
        resolve: (o: Outcome) => {
          clearTimeout(timer);
          resolve(o);
        },
      };
      const timer = setTimeout(() => {
        waiting.splice(waiting.indexOf(w), 1);
        resolve({ type: "silent" });
      }, ms);
      waiting.push(w);
    });
  };
  /** The next frame the relay sent, or what ended the wait. */
  const next = (ms = patience) => take(() => true, ms);

  const hello = await next();
  if (hello.type !== "hello") {
    socket.destroy();
    throw new NoConnection("hello", `the relay opened with ${hello.type}`);
  }
  const session = {
    relay: relayKeyId(platform, relay),
    deviceNonce: platform.random(32),
    relayNonce: hello.relayNonce,
    binding: Uint8Array.from(socket.exportKeyingMaterial(32, EXPORTER_LABEL, Buffer.alloc(0))),
  };
  const sign = (name: string, bytes: Bytes) => {
    const sig = platform.sign(name, bytes);
    if (!sig.ok) throw new Error(`no key named ${name}`);
    return sig.value;
  };
  /** Sends `frame` as one of the link's state (`state` overrides it, for a step that sends what is out of state). */
  const send = (frame: Frame, state = proven) => void socket.write(encodeFrame(frame, state));
  let id = 0;
  /** Waits for the answer to requests `ids` (sent after this call): the first `result` of any, a blob's last chunk, or what ended the wait. */
  const track = (ids: number[], ms = patience) =>
    new Promise<Frame[] | Outcome>((resolve) => {
      if (closed) return resolve({ type: "closed" });
      const done = (r: Frame[] | Outcome) => {
        clearTimeout(timer);
        for (const i of ids) pending.delete(i);
        resolve(r);
      };
      const timer = setTimeout(() => done({ type: "silent" }), ms);
      for (const i of ids) pending.set(i, { frames: [], done });
    });
  const request = (make: (request: number) => Frame) => {
    const n = ++id;
    const answer = track([n]);
    send(make(n));
    return answer;
  };
  const result = async (answer: Promise<Frame[] | Outcome>) => {
    const got = await answer;
    return Array.isArray(got) ? (got.at(-1) as Of<"result">) : got;
  };
  /** The next pass of a read (`wantRead`) or of a follow, or what is not a pass: the other sort stays for its own wait. */
  const pass = (wantRead: boolean, ms: number) =>
    take((o) => o.type !== "pass" || o.read === wantRead, ms);
  const prove = (frame: Frame, ms?: number) => {
    send(frame);
    proven = true;
    return next(ms);
  };
  return {
    socket,
    problems,
    late,
    /** A `read` from `from`, taken whole; it starts a follow, whose pushes `follow` takes. */
    read(from = 0, ms = patience) {
      asked = from;
      outstanding++;
      if (cur) cur.covered = true;
      send({ type: "read", from });
      return pass(true, ms);
    },
    /** The next push of the follow, checked as a read is, from where the last head left off. */
    follow: (ms = patience) => pass(false, ms),
    next,
    /** What the link holds of the sequence, to hand to the next link of the same relay directory. */
    held: (): Held => ({ ids: new Map(ids), checked }),
    send,
    close: () => socket.destroy(),
    /**
     * One round trip, so that every frame the relay sent before its answer is in `stream`, `late` or `problems`
     * (the relay answers in order): a `read` from 0, awaited until its pass, a `refused` or the close.
     * A frame that comes first is kept for `unread`. Then the link is closed. Known limit: on a recovery or
     * upload connection the relay answers a `read` by destroying the socket, so frames still buffered there may be lost.
     */
    async settle(ms = patience) {
      if (!closed) {
        // What is queued already was sent before the read: it is unread, whatever it is, but a follow's pass and the close.
        for (let i = stream.length - 1; i >= 0; i--) {
          const o = stream[i] as Outcome;
          if (o.type === "closed" || (o.type === "pass" && !o.read)) continue;
          strays.unshift(...stream.splice(i, 1));
        }
        asked = 0;
        outstanding++;
        if (cur) cur.covered = true;
        send({ type: "read", from: 0 });
        for (;;) {
          const o = await take(() => true, ms);
          if (o.type === "pass" && o.read) {
            problems.push(...o.problems);
            break;
          }
          if (["closed", "silent", "undecodable", "refused"].includes(o.type)) break;
          if (o.type !== "pass") strays.push(o);
        }
      }
      socket.destroy();
    },
    /** Frames that came and nobody took, but a follow's passes, which a script need not read. */
    unread: () => [...stream.filter((o) => o.type !== "pass" && o.type !== "closed"), ...strays],
    enrol: (secret: Bytes, genesis: { signed: Bytes; sig: Bytes }) =>
      send({ type: "enrol", secret, ...genesis }),
    /** `prove active` signed by the platform key `by`; the relay's answer (`served`, or a `refused`). */
    proveActive(person: Bytes, device: Bytes, by: string, ms?: number) {
      const proof: Proof = { kind: "active", ...session, person, device };
      return prove({ type: "prove-active", proof, sig: sign(by, encodeProof(proof)) }, ms);
    },
    /** `prove recovery`: the recovery key signs, and so does the new device's own key. */
    proveRecovery(
      person: Bytes,
      recovery: { id: Bytes; sign: string },
      newDevice: { device: DeviceKeys; sign: string },
      ms?: number,
    ) {
      const proof: Proof = {
        kind: "recovery",
        ...session,
        person,
        recovery: recovery.id,
        newDevice: newDevice.device,
      };
      const bytes = encodeProof(proof);
      return prove(
        {
          type: "prove-recovery",
          proof,
          recoverySig: sign(recovery.sign, bytes),
          deviceSig: sign(newDevice.sign, bytes),
        },
        ms,
      );
    },
    /** `prove upload`: a device's own key over the proof, and the relay's signature over the head it names. */
    proveUpload(
      device: { device: DeviceKeys; sign: string },
      head: RelayHead,
      relaySig: Bytes,
      ms?: number,
    ) {
      const proof: Proof = { kind: "upload", ...session, device: device.device, head };
      return prove(
        {
          type: "prove-upload",
          proof,
          deviceSig: sign(device.sign, encodeProof(proof)),
          relaySig,
        },
        ms,
      );
    },
    submit: (kind: 1 | 2 | 3 | 4, e: { signed: Bytes; sig: Bytes }) =>
      result(request((n) => ({ type: "submit", request: n, kind, ...e }))),
    giveSeal: (seal: Of<"give-seal">["seal"], sig: Bytes) =>
      result(request((n) => ({ type: "give-seal", request: n, seal, sig }))),
    /**
     * A blob in chunks of `chunk` bytes. The relay answers the last chunk, or the first that settles the
     * put (a blob it holds, a refusal), and no chunk after that; the answer is the first `result` of any
     * chunk, and a later one is in `late`. `size` is what the frames claim (the bytes' length unless a step lies).
     */
    putBlob(blob: Bytes, bytes: Bytes, chunk = 1024, size = bytes.length) {
      const offsets = Array.from(
        { length: Math.max(1, Math.ceil(bytes.length / chunk)) },
        (_, i) => i * chunk,
      );
      const ids = offsets.map(() => ++id);
      const answer = track(ids);
      offsets.forEach((offset, i) => {
        send({
          type: "put-blob",
          request: ids[i] as number,
          blob,
          size,
          offset,
          chunk: bytes.subarray(offset, offset + chunk),
        });
      });
      return result(answer);
    },
    /** The blob's chunks gathered from `offset`, or the `result` that refused it. */
    async getBlob(blob: Bytes, offset = 0) {
      const got = await request((n) => ({ type: "get-blob", request: n, blob, offset }));
      if (!Array.isArray(got)) return got;
      const last = got.at(-1) as Of<"result"> | Of<"blob">;
      if (last.type === "result") return last;
      const chunks = got.filter((f): f is Of<"blob"> => f.type === "blob");
      return { type: "blob" as const, bytes: Buffer.concat(chunks.map((c) => c.chunk)) };
    },
    /** The person's device log as the relay sends it, and the code that closed it; a `refused` ends it too. */
    async recoveryLog() {
      const got = await request((n) => ({ type: "recovery-log", request: n }));
      if (!Array.isArray(got)) return got;
      const entries = got.filter((f): f is Of<"log"> => f.type === "log").flatMap((f) => f.entries);
      return { type: "recovered" as const, entries, code: (got.at(-1) as Of<"result">).code };
    },
    uploadDone: (head: Of<"upload-done">["head"], sig: Bytes) =>
      result(request((n) => ({ type: "upload-done", request: n, head, sig }))),
  };
}
export type Link = Awaited<ReturnType<typeof dial>>;
