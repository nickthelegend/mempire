import * as THREE from 'three';

/**
 * Arena textures drawn on a canvas rather than generated as images.
 *
 * A checkerboard has to be pixel-exact to read as a play grid — an AI texture
 * gives soft, irregular squares and a visible tile seam. Canvas gives crisp
 * edges, perfect tiling, and costs a few KB instead of a megabyte.
 *
 * Everything here is seeded rather than random. A board that reshuffles its
 * own grass between matches reads as unstable, and the same texture every run
 * is also the only way a screenshot of the arena is reproducible.
 */

function canvas(size: number, height = size): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = height;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  return [c, ctx];
}

function finish(c: HTMLCanvasElement, repeat: [number, number]): THREE.Texture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** A small deterministic PRNG, so every texture is identical every run. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/**
 * Checkered grass with mown stripes, blades and wildflowers.
 *
 * The old version was two flat greens and a speckle, which read as a spread-
 * sheet with a lawn colour. Three things fix that: the two checker tones are
 * pushed further apart so the grid is legible at a glance; each square gets
 * mown stripes at right angles to its neighbour, the way a real pitch is cut;
 * and a handful of flowers per tile give the eye something that is not a grid.
 */
export function grassTexture(): THREE.Texture {
  const S = 512;
  const [c, ctx] = canvas(S);
  const half = S / 2;
  const rnd = rng(1337);

  const TONES = [
    { base: '#79c94b', stripe: '#84d456' },
    { base: '#5faa39', stripe: '#68b542' },
  ];

  for (let sy = 0; sy < 2; sy++) {
    for (let sx = 0; sx < 2; sx++) {
      const tone = TONES[(sx + sy) % 2];
      const x0 = sx * half;
      const y0 = sy * half;
      ctx.fillStyle = tone.base;
      ctx.fillRect(x0, y0, half, half);

      // Mown stripes, turned 90° between neighbouring squares. This is what
      // makes a checkered pitch read as cut grass rather than as tiling.
      ctx.fillStyle = tone.stripe;
      const across = (sx + sy) % 2 === 0;
      for (let i = 0; i < 8; i += 2) {
        const o = (i / 8) * half;
        if (across) ctx.fillRect(x0, y0 + o, half, half / 8);
        else ctx.fillRect(x0 + o, y0, half / 8, half);
      }

      // blades: short strokes, denser near the square's edges
      ctx.globalAlpha = 0.22;
      for (let i = 0; i < 260; i++) {
        const x = x0 + rnd() * half;
        const y = y0 + rnd() * half;
        ctx.fillStyle = rnd() > 0.55 ? '#a8e878' : '#468c2a';
        ctx.fillRect(x, y, 1.6, 3.4);
      }
      ctx.globalAlpha = 1;

      // wildflowers — four per square, always the same four
      for (let i = 0; i < 4; i++) {
        const x = x0 + 10 + rnd() * (half - 20);
        const y = y0 + 10 + rnd() * (half - 20);
        const petal = ['#ffe27a', '#ffffff', '#ffb3e6', '#fff2b8'][i % 4];
        ctx.fillStyle = petal;
        ctx.beginPath();
        ctx.arc(x, y, 2.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#e0a020';
        ctx.beginPath();
        ctx.arc(x, y, 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // The seam between squares, drawn on all four so no square is missing one.
  ctx.strokeStyle = 'rgba(46,92,28,.34)';
  ctx.lineWidth = 2.5;
  for (let sy = 0; sy < 2; sy++) {
    for (let sx = 0; sx < 2; sx++) {
      ctx.strokeRect(sx * half + 1, sy * half + 1, half - 2, half - 2);
    }
  }

  return finish(c, [9, 16]); // one square per arena tile
}

/** Horizontal wood planks with dark seams and grain. */
export function woodTexture(repeat: [number, number] = [4, 1]): THREE.Texture {
  const S = 256;
  const [c, ctx] = canvas(S);
  ctx.fillStyle = '#a9743a';
  ctx.fillRect(0, 0, S, S);

  const planks = 4;
  const h = S / planks;
  for (let i = 0; i < planks; i++) {
    ctx.fillStyle = i % 2 === 0 ? '#b57f42' : '#9c6832';
    ctx.fillRect(0, i * h, S, h);
    ctx.strokeStyle = 'rgba(70,40,14,.7)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, i * h);
    ctx.lineTo(S, i * h);
    ctx.stroke();
  }

  const rnd = rng(99);
  ctx.globalAlpha = 0.2;
  ctx.strokeStyle = '#6d4519';
  ctx.lineWidth = 1;
  for (let i = 0; i < 90; i++) {
    const y = rnd() * S;
    ctx.beginPath();
    ctx.moveTo(rnd() * S, y);
    ctx.bezierCurveTo(S * 0.4, y + 3, S * 0.7, y - 3, S, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return finish(c, repeat);
}

/**
 * Water: a deep channel with a lit centre.
 *
 * The old texture was a flat cyan band with seven sine lines, which is
 * legible and completely dead. This one has depth — darker at the banks,
 * bright where the light hits mid-channel — plus wave crests at varying
 * amplitude so the surface does not read as a single repeating ripple.
 */
export function waterTexture(): THREE.Texture {
  const S = 256;
  const [c, ctx] = canvas(S);

  // Deep at the banks, lit mid-channel. The values are darker than they look
  // on the canvas on purpose: the arena runs ambient at 2.1 and a sun at 2.3,
  // and a mid-cyan under that light comes out white.
  const g = ctx.createLinearGradient(0, 0, 0, S);
  g.addColorStop(0, '#05314f');
  g.addColorStop(0.16, '#08506f');
  g.addColorStop(0.5, '#0f7d9e');
  g.addColorStop(0.84, '#08506f');
  g.addColorStop(1, '#05314f');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);

  // crests, at three different frequencies so the loop is not obvious
  const rnd = rng(7);
  for (let i = 0; i < 11; i++) {
    const y = (i / 11) * S;
    const amp = 2 + rnd() * 5;
    const freq = 2 + Math.floor(rnd() * 4);
    const edge = Math.abs(y / S - 0.5) * 2; // fainter toward the banks
    ctx.strokeStyle = `rgba(190,240,255,${0.3 * (1 - edge * 0.7)})`;
    ctx.lineWidth = 1.5 + rnd() * 2;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= S; x += 8) {
      ctx.lineTo(x, y + Math.sin((x / S) * Math.PI * 2 * freq + i) * amp);
    }
    ctx.stroke();
  }

  return finish(c, [4, 1]);
}

/**
 * The caustics layer, laid over the water and scrolled the other way.
 *
 * One scrolling texture reads as a conveyor belt: every pixel travels at the
 * same speed in the same direction. Two layers moving differently is the
 * cheapest thing that reads as a moving surface rather than a moving image.
 */
export function causticTexture(): THREE.Texture {
  const S = 256;
  const [c, ctx] = canvas(S);
  ctx.clearRect(0, 0, S, S);

  const rnd = rng(4242);
  ctx.strokeStyle = 'rgba(255,255,255,.5)';
  ctx.lineCap = 'round';
  for (let i = 0; i < 46; i++) {
    const x = rnd() * S;
    const y = rnd() * S;
    const r = 6 + rnd() * 18;
    ctx.lineWidth = 1 + rnd() * 2;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * (0.3 + rnd() * 0.3), rnd() * Math.PI, 0, Math.PI * 2);
    ctx.stroke();
  }

  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 1);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Cut stone, for the river banks and the tower platforms.
 *
 * The banks used to be a flat brown box, which is the one part of the board
 * that touches both the grass and the water and so is the seam everything
 * else is judged against.
 */
export function stoneTexture(repeat: [number, number] = [8, 1]): THREE.Texture {
  const S = 256;
  const [c, ctx] = canvas(S);
  const rnd = rng(515);

  // Much darker than cut stone looks in daylight, on purpose. Ambient 2.1
  // plus a 2.3 sun multiplies everything here, and the first pass at #9aa3ae
  // came out pure white — which made the river read as a white strip with a
  // thin blue line down the middle.
  ctx.fillStyle = '#5c6672';
  ctx.fillRect(0, 0, S, S);

  const rows = 4;
  const h = S / rows;
  for (let r = 0; r < rows; r++) {
    const offset = (r % 2) * (S / 8);
    for (let i = -1; i < 4; i++) {
      const x = offset + i * (S / 4);
      const shade = 0.82 + rnd() * 0.28;
      const v = (n: number) => Math.min(255, Math.round(n * shade));
      ctx.fillStyle = `rgb(${v(102)},${v(112)},${v(126)})`;
      ctx.fillRect(x + 2, r * h + 2, S / 4 - 4, h - 4);
      // top bevel, so each block catches the light
      ctx.fillStyle = 'rgba(255,255,255,.16)';
      ctx.fillRect(x + 2, r * h + 2, S / 4 - 4, 3);
      ctx.fillStyle = 'rgba(0,0,0,.3)';
      ctx.fillRect(x + 2, r * h + h - 5, S / 4 - 4, 3);
    }
  }

  // mortar
  ctx.strokeStyle = 'rgba(28,33,41,.7)';
  ctx.lineWidth = 2;
  for (let r = 0; r <= rows; r++) {
    ctx.beginPath();
    ctx.moveTo(0, r * h);
    ctx.lineTo(S, r * h);
    ctx.stroke();
  }

  return finish(c, repeat);
}
