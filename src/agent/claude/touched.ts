/**
 * Whether a call of a session named a file: the session's transcript and its subagents'
 * (`<session>/subagents/`), read line by line.
 */
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { isRecord } from "../../values.ts";
import { projectFolder } from "./listing.ts";

/** The blocks of a `user` or `assistant` entry's message; any other entry holds none. */
function blocksOf(entry: unknown, type: string): readonly Record<string, unknown>[] {
  if (!isRecord(entry) || entry.type !== type || !isRecord(entry.message)) return [];
  const { content } = entry.message;
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

/** An absolute path with no `..`, folded of its repeated separators and dots; else null. */
function folded(named: string): string | null {
  return isAbsolute(named) && !named.split(/[\\/]/).includes("..") ? resolve(named) : null;
}

/** A call of a tool of `files` on `path`, then its result with no `is_error`, matched by id. */
async function holds(
  file: string,
  files: Readonly<Record<string, string>>,
  path: string,
): Promise<boolean> {
  const wanted = resolve(path);
  const calls = new Set<string>();
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input });
  try {
    for await (const line of lines) {
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      for (const { type, id, name, input: given } of blocksOf(entry, "assistant")) {
        const key =
          typeof name === "string" && Object.hasOwn(files, name) ? files[name] : undefined;
        if (type === "tool_use" && typeof id === "string" && key !== undefined) {
          const named = isRecord(given) ? given[key] : undefined;
          // A `..` is followed after the links before it: a path with one is refused, never read as its folded form.
          if (typeof named === "string" && folded(named) === wanted) {
            calls.add(id);
          }
        }
      }
      for (const block of blocksOf(entry, "user")) {
        if (block.type !== "tool_result" || block.is_error === true) continue;
        if (typeof block.tool_use_id === "string" && calls.has(block.tool_use_id)) return true;
      }
    }
    return false;
  } catch (error) {
    // No record, no call; any other failure is the caller's to see.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  } finally {
    lines.close();
    input.destroy();
  }
}

/**
 * Whether a call of the session `session` of `folder`, or of a subagent of it, named `path` as
 * written, through the input key `files` gives its tool, and ended with no error.
 */
export async function touched(
  projects: string,
  files: Readonly<Record<string, string>>,
  folder: string,
  session: string,
  path: string,
): Promise<boolean> {
  const project = await projectFolder(folder, projects);
  if (project === null) return false;
  if (await holds(join(project, `${session}.jsonl`), files, path)) return true;
  const nested = join(project, session, "subagents");
  const names = await readdir(nested).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const name of names.filter((n) => n.endsWith(".jsonl")).sort()) {
    if (await holds(join(nested, name), files, path)) return true;
  }
  return false;
}
