import { hash, verify } from "@node-rs/argon2";

const HASH_OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, HASH_OPTIONS);
}

export function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  return verify(storedHash, password);
}
