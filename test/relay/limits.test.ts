import assert from "node:assert/strict";
import { test } from "node:test";
import { FIGURES, Limits, whereOf } from "../../src/relay/limits.ts";

/** A limits object on a clock the test moves. */
function limits() {
  const clock = { now: 1_000_000 };
  return { clock, limits: new Limits(() => clock.now) };
}
const v4 = (n: number) => `10.0.${n >> 8}.${n & 255}`;
/** An IPv6 address in the /64 `p` (its fourth group), of the /56 `p >> 8`; host part `h`. */
const v6 = (p: number, h = 1) => `2001:db8:0:${p.toString(16)}::${h}`;

test("an address is counted as an IPv4 one, an IPv6 /64, and that /64's /56 (4.4, I6)", () => {
  assert.deepEqual(whereOf("203.0.113.9"), { fine: "4:203.0.113.9" });
  assert.deepEqual(whereOf("::ffff:203.0.113.9"), whereOf("203.0.113.9"));
  const a = whereOf("2001:db8:1:ab12::5");
  const b = whereOf("2001:db8:1:ab34:ffff::1");
  const c = whereOf("2001:db8:1:ac00::1");
  assert.equal(a.fine, "6:8193:3512:1:43794");
  assert.notEqual(a.fine, b.fine);
  assert.equal(a.coarse, b.coarse, "ab12 and ab34 share the /56 of their first byte");
  assert.notEqual(a.coarse, c.coarse);
  assert.equal(
    whereOf("fe80::1%en0").fine,
    whereOf("fe80::1").fine,
    "a zone is not part of the address",
  );
  assert.equal(whereOf("::1").fine, "6:0:0:0:0");
  assert.equal(whereOf(undefined).fine, "unknown");
});

test("the 31st new connection of a minute from one address is refused, and the 31st is free again a minute on (4.4)", () => {
  const { clock, limits: l } = limits();
  for (let i = 0; i < FIGURES.rate.fine; i++) assert.equal(l.admit(v4(1)), true, String(i));
  assert.equal(l.admit(v4(1)), false);
  assert.equal(l.admit(v4(2)), true, "another address is not counted");
  clock.now += 60_001;
  assert.equal(l.admit(v4(1)), true);
});

test("an IPv6 /56 takes 120 a minute across its /64s, and one /64 only 30 (4.4)", () => {
  const { limits: l } = limits();
  for (let p = 0; p < 4; p++) {
    for (let i = 0; i < 30; i++) assert.equal(l.admit(v6(p)), true, `${p}/${i}`);
    assert.equal(l.admit(v6(p)), false, "the /64's own 31st");
  }
  assert.equal(l.admit(v6(4)), false, "the 121st of the /56, from a /64 with none");
  assert.equal(l.admit(v6(256)), true, "another /56");
});

test("4 connections without a proof from one address, 16 from one /56; a full address is turned away, nobody evicted (4.4)", () => {
  const { limits: l } = limits();
  let cut = 0;
  const evict = () => {
    cut += 1;
  };
  for (let i = 0; i < 4; i++) assert.ok(l.open(v4(1), evict));
  assert.equal(l.open(v4(1), evict), null);
  assert.equal(cut, 0);
  for (let p = 0; p < 4; p++)
    for (let i = 0; i < 4; i++) assert.ok(l.open(v6(p, i), evict), `${p}/${i}`);
  assert.equal(l.open(v6(4), evict), null, "a fifth /64 of a /56 that holds 16");
  assert.ok(l.open(v6(300), evict), "another /56");
});

test("the 65th connection without a proof evicts the oldest one, and serves a flood no better than 64 (4.4, I6)", () => {
  const { clock, limits: l } = limits();
  const cut: number[] = [];
  const held = [];
  for (let i = 0; i < 64; i++) {
    clock.now += 1;
    held.push(l.open(v4(i), () => void cut.push(i)));
  }
  assert.equal(l.unserved, 64);
  assert.ok(l.open(v4(100), () => {}));
  assert.deepEqual(cut, [0]);
  assert.equal(l.unserved, 64);
  assert.ok(l.open(v4(101), () => {}));
  assert.deepEqual(cut, [0, 1]);
});

test("a served connection leaves the pool and is never evicted; a prove-upload one stays in it until answered (4.4, N1, 11.3)", () => {
  const { limits: l } = limits();
  const cut: number[] = [];
  const held = Array.from({ length: 64 }, (_, i) => l.open(v4(i), () => void cut.push(i)));
  const [first, second, third] = held as NonNullable<(typeof held)[number]>[];
  assert.ok(first && second && third);
  assert.equal(l.serve(first, "active"), true);
  l.upload(second);
  assert.equal(second.kind, "upload");
  assert.equal(l.unserved, 63);
  assert.ok(l.open(v4(100), () => {}));
  assert.deepEqual(cut, [], "63 and a newcomer is 64");
  assert.ok(l.open(v4(101), () => {}));
  assert.deepEqual(cut, [1], "the oldest in the pool is the upload connection, not the served one");
  l.close(third);
  l.close(third);
  assert.equal(l.unserved, 63, "a connection gives back once");
  assert.ok(l.open(v4(102), () => {}));
  assert.deepEqual(cut, [1], "room was made by the close, nobody evicted");
});

test("the recovery pool: 2 per address, 4 per /56, 4 in all, never evicted; one past it is no longer held (4.4)", () => {
  const { limits: l } = limits();
  const cut: number[] = [];
  const open = (remote: string, n = 0) => {
    const h = l.open(remote, () => void cut.push(n));
    assert.ok(h);
    return h;
  };
  assert.equal(l.serve(open(v4(1)), "recovery"), true);
  assert.equal(l.serve(open(v4(1)), "recovery"), true);
  const third = open(v4(1));
  assert.equal(l.serve(third, "recovery"), false, "a third from one address");
  assert.equal(l.unserved, 0, "the refused one is not in the pool either");
  assert.equal(l.serve(open(v4(2)), "recovery"), true);
  assert.equal(l.serve(open(v4(2)), "recovery"), true);
  assert.equal(l.serve(open(v4(3)), "recovery"), false, "four in all");
  // A flood of the unproven cuts none of them.
  for (let i = 10; i < 200; i++) l.open(v4(i), () => {});
  assert.deepEqual(cut, []);
  const x = open(v6(0, 1));
  l.close(x);
  const { limits: m } = limits();
  const six = (p: number) => m.open(v6(p), () => {}) as NonNullable<ReturnType<Limits["open"]>>;
  assert.equal(m.serve(six(0), "recovery"), true);
  assert.equal(m.serve(six(0), "recovery"), true);
  assert.equal(m.serve(six(1), "recovery"), true);
  assert.equal(m.serve(six(1), "recovery"), true);
  assert.equal(m.serve(six(2), "recovery"), false, "the /56 holds four");
});

test("a closed recovery connection gives its place back (4.4)", () => {
  const { limits: l } = limits();
  const a = l.open(v4(1), () => {}) as NonNullable<ReturnType<Limits["open"]>>;
  assert.equal(l.serve(a, "recovery"), true);
  l.close(a);
  l.close(a);
  for (let i = 0; i < 4; i++) {
    const h = l.open(v4(i + 10), () => {}) as NonNullable<ReturnType<Limits["open"]>>;
    assert.equal(l.serve(h, "recovery"), true, String(i));
  }
});

test("ten reason-5 refusals in ten minutes ban the address for ten minutes, and nine do not (4.4, I6)", () => {
  const { clock, limits: l } = limits();
  for (let i = 0; i < 9; i++) l.refusedFive(v4(1));
  assert.equal(l.admit(v4(1)), true);
  l.refusedFive(v4(1));
  assert.equal(l.admit(v4(1)), false);
  assert.equal(l.admit(v4(2)), true, "only that address");
  clock.now += 9 * 60_000;
  assert.equal(l.admit(v4(1)), false);
  clock.now += 61_000;
  assert.equal(l.admit(v4(1)), true);
  // Nine, then a wait past the window, then nine more: the old ones are gone.
  for (let i = 0; i < 9; i++) l.refusedFive(v4(3));
  clock.now += 10 * 60_000 + 1;
  for (let i = 0; i < 9; i++) l.refusedFive(v4(3));
  assert.equal(l.admit(v4(3)), true);
  // The ban is of the /64, so a host cannot step round it inside its prefix.
  for (let i = 0; i < 10; i++) l.refusedFive(v6(5, i));
  assert.equal(l.admit(v6(5, 99)), false);
  assert.equal(l.admit(v6(6)), true);
});

test("the idle and age limits of each kind of connection (4.6)", () => {
  const { clock, limits: l } = limits();
  const h = l.open(v4(1), () => {}) as NonNullable<ReturnType<Limits["open"]>>;
  assert.equal(l.deadline(h), null, "no limit runs before hello");
  const t0 = clock.now;
  l.hello(h);
  assert.equal(l.deadline(h), t0 + 10_000);
  clock.now += 4_000;
  l.touch(h);
  assert.equal(
    l.deadline(h),
    t0 + 10_000,
    "an unproven connection's 10 s do not move with its frames",
  );
  l.upload(h);
  assert.equal(l.deadline(h), t0 + 10_000, "prove upload lives as an unproven one");

  const r = l.open(v4(2), () => {}) as NonNullable<ReturnType<Limits["open"]>>;
  l.hello(r);
  const r0 = clock.now;
  assert.equal(l.serve(r, "recovery"), true);
  assert.equal(l.deadline(r), r0 + 30_000, "30 s without a frame");
  for (let i = 0; i < 30; i++) {
    clock.now += 25_000;
    l.touch(r);
  }
  assert.equal(l.deadline(r), r0 + 10 * 60_000, "ten minutes in all, whatever it sends");

  const a = l.open(v4(3), () => {}) as NonNullable<ReturnType<Limits["open"]>>;
  l.hello(a);
  assert.equal(l.serve(a, "active"), true);
  const a0 = clock.now;
  assert.equal(l.deadline(a), a0 + 15 * 60_000);
  clock.now += 60_000;
  l.touch(a);
  assert.equal(l.deadline(a), clock.now + 15 * 60_000, "15 minutes without a frame it sent");
});

test("what the limits track falls back to nothing once connections close and windows pass (4.4, 2-C3)", () => {
  const { clock, limits: l } = limits();
  const held: NonNullable<ReturnType<Limits["open"]>>[] = [];
  for (let i = 0; i < 40; i++) {
    const remote = v4(i);
    assert.ok(l.admit(remote));
    held.push(l.open(remote, () => {}) as NonNullable<ReturnType<Limits["open"]>>);
  }
  assert.ok(l.serve(held[0] as (typeof held)[number], "recovery"));
  for (const h of held) l.close(h);
  for (let i = 0; i < FIGURES.ban.after; i++) l.refusedFive(v4(500));
  for (let i = 0; i < FIGURES.ban.after - 1; i++) l.refusedFive(v4(501));
  assert.equal(l.admit(v4(500)), false, "banned");
  assert.ok(l.tracked > 0);
  clock.now += Math.max(FIGURES.ban.forMs, FIGURES.ban.windowMs, FIGURES.rate.windowMs) + 1;
  assert.equal(l.admit(v4(500)), true, "the ban is over");
  assert.equal(
    l.tracked,
    2,
    "the new connection's rate, and the refusals of 501 until the next refusal sweeps them",
  );
  clock.now += FIGURES.rate.windowMs + 1;
  l.admit(v4(900));
  l.refusedFive(v4(901));
  clock.now += Math.max(FIGURES.ban.windowMs, FIGURES.rate.windowMs) + 1;
  l.admit(v4(902));
  l.refusedFive(v4(902));
  assert.equal(l.tracked, 2, "the new rate and the new refusal, nothing older");
});

test("an address that stops connecting is dropped from the rates without another connection of its own (4.4, 2-C7)", () => {
  const { clock, limits: l } = limits();
  for (let i = 0; i < 300; i++) assert.ok(l.admit(v4(i)));
  assert.equal(l.tracked, 300);
  clock.now += FIGURES.rate.windowMs + 1;
  assert.ok(l.admit(v4(1000)));
  assert.equal(l.tracked, 1);
  for (let i = 0; i < FIGURES.rate.fine; i++) assert.ok(i === 0 || l.admit(v4(1000)));
  assert.equal(l.admit(v4(1000)), false, "an address in the window is still counted");
});

test("bans that ran out are swept by a connection from a third address, not only by the banned one's own (4.4)", () => {
  const { clock, limits: l } = limits();
  for (const n of [600, 601]) for (let i = 0; i < FIGURES.ban.after; i++) l.refusedFive(v4(n));
  assert.equal(l.tracked, 2, "two bans");
  clock.now += FIGURES.ban.forMs + 1;
  assert.ok(l.admit(v4(602)));
  assert.equal(l.tracked, 1, "only the third address's rate is left");
});

test("a rate key an address renews moves behind the others, so an older one expires at its own time (4.4)", () => {
  const { clock, limits: l } = limits();
  assert.ok(l.admit(v4(700)));
  clock.now += 1;
  assert.ok(l.admit(v4(701)));
  clock.now += FIGURES.rate.windowMs / 2;
  assert.ok(l.admit(v4(700)));
  clock.now += FIGURES.rate.windowMs / 2 + 1;
  assert.ok(l.admit(v4(702)));
  assert.equal(l.tracked, 2, "701 is past its window and dropped; 700 and 702 stay");
});

test("section 7: the counts of refused proofs and of dropped connections are taken once and start again, with no address in them", () => {
  const limits = new Limits(() => 0, { ...FIGURES, rate: { ...FIGURES.rate, fine: 2 } });
  assert.deepEqual(limits.take(), { refused: 0, dropped: 0 });
  limits.refusedProof();
  limits.refusedFive("127.0.0.1");
  assert.equal(limits.admit("127.0.0.2"), true);
  assert.equal(limits.admit("127.0.0.2"), true);
  assert.equal(limits.admit("127.0.0.2"), false, "past the rate of an address");
  limits.drop();
  assert.deepEqual(limits.take(), { refused: 1, dropped: 2 });
  assert.deepEqual(limits.take(), { refused: 0, dropped: 0 });
});
