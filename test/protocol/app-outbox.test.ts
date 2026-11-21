/**
 * The app outbox as the store hands it back (new channel design 4): whatever the file holds, it loads without
 * a throw, a wrong item, entry or channel is dropped, and a null optional field is an absent one.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { type AppOutbox, Boxes } from "../../src/protocol/app-outbox.ts";
import type { Bytes } from "../../src/protocol/platform.ts";
import { fill, keyed, message } from "../relay/world.ts";

const channel = fill(9);
const item = { name: fill(1, 16), kind: 2, to: fill(2), content: "{}", files: [] };
const load = (stored: unknown, c: Bytes = channel) => new Boxes(stored as AppOutbox).items(c);
const holding = (items: unknown[]) => ({
  pending: null,
  channels: [{ channel, items }],
  faults: [],
});

test("a stored outbox of any shape loads without a throw, and keeps only what is sound", () => {
  const shapes: [string, unknown, number][] = [
    ["null item", holding([null, item]), 1],
    ["re null", holding([{ ...item, re: null }]), 1],
    ["built null", holding([{ ...item, built: null }]), 1],
    ["to null", holding([{ ...item, kind: 3, to: null }]), 0],
    [
      "a null channel entry",
      { pending: null, channels: [null, { channel, items: [item] }], faults: [] },
      1,
    ],
    ["channels not an array", { pending: null, channels: { channel }, faults: [] }, 0],
    ["items not an array", { pending: null, channels: [{ channel, items: 5 }], faults: [] }, 0],
    ["faults not an array", { pending: null, channels: [], faults: 5 }, 0],
    ["pending a string", { pending: "x", channels: [], faults: [] }, 0],
    ["re a number", holding([{ ...item, re: 5 }]), 0],
    ["built a number", holding([{ ...item, built: 5 }]), 1],
    ["no stored value", undefined, 0],
  ];
  for (const [label, stored, kept] of shapes) assert.equal(load(stored).length, kept, label);
});

test("a null optional field is an absent one: the item is kept, without it", () => {
  const [kept] = load(
    holding([{ ...item, to: null, kind: 1, incarnation: null, re: null, built: null }]),
  );
  assert.ok(kept);
  assert.equal(kept.to, undefined);
  assert.equal(kept.incarnation, undefined);
  assert.equal(kept.re, undefined);
  assert.equal(kept.built, undefined);
  const [withTo] = load(holding([{ ...item, incarnation: null }]));
  assert.deepEqual(withTo?.to, item.to);
});

test("damaged built bytes leave the item unbuilt, and bytes that are its own are kept", () => {
  const sender = keyed();
  const mine = { name: fill(1, 16), kind: 1, content: "{}", files: [] };
  const made = (name: Bytes) =>
    message(sender, channel, { id: fill(3), key: fill(4) }, { name, kind: 1 });
  const ok = made(mine.name);
  const other = made(fill(7, 16));
  const built = (b: { signed: Bytes; sig: Bytes }, sig = b.sig) => ({
    signed: b.signed,
    signature: sig,
  });
  const cases: [string, unknown, boolean][] = [
    ["its own", built(ok), true],
    ["undecodable", { signed: fill(1, 10), signature: ok.sig }, false],
    ["another name", built(other), false],
    ["a short signature", built(ok, ok.sig.slice(0, 63)), false],
  ];
  for (const [label, b, kept] of cases) {
    const [item] = load(holding([{ ...mine, built: b }]));
    assert.ok(item, `${label}: the item stays`);
    assert.equal(item.built !== undefined, kept, label);
  }
  // No name, or a null one, beside bytes that would otherwise be its own: no throw, the item dropped.
  for (const name of [undefined, null]) {
    const { name: _, ...nameless } = mine;
    assert.equal(
      load(holding([{ ...nameless, name, built: built(ok) }])).length,
      0,
      `name ${name}`,
    );
  }
});
