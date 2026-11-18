/**
 * Pairing the bot with a relay (security design 5.3, 5.8): new keys for a person id, and the files
 * that say what they were made for. The private keys stay in the platform's key file; nothing here
 * holds their bytes, and the string it returns is public.
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "../../core/port.ts";
import { writeFileAtomic } from "../../platform-node/key-file.ts";
import { createNodePlatform, type NodePlatform } from "../../platform-node/platform.ts";
import { Writer } from "../../protocol/bytes.ts";
import { type DeviceKeys, encodeDevicePossession, writeDevice } from "../../protocol/device-log.ts";
import type { Bytes } from "../../protocol/platform.ts";
import { AGAIN, fromHex, toHex } from "./hex.ts";
import { identityOf, resetStore, storePath } from "./store.ts";

const KEYS = "keys.json";
const PAIRING = "pairing.json";
/** The names the bot's two keys have in its platform. */
export const SIGN = "bot.s";
export const RECEIVE = "bot.r";

/** What a pairing was made for, and the bot's public keys. */
export interface Pairing {
  readonly person: Bytes;
  readonly relay: Bytes;
  readonly device: DeviceKeys;
}

/** The platform holding the bot's keys, in the instance's key file. */
export const botPlatform = (directory: string): NodePlatform =>
  createNodePlatform(undefined, { keyFile: join(directory, KEYS) });

/**
 * Pairs the bot with the relay `relay` for `person`, under the instance lock that the caller holds
 * (the wizard, through `finish`): removes the old pairing and keys, makes new keys, and writes the
 * pairing file last. Returns the hex string the approving device adds: the bot's kind, its two
 * public keys and the proof of possession, which is signed once and not kept. `between` runs after
 * the keys and before the pairing file, and `stored` after the pairing file and before the store's
 * reset, for a test to stand where a crash would. `warn` is told when the reset failed. The store is reset last, keeping only `decided`
 * (row I1). The platform's keys are zeroed before it returns.
 */
export async function pair(
  directory: string,
  person: Bytes,
  relay: Bytes,
  hooks: {
    between?: () => void | Promise<void>;
    stored?: () => void | Promise<void>;
    warn?: (line: string) => void;
  } = {},
): Promise<string> {
  if (person.length !== 32) throw new Error("the person id is not 32 bytes");
  if (relay.length !== 65) throw new Error("the relay key is not 65 bytes");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let platform: NodePlatform | undefined;
  try {
    rmSync(join(directory, PAIRING), { force: true });
    rmSync(join(directory, KEYS), { force: true });
    platform = botPlatform(directory);
    const signing = platform.makeKeyPair(SIGN, "sign");
    const receiving = platform.makeKeyPair(RECEIVE, "receive");
    if (!signing.ok || !receiving.ok) throw new Error("the platform made no key");
    const device: DeviceKeys = { kind: "bot", signing: signing.value, receiving: receiving.value };
    const proof = platform.sign(SIGN, encodeDevicePossession(person, device));
    if (!proof.ok) throw new Error("the platform did not sign");
    await hooks.between?.();
    const text = JSON.stringify({
      person: toHex(person),
      relay: toHex(relay),
      signing: toHex(signing.value),
      receiving: toHex(receiving.value),
    });
    writeFileAtomic(join(directory, PAIRING), text);
    await hooks.stored?.();
    try {
      resetStore(directory, identityOf(platform, device, relay));
    } catch {
      // The pairing is complete and its string is not to be lost: the next start finishes the reset (row N1), unless the store cannot be read.
      hooks.warn?.(
        `The store at ${storePath(directory)} could not be reset. Remove it, then start the bot.`,
      );
    }
    return toHex(writeDevice(new Writer(), device).sig(proof.value).bytes());
  } finally {
    platform?.erase();
  }
}

/**
 * The pairing of `directory`, checked against the key file: a start refuses, naming the file,
 * when there is none or when the keys are not the ones the pairing was made with.
 */
export function loadPairing(directory: string): Pairing {
  const path = join(directory, PAIRING);
  const bad = (why: string) => new ConfigError(`${path} ${why}: ${AGAIN}`);
  let record: unknown;
  try {
    record = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw bad("is missing or unreadable, so the bot is not paired or a pairing was cut short");
  }
  const field = (name: string, length: number): Bytes => {
    const value = fromHex((record as Record<string, unknown> | null)?.[name]);
    if (value.length !== length) throw bad(`has no valid ${name}`);
    return value;
  };
  const person = field("person", 32);
  const relay = field("relay", 65);
  const signing = field("signing", 65);
  const receiving = field("receiving", 65);
  let held: NodePlatform;
  try {
    held = botPlatform(directory);
  } catch (error) {
    throw new ConfigError(`${join(directory, KEYS)}: ${(error as Error).message}`);
  }
  try {
    const matches = (name: string, expected: Bytes) => {
      const key = held.publicKey(name);
      return key.ok && Buffer.compare(key.value, expected) === 0;
    };
    // Each key holds the use its name says: `hpkeOpen` answers `no-such-key` for a key that does
    // not receive. Nothing is signed.
    const none = new Uint8Array(0);
    const asSigning = held.hpkeOpen(SIGN, none, none, none, none);
    const asReceiving = held.hpkeOpen(RECEIVE, none, none, none, none);
    const uses =
      !asSigning.ok &&
      asSigning.error === "no-such-key" &&
      !asReceiving.ok &&
      asReceiving.error !== "no-such-key";
    if (!uses || !matches(SIGN, signing) || !matches(RECEIVE, receiving)) {
      throw bad(`and ${KEYS} are not from one pairing`);
    }
  } finally {
    held.erase();
  }
  return { person, relay, device: { kind: "bot", signing, receiving } };
}
