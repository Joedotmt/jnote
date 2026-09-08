import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEncryptionMetadata,
  decryptStringWithState,
  deriveEncryptionKey,
  encryptStringWithState,
  isEncryptedEnvelopeString,
  normalizeEncryptionMetadata
} from '../src/lib/crypto.js';

test('the existing JNote encryption envelope round-trips Unicode plaintext', async () => {
  const metadata = createEncryptionMetadata();
  const state = {
    key: await deriveEncryptionKey('correct horse battery staple', metadata),
    metadata
  };
  const plaintext = 'A private note — Καλημέρα 🌿\nSecond line';
  const encrypted = await encryptStringWithState(plaintext, state);
  const envelope = JSON.parse(encrypted);

  assert.equal(envelope.v, 1);
  assert.equal(envelope.alg, 'AES-GCM');
  assert.equal(envelope.kdf.alg, 'PBKDF2');
  assert.equal(envelope.kdf.hash, 'SHA-256');
  assert.equal(envelope.kdf.iterations, 310000);
  assert.equal(isEncryptedEnvelopeString(encrypted), true);
  assert.equal(await decryptStringWithState(encrypted, state), plaintext);
});

test('a different passphrase cannot decrypt an envelope', async () => {
  const metadata = createEncryptionMetadata();
  const encrypted = await encryptStringWithState('secret', {
    key: await deriveEncryptionKey('first key', metadata),
    metadata
  });
  const wrongState = {
    key: await deriveEncryptionKey('second key', metadata),
    metadata
  };

  await assert.rejects(() => decryptStringWithState(encrypted, wrongState));
});

test('mixed encryption salts are rejected before decryption', async () => {
  const originalMetadata = createEncryptionMetadata();
  const encrypted = await encryptStringWithState('secret', {
    key: await deriveEncryptionKey('key', originalMetadata),
    metadata: originalMetadata
  });
  const otherMetadata = createEncryptionMetadata();
  const otherState = {
    key: await deriveEncryptionKey('key', otherMetadata),
    metadata: otherMetadata
  };

  await assert.rejects(
    () => decryptStringWithState(encrypted, otherState),
    /different key salt/
  );
});

test('invalid encryption metadata is rejected', () => {
  assert.equal(normalizeEncryptionMetadata(null), null);
  assert.equal(normalizeEncryptionMetadata({ v: 2 }), null);
  assert.equal(isEncryptedEnvelopeString('{"v":1}'), false);
  assert.equal(isEncryptedEnvelopeString('plaintext'), false);
});
