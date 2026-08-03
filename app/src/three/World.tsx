import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { FP } from '../sim/fixed';
import { ARENA_H, ARENA_W } from '../sim/engine';
import { meadowTexture, skyTexture } from './textures';

const W = ARENA_W / FP; // 18
const H = ARENA_H / FP; // 32

/** How far the arena's plinth drops below the playing surface. */
export const GROUND_Y = -0.9;

/**
 * The place the arena is in.
 *
 * Before this there was a flat clear colour and fog, and nothing else — so the
 * board hung in a blue void and the trees around it stood on that same blue,
 * which read as trees standing in water. That is not a lighting problem or a
 * texture problem; there was simply no world, and no amount of polish on the
 * board itself was going to fix a board with nothing underneath it.
 *
 * Four pieces, cheapest first:
 *
 * 1. A **sky dome** with a vertical ramp, so there is a horizon to sit against.
 *    The fog colour is the ramp's bottom stop, so ground fades into sky rather
 *    than stopping at a line.
 * 2. **Ground**, well below the playing surface, which turns the arena into a
 *    raised platform and gives the scenery something to stand on.
 * 3. **Hills** on the far side, for a silhouette at the horizon.
 * 4. **Clouds**, which are the only thing here that moves.
 *
 * Everything is duller than the board on purpose. The arena has to stay the
 * brightest thing on screen; scenery that competes wins on area alone.
 */
export function World() {
  const meadow = useMemo(meadowTexture, []);
  const sky = useMemo(skyTexture, []);

  useEffect(() => () => {
    [meadow, sky].forEach((t) => t.dispose());
  }, [meadow, sky]);

  /**
   * The woodland ring.
   *
   * Kept clear of the plinth and of the near scenery Arena.tsx places, so the
   * two do not interpenetrate. Density falls off with distance because the
   * far ring covers far more ground per tree and an even density there reads
   * as a solid green wall.
   */
  const trees = useMemo(() => {
    const out: { x: number; z: number; s: number; tone: number }[] = [];
    const cx = W / 2;
    const cz = H / 2;
    let seed = 24601;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    // radius, count — the board's half-diagonal is about 18, so 22 is the
    // first ring that clears both the plinth and Arena's own trees.
    ([[22, 26], [30, 30], [40, 26], [52, 18]] as const).forEach(([radius, count]) => {
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + rnd() * 0.5;
        const r = radius + (rnd() - 0.5) * 9;
        out.push({
          x: cx + Math.cos(a) * r * 1.15,   // wider than deep, matching the board
          z: cz + Math.sin(a) * r,
          s: 1.1 + rnd() * 1.5,
          tone: Math.floor(rnd() * 3),
        });
      }
    });
    return out;
  }, []);

  // Hills are laid out from a fixed table for the same reason the trees are:
  // a horizon that reshuffles between matches reads as an unstable world.
  const hills = useMemo(() => {
    const out: { x: number; z: number; r: number; h: number; c: string }[] = [];
    const ring = (radius: number, count: number, rs: number, hs: number, c: string) => {
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + radius * 0.11;
        const wobble = ((i * 37) % 11) / 11;
        out.push({
          x: W / 2 + Math.cos(a) * (radius + wobble * 9),
          z: H / 2 + Math.sin(a) * (radius + wobble * 12),
          r: rs * (0.75 + wobble * 0.6),
          h: hs * (0.7 + wobble * 0.7),
          c,
        });
      }
    };
    // Two bands. The far one is bluer, because distance desaturates and this
    // is cheaper and more legible than depth-fading each hill individually.
    ring(52, 11, 13, 7, '#3f7a41');
    ring(78, 13, 19, 11, '#4a7f82');
    return out;
  }, []);

  return (
    <group>
      {/* ── sky ────────────────────────────────────────────────────────
          Rendered on the inside of a sphere. `fog={false}` because fogging
          the sky fogs it toward its own horizon colour and flattens the ramp
          into the one flat blue this replaced. */}
      <mesh scale={[-1, 1, 1]} position={[W / 2, 0, H / 2]}>
        <sphereGeometry args={[125, 24, 16]} />
        <meshBasicMaterial map={sky} side={THREE.BackSide} fog={false} depthWrite={false} />
      </mesh>

      {/* ── ground ─────────────────────────────────────────────────────
          Big enough to reach the fog before it reaches its own edge. A ground
          plane whose edge is visible is worse than no ground plane. */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[W / 2, GROUND_Y, H / 2]}
        receiveShadow
      >
        <planeGeometry args={[260, 260]} />
        <meshStandardMaterial map={meadow} roughness={0.98} />
      </mesh>

      {/* ── the plinth ─────────────────────────────────────────────────
          The block the board stands on. Without it the frame's underside is
          open to the ground and the arena reads as a decal lying on grass
          rather than as an object with a thickness. */}
      <mesh position={[W / 2, GROUND_Y / 2 - 0.03, H / 2]} receiveShadow castShadow>
        <boxGeometry args={[W + 4.2, Math.abs(GROUND_Y) - 0.06, H + 4.2]} />
        <meshStandardMaterial color="#6b5233" roughness={0.95} />
      </mesh>
      {/* A darker skirt at the base, so the plinth meets the ground in a
          shadow line rather than a hard butt joint. */}
      <mesh position={[W / 2, GROUND_Y + 0.09, H / 2]}>
        <boxGeometry args={[W + 4.6, 0.18, H + 4.6]} />
        <meshStandardMaterial color="#4a3722" roughness={1} />
      </mesh>

      {/* ── hills ──────────────────────────────────────────────────────
          Eight-sided cones. At this distance the facet count is invisible and
          a smooth cone costs triangles nobody can see. */}
      {hills.map((h, i) => (
        <mesh key={i} position={[h.x, GROUND_Y, h.z]}>
          <coneGeometry args={[h.r, h.h, 8]} />
          <meshStandardMaterial color={h.c} roughness={1} flatShading />
        </mesh>
      ))}

      {/* ── woodland ───────────────────────────────────────────────────
          The meadow on its own is a green carpet, and a green carpet is the
          same complaint as the blue void it replaced — there is simply nothing
          in it. These fill the band the camera actually sees, thinning with
          distance so the eye reads depth rather than a wall of trees.

          Placed on rings rather than a grid: a grid of trees at this density
          reads as an orchard, and the regular spacing is visible even when
          each item is jittered. */}
      <Woodland trees={trees} />
    </group>
  );
}

/**
 * A tree for the surrounding woodland.
 *
 * Simpler than the ones just outside the frame — three cones and a trunk, flat
 * shaded, no shadow casting. There are around ninety of these and every one of
 * them is at least fifteen units from the camera's focus; paying for smooth
 * normals and a shadow map entry on each would cost real frames for something
 * nobody can resolve.
 */
interface TreeSpot { x: number; z: number; s: number; tone: number }

/**
 * The woodland, drawn as four instanced meshes.
 *
 * A hundred trees built as a group of four meshes each is four hundred draw
 * calls for scenery nobody looks at directly — fine on a desktop GPU, and the
 * first thing to give way on the mid-range phone this game is actually played
 * on. Instancing collapses that to four: one trunk, one per canopy tier.
 *
 * Canopy colour varies per instance rather than per mesh, so the ring still
 * has three greens in it without needing three materials.
 */
function Woodland({ trees }: { trees: TreeSpot[] }) {
  const trunk = useRef<THREE.InstancedMesh>(null);
  const tiers = [useRef<THREE.InstancedMesh>(null), useRef<THREE.InstancedMesh>(null), useRef<THREE.InstancedMesh>(null)];

  const CANOPY = useMemo(
    () => ['#2f6323', '#3d7a2c', '#356e27'].map((c) => new THREE.Color(c)),
    [],
  );

  useEffect(() => {
    const m = new THREE.Object3D();
    trees.forEach((t, i) => {
      m.position.set(t.x, GROUND_Y + 0.55 * t.s, t.z);
      m.scale.setScalar(t.s);
      m.updateMatrix();
      trunk.current?.setMatrixAt(i, m.matrix);

      tiers.forEach((ref, k) => {
        m.position.set(t.x, GROUND_Y + (1.25 + k * 0.6) * t.s, t.z);
        m.scale.setScalar(t.s);
        m.updateMatrix();
        ref.current?.setMatrixAt(i, m.matrix);
        ref.current?.setColorAt(i, CANOPY[t.tone]);
      });
    });
    if (trunk.current) trunk.current.instanceMatrix.needsUpdate = true;
    tiers.forEach((ref) => {
      if (!ref.current) return;
      ref.current.instanceMatrix.needsUpdate = true;
      // setColorAt allocates instanceColor on first use, so this has to come
      // after the loop rather than being hoisted out of it.
      if (ref.current.instanceColor) ref.current.instanceColor.needsUpdate = true;
    });
    // `tiers` is three refs created fresh each render; listing it would re-run
    // this every frame. The trees themselves are memoised and never change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trees, CANOPY]);

  const n = trees.length;
  return (
    <group>
      <instancedMesh ref={trunk} args={[undefined, undefined, n]}>
        <cylinderGeometry args={[0.16, 0.24, 1.1, 5]} />
        <meshStandardMaterial color="#4f341c" roughness={1} />
      </instancedMesh>
      {[0, 1, 2].map((k) => (
        <instancedMesh key={k} ref={tiers[k]} args={[undefined, undefined, n]}>
          <coneGeometry args={[1.05 - k * 0.26, 1.0, 6]} />
          <meshStandardMaterial roughness={1} flatShading />
        </instancedMesh>
      ))}
    </group>
  );
}
