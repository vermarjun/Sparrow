// Sortable ids: prefix + 26-char ULID (Crockford base32, 48-bit time + 80-bit random).
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now = Date.now()): string {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let rand = '';
  for (let i = 0; i < 16; i++) rand += ALPHABET[bytes[i] % 32];
  return time + rand;
}

export const newId = (prefix: 'ag' | 'call' | 'msg') => `${prefix}_${ulid()}`;
export const uuid = () => crypto.randomUUID();
