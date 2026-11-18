/**
 * What a connection may hold and for how long (design 4.4 and 4.6): counts by address, the pool of
 * connections without a proof with its eviction, the recovery pool, the ban on reason 5, and each
 * kind's lifetime. Pure bookkeeping on a clock the caller gives; nothing here touches a socket.
 */
import { isIP } from "node:net";

const MINUTE = 60_000;

/** The figures of 4.4 and 4.6: proposals, held as constants (design 2.2). */
export const FIGURES = {
  rate: { fine: 30, coarse: 120, windowMs: MINUTE },
  unproven: { fine: 4, coarse: 16, all: 64 },
  recovery: { fine: 2, coarse: 4, all: 4 },
  ban: { after: 10, windowMs: 10 * MINUTE, forMs: 10 * MINUTE },
  unprovenMs: 10_000,
  recoveryIdleMs: 30_000,
  recoveryTotalMs: 10 * MINUTE,
  activeIdleMs: 15 * MINUTE,
};

/** An address counted at its finest (an IPv4 address, an IPv6 /64) and, for IPv6, at its /56. */
export interface Where {
  fine: string;
  coarse?: string;
}

/** The eight 16-bit groups of an IPv6 address, or null when it is not one. */
function groupsOf(text: string): number[] | null {
  const bare = text.split("%")[0] as string;
  if (isIP(bare) !== 6) return null;
  const quad = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(bare);
  const hex = quad
    ? bare.replace(
        quad[0],
        `${((Number(quad[1]) << 8) | Number(quad[2])).toString(16)}:${((Number(quad[3]) << 8) | Number(quad[4])).toString(16)}`,
      )
    : bare;
  const [head = "", tail] = hex.split("::");
  const take = (part: string) => (part === "" ? [] : part.split(":").map((g) => parseInt(g, 16)));
  const first = take(head);
  const last = tail === undefined ? [] : take(tail);
  return tail === undefined
    ? first
    : [...first, ...new Array<number>(8 - first.length - last.length).fill(0), ...last];
}

/** An IPv4 address written as IPv6 (`::ffff:a.b.c.d`) counts as the IPv4 one (design 4.4). */
export function whereOf(remote: string | undefined): Where {
  const text = (remote ?? "").replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
  if (isIP(text) === 4) return { fine: `4:${text}` };
  const g = groupsOf(text);
  if (g === null) return { fine: "unknown" };
  return {
    fine: `6:${g.slice(0, 4).join(":")}`,
    coarse: `6/56:${g.slice(0, 3).join(":")}:${(g[3] as number) >> 8}`,
  };
}

/** `unproven` and `upload` are in the pool of connections not served; `active` and `recovery` are served. */
export type Kind = "unproven" | "upload" | "active" | "recovery";

/** One connection's standing. `evict` is what the pool calls to cut it. */
export interface Held {
  kind: Kind;
  where: Where;
  since: number;
  /** When the relay said `hello`, from which the lifetime of 4.6 counts. */
  helloAt: number | null;
  /** The last frame the device sent (design 4.6: not what the relay pushes). */
  last: number;
  evict: () => void;
}

export class Limits {
  #now: () => number;
  #f: typeof FIGURES;
  #rates = new Map<string, number[]>();
  #refused = new Map<string, number[]>();
  #banned = new Map<string, number>();
  #pool = new Set<Held>();
  #inPool = new Map<string, number>();
  #recovery = new Map<string, number>();
  #recovering = new Set<Held>();
  #counts = { refused: 0, dropped: 0 };

  /** `figures` is replaced by a test that cannot wait ten seconds. */
  constructor(now: () => number = Date.now, figures: typeof FIGURES = FIGURES) {
    this.#now = now;
    this.#f = figures;
  }

  #keys = (w: Where) => (w.coarse === undefined ? [w.fine] : [w.fine, w.coarse]);
  #bump = (counts: Map<string, number>, w: Where, by: 1 | -1) => {
    for (const key of this.#keys(w)) {
      const next = (counts.get(key) ?? 0) + by;
      if (next === 0) counts.delete(key);
      else counts.set(key, next);
    }
  };
  /** Sets `key` last in the map's order, so that the map is ordered by when each key last changed. */
  #renew = <V>(map: Map<string, V>, key: string, value: V) => {
    map.delete(key);
    map.set(key, value);
  };
  /** Drops the keys at the front of `map`, the longest unchanged, while `stale` says their value is past its window. */
  #expire = <V>(map: Map<string, V>, stale: (value: V) => boolean) => {
    for (const [key, value] of map) {
      if (!stale(value)) break;
      map.delete(key);
    }
  };
  #fits = (counts: Map<string, number>, w: Where, fine: number, coarse: number) =>
    (counts.get(w.fine) ?? 0) < fine &&
    (w.coarse === undefined || (counts.get(w.coarse) ?? 0) < coarse);

  /** Whether a new connection from `remote` may go on to TLS: not banned, under its rate (counted when taken). */
  admit(remote: string | undefined): boolean {
    const now = this.#now();
    const w = whereOf(remote);
    if ((this.#banned.get(w.fine) ?? 0) > now) return this.drop();
    this.#banned.delete(w.fine);
    this.#expire(this.#banned, (until) => until <= now);
    const since = now - this.#f.rate.windowMs;
    this.#expire(this.#rates, (times) => (times.at(-1) ?? 0) <= since);
    const recent = (key: string) => (this.#rates.get(key) ?? []).filter((t) => t > since);
    const [fine, coarse] = [recent(w.fine), w.coarse === undefined ? [] : recent(w.coarse)];
    this.#renew(this.#rates, w.fine, fine);
    if (w.coarse !== undefined) this.#renew(this.#rates, w.coarse, coarse);
    if (fine.length >= this.#f.rate.fine || coarse.length >= this.#f.rate.coarse)
      return this.drop();
    fine.push(now);
    coarse.push(now);
    return true;
  }

  /**
   * Takes a connection into the pool of the unserved. Null when its address already holds its share;
   * past 64 in all, the oldest in the pool is cut to make room (design 4.4).
   */
  open(remote: string | undefined, evict: () => void): Held | null {
    const w = whereOf(remote);
    if (!this.#fits(this.#inPool, w, this.#f.unproven.fine, this.#f.unproven.coarse)) {
      this.drop();
      return null;
    }
    if (this.#pool.size >= this.#f.unproven.all) {
      const oldest = this.#pool.values().next().value as Held;
      this.close(oldest);
      this.drop();
      oldest.evict();
    }
    const now = this.#now();
    const held: Held = { kind: "unproven", where: w, since: now, helloAt: null, last: now, evict };
    this.#pool.add(held);
    this.#bump(this.#inPool, w, 1);
    return held;
  }

  hello(held: Held): void {
    held.helloAt = this.#now();
  }

  /** A frame from the device: the idle limits count from it. */
  touch(held: Held): void {
    held.last = this.#now();
  }

  /** `prove upload`: it stays in the pool, and evictable, until its `upload done` is answered (4.4). */
  upload(held: Held): void {
    held.kind = "upload";
  }

  /**
   * A proof was served: the connection leaves the pool. A recovery enters its own pool, which is
   * never evicted; false, with the connection no longer held, when it is full for this address or in all.
   */
  serve(held: Held, kind: "active" | "recovery"): boolean {
    if (kind === "recovery") {
      const room =
        this.#recovering.size < this.#f.recovery.all &&
        this.#fits(this.#recovery, held.where, this.#f.recovery.fine, this.#f.recovery.coarse);
      if (!room) {
        this.close(held);
        return this.drop();
      }
    }
    this.#leave(held);
    held.kind = kind;
    held.last = this.#now();
    if (kind === "recovery") {
      this.#bump(this.#recovery, held.where, 1);
      this.#recovering.add(held);
    }
    return true;
  }

  #leave(held: Held): void {
    if (this.#pool.delete(held)) this.#bump(this.#inPool, held.where, -1);
  }

  /** Gives back what a connection held; once is enough, a second call does nothing. */
  close(held: Held): void {
    this.#leave(held);
    if (this.#recovering.delete(held)) this.#bump(this.#recovery, held.where, -1);
  }

  /** A proof refused, whatever its reason, for the relay's line of section 7: an enrolment is no proof. */
  refusedProof(): void {
    this.#counts.refused++;
  }

  /** A signature or a secret that does not verify: ten in ten minutes from one address ban it for ten minutes. */
  refusedFive(remote: string | undefined): void {
    const now = this.#now();
    const key = whereOf(remote).fine;
    this.#expire(this.#refused, (times) => (times.at(-1) ?? 0) <= now - this.#f.ban.windowMs);
    const recent = [...(this.#refused.get(key) ?? []), now].filter(
      (t) => t > now - this.#f.ban.windowMs,
    );
    if (recent.length >= this.#f.ban.after) {
      this.#renew(this.#banned, key, now + this.#f.ban.forMs);
      this.#refused.delete(key);
    } else this.#renew(this.#refused, key, recent);
  }

  /** A connection cut by a limit (4.4, 4.6); returns false, as the refusals that call it do. */
  drop(): false {
    this.#counts.dropped++;
    return false;
  }

  /** The counts since the last call, for the relay's line once a minute (section 7): never an address. */
  take(): { refused: number; dropped: number } {
    const counts = this.#counts;
    this.#counts = { refused: 0, dropped: 0 };
    return counts;
  }

  /** When the connection must be cut for its age or idleness, or null while no limit runs (4.6). */
  deadline(held: Held): number | null {
    if (held.kind === "active") return held.last + this.#f.activeIdleMs;
    if (held.helloAt === null) return null;
    if (held.kind === "recovery") {
      return Math.min(held.last + this.#f.recoveryIdleMs, held.helloAt + this.#f.recoveryTotalMs);
    }
    return held.helloAt + this.#f.unprovenMs;
  }

  /** How many keys the counts, the rates, the refusals and the bans hold: what a test checks falls back to none. */
  get tracked(): number {
    const maps = [this.#rates, this.#refused, this.#banned, this.#inPool, this.#recovery];
    return maps.reduce((n, map) => n + map.size, 0);
  }

  /** How many connections the pool of the unserved holds. */
  get unserved(): number {
    return this.#pool.size;
  }
}
