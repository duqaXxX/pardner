/**
 * The relay chat module: the chat registry's entry for a bot that talks through a relay. `setup`
 * pairs the bot; `build` checks a start against the pairing and wires the store, the connection,
 * the outbox, the reading of the owner's messages and the provider, which dials once it is started.
 */
import { createECDH } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute } from "node:path";
import { type ChatContext, type ChatEntry, ConfigError, type Instance } from "../../core/port.ts";
import { getLogger } from "../../log.ts";
import type { Check, ModuleSetup, SetupQuestion } from "../../module-setup.ts";
import { createNodePlatform } from "../../platform-node/platform.ts";
import { deviceId } from "../../protocol/ids.ts";
import { Run } from "../../protocol/outbox.ts";
import { checkPairingName, decodePairingString, shortForm } from "../../protocol/pairing-string.ts";
import type { Bytes } from "../../protocol/platform.ts";
import { encodeProfile, type Profile, refusedInName } from "../../protocol/profile.ts";
import type { ChatProvider } from "../seam.ts";
import { Connection, realClock } from "./connection.ts";
import { AGAIN, fromHex, toHex } from "./hex.ts";
import { Inbound } from "./inbound.ts";
import { Outbox } from "./outbox.ts";
import { botPlatform, loadPairing, pair } from "./pairing.ts";
import { ProfileWriter } from "./profile.ts";
import { RelayProvider } from "./provider.ts";
import { identityOf, Store } from "./store.ts";

const logger = getLogger("pardner.chat.relay.module");
const RECREATE =
  "the relay must be recreated: it was put back from an older copy or is at fault, and the bot dials it no more";

const isHex = (text: string) => /^([0-9a-f]{2})+$/i.test(text);

/** Whether `hex` is a point of P-256, as the platform's key agreement takes it. */
function onCurve(hex: string): boolean {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  try {
    ecdh.computeSecret(fromHex(hex));
    return true;
  } catch {
    return false;
  }
}

const ADDRESS = /^(?:\[[0-9a-f:.]+\]|[\w.-]+):(\d{1,5})$/i;
const BAD_ADDRESS = "write the address as host:port, for example 127.0.0.1:4433.";

/** Whether `address` is `host:port` with a port of 1 to 65535: the setup's check and the start's. */
const validAddress = (address: string) => {
  const port = Number(ADDRESS.exec(address)?.[1]);
  return port >= 1 && port <= 65535;
};

const NAME_RULE =
  "PARDNER_BOT_NAME: write 1 to 32 characters, with no @, no control or invisible character and no space at either end.";
const MAX_ICON_FILE = 65_536;
const ICON_RULE =
  "PARDNER_BOT_ICON: the icon is a square PNG or JPEG of 16 to 256 pixels a side, 65,536 bytes at most.";
const folded = (text: string) => text.toLowerCase().replace(/[\s._-]/g, "");
/** The default name: the host's up to its first dot, then `-<instance>`, cut to what a profile takes; `bot` when nothing is left. */
function defaultName(host: string, instance: string | undefined, branded: (n: string) => boolean) {
  const whole = `${host.split(".")[0] ?? ""}${instance ? `-${instance}` : ""}`;
  const kept = [...whole].filter((p) => !refusedInName(p.codePointAt(0) as number));
  const name = kept.slice(0, 32).join("").trim();
  return name && !branded(name) ? name : "bot";
}

/**
 * The bot's name and icon (bot-profile design 4.1). A configured name is stricter than what a reader
 * takes: NFC, no character of the categories Cc, Cf, Zl or Zp, and no brand of the agent's
 * (invariant 6). A configured value that fails stops the start, naming the variable and the rule.
 */
export function configuredProfile(
  context: Pick<ChatContext, "variables" | "instance" | "brand">,
  host = hostname(),
): Omit<Profile, "account"> {
  const brand = (context.brand ?? []).filter((b) => folded(b) !== "");
  const branded = (n: string) => brand.find((b) => folded(n).includes(folded(b)));
  const set = context.variables.PARDNER_BOT_NAME;
  const name = set ?? defaultName(host, context.instance, (n) => !!branded(n));
  if (set !== undefined) {
    if (set.normalize("NFC") !== set || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(set))
      throw new ConfigError(`${NAME_RULE} The name must be in NFC and hold no format character.`);
    const held = branded(set);
    if (held) throw new ConfigError(`PARDNER_BOT_NAME: a bot's name may not hold "${held}".`);
  }
  try {
    encodeProfile({ name });
  } catch {
    throw new ConfigError(NAME_RULE);
  }
  const path = context.variables.PARDNER_BOT_ICON;
  if (path === undefined) return { name };
  if (!isAbsolute(path))
    throw new ConfigError("PARDNER_BOT_ICON: write the icon file's absolute path.");
  let icon: Bytes;
  try {
    // Its size before its bytes: a file past what a profile takes, or no file at all, is never read.
    const file = statSync(path);
    if (!file.isFile() || file.size > MAX_ICON_FILE) throw new ConfigError(ICON_RULE);
    icon = new Uint8Array(readFileSync(path));
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError("PARDNER_BOT_ICON: the icon file cannot be read.");
  }
  try {
    encodeProfile({ name, icon });
  } catch {
    throw new ConfigError(ICON_RULE);
  }
  return { name, icon };
}

/** A question for the bot's name or icon, which an empty answer skips. Its check is the start's, the agent's brand included. */
function profileQuestion(
  variable: string,
  message: string,
  brand: readonly string[],
): SetupQuestion {
  return {
    variable,
    message,
    secret: false,
    optional: true,
    async check(answer): Promise<Check> {
      try {
        configuredProfile({ variables: { [variable]: answer }, brand });
        return {};
      } catch (error) {
        return { refusal: (error as Error).message.replace(`${variable}: `, "") };
      }
    },
  };
}

/** The bot's name question: the profile's check, and then the pairing string's, so that `finish` meets no typed name it cannot carry. */
function nameQuestion(message: string, brand: readonly string[]): SetupQuestion {
  const question = profileQuestion("PARDNER_BOT_NAME", message, brand);
  return {
    ...question,
    async check(answer): Promise<Check> {
      const checked = await question.check(answer);
      if ("refusal" in checked || checkPairingName(createNodePlatform(), answer)) return checked;
      return {
        refusal: "the name travels in the pairing string, which takes 64 bytes of text at most.",
      };
    },
  };
}

/**
 * The name the pairing string carries: the bot's name as the start reads it (the brand included),
 * the host's default when none was typed. A default the string cannot carry (a host name past 64
 * bytes, or with an invisible character) is refused here, naming what to do, before `pair` runs.
 */
export function pairingName(
  values: Readonly<Record<string, string>>,
  instance: string | undefined,
  brand: readonly string[],
  host = hostname(),
): string {
  const typed = values.PARDNER_BOT_NAME;
  const cannotTravel = new ConfigError(
    "PARDNER_BOT_NAME: this Mac's name cannot travel in the pairing string (64 bytes at most, no invisible character). Move .env away, then run setup again and type a name.",
  );
  let name: string;
  try {
    name = configuredProfile(
      { variables: typed === undefined ? {} : { PARDNER_BOT_NAME: typed }, instance, brand },
      host,
    ).name;
  } catch (error) {
    // A default the profile refuses (an invisible character in the host name) is the same case.
    if (typed === undefined && error instanceof ConfigError) throw cannotTravel;
    throw error;
  }
  if (!checkPairingName(createNodePlatform(), name)) throw cannotTravel;
  return name;
}

/** Setup of the pairing: `finish` pairs the bot once the wizard has written `.env`, so ending it earlier leaves no keys. */
function relaySetup(instance: Instance, brand: readonly string[] = []): ModuleSetup {
  const questions: SetupQuestion[] = [
    {
      variable: "RELAY_ADDRESS",
      message: "Relay address (host:port):",
      secret: false,
      optional: false,
      async check(answer): Promise<Check> {
        return validAddress(answer) ? {} : { refusal: BAD_ADDRESS };
      },
    },
    {
      variable: "RELAY_KEY",
      message: "Relay public key (130 hex digits):",
      secret: false,
      optional: false,
      async check(answer): Promise<Check> {
        if (
          !isHex(answer) ||
          answer.length !== 130 ||
          !answer.startsWith("04") ||
          !onCurve(answer)
        ) {
          return { refusal: "the relay key is 130 hex digits and a point of the P-256 curve." };
        }
        return {};
      },
    },
    {
      variable: "RELAY_OWNER",
      message: "Your person id (64 hex digits):",
      secret: false,
      optional: false,
      async check(answer): Promise<Check> {
        if (!isHex(answer) || answer.length !== 64) {
          return { refusal: "the person id is 64 hex digits." };
        }
        return {};
      },
    },
    nameQuestion("The bot's name as your devices show it (Enter for this Mac's name):", brand),
    profileQuestion(
      "PARDNER_BOT_ICON",
      "The absolute path of the bot's icon, a square PNG or JPEG (Enter for none):",
      brand,
    ),
  ];
  return {
    intro: [
      "Pairs this bot with a relay. You need the relay's address and public key, and your person id.",
      "After the file is written, setup makes the bot's new keys and prints the string your device adds.",
    ],
    questions,
    async finish(configDir, values) {
      const warnings: string[] = [];
      const name = pairingName(values, instance.name ?? undefined, brand);
      const string = await pair(
        configDir,
        fromHex(values.RELAY_OWNER ?? ""),
        fromHex(values.RELAY_KEY ?? ""),
        name,
        { warn: (line) => warnings.push(line) },
      );
      // From the string itself, not from the files `pair` wrote: a read that fails now would lose the string.
      const platform = createNodePlatform();
      const decoded = decodePairingString(platform, string);
      if (!decoded.ok) throw new Error("the pairing string does not decode");
      const short = shortForm(platform, decoded.value.device);
      return [
        "Paired. Add this device on your side with:",
        string,
        `Name: ${name}`,
        `Device: ${short}`,
        "Check that your device shows this name and this device before you confirm.",
        ...warnings,
      ];
    },
  };
}

/** The chat entry that pairs the bot with a relay, checks a start against the pairing and builds the provider that talks through it. */
export function relayChat(): ChatEntry {
  return {
    required: ["RELAY_ADDRESS", "RELAY_KEY", "RELAY_OWNER"],
    optional: ["PARDNER_BOT_NAME", "PARDNER_BOT_ICON"],
    name: "relay",
    limitsHeading: "Limits of the relay chat",
    words: { names: [], literals: [], patterns: [] },
    setup: relaySetup,
    async build(context: ChatContext): Promise<ChatProvider> {
      if (context.configDir === undefined) {
        throw new ConfigError("the relay chat needs the instance's configuration directory");
      }
      const pairing = loadPairing(context.configDir);
      const configured = configuredProfile(context); // before the store opens: a start it stops changes nothing
      for (const [variable, held] of [
        ["RELAY_OWNER", toHex(pairing.person)],
        ["RELAY_KEY", toHex(pairing.relay)],
      ] as const) {
        if (context.variables[variable]?.toLowerCase() !== held) {
          throw new ConfigError(`${variable} is not the one the bot was paired with: ${AGAIN}`);
        }
      }
      // Opens the store: one that does not read stops the start; one of another pairing is reset.
      const platform = botPlatform(context.configDir);
      try {
        const address = context.variables.RELAY_ADDRESS ?? "";
        // Before the store opens: a start that cannot go on must not reset a store of another pairing.
        if (!validAddress(address)) throw new ConfigError(`RELAY_ADDRESS: ${BAD_ADDRESS}`);
        const store = Store.open(
          context.configDir,
          identityOf(platform, pairing.device, pairing.relay),
        );
        const colon = address.lastIndexOf(":");
        const self = deviceId(platform, pairing.device.signing, pairing.device.receiving);
        const run = new Run(platform);
        const log = (line: string) => logger.info(line);
        const clock = realClock;
        const connection = new Connection({
          clock,
          address: () => ({
            host: address.slice(0, colon).replace(/^\[|\]$/g, ""),
            port: Number(address.slice(colon + 1)),
          }),
          pairing,
          platform,
          store,
          log,
          on: (out) => {
            if (out.do === "put-back" || out.do === "fault") logger.error(RECREATE);
            outbox.take(out);
            inbound.take(out);
            profile.take(out);
          },
        });
        // A put-back or a fault the store holds is final: the bot never dials, so the start says so (SD 5.8).
        if (connection.reading.state === "put-back" || connection.reading.state === "fault")
          throw new ConfigError(`${RECREATE}; once it is, ${AGAIN}`);
        const outbox = new Outbox({
          platform,
          pairing,
          store,
          reading: connection.reading,
          run,
          submit: (kind, signed, sig) => connection.submit(kind, signed, sig),
          giveSeal: (seal, sig) => connection.giveSeal(seal, sig),
          log,
        });
        const inbound = new Inbound({ platform, self, store, outbox, run, log });
        const profile = new ProfileWriter({
          platform,
          self,
          run,
          reading: connection.reading,
          outbox,
          store,
          configured,
          log,
        });
        return new RelayProvider(
          self,
          outbox,
          inbound,
          platform,
          {
            start: () => connection.start(),
            stop: () => connection.stop(),
            close: () => platform.erase(),
            account: (account) => profile.account(account),
          },
          context.steady,
          clock,
          { person: pairing.person, reading: connection.reading },
        );
      } catch (error) {
        platform.erase();
        throw error;
      }
    },
  };
}
