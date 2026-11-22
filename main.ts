// A tiny stack VM for make.fun's program/v1 ISA, exact to the kit's reference.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Per-opcode stack effect: one hex digit per opcode, pops * 4 + pushes.
const PP = '01146abf' + '00000000' + '99999995' + '99959990' + '99900000' +
  '00000000' + '04400000' + '00000000' + '58000000' + '00000000' + '4414';

// The two-operand group; the division family yields null on a zero divisor.
const F = {
  16: (a, b) => (a + b) | 0,
  17: (a, b) => (a - b) | 0,
  18: (a, b) => Math.imul(a, b),
  19: (a, b) => b === 0 ? null : a === -2147483648 && b === -1 ? a : (a / b) | 0,
  20: (a, b) => b === 0 ? null : b === -1 ? 0 : (a % b) | 0,
  21: (a, b) => b === 0 ? null : Math.floor((a >>> 0) / (b >>> 0)) | 0,
  22: (a, b) => b === 0 ? null : ((a >>> 0) % (b >>> 0)) | 0,
  24: (a, b) => a & b,
  25: (a, b) => a | b,
  26: (a, b) => a ^ b,
  28: (a, b) => a << (b & 31),
  29: (a, b) => a >> (b & 31),
  30: (a, b) => (a >>> (b & 31)) | 0,
  32: (a, b) => a === b ? 1 : 0,
  33: (a, b) => a < b ? 1 : 0,
  34: (a, b) => (a >>> 0) < (b >>> 0) ? 1 : 0,
};

// Executes one program on its input bytes; returns [output bytes, exit code].
function run(P, inp) {
  const n = P.length;
  const D = new Int32Array(256);
  const C = new Int32Array(64);
  const M = new Int32Array(256);
  const out = new Uint8Array(65536);
  let sp = 0, csp = 0, olen = 0, ip = 0, pc = 0, steps = 0;
  const fin = (code) => [out.subarray(0, olen), code];
  for (;;) {
    if (steps === 1000000) return fin(10); // step limit
    if (pc < 0 || pc >= n) return fin(9); // pc outside the program
    const op = P[pc];
    const known = op <= 7 || (op >= 16 && op <= 34) || (op >= 48 && op <= 52) ||
      op === 64 || op === 65 || (op >= 80 && op <= 83);
    if (!known) return fin(5); // unknown opcode
    const imm = op === 1 ? 1 : op === 2 ? 4 : op >= 48 && op <= 51 ? 2 : 0;
    if (pc + imm >= n) return fin(9); // immediate cut off by the program's end
    steps++;
    const fx = parseInt(PP[op], 16), pops = fx >> 2, pushes = fx & 3;
    if (sp < pops) return fin(2); // stack underflow
    if (sp - pops + pushes > 256) return fin(3); // stack overflow
    const nx = pc + 1 + imm; // address of the next instruction
    pc = nx;
    switch (op) {
      case 0: // HALT
        return fin(0);
      case 1: // PUSH8
        D[sp++] = (P[nx - 1] << 24) >> 24;
        break;
      case 2: // PUSH32
        D[sp++] = P[nx - 4] | (P[nx - 3] << 8) | (P[nx - 2] << 16) | (P[nx - 1] << 24);
        break;
      case 3: // POP
        sp--;
        break;
      case 4: // DUP
        D[sp] = D[sp - 1];
        sp++;
        break;
      case 5: { // SWAP
        const t = D[sp - 1];
        D[sp - 1] = D[sp - 2];
        D[sp - 2] = t;
        break;
      }
      case 6: // OVER
        D[sp] = D[sp - 2];
        sp++;
        break;
      case 7: { // ROT
        const a = D[sp - 3];
        D[sp - 3] = D[sp - 2];
        D[sp - 2] = D[sp - 1];
        D[sp - 1] = a;
        break;
      }
      case 23: // NEG
        D[sp - 1] = -D[sp - 1] | 0;
        break;
      case 27: // NOT
        D[sp - 1] = ~D[sp - 1];
        break;
      case 16: case 17: case 18: case 19: case 20: case 21: case 22:
      case 24: case 25: case 26: case 28: case 29: case 30:
      case 32: case 33: case 34: { // the two-operand group, via F above
        const r = F[op](D[sp - 2], D[sp - 1]);
        if (r === null) return fin(4); // division by zero
        sp--;
        D[sp - 1] = r;
        break;
      }
      case 48: case 49: case 50: { // JMP, JZ, JNZ
        const rel = ((P[nx - 2] | (P[nx - 1] << 8)) << 16) >> 16;
        let take = op === 48;
        if (!take) {
          const v = D[--sp];
          take = op === 49 ? v === 0 : v !== 0;
        }
        if (take) pc = nx + rel;
        break;
      }
      case 51: // CALL
        if (csp === 64) return fin(7);
        C[csp++] = nx;
        pc = P[nx - 2] | (P[nx - 1] << 8);
        break;
      case 52: // RET
        if (csp === 0) return fin(8);
        pc = C[--csp];
        break;
      case 64: { // LOAD
        const a = D[sp - 1];
        if (a < 0 || a > 255) return fin(6);
        D[sp - 1] = M[a];
        break;
      }
      case 65: { // STORE
        const a = D[sp - 1];
        if (a < 0 || a > 255) return fin(6);
        M[a] = D[sp - 2];
        sp -= 2;
        break;
      }
      case 80: { // PRINT
        const s = String(D[sp - 1]);
        if (olen + s.length > 65536) return fin(11);
        for (let k = 0; k < s.length; k++) out[olen++] = s.charCodeAt(k);
        sp--;
        break;
      }
      case 81: // PUTC
        if (olen === 65536) return fin(11);
        out[olen++] = D[--sp] & 255;
        break;
      case 82: // IN
        D[sp++] = ip < inp.length ? inp[ip++] : -1;
        break;
      case 83: // EXIT
        return fin(D[--sp] & 255);
    }
  }
}

// Answer every instance in the input directory.
for (const id of readdirSync(IN_DIR).sort()) {
  const d = join(IN_DIR, id), o = join(OUT_DIR, id);
  let inp;
  try {
    inp = readFileSync(join(d, 'input.bin'));
  } catch {
    inp = new Uint8Array(0);
  }
  const [bytes, code] = run(readFileSync(join(d, 'program.bin')), inp);
  mkdirSync(o, { recursive: true });
  writeFileSync(join(o, 'stdout.bin'), Buffer.from(bytes));
  writeFileSync(join(o, 'exit.txt'), code + '\n');
}
