import { bytesEqual, decode, isBytes, refuse, Writer } from "./bytes.ts";
import { activeDevices, idKey, type LoggedEntry } from "./device-log.ts";
import { signedId } from "./ids.ts";
import type { Bytes, Platform } from "./platform.ts";
import type { Result } from "./result.ts";

export type MemberRole = "member" | "admin";

/** A member-log entry (design 6.2); `channel` and `prev` are absent exactly at `seq` 0. */
export type MemberEntry = {
  channel?: Bytes | undefined;
  seq: number;
  prev?: Bytes | undefined;
  signerPerson: Bytes;
  signerDevice: Bytes;
} & MemberBody;

/** What an entry does, by its kind: `add` invites, `accept` joins, `role` is "set role". */
type MemberBody =
  | { kind: "create"; nonce: Bytes }
  | { kind: "add"; person: Bytes; role: MemberRole }
  | { kind: "accept" }
  | { kind: "remove"; person: Bytes }
  | { kind: "role"; person: Bytes; role: MemberRole };

/**
 * An entry the log holds: its id is SHA-256 of its signed bytes; entry 0's id is the channel id.
 * `changesMembers` is whether it makes or removes a member (security design 4, "set-changing"):
 * an accept, or a remove of a member; a remove of an invited person withdraws the invitation and
 * changes no set. The check computes it from the state it used. `space` is whether it is the entry
 * 0 of a person's space (personal space design 2.3): the class of a channel, read from that entry alone.
 */
export interface LoggedMember {
  entry: MemberEntry;
  id: Bytes;
  changesMembers: boolean;
  space: boolean;
}

/** Why an entry may not follow a log: `decode` is the structure, the rest are security design 4's rules. */
export type MemberRule =
  | "decode"
  | "device"
  | "signature"
  | "position"
  | "prev"
  | "channel"
  | "authority"
  | "member"
  | "accept"
  | "last admin";

export type MemberVerdict = { ok: true; value: LoggedMember } | { ok: false; rule: MemberRule };

const KINDS = ["create", "add", "accept", "remove", "role"] as const;
const ROLES = ["member", "admin"] as const;
const writeRole = (w: Writer, role: MemberRole): Writer => {
  const n = ROLES.indexOf(role);
  if (n < 0) throw new RangeError("a role is member or admin");
  return w.u8(n);
};

/** The signed bytes of an entry, label first, signature excluded; a value outside its field throws. */
export function encodeMemberEntry(e: MemberEntry): Bytes {
  const first = e.seq === 0;
  if ((e.kind === "create") !== first || (e.channel === undefined) !== first)
    throw new RangeError("seq 0 is create and has no channel; any other entry has one");
  if ((e.prev === undefined) !== first)
    throw new RangeError("seq 0 has no prev; any other has one");
  const w = new Writer().label("member-entry");
  w.opt(e.channel, (x, v) => x.b32(v)).u64(e.seq);
  w.opt(e.prev, (x, v) => x.b32(v)).u8(KINDS.indexOf(e.kind));
  if (e.kind === "create") w.b16(e.nonce);
  if (e.kind === "add" || e.kind === "role") writeRole(w.b32(e.person), e.role);
  if (e.kind === "remove") w.b32(e.person);
  return w.b32(e.signerPerson).b32(e.signerDevice).bytes();
}

/** Reads an entry; `seq` 0 is create and has no channel and no prev, any other entry has both. */
export function decodeMemberEntry(bytes: Bytes): Result<MemberEntry> {
  return decode(bytes, (r) => {
    r.label("member-entry");
    const channel = r.opt((x) => x.b32());
    const seq = r.u64();
    const prev = r.opt((x) => x.b32());
    const kind = KINDS[r.u8()];
    if (kind === undefined || (kind === "create") !== (seq === 0)) refuse();
    if ((channel === undefined) !== (seq === 0) || (prev === undefined) !== (seq === 0)) refuse();
    const role = (): MemberRole => {
      const n = r.u8();
      if (n > 1) refuse();
      return ROLES[n] as MemberRole;
    };
    const head = { channel, seq, prev };
    let entry: MemberBody & { channel?: Bytes | undefined; seq: number; prev?: Bytes | undefined };
    if (kind === "create") entry = { ...head, kind, nonce: r.b16() };
    else if (kind === "add") entry = { ...head, kind, person: r.b32(), role: role() };
    else if (kind === "accept") entry = { ...head, kind };
    else if (kind === "remove") entry = { ...head, kind, person: r.b32() };
    else entry = { ...head, kind, person: r.b32(), role: role() };
    return { ...entry, signerPerson: r.b32(), signerDevice: r.b32() } as MemberEntry;
  });
}

/** The nonce of the entry 0 of `person`'s space: the first 16 bytes of SHA-256 of its label and the person (personal space design 2.1). */
export const spaceNonce = (platform: Platform, person: Bytes): Bytes =>
  platform.sha256(new Writer().label("personal-space").b32(person).bytes()).slice(0, 16);

/** Whether `e` is the entry 0 of a space: a create whose nonce is the space nonce of its own signer's person (design 2.3). */
export const isSpaceEntry = (platform: Platform, e: MemberEntry): boolean =>
  e.kind === "create" && bytesEqual(e.nonce, spaceNonce(platform, e.signerPerson));

/** Who belongs to a channel with which role, and who is invited and has not accepted. */
interface State {
  members: Map<string, MemberRole>;
  invited: Map<string, MemberRole>;
}

function stateOf(log: readonly LoggedMember[]): State {
  const s: State = { members: new Map(), invited: new Map() };
  for (const { entry: e } of log) {
    if (e.kind === "create") s.members.set(idKey(e.signerPerson), "admin");
    if (e.kind === "add") s.invited.set(idKey(e.person), e.role);
    if (e.kind === "accept") {
      const who = idKey(e.signerPerson);
      s.members.set(who, s.invited.get(who) as MemberRole);
      s.invited.delete(who);
    }
    if (e.kind === "remove") {
      s.members.delete(idKey(e.person));
      s.invited.delete(idKey(e.person));
    }
    if (e.kind === "role") s.members.set(idKey(e.person), e.role);
  }
  return s;
}

/**
 * The persons who are members after a log, by `idKey` of their ids. In a space no entry after entry
 * 0 changes who is a member, so its person alone is: an entry an older relay placed there is folded
 * and changes nothing (personal space design 2.5).
 */
export const membersOf = (log: readonly LoggedMember[]): Set<string> =>
  log[0]?.space
    ? new Set([idKey(log[0].entry.signerPerson)])
    : new Set(stateOf(log).members.keys());

/**
 * Whether `signed` with `signature` may follow `log` (security design 4): the structure, then the
 * signer's device, then the signature, then the rules. `devices` is the signing person's device
 * log, checked entries only, as it stands at this entry's place in the relay's sequence; the
 * caller passes the log of the person the entry names. `signer-person` must be that log's entry 0
 * id and `signer-device` an active device in it, and its signing key verifies the signature.
 * Each failure names its rule; nothing throws on another party's bytes.
 */
export function checkMemberEntry(
  platform: Platform,
  log: readonly LoggedMember[],
  signed: Bytes,
  signature: Bytes,
  devices: readonly LoggedEntry[],
): MemberVerdict {
  const decoded = decodeMemberEntry(signed);
  if (!decoded.ok) return { ok: false, rule: "decode" };
  const e = decoded.value;
  const fail = (rule: MemberRule): MemberVerdict => ({ ok: false, rule });
  const first = Array.isArray(devices) ? devices[0] : undefined;
  const signer =
    first && bytesEqual(e.signerPerson, first.id)
      ? activeDevices(platform, devices).get(idKey(e.signerDevice))
      : undefined;
  if (!signer) return fail("device");
  if (
    !isBytes(signature) ||
    signature.length !== 64 ||
    !platform.verify(signer.signing, signed, signature)
  )
    return fail("signature");
  if (e.seq !== log.length) return fail("position");
  const logged = (changesMembers: boolean): MemberVerdict => ({
    ok: true,
    value: {
      entry: e,
      id: signedId(platform, signed),
      changesMembers,
      space: isSpaceEntry(platform, e),
    },
  });
  if (e.kind === "create") return logged(false);
  const last = log.at(-1) as LoggedMember;
  if (!e.prev || !bytesEqual(e.prev, last.id)) return fail("prev");
  if (!e.channel || !bytesEqual(e.channel, (log[0] as LoggedMember).id)) return fail("channel");
  const s = stateOf(log);
  const who = idKey(e.signerPerson);
  if (e.kind === "accept") return s.invited.has(who) ? logged(true) : fail("accept");
  if (s.members.get(who) !== "admin") return fail("authority");
  const target = idKey(e.person);
  if (e.kind === "add")
    return s.members.has(target) || s.invited.has(target) ? fail("member") : logged(false);
  const held = s.members.get(target);
  if (held === undefined)
    return e.kind === "remove" && s.invited.has(target) ? logged(false) : fail("member");
  const admins = [...s.members.values()].filter((r) => r === "admin").length;
  if (e.kind === "role" && held === e.role) return fail("member");
  const loses = held === "admin" && (e.kind === "remove" || e.role !== "admin");
  return loses && admins === 1 ? fail("last admin") : logged(e.kind === "remove");
}
