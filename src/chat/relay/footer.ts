/**
 * The text a work's end is written as (D2 design 3.1): its length, the session's line for the thread
 * panel's header and, in a channel of the owner's alone, the account's values: the subscription's
 * limits as numbers, and the session's estimated cost for an account with no plan (D3 design 3.2).
 * The session's line is written by the core's one formatter, as `/status` writes it; the money is in
 * no line of it, and only here.
 */

import { footerFields, formatWorkDuration, valueWithDetail } from "../../core/port.ts";
import { idKey } from "../../protocol/device-log.ts";
import { membersOf } from "../../protocol/member-log.ts";
import type { Bytes } from "../../protocol/platform.ts";
import type { Reading } from "../../protocol/reading.ts";
import type { FooterFields, UsageLimit } from "../seam.ts";

/** The owner's person and what the module read of the channels, to tell a channel of the owner's alone. */
export interface Owner {
  person: Bytes;
  reading: Pick<Reading, "channel">;
}

/** Whether the owner is the only member of `channel` as the module read it; a channel not read yet is not. */
export function ownerAlone(owner: Owner | undefined, channel: Bytes): boolean {
  const view = owner?.reading.channel(channel);
  if (!owner || !view) return false;
  const members = membersOf(view.members);
  return members.size === 1 && members.has(idKey(owner.person));
}

const limit = (l: UsageLimit | null) => (l ? { percent: l.percent, resetsAt: l.resetsAt } : null);

/** The last two names of a folder: `pardner/pardner-workspace`; one name when there is no more. */
const tail = (folder: string) => folder.split(/[\\/]/).filter(Boolean).slice(-2).join("/");

/** The session's line, its known parts joined by ` · `; undefined when none is known. */
function sessionLine(footer: FooterFields, now: number): string | undefined {
  const fields = new Map(footerFields(footer, now).map((f) => [f.key, f]));
  const value = (key: "model" | "advisor" | "effort" | "context" | "tokens") => {
    const field = fields.get(key);
    return field && valueWithDetail(field);
  };
  const git = [fields.get("branch")?.value, fields.get("changes")?.value].filter(Boolean).join(" ");
  const untrusted = fields.get("git_untrusted");
  const advisor = value("advisor");
  const effort = value("effort");
  const context = value("context");
  const tokens = value("tokens");
  const parts = [
    footer.planning ? "⏸ plan" : footer.bypass ? "⚡ bypass" : undefined,
    value("model"),
    advisor && `advisor ${advisor}`,
    effort && `effort ${effort}`,
    git || undefined,
    untrusted && `git ${untrusted.value}`,
    context && `ctx ${context}`,
    tokens && `${tokens} tokens`,
    footer.folder ? tail(footer.folder) : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

/** The content of a work's end; `usage` only when `alone` (the owner is the channel's one member). */
export function footerContent(footer: FooterFields, now: number, alone: boolean) {
  const session = sessionLine(footer, now);
  // Null for an account with a plan: the core gives none there.
  const cost = footer.sessionCost;
  const usage =
    alone && footer.work && (footer.sessionLimit || footer.weekLimit || cost !== null)
      ? {
          at: footer.work.doneAt,
          session: limit(footer.sessionLimit),
          week: limit(footer.weekLimit),
          ...(cost === null ? {} : { cost }),
        }
      : undefined;
  return {
    say: "footer",
    markdown: footer.work ? formatWorkDuration(footer.work.durationMs) : "",
    ...(session ? { session } : {}),
    ...(usage ? { usage } : {}),
  };
}
