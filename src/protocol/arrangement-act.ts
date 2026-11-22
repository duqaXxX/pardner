/**
 * The five acts of the sidebar's sections (sidebar sections design 3): the arrangement an act makes of the one a
 * device shows, built whole. The base, the encoding and the limits are the caller's.
 */
import { KIND_DEVICE_NAME } from "./messages.ts";
import { type Arrangement, MAX_CHANNELS, MAX_SECTIONS, readName } from "./profile.ts";

/** An act of the person on the sections; ids are lowercase hex, `null` is "last" or "no section" as the design's table says. */
export type ArrangeAct =
  | { type: "section-new"; name: string; channel?: string }
  | { type: "section-rename"; section: string; name: string }
  | { type: "section-move"; section: string; before: string | null }
  | { type: "section-remove"; section: string }
  | { type: "channel-move"; channel: string; section: string | null; before: string | null };

const isId = (x: unknown): x is string => typeof x === "string";
const orNull = (x: unknown): x is string | null => x === null || isId(x);

/**
 * The arrangement `act` makes of `shown`, `bad-input` when its form or name is refused, a move's `before` is the moved item
 * itself, or it names a section or channel `shown` or the sequence (`held`: its conversation channels) does not hold, and
 * `too-many` when the result passes a limit. Channels the sequence does not hold are dropped before the limits (design 3, round 1's finding 2).
 */
export function applyAct(
  shown: Arrangement,
  act: unknown,
  held: ReadonlySet<string>,
  newId: () => string,
): Arrangement | "bad-input" | "too-many" {
  const a = (typeof act === "object" && act !== null ? act : {}) as Record<string, unknown>;
  const { section, channel, before, name } = a;
  const forms: Record<string, boolean> = {
    "section-new": channel == null || isId(channel), // a Swift nil may arrive as null
    "section-rename": isId(section),
    "section-move": isId(section) && orNull(before),
    "section-remove": isId(section),
    "channel-move": isId(channel) && orNull(section) && orNull(before),
  };
  const named = a.type === "section-new" || a.type === "section-rename";
  if (
    typeof a.type !== "string" ||
    !Object.hasOwn(forms, a.type) ||
    !forms[a.type] ||
    (named && !readName(KIND_DEVICE_NAME, JSON.stringify({ name })).ok) ||
    (before != null && before === (a.type === "channel-move" ? channel : section))
  )
    return "bad-input";
  const sections = shown.sections.map((s) => ({ ...s, channels: [...s.channels] }));
  const at = (id: unknown) => sections.findIndex((s) => s.id === id);
  const leave = (c: unknown) => {
    for (const s of sections) s.channels = s.channels.filter((x) => x !== c);
  };
  const into = sections[at(section)];
  if (a.type === "section-new") {
    if (channel != null && !held.has(channel as string)) return "bad-input";
    leave(channel);
    sections.push({
      id: newId(),
      name: name as string,
      channels: channel == null ? [] : [channel as string],
      carried: Object.create(null),
    });
  } else if (a.type === "section-rename") {
    if (!into) return "bad-input";
    into.name = name as string;
  } else if (a.type === "section-move") {
    if (!into || (before !== null && at(before) < 0)) return "bad-input";
    sections.splice(at(section), 1);
    sections.splice(before === null ? sections.length : at(before), 0, into);
  } else if (a.type === "section-remove") {
    if (!into) return "bad-input";
    sections.splice(at(section), 1);
  } else {
    if (!held.has(channel as string) || (section !== null && !into)) return "bad-input";
    if (before !== null && !into?.channels.includes(before as string)) return "bad-input";
    leave(channel);
    if (into)
      into.channels.splice(
        before === null ? into.channels.length : into.channels.indexOf(before as string),
        0,
        channel as string,
      );
  }
  for (const s of sections) s.channels = s.channels.filter((c) => held.has(c));
  if (
    sections.length > MAX_SECTIONS ||
    sections.reduce((n, s) => n + s.channels.length, 0) > MAX_CHANNELS
  )
    return "too-many";
  return { ...shown, sections };
}
