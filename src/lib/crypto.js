const ENCRYPTED_VALUE_VERSION = 1;
const ENCRYPTION_ALGORITHM = 'AES-GCM';
const KDF_ALGORITHM = 'PBKDF2';
const KDF_HASH = 'SHA-256';
const KDF_ITERATIONS = 310000;
const AES_KEY_LENGTH = 256;
const ENCRYPTION_SALT_BYTES = 16;
const ENCRYPTION_IV_BYTES = 12;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function assertWebCryptoAvailable() {
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) {
    throw new Error('Web Crypto is unavailable. Open this app over HTTPS or localhost.');
  }
}

export function createEncryptionMetadata(salt = randomBase64(ENCRYPTION_SALT_BYTES)) {
  return {
    v: ENCRYPTED_VALUE_VERSION,
    alg: ENCRYPTION_ALGORITHM,
    kdf: {
      alg: KDF_ALGORITHM,
      hash: KDF_HASH,
      iterations: KDF_ITERATIONS,
      salt
    }
  };
}

export function normalizeEncryptionMetadata(metadata) {
  if (!metadata || metadata.v !== ENCRYPTED_VALUE_VERSION || metadata.alg !== ENCRYPTION_ALGORITHM) {
    return null;
  }
  if (metadata.kdf?.alg !== KDF_ALGORITHM || metadata.kdf?.hash !== KDF_HASH) return null;
  if (!Number.isInteger(metadata.kdf?.iterations) || metadata.kdf.iterations <= 0) return null;
  if (typeof metadata.kdf?.salt !== 'string' || !metadata.kdf.salt) return null;

  return {
    v: metadata.v,
    alg: metadata.alg,
    kdf: {
      alg: metadata.kdf.alg,
      hash: metadata.kdf.hash,
      iterations: metadata.kdf.iterations,
      salt: metadata.kdf.salt
    }
  };
}

export async function deriveEncryptionKey(passphrase, metadata, options = {}) {
  assertWebCryptoAvailable();

  const baseKey = await globalThis.crypto.subtle.importKey(
    'raw',
    textEncoder.encode(passphrase),
    KDF_ALGORITHM,
    false,
    ['deriveKey']
  );

  return globalThis.crypto.subtle.deriveKey(
    {
      name: KDF_ALGORITHM,
      salt: base64ToBytes(metadata.kdf.salt),
      iterations: metadata.kdf.iterations,
      hash: metadata.kdf.hash
    },
    baseKey,
    { name: ENCRYPTION_ALGORITHM, length: AES_KEY_LENGTH },
    Boolean(options.extractable),
    ['encrypt', 'decrypt']
  );
}

export async function importRememberedKey(rawKey) {
  assertWebCryptoAvailable();

  return globalThis.crypto.subtle.importKey(
    'raw',
    base64ToBytes(rawKey),
    { name: ENCRYPTION_ALGORITHM, length: AES_KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function exportKey(key) {
  const rawKey = await globalThis.crypto.subtle.exportKey('raw', key);
  return bytesToBase64(new Uint8Array(rawKey));
}

export async function encryptStringWithState(plaintext, state) {
  if (!state) throw new Error('Notes are locked.');
  assertWebCryptoAvailable();

  const iv = globalThis.crypto.getRandomValues(new Uint8Array(ENCRYPTION_IV_BYTES));
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: ENCRYPTION_ALGORITHM, iv },
    state.key,
    textEncoder.encode(String(plaintext ?? ''))
  );

  return JSON.stringify({
    ...state.metadata,
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(ciphertext))
  });
}

export async function decryptStringWithState(encryptedValue, state) {
  if (!state) throw new Error('Notes are locked.');
  assertWebCryptoAvailable();

  const envelope = parseEncryptedEnvelope(encryptedValue);
  if (envelope.kdf.salt !== state.metadata.kdf.salt) {
    throw new Error('Encrypted data was created with a different key salt.');
  }

  const plaintext = await globalThis.crypto.subtle.decrypt(
    { name: ENCRYPTION_ALGORITHM, iv: base64ToBytes(envelope.iv) },
    state.key,
    base64ToBytes(envelope.ct)
  );

  return textDecoder.decode(plaintext);
}

export function parseEncryptedEnvelope(value) {
  let envelope;
  try {
    envelope = JSON.parse(value);
  } catch {
    throw new Error('Encrypted value is not a valid encryption envelope.');
  }

  const metadata = normalizeEncryptionMetadata(envelope);
  if (!metadata || typeof envelope.iv !== 'string' || typeof envelope.ct !== 'string') {
    throw new Error('Encrypted value is missing required encryption metadata.');
  }

  return { ...metadata, iv: envelope.iv, ct: envelope.ct };
}

export function extractEncryptionMetadata(value) {
  if (!isEncryptedEnvelopeString(value)) return null;

  try {
    return normalizeEncryptionMetadata(JSON.parse(value));
  } catch {
    return null;
  }
}

export function isEncryptedEnvelopeString(value) {
  if (typeof value !== 'string' || !value.trim().startsWith('{')) return false;

  try {
    const parsed = JSON.parse(value);
    return Boolean(
      normalizeEncryptionMetadata(parsed)
      && typeof parsed.iv === 'string'
      && typeof parsed.ct === 'string'
    );
  } catch {
    return false;
  }
}

export function randomBase64(byteLength) {
  assertWebCryptoAvailable();
  return bytesToBase64(globalThis.crypto.getRandomValues(new Uint8Array(byteLength)));
}

export function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export const encryptionFormat = {
  version: ENCRYPTED_VALUE_VERSION,
  algorithm: ENCRYPTION_ALGORITHM
};
