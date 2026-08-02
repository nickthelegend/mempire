import { useFrame, useThree } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { coinByMint } from '../lib/coins';
import { FP } from '../sim/fixed';
import type { SimState, Unit } from '../sim/types';
import { useMatch } from '../state/match';

/**
 * Units as billboards.
 *
 * Each fighter is the coin's own card art on a plane that turns to face the
 * camera. Two reasons this beats the skinned-mesh path it replaces:
 *
 * 1. **Every coin fights as itself.** The rig path shares five skeletons across
 *    the whole registry, so $BTC and $WIF are literally the same knight. A
 *    billboard costs one texture, so identity is per-coin and free — and the
 *    texture is the card art we already generate.
 * 2. **It is far cheaper.** Forty textured quads against forty skinned meshes
 *    with per-frame bone matrices, on a 30fps mobile floor.
 *
 * Motion is code rather than clips: bob, squash, lean, recoil, flash, topple.
 * At this camera height a real walk cycle is barely legible anyway — units had
 * to be scaled well past their collision footprint just to be readable — so the
 * expressive loss is smaller than it sounds and the identity gain is large.
 */

/**
 * Full camera-facing billboard, not yaw-only.
 *
 * The arena camera sits at y=38 looking down about 52°. A cylindrical
 * (yaw-only) billboard under that pitch is foreshortened almost flat — the
 * first build put every fighter face-down on the grass. Copying the camera's
 * whole orientation keeps each sprite square-on to the viewer, so it reads
 * upright on screen at any camera angle. This is the standard 2.5D sprite
 * treatment, and the reason particle systems do the same thing.
 */

const OWN_TINT = new THREE.Color('#bcd8ff');
const ENEMY_TINT = new THREE.Color('#ffc0b6');

const SPAWN_POP = 0.34;
const HIT_FLASH = 0.16;
const DEATH_TIME = 0.55;

/** Height in world units, by archetype. Matches the rig path's readability. */
const HEIGHT: Record<number, number> = {
  0: 3.4, 1: 2.5, 2: 3.0, 3: 3.3, 4: 3.0, 5: 2.8,
};

/**
 * A soft radial alpha mask, drawn once and shared.
 *
 * The card art is a character on a radial glow, not a cut-out — dropping it
 * straight onto a quad would put a visible rectangle on the grass. Fading the
 * outer edge removes the rectangle, and the glow that survives inside the mask
 * reads as an aura around the fighter rather than a background.
 */
function makeAlphaMask(): THREE.Texture {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d')!;
  // Slightly taller than wide: characters are portrait, so an even circle would
  // clip heads and feet before it clipped the sides.
  const grd = g.createRadialGradient(S / 2, S / 2, S * 0.16, S / 2, S / 2, S * 0.52);
  grd.addColorStop(0, '#fff');
  grd.addColorStop(0.72, '#fff');
  grd.addColorStop(1, '#000');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/** One loader + cache for every unit texture; the same coin recurs constantly. */
const loader = new THREE.TextureLoader();
const texCache = new Map<string, THREE.Texture>();

/**
 * Loads a unit texture, falling back when the file is not there yet.
 *
 * Card art arrives one file at a time, so `card_<ticker>.png` is requested
 * optimistically and the round coin badge is swapped in on a 404. The texture
 * object is reused either way, so the material never has to be rebuilt and a
 * unit already on the field just changes what it is showing.
 */
function textureFor(url: string, fallback?: string): THREE.Texture {
  const hit = texCache.get(url);
  if (hit) return hit;
  const t = loader.load(url, undefined, undefined, () => {
    if (!fallback || fallback === url) return;
    loader.load(fallback, (fb) => {
      t.image = fb.image;
      t.needsUpdate = true;
    });
  });
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  texCache.set(url, t);
  return t;
}

interface LiveUnit {
  group: THREE.Group;
  sprite: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  shadow: THREE.Mesh;
  ring: THREE.Mesh;
  ringDone: boolean;
  height: number;
  lastX: number;
  lastZ: number;
  lastHp: number;
  spawning: number;
  hitFlash: number;
  dying: number;
  /** Accumulated stride phase — advances with distance, not wall time, so a
   *  slow unit does not moonwalk. */
  phase: number;
  attackPulse: number;
  baseTint: THREE.Color;
}

function disposeUnit(lu: LiveUnit): void {
  // Per-unit materials are cloned, so they are ours to release. Geometries and
  // textures are shared and deliberately never disposed here — StrictMode
  // double-invokes effect cleanup in dev and would tear them out from under
  // every other unit.
  lu.mat.dispose();
  (lu.shadow.material as THREE.Material).dispose();
  (lu.ring.material as THREE.Material).dispose();
}

export function UnitsBillboard() {
  const root = useRef<THREE.Group>(null);
  const live = useRef(new Map<number, LiveUnit>());
  const { camera } = useThree();

  const alphaMask = useMemo(makeAlphaMask, []);
  const planeGeo = useMemo(() => new THREE.PlaneGeometry(1, 1), []);
  const ringGeo = useMemo(() => new THREE.RingGeometry(0.36, 0.52, 24), []);
  const shadowGeo = useMemo(() => new THREE.CircleGeometry(0.46, 18), []);

  const spawn = (u: Unit, coinId: string, me: 0 | 1): LiveUnit => {
    const group = new THREE.Group();
    const coin = coinByMint(coinId);
    // Card art when the file exists, the round coin badge until it does — so
    // the battlefield stays populated while the art set fills in.
    const fallback = coin?.logoUrl ?? '/art/avatar_guest.png';
    const url = coin?.cardArt ?? fallback;
    const tint = u.owner === me ? OWN_TINT : ENEMY_TINT;

    const mat = new THREE.MeshBasicMaterial({
      map: textureFor(url, fallback),
      alphaMap: alphaMask,
      transparent: true,
      alphaTest: 0.04,
      depthWrite: false,
      color: tint.clone(),
      toneMapped: false,
    });

    const h = HEIGHT[u.archetype] ?? 3.0;
    const sprite = new THREE.Mesh(planeGeo, mat);
    sprite.scale.set(h * 0.78, h, 1);
    // Anchored so the sprite's foot sits near the group origin — the group is
    // the unit's actual position on the board, which is what the shadow marks.
    sprite.position.y = h * 0.46;
    sprite.frustumCulled = false;
    group.add(sprite);

    const shadow = new THREE.Mesh(
      shadowGeo,
      new THREE.MeshBasicMaterial({
        color: '#1d3a12', transparent: true, opacity: 0.3, depthWrite: false,
      }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.02;
    group.add(shadow);

    const ring = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({
        color: u.owner === me ? '#3fa9ff' : '#ff5a4a',
        transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.035;
    group.add(ring);

    group.position.set(u.x / FP, 0, u.y / FP);

    return {
      group, sprite, mat, shadow, ring, ringDone: false, height: h,
      lastX: u.x / FP, lastZ: u.y / FP, lastHp: u.hp,
      spawning: 0, hitFlash: 0, dying: 0, phase: 0, attackPulse: 0,
      baseTint: tint.clone(),
    };
  };

  useFrame((_state, dtRaw) => {
    const store = useMatch.getState();
    const sim: SimState | null = store.sim;
    if (!sim || !root.current) return;
    const dt = Math.min(dtRaw, 0.05); // a backgrounded tab must not jump the field
    const seen = new Set<number>();
    const deckOf = (o: 0 | 1) => (o === store.perspective ? store.playerDeck : store.botDeck);

    for (const u of sim.units) {
      seen.add(u.id);
      let lu = live.current.get(u.id);
      if (!lu) {
        const deck = deckOf(u.owner);
        const coinId = deck[u.cardIndex]?.coinId ?? deck[0]?.coinId ?? '';
        lu = spawn(u, coinId, store.perspective);
        live.current.set(u.id, lu);
        root.current.add(lu.group);
      }

      const tx = u.x / FP;
      const tz = u.y / FP;
      const k = 1 - Math.exp(-dt * 11);
      lu.group.position.x += (tx - lu.group.position.x) * k;
      lu.group.position.z += (tz - lu.group.position.z) * k;

      const dx = tx - lu.lastX;
      const dz = tz - lu.lastZ;
      const travelled = Math.hypot(dx, dz);
      const moving = travelled > 1e-4;
      lu.lastX = tx; lu.lastZ = tz;

      // Stride advances with distance covered, so speed and bob stay in step.
      if (moving) lu.phase += travelled * 5.2;

      // Face the camera completely, every frame. Quaternion copy rather than
      // Euler assignment: mixing an axis-by-axis yaw with the lean below fights
      // over rotation order and tips the sprite.
      lu.sprite.quaternion.copy(camera.quaternion);

      if (u.hp < lu.lastHp) lu.hitFlash = HIT_FLASH;
      lu.lastHp = u.hp;
      if (u.state === 'attack') lu.attackPulse = Math.min(1, lu.attackPulse + dt * 6);
      else lu.attackPulse = Math.max(0, lu.attackPulse - dt * 5);

      // ── the animation, such as it is ──────────────────────────────────────
      const h = lu.height;
      const bob = moving ? Math.abs(Math.sin(lu.phase)) : 0;
      const breathe = Math.sin(performance.now() / 620 + lu.group.position.x) * 0.012;
      // Squash on the down-beat of the stride: the classic weight cue, and the
      // single biggest thing that stops a billboard reading as a sticker.
      const squash = moving ? 1 - bob * 0.07 : 1 + breathe;
      const stretch = moving ? 1 + bob * 0.09 : 1 - breathe;
      const lunge = lu.attackPulse * 0.16;

      const pop = lu.spawning < SPAWN_POP
        ? (() => {
          lu.spawning += dt;
          const t = Math.min(1, lu.spawning / SPAWN_POP);
          const eased = 1 - (1 - t) ** 3;
          lu.ring.scale.setScalar(0.4 + t * 3.4);
          (lu.ring.material as THREE.MeshBasicMaterial).opacity = 0.95 * (1 - t);
          if (t >= 1 && !lu.ringDone) {
            lu.ringDone = true;
            lu.group.remove(lu.ring);
            (lu.ring.material as THREE.Material).dispose();
          }
          return eased * (1 + 0.16 * Math.sin(Math.PI * t));
        })()
        : 1;

      lu.sprite.scale.set(
        h * 0.78 * squash * pop * (1 + lunge),
        h * stretch * pop * (1 + lunge),
        1,
      );
      lu.sprite.position.y = h * 0.46 * stretch * pop + bob * 0.12;

      // Lean into the stride — applied AFTER the billboard quaternion, so it is
      // a roll in screen space. A static image that rocks reads as momentum,
      // which is most of what a walk cycle communicates at this size.
      const lean = moving ? Math.min(0.16, travelled * 9) : 0;
      lu.sprite.rotateZ(-lean * Math.sin(lu.phase * 0.5) - lu.attackPulse * 0.1);

      if (lu.hitFlash > 0) {
        lu.hitFlash = Math.max(0, lu.hitFlash - dt);
        const f = lu.hitFlash / HIT_FLASH;
        // Tint only — never scale. Scaling here fights the stride and the unit
        // visibly stutters on every hit.
        lu.mat.color.copy(lu.baseTint).lerp(new THREE.Color('#ffffff'), f * 0.85);
      } else {
        lu.mat.color.copy(lu.baseTint);
      }

      lu.shadow.scale.setScalar(pop * (0.9 + bob * 0.16));
    }

    // Deaths: topple, sink and fade rather than vanishing mid-field.
    for (const [id, lu] of live.current) {
      if (seen.has(id)) continue;
      lu.dying += dt;
      const t = Math.min(1, lu.dying / DEATH_TIME);
      lu.sprite.rotation.z = -t * 1.15;
      lu.sprite.position.y = (lu.height / 2) * (1 - t * 0.62);
      lu.mat.opacity = 1 - t;
      (lu.shadow.material as THREE.MeshBasicMaterial).opacity = 0.3 * (1 - t);
      if (t >= 1) {
        root.current.remove(lu.group);
        disposeUnit(lu);
        live.current.delete(id);
      }
    }
  });

  return <group ref={root} />;
}
