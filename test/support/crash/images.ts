/**
 * The crash images of a record (design 3.3): the states a power cut can leave, and the latest cut
 * that leaves each content. Pure functions of the record and the base; the checker (C2) starts
 * relays on what `build` writes.
 */
import {
  apply,
  type Config,
  clone,
  coveredAt,
  digest,
  type Micro,
  micros,
  type Rec,
  type State,
} from "./replay.ts";

/** The largest window whose subsets are all built (design 3.3 point 4); above it only points 1 to 3. */
const SUBSETS = 6;

/** An image: the content, the latest cut that leaves it, and the micro-operations applied and dropped (`kind@record`) for a finding (design 5.4). */
export type Image = {
  config: string;
  cut: number;
  how: string;
  state: State;
  hash: string;
  applied: string[];
  dropped: string[];
};

/** Pseudo-random bytes for a torn size change; fixed so that a run repeats. */
const noise = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 167 + 13) & 255));

/**
 * Every state design 3.3 builds for `cfg`, one per content, each with the latest cut that leaves it:
 * a check's oracle only grows with the cut (design 5.2), so the latest is the one to check against.
 * `window` is the largest set of uncovered operations at any cut, `fallback` that it passed 6. A cut
 * `cuts.skip` names is not built: a power cut in the middle of a copy the test put by hand (design 2.3).
 * `cuts.gen` gives the generation of a cut: a content is deduplicated within one generation, never across.
 */
export function enumerate(
  recs: Rec[],
  base: State,
  cfg: Config,
  cuts: { skip?: (cut: number) => boolean; gen?: (cut: number) => number } = {},
) {
  const m = micros(recs, base, cfg.split);
  const cover = m.ops.map((o) => coveredAt(o, cfg, m));
  const found = new Map<string, Image>();
  let window = 0;
  const add = (cut: number, how: string, list: Micro[]) => {
    const state = clone(base);
    for (const o of list) apply(state, o);
    const hash = digest(state);
    const name = (o: Micro) => `${o.t}@${o.rec}`;
    const dropped = m.ops.filter((o) => o.rec < cut && !list.includes(o)).map(name);
    // A content is kept once per generation: each generation has an oracle of its own (design 5.2).
    found.set(`${cuts.gen?.(cut) ?? 0}:${hash}`, {
      config: cfg.name,
      cut,
      how,
      state,
      hash,
      applied: list.map(name),
      dropped,
    });
  };
  for (let cut = 1; cut <= recs.length; cut++) {
    if (cuts.skip?.(cut)) continue;
    const live = m.ops.filter((o) => o.rec < cut);
    const win = live.map((_, i) => i).filter((i) => (cover[i] ?? Infinity) >= cut);
    window = Math.max(window, win.length);
    add(cut, "prefix", live);
    const w = win.findLast((i) => live[i]?.t === "write");
    const torn = w === undefined ? undefined : live[w];
    if (w !== undefined && torn?.t === "write") {
      const n = torn.data.length;
      const parts: Record<string, { off: number; data: Buffer }> = {
        third: { off: torn.off, data: torn.data.subarray(0, Math.floor(n / 3)) },
        "two thirds": { off: torn.off, data: torn.data.subarray(0, Math.floor((2 * n) / 3)) },
      };
      // A size that reached the disk before its data exists only past the old end (design 3.1):
      // the bytes before it keep what was there.
      const from = Math.max(torn.off, torn.end);
      const past = torn.off + n - from;
      if (past > 0)
        Object.assign(parts, {
          zeros: { off: from, data: Buffer.alloc(past) },
          noise: { off: from, data: noise(past) },
        });
      // Every operation covered at this cut stays: a sync done before the cut made it durable (design 3.2).
      for (const [name, part] of Object.entries(parts))
        add(
          cut,
          `torn ${name}`,
          live.flatMap((o, j) =>
            j < w
              ? [o]
              : j === w
                ? [{ ...torn, ...part }]
                : (cover[j] ?? Infinity) < cut
                  ? [o]
                  : [],
          ),
        );
    }
    for (const i of win)
      add(
        cut,
        `dropped ${i}`,
        live.filter((_, j) => j !== i),
      );
    if (win.length <= SUBSETS)
      for (let mask = 0; mask < 1 << win.length; mask++)
        add(
          cut,
          `subset ${mask}`,
          live.filter((_, j) => (win.includes(j) ? ((mask >> win.indexOf(j)) & 1) === 1 : true)),
        );
  }
  return { images: [...found.values()], window, fallback: window > SUBSETS };
}
