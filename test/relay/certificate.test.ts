import assert from "node:assert/strict";
import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { test } from "node:test";
import { createSecureContext } from "node:tls";
import { makeCertificate } from "../../src/relay/certificate.ts";
import { platform } from "./support.ts";

const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" });

test("the certificate is made around the relay key, parses, and names nothing (3.3)", () => {
  const der = makeCertificate(pem, platform.random(16));
  const cert = new X509Certificate(der);
  assert.equal(cert.subject, "CN=relay");
  assert.equal(cert.checkPrivateKey(pair.privateKey), true);
  assert.equal(cert.verify(pair.publicKey), true, "self-signed under its own key");
  assert.deepEqual(
    cert.publicKey.export({ type: "spki", format: "der" }),
    pair.publicKey.export({ type: "spki", format: "der" }),
  );
  assert.notEqual(
    cert.serialNumber,
    new X509Certificate(makeCertificate(pem, platform.random(16))).serialNumber,
  );
  assert.ok(new Date(cert.validTo).getFullYear() > 9000, "dates are not what a device checks");
  const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey;
  assert.equal(cert.verify(other), false);
});

test("a serial whose first byte is 0x00, 0x80 or 0xff still makes a certificate OpenSSL loads (3.3, 2-C1)", () => {
  for (const first of [0x00, 0x80, 0xff]) {
    const serial = new Uint8Array(16).fill(0x11);
    serial[0] = first;
    serial[1] = 0x05;
    const certificate = makeCertificate(pem, serial);
    assert.doesNotThrow(() => new X509Certificate(certificate), `first byte ${first}`);
    assert.doesNotThrow(
      () => createSecureContext({ key: pem, cert: certificate }),
      `first byte ${first}`,
    );
  }
});
