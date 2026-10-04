// Web Push sender on plain WebCrypto (works in Workers and Node 20+):
// VAPID (RFC 8292) auth + aes128gcm payload encryption (RFC 8188 / RFC 8291).

type Bytes = Uint8Array<ArrayBuffer>;

const encoder = new TextEncoder();
const utf8 = (s: string): Bytes => encoder.encode(s) as Bytes;

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Bytes {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

export interface PushTarget {
  endpoint: string;
  /** Client public key, base64url, uncompressed P-256 point (65 bytes). */
  p256dh: string;
  /** Client auth secret, base64url (16 bytes). */
  auth: string;
}

export interface VapidKeys {
  /** base64url uncompressed P-256 public key (65 bytes). */
  publicKey: string;
  /** base64url private scalar `d` (32 bytes). */
  privateKey: string;
  /** "mailto:…" or "https://…" contact for push services. */
  subject: string;
}

export function isValidClientKeys(p256dh: string, auth: string): boolean {
  try {
    const pub = b64urlDecode(p256dh);
    return pub.length === 65 && pub[0] === 4 && b64urlDecode(auth).length === 16;
  } catch {
    return false;
  }
}

export interface EncryptOptions {
  /** Fixed salt / sender key pair, for tests only. */
  salt?: Bytes;
  senderKeys?: CryptoKeyPair;
}

/** Encrypts `payload` for one subscription as a single aes128gcm record. */
export async function encryptPayload(payload: Uint8Array, target: Pick<PushTarget, 'p256dh' | 'auth'>, opts: EncryptOptions = {}): Promise<Bytes> {
  const uaPublic = b64urlDecode(target.p256dh);
  const authSecret = b64urlDecode(target.auth);

  const sender =
    opts.senderKeys ??
    ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', sender.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  // Passed as a variable: Workers and DOM typings name the `public` member differently.
  const ecdhParams = { name: 'ECDH', public: uaKey };
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(ecdhParams, sender.privateKey, 256));

  const ikm = await hkdf(authSecret, ecdhSecret, concat(utf8('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = opts.salt ?? (crypto.getRandomValues(new Uint8Array(16)) as Bytes);
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // 0x02 marks the last (and only) record; no extra padding.
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(payload, Uint8Array.of(2))));

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  return concat(salt, recordSize, Uint8Array.of(asPublic.length), asPublic, ciphertext);
}

async function importVapidPrivateKey(vapid: VapidKeys): Promise<CryptoKey> {
  const pub = b64urlDecode(vapid.publicKey);
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: b64urlEncode(pub.slice(1, 33)),
    y: b64urlEncode(pub.slice(33, 65)),
    d: vapid.privateKey,
    ext: true,
  };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/** `Authorization` header value for a push to `endpoint`. */
export async function vapidAuthorization(endpoint: string, vapid: VapidKeys, now = Date.now()): Promise<string> {
  const header = b64urlEncode(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(
    utf8(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: vapid.subject })),
  );
  const unsigned = `${header}.${claims}`;
  const key = await importVapidPrivateKey(vapid);
  // WebCrypto ECDSA signatures are already raw r||s, which is what JWS ES256 wants.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(unsigned)));
  return `vapid t=${unsigned}.${b64urlEncode(sig)}, k=${vapid.publicKey}`;
}

export interface SendOptions {
  /** Seconds the push service should keep trying to deliver. */
  ttl?: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
}

export async function sendPush(target: PushTarget, payload: unknown, vapid: VapidKeys, opts: SendOptions = {}): Promise<Response> {
  const body = await encryptPayload(utf8(JSON.stringify(payload)), target);
  return fetch(target.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuthorization(target.endpoint, vapid),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(opts.ttl ?? 3600),
      Urgency: opts.urgency ?? 'normal',
    },
    body,
  });
}
