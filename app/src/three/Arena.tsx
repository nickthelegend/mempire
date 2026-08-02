import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { FP } from '../sim/fixed';
import { ARENA_H, ARENA_W, BRIDGE_X, RIVER_BOT, RIVER_TOP } from '../sim/engine';
import { grassTexture, waterTexture, woodTexture } from './textures';

const W = ARENA_W / FP; // 18
const H = ARENA_H / FP; // 32
const RT = RIVER_TOP / FP;
const RB = RIVER_BOT / FP;

const FRAME = 1.3; // wood border thickness

/**
 * The arena, built to read the way the genre's players expect: checkered green
 * grass inside a wood frame, a cyan river with plank bridges, and scenery
 * outside the frame so the board sits in a place rather than in a void.
 *
 * Geometry and textures are memoised and disposed on unmount — this subtree
 * rebuilds whenever a match starts.
 */
export function Arena({ placing }: { placing: boolean }) {
  const grass = useMemo(grassTexture, []);
  const water = useMemo(waterTexture, []);
  const woodFrame = useMemo(() => woodTexture([6, 1]), []);
  const woodPlank = useMemo(() => woodTexture([2, 1]), []);
  const waterRef = useRef<THREE.MeshStandardMaterial>(null);

  useEffect(() => () => {
    [grass, water, woodFrame, woodPlank].forEach((t) => t.dispose());
  }, [grass, water, woodFrame, woodPlank]);

  // river drifts, so the board is never completely still
  useFrame((_, dt) => {
    water.offset.x += dt * 0.05;
    if (waterRef.current) waterRef.current.needsUpdate = false;
  });

  // Scenery is placed from a fixed table rather than at random: a board that
  // reshuffles its trees every match feels unstable.
  const scenery = useMemo(() => {
    const spots: { x: number; z: number; kind: 'tree' | 'rock'; s: number }[] = [];
    const edges = [-FRAME - 1.4, W + FRAME + 1.4];
    for (let i = 0; i < 9; i++) {
      const z = 1.5 + i * (H / 9);
      edges.forEach((x, k) => {
        spots.push({
          x: x + (i % 2 ? 0.5 : -0.3) * (k ? -1 : 1),
          z,
          kind: (i + k) % 3 === 0 ? 'rock' : 'tree',
          s: 0.85 + ((i * 7 + k * 3) % 5) * 0.08,
        });
      });
    }
    // corners behind each king
    [-1.8, W + 1.8].forEach((x) => {
      [-1.9, H + 1.9].forEach((z) => spots.push({ x, z, kind: 'tree', s: 1.15 }));
    });
    return spots;
  }, []);

  return (
    <group>
      {/* ── wood frame ─────────────────────────────────────────────── */}
      {[
        { pos: [W / 2, 0.16, -FRAME / 2] as const, size: [W + FRAME * 2, 0.34, FRAME] as const },
        { pos: [W / 2, 0.16, H + FRAME / 2] as const, size: [W + FRAME * 2, 0.34, FRAME] as const },
        { pos: [-FRAME / 2, 0.16, H / 2] as const, size: [FRAME, 0.34, H] as const },
        { pos: [W + FRAME / 2, 0.16, H / 2] as const, size: [FRAME, 0.34, H] as const },
      ].map((b, i) => (
        <mesh key={i} position={b.pos as unknown as [number, number, number]}>
          <boxGeometry args={b.size as unknown as [number, number, number]} />
          <meshStandardMaterial map={woodFrame} roughness={0.8} />
        </mesh>
      ))}

      {/* ── grass, one continuous field ─────────────────────────────
          Both halves share the same material: tinting one side made the
          board look like two different lawns stitched together. Ownership
          is read from the towers and the unit rings instead. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[W / 2, 0, H / 2]} receiveShadow>
        <planeGeometry args={[W, H]} />
        <meshStandardMaterial map={grass} roughness={0.92} />
      </mesh>

      {/* ── river ──────────────────────────────────────────────────── */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[W / 2, 0.03, (RT + RB) / 2]}>
        <planeGeometry args={[W, RB - RT]} />
        <meshStandardMaterial
          ref={waterRef}
          map={water}
          transparent
          opacity={0.95}
          roughness={0.24}
          metalness={0.12}
        />
      </mesh>
      {/* river banks */}
      {[RT, RB].map((z) => (
        <mesh key={z} position={[W / 2, 0.07, z]}>
          <boxGeometry args={[W, 0.14, 0.24]} />
          <meshStandardMaterial color="#8a6b3c" roughness={0.9} />
        </mesh>
      ))}

      {/* ── bridges ────────────────────────────────────────────────── */}
      {BRIDGE_X.map((bx) => {
        const x = bx / FP;
        return (
          <group key={bx}>
            <mesh position={[x, 0.11, (RT + RB) / 2]}>
              <boxGeometry args={[2.6, 0.22, RB - RT + 0.5]} />
              <meshStandardMaterial map={woodPlank} roughness={0.82} />
            </mesh>
            {/* rails */}
            {[-1.24, 1.24].map((off) => (
              <mesh key={off} position={[x + off, 0.3, (RT + RB) / 2]}>
                <boxGeometry args={[0.16, 0.3, RB - RT + 0.5]} />
                <meshStandardMaterial color="#7a5424" roughness={0.85} />
              </mesh>
            ))}
          </group>
        );
      })}

      {/* ── own-half highlight while a card is held ────────────────── */}
      {placing && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[W / 2, 0.05, RT / 2]}>
          <planeGeometry args={[W, RT]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0.13} />
        </mesh>
      )}

      {/* ── scenery outside the frame ──────────────────────────────── */}
      {scenery.map((s, i) => (
        s.kind === 'tree'
          ? <Tree key={i} x={s.x} z={s.z} s={s.s} />
          : <Rock key={i} x={s.x} z={s.z} s={s.s} />
      ))}
    </group>
  );
}

function Tree({ x, z, s }: { x: number; z: number; s: number }) {
  return (
    <group position={[x, 0, z]} scale={s}>
      <mesh position={[0, 0.5, 0]}>
        <cylinderGeometry args={[0.16, 0.22, 1, 6]} />
        <meshStandardMaterial color="#6b4423" roughness={0.9} />
      </mesh>
      {[0, 1, 2].map((i) => (
        <mesh key={i} position={[0, 1.15 + i * 0.52, 0]}>
          <coneGeometry args={[0.92 - i * 0.24, 0.85, 7]} />
          <meshStandardMaterial color={i === 2 ? '#4f9a32' : '#3f8228'} roughness={0.86} />
        </mesh>
      ))}
    </group>
  );
}

function Rock({ x, z, s }: { x: number; z: number; s: number }) {
  return (
    <group position={[x, 0, z]} scale={s}>
      <mesh position={[0, 0.34, 0]} rotation={[0.3, 0.8, 0.15]}>
        <dodecahedronGeometry args={[0.55, 0]} />
        <meshStandardMaterial color="#8d8f96" roughness={0.95} />
      </mesh>
      <mesh position={[0.42, 0.18, 0.2]} rotation={[0.7, 0.2, 0]}>
        <dodecahedronGeometry args={[0.3, 0]} />
        <meshStandardMaterial color="#7c7e85" roughness={0.95} />
      </mesh>
    </group>
  );
}
