/**
 * Runs a script against a relay a person started (design 4.2): `node cli.ts --port 4000 --relay <hex
 * key> [--secret <hex>] script.jsonl`. `init` prints the key and the secret. Exits 0 when every step
 * got its expected outcome, 1 when one did not, 2 on a defect of the script or the interpreter.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Failure, parse, run } from "./script.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { port: { type: "string" }, relay: { type: "string" }, secret: { type: "string" } },
});
const [file] = positionals;
if (!file || !values.port || !values.relay) {
  console.error("usage: cli.ts --port <port> --relay <hex key> [--secret <hex>] <script.jsonl>");
  process.exit(2);
}
const port = Number(values.port);
const hexOf = (v: string | undefined, bytes: number) =>
  v === undefined || new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(v);
if (
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535 ||
  !hexOf(values.relay, 65) ||
  !hexOf(values.secret, 32)
) {
  console.error("--port is 1 to 65535, --relay is 130 hex digits, --secret is 64");
  process.exit(2);
}
const secret = values.secret === undefined ? undefined : Buffer.from(values.secret, "hex");
try {
  const steps = parse(readFileSync(file, "utf8"));
  await run(steps, { port, relay: Buffer.from(values.relay, "hex"), secret });
  console.log(`${steps.length} steps passed`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(e instanceof Failure ? 1 : 2);
}
