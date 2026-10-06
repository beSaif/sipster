// Generates a VAPID key pair for Web Push.
//   node scripts/gen-vapid.ts            → prints the keys and the wrangler commands
//   node scripts/gen-vapid.ts --dev-vars → also writes them to .dev.vars for `wrangler dev`
//
// --dev-vars only touches its own three lines: everything else in .dev.vars (the Google OAuth
// secrets, comments) survives regenerating the keys. GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are
// added as empty placeholders when they are missing (see .dev.vars.example).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const b64url = (buf: ArrayBuffer | Uint8Array) => Buffer.from(buf as ArrayBuffer).toString('base64url');

const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
const publicKey = b64url(await crypto.subtle.exportKey('raw', pair.publicKey));
const privateKey = (await crypto.subtle.exportKey('jwk', pair.privateKey)).d!;

const DEV_VARS = '.dev.vars';
const GOOGLE_KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];
const GOOGLE_COMMENT = '# Sign in with Google: the OAuth client from the Google Cloud console (see .dev.vars.example).';

/** The variable a dotenv line sets, or null for comments and blank lines. */
function keyOf(line: string): string | null {
  const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
  return m ? m[1] : null;
}

/** Writes the three push lines into .dev.vars, replacing them in place when they exist. */
function writeDevVars(): void {
  const fresh = new Map<string, string>([
    ['VAPID_PUBLIC_KEY', `VAPID_PUBLIC_KEY=${publicKey}`],
    ['VAPID_PRIVATE_KEY', `VAPID_PRIVATE_KEY=${privateKey}`],
    ['ALLOW_ANY_PUSH_HOST', 'ALLOW_ANY_PUSH_HOST=true'],
  ]);
  const ours = new Set(fresh.keys());
  const existing = existsSync(DEV_VARS) ? readFileSync(DEV_VARS, 'utf8').split(/\r?\n/) : [];
  const out: string[] = [];
  for (const line of existing) {
    const key = keyOf(line);
    if (key === null || !ours.has(key)) {
      out.push(line);
    } else if (fresh.has(key)) {
      out.push(fresh.get(key)!); // replaced in place; a later duplicate of the same variable is dropped
      fresh.delete(key);
    }
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  out.push(...fresh.values()); // whatever wasn't there yet (all three for a fresh file)

  const present = new Set(out.map(keyOf));
  const missingGoogle = GOOGLE_KEYS.filter((k) => !present.has(k));
  if (missingGoogle.length) {
    if (!out.includes(GOOGLE_COMMENT)) out.push(GOOGLE_COMMENT);
    out.push(...missingGoogle.map((k) => `${k}=`));
  }
  writeFileSync(DEV_VARS, out.join('\n') + '\n');
}

if (process.argv.includes('--dev-vars')) {
  writeDevVars();
  console.log('Wrote .dev.vars (git-ignored).');
} else {
  console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
  console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
  console.log('\nStore them on Cloudflare (paste each value when asked):');
  console.log('  npx wrangler secret put VAPID_PUBLIC_KEY');
  console.log('  npx wrangler secret put VAPID_PRIVATE_KEY');
  console.log('\nKeep the private key secret. Changing the keys later unsubscribes every phone.');
}
