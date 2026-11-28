/**
 * Design 4.5: everything a served connection is sent goes through its outbox. A write the socket
 * queued in memory stops the outbox until `drain`, so a peer that does not read holds the frame that
 * filled the socket and nothing it asked for since: an answer is built, and a stream takes its next
 * step, only while the socket has room. Answers go before a pass, a pass goes before a stream's next
 * step, and one stream runs at a time while the others wait their turn. A pass is a follow's: a device's
 * new messages go ahead of a file it is streaming, the file goes on once they are sent (#153).
 *
 * After `drain` the next step waits one turn of the event loop: the server hands on what the device
 * sent while the socket was full in that turn, and a chunk written first would fill the socket again
 * before any of it was read.
 */
import type { Frame } from "../protocol/frames.ts";
import type { Peer } from "./server.ts";

/** Jobs and steps run before the outbox yields to the event loop (design 3.10, a proposal). */
const SLICE = 256;

export class Outbox {
  #peer: Peer;
  #silent: () => boolean;
  #fail: (error: unknown) => void;
  #answers: (() => void)[] = [];
  #passes: Generator<void>[] = [];
  #streams: Generator<void>[] = [];
  #stream: Generator<void> | undefined;
  #blocked = false;
  #running = false;
  #closed = false;

  /** `silent` says the relay sends nothing more (6.5, 3.7); an error a job or a step throws goes to `fail`. */
  constructor(peer: Peer, silent: () => boolean, fail: (error: unknown) => void) {
    this.#peer = peer;
    this.#silent = silent;
    this.#fail = fail;
  }

  /** Writes `frame`, for a job or a step: a socket that queued it stops the outbox until it drains. */
  send(frame: Frame): void {
    if (!this.#peer.send(frame)) this.#blocked = true;
  }

  /** `job` runs, in order with the other answers, once the socket has room. */
  answer(job: () => void): void {
    this.#answers.push(job);
    this.#run();
  }

  /** `steps` runs one step per `yield`, each after the answers due; it starts once the streams before it are done. */
  stream(steps: Generator<void>): void {
    this.#streams.push(steps);
    this.#run();
  }

  /** `steps` is a follow's pass: it runs, one step per `yield`, ahead of the streams, once the answers are built. */
  follow(steps: Generator<void>): void {
    this.#passes.push(steps);
    this.#run();
  }

  /** Sends `frame` and closes the connection: nothing is built after it. */
  end(frame: Frame): void {
    this.close();
    this.#peer.end(frame);
  }

  /** The connection is over: what waits is dropped. */
  close(): void {
    this.#closed = true;
    this.#answers = [];
    this.#passes = [];
    this.#streams = [];
    this.#stream = undefined;
  }

  #run(): void {
    if (this.#running) return;
    this.#running = true;
    try {
      for (let n = 0; ; n++) {
        if (this.#closed || this.#silent()) {
          this.close();
          break;
        }
        if (this.#blocked) {
          // One turn later, so that the server hands on what the device sent meanwhile (header comment).
          this.#peer.drain(() => setImmediate(() => this.#again(() => (this.#blocked = false))));
          return;
        }
        if (n === SLICE) {
          setImmediate(() => this.#again());
          return;
        }
        const job = this.#answers.shift();
        if (job) {
          job();
          continue;
        }
        const [pass] = this.#passes;
        if (pass) {
          if (pass.next().done) this.#passes.shift();
          continue;
        }
        this.#stream ??= this.#streams.shift();
        if (!this.#stream) break;
        if (this.#stream.next().done) this.#stream = undefined;
      }
    } catch (error) {
      this.close();
      this.#fail(error);
    }
    this.#running = false;
  }

  #again(before?: () => void): void {
    before?.();
    this.#running = false;
    this.#run();
  }
}
