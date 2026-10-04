declare module 'http_ece' {
  import type { ECDH } from 'node:crypto';
  interface Params {
    version: 'aes128gcm' | 'aesgcm' | 'aesgcm128';
    privateKey?: ECDH;
    authSecret?: Buffer;
    dh?: Buffer;
    key?: Buffer;
  }
  const ece: { decrypt(buffer: Buffer, params: Params): Buffer; encrypt(buffer: Buffer, params: Params): Buffer };
  export default ece;
}
