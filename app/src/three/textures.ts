import * as THREE from 'three';

/**
 * Arena textures drawn on a canvas rather than generated as images.
 *
 * A checkerboard has to be pixel-exact to read as a play grid — an AI texture
 * gives soft, irregular squares and a visible tile seam. Canvas gives crisp
 * edges, perfect tiling, and costs a few KB instead of a megabyte.
 */

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
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

/** Two-tone checkered grass with a subtle blade speckle in each square. */
export function grassTexture(): THREE.Texture {
  const S = 256;
  const [c, ctx] = canvas(S);
  const light = '#7ec850';
  const dark = '#6bb544';
  const half = S / 2;

  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 2; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? light : dark;
      ctx.fillRect(x * half, y * half, half, half);
    }
  }

  // speckle — deterministic so the texture is identical every run
  let seed = 1337;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  ctx.globalAlpha = 0.16;
  for (let i = 0; i < 900; i++) {
    const x = rnd() * S;
    const y = rnd() * S;
    ctx.fillStyle = rnd() > 0.5 ? '#a5e074' : '#4f9a32';
    ctx.fillRect(x, y, 2, 3);
  }
  ctx.globalAlpha = 1;

  // faint seam between squares, which is what makes the grid legible
  ctx.strokeStyle = 'rgba(60,110,40,.28)';
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, half, half);
  ctx.strokeRect(half, half, half, half);

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

  let seed = 99;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
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

/** Flowing water: banded cyan with lighter crests. */
export function waterTexture(): THREE.Texture {
  const S = 256;
  const [c, ctx] = canvas(S);
  const g = ctx.createLinearGradient(0, 0, 0, S);
  g.addColorStop(0, '#3fd6e8');
  g.addColorStop(0.5, '#22b9d6');
  g.addColorStop(1, '#3fd6e8');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);

  ctx.strokeStyle = 'rgba(255,255,255,.4)';
  ctx.lineWidth = 3;
  for (let i = 0; i < 7; i++) {
    const y = (i / 7) * S;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= S; x += 16) {
      ctx.lineTo(x, y + Math.sin((x / S) * Math.PI * 4 + i) * 5);
    }
    ctx.stroke();
  }
  return finish(c, [4, 1]);
}
