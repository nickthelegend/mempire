import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Suspense, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { PALETTE } from '../lib/palette';
import { FP, fp } from '../sim/fixed';
import { ARENA_W, RIVER_BOT, RIVER_TOP } from '../sim/engine';
import { useMatch } from '../state/match';
import { Arena } from './Arena';
import { TowerMesh } from './Towers';
import { UnitsBillboard } from './UnitsBillboard';
import { vfx } from './vfx';

const W = ARENA_W / FP; // 18
const H = 32; // ARENA_H in tiles

/** Owns the camera every mount (HMR-safe); frames the full field portrait. */
let activeCamera: THREE.Camera | null = null;

/**
 * Which sim seat this client occupies. The board is one world; the camera
 * stands behind *your* king so your half is always the bottom of the screen —
 * for seat 1 that means looking down the field from the far end. Module state
 * (like activeCamera) because the DOM-layer deploy path needs it outside React.
 */
let viewSeat: 0 | 1 = 0;
export function setViewSeat(seat: 0 | 1): void { viewSeat = seat; }

function CameraRig({ seat }: { seat: 0 | 1 }) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  // Where the camera sits when nothing is hitting it. The shake is an offset
  // from this rather than an accumulation on the camera itself, so a hundred
  // impacts over a match cannot drift the framing off the board.
  const home = useRef(new THREE.Vector3());
  const shake = useRef(new THREE.Vector3());

  useFrame((_, dt) => {
    vfx.shakeOffset(Math.min(dt, 0.05), shake.current);
    camera.position.addVectors(home.current, shake.current);
  });

  useEffect(() => {
    // Pulled back and raised so the wood frame encloses the whole board rather
    // than running off the bottom of a portrait screen. Seat 1 gets the exact
    // mirror about the river line, so both players fight "uphill".
    if (seat === 0) {
      home.current.set(W / 2, 38, -15);
      camera.position.copy(home.current);
      camera.lookAt(W / 2, 0, 15);
    } else {
      home.current.set(W / 2, 38, H + 15);
      camera.position.copy(home.current);
      camera.lookAt(W / 2, 0, H - 15);
    }
    camera.updateProjectionMatrix();
    // Deliberately never cleared: StrictMode double-invokes effect cleanup in
    // dev, and nulling here left deploy raycasts with no camera to project
    // through, silently swallowing every card the player dropped.
    activeCamera = camera;
  }, [camera, size, seat]);
  return null;
}

// Deploy taps resolve at the DOM layer with an analytic ground-plane hit —
// R3F's canvas raycast misses synthetic/atypical pointer dispatch (seen in
// embedded webviews), and one code path beats two firing double.
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const deployRaycaster = new THREE.Raycaster();
const deployNdc = new THREE.Vector2();
const deployHit = new THREE.Vector3();

export function resolveGroundHit(
  clientX: number, clientY: number, el: HTMLElement,
): { x: number; z: number } | null {
  if (!activeCamera) return null;
  const r = el.getBoundingClientRect();
  deployNdc.set(
    ((clientX - r.left) / r.width) * 2 - 1,
    -(((clientY - r.top) / r.height) * 2 - 1),
  );
  deployRaycaster.setFromCamera(deployNdc, activeCamera);
  return deployRaycaster.ray.intersectPlane(groundPlane, deployHit)
    ? { x: deployHit.x, z: deployHit.z }
    : null;
}

/**
 * The legal drop zone in world units for the current seat, mirrored by the
 * sim's own clamp. Seat 0 owns the low-z half, seat 1 the high-z half.
 */
function ownHalf(): { minX: number; maxX: number; minZ: number; maxZ: number } {
  return viewSeat === 0
    ? { minX: 0.5, maxX: W - 0.5, minZ: 0.5, maxZ: RIVER_TOP / FP - 0.5 }
    : { minX: 0.5, maxX: W - 0.5, minZ: RIVER_BOT / FP + 0.5, maxZ: H - 0.5 };
}

export const isLegalDrop = (x: number, z: number): boolean => {
  const h = ownHalf();
  return x >= h.minX && x <= h.maxX && z >= h.minZ && z <= h.maxZ;
};

/**
 * Snap a ground hit into the player's half.
 *
 * Rejecting an out-of-bounds release is the wrong call: a fat-fingered drop
 * near the river or off the field should still deploy, the way it does in the
 * games this borrows from. Only a drop well inside enemy territory is refused,
 * so the marker still teaches where the line is.
 */
export function clampDrop(x: number, z: number): { x: number; z: number } {
  const h = ownHalf();
  return {
    x: Math.min(Math.max(x, h.minX), h.maxX),
    z: Math.min(Math.max(z, h.minZ), h.maxZ),
  };
}

function SpellMarkers() {
  const root = useRef<THREE.Group>(null);
  const ringGeo = useMemo(() => new THREE.RingGeometry(2.1, 2.5, 32), []);
  useFrame(() => {
    const sim = useMatch.getState().sim;
    const g = root.current;
    if (!sim || !g) return;
    // rebuild cheap marker set (≤2 concurrent spells in practice)
    while (g.children.length > sim.spells.length) g.remove(g.children[g.children.length - 1]);
    while (g.children.length < sim.spells.length) {
      const m = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({ color: PALETTE.purple, transparent: true, side: THREE.DoubleSide }),
      );
      m.rotation.x = -Math.PI / 2;
      g.add(m);
    }
    sim.spells.forEach((s, i) => {
      const m = g.children[i] as THREE.Mesh;
      m.position.set(s.x / FP, 0.04, s.y / FP);
      const remain = Math.max(0, s.explodeTick - sim.tick) / 20;
      (m.material as THREE.MeshBasicMaterial).opacity = 0.35 + 0.5 * (1 - remain);
      const sc = 0.4 + 0.6 * (1 - remain);
      m.scale.setScalar(sc);
    });
  });
  return <group ref={root} />;
}

/**
 * Tower fire made visible. The sim resolves damage instantly, so a bolt is
 * spawned whenever a tower's cooldown resets and flown to the victim purely
 * for presentation — it never feeds back into the simulation.
 */
function TowerFire() {
  const root = useRef<THREE.Group>(null);
  const geo = useMemo(() => new THREE.SphereGeometry(0.17, 10, 8), []);
  const cooldowns = useRef<number[]>([]);
  const hps = useRef<number[]>([]);
  const bolts = useRef<{ mesh: THREE.Mesh; from: THREE.Vector3; to: THREE.Vector3; t: number }[]>([]);

  useFrame((_, dtRaw) => {
    const sim = useMatch.getState().sim;
    const g = root.current;
    if (!sim || !g) return;
    const dt = Math.min(dtRaw, 0.05);

    sim.towers.forEach((t, i) => {
      // A tower losing hit points is the only thing on this board that changes
      // who is winning, so it is the one event allowed to move the camera.
      const lastHp = hps.current[i];
      hps.current[i] = t.hp;
      if (lastHp !== undefined && t.hp < lastHp) {
        const x = t.x / FP;
        const z = t.y / FP;
        const th = t.kind === 'king' ? 2.6 : 2.0;
        if (t.hp <= 0) {
          // A crown falling. Everything at once, and the biggest kick in the
          // game — if any moment earns it, this is the one.
          vfx.kick(0.42);
          vfx.shockwave(x, z, t.owner === 0 ? PALETTE.teal : PALETTE.red, 2.6);
          vfx.dust(x, z, 3);
          vfx.impact(x, th, z, 0, 0, '#ffe08a', 2);
          vfx.coins(x, th, z, 14);
        } else {
          // Scaled to the bite taken out of it, so chip damage from a lone
          // swarm unit does not shake as hard as a tank connecting.
          const bite = (lastHp - t.hp) / t.maxHp;
          vfx.kick(Math.min(0.12, 0.02 + bite * 1.6));
          vfx.impact(x, th, z, 0, 0, '#ffd6a0', 0.8 + bite * 6);
        }
      }

      const prev = cooldowns.current[i] ?? 0;
      cooldowns.current[i] = t.cooldown;
      // cooldown jumping back up = the tower just fired this tick
      if (t.hp > 0 && t.cooldown > prev + 1) {
        let best: { x: number; y: number } | null = null;
        let bestD = Infinity;
        for (const u of sim.units) {
          if (u.owner === t.owner || u.hp <= 0) continue;
          const d = (u.x - t.x) ** 2 + (u.y - t.y) ** 2;
          if (d < bestD) { bestD = d; best = { x: u.x, y: u.y }; }
        }
        if (!best) return;
        const mesh = new THREE.Mesh(
          geo,
          new THREE.MeshBasicMaterial({
            color: t.owner === 0 ? PALETTE.teal : PALETTE.red,
            transparent: true, depthWrite: false,
          }),
        );
        const h = t.kind === 'king' ? 2.9 : 2.3;
        bolts.current.push({
          mesh,
          from: new THREE.Vector3(t.x / FP, h, t.y / FP),
          to: new THREE.Vector3(best.x / FP, 0.85, best.y / FP),
          t: 0,
        });
        g.add(mesh);
      }
    });

    for (let i = bolts.current.length - 1; i >= 0; i--) {
      const b = bolts.current[i];
      b.t += dt * 3.4;
      if (b.t >= 1) {
        g.remove(b.mesh);
        (b.mesh.material as THREE.Material).dispose();
        bolts.current.splice(i, 1);
        continue;
      }
      b.mesh.position.lerpVectors(b.from, b.to, b.t);
      b.mesh.position.y += Math.sin(b.t * Math.PI) * 0.7; // arc
      const s = 1 + Math.sin(b.t * Math.PI) * 0.5;
      b.mesh.scale.setScalar(s);
    }
  });

  useEffect(() => {
    const live = bolts.current;
    const g = root.current;
    return () => {
      live.forEach((b) => { g?.remove(b.mesh); (b.mesh.material as THREE.Material).dispose(); });
      live.length = 0;
      geo.dispose();
    };
  }, [geo]);

  return <group ref={root} />;
}

/** Pulsing ring under the dragged card, green when the drop is legal. */
function DropMarker({ at }: { at: { x: number; z: number; legal: boolean } | null }) {
  const ring = useRef<THREE.Mesh>(null);
  const inner = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (!ring.current || !inner.current) return;
    const pulse = 1 + Math.sin(clock.elapsedTime * 6) * 0.08;
    ring.current.scale.setScalar(pulse);
    inner.current.scale.setScalar(2 - pulse);
  });
  if (!at) return null;
  const color = at.legal ? PALETTE.teal : PALETTE.red;
  return (
    <group position={[at.x, 0.06, at.z]}>
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.95, 1.25, 40]} />
        <meshBasicMaterial color={color} transparent opacity={0.95} side={THREE.DoubleSide} />
      </mesh>
      <mesh ref={inner} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.9, 32]} />
        <meshBasicMaterial color={color} transparent opacity={0.22} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

export function BattleScene({ onPlace, placing, marker, sceneRef, perspective = 0 }: {
  onPlace: (xFp: number, yFp: number) => void;
  placing: boolean;
  marker: { x: number; z: number; legal: boolean } | null;
  sceneRef?: React.Ref<HTMLDivElement>;
  /** Which sim seat this client is — decides camera end and legal half. */
  perspective?: 0 | 1;
}) {
  // Set before the camera effect runs so the first painted frame and the first
  // deploy clamp already agree about which half is "mine".
  setViewSeat(perspective);
  return (
    <div
      ref={sceneRef}
      style={{ position: 'absolute', inset: 0 }}
      onPointerDown={(e) => {
        // tap-to-deploy; drag-to-deploy is driven from the HUD
        const hit = resolveGroundHit(e.clientX, e.clientY, e.currentTarget);
        if (hit) onPlace(fp(hit.x), fp(hit.z));
      }}
    >
      <Canvas
        dpr={[1, 1.75]}
        camera={{ position: [W / 2, 33, -11.5], fov: 52, near: 1, far: 140 }}
        style={{ touchAction: 'none' }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
      >
        <CameraRig seat={perspective} />
        {/* Bright daylight, not a dungeon — the genre reads as a sunny field. */}
        <color attach="background" args={['#5aa9e0']} />
        <fog attach="fog" args={['#7cc0e8', 74, 132]} />
        <ambientLight intensity={2.1} color="#e8f2ff" />
        <directionalLight position={[8, 22, 6]} intensity={2.3} color="#fff6e0" />
        <directionalLight position={[-10, 14, 30]} intensity={0.7} color="#bfe4ff" />
        {/* The arena draws its own canvas textures, so it never suspends.
            Units load separately — the field must never wait on meshes. */}
        <Arena placing={placing} />
        <Suspense fallback={null}>
          <UnitsBillboard />
        </Suspense>
        {[0, 1, 2, 3, 4, 5].map((i) => <TowerMesh key={i} index={i} />)}
        <SpellMarkers />
        <TowerFire />
        <DropMarker at={marker} />
      </Canvas>
    </div>
  );
}
