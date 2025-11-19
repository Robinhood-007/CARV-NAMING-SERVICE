// src/polyfills.ts
// Must be imported FIRST in main.tsx

// Make Node-y globals some libs expect
// @ts-ignore
if (!(globalThis as any).global) (globalThis as any).global = globalThis;
import process from 'process';
// @ts-ignore
if (!(globalThis as any).process) {
  // process/browser provides browser: true, env, versions, version
  (globalThis as any).process = process;
}
// Ensure required fields exist even if a different shim runs first
// @ts-ignore
if (!(globalThis as any).process.browser) (globalThis as any).process.browser = true;
// @ts-ignore
if (!(globalThis as any).process.env) (globalThis as any).process.env = {};
// @ts-ignore
if (!(globalThis as any).process.version) (globalThis as any).process.version = '';
// @ts-ignore
if (!(globalThis as any).process.versions) (globalThis as any).process.versions = {};

// Buffer polyfill for @solana/* libs
import { Buffer } from 'buffer';
if (!(globalThis as any).Buffer) {
  (globalThis as any).Buffer = Buffer;
}
