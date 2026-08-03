import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { FP } from '../sim/fixed';
import { ARENA_H, ARENA_W } from '../sim/engine';
import { masonryTexture, sandTexture, skyTexture } from './textures';

const W = ARENA_W / FP; // 18
const H = ARENA_H / FP; // 32
const CX = W / 2;
const CZ = H / 2;

/** How far the arena floor drops below the playing surface. */
export const GROUND_Y = -0.9;

/* ── the bowl ──────────────────────────────────────────────────────────────
   Half-extents of the barrier wall, then five tiers stepping out and up.
   Sized against the match camera, which pitches 51° down with a 26° half-fov:
   the top of the frame is 25° below horizontal, which puts the visible
   ceiling near y=9 by the time you are 40 units out. A bowl topping out
   around there fills the upper frame without being cropped, and without the
   far side climbing high enough to hide the board. */
// Hugging the plinth, which is 11.1 half-wide. Further out and the side
// stands fall outside a portrait frame entirely: the camera sits inside the
// bowl looking down its long axis, so anything much wider than the board only
// contributes dark stone at the edges of the shot.
const INNER_X = 12.4;
const INNER_Z = 19.5;
const WALL_H = 2.6;
const TIERS = 5;
const STEP_OUT = 2.4;
const STEP_UP = 1.35;

const GOLD = '#ffc422';

/** The four slabs that make one rectangular ring, as [cx, cz, sizeX, sizeZ]. */
function ringSlabs(ix: number, iz: number, ox: number, oz: number) {
  return [
    [CX, CZ - (iz + oz) / 2, ox * 2, oz - iz],
    [CX, CZ + (iz + oz) / 2, ox * 2, oz - iz],
    [CX - (ix + ox) / 2, CZ, ox - ix, iz * 2],
    [CX + (ix + ox) / 2, CZ, ox - ix, iz * 2],
  ] as const;
}

/**
 * The colosseum the arena stands in.
 *
 * The board hung in a flat blue void, which is why the trees around it read
 * as standing in water. The pass after that put it in a meadow — a place, but
 * a generic one. This game is called Mempire and its fighters are gladiators;
 * the room for it is a bowl of stone with a crowd in it, not a field.
 *
 * Built as five stepped rings rather than a swept surface. A rectangular bowl
 * matches a rectangular board — an oval reads as a stadium built for some
 * other game — and rings of boxes stay cheap enough to instance a thousand
 * spectators onto.
 *
 * Everything here is darker and duller than the field. The board has to stay
 * the brightest thing on screen; stands that compete win on area alone.
 */
export function World() {
  const sand = useMemo(sandTexture, []);
  const stone = useMemo(() => masonryTexture([8, 2]), []);
  const stoneTall = useMemo(() => masonryTexture([10, 1]), []);
  const sky = useMemo(skyTexture, []);
  const flames = useRef<THREE.Group>(null);
  const t = useRef(0);

  useEffect(() => () => {
    [sand, stone, stoneTall, sky].forEach((x) => x.dispose());
  }, [sand, stone, stoneTall, sky]);

  /** Each tier's inner and outer half-extents, and its top height. */
  const tiers = useMemo(() => {
    const out: Tier[] = [];
    for (let k = 0; k < TIERS; k++) {
      const ix = INNER_X + STEP_OUT * k;
      const iz = INNER_Z + STEP_OUT * k;
      out.push({
        ix, iz,
        ox: ix + STEP_OUT,
        oz: iz + STEP_OUT,
        top: WALL_H + STEP_UP * (k + 1),
      });
    }
    return out;
  }, []);

  /** Torches along the barrier wall, clear of the four corners. */
  const torches = useMemo(() => {
    const out: [number, number][] = [];
    for (let i = 1; i < 6; i++) {
      const x = CX - INNER_X + (i / 6) * INNER_X * 2;
      out.push([x, CZ - INNER_Z], [x, CZ + INNER_Z]);
    }
    for (let i = 1; i < 8; i++) {
      const z = CZ - INNER_Z + (i / 8) * INNER_Z * 2;
      out.push([CX - INNER_X, z], [CX + INNER_X, z]);
    }
    return out;
  }, []);

  useFrame((_, dt) => {
    t.current += dt;
    // Flames breathe out of phase. A row of them pulsing together reads as one
    // flashing light rather than as fire.
    if (!flames.current) return;
    flames.current.children.forEach((f, i) => {
      const s = 0.86 + Math.sin(t.current * 7 + i * 1.7) * 0.13;
      f.scale.set(s, 1 + (1 - s) * 1.6, s);
    });
  });

  const outer = tiers[TIERS - 1];
  const barrier = ringSlabs(INNER_X, INNER_Z, INNER_X + 1.1, INNER_Z + 1.1);

  return (
    <group>
      {/* ── sky ────────────────────────────────────────────────────────
          `fog={false}`: fogging the sky fogs it toward its own horizon colour
          and flattens the ramp back into the flat blue this replaced. */}
      <mesh scale={[-1, 1, 1]} position={[CX, 0, CZ]}>
        <sphereGeometry args={[150, 24, 16]} />
        <meshBasicMaterial map={sky} side={THREE.BackSide} fog={false} depthWrite={false} />
      </mesh>

      {/* ── the arena floor ────────────────────────────────────────────
          Sand, as an arena floor is. Reaches well past the outermost tier so
          no edge of it is ever visible under the stands. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[CX, GROUND_Y, CZ]} receiveShadow>
        <planeGeometry args={[(outer.ox + 40) * 2, (outer.oz + 40) * 2]} />
        <meshStandardMaterial map={sand} roughness={1} />
      </mesh>

      {/* ── the plinth the board stands on ─────────────────────────────
          Its top sits just below the playing surface. Flush, it was exactly
          coplanar with the grass and cast a shadow across the board — a hard
          diagonal that looked like the shadow of something that was not
          there. */}
      <mesh position={[CX, GROUND_Y / 2 - 0.03, CZ]} receiveShadow castShadow>
        <boxGeometry args={[W + 4.2, Math.abs(GROUND_Y) - 0.06, H + 4.2]} />
        <meshStandardMaterial map={stoneTall} roughness={0.95} />
      </mesh>

      {/* ── the barrier wall ───────────────────────────────────────────
          What separates the floor from the crowd. Solid, so the front row
          never appears to be standing at floor level. */}
      {barrier.map((s, i) => (
        <mesh key={`wall${i}`} position={[s[0], GROUND_Y + WALL_H / 2, s[1]]} castShadow receiveShadow>
          <boxGeometry args={[s[2], WALL_H, s[3]]} />
          <meshStandardMaterial map={stoneTall} roughness={0.92} />
        </mesh>
      ))}

      {/* The gold band along the barrier's top — the same rule the board's
          frame wears, carried up into the room around it. */}
      {barrier.map((s, i) => (
        <mesh key={`wallgold${i}`} position={[s[0], GROUND_Y + WALL_H + 0.08, s[1]]}>
          <boxGeometry args={[s[2] + 0.1, 0.16, s[3] + 0.1]} />
          <meshStandardMaterial color={GOLD} roughness={0.35} metalness={0.6} emissive="#3d2900" />
        </mesh>
      ))}

      {/* ── the tiers ──────────────────────────────────────────────────
          Each ring runs from the floor to its own top, so they nest into a
          stepped bowl with no gaps at the corners and no coplanar faces to
          z-fight. */}
      {tiers.map((tier, k) =>
        ringSlabs(tier.ix, tier.iz, tier.ox, tier.oz).map((s, i) => (
          <mesh
            key={`t${k}-${i}`}
            position={[s[0], GROUND_Y + tier.top / 2, s[1]]}
            castShadow
            receiveShadow
          >
            <boxGeometry args={[s[2], tier.top, s[3]]} />
            <meshStandardMaterial map={stone} roughness={0.95} />
          </mesh>
        )),
      )}

      <Crowd tiers={tiers} />
      <Arcade outer={outer} stone={stoneTall} />

      {/* ── torches ────────────────────────────────────────────────────── */}
      <group>
        {torches.map(([x, z], i) => (
          <mesh key={`post${i}`} position={[x, GROUND_Y + WALL_H + 0.55, z]} castShadow>
            <cylinderGeometry args={[0.11, 0.15, 1.1, 6]} />
            <meshStandardMaterial color="#3a3227" roughness={0.9} />
          </mesh>
        ))}
      </group>
      <group ref={flames}>
        {torches.map(([x, z], i) => (
          // Emissive, not point lights. Twenty-six point lights would rebuild
          // every material's shader and cost more than the rest of the bowl
          // put together; nothing here needs to be lit *by* a torch, it only
          // needs to read as one. `toneMapped={false}` keeps the flame at full
          // brightness through the ACES curve — a fire that rolls off with
          // everything else stops looking like fire.
          <mesh key={`flame${i}`} position={[x, GROUND_Y + WALL_H + 1.32, z]}>
            <coneGeometry args={[0.26, 0.72, 6]} />
            <meshBasicMaterial color="#ffb02e" toneMapped={false} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

interface Tier { ix: number; iz: number; ox: number; oz: number; top: number }

/**
 * The crowd, as one instanced mesh.
 *
 * Around a thousand figures. As individual meshes that is a thousand draw
 * calls for something a few pixels tall each; instanced it is one, and the
 * per-instance colour still lets each end of the bowl support its own side.
 *
 * They are boxes, because at this distance a body is four pixels tall and the
 * silhouette is all that survives — a modelled figure costs triangles to
 * render something indistinguishable from a box.
 */
function Crowd({ tiers }: { tiers: Tier[] }) {
  const ref = useRef<THREE.InstancedMesh>(null);

  const seats = useMemo(() => {
    const out: { x: number; y: number; z: number; c: THREE.Color; s: number }[] = [];
    let seed = 90210;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    // The bowl takes sides: blue behind the blue king, red behind the red one,
    // and a third neutral so it does not read as two flat blocks of colour.
    const BLUE = ['#3f6fc9', '#5b8ae0', '#2b4f96'].map((c) => new THREE.Color(c));
    const RED = ['#c9433f', '#e06b5b', '#96302b'].map((c) => new THREE.Color(c));
    const NEUTRAL = ['#c9c2b4', '#8d8477', '#e0d8c6', '#6d6152'].map((c) => new THREE.Color(c));

    for (const tier of tiers) {
      const y = GROUND_Y + tier.top;
      for (let r = 0; r < 2; r++) {
        const inset = 0.6 + r * 1.1;
        const x0 = tier.ix + inset;
        const z0 = tier.iz + inset;
        const push = (x: number, z: number) => {
          // Roughly one seat in six is empty. A full bowl reads as a texture;
          // the gaps are what make it read as people.
          if (rnd() > 0.82) return;
          const half = z < CZ ? BLUE : RED;
          const pal = rnd() > 0.66 ? NEUTRAL : half;
          out.push({
            x, y, z,
            c: pal[Math.floor(rnd() * pal.length)],
            s: 0.34 + rnd() * 0.16,
          });
        };
        const nx = Math.max(1, Math.floor((x0 * 2) / 0.85));
        for (let i = 0; i <= nx; i++) {
          const x = CX - x0 + (i / nx) * x0 * 2;
          push(x, CZ - z0);
          push(x, CZ + z0);
        }
        const nz = Math.max(1, Math.floor((z0 * 2) / 0.85));
        for (let i = 0; i <= nz; i++) {
          const z = CZ - z0 + (i / nz) * z0 * 2;
          push(CX - x0, z);
          push(CX + x0, z);
        }
      }
    }
    return out;
  }, [tiers]);

  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const m = new THREE.Object3D();
    seats.forEach((s, i) => {
      m.position.set(s.x, s.y + s.s, s.z);
      m.scale.set(s.s, s.s * 1.7, s.s);
      m.rotation.y = ((i * 37) % 17) / 17;
      m.updateMatrix();
      mesh.setMatrixAt(i, m.matrix);
      mesh.setColorAt(i, s.c);
    });
    mesh.instanceMatrix.needsUpdate = true;
    // setColorAt allocates instanceColor on its first call, so this cannot be
    // hoisted above the loop.
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [seats]);

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, seats.length]}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial roughness={0.9} />
    </instancedMesh>
  );
}

/**
 * The colonnade around the top of the bowl.
 *
 * Columns and a lintel rather than modelled arches: from the match camera an
 * arch opening is a couple of pixels tall and would be indistinguishable from
 * the gap between two columns, while costing a torus segment each. The
 * colonnade is what says "colosseum" rather than "stadium", so it is the one
 * piece up here worth its draw calls.
 */
function Arcade({ outer, stone }: { outer: Tier; stone: THREE.Texture }) {
  const cols = useRef<THREE.InstancedMesh>(null);

  const posts = useMemo(() => {
    const out: [number, number][] = [];
    const { ox, oz } = outer;
    const stepX = Math.max(1, Math.floor((ox * 2) / 3.4));
    for (let i = 0; i <= stepX; i++) {
      const x = CX - ox + (i / stepX) * ox * 2;
      out.push([x, CZ - oz], [x, CZ + oz]);
    }
    const stepZ = Math.max(2, Math.floor((oz * 2) / 3.4));
    for (let i = 1; i < stepZ; i++) {
      const z = CZ - oz + (i / stepZ) * oz * 2;
      out.push([CX - ox, z], [CX + ox, z]);
    }
    return out;
  }, [outer]);

  useEffect(() => {
    const mesh = cols.current;
    if (!mesh) return;
    const m = new THREE.Object3D();
    posts.forEach(([x, z], i) => {
      m.position.set(x, GROUND_Y + outer.top + 1.5, z);
      m.updateMatrix();
      mesh.setMatrixAt(i, m.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [posts, outer]);

  return (
    <group>
      <instancedMesh ref={cols} args={[undefined, undefined, posts.length]} castShadow>
        <cylinderGeometry args={[0.42, 0.5, 3, 8]} />
        <meshStandardMaterial map={stone} roughness={0.9} />
      </instancedMesh>

      {/* The lintel the columns carry, and a gold fillet beneath it. */}
      {ringSlabs(outer.ox - 0.7, outer.oz - 0.7, outer.ox + 0.7, outer.oz + 0.7).map((s, i) => (
        <group key={`lintel${i}`}>
          <mesh position={[s[0], GROUND_Y + outer.top + 3.35, s[1]]} castShadow>
            <boxGeometry args={[s[2], 0.7, s[3]]} />
            <meshStandardMaterial map={stone} roughness={0.9} />
          </mesh>
          <mesh position={[s[0], GROUND_Y + outer.top + 2.94, s[1]]}>
            <boxGeometry args={[s[2] + 0.12, 0.14, s[3] + 0.12]} />
            <meshStandardMaterial color={GOLD} roughness={0.35} metalness={0.6} emissive="#3d2900" />
          </mesh>
        </group>
      ))}
    </group>
  );
}
