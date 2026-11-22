/**
 * The one rule of which code points a name may not hold, for a person, a device and a bot alike:
 * written once, so that the profile and the pairing string agree.
 */

// Only what needs no Unicode table, so that Node and JavaScriptCore give one verdict (bot profile design 3.1):
// a C0 or C1 control, a line or paragraph separator, or a lone surrogate, which Swift turns into
// U+FFFD so that two strings that differ would look alike. Iterating by code point leaves a lone
// surrogate as one unit in U+D800 to U+DFFF.
/** Whether a code point is a control, a line or paragraph separator or a lone surrogate. */
export const hidden = (c: number): boolean =>
  c <= 0x1f ||
  (c >= 0x7f && c <= 0x9f) ||
  c === 0x2028 ||
  c === 0x2029 ||
  (c >= 0xd800 && c <= 0xdfff);
// No name can pass for another: the refusals of `hidden` (a control, a line or paragraph
// separator, a lone surrogate), Unicode's default-ignorable code points, which render as nothing
// (DerivedCoreProperties.txt, Unicode 18.0.0, read 2026-11-20), and the interlinear annotations. The
// ranges are written here rather than read from an engine's Unicode tables, so that Node and
// JavaScriptCore give one verdict, as `hidden` does.
const INVISIBLE: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfffb],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff],
];
/** Whether a code point may not stand in a person's, a device's or a bot's name. */
export const hiddenInName = (c: number): boolean =>
  hidden(c) || INVISIBLE.some(([from, to]) => c >= from && c <= to);
