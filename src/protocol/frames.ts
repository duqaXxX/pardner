import { decode, isBytes, type Reader, refuse, Writer } from "./bytes.ts";
import { type HistorySeal, readHistorySeal, writeHistorySeal } from "./epochs.ts";
import type { Bytes } from "./platform.ts";
import {
  type Proof,
  type ProofKind,
  type RelayHead,
  readHead,
  readProof,
  writeHead,
  writeProof,
} from "./proofs.ts";
import { fail, type Result } from "./result.ts";

/** The codes of a field that names one of a few (design 6.7); a retired one is left out and never reused. */
const ALLOWED = {
  kind: [1, 2, 3, 4], // device entry, member entry, epoch entry, message
  reason: [1, 2, 3, 5, 6],
  code: [0, 1, 2, 3, 4, 5, 7, 8, 9, 11],
} as const;
const codesOf = (type: string): readonly number[] | undefined =>
  Object.hasOwn(ALLOWED, type) ? (ALLOWED as Record<string, readonly number[]>)[type] : undefined;

/**
 * Every frame of design 6.7 by name: its code, then its fields after the type byte as `name:type`.
 * `name[]` opens a list, whose row is the fields after it.
 */
const SPEC = {
  hello: [0x40, "relayNonce:b32"],
  "prove-active": [0x01, "proof:proof-active sig:sig"],
  "prove-recovery": [0x02, "proof:proof-recovery recoverySig:sig deviceSig:sig"],
  "prove-upload": [0x0a, "proof:proof-upload deviceSig:sig relaySig:sig"],
  refused: [0x48, "reason:reason"],
  served: [0x41, "incarnation:b16"],
  read: [0x03, "from:u64"],
  position: [0x42, "from:u64 incarnation:b16"],
  head: [0x49, "n:u64 chain:b32 sig:sig"],
  item: [0x43, "position:u64 kind:kind signed:var sig:sig"],
  submit: [0x04, "request:u32 kind:kind signed:var sig:sig"],
  result: [0x44, "request:u32 code:code"],
  "give-seal": [0x05, "request:u32 seal:seal sig:sig"],
  seals: [0x45, "items[] seal:seal sig:sig"],
  "put-blob": [0x06, "request:u32 blob:b32 size:u64 offset:u64 chunk:var"],
  "get-blob": [0x07, "request:u32 blob:b32 offset:u64"],
  blob: [0x46, "request:u32 size:u64 offset:u64 chunk:var"],
  "recovery-log": [0x08, "request:u32"],
  log: [0x47, "request:u32 entries[] signed:var sig:sig"],
  // 0x09 was `upload-items`: retired, never reused.
  "upload-done": [0x0c, "request:u32 head:head sig:sig"],
  enrol: [0x0d, "secret:b32 signed:var sig:sig"],
} as const;
type Name = keyof typeof SPEC;

type Values = Record<"u32" | "u64", number> & {
  [K in keyof typeof ALLOWED]: (typeof ALLOWED)[K][number];
} & Record<"b16" | "b32" | "var" | "sig", Bytes> & { seal: HistorySeal; head: RelayHead } & {
    [K in ProofKind as `proof-${K}`]: Extract<Proof, { kind: K }>;
  };
type One<F> = F extends `${infer N}:${infer T}`
  ? { [K in N]: T extends keyof Values ? Values[T] : never }
  : never;
type Fields<S extends string> = S extends `${infer F} ${infer R}`
  ? F extends `${infer N}[]`
    ? { [K in N]: Fields<R>[] }
    : One<F> & Fields<R>
  : One<S>;

export type Frame = { [N in Name]: { type: N } & Fields<(typeof SPEC)[N][1]> }[Name];

type Field = readonly [name: string, type: string | readonly Field[]];
type Row = Record<string, unknown>;
const atomOf = (type: string) => (codesOf(type) ? "u8" : type) as Atom;
const ATOMS = ["u8", "u32", "u64", "b16", "b32", "var", "sig", "seal", "head"];
const known = (type: string) =>
  ATOMS.includes(type) ||
  Object.hasOwn(ALLOWED, type) ||
  /^proof-(active|recovery|upload)$/.test(type);
const parse = (tokens: string[]): Field[] => {
  const list = tokens.findIndex((t) => t.endsWith("[]"));
  const plain = (list < 0 ? tokens : tokens.slice(0, list)).map((t): Field => {
    const [name, type] = t.split(":") as [string, string];
    if (!known(type)) throw new TypeError(`unknown field type ${type}`);
    return [name, type];
  });
  return list < 0
    ? plain
    : [...plain, [(tokens[list] as string).slice(0, -2), parse(tokens.slice(list + 1))]];
};
const FIELDS = Object.fromEntries(
  Object.entries(SPEC).map(([n, [, s]]) => [n, parse(s.split(" "))]),
);
/** Type codes that were frames once and are never reused (design 6.7). */
const RETIRED: ReadonlySet<number> = new Set([0x09]); // upload-items
/** Maps each code of a spec to its name; throws on a code in `retired`. */
export const namesOf = (
  spec: Record<string, readonly [number, string]>,
  retired: ReadonlySet<number>,
): Map<number, string> =>
  new Map(
    Object.entries(spec).map(([name, [code]]) => {
      if (retired.has(code)) throw new RangeError(`type code ${code} is retired`);
      return [code, name];
    }),
  );
const NAMES = namesOf(SPEC, RETIRED) as Map<number, Name>;
/** The handshake frames cross before a proof and never after it; `refused` crosses at both times (design 6.7). */
const HANDSHAKE = ["hello", "prove-active", "prove-recovery", "prove-upload", "enrol"];
const crosses = (name: string, proven: boolean) =>
  proven ? !HANDSHAKE.includes(name) : HANDSHAKE.includes(name) || name === "refused";
const limit = (proven: boolean) => (proven ? 1_048_576 : 4096); // after a proof: a proposal
type Atom = "u8" | "u32" | "u64" | "b16" | "b32" | "var" | "sig";

const putAll = (w: Writer, fields: readonly Field[], row: Row): Writer => {
  for (const [name, type] of fields) {
    const v = row[name];
    if (typeof type !== "string") w.list(v as Row[], (x, item) => putAll(x, type, item));
    else if (codesOf(type) && !codesOf(type)?.includes(v as number))
      throw new RangeError(`not a ${type} of the protocol`);
    else if (type === "seal") writeHistorySeal(w, v as HistorySeal);
    else if (type === "head") writeHead(w, v as RelayHead);
    else if (type.startsWith("proof-")) {
      if ((v as Proof).kind !== type.slice(6)) throw new RangeError("a proof of another kind");
      writeProof(w, v as Proof);
    } else (w as unknown as Record<Atom, (value: unknown) => Writer>)[atomOf(type)](v);
  }
  return w;
};

function takeAll(r: Reader, fields: readonly Field[]): Row {
  const row: Row = {};
  for (const [name, type] of fields) {
    if (typeof type !== "string") row[name] = r.list((x) => takeAll(x, type));
    else if (type === "seal") row[name] = readHistorySeal(r);
    else if (type === "head") row[name] = readHead(r);
    else if (type.startsWith("proof-")) row[name] = readProof(r, type.slice(6) as ProofKind);
    else {
      row[name] = (r as unknown as Record<Atom, () => unknown>)[atomOf(type)]();
      if (codesOf(type) && !codesOf(type)?.includes(row[name] as number)) refuse();
    }
  }
  return row;
}

/** A frame's bytes: its `u32` length, its type, its fields. A frame past the limit, one that does not cross in this state, or a value outside its field throws. */
export function encodeFrame(frame: Frame, proven: boolean): Bytes {
  if (!Object.hasOwn(SPEC, frame.type) || !crosses(frame.type, proven))
    throw new RangeError("not a frame type, or one that does not cross now");
  const body = putAll(new Writer().u8(SPEC[frame.type][0]), FIELDS[frame.type] as Field[], frame);
  const bytes = body.bytes();
  if (bytes.length > limit(proven)) throw new RangeError("a frame past its limit");
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
}

/** The body's length from a frame's first four bytes: zero, or past the limit, refuses before the body is read. */
export function frameLength(prefix: Bytes, proven: boolean): Result<number> {
  const length = decode(prefix, (r) => r.u32());
  return length.ok && length.value >= 1 && length.value <= limit(proven)
    ? length
    : fail("bad-input");
}

/** The side that reads a frame: a device reads the relay's types, the relay a device's. */
export type Side = "device" | "relay";

/**
 * Reads one whole frame as `reader`; a retired code, an unknown type, a type the other side does not
 * send or one that does not cross in this state refuses.
 */
export function decodeFrame(bytes: Bytes, proven: boolean, reader: Side): Result<Frame> {
  if (!isBytes(bytes)) return fail("bad-input");
  const size = frameLength(bytes.subarray(0, 4), proven);
  if (!size.ok || bytes.length !== 4 + size.value) return fail("bad-input");
  return decode(bytes.subarray(4), (r) => {
    const code = r.u8();
    const type = NAMES.get(code);
    if (type === undefined || !crosses(type, proven) || code >= 0x40 !== (reader === "device"))
      refuse();
    return { type, ...takeAll(r, FIELDS[type as Name] as Field[]) } as Frame;
  });
}

/** Whether the relay sends this frame: the types from 0x40 on (design 6.7); a type not in the table is no one's. */
export const fromRelay = (frame: Frame): boolean =>
  Object.hasOwn(SPEC, frame.type) && SPEC[frame.type][0] >= 0x40;
