/**
 * Render the overlay, then lay it over the gameplay.
 *
 * Why two steps instead of one `<video>` inside the composition:
 * the producer swaps each timed `<video>` for a pre-extracted frame at capture
 * time, and on this project roughly one frame in seven came back drawn at ~40%
 * scale in the top-left corner with the rest of the frame empty. It survived
 * every gate — `check` passed, `lint` passed, and the render reported success —
 * because `--best-effort` is on by default and treats unready media as a
 * warning. `--video-frame-format=png`, a single worker and `--no-best-effort`
 * all failed to shift it.
 *
 * So the composition never touches the footage. It renders to a MOV with a
 * real alpha channel — text, scrims, chips, nothing else — and ffmpeg puts the
 * gameplay underneath. The overlay is deterministic because HyperFrames owns
 * it; the footage is correct because nothing re-encodes it into a frame
 * sequence first.
 *
 * Usage: node build.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'renders');
const OVERLAY = join(OUT, 'overlay.mov');
const FINAL = join(OUT, 'mempire-day-2.mp4');
const GAMEPLAY = join(HERE, 'assets', 'gameplay.mp4');

const run = (cmd, args) =>
  execFileSync(cmd, args, { cwd: HERE, stdio: 'inherit' });

if (!existsSync(GAMEPLAY)) {
  console.error(`missing ${GAMEPLAY} — capture it first with app/capture-gameplay.mjs`);
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

console.log('\n1/2  rendering the overlay (alpha)…');
// MOV carries the alpha channel; --no-best-effort makes unready media an error
// rather than a silently damaged frame.
run('npx', [
  'hyperframes', 'render',
  '--format', 'mov',
  '--no-best-effort',
  '-o', OVERLAY,
]);

console.log('\n2/2  compositing over the gameplay…');
run('ffmpeg', [
  '-v', 'error', '-stats',
  '-i', GAMEPLAY,
  '-i', OVERLAY,
  // Both inputs are already 1080x1920 at 30fps, so overlay needs no scaling.
  // shortest=1 ends on the 10s overlay rather than any encoder tail.
  '-filter_complex', '[0:v][1:v]overlay=0:0:format=auto:shortest=1[v]',
  '-map', '[v]',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'slow',
  '-movflags', '+faststart', '-an',
  FINAL, '-y',
]);

console.log(`\n✓ ${FINAL}`);
