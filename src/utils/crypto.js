/**
 * Browser-native SHA-256 hashing using Web Crypto API.
 * No external dependencies required.
 */
export async function hashPassword(plain) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyPassword(plain, hash) {
  const plainHash = await hashPassword(plain);
  return plainHash === hash;
}
