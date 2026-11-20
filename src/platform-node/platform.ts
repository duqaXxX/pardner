import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as ecdsaSign,
  verify as ecdsaVerify,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import type { Bytes, Platform } from "../protocol/platform.ts";
import { fail, ok, type Result } from "../protocol/result.ts";
import { gcmOpen, gcmSeal } from "./aead.ts";
import { deriveKeyPair, generateKeyPair, type KeyPair, keyPairOf, open, seal } from "./hpke.ts";
import { RenamedOnly, readKeyFile, type StoredKey, writeFileAtomic } from "./key-file.ts";

type Use = "sign" | "receive";
interface Held extends KeyPair {
  readonly use: Use;
}

/**
 * The person's side of the recovery secret: a terminal prompt for the bot. `show` gets a copy the
 * platform erases when it returns, with the public text the sheet carries (`context`), and answers
 * `true` only when the person confirmed; `enter` hands over bytes the platform erases after use.
 */
export interface RecoveryPerson {
  show(secret: Bytes, context: string): boolean;
  enter(): Bytes;
}

/** The platform on Node, and the constructor tests use to put a known key under a name. */
export interface NodePlatform extends Platform {
  importKey(name: string, use: Use, privateKey: Bytes): Result<Bytes>;
  /** Zeroes every key held and forgets them, leaving the key file as it is. */
  erase(): void;
}

const plain = (data: Uint8Array) => new Uint8Array(data);
// The private scalar passes through a copy that is erased: Node's buffer pool would keep it. The
// base64url text is a JavaScript string, which no code can erase.
const base64url = (bytes: Uint8Array) => {
  const copy = Buffer.from(bytes);
  try {
    return copy.toString("base64url");
  } finally {
    copy.fill(0);
  }
};
const jwk = (pk: Uint8Array, sk?: Uint8Array) => ({
  kty: "EC",
  crv: "P-256",
  x: base64url(pk.subarray(1, 33)),
  y: base64url(pk.subarray(33, 65)),
  ...(sk ? { d: base64url(sk) } : {}),
});
const INFO_MAX = 1024;
// One input for both halves would give one scalar for ECDSA and for HPKE (RFC 9180, 9.2.3).
const same = (a: Bytes, b: Bytes) => Buffer.compare(a, b) === 0;
// The positions of each function's byte arguments: any other value there is a fault of the
// package, as on the other engine. the class tag reads a Uint8Array of any realm.
const BYTES: Record<string, number[]> = {
  sha256: [0],
  hkdf: [0, 1],
  aesGcmSeal: [0, 1, 2, 3],
  aesGcmOpen: [0, 1, 2, 3],
  verify: [0, 1, 2],
  hpkeSeal: [0, 1, 2, 3],
  sign: [1],
  hpkeOpen: [1, 2, 3, 4],
  createRecovery: [1, 2],
  enterRecovery: [1, 2],
  utf8Decode: [0],
  importKey: [2],
};
function guarded(platform: NodePlatform): NodePlatform {
  const table = platform as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const [name, positions] of Object.entries(BYTES)) {
    const inner = table[name] as (...args: unknown[]) => unknown;
    table[name] = (...args) => {
      for (const at of positions) {
        const value = args[at];
        if (Object.prototype.toString.call(value) !== "[object Uint8Array]") {
          throw new TypeError(`${name}: argument ${at} is not a Uint8Array`);
        }
      }
      return inner(...args);
    };
  }
  return platform;
}
const isPoint = (key: Uint8Array) => key.length === 65 && key[0] === 4;

/**
 * Keys live in memory under their names, as long as the returned platform does. With a key file,
 * the keys made or imported through `makeKeyPair` and `importKey` are also in that file (mode 0600)
 * before the call returns, and the file's keys are held again at the start.
 */
export function createNodePlatform(
  person?: RecoveryPerson,
  options: { readonly keyFile?: string } = {},
): NodePlatform {
  const keys = new Map<string, Held>();
  // Recovery secrets made and not yet shown, by name: erased when shown, deleted or at the end.
  const secrets = new Map<string, Uint8Array>();
  const { keyFile } = options;
  // The names the file holds: a key held another way (a recovery key) never reaches the file.
  const filed = new Set<string>();
  let erased = false;
  const persist = (without?: string) => {
    if (keyFile === undefined) return;
    const stored: Record<string, StoredKey> = {};
    for (const [name, key] of keys) {
      if (filed.has(name) && name !== without) {
        stored[name] = { use: key.use, sk: key.sk.toString("hex") };
      }
    }
    writeFileAtomic(keyFile, JSON.stringify(stored));
  };
  if (keyFile !== undefined) {
    const stored = readKeyFile(keyFile);
    try {
      for (const [name, key] of Object.entries(stored)) {
        if ((key?.use !== "sign" && key?.use !== "receive") || !/^[0-9a-f]{64}$/.test(key.sk)) {
          throw new Error("shape");
        }
        keys.set(name, { ...keyPairOf(Buffer.from(key.sk, "hex")), use: key.use });
        filed.add(name);
      }
    } catch {
      for (const key of keys.values()) key.sk.fill(0);
      throw new Error("the key file holds a key that cannot be read; its content is not shown");
    }
  }

  const hold = (name: string, use: Use, pair: KeyPair): Result<Bytes> => {
    if (erased) return fail("bad-input");
    if (keys.has(name) || secrets.has(name)) return fail("key-exists");
    keys.set(name, { ...pair, use });
    if (keyFile !== undefined) {
      filed.add(name);
      try {
        persist();
      } catch (error) {
        // A file that was renamed holds the key: memory keeps it, and the caller is told.
        if (!(error instanceof RenamedOnly)) {
          keys.delete(name);
          filed.delete(name);
          pair.sk.fill(0);
        }
        return fail("io-failed");
      }
    }
    return ok(plain(pair.pk));
  };
  const held = (name: string, use: Use) => {
    const key = keys.get(name);
    return key?.use === use ? key : undefined;
  };
  const taken = (name: string) =>
    keys.has(`${name}.sign`) ||
    keys.has(`${name}.receive`) ||
    secrets.has(`${name}.sign`) ||
    secrets.has(`${name}.receive`);
  const platform: NodePlatform = {
    sha256: (data) => plain(createHash("sha256").update(data).digest()),
    hkdf(ikm, info, length) {
      if (info.length > INFO_MAX || !Number.isInteger(length) || length < 1 || length > 8160) {
        throw new RangeError("hkdf: info over 1,024 bytes, or a length outside 1 to 8,160");
      }
      const raw = new Uint8Array(hkdfSync("sha256", ikm, new Uint8Array(0), info, length));
      const out = plain(raw);
      raw.fill(0); // the original is key material too
      return out;
    },
    aesGcmSeal(key, nonce, aad, plaintext) {
      if (key.length !== 32 || nonce.length !== 12)
        throw new RangeError("aes-256-gcm: key or nonce");
      return plain(gcmSeal(key, nonce, aad, plaintext));
    },
    aesGcmOpen(key, nonce, aad, sealed) {
      if (key.length !== 32 || nonce.length !== 12) return fail("bad-input");
      try {
        return ok(plain(gcmOpen(key, nonce, aad, sealed)));
      } catch {
        return fail("open-failed");
      }
    },
    verify(publicKey, message, signature) {
      if (!isPoint(publicKey) || signature.length !== 64) return false;
      try {
        const key = createPublicKey({ key: jwk(publicKey), format: "jwk" });
        return ecdsaVerify("sha256", message, { key, dsaEncoding: "ieee-p1363" }, signature);
      } catch {
        return false;
      }
    },
    hpkeSeal(recipient, info, aad, plaintext) {
      if (!isPoint(recipient)) return fail("bad-input");
      try {
        const { enc, sealed } = seal(recipient, info, aad, plaintext);
        return ok({ enc: plain(enc), sealed: plain(sealed) });
      } catch {
        return fail("bad-input");
      }
    },

    makeKeyPair: (name, use) =>
      use === "sign" || use === "receive" ? hold(name, use, generateKeyPair()) : fail("bad-input"),
    importKey(name, use, privateKey) {
      if (privateKey.length !== 32 || (use !== "sign" && use !== "receive"))
        return fail("bad-input");
      try {
        return hold(name, use, keyPairOf(Buffer.from(privateKey)));
      } catch {
        return fail("bad-input");
      }
    },
    publicKey(name) {
      const key = keys.get(name);
      return key ? ok(plain(key.pk)) : fail("no-such-key");
    },
    sign(name, message) {
      const key = held(name, "sign");
      if (!key) return fail("no-such-key");
      const privateKey = createPrivateKey({ key: jwk(key.pk, key.sk), format: "jwk" });
      return ok(
        plain(ecdsaSign("sha256", message, { key: privateKey, dsaEncoding: "ieee-p1363" })),
      );
    },
    hpkeOpen(name, enc, info, aad, sealed) {
      const key = held(name, "receive");
      if (!key) return fail("no-such-key");
      if (!isPoint(enc)) return fail("bad-input");
      try {
        return ok(plain(open(key, enc, info, aad, sealed)));
      } catch {
        return fail("open-failed"); // no more is said of which check failed
      }
    },
    deleteKey(name) {
      secrets.get(name)?.fill(0); // a secret made and never shown
      secrets.delete(name);
      const key = keys.get(name);
      if (key === undefined) return ok(undefined);
      // The file first. A write that failed leaves the key on disk and in memory; one that was
      // renamed has dropped it from the file, so memory drops it too.
      let failed = false;
      if (filed.has(name)) {
        try {
          persist(name);
        } catch (error) {
          if (!(error instanceof RenamedOnly)) return fail("io-failed");
          failed = true;
        }
      }
      filed.delete(name);
      key.sk.fill(0);
      keys.delete(name);
      return failed ? fail("io-failed") : ok(undefined);
    },
    erase() {
      erased = true;
      for (const secret of secrets.values()) secret.fill(0);
      secrets.clear();
      for (const key of keys.values()) key.sk.fill(0);
      keys.clear();
      filed.clear();
    },

    createRecovery(name, signInfo, receiveInfo) {
      if (!person || erased) return fail("bad-input");
      if (same(signInfo, receiveInfo)) return fail("bad-input");
      // The held secret lives under the bare name, which deleteKey shares with the keys.
      if (taken(name) || keys.has(name) || secrets.has(name)) return fail("key-exists");
      const secret = platform.random(32);
      try {
        const [signing, receiving] = derive(secret, signInfo, receiveInfo);
        const keys = { signing: plain(signing.pk), receiving: plain(receiving.pk) };
        signing.sk.fill(0);
        receiving.sk.fill(0);
        secrets.set(name, secret); // kept until showRecovery, deleteKey or erase wipes it
        return ok(keys);
      } catch (error) {
        secret.fill(0);
        throw error;
      }
    },
    showRecovery(name, context) {
      if (typeof context !== "string") return fail("bad-input"); // before anything is shown or wiped
      const secret = secrets.get(name);
      if (!person || erased || !secret) return fail("bad-input");
      secrets.delete(name); // wiped whatever the person answers
      const shown = plain(secret);
      try {
        return person.show(shown, context) !== true ? fail("bad-input") : ok(undefined);
      } finally {
        shown.fill(0);
        secret.fill(0);
      }
    },
    enterRecovery(name, signInfo, receiveInfo) {
      if (erased) return fail("bad-input");
      if (same(signInfo, receiveInfo)) return fail("bad-input");
      if (keys.has(name) || taken(name) || secrets.has(name)) return fail("key-exists"); // before the person types a secret
      const secret = person ? person.enter() : new Uint8Array(0);
      try {
        if (secret.length !== 32) return fail("bad-input");
        const [signing, receiving] = derive(secret, signInfo, receiveInfo);
        if (taken(name)) {
          // a name taken while the person typed: neither key is held
          signing.sk.fill(0);
          receiving.sk.fill(0);
          return fail("key-exists");
        }
        keys.set(`${name}.sign`, { ...signing, use: "sign" });
        keys.set(`${name}.receive`, { ...receiving, use: "receive" });
        return ok({ signing: plain(signing.pk), receiving: plain(receiving.pk) });
      } finally {
        secret.fill(0);
      }
    },

    random(length) {
      const raw = randomBytes(length);
      const out = plain(raw);
      raw.fill(0);
      return out;
    },
    now: () => Date.now(),
    utf8Encode: (text) => new TextEncoder().encode(text),
    utf8Decode(bytes) {
      try {
        return ok(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
      } catch {
        return fail("bad-input");
      }
    },
  };

  /** Both pairs from the secret, or none: the first is erased when the second cannot be made. */
  function derive(secret: Bytes, signInfo: Bytes, receiveInfo: Bytes): [KeyPair, KeyPair] {
    const pair = (info: Bytes) => {
      const ikm = platform.hkdf(secret, info, 32);
      try {
        return deriveKeyPair(ikm);
      } finally {
        ikm.fill(0);
      }
    };
    const first = pair(signInfo);
    try {
      return [first, pair(receiveInfo)];
    } catch (error) {
      first.sk.fill(0);
      throw error;
    }
  }
  return guarded(platform);
}
