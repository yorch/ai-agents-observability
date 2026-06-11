export async function hashPassword(plaintext: string): Promise<string> {
  return Bun.password.hash(plaintext);
}

export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  return Bun.password.verify(plaintext, hash);
}
