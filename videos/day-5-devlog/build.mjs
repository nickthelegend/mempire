/**
 * Render the overlay, lay it over the gameplay, and score it.
 *
 * The two-step split is inherited from `videos/day-2-devlog` and its BRIEF
 * explains why: a timed `<video>` inside a composition gets swapped for a
 * pre-extracted frame at capture, and roughly one frame in seven came back
 * drawn at 40% scale in a corner — surviving `check`, `lint` and a
 * "successful" render, because `--best-effort` defaults to true. So the
 * composition renders to a MOV with alpha and never touches the footage.
 *
 * The music is the game's own battle track, not a generated bed. It is the
 * thing a player actually hears while doing what the video shows, and it costs
 * nothing in licensing or plausibility.
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
const FINAL = join(OUT, 'mempire-day-5.mp4');
const GAMEPLAY = join(HERE, 'assets', 'gameplay.mp4');
const MUSIC = join(HERE, 'assets', 'music_battle.m4a');

/** Composition length. Must match the root `data-duration`. */
const DUR = 18;
/** Where in the track to start — past the intro, into the loop's body. */
const MUSIC_IN = 6;

const run = (cmd, args) => execFileSync(cmd, args, { cwd: HERE, stdio: 'inherit' });

for (const [p, what] of [[GAMEPLAY, 'gameplay'], [MUSIC, 'music']]) {
  if (!existsSync(p)) { console.error(`missing ${what}: ${p}`); process.exit(1); }
}
mkdirSync(OUT, { recursive: true });

console.log('\n1/2  rendering the overlay (alpha)…');
run('npx', ['hyperframes', 'render', '--format', 'mov', '--no-best-effort', '-o', OVERLAY]);

console.log('\n2/2  compositing and scoring…');
run('ffmpeg', [
  '-v', 'error', '-stats',
  '-i', GAMEPLAY,
  '-i', OVERLAY,
  '-ss', String(MUSIC_IN), '-i', MUSIC,
  '-filter_complex', [
    // Both video inputs are 1080x1920 at 30fps, so overlay needs no scaling.
    '[0:v][1:v]overlay=0:0:format=auto:shortest=1[v]',
    // Under the copy, not over it: -9dB, a half-second in, and a two-second
    // fade so the clip ends rather than being cut off mid-bar.
    `[2:a]volume=-9dB,afade=t=in:st=0:d=0.5,afade=t=out:st=${DUR - 2}:d=2,atrim=0:${DUR},asetpts=N/SR/TB[a]`,
  ].join(';'),
  '-map', '[v]', '-map', '[a]',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'slow',
  '-c:a', 'aac', '-b:a', '160k', '-ar', '44100',
  '-movflags', '+faststart', '-shortest',
  FINAL, '-y',
]);

console.log(`\n✓ ${FINAL}`);
