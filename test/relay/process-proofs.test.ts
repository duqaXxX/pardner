/**
 * Process-level tests 1 and 2 of design 9.2: `node src/relay/main.ts` in child processes, spoken to
 * over real TLS on 127.0.0.1. The Time Machine exclusion is not run (`tmutil` is replaced, as in
 * `process-transport.test.ts`). The requests of test 1 are in `process-requests.test.ts`.
 */
import assert from "node:assert/strict";
import { createServer as netServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { dial, NoConnection } from "../support/scripted-device/link.ts";
import { tempDirSync } from "../support/temp.ts";
import {
  DARWIN,
  enrolAndProve,
  incarnationOf,
  init,
  portOf,
  run,
  wait,
  watch,
} from "./process-support.ts";
import { platform } from "./support.ts";
import { person } from "./world.ts";

test(
  "a start: init, serve enrols the first device with the secret and serves its proof, a second serve exits 1, SIGTERM exits 0, a start again serves it under another incarnation, a second genesis is refused as unknown and the same one served (9.2 #1)",
  DARWIN,
  async () => {
    const dir = join(tempDirSync("pardner-relay-"), "relay");
    const { key, secret } = await init(dir);
    const serve = () => watch(run(["serve", "--dir", dir, "--listen", "127.0.0.1:0"]));
    const alice = person();
    let first = serve();
    try {
      const port = await portOf(first);
      const answer = await enrolAndProve(port, key, alice, secret);
      const incarnation = incarnationOf(answer);

      const second = serve();
      assert.equal(await second.exit, 1, "one instance, one directory");
      assert.match(second.err(), /another relay holds the directory/);

      first.child.kill("SIGTERM");
      assert.equal(await first.exit, 0, first.err());

      first = serve();
      const again = await portOf(first);
      const [served, other, same] = [
        await enrolAndProve(again, key, alice),
        await enrolAndProve(again, key, person(), secret),
        await enrolAndProve(again, key, alice, secret),
      ];
      assert.notEqual(incarnationOf(served), incarnation, "another incarnation after a start");
      assert.deepEqual(other, { type: "refused", reason: 2 }, "a second genesis places nothing");
      assert.equal(incarnationOf(same), incarnationOf(served), "the same genesis is served again");
    } finally {
      first.child.kill("SIGTERM");
      assert.equal(await first.exit, 0, first.err());
    }
    assert.doesNotMatch(first.err(), /127\.0\.0\.1:\d+/, "no peer address is logged");
  },
);

test(
  "waiting: serve on a missing directory listens on nothing and says it waits; init brings it to serving within the check's second (9.2 #2)",
  DARWIN,
  async () => {
    const probe = netServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
    const port = (probe.address() as { port: number }).port;
    await new Promise((resolve) => probe.close(resolve));
    const dir = join(tempDirSync("pardner-relay-"), "relay");
    const served = watch(run(["serve", "--dir", dir, "--listen", `127.0.0.1:${port}`]));
    try {
      for (let i = 0; i < 200 && !/waiting for init/.test(served.err()); i++) await wait(25);
      assert.match(served.err(), /waiting for init/);
      await assert.rejects(
        dial(platform, port, new Uint8Array(65)),
        (e) => e instanceof NoConnection && e.reason === "refused",
        "nothing listens while it waits",
      );
      const { key } = await init(dir);
      const t0 = Date.now();
      for (let i = 0; i < 400 && !/listening on port/.test(served.err()); i++) await wait(25);
      assert.match(served.err(), /listening on port/);
      assert.ok(Date.now() - t0 < 3000, `serving ${Date.now() - t0} ms after init`);
      // The hello, whose nonce is 32 bytes by its frame, is what `dial` returns on.
      (await dial(platform, port, key)).close();
    } finally {
      served.child.kill("SIGTERM");
      assert.equal(await served.exit, 0, served.err());
    }
  },
);
