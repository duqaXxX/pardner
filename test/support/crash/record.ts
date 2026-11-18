/**
 * The recorder of the crash images (design 2.2): `node:fs` replaced in the relay's child before the
 * relay loads, so that every effect on the test's root folder is a JSON line. A call it does not
 * model writes an `unmodelled` line and throws: `parse` (images.ts) then fails the recording.
 */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const words = (s: string) => s.split(" ");
const MAIN = new URL("../../../src/relay/main.ts", import.meta.url).href;

/** What the recorder models, which `src/relay/` may import for writing. */
export const MODELLED = words(
  "openSync writeSync fsync fsyncSync renameSync rmSync rmdirSync mkdirSync ftruncateSync writeFileSync closeSync",
);
/** What the relay may import because it changes nothing on disk. */
export const READ_ONLY = words(
  "constants existsSync fstatSync readSync readFileSync readdirSync statSync statfsSync",
);

const PATH_CALLS = words(
  "unlinkSync truncateSync appendFileSync copyFileSync linkSync symlinkSync cpSync mkdtempSync chmodSync chownSync utimesSync lutimesSync lchownSync mkdtempDisposableSync lchmodSync writeFile appendFile rename rm rmdir unlink mkdir truncate copyFile link symlink open cp mkdtemp mkdtempDisposable lchmod chmod chown utimes createWriteStream",
);
const FD_CALLS = words(
  "writevSync write writev ftruncate fchmodSync fchownSync futimesSync fchmod fchown futimes",
);
/** The calls that take two paths: the second argument of any other is data or an option. */
const TWO_PATHS = words("copyFileSync linkSync symlinkSync cpSync copyFile link symlink cp rename");
const PROMISES = PATH_CALLS.filter((n) => !n.endsWith("Sync") && n !== "createWriteStream");

// biome-ignore lint/suspicious/noExplicitAny: the replaced functions take what `node:fs` takes
type Fn = (...a: any[]) => any;
type Path = string | URL | Buffer;

/** Replaces the writing functions of `node:fs` for paths under `root`; the record goes to `file`, outside `root`. */
export function install(rootPath: string, file: string, flag?: string): void {
  const root = resolve(rootPath);
  const f = fs as unknown as Record<string, Fn>;
  const real = { ...fs };
  const dyn = real as unknown as Record<string, Fn | undefined>;
  const out = real.openSync(file, "a");
  const emit = (r: object) => real.writeSync(out, `${JSON.stringify(r)}\n`);
  const fds = new Map<number, { path: string; pos: number; append: boolean; gone?: boolean }>();
  let depth = 0;
  let syncs = 0;

  const rel = (p: unknown): string | null => {
    if (typeof p !== "string" && !(p instanceof URL) && !Buffer.isBuffer(p)) return null;
    const abs = resolve(p instanceof URL ? fileURLToPath(p) : p.toString());
    return abs === root || abs.startsWith(root + sep) ? relative(root, abs) : null;
  };
  const stop = (name: string): never => {
    emit({ op: "unmodelled", name });
    throw new Error(`crash recorder: ${name} is not modelled`);
  };
  /** Runs `body` as the outermost call: the calls `node:fs` makes inside itself are not recorded. */
  const outer = (name: string, body: Fn) => {
    f[name] = (...a: unknown[]) => {
      if (depth > 0) return dyn[name]?.(...a);
      depth++;
      try {
        return body(...a);
      } finally {
        depth--;
      }
    };
  };
  const exists = (p: string) => real.existsSync(p);
  /** The tracked descriptor; one whose file a rename replaced names nothing the model knows, so its use fails. */
  const track = (fd: number) => {
    const t = fds.get(fd);
    if (t?.gone) stop("a descriptor whose file was replaced");
    return t;
  };
  const modeOf = (path: string) => real.statSync(join(root, path)).mode & 0o777;

  for (const name of [...PATH_CALLS, ...FD_CALLS]) {
    const guard = (...a: unknown[]) => {
      const path =
        typeof a[0] === "number"
          ? fds.has(a[0])
          : rel(a[0]) !== null || (TWO_PATHS.includes(name) && rel(a[1]) !== null);
      if (path && depth === 0) stop(name);
    };
    const orig = dyn[name];
    if (orig)
      f[name] = (...a: unknown[]) => {
        guard(...a);
        return orig(...a);
      };
  }
  const promises = fs.promises as unknown as Record<string, Fn>;
  for (const name of PROMISES) {
    const orig = promises[name];
    if (orig)
      promises[name] = (...a: unknown[]) =>
        rel(a[0]) !== null || (TWO_PATHS.includes(name) && rel(a[1]) !== null)
          ? stop(`promises.${name}`)
          : orig(...a);
  }
  // The callback close forgets the descriptor as `closeSync` does: its number is used again.
  const close = dyn.close as Fn;
  f.close = (fd: number, ...rest: unknown[]) => {
    fds.delete(fd);
    return close(fd, ...rest);
  };

  outer("openSync", (p: Path, flags: string | number = "r", mode?: number) => {
    const r = rel(p);
    const had = r === null || exists(p as string);
    const fd = real.openSync(p, flags, mode);
    // A number used again outside the root must not keep naming the file it named before.
    fds.delete(fd);
    if (r === null) return fd;
    const c = fs.constants;
    const bits = typeof flags === "number" ? flags : 0;
    const make = typeof flags === "string" ? /[wa]/.test(flags) : (bits & c.O_CREAT) !== 0;
    const cut = typeof flags === "string" ? flags.startsWith("w") : (bits & c.O_TRUNC) !== 0;
    const append = typeof flags === "string" ? flags.startsWith("a") : (bits & c.O_APPEND) !== 0;
    if (!had && make) emit({ op: "create", path: r, mode: modeOf(r) });
    else if (had && cut) emit({ op: "truncate", path: r, size: 0 });
    fds.set(fd, { path: r, pos: 0, append });
    return fd;
  });
  outer("closeSync", (fd: number) => {
    fds.delete(fd);
    return real.closeSync(fd);
  });
  outer(
    "writeSync",
    (fd: number, data: string | Uint8Array, a?: unknown, b?: unknown, c?: unknown) => {
      const t = track(fd);
      // fd 1 and 2: what the relay prints, and its synchronous log (`src/relay/log.ts`), in order with the file operations.
      if (!t && fd !== 1 && fd !== 2) return (real.writeSync as Fn)(fd, data, a, b, c);
      if (
        (typeof a === "object" && a !== null) ||
        (typeof data !== "string" && !(data instanceof Uint8Array))
      )
        stop("writeSync(options)");
      const buf =
        typeof data === "string"
          ? Buffer.from(data, typeof b === "string" ? (b as BufferEncoding) : "utf8")
          : Buffer.from(
              data.buffer,
              data.byteOffset + (Number(a) || 0),
              typeof b === "number" ? b : data.byteLength - (Number(a) || 0),
            );
      const at = typeof data === "string" ? a : c;
      const before = t?.append ? real.fstatSync(fd).size : (t?.pos ?? 0);
      const n = (real.writeSync as Fn)(fd, data, a, b, c) as number;
      const bytes = buf.subarray(0, n);
      if (!t) emit({ op: "print", text: bytes.toString("utf8") });
      else {
        emit({
          op: "write",
          path: t.path,
          off: typeof at === "number" ? at : before,
          data: bytes.toString("base64"),
        });
        if (typeof at !== "number") t.pos += n;
      }
      return n;
    },
  );
  const sync = (fd: number, call: (done: () => void, path: string) => unknown) => {
    const t = track(fd);
    if (!t) return call(() => {}, "");
    const id = syncs++;
    emit({ op: "sync", phase: "start", id, path: t.path });
    return call(() => emit({ op: "sync", phase: "done", id, path: t.path }), t.path);
  };
  /**
   * The `hold` act (design 4.1): while `flag` exists, a sync of a file it names waits, at most `ms` from that file's first wait,
   * after `sync start` is recorded and before the real call. `flag.waiting.<file>` exists while a sync of that file waits, for `await-hold`.
   */
  // Each file an act names is held once, for at most `ms` from its first wait: one deadline per (act, file).
  const deadlines = new Map<string, number>();
  const held = async (path: string) => {
    if (!flag) return;
    // The act writes the flag whole and renames it in; a flag that cannot be read holds nothing.
    let hold: { files: string[]; ms: number; at: number };
    try {
      hold = JSON.parse(real.readFileSync(flag, "utf8"));
    } catch {
      return;
    }
    const name = path.split("/").pop() ?? "";
    const blob = name.startsWith("tmp-") && path.includes("/blobs/") ? "blob" : name;
    if (!hold.files.includes(blob) || !(hold.ms > 0)) return;
    const key = `${hold.at}:${blob}`;
    const until = deadlines.get(key) ?? Date.now() + hold.ms;
    deadlines.set(key, until);
    if (Date.now() >= until) return;
    const waiting = `${flag}.waiting.${blob}`;
    real.writeFileSync(waiting, "");
    while (real.existsSync(flag) && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 5));
    real.rmSync(waiting, { force: true });
  };
  // `fsync` is the callback form the seam uses: `done` is written before the caller's callback runs.
  f.fsync = (fd: number, cb: (e: unknown) => void) =>
    sync(fd, (done, path) =>
      held(path).then(() =>
        real.fsync(fd, (e: unknown) => {
          if (!e) done();
          cb(e);
        }),
      ),
    );
  outer("fsyncSync", (fd: number) =>
    sync(fd, (done) => {
      real.fsyncSync(fd);
      done();
    }),
  );
  outer("renameSync", (a: Path, b: Path) => {
    const [from, to] = [rel(a), rel(b)];
    if ((from === null) !== (to === null)) stop("renameSync across the root");
    real.renameSync(a, b);
    if (from === null || to === null) return;
    emit({ op: "rename", from, to });
    // A descriptor on a replaced destination names no file now; one under a renamed path follows it.
    for (const t of fds.values()) {
      if (t.path === to || t.path.startsWith(`${to}/`)) t.gone = true;
      else if (t.path === from || t.path.startsWith(`${from}/`))
        t.path = to + t.path.slice(from.length);
    }
  });
  const remove = (name: string) =>
    outer(name, (p: Path, o?: { force?: boolean }) => {
      const r = rel(p);
      const had = r !== null && exists(p as string);
      dyn[name]?.(p, o);
      if (r !== null && had) emit({ op: "remove", path: r });
    });
  remove("rmSync");
  remove("rmdirSync");
  outer("mkdirSync", (p: Path, o?: { recursive?: boolean } | number) => {
    const r = rel(p);
    const made: string[] = [];
    for (
      let at = r === null ? "" : resolve(p.toString());
      r !== null && at !== root && !exists(at);
      at = resolve(at, "..")
    )
      made.unshift(relative(root, at));
    const res = real.mkdirSync(p, o);
    for (const path of made) emit({ op: "mkdir", path, mode: modeOf(path) });
    return res;
  });
  outer("ftruncateSync", (fd: number, len = 0) => {
    real.ftruncateSync(fd, len);
    const t = track(fd);
    if (t) emit({ op: "truncate", path: t.path, size: len });
  });
  outer("writeFileSync", (p: Path | number, data: string | Uint8Array, o?: unknown) => {
    const r = typeof p === "number" ? null : rel(p);
    if (
      typeof p === "number"
        ? fds.has(p)
        : r !== null && o !== undefined && typeof o !== "string" && (o as { flag?: string }).flag
    )
      stop("writeFileSync(fd or flag)");
    const made = r !== null && !exists(p as string);
    (real.writeFileSync as Fn)(p, data, o);
    if (r === null) return;
    const bytes =
      typeof data === "string"
        ? Buffer.from(data, typeof o === "string" ? (o as BufferEncoding) : "utf8")
        : Buffer.from(data);
    emit({
      op: "writefile",
      path: r,
      made,
      data: bytes.toString("base64"),
      mode: made ? modeOf(r) : undefined,
    });
  });
  syncBuiltinESMExports();
}

/** The body of a child that installs the recorder, then runs the relay's `run` as a user would (`relayChild`). */
export const recordedBody = (root: string, file: string, args: string[]) => `
import { install } from ${JSON.stringify(import.meta.url)};
install(${JSON.stringify(root)}, ${JSON.stringify(file)});
const { run } = await import(${JSON.stringify(MAIN)});
process.exitCode = await run(${JSON.stringify(args)}, { exec: () => {} });`;
