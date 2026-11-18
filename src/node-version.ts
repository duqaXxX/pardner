/**
 * The oldest Node that runs pardner, and the sentence that refuses an older one. The entry reads
 * it before it loads the daemon (`main.ts`). `test/node-version.test.ts` holds `MINIMUM_NODE` to
 * `engines.node` in `package.json`. This file and what it imports are loaded on every Node, so
 * they name `node:fs` and each other only.
 */
import { SETUP_SECTIONS, setupGuide } from "./version.ts";

// The floor is the Node the local runs of the suite use, and CI runs the latest Node 26: Node 22
// ends on 2027-04-30 (the release schedule of nodejs/Release) and 26 is the long-term line.
export const MINIMUM_NODE = "26.5.1";

/** `major.minor.patch` as three numbers; null for a text that does not start with them. */
function parts(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * The refusal for a Node whose `process.versions.node` is `found`, or null when it is at least
 * `MINIMUM_NODE`. Compared number by number (26.4.10 is below 26.5.1); a pre-release suffix is
 * ignored, and a text that holds no version is not refused, since nothing says it is too old.
 */
export function nodeRefusal(found: string): string | null {
  const have = parts(found);
  const need = parts(MINIMUM_NODE) as [number, number, number];
  if (have === null) return null;
  for (const [index, wanted] of need.entries()) {
    const actual = have[index] as number;
    if (actual > wanted) return null;
    if (actual < wanted) {
      return `pardner needs Node ${MINIMUM_NODE} or later and this is Node ${found}; to run it on a newer Node without changing this one, see ${setupGuide(SETUP_SECTIONS.nodeOfItsOwn)}`;
    }
  }
  return null;
}
