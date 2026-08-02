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
      if (moving) {
        // turn toward travel rather than snapping, so corners read as a pivot
        const want = Math.atan2(dx, dz);
        let delta = want - lu.facing;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        lu.facing += delta * Math.min(1, dt * 12);
      }
      lu.group.rotation.y = lu.facing;
      lu.lastX = tx; lu.lastZ = tz;

      /*
       * These meshes have no skeleton, so all life comes from here. A hop-march
       * (rise, tilt into the step, squash on landing) reads as walking far
       * better than a gentle bob does — the silhouette actually changes shape,
       * which is what the eye reads as motion at this camera height.
       */
      const speed = moving ? 13 : 2.6;
      lu.phase += dt * speed;

      if (moving) {
        const hop = Math.abs(Math.sin(lu.phase));      // 0..1, two beats per cycle
        const landing = Math.max(0, -Math.cos(lu.phase * 2)); // peaks at footfall
        lu.body.position.y = hop * 0.19;
        // squash on landing, stretch at the top of the hop
        lu.body.scale.set(
          1 + landing * 0.11 - hop * 0.04,
          1 - landing * 0.13 + hop * 0.07,
          1 + landing * 0.11 - hop * 0.04,
        );
        lu.body.rotation.z = Math.sin(lu.phase) * 0.15;   // rock side to side
        lu.body.rotation.x = -0.09 - hop * 0.06;          // lean into the march
      } else {
        // idle breathing, so a waiting unit is never a statue
        const breathe = Math.sin(lu.phase) * 0.5 + 0.5;
        lu.body.position.y = breathe * 0.035;
        lu.body.scale.set(1 + breathe * 0.018, 1 - breathe * 0.022, 1 + breathe * 0.018);
        lu.body.rotation.z *= 0.85;
        lu.body.rotation.x *= 0.85;
      }

      // attack: wind back, then snap forward and recoil
      if (u.state === 'attack' && lu.swing <= 0) lu.swing = SWING_TIME;
      if (lu.swing > 0) {
        lu.swing = Math.max(0, lu.swing - dt);
        const t = 1 - lu.swing / SWING_TIME;
        // -1 winding up through 0 to +1 at full extension
        const strike = t < 0.3 ? -(t / 0.3) * 0.4 : Math.sin(((t - 0.3) / 0.7) * Math.PI);
        lu.body.position.z = strike * 0.42;
        lu.body.rotation.x = -strike * 0.42;
        lu.group.rotation.y = lu.facing + strike * 0.16; // shoulder into the blow
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
      // Tint only — the walk cycle owns scale, so a flash must not fight it.
      if (lu.hitFlash > 0) {
        lu.hitFlash = Math.max(0, lu.hitFlash - dt);
        const f = lu.hitFlash / HIT_FLASH;
        lu.group.traverse((o) => {
          const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
          if (m?.emissive) m.emissive.setRGB(0.9 * f, 0.06 * f, 0.14 * f);
        });
        lu.body.scale.multiplyScalar(1 + f * 0.1);
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
