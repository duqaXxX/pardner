/**
 * The self-signed certificate the relay makes at each start, around its own key (design 3.3): Node
 * "parses certificates and cannot create them", so the DER is written here. A device pins the key,
 * not the certificate, so it carries no name and never needs renewing.
 */
import { createPrivateKey, createPublicKey, sign } from "node:crypto";

const der = (tag: number, ...parts: Uint8Array[]): Buffer => {
  const body = Buffer.concat(parts);
  const n = body.length;
  const length = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff]; // a certificate is under 64 KiB
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
};

// ecdsa-with-SHA256, 1.2.840.10045.4.3.2
const SIGNATURE_ALGORITHM = der(0x30, der(0x06, Buffer.from("2a8648ce3d040302", "hex")));
// commonName, 2.5.4.3, "relay"
const NAME = der(
  0x30,
  der(0x31, der(0x30, der(0x06, Buffer.from("550403", "hex")), der(0x0c, Buffer.from("relay")))),
);
// Dates are not checked (design 3.3): from 2000 to the last second of year 9999.
const VALIDITY = der(
  0x30,
  der(0x17, Buffer.from("000101000000Z")),
  der(0x18, Buffer.from("99991231235959Z")),
);

/** The PEM certificate for the PKCS#8 PEM key `pem`; `serial` is 16 random bytes of the platform. */
export function makeCertificate(pem: string | Buffer, serial: Uint8Array): string {
  const key = createPrivateKey(pem);
  const spki = createPublicKey(key).export({ type: "spki", format: "der" });
  // A positive, minimal INTEGER (X.690 8.3.2): a first byte of 0x40 to 0x7f is never a padding zero and its top bit is clear.
  const number = Buffer.from(serial);
  number[0] = ((number[0] as number) & 0x7f) | 0x40;
  const tbs = der(
    0x30,
    der(0xa0, der(0x02, Buffer.from([2]))), // version 3
    der(0x02, number),
    SIGNATURE_ALGORITHM,
    NAME,
    VALIDITY,
    NAME,
    spki,
  );
  // X.509 carries an ECDSA signature as DER (RFC 5480), which is the one place crypto.md 4 allows it.
  const signature = sign("sha256", tbs, { key, dsaEncoding: "der" });
  const certificate = der(0x30, tbs, SIGNATURE_ALGORITHM, der(0x03, Buffer.from([0]), signature));
  const lines = certificate.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}
