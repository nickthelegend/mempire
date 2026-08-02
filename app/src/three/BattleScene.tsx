import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useTexture } from '@react-three/drei';
import { Suspense, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { ARENA, PALETTE } from '../lib/palette';
import { FP, fp } from '../sim/fixed';
import { ARENA_H, ARENA_W, BRIDGE_X, RIVER_BOT, RIVER_TOP } from '../sim/engine';
import type { Tower } from '../sim/types';
import { useMatch } from '../state/match';

const W = ARENA_W / FP; // 18
const H = ARENA_H / FP; // 32

/** Owns the camera every mount (HMR-safe); frames the full field portrait. */
let activeCamera: THREE.Camera | null = null;

function CameraRig() {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  useEffect(() => {
    camera.position.set(W / 2, 33, -11.5);
    camera.lookAt(W / 2, 0, 14);
    camera.updateProjectionMatrix();
    // Deliberately never cleared: StrictMode double-invokes effect cleanup in
    // dev, and nulling here left deploy raycasts with no camera to project
    // through, silently swallowing every card the player dropped.
    activeCamera = camera;
  }, [camera, size]);
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

/** Player 0's legal drop zone in world units, mirrored by the sim's clamp. */
export const OWN_HALF = {
  minX: 0.5,
  maxX: W - 0.5,
  minZ: 0.5,
  maxZ: RIVER_TOP / FP - 0.5,
};

export const isLegalDrop = (x: number, z: number): boolean =>
  x >= OWN_HALF.minX && x <= OWN_HALF.maxX && z >= OWN_HALF.minZ && z <= OWN_HALF.maxZ;

/**
 * Snap a ground hit into the player's half.
 *
 * Rejecting an out-of-bounds release is the wrong call: a fat-fingered drop
 * near the river or off the field should still deploy, the way it does in the
 * games this borrows from. Only a drop well inside enemy territory is refused,
 * so the marker still teaches where the line is.
 */
export function clampDrop(x: number, z: number): { x: number; z: number } {
  return {
    x: Math.min(Math.max(x, OWN_HALF.minX), OWN_HALF.maxX),
    z: Math.min(Math.max(z, OWN_HALF.minZ), OWN_HALF.maxZ),
  };
}

function TowerMesh({ index }: { index: number }) {
  const group = useRef<THREE.Group>(null);
  const barGroup = useRef<THREE.Group>(null);
  const bar = useRef<THREE.Mesh>(null);
  const barMat = useRef<THREE.MeshBasicMaterial>(null);

  useFrame(({ camera }) => {
    const sim = useMatch.getState().sim;
    if (!sim || !group.current) return;
    const t: Tower = sim.towers[index];
    const pct = Math.max(0, t.hp / t.maxHp);
    group.current.visible = t.hp > 0;
    if (bar.current) bar.current.scale.x = Math.max(0.001, pct);
    if (barMat.current) {
      // gold is reserved for money; a hurt tower reads as damage, so it goes red
      barMat.current.color.set(pct > 0.4 ? (t.owner === 0 ? PALETTE.teal : PALETTE.red) : PALETTE.red);
    }
    barGroup.current?.quaternion.copy(camera.quaternion);
  });

  const sim = useMatch.getState().sim;
  if (!sim) return null;
  const t = sim.towers[index];
  const isKing = t.kind === 'king';
  const x = t.x / FP;
  const z = t.y / FP;
  const height = isKing ? 2.6 : 2.0;
  const radius = isKing ? 1.15 : 0.85;
  const bodyColor = t.owner === 0 ? ARENA.towerOwn : ARENA.towerEnemy;

  return (
    <group ref={group} position={[x, 0, z]}>
      <mesh position={[0, height / 2, 0]}>
        <cylinderGeometry args={[radius * 0.82, radius, height, 8]} />
        <meshStandardMaterial color={bodyColor} roughness={0.8} />
      </mesh>
      <mesh position={[0, height + 0.09, 0]}>
        <cylinderGeometry args={[radius * 1.02, radius * 0.82, 0.3, 8]} />
        <meshStandardMaterial color={PALETTE.gold} metalness={0.55} roughness={0.35} />
      </mesh>
      {isKing && (
        <mesh position={[0, height + 0.55, 0]}>
          <coneGeometry args={[0.5, 0.75, 4]} />
          <meshStandardMaterial
            color={PALETTE.goldHi} metalness={0.7} roughness={0.25}
            emissive={PALETTE.gold} emissiveIntensity={0.45}
          />
        </mesh>
      )}
      {/* hp bar — billboarded to camera */}
      <group ref={barGroup} position={[0, height + (isKing ? 1.2 : 0.7), 0]}>
        <mesh>
          <planeGeometry args={[1.7, 0.18]} />
          <meshBasicMaterial color={ARENA.hpTrack} />
        </mesh>
        <mesh ref={bar} position={[0, 0, 0.01]}>
          <planeGeometry args={[1.62, 0.12]} />
          <meshBasicMaterial ref={barMat} color={PALETTE.teal} />
        </mesh>
      </group>
    </group>
  );
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
  const bolts = useRef<{ mesh: THREE.Mesh; from: THREE.Vector3; to: THREE.Vector3; t: number }[]>([]);

  useFrame((_, dtRaw) => {
    const sim = useMatch.getState().sim;
    const g = root.current;
    if (!sim || !g) return;
    const dt = Math.min(dtRaw, 0.05);

    sim.towers.forEach((t, i) => {
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

/** Untextured field, shown for the frames before the floor texture decodes. */
function FallbackGround() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[W / 2, 0, H / 2]}>
      <planeGeometry args={[W, H]} />
      <meshStandardMaterial color={ARENA.ground} roughness={0.9} />
    </mesh>
  );
}

function Ground({ placing }: { placing: boolean }) {
  // built once — rebuilding per render replaced the GPU buffer every frame
  const gridGeo = useMemo(() => {
    const pts: number[] = [];
    for (let i = 1; i < W; i += 1) pts.push(i, 0, 0, i, 0, H);
    for (let j = 1; j < H; j += 1) pts.push(0, 0, j, W, 0, j);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, []);
  useEffect(() => () => gridGeo.dispose(), [gridGeo]);

  const floor = useTexture('/art/arena_ground.png');
  useMemo(() => {
    floor.wrapS = THREE.RepeatWrapping;
    floor.wrapT = THREE.RepeatWrapping;
    floor.repeat.set(4, 7);
    floor.colorSpace = THREE.SRGBColorSpace;
  }, [floor]);

  return (
    <group>
      {/* textured field */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[W / 2, 0, H / 2]}>
        <planeGeometry args={[W, H]} />
        <meshStandardMaterial map={floor} color="#b9a8ff" roughness={0.85} />
      </mesh>
      {/* half tints so ownership reads instantly */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[W / 2, 0.008, (RIVER_TOP / FP) / 2]}>
        <planeGeometry args={[W, RIVER_TOP / FP]} />
        <meshBasicMaterial color={PALETTE.teal} transparent opacity={0.07} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[W / 2, 0.008, H - (RIVER_TOP / FP) / 2]}>
        <planeGeometry args={[W, RIVER_TOP / FP]} />
        <meshBasicMaterial color={PALETTE.red} transparent opacity={0.07} />
      </mesh>
      <lineSegments geometry={gridGeo} position={[0, 0.014, 0]}>
        <lineBasicMaterial color={ARENA.grid} transparent opacity={0.35} />
      </lineSegments>
      {/* river */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[W / 2, 0.02, (RIVER_TOP / FP + RIVER_BOT / FP) / 2]}>
        <planeGeometry args={[W, (RIVER_BOT - RIVER_TOP) / FP]} />
        <meshStandardMaterial
          color={ARENA.river} emissive={PALETTE.teal} emissiveIntensity={0.35} roughness={0.4}
        />
      </mesh>
      {/* bridges */}
      {BRIDGE_X.map((bx) => (
        <mesh key={bx} position={[bx / FP, 0.09, H / 2]}>
          <boxGeometry args={[2.4, 0.18, 2.6]} />
          <meshStandardMaterial color={ARENA.bridge} roughness={0.75} />
        </mesh>
      ))}
      {/* gold trim on bridge edges */}
      {BRIDGE_X.map((bx) => (
        <mesh key={`t${bx}`} position={[bx / FP, 0.19, H / 2]}>
          <boxGeometry args={[2.5, 0.04, 0.12]} />
          <meshStandardMaterial color={PALETTE.gold} metalness={0.7} roughness={0.3} />
        </mesh>
      ))}
      {/* own-half highlight while placing */}
      {placing && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[W / 2, 0.03, (RIVER_TOP / FP) / 2]}>
          <planeGeometry args={[W, RIVER_TOP / FP]} />
          <meshBasicMaterial color={PALETTE.purple} transparent opacity={0.14} />
        </mesh>
      )}
    </group>
  );
}

import { Units } from './Units';

export function BattleScene({ onPlace, placing, marker, sceneRef }: {
  onPlace: (xFp: number, yFp: number) => void;
  placing: boolean;
  marker: { x: number; z: number; legal: boolean } | null;
  sceneRef?: React.Ref<HTMLDivElement>;
}) {
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
        <CameraRig />
        <color attach="background" args={['#0d2a5c']} />
        <fog attach="fog" args={['#123566', 62, 120]} />
        <ambientLight intensity={1.9} color="#cfe0ff" />
        <directionalLight position={[7, 20, 3]} intensity={2.5} color="#fff3d4" />
        <directionalLight position={[-9, 12, 30]} intensity={0.9} color="#8fd8ff" />
        {/* Separate boundaries: the field must not wait on ~30MB of unit
            meshes, or the arena is blank for the first seconds of a match. */}
        <Suspense fallback={<FallbackGround />}>
          <Ground placing={placing} />
        </Suspense>
        <Suspense fallback={null}>
          <Units />
        </Suspense>
        {[0, 1, 2, 3, 4, 5].map((i) => <TowerMesh key={i} index={i} />)}
        <SpellMarkers />
        <TowerFire />
        <DropMarker at={marker} />
      </Canvas>
    </div>
  );
}
