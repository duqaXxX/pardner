/**
 * The relay chat module: the chat registry's entry for a bot that talks through a relay. `setup`
 * pairs the bot; `build` checks a start against the pairing and wires the store, the connection,
 * the outbox, the reading of the owner's messages and the provider, which dials once it is started.
 */
import { createECDH } from "node:crypto";
import { type ChatContext, type ChatEntry, ConfigError } from "../../core/port.ts";
import { getLogger } from "../../log.ts";
import type { Check, ModuleSetup, SetupQuestion } from "../../module-setup.ts";
import { deviceId } from "../../protocol/ids.ts";
import { Run } from "../../protocol/outbox.ts";
import type { ChatProvider } from "../seam.ts";
import { Connection } from "./connection.ts";
import { AGAIN, fromHex, toHex } from "./hex.ts";
import { Inbound } from "./inbound.ts";
import { Outbox } from "./outbox.ts";
import { botPlatform, loadPairing, pair } from "./pairing.ts";
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

/** Setup of the pairing: `finish` pairs the bot once the wizard has written `.env`, so ending it earlier leaves no keys. */
function relaySetup(): ModuleSetup {
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
  ];
  return {
    intro: [
      "Pairs this bot with a relay. You need the relay's address and public key, and your person id.",
      "After the file is written, setup makes the bot's new keys and prints the string your device adds.",
    ],
    questions,
    async finish(configDir, values) {
      const warnings: string[] = [];
      const string = await pair(
        configDir,
        fromHex(values.RELAY_OWNER ?? ""),
        fromHex(values.RELAY_KEY ?? ""),
        { warn: (line) => warnings.push(line) },
      );
      return ["Paired. Add this device on your side with:", string, ...warnings];
    },
  };
}

/** The chat entry that pairs the bot with a relay, checks a start against the pairing and builds the provider that talks through it. */
export function relayChat(): ChatEntry {
  return {
    required: ["RELAY_ADDRESS", "RELAY_KEY", "RELAY_OWNER"],
    optional: [],
    name: "relay",
    limitsHeading: "Limits of the relay chat",
    words: { names: [], literals: [], patterns: [] },
    setup: relaySetup,
    async build(context: ChatContext): Promise<ChatProvider> {
      if (context.configDir === undefined) {
        throw new ConfigError("the relay chat needs the instance's configuration directory");
      }
      const pairing = loadPairing(context.configDir);
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
        const connection = new Connection({
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
          log,
        });
        const inbound = new Inbound({ platform, self, store, outbox, run, log });
        return new RelayProvider(self, outbox, inbound, platform, {
          start: () => connection.start(),
          stop: () => connection.stop(),
          close: () => platform.erase(),
        });
      } catch (error) {
        platform.erase();
        throw error;
      }
    },
  };
}
