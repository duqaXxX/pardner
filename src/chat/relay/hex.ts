/** Hex text and the sentence that tells the owner to pair again, shared by the pairing and the store. */
import type { Reference } from "../../protocol/messages.ts";
import type { Bytes } from "../../protocol/platform.ts";

/** The wizard refuses an existing `.env`, so a start says to move it. */
export const AGAIN = "move the instance's .env away, then run setup again";

export const toHex = (bytes: Bytes) => Buffer.from(bytes).toString("hex");
export const fromHex = (text: unknown): Bytes =>
  typeof text === "string" ? Uint8Array.from(Buffer.from(text, "hex")) : new Uint8Array(0);

const ID = /^[0-9a-f]{64}(?:[0-9a-f]{2})+$/;

/** The message an id names, the sender's 64 hex digits and then the name's; `undefined` for text that is no such id. */
export const referenceOf = (id: string): Reference | undefined =>
  ID.test(id) ? { device: fromHex(id.slice(0, 64)), name: fromHex(id.slice(64)) } : undefined;
