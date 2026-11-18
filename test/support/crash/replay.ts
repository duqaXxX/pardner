/**
 * A record of the relay's directory replayed (design 3.1, 3.2): micro-operations on inodes, and what
 * a completed sync covers under a configuration. The states a cut can leave are in `images.ts`.
 */
import { createHash } from "node:crypto";
import { dirname } from "node:path";

export type Rec =
  | { op: "create" | "mkdir"; path: string; mode?: number }
  | { op: "remove"; path: string }
  | { op: "truncate"; path: string; size: number }
  | { op: "write"; path: string; off: number; data: string }
  | { op: "writefile"; path: string; data: string; mode?: number }
  | { op: "rename"; from: string; to: string }
  | { op: "sync"; phase: "start" | "done"; id: number; path: string }
  | { op: "print"; text: string }
  | { op: "chmod"; path: string; mode: number }
  /** A copy put by hand, taken as durable (design 2.3): covers the operations of the records `recs`, the test's own, and no other. */
  | { op: "durable"; recs: number[] };

/** The record's lines; a line the recorder could not model fails the recording (design 2.2). */
export function parse(text: string): Rec[] {
  const recs = text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Rec | { op: "unmodelled"; name: string });
  for (const r of recs) if (r.op === "unmodelled") throw new Error(`unmodelled call: ${r.name}`);
  return recs as Rec[];
}

/** `mode` is the permission bits the recorder saw the file or folder get; none for an inode only a write reached. */
type Node = { entries: Map<string, number>; mode?: number } | { data: Buffer; mode?: number };
/** Inode to node; inode 0 is the root folder. Inodes are never allocated or freed (ALICE 3.2.2). */
export type State = Map<number, Node>;

/** A base that holds the empty root folder alone. */
export const emptyBase = (): State => new Map([[0, { entries: new Map() }]]);

export const clone = (s: State): State =>
  new Map(
    [...s].map(([i, n]) => [
      i,
      "entries" in n
        ? { entries: new Map(n.entries), mode: n.mode }
        : { data: Buffer.from(n.data), mode: n.mode },
    ]),
  );
export const dir = (s: State, ino: number) => {
  const n = s.get(ino) ?? { entries: new Map<string, number>() };
  if (!("entries" in n)) throw new Error(`inode ${ino} is a file`);
  s.set(ino, n);
  return n;
};
export const file = (s: State, ino: number) => {
  const n = s.get(ino) ?? { data: Buffer.alloc(0) };
  if (!("data" in n)) throw new Error(`inode ${ino} is a directory`);
  s.set(ino, n);
  return n;
};

/** A hash of the tree reachable from the root: names, kinds, modes (the root's apart) and bytes. Equal hash, equal content. */
export function digest(s: State): string {
  const h = createHash("sha1");
  const walk = (ino: number, path: string, depth: number) => {
    const n = s.get(ino);
    if (depth > 16) throw new Error("a directory loop");
    if (n && "entries" in n) {
      h.update(`${path}/${ino === 0 ? "" : n.mode}\n`);
      for (const name of [...n.entries.keys()].sort())
        walk(n.entries.get(name) ?? 0, `${path}/${name}`, depth + 1);
    } else h.update(`${path}\0${n?.mode}\0${n?.data.length ?? 0}\0`).update(n?.data ?? "");
  };
  walk(0, "", 0);
  return h.digest("hex");
}

export type Micro =
  | { t: "write"; rec: number; ino: number; off: number; data: Buffer; end: number }
  | { t: "size"; rec: number; ino: number; size: number }
  | {
      t: "link";
      rec: number;
      dir: number;
      name: string;
      ino: number;
      isDir: boolean;
      mode?: number;
    }
  | { t: "unlink"; rec: number; dir: number; name: string }
  | { t: "mode"; rec: number; ino: number; mode: number }
  | {
      t: "mv";
      rec: number;
      from: [number, string];
      to: [number, string];
      ino: number;
      isDir: boolean;
      mode?: number;
    };

export function apply(s: State, o: Micro): void {
  if (o.t === "write") {
    const f = file(s, o.ino);
    if (f.data.length < o.off + o.data.length)
      f.data = Buffer.concat([f.data, Buffer.alloc(o.off + o.data.length - f.data.length)]);
    o.data.copy(f.data, o.off);
  } else if (o.t === "size") {
    const f = file(s, o.ino);
    f.data = Buffer.concat([
      f.data.subarray(0, o.size),
      Buffer.alloc(Math.max(0, o.size - f.data.length)),
    ]);
  } else if (o.t === "unlink") dir(s, o.dir).entries.delete(o.name);
  else if (o.t === "mode") {
    const n = s.get(o.ino);
    if (n) n.mode = o.mode;
  } else {
    const [d, name] = o.t === "link" ? [o.dir, o.name] : o.to;
    dir(s, d).entries.set(name, o.ino);
    const node = o.isDir ? dir(s, o.ino) : file(s, o.ino);
    if (o.mode !== undefined) node.mode = o.mode;
    if (o.t === "mv") dir(s, o.from[0]).entries.delete(o.from[1]);
  }
}

/** One configuration of the persistence model (design 3.2). A1 always holds. */
export type Config = { name: string; a2: boolean; a3: boolean; split: boolean };
export const M: Config = { name: "M", a2: true, a3: false, split: false };
export const CONFIGS: Config[] = [
  M,
  { ...M, name: "M without A2", a2: false },
  { ...M, name: "M split rename", split: true },
  { ...M, name: "M with A3", a3: true },
];

/** The micro-operations of a record, and the syncs that completed: the record replayed on its base. */
export function micros(recs: Rec[], base: State, split: boolean) {
  const L = clone(base);
  let next = Math.max(...base.keys()) + 1;
  const ops: Micro[] = [];
  const syncs: { ino: number; start: number; done: number }[] = [];
  const open = new Map<number, { ino: number; start: number }>();
  const durable: { at: number; recs: number[] }[] = [];
  const at = (path: string) => {
    let cur: number | undefined = 0;
    for (const part of path.split("/").filter(Boolean)) {
      const n: Node | undefined = cur === undefined ? undefined : L.get(cur);
      cur = n && "entries" in n ? n.entries.get(part) : undefined;
    }
    return cur;
  };
  const need = (path: string) => {
    const ino = at(path);
    if (ino === undefined) throw new Error(`the record names ${path}, which the replay lacks`);
    return ino;
  };
  const parent = (path: string) => ({
    dir: need(dirname(path) === "." ? "" : dirname(path)),
    name: path.split("/").pop() ?? "",
  });
  const put = (o: Micro) => {
    ops.push(o);
    apply(L, o);
  };
  /** `end` is the file's length before the write: only past it can the size reach the disk before the data. */
  const write = (rec: number, ino: number, off: number, data: Buffer) =>
    put({
      t: "write",
      rec,
      ino,
      off,
      data,
      end: (L.get(ino) as { data: Buffer } | undefined)?.data.length ?? 0,
    });
  const unlinkTree = (rec: number, d: number, name: string) => {
    const child = dir(L, d).entries.get(name) ?? -1;
    const n = L.get(child);
    if (n && "entries" in n) for (const sub of [...n.entries.keys()]) unlinkTree(rec, child, sub);
    put({ t: "unlink", rec, dir: d, name });
  };
  recs.forEach((r, rec) => {
    if (r.op === "create" || r.op === "mkdir")
      put({
        t: "link",
        rec,
        ...parent(r.path),
        ino: next++,
        isDir: r.op === "mkdir",
        mode: r.mode,
      });
    else if (r.op === "write") write(rec, need(r.path), r.off, Buffer.from(r.data, "base64"));
    else if (r.op === "truncate") put({ t: "size", rec, ino: need(r.path), size: r.size });
    else if (r.op === "writefile") {
      if (at(r.path) === undefined)
        put({ t: "link", rec, ...parent(r.path), ino: next++, isDir: false, mode: r.mode });
      else put({ t: "size", rec, ino: need(r.path), size: 0 });
      write(rec, need(r.path), 0, Buffer.from(r.data, "base64"));
    } else if (r.op === "remove") unlinkTree(rec, parent(r.path).dir, parent(r.path).name);
    else if (r.op === "rename") {
      const [from, to, ino] = [parent(r.from), parent(r.to), need(r.from)];
      const isDir = "entries" in (L.get(ino) ?? { data: 0 });
      const mode = L.get(ino)?.mode;
      if (!split)
        put({ t: "mv", rec, from: [from.dir, from.name], to: [to.dir, to.name], ino, isDir, mode });
      else {
        if (at(r.to) !== undefined) put({ t: "unlink", rec, ...to });
        put({ t: "link", rec, ...to, ino, isDir, mode });
        put({ t: "unlink", rec, ...from });
      }
    } else if (r.op === "sync" && r.phase === "start")
      open.set(r.id, { ino: need(r.path), start: rec });
    else if (r.op === "sync") {
      const s = open.get(r.id);
      if (s) syncs.push({ ...s, done: rec });
    } else if (r.op === "chmod") put({ t: "mode", rec, ino: need(r.path), mode: r.mode });
    else if (r.op === "durable") durable.push({ at: rec, recs: r.recs });
  });
  return { ops, syncs, durable };
}

/** The record index at which `o` is covered under `cfg` (design 3.2); Infinity when no sync covers it. */
export function coveredAt(o: Micro, cfg: Config, m: ReturnType<typeof micros>): number {
  const first = (ino: number) =>
    Math.min(
      ...m.syncs.filter((s) => s.ino === ino && s.start > o.rec).map((s) => s.done),
      Infinity,
    );
  let by = Infinity;
  if (o.t === "write" || o.t === "size") by = first(o.ino);
  else if (o.t !== "mode") {
    const dirs = o.t === "mv" ? [o.from[0], o.to[0]] : [o.dir];
    if (cfg.a2) by = Math.max(...dirs.map(first));
    if (cfg.a3 && o.t !== "unlink") by = Math.min(by, first(o.ino));
  }
  return Math.min(by, ...m.durable.filter((d) => d.recs.includes(o.rec)).map((d) => d.at));
}

/** The state the whole record leaves with every operation applied: the directory a run that ended normally holds. */
export function replay(recs: Rec[], base: State): State {
  const state = clone(base);
  for (const o of micros(recs, base, false).ops) apply(state, o);
  return state;
}
