import { randomBytes } from "node:crypto";
import { CROCKFORD_ALPHABET, CROCKFORD_CLASS } from "../models/types.js";

export function encodeBase32Crockford(bytes: Uint8Array): string {
  let result = "";
  for (let i = 0; i < 16; i++) {
    const bitOffset = i * 5;
    const byteIndex = bitOffset >>> 3;
    const shift = bitOffset & 7;
    const value =
      ((bytes[byteIndex]! << shift) |
        (shift > 3 && byteIndex + 1 < bytes.length
          ? bytes[byteIndex + 1]! >>> (8 - shift)
          : 0)) &
      0xff;
    result += CROCKFORD_ALPHABET[(value >>> 3) & 0x1f];
  }
  return result;
}

export type CanonicalPrefix = "t" | "i" | "n" | "l" | "a" | "g";

export function generateCanonicalId(prefix: CanonicalPrefix): string {
  const bytes = randomBytes(10);
  return `${prefix}-${encodeBase32Crockford(bytes)}`;
}

// T-474: "g" (gate-ack) ids are never minted via generateCanonicalId -- they
// are content-derived (see gate-ack.ts's computeGateAckId) so re-acking the
// identical pin is idempotent. Included in this regex for validation only.
export const CANONICAL_ID_REGEX = new RegExp(`^[tinlag]-${CROCKFORD_CLASS}{16}$`);
