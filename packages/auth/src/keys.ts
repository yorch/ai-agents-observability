import type { KeyLike } from 'jose';
import { importPKCS8, importSPKI } from 'jose';

let _privateKey: KeyLike | null = null;
let _publicKey: KeyLike | null = null;

export async function getPrivateKey(): Promise<KeyLike> {
  if (_privateKey) {
    return _privateKey;
  }
  const pem = process.env.JWT_ED25519_PRIVATE_KEY;
  if (!pem) {
    throw new Error('JWT_ED25519_PRIVATE_KEY env var is not set');
  }
  _privateKey = await importPKCS8(pem, 'EdDSA');
  return _privateKey;
}

export async function getPublicKey(): Promise<KeyLike> {
  if (_publicKey) {
    return _publicKey;
  }
  const pem = process.env.JWT_ED25519_PUBLIC_KEY;
  if (!pem) {
    throw new Error('JWT_ED25519_PUBLIC_KEY env var is not set');
  }
  _publicKey = await importSPKI(pem, 'EdDSA');
  return _publicKey;
}

/** For tests: inject pre-loaded key material instead of reading from env. */
export function setKeysForTesting(privateKey: KeyLike, publicKey: KeyLike): void {
  _privateKey = privateKey;
  _publicKey = publicKey;
}

export function resetKeys(): void {
  _privateKey = null;
  _publicKey = null;
}
