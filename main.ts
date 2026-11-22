// Tiny stack VM for make.fun's tiny stack ISA v1: for every instance it
// runs program.bin on input.bin and writes stdout.bin + exit.txt, with the
// ISA's exact semantics (wrapping 32-bit arithmetic, 256-value stack,
// 64-deep call stack, 256 memory words, ten traps, step and output
// limits). No clock, no randomness: two runs agree byte for byte.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Per-opcode [immediate bytes, pops, pushes]; missing = unknown (trap 5).
const META = [];
for (const [op, imm, pops, pushes] of [
  [0x00,0,0,0], [0x01,1,0,1], [0x02,4,0,1], [0x03,0,1,0], [0x04,0,1,2],
  [0x05,0,2,2], [0x06,0,2,3], [0x07,0,3,3], [0x17,0,1,1], [0x1b,0,1,1],
  [0x30,2,0,0], [0x31,2,1,0], [0x32,2,1,0], [0x33,2,0,0], [0x34,0,0,0],
  [0x40,0,1,1], [0x41,0,2,0], [0x50,0,1,0], [0x51,0,1,0], [0x52,0,0,1],
  [0x53,0,1,0],
]) META[op] = [imm, pops, pushes];
for (const op of [0x10,0x11,0x12,0x13,0x14,0x15,0x16,0x18,0x19,0x1a,
  0x1c,0x1d,0x1e,0x20,0x21,0x22]) META[op] = [0,2,1];

// Non-trapping binary operators, by opcode.
const BIN = [];
BIN[0x10] = (a, b) => (a + b) | 0; BIN[0x11] = (a, b) => (a - b) | 0;
BIN[0x12] = (a, b) => Math.imul(a, b); BIN[0x18] = (a, b) => a & b;
BIN[0x19] = (a, b) => a | b; BIN[0x1a] = (a, b) => a ^ b;
BIN[0x1c] = (a, b) => a << (b & 31); BIN[0x1d] = (a, b) => a >> (b & 31);
BIN[0x1e] = (a, b) => (a >>> (b & 31)) | 0; BIN[0x20] = (a, b) => (a === b ? 1 : 0);
BIN[0x21] = (a, b) => (a < b ? 1 : 0); BIN[0x22] = (a, b) => ((a >>> 0) < (b >>> 0) ? 1 : 0);

function runVM(P, I) {
  const n = P.length;
  const D = new Int32Array(256), C = new Int32Array(64), M = new Int32Array(256);
  const out = new Uint8Array(65536);
  let sp = 0, csp = 0, olen = 0, ip = 0, pc = 0, steps = 0;
  const done = (code) => [code, out.slice(0, olen)];
  for (;;) {
    if (steps === 1000000) return done(10);
    if (pc < 0 || pc >= n) return done(9);
    const op = P[pc], meta = META[op];
    if (meta === undefined) return done(5);
    if (pc + meta[0] >= n) return done(9);
    steps++;
    const next = pc + 1 + meta[0];
    if (sp < meta[1]) return done(2);
    if (sp - meta[1] + meta[2] > 256) return done(3);
    pc = next;
    switch (op) {
      case 0x00: return done(0); // HALT
      case 0x01: D[sp++] = (P[next - 1] << 24) >> 24; break; // PUSH8 (sign-extended)
      case 0x02: D[sp++] = P[next - 4] | (P[next - 3] << 8) | (P[next - 2] << 16) | (P[next - 1] << 24); break; // PUSH32
      case 0x03: sp--; break; // POP
      case 0x04: D[sp] = D[sp - 1]; sp++; break; // DUP
      case 0x05: { const t = D[sp - 1]; D[sp - 1] = D[sp - 2]; D[sp - 2] = t; break; } // SWAP
      case 0x06: D[sp] = D[sp - 2]; sp++; break; // OVER
      case 0x07: { const a = D[sp - 3]; D[sp - 3] = D[sp - 2]; D[sp - 2] = D[sp - 1]; D[sp - 1] = a; break; } // ROT
      case 0x17: D[sp - 1] = -D[sp - 1] | 0; break; // NEG
      case 0x1b: D[sp - 1] = ~D[sp - 1]; break; // NOT
      case 0x13: case 0x14: case 0x15: case 0x16: { // DIV / MOD / DIVU / MODU
        const b = D[sp - 1], a = D[sp - 2];
        if (b === 0) return done(4);
        let r;
        if (op === 0x13) r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
        else if (op === 0x14) r = b === -1 ? 0 : (a % b) | 0;
        else if (op === 0x15) r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
        else r = ((a >>> 0) % (b >>> 0)) | 0;
        sp--;
        D[sp - 1] = r;
        break;
      }
      case 0x10: case 0x11: case 0x12: case 0x18: case 0x19: case 0x1a:
      case 0x1c: case 0x1d: case 0x1e: case 0x20: case 0x21: case 0x22:
        sp--;
        D[sp - 1] = BIN[op](D[sp - 1], D[sp]);
        break;
      case 0x30: case 0x31: case 0x32: { // JMP / JZ / JNZ
        const rel = ((P[next - 2] | (P[next - 1] << 8)) << 16) >> 16;
        let take = true;
        if (op !== 0x30) {
          const v = D[--sp];
          take = op === 0x31 ? v === 0 : v !== 0;
        }
        if (take) pc = next + rel;
        break;
      }
      case 0x33: // CALL
        if (csp === 64) return done(7);
        C[csp++] = next;
        pc = P[next - 2] | (P[next - 1] << 8);
        break;
      case 0x34: // RET
        if (csp === 0) return done(8);
        pc = C[--csp];
        break;
      case 0x40: { // LOAD
        const addr = D[sp - 1];
        if (addr < 0 || addr > 255) return done(6);
        D[sp - 1] = M[addr];
        break;
      }
      case 0x41: { // STORE
        const addr = D[sp - 1];
        if (addr < 0 || addr > 255) return done(6);
        M[addr] = D[sp - 2];
        sp -= 2;
        break;
      }
      case 0x50: { // PRINT
        const s = String(D[sp - 1]);
        if (olen + s.length > 65536) return done(11);
        for (let i = 0; i < s.length; i++) out[olen++] = s.charCodeAt(i);
        sp--;
        break;
      }
      case 0x51: // PUTC
        if (olen + 1 > 65536) return done(11);
        out[olen++] = D[--sp] & 255;
        break;
      case 0x52: // IN (-1 past the end)
        D[sp++] = ip < I.length ? I[ip++] : -1;
        break;
      case 0x53: // EXIT
        return done(D[--sp] & 255);
    }
  }
}

const read = (f, d) => { try { return readFileSync(f); } catch { return d; } };
const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(IN_DIR).sort()) {
  const prog = read(join(IN_DIR, id, 'program.bin'), null);
  if (prog === null) continue;
  const [code, bytes] = runVM(prog, read(join(IN_DIR, id, 'input.bin'), Buffer.alloc(0)));
  mkdirSync(join(OUT_DIR, id), { recursive: true });
  writeFileSync(join(OUT_DIR, id, 'stdout.bin'), bytes);
  writeFileSync(join(OUT_DIR, id, 'exit.txt'), code + '\n');
}
