/** The pairing string (device pairing design 3.1, 3.2, 3.4) on real keys and real signatures. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createNodePlatform } from "../../src/platform-node/platform.ts";
import type { DeviceKeys } from "../../src/protocol/device-log.ts";
import { deviceId } from "../../src/protocol/ids.ts";
import {
  checkPairingName,
  checkPairingProof,
  decodePairingString,
  encodePairingString,
  inspectPairingString,
  makePairingProof,
  pairingString,
  shortForm,
} from "../../src/protocol/pairing-string.ts";
import { makeProof } from "./proof.ts";

const platform = createNodePlatform();
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
let counter = 0;

/** A device whose keys the platform holds, its person id and its proof for that person. */
function made(kind: "app" | "bot" = "app") {
  const n = counter++;
  const signing = platform.makeKeyPair(`pair.${n}.s`, "sign");
  const receiving = platform.makeKeyPair(`pair.${n}.r`, "receive");
  assert.ok(signing.ok && receiving.ok);
  const device: DeviceKeys = { kind, signing: signing.value, receiving: receiving.value };
  const person = platform.random(32);
  return {
    device,
    person,
    name: `pair.${n}.s`,
    proof: makeProof(platform, `pair.${n}.s`, person, device),
  };
}

/** The string's bytes with `edit` applied, as hex, for a refusal that needs a hand-made string. */
const raw = (made1: ReturnType<typeof made>, name: Uint8Array) =>
  encodePairingString(platform, made1.device, made1.proof, "x").slice(0, -2) + hex(name);

test("a string round-trips the device, the proof and the name", () => {
  const m = made("bot");
  const text = encodePairingString(platform, m.device, m.proof, "Studio Mac é 漢");
  assert.match(text, /^[0-9a-f]+$/);
  const back = decodePairingString(platform, text);
  assert.ok(back.ok);
  assert.deepEqual(back.value.device, m.device);
  assert.equal(hex(back.value.proof), hex(m.proof));
  assert.equal(back.value.name, "Studio Mac é 漢");
});

test("surrounding whitespace is trimmed and nothing else", () => {
  const m = made();
  const text = encodePairingString(platform, m.device, m.proof, "Mac");
  assert.ok(decodePairingString(platform, `  ${text}\n`).ok);
  assert.ok(!decodePairingString(platform, `${text.slice(0, 10)} ${text.slice(10)}`).ok);
});

test("a string that is not hex, or has an odd length, or is empty, is refused", () => {
  const m = made();
  const text = encodePairingString(platform, m.device, m.proof, "Mac");
  assert.ok(!decodePairingString(platform, `${text.slice(0, -2)}zz`).ok);
  assert.ok(!decodePairingString(platform, text.slice(0, -1)).ok);
  assert.ok(!decodePairingString(platform, "").ok);
});

test("a device that does not decode, or a short proof, is refused", () => {
  const m = made();
  const text = encodePairingString(platform, m.device, m.proof, "Mac");
  assert.ok(!decodePairingString(platform, `03${text.slice(2)}`).ok); // a kind byte that is neither
  assert.ok(!decodePairingString(platform, `${text.slice(0, 2)}05${text.slice(4)}`).ok); // a key not starting with 4
  assert.ok(!decodePairingString(platform, text.slice(0, 2 * (1 + 130 + 63))).ok); // 63 bytes of proof
});

test("a name that is empty, past 64 bytes or not UTF-8 is refused", () => {
  const m = made();
  assert.ok(!decodePairingString(platform, raw(m, new Uint8Array(0))).ok);
  assert.ok(decodePairingString(platform, raw(m, new Uint8Array(64).fill(0x61))).ok);
  assert.ok(!decodePairingString(platform, raw(m, new Uint8Array(65).fill(0x61))).ok);
  assert.ok(!decodePairingString(platform, raw(m, Uint8Array.of(0xff, 0xfe))).ok);
  assert.ok(!decodePairingString(platform, raw(m, Uint8Array.of(0xc3))).ok); // a cut character
});

test("a name with a control, an invisible or bidirectional format character, or a line or paragraph separator is refused", () => {
  const m = made();
  for (const [what, char] of [
    ["Cc", "\u0007"],
    ["Cf", "‮"],
    ["Zl", " "],
    ["Zp", " "],
    ["zero width space", "\u200b"],
    ["right-to-left mark", "\u200f"],
    ["right-to-left isolate", "\u2067"],
    ["byte order mark", "\ufeff"],
    ["tag", "\u{e0041}"],
    ["soft hyphen", "\u00ad"],
    ["combining grapheme joiner", "\u034f"],
    ["Hangul filler", "\u3164"],
    ["halfwidth Hangul filler", "\uffa0"],
    ["variation selector", "\ufe0f"],
    ["shorthand format control", "\u{1bca0}"],
    ["musical format control", "\u{1d173}"],
    ["variation selector supplement", "\u{e0100}"],
  ] as const) {
    const name = `Mac${char}`;
    assert.ok(!checkPairingName(platform, name), what);
    assert.throws(() => encodePairingString(platform, m.device, m.proof, name), RangeError, what);
    assert.ok(!decodePairingString(platform, raw(m, platform.utf8Encode(name))).ok, what);
  }
  assert.ok(!checkPairingName(platform, "")); // empty
  assert.ok(!checkPairingName(platform, "a".repeat(65)));
  assert.ok(!checkPairingName(platform, "\ud800")); // a lone surrogate would travel as U+FFFD
  for (const name of [" Mac", "Mac ", "   "]) assert.ok(!checkPairingName(platform, name), name);
  assert.ok(checkPairingName(platform, "Studio Mac"));
});

test("a text longer than any pairing string is refused before it is read", () => {
  const m = made();
  const good = encodePairingString(platform, m.device, m.proof, "Mac");
  assert.ok(decodePairingString(platform, good).ok);
  assert.ok(!decodePairingString(platform, `${good}${"ab".repeat(70)}`).ok);
  assert.ok(!decodePairingString(platform, "ab".repeat(1_000_000)).ok);
});

test("the short form is four groups of four, and its first 8 digits are the window's short id", () => {
  const m = made();
  const form = shortForm(platform, m.device);
  assert.match(form, /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
  const id = deviceId(platform, m.device.signing, m.device.receiving);
  assert.equal(form.replaceAll("-", ""), hex(id).slice(0, 16));
  assert.equal(form.replaceAll("-", "").slice(0, 8), hex(id.slice(0, 4)));
});

test("the proof checks for the person it was made for, and for no other person or device", () => {
  const m = made();
  const other = made();
  assert.ok(checkPairingProof(platform, m.person, m.device, m.proof));
  assert.ok(!checkPairingProof(platform, platform.random(32), m.device, m.proof));
  assert.ok(!checkPairingProof(platform, m.person, other.device, m.proof));
  assert.ok(!checkPairingProof(platform, m.person, { ...m.device, kind: "bot" }, m.proof));
  assert.ok(!checkPairingProof(platform, m.person, m.device, m.proof.slice(0, 63)));
});

test("inspecting a string gives the short form, and names which of the two refusals it is (design 3.4)", () => {
  const m = made();
  const text = encodePairingString(platform, m.device, m.proof, "Mac");
  const seen = inspectPairingString(platform, text);
  assert.ok(seen.ok);
  assert.equal(seen.value.name, "Mac");
  assert.equal(seen.value.short, shortForm(platform, m.device));
  assert.deepEqual(inspectPairingString(platform, "zz"), { ok: false, error: "not-a-string" });
  assert.deepEqual(inspectPairingString(platform, text.slice(0, 2 * (1 + 130 + 63))), {
    ok: false,
    error: "not-a-string",
  });
  assert.deepEqual(inspectPairingString(platform, raw(m, Uint8Array.of(0xe2, 0x80, 0x8b))), {
    ok: false,
    error: "bad-name",
  });
  assert.deepEqual(inspectPairingString(platform, raw(m, new Uint8Array(0))), {
    ok: false,
    error: "bad-name",
  });
});

test("a joining device signs its proof once and writes its string, a bad name is a failure and not a throw (design 3.7)", () => {
  const m = made();
  const made1 = makePairingProof(platform, m.name, m.person, m.device);
  assert.ok(made1.ok);
  assert.ok(checkPairingProof(platform, m.person, m.device, made1.value));
  const text = pairingString(platform, m.device, made1.value, "Mac");
  assert.ok(text.ok);
  assert.equal(text.value, encodePairingString(platform, m.device, made1.value, "Mac"));
  assert.deepEqual(pairingString(platform, m.device, made1.value, " Mac"), {
    ok: false,
    error: "bad-input",
  });
  assert.deepEqual(makePairingProof(platform, "no.such.key", m.person, m.device), {
    ok: false,
    error: "no-such-key",
  });
});

test("a malformed value across the boundary is a failure and not a throw (crypto rule 9)", () => {
  const m = made();
  const proof = makePairingProof(platform, m.name, m.person, m.device);
  assert.ok(proof.ok);
  const short = { ...m.device, signing: new Uint8Array(3) };
  assert.deepEqual(makePairingProof(platform, m.name, new Uint8Array(5), m.device), {
    ok: false,
    error: "bad-input",
  });
  assert.deepEqual(makePairingProof(platform, m.name, m.person, short), {
    ok: false,
    error: "bad-input",
  });
  assert.deepEqual(pairingString(platform, short, proof.value, "Mac"), {
    ok: false,
    error: "bad-input",
  });
  assert.deepEqual(pairingString(platform, m.device, new Uint8Array(3), "Mac"), {
    ok: false,
    error: "bad-input",
  });
});
