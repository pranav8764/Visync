/**
 * Reproducible RDP stroke-payload benchmark.
 *
 * Measures how many points and how many JSON bytes `simplifyPath` removes from
 * synthetic freehand strokes. It does NOT measure network latency, WebSocket
 * fan-out or server routing time.
 *
 * Run:  npx vite-node bench/rdp-payload.ts
 *
 * Strokes are synthetic (seeded PRNG): a smooth curve made of a few sine waves
 * plus small hand jitter, sampled at a fixed step like pointer events. Real
 * reduction depends on drawing speed, device and sampling rate, so treat the
 * numbers as indicative for this generator only.
 */
import { simplifyPath } from '../lib/simplify';

type Point = { x: number; y: number };

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeStroke(rand: () => number, n: number, jitter: number): Point[] {
  const a = 40 + rand() * 120, b = 20 + rand() * 60;
  const f1 = 0.01 + rand() * 0.02, f2 = 0.03 + rand() * 0.04;
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) {
    pts.push({
      x: 200 + i * 2 + (rand() - 0.5) * jitter,
      y: 300 + a * Math.sin(i * f1) + b * Math.sin(i * f2) + (rand() - 0.5) * jitter,
    });
  }
  return pts;
}

const bytes = (p: Point[]) => Buffer.byteLength(JSON.stringify(p));
const pct = (before: number, after: number) => (100 * (1 - after / before)).toFixed(1);

const STROKES = 200;
console.log(`node ${process.version}, ${process.platform}/${process.arch}, ${STROKES} strokes per row, seed 42`);
console.log('points/stroke  jitter(px)  tolerance  points before->after  reduction  JSON bytes before->after  reduction');
for (const n of [50, 200, 800]) {
  for (const jitter of [0, 1, 3]) {
    for (const tol of [1]) {
      const rand = mulberry32(42);
      let pb = 0, pa = 0, bb = 0, ba = 0;
      for (let s = 0; s < STROKES; s++) {
        const stroke = makeStroke(rand, n, jitter);
        const out = simplifyPath(stroke, tol);
        pb += stroke.length; pa += out.length; bb += bytes(stroke); ba += bytes(out);
      }
      console.log(
        `${String(n).padStart(13)}  ${String(jitter).padStart(10)}  ${String(tol).padStart(9)}  ` +
        `${`${pb}->${pa}`.padStart(20)}  ${(pct(pb, pa) + '%').padStart(9)}  ` +
        `${`${bb}->${ba}`.padStart(24)}  ${pct(bb, ba)}%`
      );
    }
  }
}
