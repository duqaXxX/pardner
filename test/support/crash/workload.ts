/** A script run on a recorded relay, for the tests of the checker: the record, the platform that holds the script's keys, the relay's folders (removed with the test process). */
import { createNodePlatform } from "../../../src/platform-node/platform.ts";
import { RelayProcess } from "../scripted-device/relay-process.ts";
import { parse, run } from "../scripted-device/script.ts";
import type { Recording } from "./segments.ts";

export async function recorded(source: string) {
  // Each run has a platform of its own: it holds the keys by name for good.
  const platform = createNodePlatform();
  const relay = new RelayProcess(true);
  try {
    const steps = parse(`${source}\n{"op":"relay","act":"stop"}`);
    await run(steps, await relay.open(), platform, relay, (seen) => relay.recording?.observe(seen));
  } finally {
    await relay.close();
  }
  return { relay, platform, rec: relay.recording as Recording };
}
