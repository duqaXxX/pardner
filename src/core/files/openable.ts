/**
 * Which files the owner may open (`/open <path>`, a click on a call's line): one inside the
 * session's folder, or one a call of the session named, which the agent says (`touched`).
 */
import { isAbsolute, resolve, sep } from "node:path";
import { relativeTo } from "./paths.ts";
import { locate, NotAFile, readOnce, realpathLoose, titleOf } from "./read.ts";

/** A file `openPath` read: where it really is, its bytes, its last change in milliseconds. */
export interface OpenedPath {
  readonly target: string;
  readonly content: Buffer;
  readonly modified: number;
}

/**
 * Reads `path` (untrusted; absolute, or relative to `working`) up to `limit` bytes when it is a
 * regular file inside `folder`, or when `touched` says a call named it (asked with the path
 * resolved as text). Either way `readOnce` opens it. Throws `NotAFile` or `TooLarge`.
 */
export async function openPath(
  folder: string,
  working: string,
  path: string,
  limit: number,
  touched?: (resolved: string) => Promise<boolean>,
): Promise<OpenedPath> {
  // Joined as text, as `locate` joins: `path.join` would drop `link/..` lexically.
  const joined = isAbsolute(path) ? path : `${working}${sep}${path}`;
  let target: string;
  try {
    target = (await locate(await realpathLoose(folder), joined)).target;
  } catch (error) {
    // What a call named is a text: the same resolved text is asked and read.
    const resolved = resolve(working, path);
    if (!(error instanceof NotAFile) || !(await touched?.(resolved))) throw error;
    target = await realpathLoose(resolved);
  }
  let modified = 0;
  const content = await readOnce(target, limit, undefined, (found) => {
    modified = Math.trunc(found.mtimeMs);
  });
  return { target, content, modified };
}

/** The title: the path from `folder` with `/`, or `path` as named when outside it. */
export async function titleIn(folder: string, target: string, path: string): Promise<string> {
  const inside = relativeTo(await realpathLoose(folder), target);
  return titleOf(inside === null ? path : inside.split(sep).join("/"));
}
