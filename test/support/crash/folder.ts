/** Real folders and states (design 3.1): what a segment starts from, and what an image is written as. */
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dir, emptyBase, file, type State } from "./replay.ts";

/** The state of a real folder, with the permission bits of every entry. */
export function loadBase(folder: string): State {
  const s = emptyBase();
  let next = 1;
  const walk = (path: string, ino: number) => {
    for (const e of readdirSync(path, { withFileTypes: true })) {
      const child = next++;
      dir(s, ino).entries.set(e.name, child);
      const mode = statSync(join(path, e.name)).mode & 0o777;
      if (e.isDirectory()) {
        dir(s, child).mode = mode;
        walk(join(path, e.name), child);
      } else Object.assign(file(s, child), { data: readFileSync(join(path, e.name)), mode });
    }
  };
  walk(folder, 0);
  return s;
}

/** Writes the tree of `s` into `folder`, each entry with its mode (set after the write, so that the umask does not change it). */
export function build(s: State, folder: string): void {
  const walk = (ino: number, path: string) => {
    mkdirSync(path, { recursive: true });
    for (const [name, child] of dir(s, ino).entries) {
      const node = s.get(child);
      if (node && "entries" in node) walk(child, join(path, name));
      else {
        writeFileSync(join(path, name), file(s, child).data);
        if (node?.mode !== undefined) chmodSync(join(path, name), node.mode);
      }
    }
    // After the children, so that a folder without write permission can still be filled.
    const mode = s.get(ino)?.mode;
    if (mode !== undefined && ino !== 0) chmodSync(path, mode);
  };
  walk(0, folder);
}
