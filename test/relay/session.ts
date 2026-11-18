/**
 * A relay's sessions driven without a network: each fake connection is a `Peer` that records what
 * it was sent, and the rounds are the ones of `world.ts`, which a test holds with `r.pending.hold`.
 * The TLS server and the frame reader are tested in `transport.test.ts`; what a frame means is the
 * session's, and these tests are about that.
 */
import assert from "node:assert/strict";
import { openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createNodePlatform } from "../../src/platform-node/platform.ts";
import { encodeFrame, type Frame } from "../../src/protocol/frames.ts";
import { encodeHead, encodeProof, type RelayHead } from "../../src/protocol/proofs.ts";
import { Blobs } from "../../src/relay/blobs.ts";
import { relaySigner } from "../../src/relay/directory.ts";
import { FIGURES, Limits } from "../../src/relay/limits.ts";
import { Proofs } from "../../src/relay/proofs.ts";
import { Seals } from "../../src/relay/seals.ts";
import type { Peer } from "../../src/relay/server.ts";
import { openAppending, platform, tick, track } from "./support.ts";
import { fill, type Keyed, type Person, type rig } from "./world.ts";

type Rig = Awaited<ReturnType<typeof rig>>;

/** Lets the microtasks and the immediates a round and a slice of items schedule run. */
export const settle = async () => {
  for (let i = 0; i < 4; i++) await tick();
};

/** The relay of `r` as `serve` builds it, without a socket. */
export async function relayOver<R extends Rig>(
  r: R,
  figures: Partial<typeof FIGURES> = {},
  given?: Blobs,
) {
  const blobs = given ?? new Blobs(platform, r.s.rounds, r.s.seam, join(r.dir, "blobs"));
  blobs.start(r.seq);
  const limits = new Limits(Date.now, { ...FIGURES, ...figures });
  const seals = await Seals.open(
    platform,
    r.s.rounds,
    r.seq,
    openAppending(join(r.dir, "seals")),
    r.relay,
  );
  const lock = track(openSync(r.dir, "r"));
  const proofs = new Proofs({
    platform,
    relayPublic: r.publicKey,
    limits,
    log: r.s.log,
    serving: {
      seq: r.seq,
      journal: r.journal,
      rounds: r.s.rounds,
      seam: r.s.seam,
      dir: r.dir,
      lock,
      incarnation: fill(7, 16),
      seals,
      blobs,
    },
  });
  const signHead = relaySigner(createNodePlatform(), readFileSync(join(r.dir, "key.pem")));
  const headOf = (n: number, chain?: Uint8Array) => {
    const head: RelayHead = {
      relay: r.relay,
      n,
      chain: chain ?? (n === 0 ? fill(0) : (r.journal.placed[n - 1]?.chain as Uint8Array)),
    };
    return { head, sig: signHead(encodeHead(head)) };
  };

  let connections = 0;
  /** What the relay wrote on every connection, in order, as `c1:result`. */
  const order: string[] = [];
  /** A device's connection: `sent` is what the relay wrote to it, in order. */
  const connect = () => {
    const label = `c${++connections}`;
    const sent: Frame[] = [];
    const calls = { pause: 0, resume: 0, closed: false };
    const drains: (() => void)[] = [];
    const behind = {
      writable: true,
      stalled: false,
      paused: false,
      broken: false,
      /** The count of frames sent at which the socket says it is full. */
      fillAt: undefined as number | undefined,
    };
    /** What the server would not have read yet: it stops reading from the write that filled the socket. */
    const unread: Frame[] = [];
    const held = limits.open("127.0.0.1", () => {});
    assert.ok(held);
    const peer: Peer = {
      remote: "127.0.0.1",
      held,
      nonce: fill(1, 32),
      binding: fill(2, 32),
      allow: () => {},
      send: (frame) => {
        if (behind.broken)
          throw Object.assign(new Error("write"), { code: "EPIPE", syscall: "write" });
        // The server encodes what it writes: a frame past the limit throws there, and so here.
        encodeFrame(frame, true);
        sent.push(frame);
        order.push(`${label}:${frame.type}`);
        if (sent.length === behind.fillAt) behind.writable = false;
        if (!behind.writable) behind.stalled = true;
        return behind.writable;
      },
      end: (frame) => {
        sent.push(frame);
        order.push(`${label}:${frame.type}`);
        calls.closed = true;
      },
      close: () => {
        calls.closed = true;
      },
      pause: () => {
        calls.pause++;
        behind.paused = true;
      },
      resume: () => {
        calls.resume++;
        order.push(`${label}:resume`);
        behind.paused = false;
        reading();
      },
      drain: (fn) => {
        drains.push(fn);
      },
    };
    limits.hello(held);
    const session = proofs.session(peer);
    /** The frames the server read and holds: it hands them over once nothing holds its reading. */
    const reading = () => {
      while (!behind.stalled && !behind.paused && unread.length > 0)
        session.frame(unread.shift() as Frame);
    };
    const proof = <T extends object>(over: T) => ({
      relay: r.relay,
      deviceNonce: fill(3),
      relayNonce: peer.nonce,
      binding: peer.binding,
      ...over,
    });
    const device = {
      sent,
      calls,
      session,
      /** The types of what was sent, from `from`. */
      types: (from = 0) => sent.slice(from).map((f) => f.type),
      /** The relay's socket buffer is full: `send` says so, until `flush`. */
      block: () => {
        behind.writable = false;
      },
      /** The buffer fills with the `n`th frame sent from now on. */
      blockAfter: (n: number) => {
        behind.fillAt = sent.length + n;
      },
      /** The buffer drained: what waited for `'drain'` goes on, and the frames the server held are read. */
      flush: async () => {
        behind.writable = true;
        behind.stalled = false;
        for (const fn of drains.splice(0)) fn();
        reading();
        await settle();
      },
      /** Every later `send` throws, as a socket that broke would. */
      breakSend: () => {
        behind.broken = true;
      },
      drains: () => drains.length,
      /** A frame as the server hands it: not at all while the last write is still queued or it is paused (4.5). */
      frame: (f: Frame) => {
        if (!behind.stalled && !behind.paused) return session.frame(f);
        unread.push(f);
        return true;
      },
      /** The `prove active` frame of `by`, which a second proof on a served connection repeats. */
      proveFrame(by: Keyed, of: Person): Frame {
        const p = proof({ kind: "active" as const, person: of.id, device: by.id });
        const sig = platform.sign(by.sign, encodeProof(p));
        assert.ok(sig.ok);
        return { type: "prove-active", proof: p, sig: sig.value };
      },
      /** `prove active`, then the round the answer waits for. */
      async prove(by: Keyed, of: Person) {
        assert.equal(session.frame(device.proveFrame(by, of)), true);
        await settle();
        const first = sent.at(-1);
        assert.equal(first?.type, "served", "the proof is served");
        return device;
      },
      /** `prove recovery` with the person's recovery key, naming `fresh` as the new device. */
      async recover(fresh: Keyed, of: Person) {
        const p = proof({
          kind: "recovery" as const,
          person: of.id,
          recovery: of.recovery.recoveryId,
          newDevice: fresh.device,
        });
        const bytes = encodeProof(p);
        const sigs = [of.recovery, fresh].map((k) => platform.sign(k.sign, bytes));
        assert.ok(sigs[0]?.ok && sigs[1]?.ok);
        const frame: Frame = {
          type: "prove-recovery",
          proof: p,
          recoverySig: sigs[0].value,
          deviceSig: sigs[1].value,
        };
        assert.equal(session.frame(frame), true);
        return device;
      },
      /** `prove upload` of `by` with `head`, which the relay signed as `relaySig`. */
      upload(by: Keyed, head: RelayHead, relaySig: Uint8Array) {
        const p = proof({ kind: "upload" as const, device: by.device, head });
        const sig = platform.sign(by.sign, encodeProof(p));
        assert.ok(sig.ok);
        const frame: Frame = { type: "prove-upload", proof: p, deviceSig: sig.value, relaySig };
        assert.equal(session.frame(frame), true);
        return device;
      },
      closed: () => session.closed(),
    };
    return device;
  };
  return { ...r, limits, proofs, seals, blobs, headOf, connect, signHead, order };
}
export type Relay = Awaited<ReturnType<typeof relayOver>>;
export type Device = ReturnType<Relay["connect"]>;

/** Holds the next round, and returns what releases it. */
export function hold(r: Rig) {
  r.pending.hold = true;
  return async () => {
    await settle();
    r.pending.hold = false;
    r.pending.release?.();
    await settle();
  };
}
