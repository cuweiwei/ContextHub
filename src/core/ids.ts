import { randomBytes } from 'node:crypto';

// Crockford base32, as used by ULID.
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let lastTime = 0;
let lastRandom: number[] = [];

function encodeTime(time: number, len: number): string {
  let out = '';
  for (let i = 0; i < len; i++) {
    out = ENCODING[time % 32]! + out;
    time = Math.floor(time / 32);
  }
  return out;
}

/**
 * Monotonic ULID: lexicographically sortable by creation time, which lets the
 * `id` column double as the pagination cursor for created-order listings.
 */
export function ulid(now = Date.now()): string {
  if (now <= lastTime) {
    for (let i = 15; i >= 0; i--) {
      if (lastRandom[i]! < 31) {
        lastRandom[i]!++;
        break;
      }
      lastRandom[i] = 0;
    }
  } else {
    lastTime = now;
    const bytes = randomBytes(16);
    lastRandom = Array.from(bytes, (b) => b % 32);
  }
  return encodeTime(lastTime, 10) + lastRandom.map((v) => ENCODING[v]!).join('');
}
