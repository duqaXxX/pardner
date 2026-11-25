/**
 * The requests a device has in flight on its connection (step 6.3 design, D5): each has its own id
 * and its own deadline. Pure bookkeeping for `Link`, which sends the frames and reads the time.
 */

/** The requests in flight, each answered once, by its result or by the end of the connection. */
export class Requests {
  #last = 1; // 1 is the give-back upload's: the first request is 2
  #open = new Map<number, number>(); // the id and the time it is due
  #patience: number;

  /** No request in flight; each is due `patience` after it was added. */
  constructor(patience: number) {
    this.#patience = patience;
  }

  /** The id the next request will have, for a caller that sends the frame before it adds the request. */
  get next(): number {
    return this.#last + 1;
  }

  /** A new request added at `now`: its id, due `patience` later, or never until `due` sets it when `held`. */
  add(now: number, held = false): number {
    this.#open.set(++this.#last, held ? Infinity : now + this.#patience);
    return this.#last;
  }

  /** An id no request has or will have, for a caller that names a piece of work before it has a request. */
  reserve(): number {
    return ++this.#last;
  }

  /** The time a request in flight is due: a held one starts its clock here. */
  due(id: number, at: number): void {
    if (this.#open.has(id)) this.#open.set(id, at + this.#patience);
  }

  /** Whether `id` was in flight, which it no longer is; an unknown id is ignored. */
  answer(id: number): boolean {
    return this.#open.delete(id);
  }

  /** The earliest time a request in flight is due, or `undefined` with none. */
  get deadline(): number | undefined {
    return this.#open.size ? Math.min(...this.#open.values()) : undefined;
  }

  /** The ids in flight that are due at `now` or before. */
  late(now: number): number[] {
    return [...this.#open].filter(([, due]) => due <= now).map(([id]) => id);
  }

  /** Every id in flight, which stops being so: the connection ended and each is `unanswered`. */
  clear(): number[] {
    const ids = [...this.#open.keys()];
    this.#open.clear();
    return ids;
  }
}
