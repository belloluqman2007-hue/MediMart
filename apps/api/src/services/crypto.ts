import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
export const argonOptions = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
} as const;
export const hashPassword = (password: string) => argon2.hash(password, argonOptions);
export const verifyPassword = (hash: string, password: string) => argon2.verify(hash, password);
export const opaqueToken = () => randomBytes(32).toString('hex');
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export function secureEqual(left: string, right: string): boolean {
  // Hash to fixed-length buffers before constant-time comparison.
  return timingSafeEqual(Buffer.from(hashToken(left), 'hex'), Buffer.from(hashToken(right), 'hex'));
}
export const csrfForToken = (token: string) => hashToken(`medimart:csrf:${token}`);
