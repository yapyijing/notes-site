// Encryption helpers shared by the browser and the Node build script.
// Content is encrypted with random AES-256-GCM keys that change on every publish:
// one for the file index, and one per group of files that the same access keys may open.
// Each active access key gets its own wrapped bundle of the keys it is allowed to hold.

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();

// A–Z and 0–9 without I and O (they look like 1 and 0): 34 symbols, about 81 bits per key.
const KEY_ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export function toB64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

export function fromB64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function toHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A new access key such as 7F3K-Q9XA-M2PD-8HVT. */
export function generateKey() {
  let body = '';
  while (body.length < 16) {
    for (const b of randomBytes(32)) {
      // Rejection sampling keeps every symbol equally likely (238 = 7 × 34).
      if (b < 238 && body.length < 16) body += KEY_ALPHABET[b % 34];
    }
  }
  return body.match(/.{4}/g).join('-');
}

/** Upper-case, strip dashes and spaces, and read a typed O or I as 0 or 1. */
export function normaliseKey(input) {
  let s = String(input || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  // Older keys were written as NOTE-XXXX-XXXX-XXXX-XXXX.
  if (s.length === 20 && s.startsWith('NOTE')) s = s.slice(4);
  return s.replace(/O/g, '0').replace(/I/g, '1');
}

export function isPlausibleKey(norm) {
  return /^[0-9A-HJ-NP-Z]{16}$/.test(norm);
}

/** Public identifier for a key: lets the site find its entry without revealing the key. */
export async function keyId(norm) {
  const digest = new Uint8Array(await subtle.digest('SHA-256', te.encode('kid:' + norm)));
  return toHex(digest.subarray(0, 8));
}

async function deriveWrapKey(norm, salt) {
  const base = await subtle.importKey('raw', te.encode(norm), 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: te.encode('notes-wrap-v1') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function importContentKey(raw) {
  return subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function wrapContentKey(rawContentKey, norm, salt) {
  const wrapKey = await deriveWrapKey(norm, salt);
  const iv = randomBytes(12);
  const wrapped = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, wrapKey, rawContentKey));
  return { iv: toB64(iv), w: toB64(wrapped) };
}

export async function unwrapContentKey(entry, norm, salt) {
  const wrapKey = await deriveWrapKey(norm, salt);
  const raw = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(entry.iv) }, wrapKey, fromB64(entry.w));
  return importContentKey(new Uint8Array(raw));
}

// A key bundle is padded to a multiple of this, so its size does not reveal how many groups a key can open.
const BUNDLE_BLOCK = 1024;

/** Encrypt a small JSON bundle of keys for one access key. */
export async function wrapBundle(bundle, norm, salt) {
  let json = JSON.stringify(bundle);
  json += ' '.repeat((BUNDLE_BLOCK - (json.length % BUNDLE_BLOCK)) % BUNDLE_BLOCK);
  return wrapContentKey(te.encode(json), norm, salt);
}

export async function unwrapBundle(entry, norm, salt) {
  const wrapKey = await deriveWrapKey(norm, salt);
  const raw = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(entry.iv) }, wrapKey, fromB64(entry.w));
  return JSON.parse(td.decode(raw));
}

/** Returns iv (12 bytes) followed by the ciphertext. */
export async function encryptBytes(key, data) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return out;
}

export async function decryptBytes(key, buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(0, 12) }, key, b.subarray(12)));
}

export async function encryptJson(key, value) {
  return encryptBytes(key, te.encode(JSON.stringify(value)));
}

export async function decryptJson(key, buf) {
  return JSON.parse(td.decode(await decryptBytes(key, buf)));
}
