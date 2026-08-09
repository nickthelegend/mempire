/**
 * Render the narration with Kokoro, one WAV per line.
 *
 * # Why per-line rather than one long take
 *
 * The edit is cut to the voiceover, not the other way round. Rendering each
 * beat separately gives an exact duration for every line before a single frame
 * is captured, so the capture harness knows how long to hold each shot and the
 * assembly never has to stretch or squeeze anything to fit.
 *
 * It also makes a rewrite cheap: changing one sentence re-renders one file
 * instead of the whole track, and the timing of everything after it shifts by a
 * known amount rather than silently drifting.
 *
 * # Speed
 *
 * Rendered at 1.0 deliberately. The finished cut is played back at 1.2, which
 * is where the energy comes from — generating fast *and* playing fast compounds
 * to about 1.26 and turns the delivery into gabble.
 *
 * Writes `timing.json` next to the audio: the manifest the capture and assembly
 * steps both read.
 *
 * Run: node tts.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'vo');
const MODEL = `${process.env.HOME}/.cache/hyperframes/tts/models/kokoro-v1.0.onnx`;
const VOICES = `${process.env.HOME}/.cache/hyperframes/tts/voices/voices-v1.0.bin`;

/** Beat of silence after each line, so lines do not run into each other. */
const GAP_S = 0.45;

const script = JSON.parse(readFileSync(join(HERE, 'script.json'), 'utf8'));
mkdirSync(OUT, { recursive: true });

// Python does the synthesis — kokoro-onnx is a Python package and there is no
// point reimplementing its tokeniser to keep this file monolingual.
const py = `
import json, sys
from kokoro_onnx import Kokoro
import soundfile as sf

spec = json.loads(sys.argv[1])
k = Kokoro(${JSON.stringify(MODEL)}, ${JSON.stringify(VOICES)})
out = []
for line in spec["lines"]:
    audio, sr = k.create(
        line["text"], voice=spec["voice"], speed=spec["speed"], lang=spec["lang"],
    )
    path = ${JSON.stringify(OUT)} + "/" + line["id"] + ".wav"
    sf.write(path, audio, sr)
    out.append({
        "id": line["id"], "shot": line["shot"], "text": line["text"],
        "file": path, "seconds": round(len(audio) / sr, 3),
    })
print(json.dumps(out))
`;

const raw = execFileSync('python3', ['-c', py, JSON.stringify(script)], {
  encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
});
const lines = JSON.parse(raw.trim().split('\n').at(-1));

// Absolute start times, so a shot can be looked up by when it begins rather
// than by summing the ones before it at every call site.
let t = 0;
for (const l of lines) {
  l.startsAt = Number(t.toFixed(3));
  t += l.seconds + GAP_S;
  l.endsAt = Number((t - GAP_S).toFixed(3));
}

const manifest = {
  voice: script.voice,
  speed: script.speed,
  gapSeconds: GAP_S,
  totalSeconds: Number(t.toFixed(3)),
  playbackRate: 1.2,
  finalSeconds: Number((t / 1.2).toFixed(3)),
  lines,
};
writeFileSync(join(HERE, 'vo', 'timing.json'), `${JSON.stringify(manifest, null, 2)}\n`);

for (const l of lines) {
  console.log(`  ${l.startsAt.toFixed(2).padStart(6)}s  ${l.seconds.toFixed(2)}s  ${l.shot.padEnd(12)} ${l.text.slice(0, 58)}`);
}
console.log(`\n  ${lines.length} lines · ${manifest.totalSeconds.toFixed(1)}s spoken · ${manifest.finalSeconds.toFixed(1)}s at 1.2x`);
