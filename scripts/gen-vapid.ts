// Generates a VAPID key pair for Web Push.
//   node scripts/gen-vapid.ts            → prints the keys and the wrangler commands
//   node scripts/gen-vapid.ts --dev-vars → also writes them to .dev.vars for `wrangler dev`

import { writeFileSync } from 'node:fs';

const b64url = (buf: ArrayBuffer | Uint8Array) => Buffer.from(buf as ArrayBuffer).toString('base64url');

const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
const publicKey = b64url(await crypto.subtle.exportKey('raw', pair.publicKey));
const privateKey = (await crypto.subtle.exportKey('jwk', pair.privateKey)).d!;

if (process.argv.includes('--dev-vars')) {
  writeFileSync('.dev.vars', `VAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${privateKey}\nALLOW_ANY_PUSH_HOST=true\n`);
  console.log('Wrote .dev.vars (git-ignored).');
} else {
  console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
  console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
  console.log('\nStore them on Cloudflare (paste each value when asked):');
  console.log('  npx wrangler secret put VAPID_PUBLIC_KEY');
  console.log('  npx wrangler secret put VAPID_PRIVATE_KEY');
  console.log('\nKeep the private key secret. Changing the keys later unsubscribes every phone.');
}
