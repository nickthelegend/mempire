/**
 * Find how far apart the two client recordings are in wall-clock time.
 *
 * # Why this is needed
 *
 * The two seats are recorded by two browser contexts created several seconds
 * apart — deliberately, because booting them together gets the second one
 * rate-limited off the RPC. They also take different times to load. So the
 * same *match* moment sits at different *recording* offsets in the two files,
 * and compositing them at a shared offset shows two different moments of one
 * match side by side.
 *
 * That is exactly what made the split-screen look like two unrelated games:
 * sampling both at t=100s gave 1:38 on one seat and 1:27 on the other. Eleven
 * seconds apart, same match, and completely unconvincing on screen.
 *
 * # How
 *
 * Both clients render the same match clock, so the correct offset is the one
 * that makes the two timers identical. This crops the timer region out of both
 * videos and looks for the shift that minimises the pixel difference — a plain
 * cross-correlation, no OCR needed, and it verifies itself: at the right offset
 * the two crops are near-identical, and at any other offset they are not.
 *
 * Run: node align.mjs [takeDir]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TAKE = process.argv[2]
  ?? fileURLToPath(new URL('../../app/.demo-recording/pvp', import.meta.url));

/**
 * The clock digits, and as little else as possible.
 *
 * The first version cropped a 150px band that also caught the close button, the
 * mute icon and a slice of crowd. Those are identical at *every* offset, so
 * they contributed the same match score everywhere and buried the only signal
 * that varies. The tool reported the correct shift and then called itself
 * WEAK, because the runner-up was nearly as good — on the strength of pixels
 * that could never disagree.
 */
const CROP = 'crop=92:30:179:12';
/** Where in A's recording to take the reference samples. */
const A_FROM = 70;
const A_TO = 100;
const STEP = 1.0;
/** How far B may be behind or ahead of A. */
const SEARCH = 40;
const FINE = 0.25;

const webm = (seat) => {
  const dir = join(TAKE, seat);
  const f = readdirSync(dir).find((n) => n.endsWith('.webm'));
  if (!f) throw new Error(`no recording in ${dir}`);
  return join(dir, f);
};

const work = mkdtempSync(join(tmpdir(), 'align-'));

/** One greyscale timer crop, as a raw byte array. */
function sample(file, at, tag) {
  const out = join(work, `${tag}.pgm`);
  execFileSync('ffmpeg', [
    '-hide_banner', '-v', 'error', '-ss', String(at), '-i', file,
    '-frames:v', '1', '-vf', `${CROP},format=gray,scale=75:23`,
    '-f', 'image2', '-pix_fmt', 'gray', out, '-y',
  ]);
  const buf = readFileSync(out);
  // PGM: strip the ASCII header (three whitespace-separated fields after P5).
  let i = 0; let fields = 0;
  while (fields < 4 && i < buf.length) {
    while (i < buf.length && /\s/.test(String.fromCharCode(buf[i]))) i += 1;
    while (i < buf.length && !/\s/.test(String.fromCharCode(buf[i]))) i += 1;
    fields += 1;
  }
  return buf.subarray(i + 1);
}

const diff = (a, b) => {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i += 1) s += Math.abs(a[i] - b[i]);
  return s / n;
};

const A = webm('A');
const B = webm('B');

// Reference samples from A.
const refs = [];
for (let t = A_FROM; t <= A_TO; t += STEP) {
  refs.push({ t, px: sample(A, t, `a_${t}`) });
}

/** Mean difference across every reference when B is shifted by `d`. */
function scoreAt(d) {
  let total = 0;
  for (const r of refs) {
    const t = r.t + d;
    if (t < 1) return Infinity;
    total += diff(r.px, sample(B, t, `b_${d}_${r.t}`));
  }
  return total / refs.length;
}

console.log(`  searching ±${SEARCH}s for the shift that makes the two clocks agree`);
let best = { d: 0, score: Infinity };
for (let d = -SEARCH; d <= SEARCH; d += 1) {
  const s = scoreAt(d);
  if (s < best.score) best = { d, score: s };
}
// Refine around the winner.
for (let d = best.d - 1; d <= best.d + 1; d += FINE) {
  const s = scoreAt(d);
  if (s < best.score) best = { d, score: s };
}

const runnerUp = (() => {
  let r = { d: 0, score: Infinity };
  for (let d = -SEARCH; d <= SEARCH; d += 1) {
    if (Math.abs(d - best.d) < 3) continue;
    const s = scoreAt(d);
    if (s < r.score) r = { d, score: s };
  }
  return r;
})();

console.log(`  best offset  B = A ${best.d >= 0 ? '+' : ''}${best.d.toFixed(2)}s   (difference ${best.score.toFixed(2)})`);
console.log(`  next best    ${runnerUp.d}s (difference ${runnerUp.score.toFixed(2)})`);
// A real lock is unmistakable: the matching shift scores far below everything
// else. If it does not, the alignment is a guess and should not be trusted.
const confident = best.score < runnerUp.score * 0.6;
console.log(confident
  ? '  LOCKED — the clocks agree at this shift and nowhere near it'
  : '  WEAK — no clear winner; do not composite on this');
console.log(JSON.stringify({ offsetB: Number(best.d.toFixed(2)), confident }));
