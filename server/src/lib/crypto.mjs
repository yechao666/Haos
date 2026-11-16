import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, expectedHex] = stored.split(':');
  try {
    const actual = scryptSync(String(password), salt, 64);
    const expected = Buffer.from(expectedHex, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
