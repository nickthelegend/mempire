import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { ARENA, PALETTE } from '../lib/palette';
import { SkeletonUtils } from 'three-stdlib';
import { FP } from '../sim/fixed';
import { Archetype, type SimState, type Unit } from '../sim/types';
import { useMatch } from '../state/match';
import { COINS } from '../lib/coins';

/**
 * Generated chibi meshes are static (the auto-rigger is humanoid-only and the
 * animal silhouettes fail it), so motion is procedural: a march bob while
 * advancing, a lunge on each swing, a squash on impact. At this camera height
 * that reads better than skeletal playback and never mismatches the sim.
 */
const MODEL: Record<number, string> = {
  [Archetype.Tank]: '/models/unit_tank.glb',
  [Archetype.Swarm]: '/models/unit_swarm.glb',
  [Archetype.Ranged]: '/models/unit_ranged.glb',
  [Archetype.Splash]: '/models/unit_splash.glb',
  [Archetype.Support]: '/models/unit_support.glb',
};

// Per-archetype presentation scale — chibi proportions vary a lot by concept.
const SCALE: Record<number, number> = {
  [Archetype.Tank]: 2.5,
  [Archetype.Swarm]: 1.7,
  [Archetype.Ranged]: 2.0,
  [Archetype.Splash]: 2.1,
  [Archetype.Support]: 2.1,
};

const OWN_TINT = new THREE.Color(ARENA.tintOwn);
const ENEMY_TINT = new THREE.Color(ARENA.tintEnemy);

interface LiveUnit {
  group: THREE.Group;   // world transform
  body: THREE.Group;    // animated locally so world position stays authoritative
  ring: THREE.Mesh;     // deploy shockwave
  ringDone: boolean;
  dying: number;
  spawning: number;
  phase: number;        // per-unit march offset so a swarm doesn't move in lockstep
  swing: number;        // seconds left in the current attack lunge
  hitFlash: number;
  lastHp: number;
  lastX: number;
  lastZ: number;
  facing: number;
}

const SPAWN_POP = 0.42;
const HIT_FLASH = 0.14;
const SWING_TIME = 0.34;

function coinHue(mint: string): number {
  return COINS.find((c) => c.mint === mint)?.hue ?? 260;
}

/** Cloned materials are per-unit (owner tint), so they are released per-unit. */
function disposeUnit(lu: LiveUnit): void {
  lu.group.traverse((o) => {
    const mat = (o as THREE.Mesh).material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat?.dispose();
  });
}

/**
 * Normalise wildly different generated mesh sizes to a common height.
 * Sets scale absolutely (never multiplies) and re-centres on X/Z so the unit
 * stands on its own origin — generated meshes carry arbitrary pivots.
 */
function fitToHeight(model: THREE.Object3D, target: number): void {
  model.scale.setScalar(1);
  model.position.set(0, 0, 0);
  model.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  const centre = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(centre);
  if (!Number.isFinite(size.y) || size.y < 1e-4) return;

  const s = target / size.y;
  model.scale.setScalar(s);
  model.position.set(-centre.x * s, -box.min.y * s, -centre.z * s);
}

export function Units() {
  const gltfs = [
    useGLTF(MODEL[0]), useGLTF(MODEL[1]), useGLTF(MODEL[2]),
    useGLTF(MODEL[3]), useGLTF(MODEL[4]),
  ];
  const root = useRef<THREE.Group>(null);
  const live = useRef(new Map<number, LiveUnit>());
  const ringGeo = useMemo(() => new THREE.RingGeometry(0.34, 0.5, 24), []);
  const discGeo = useMemo(() => new THREE.CircleGeometry(0.24, 20), []);
  const shadowGeo = useMemo(() => new THREE.CircleGeometry(0.42, 18), []);

  const spawn = (u: Unit, deckOf: (o: 0 | 1) => { coinId: string }[]): LiveUnit => {
    const proto = gltfs[u.archetype] ?? gltfs[0];
    const group = new THREE.Group();
    const body = new THREE.Group();

    const model = SkeletonUtils.clone(proto.scene);
    const tint = u.owner === 0 ? OWN_TINT : ENEMY_TINT;
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.material) {
        const m = (mesh.material as THREE.MeshStandardMaterial).clone();
        m.color.lerp(tint, 0.16);
        m.roughness = Math.min(1, (m.roughness ?? 0.8) + 0.1);
        mesh.material = m;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
      }
    });
    fitToHeight(model, SCALE[u.archetype] ?? 1.25);
    body.add(model);
    group.add(body);

    // contact shadow — grounds the unit without a shadow map
    const shadow = new THREE.Mesh(
      shadowGeo,
      new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.34, depthWrite: false }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.015;
    group.add(shadow);

    // ownership ring
    const own = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({
        color: u.owner === 0 ? PALETTE.teal : PALETTE.red,
        transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    own.rotation.x = -Math.PI / 2;
    own.position.y = 0.03;
    group.add(own);

    // coin sigil billboard
    const hue = coinHue(deckOf(u.owner)[u.cardIndex]?.coinId ?? '');
    const disc = new THREE.Mesh(
      discGeo,
      new THREE.MeshBasicMaterial({ color: new THREE.Color(`hsl(${hue}, 88%, 62%)`), depthWrite: false }),
    );
    disc.position.y = (SCALE[u.archetype] ?? 1.25) + 0.55;
    disc.name = 'sigil';
    group.add(disc);

    // deploy shockwave
    const shockwave = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({
        color: u.owner === 0 ? PALETTE.teal : PALETTE.red,
        transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    shockwave.rotation.x = -Math.PI / 2;
    shockwave.position.y = 0.06;
    group.add(shockwave);

    group.position.set(u.x / FP, 0, u.y / FP);
    group.scale.setScalar(0.01);
    return {
      group, body, ring: shockwave, ringDone: false,
      dying: 0, spawning: 0,
      phase: (u.id * 1.7) % (Math.PI * 2),
      swing: 0, hitFlash: 0,
      lastHp: u.hp, lastX: u.x / FP, lastZ: u.y / FP,
      facing: u.owner === 0 ? 0 : Math.PI,
    };
  };

  useFrame((state, dtRaw) => {
    const store = useMatch.getState();
    const sim: SimState | null = store.sim;
    if (!sim || !root.current) return;
    const dt = Math.min(dtRaw, 0.05); // a backgrounded tab must not jump the VFX
    const seen = new Set<number>();
    const deckOf = (o: 0 | 1) => (o === 0 ? store.playerDeck : store.botDeck);

    for (const u of sim.units) {
      seen.add(u.id);
      let lu = live.current.get(u.id);
      if (!lu) {
        lu = spawn(u, deckOf);
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
      const moving = dx * dx + dz * dz > 1e-7;
      if (moving) lu.facing = Math.atan2(dx, dz);
      lu.group.rotation.y = lu.facing;
      lu.lastX = tx; lu.lastZ = tz;

      // march bob + sway while advancing; settle when holding position
      lu.phase += dt * (moving ? 11 : 3.2);
      const bob = moving ? Math.abs(Math.sin(lu.phase)) * 0.11 : Math.sin(lu.phase) * 0.02;
      lu.body.position.y = bob;
      lu.body.rotation.z = moving ? Math.sin(lu.phase * 0.5) * 0.09 : 0;

      // attack: a forward lunge that retracts, retriggered each swing
      if (u.state === 'attack' && lu.swing <= 0) lu.swing = SWING_TIME;
      if (lu.swing > 0) {
        lu.swing = Math.max(0, lu.swing - dt);
        const t = 1 - lu.swing / SWING_TIME;
        const punch = Math.sin(t * Math.PI);
        lu.body.position.z = punch * 0.34;
        lu.body.rotation.x = -punch * 0.3;
      } else {
        lu.body.position.z *= 0.8;
        lu.body.rotation.x *= 0.8;
      }

      // spawn pop-in with overshoot, shockwave expanding away
      if (lu.spawning < SPAWN_POP) {
        lu.spawning += dt;
        const t = Math.min(1, lu.spawning / SPAWN_POP);
        const eased = 1 - Math.pow(1 - t, 3);
        lu.group.scale.setScalar(eased * (1 + 0.18 * Math.sin(Math.PI * t)));
        lu.ring.scale.setScalar(0.4 + t * 3.2);
        (lu.ring.material as THREE.MeshBasicMaterial).opacity = 0.95 * (1 - t);
        if (t >= 1 && !lu.ringDone) {
          lu.ringDone = true;
          lu.group.remove(lu.ring);
          (lu.ring.material as THREE.Material).dispose();
        }
      }

      // damage flash + squash
      if (u.hp < lu.lastHp) lu.hitFlash = HIT_FLASH;
      lu.lastHp = u.hp;
      if (lu.hitFlash > 0) {
        lu.hitFlash = Math.max(0, lu.hitFlash - dt);
        const f = lu.hitFlash / HIT_FLASH;
        lu.body.scale.set(1 + f * 0.13, 1 - f * 0.13, 1 + f * 0.13);
        lu.group.traverse((o) => {
          const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
          if (m?.emissive) m.emissive.setRGB(0.85 * f, 0.06 * f, 0.14 * f);
        });
      } else {
        lu.body.scale.setScalar(1);
      }

      const sigil = lu.group.getObjectByName('sigil') as THREE.Mesh | null;
      if (sigil) {
        sigil.lookAt(state.camera.position);
        const hpPct = u.hp / u.maxHp;
        const mat = sigil.material as THREE.MeshBasicMaterial;
        mat.transparent = true;
        mat.opacity = 0.45 + 0.55 * hpPct;
      }
    }

    // deaths: pop up, spin out, then release
    for (const [id, lu] of live.current) {
      if (seen.has(id)) continue;
      lu.dying += dt;
      const t = Math.min(1, lu.dying / 0.42);
      lu.group.scale.setScalar(Math.max(0, (1 - t) * (1 + 0.3 * Math.sin(t * Math.PI))));
      lu.body.position.y = Math.sin(t * Math.PI) * 0.5;
      lu.group.rotation.y += dt * 7;
      if (lu.dying >= 0.42) {
        root.current.remove(lu.group);
        disposeUnit(lu);
        live.current.delete(id);
      }
    }
  });

  // Release cloned materials on unmount. The memoised geometries are shared and
  // deliberately not disposed here — StrictMode double-invokes this in dev.
  useEffect(() => {
    const pool = live.current;
    return () => { pool.forEach(disposeUnit); pool.clear(); };
  }, []);

  return <group ref={root} />;
}

Object.values(MODEL).forEach((m) => useGLTF.preload(m));
