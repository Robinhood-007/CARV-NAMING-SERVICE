// src/polyfills.ts
// Must be imported FIRST in main.tsx

// Make Node-y globals some libs expect
// @ts-ignore
if (!(globalThis as any).global) (globalThis as any).global = globalThis;
// @ts-ignore
if (!(globalThis as any).process) (globalThis as any).process = { env: {} };

// Buffer polyfill for @solana/* libs
import { Buffer } from 'buffer';
if (!(globalThis as any).Buffer) {
  (globalThis as any).Buffer = Buffer;
}
