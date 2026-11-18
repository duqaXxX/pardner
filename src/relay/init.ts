/**
 * Design 3.1, `init`: a whole directory built in a temporary sibling and renamed into place, so a
 * directory goes from none to whole at once. The values are printed before the rename (review, M3).
 */
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { createNodePlatform } from "../platform-node/platform.ts";
import { relayKeyId } from "../protocol/ids.ts";
import { relayPublicKey } from "./directory.ts";
import { type Exec, excludeFromBackup } from "./exclusion.ts";
import { fileHeader } from "./journal.ts";

/** What `init` takes from the machine: the exclusion, and where the values are printed. */
export interface InitDeps {
  exec: Exec;
  out: (text: string) => void;
  /** Makes a file or a folder durable; a test records the paths. */
  sync?: (path: string) => void;
  os?: string;
}

/** `init` did not make the directory; the message says whether the values printed are void. */
export class InitFailed extends Error {}

// The names Finder writes in a folder it shows; any other entry, a hidden one included, is the owner's.
const FINDER = new Set([".DS_Store"]);

/** `fsync` of a file or a folder; Windows cannot open a folder to sync it (as `core/state.ts` guards). */
function syncPath(path: string): void {
  if (process.platform === "win32" && statSync(path).isDirectory()) return;
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Makes the relay's directory at `dir`, which must not exist or hold nothing but dot files. */
export async function init(dir: string, deps: InitDeps): Promise<void> {
  const sync = deps.sync ?? syncPath;
  let entries: string[] | null = null;
  try {
    entries = readdirSync(dir);
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") {
      throw new InitFailed("the path is not a directory that can be made");
    }
  }
  if (entries?.some((name) => !FINDER.has(name)))
    throw new InitFailed("the directory is not empty");
  const parent = dirname(dir);
  const prefix = `${basename(dir)}.init-`;
  const mine = (name: string) =>
    name.startsWith(prefix) && /^[0-9a-f]{16}$/.test(name.slice(prefix.length));
  for (const name of readdirSync(parent)) {
    if (mine(name)) {
      rmSync(join(parent, name), { recursive: true, force: true });
    }
  }
  const tmp = `${dir}.init-${randomBytes(8).toString("hex")}`;
  mkdirSync(tmp, { mode: 0o700 });
  let text: string;
  try {
    const pem = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
      type: "pkcs8",
      format: "pem",
    });
    const publicKey = relayPublicKey(pem);
    const relay = relayKeyId(createNodePlatform(), publicKey);
    const secret = randomBytes(32);
    const put = (name: string, data: Uint8Array | string) => {
      writeFileSync(join(tmp, name), data, { mode: 0o600 });
      sync(join(tmp, name));
    };
    put("key.pem", pem);
    put("enrol", createHash("sha256").update(secret).digest());
    put("journal", fileHeader("journal", relay));
    put("seals", fileHeader("seals", relay));
    mkdirSync(join(tmp, "blobs"), { mode: 0o700 });
    sync(join(tmp, "blobs"));
    sync(tmp);
    await excludeFromBackup(tmp, deps.exec, deps.os);
    text = `relay public key: ${Buffer.from(publicKey).toString("hex")}\nenrolment secret: ${secret.toString("hex")}\n`;
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
  try {
    deps.out(text);
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
  try {
    if (entries) {
      for (const name of entries) rmSync(join(dir, name), { recursive: true, force: true });
      rmdirSync(dir);
    }
    renameSync(tmp, dir);
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw new InitFailed(
      "the directory could not be put in place: the values printed above are void",
      { cause: error },
    );
  }
  try {
    sync(parent);
  } catch (error) {
    // The rename is done: the directory is whole and the values printed are the ones that enrol it.
    throw new InitFailed(
      "the relay is in place but its parent could not be synced: the values printed above hold",
      { cause: error },
    );
  }
  deps.out("the relay is made\n");
}
