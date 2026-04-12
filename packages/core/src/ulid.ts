/**
 * Minimal ULID generator. Produces a 26-character Crockford Base32 string
 * with millisecond-precision timestamp prefix for k-sortability.
 *
 * No external dependency — crypto.getRandomValues is available in Node 22.
 */

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(now: number, len: number): string {
  let str = "";
  let remaining = now;
  for (let i = len; i > 0; i--) {
    const mod = remaining % ENCODING_LEN;
    str = ENCODING.charAt(mod) + str;
    remaining = (remaining - mod) / ENCODING_LEN;
  }
  return str;
}

function encodeRandom(len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let str = "";
  for (let i = 0; i < len; i++) {
    const byte = bytes[i] ?? 0;
    str += ENCODING.charAt(byte % ENCODING_LEN);
  }
  return str;
}

/** Generate a ULID. Optionally accepts a timestamp for testing. */
export function ulid(seedTime?: number): string {
  const time = seedTime ?? Date.now();
  return encodeTime(time, TIME_LEN) + encodeRandom(RANDOM_LEN);
}
