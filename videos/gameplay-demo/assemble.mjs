/**
 * Build the demo: aligned two-up match, narration with silences, music under.
 *
 * # The two-up shots are time-aligned, not offset-aligned
 *
 * The two seats are recorded by browser contexts created seconds apart, so the
 * same match moment lives at different offsets in the two files. Compositing
 * them at a shared offset showed 1:38 next to 1:27 — one match, two instants,
 * and it read on screen as two unrelated games. `align.mjs` measures the shift
 * from the match clocks themselves; `MATCH_OFFSET_B` is that measurement.
 *
 * # The frame says what it is
 *
 * Even correctly aligned, two top-down arenas drawn from opposite ends do not
 * announce themselves as one match. Each panel is labelled with its seat and
 * the frame carries the on-chain match id, so the claim is stated rather than
 * left to be inferred from mirrored crown counts.
 *
 * # Holds, not sentences
 *
 * `timeline.json` gives each shot a duration independent of its narration, so
 * the picture can outlast the line and some shots can carry no line at all.
 *
 * Run: node assemble.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REC = join(HERE, '../../app/.demo-recording');
const WORK = join(HERE, 'work');
const OUT = join(HERE, 'renders');

const W = 1920;
const H = 1080;
const COL_W = Math.round((430 / 932) * H); // 498
const BG = '#0b1b3a';
const FONT = '/System/Library/Fonts/Supplemental/Arial Bold.ttf';

/** Measured by align.mjs: seat B's recording runs this many seconds behind A's. */
const MATCH_OFFSET_B = -11.25;
/** The on-chain match these recordings are of. */
const MATCH_ID = 61;

mkdirSync(WORK, { recursive: true });
mkdirSync(OUT, { recursive: true });

const ff = (args) => execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', ...args], { stdio: 'inherit' });
const dur = (f) => Number(execFileSync('ffprobe', [
  '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f,
], { encoding: 'utf8' }).trim());

const timeline = JSON.parse(readFileSync(join(HERE, 'timeline.json'), 'utf8'));
const timing = JSON.parse(readFileSync(join(HERE, 'vo', 'timing.json'), 'utf8'));
const lineById = new Map(timing.lines.map((l) => [l.id, l]));
const RATE = timeline.playbackRate;

const feat = (n) => join(REC, 'features', `${n}.webm`);
const seat = (take, s) => {
  const dir = join(REC, take, s);
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).find((n) => n.endsWith('.webm'));
  return f ? join(dir, f) : null;
};
const TAKES = { long: 'pvp', rush: 'pvp' };

/**
 * The overlay is a PNG, not `drawtext`.
 *
 * This ffmpeg is built without libfreetype, so the `drawtext` filter does not
 * exist at all — the filter graph failed outright rather than degrading. PIL
 * renders the labels once into a transparent 1920x1080 layer, which composites
 * with a plain `overlay` and gives better type than drawtext would have.
 */
const LABELS = join(WORK, 'labels.png');
execFileSync('python3', [join(HERE, 'make-labels.py'), LABELS, String(MATCH_ID)], { stdio: 'ignore' });

/**
 * An animated title sequence, from a rendered PNG frame sequence.
 *
 * This replaced a `zoompan` push-in on a still. A slow zoom is what you reach
 * for when you have a static plate and want it to stop looking static, and it
 * reads as a slideshow transition rather than a title — the logo should arrive,
 * not creep. `make-intro.py` renders every frame with its own easing, so the
 * logo drops and overshoots, the tagline rises under it, and the plate and
 * button follow on their own curves.
 */
function frames(name, seconds, out) {
  ff([
    '-framerate', '30', '-i', join(HERE, 'frames', `${name}_%04d.png`),
    '-vf', `fade=t=in:st=0:d=0.4,fade=t=out:st=${(seconds - 0.5).toFixed(2)}:d=0.5,format=yuv420p`,
    '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-r', '30',
    '-t', String(seconds), out, '-y',
  ]);
}

/**
 * A desktop capture — the Solana Explorer — fitted into the frame.
 *
 * Recorded at 1280x900, which is neither the frame's shape nor its size, so it
 * is scaled to fit and centred on the same navy field the rest of the video
 * uses. Letterboxed rather than cropped: the parts that would be cropped are
 * the account names and addresses, which are the entire reason the shot exists.
 */
function web(src, from, seconds, out) {
  const h = Math.round(H * 0.86);
  ff([
    '-f', 'lavfi', '-t', String(seconds), '-i', `color=c=${BG}:s=${W}x${H}:r=30`,
    '-ss', String(from), '-t', String(seconds), '-i', src,
    '-filter_complex',
    `[1:v]scale=-2:${h}:flags=lanczos,setsar=1[c];`
    + `[0:v][c]overlay=(W-w)/2:(H-h)/2:shortest=1,format=yuv420p[v]`,
    '-map', '[v]', '-an', '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-r', '30',
    '-t', String(seconds), out, '-y',
  ]);
}

/** One clip, centred. */
function single(src, from, seconds, out) {
  ff([
    '-f', 'lavfi', '-t', String(seconds), '-i', `color=c=${BG}:s=${W}x${H}:r=30`,
    '-ss', String(from), '-t', String(seconds), '-i', src,
    '-filter_complex',
    `[1:v]scale=${COL_W}:${H}:flags=lanczos,setsar=1[c];`
    + `[0:v][c]overlay=(W-w)/2:0:shortest=1,format=yuv420p[v]`,
    '-map', '[v]', '-an', '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-r', '30',
    '-t', String(seconds), out, '-y',
  ]);
}

/**
 * Both seats at the same match moment, labelled.
 *
 * `fromA` is a position in seat A's recording; seat B is read from the same
 * moment translated by the measured offset.
 */
function two(a, b, fromA, seconds, out) {
  const gap = 44;
  const x1 = Math.round((W - (COL_W * 2 + gap)) / 2);
  const x2 = x1 + COL_W + gap;
  const fromB = Math.max(0, fromA + MATCH_OFFSET_B);
  ff([
    '-f', 'lavfi', '-t', String(seconds), '-i', `color=c=${BG}:s=${W}x${H}:r=30`,
    '-ss', String(fromA), '-t', String(seconds), '-i', a,
    '-ss', String(fromB), '-t', String(seconds), '-i', b,
    // `-loop 1`, because a PNG is one frame. Without it the label layer ends
    // after 1/30th of a second, and `shortest` on that overlay ended the whole
    // shot with it — every two-up clip came out 0.0s long while ffmpeg
    // reported success. The colour base already carries `-t`, so nothing else
    // needs to bound the output.
    '-loop', '1', '-i', LABELS,
    '-filter_complex',
    `[1:v]scale=${COL_W}:${H}:flags=lanczos,setsar=1[l];`
    + `[2:v]scale=${COL_W}:${H}:flags=lanczos,setsar=1[r];`
    + `[0:v][l]overlay=${x1}:0[t];[t][r]overlay=${x2}:0[s];`
    + `[s][3:v]overlay=0:0,format=yuv420p[v]`,
    '-map', '[v]', '-an', '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-r', '30',
    '-t', String(seconds), out, '-y',
  ]);
}

// ── cut the picture ────────────────────────────────────────────────────────
const parts = [];
const schedule = [];
let clock = 0;

for (const [i, step] of timeline.shots.entries()) {
  const seconds = step.hold;
  const out = join(WORK, `${String(i).padStart(2, '0')}_${step.shot}.mp4`);

  if (step.frames) {
    frames(step.frames, seconds, out);
  } else if (step.match) {
    // Seat A's recording of match #61, treated exactly like any other single
    // client shot — no second panel, no labels, nothing to reconcile.
    const a = seat('pvp', 'A');
    if (!a) { console.log(`  skip ${step.shot} — no match take`); continue; }
    single(a, Math.min(step.from, Math.max(0, dur(a) - seconds - 0.5)), seconds, out);
  } else if (step.web) {
    const src = join(REC, 'explorer', `${step.web}.webm`);
    if (!existsSync(src)) { console.log(`  skip ${step.shot} — no explorer clip ${step.web}`); continue; }
    web(src, Math.min(step.from, Math.max(0, dur(src) - seconds - 0.3)), seconds, out);
  } else {
    const src = feat(step.src);
    if (!existsSync(src)) { console.log(`  skip ${step.shot} — missing ${step.src}`); continue; }
    single(src, Math.min(step.from, Math.max(0, dur(src) - seconds - 0.3)), seconds, out);
  }

  // A shot that opens on a blank frame is a mis-chosen offset, not a style.
  const probe = join(WORK, 'probe.png');
  ff(['-ss', '0.3', '-i', out, '-frames:v', '1', '-vf', `crop=${COL_W}:${H}:${Math.round((W - COL_W) / 2)}:0`, probe, '-y']);
  const bytes = Number(execFileSync('sh', ['-c', `wc -c < ${JSON.stringify(probe)}`], { encoding: 'utf8' }).trim());

  parts.push(out);
  schedule.push({ ...step, startsAt: clock, seconds });
  console.log(`  ${String(clock).padStart(5)}s  ${step.shot.padEnd(16)} ${String(seconds).padStart(3)}s`
    + `${step.line ? '' : '   (no narration — music only)'}${bytes < 25_000 ? '   ⚠ blank open' : ''}`);
  clock += seconds;
}

const list = join(WORK, 'parts.txt');
writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'));
const silent = join(WORK, 'silent.mp4');
ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', silent, '-y']);
const total = dur(silent);

// ── narration, placed a beat into each shot that has one ───────────────────
const LEAD = 0.6;
const voiced = schedule.filter((s) => s.line && lineById.has(s.line));
const inputs = [];
const delays = [];
voiced.forEach((s, i) => {
  inputs.push('-i', lineById.get(s.line).file);
  const at = Math.round((s.startsAt + LEAD) * 1000);
  delays.push(`[${i + 2}:a]adelay=${at}|${at}[v${i}]`);
});

/**
 * Music under the voice, ducked by the voice.
 *
 * `sidechaincompress` pulls the bed down whenever narration is playing and
 * lets it come back up in the gaps, which is what makes the silences feel
 * deliberate rather than empty.
 */
const voMix = `${delays.join(';')};${voiced.map((_, i) => `[v${i}]`).join('')}`
  + `amix=inputs=${voiced.length}:normalize=0[vo]`;

const mixed = join(WORK, 'mixed.mp4');
ff([
  '-i', silent,
  '-stream_loop', '-1', '-i', join(HERE, 'music', 'bed-long.wav'),
  ...inputs,
  '-filter_complex',
  `${voMix};`
  + `[vo]asplit=2[vo1][vokey];`
  + `[1:a]atrim=0:${total},volume=0.34[bed];`
  + `[bed][vokey]sidechaincompress=threshold=0.05:ratio=6:attack=15:release=420[duck];`
  + `[duck][vo1]amix=inputs=2:normalize=0,afade=t=out:st=${(total - 1.6).toFixed(2)}:d=1.6[a]`,
  '-map', '0:v', '-map', '[a]',
  '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', String(total),
  mixed, '-y',
]);

// ── 1.2x, picture and sound together ───────────────────────────────────────
const master = join(OUT, 'mempire-gameplay-1080p.mp4');
ff([
  '-i', mixed,
  '-filter_complex', `[0:v]setpts=PTS/${RATE}[v];[0:a]atempo=${RATE}[a]`,
  '-map', '[v]', '-map', '[a]',
  '-c:v', 'libx264', '-crf', '19', '-preset', 'slow', '-r', '30',
  '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
  master, '-y',
]);

const webCut = join(OUT, 'mempire-gameplay-web.mp4');
ff(['-i', master, '-vf', 'scale=1280:720', '-c:v', 'libx264', '-crf', '25', '-preset', 'slow',
  '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', webCut, '-y']);

const mins = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
console.log(`\n  ${parts.length} shots · ${voiced.length} narrated · ${parts.length - voiced.length} music-only`);
console.log(`  raw    ${mins(total)}`);
console.log(`  master ${mins(dur(master))}  ${master}`);
