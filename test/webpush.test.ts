import { createECDH, randomBytes } from 'node:crypto';
import ece from 'http_ece';
import { describe, expect, it } from 'vitest';
import { b64urlDecode, b64urlEncode, encryptPayload, isValidClientKeys, vapidAuthorization } from '../worker/webpush';

function browserSubscription() {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = randomBytes(16);
  return { ua, auth, p256dh: ua.getPublicKey().toString('base64url'), authB64: auth.toString('base64url') };
}

describe('base64url', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array(randomBytes(77));
    expect(b64urlDecode(b64urlEncode(bytes))).toEqual(bytes);
    expect(b64urlEncode(bytes)).not.toMatch(/[+/=]/);
  });
});

describe('encryptPayload', () => {
  it('produces an aes128gcm body a reference implementation can decrypt', async () => {
    const sub = browserSubscription();
    const message = JSON.stringify({ title: 'Gerald is staring at you.', body: 'Drink.' });
    const body = await encryptPayload(new TextEncoder().encode(message), { p256dh: sub.p256dh, auth: sub.authB64 });

    // Header: 16 salt + 4 record size + 1 key length + 65 sender key.
    expect(new DataView(body.buffer).getUint32(16)).toBe(4096);
    expect(body[20]).toBe(65);

    const plain = ece.decrypt(Buffer.from(body), { version: 'aes128gcm', privateKey: sub.ua, authSecret: sub.auth });
    expect(plain.toString('utf8')).toBe(message);
  });

  it('uses a fresh salt and sender key for every message', async () => {
    const sub = browserSubscription();
    const payload = new TextEncoder().encode('same');
    const a = await encryptPayload(payload, { p256dh: sub.p256dh, auth: sub.authB64 });
    const b = await encryptPayload(payload, { p256dh: sub.p256dh, auth: sub.authB64 });
    expect(Buffer.from(a.slice(0, 16)).equals(Buffer.from(b.slice(0, 16)))).toBe(false);
  });
});

describe('isValidClientKeys', () => {
  it('accepts real keys and rejects junk', () => {
    const sub = browserSubscription();
    expect(isValidClientKeys(sub.p256dh, sub.authB64)).toBe(true);
    expect(isValidClientKeys('abc', sub.authB64)).toBe(false);
    expect(isValidClientKeys(sub.p256dh, 'abc')).toBe(false);
  });
});

describe('vapidAuthorization', () => {
  it('signs an ES256 JWT for the push service origin', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const publicKey = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
    const privateKey = (await crypto.subtle.exportKey('jwk', pair.privateKey)).d!;
    const now = Date.UTC(2026, 9, 4, 12);

    const header = await vapidAuthorization(
      'https://fcm.googleapis.com/fcm/send/abc123',
      { publicKey, privateKey, subject: 'https://sipster.example' },
      now,
    );
    const match = header.match(/^vapid t=([^,]+), k=(.+)$/);
    expect(match).not.toBeNull();
    const [, jwt, k] = match!;
    expect(k).toBe(publicKey);

    const [h, c, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(Buffer.from(c, 'base64url').toString())).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: now / 1000 + 12 * 3600,
      sub: 'https://sipster.example',
    });
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.publicKey,
      b64urlDecode(s),
      new TextEncoder().encode(`${h}.${c}`),
    );
    expect(ok).toBe(true);
  });
});
