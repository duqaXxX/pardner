/**
 * The bot's profile (bot-profile design 3.2 and 4): its name, its icon and the agent's account,
 * written into each channel it reads, in the channel's current epoch, when what it would write
 * differs from its newest profile there. Nothing is stored: what to write follows from the
 * sequence, the configuration and the run, so a restart or a store gone back writes one again at
 * worst.
 */
import { bytesEqual } from "../../protocol/bytes.ts";
import { activeDevices, idKey } from "../../protocol/device-log.ts";
import { membersOf } from "../../protocol/member-log.ts";
import { KIND_PROFILE, openMessage } from "../../protocol/messages.ts";
import type { Run } from "../../protocol/outbox.ts";
import type { Bytes, Platform } from "../../protocol/platform.ts";
import { encodeProfile, type Profile, Profiles, readProfile } from "../../protocol/profile.ts";
import type { Out, Reading } from "../../protocol/reading.ts";
import { toHex } from "./hex.ts";
import type { Outbox } from "./outbox.ts";
import type { Store } from "./store.ts";

export interface ProfileOptions {
  platform: Platform;
  self: Bytes;
  /** The owner: the account goes only into a channel whose members are the owner alone (3.5). */
  person: Bytes;
  run: Run;
  reading: Reading;
  outbox: Outbox;
  store: Store;
  /** The name and the icon of the configuration (4.1), already checked by `encodeProfile`. */
  configured: Omit<Profile, "account">;
  log: (line: string) => void;
}

/** A profile of the bot's own read in the sequence. */
interface Own {
  epoch: string;
  run: string;
  position: number;
  name: string;
  profile: Profile;
}

export class ProfileWriter {
  #o: ProfileOptions;
  #profiles = new Profiles(); // every bot's, the bot's own included
  #senders = new Map<string, Bytes>(); // the bots whose profile was read
  #own = new Map<string, Own[]>(); // by channel
  #account: Profile["account"] | null | undefined; // undefined: not known yet in this run (4.3)
  #blind = new Set<string>(); // names of the profiles written before the account was known
  #queuing = new Set<string>();
  #unqueued = false; // the outbox refused a profile's draft: none in this run
  #looked = false; // the line of 4.2, said at the run's first rest
  #twice = false; // the line of 3.2, said once

  constructor(options: ProfileOptions) {
    this.#o = options;
  }

  /** The account the agent reported, `null` when it does not say: known from now on in this run. */
  account(account: { name: string; plan: string | null } | null): void {
    this.#account = account && { name: account.name, plan: account.plan };
    this.#decideAll();
  }

  /** Told of each `Out` of the connection, after the outbox. */
  take(out: Out): void {
    if (out.do === "incarnation" && out.changed) {
      // The reading starts again from the start: two sequences have no one order.
      this.#profiles = new Profiles();
      this.#senders.clear();
      this.#own.clear();
    } else if (out.do === "message" && out.message.header.kind === KIND_PROFILE) {
      const { message, place, position } = out;
      const h = message.header;
      // The key `place` gives is its current epoch's: a profile of another epoch is not opened.
      if (!place.key || !bytesEqual(place.epoch, h.epoch)) return;
      const body = openMessage(this.#o.platform, place.key, message);
      if (!body.ok) return;
      this.#profiles.take(position, h, body.value.content);
      this.#senders.set(idKey(h.sender), h.sender);
      const read = readProfile(body.value.content);
      if (!bytesEqual(h.sender, this.#o.self) || !read.ok || h.blobs.length > 0) return;
      const key = toHex(h.channel);
      const own = this.#own.get(key) ?? [];
      own.push({
        epoch: idKey(h.epoch),
        run: idKey(h.run),
        position,
        name: toHex(h.name),
        profile: read.value,
      });
      this.#own.set(key, own);
    } else if (out.do === "rest") {
      this.#look();
      this.#decideAll();
    }
  }

  #decideAll(): void {
    if (!this.#o.reading.sendable) return;
    for (const channel of this.#o.reading.channels()) void this.#decide(channel);
  }

  /** What the bot would write into a channel, with the account when its owner is its one member (3.5, 4.3). */
  #wanted(alone: boolean): Profile {
    const account =
      this.#account === undefined ? this.#profiles.of(this.#o.self)?.account : this.#account;
    const p = { ...this.#o.configured, ...(alone && account ? { account } : {}) };
    try {
      encodeProfile(p);
      return p;
    } catch {
      return this.#o.configured; // an account the codec refuses is left out, the name still goes
    }
  }

  async #decide(channel: Bytes): Promise<void> {
    const { reading, outbox, run, platform } = this.#o;
    const key = toHex(channel);
    const view = reading.channel(channel);
    const epoch = view?.epochs.at(-1);
    if (!view?.key || !epoch || this.#queuing.has(key)) return;
    if (outbox.profileDropped || this.#unqueued) return;
    const queued = this.#o.store.saved.outboxes.get(key) ?? [];
    if (queued.some((i) => i.kind === KIND_PROFILE)) return;
    const members = membersOf(view.members);
    const want = this.#wanted(members.size === 1 && members.has(idKey(this.#o.person)));
    const mine = (this.#own.get(key) ?? []).filter((o) => o.epoch === idKey(epoch.id));
    const newest = mine.reduce<Own | undefined>(
      (a, o) => (!a || o.position > a.position ? o : a),
      undefined,
    );
    // An account not known yet is no difference (condition 2).
    const known = this.#account !== undefined;
    const same = (p: Profile) =>
      encodeProfile(known ? p : { ...p, account: undefined }) ===
      encodeProfile(known ? want : { ...want, account: undefined });
    if (newest && same(newest.profile)) return;
    // Condition 3: one per epoch and run, and one more once the run learns its account.
    const ofRun = mine.filter((o) => o.run === idKey(run.id));
    const again = ofRun.length === 1 && known && this.#blind.has(ofRun[0]?.name ?? "");
    if (ofRun.length > 0 && !again) return;
    const name = platform.random(16);
    if (!known) this.#blind.add(toHex(name));
    this.#queuing.add(key);
    try {
      const draft = { kind: KIND_PROFILE, name, content: encodeProfile(want) };
      if (!(await outbox.queue(channel, draft))) this.#unqueued = true;
    } catch (error) {
      // The store keeps the edit in memory when its write fails, so the profile still waits in the
      // outbox and is sent once a write holds it. Never a rejection nobody handles.
      this.#o.log(`relay: the store did not write the bot's profile: ${(error as Error).message}`);
    } finally {
      this.#queuing.delete(key);
    }
  }

  /** At rest: a second process with this bot's key (3.2); at the run's first, another bot of the same name (4.2). */
  #look(): void {
    const { log, platform, reading, self, run, configured } = this.#o;
    for (const own of this.#twice ? [] : this.#own.values()) {
      // A profile of another run placed after one of this run's: the key runs twice.
      const first = Math.min(...own.filter((o) => o.run === idKey(run.id)).map((o) => o.position));
      if (own.some((o) => o.run !== idKey(run.id) && o.position > first)) {
        log("relay: another process is writing as this bot");
        this.#twice = true;
        break;
      }
    }
    if (this.#looked) return;
    this.#looked = true;
    for (const [id, d] of activeDevices(platform, reading.devices)) {
      const sender = this.#senders.get(id);
      if (d.kind !== "bot" || !sender || bytesEqual(sender, self)) continue;
      if (this.#profiles.of(sender)?.name === configured.name)
        log(`relay: another bot of this owner is also named ${configured.name}`);
    }
  }
}
