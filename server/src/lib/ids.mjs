import { randomBytes } from 'node:crypto';

export function id(prefix) {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

export function token(bytes = 32) {
  return randomBytes(bytes).toString('hex');
}
