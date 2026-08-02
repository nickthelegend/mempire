import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { GLTFLoader } from 'three-stdlib';
import { SkeletonUtils } from 'three-stdlib';
// Models ship meshopt-compressed, so the loader needs the decoder registered.
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { ARENA, PALETTE } from '../lib/palette';
import { COINS } from '../lib/coins';
import { FP } from '../sim/fixed';
import { Archetype, type SimState, type Unit } from '../sim/types';
import { useMatch } from '../state/match';

/**
 * Battle units, on real rigs.
 *
 * These are KayKit CC0 chibi characters — properly skinned skeletons carrying
 * Idle / Walk / Run / Attack / Hit / Death clips. Earlier the meshes were
 * generated and static, which meant every unit slid around frozen; a genuine
 * AnimationMixer is worth far more here than better-looking geometry.
 *
 * Meme identity comes from the owner tint plus the coin sigil above each unit,
 * so one rig family covers any number of coins.
 */
const MODEL: Record<number, string> = {
  [Archetype.Tank]: '/models/unit_tank.glb',
  [Archetype.Swarm]: '/models/unit_swarm.glb',
  [Archetype.Ranged]: '/models/unit_ranged.glb',
  [Archetype.Splash]: '/models/unit_splash.glb',
  [Archetype.Support]: '/models/unit_support.glb',
};

/** Which clip each archetype swings with — matched to the character's weapon. */
const ATTACK_CLIP: Record<number, string> = {
  [Archetype.Tank]: '1H_Melee_Attack_Chop',
  [Archetype.Swarm]: '1H_Melee_Attack_Chop',
  [Archetype.Ranged]: 'Spellcast_Shoot',
  [Archetype.Splash]: '2H_Melee_Attack_Chop',
  [Archetype.Support]: '1H_Melee_Attack_Chop',
};

/**
 * Presentation height in world tiles, per archetype.
 *
 * Deliberately larger than the sim's collision footprint: at this camera height
 * a unit scaled to its true radius is a dot. Readability of who is on the field
 * matters more than physical honesty, which is why the genre oversizes them too.
 */
const HEIGHT: Record<number, number> = {
  [Archetype.Tank]: 3.4,
  [Archetype.Swarm]: 2.5,
  [Archetype.Ranged]: 3.0,
  [Archetype.Splash]: 3.3,
  [Archetype.Support]: 3.0,
};

const OWN_TINT = new THREE.Color(ARENA.tintOwn);
const ENEMY_TINT = new THREE.Color(ARENA.tintEnemy);

const HIT_FLASH = 0.15;
const SPAWN_POP = 0.4;
const DEATH_TIME = 0.75;
const FADE = 0.18; // clip cross-fade

type Motion = 'idle' | 'walk' | 'attack' | 'hit' | 'death';

interface LiveUnit {
  group: THREE.Group;
  mixer: THREE.AnimationMixer;
  actions: Partial<Record<Motion, THREE.AnimationAction>>;
  motion: Motion;
  ring: THREE.Mesh;
  ringDone: boolean;
  spawning: number;
  dying: number;
  hitFlash: number;
  lastHp: number;
  lastX: number;
  lastZ: number;
  facing: number;
}

const withMeshopt = (loader: GLTFLoader) => { loader.setMeshoptDecoder(MeshoptDecoder); };

function coinHue(mint: string): number {
  return COINS.find((c) => c.mint === mint)?.hue ?? 260;
}

function findClip(clips: THREE.AnimationClip[], name: string): THREE.AnimationClip | undefined {
  return clips.find((c) => c.name === name)
    ?? clips.find((c) => c.name.toLowerCase().includes(name.toLowerCase()));
}

/** Cloned materials and the mixer are per-unit, so both release per-unit. */
function disposeUnit(lu: LiveUnit): void {
  lu.mixer.stopAllAction();
  lu.group.traverse((o) => {
    const mat = (o as THREE.Mesh).material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat?.dispose();
  });
}

/** Absolute fit, never multiplied, and re-centred — rigs carry odd pivots. */
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
    useGLTF(MODEL[0], undefined, undefined, withMeshopt),
    useGLTF(MODEL[1], undefined, undefined, withMeshopt),
    useGLTF(MODEL[2], undefined, undefined, withMeshopt),
    useGLTF(MODEL[3], undefined, undefined, withMeshopt),
    useGLTF(MODEL[4], undefined, undefined, withMeshopt),
  ];
  const root = useRef<THREE.Group>(null);
  const live = useRef(new Map<number, LiveUnit>());
  const ringGeo = useMemo(() => new THREE.RingGeometry(0.36, 0.52, 24), []);
  const discGeo = useMemo(() => new THREE.CircleGeometry(0.26, 20), []);
  const shadowGeo = useMemo(() => new THREE.CircleGeometry(0.46, 18), []);

  const spawn = (u: Unit, deckOf: (o: 0 | 1) => { coinId: string }[]): LiveUnit => {
    const proto = gltfs[u.archetype] ?? gltfs[0];
    const group = new THREE.Group();

    const model = SkeletonUtils.clone(proto.scene);
    const tint = u.owner === 0 ? OWN_TINT : ENEMY_TINT;
    model.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if ((mesh.isMesh || mesh.isSkinnedMesh) && mesh.material) {
        const m = (mesh.material as THREE.MeshStandardMaterial).clone();
        m.color.lerp(tint, 0.3);
        mesh.material = m;
        mesh.frustumCulled = false; // skinned bounds are unreliable on clones
      }
    });
    fitToHeight(model, HEIGHT[u.archetype] ?? 2.0);
    group.add(model);

    // contact shadow, so a unit sits on the grass rather than hovering
    const shadow = new THREE.Mesh(
      shadowGeo,
      new THREE.MeshBasicMaterial({ color: '#1d3a12', transparent: true, opacity: 0.3, depthWrite: false }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.02;
    group.add(shadow);

    // ownership ring
    const own = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({
        color: u.owner === 0 ? '#3fa9ff' : '#ff5a4a',
        transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    own.rotation.x = -Math.PI / 2;
    own.position.y = 0.035;
    group.add(own);

    // coin sigil billboard
    const hue = coinHue(deckOf(u.owner)[u.cardIndex]?.coinId ?? '');
    const disc = new THREE.Mesh(
      discGeo,
      new THREE.MeshBasicMaterial({ color: new THREE.Color(`hsl(${hue}, 88%, 60%)`), depthWrite: false }),
    );
    disc.position.y = (HEIGHT[u.archetype] ?? 2.0) + 0.45;
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
    shockwave.position.y = 0.07;
    group.add(shockwave);

    // ── the rig ──
    const mixer = new THREE.AnimationMixer(model);
    const clips = proto.animations;
    const mk = (name: string, once = false) => {
      const clip = findClip(clips, name);
      if (!clip) return undefined;
      const a = mixer.clipAction(clip);
      if (once) {
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true; // hold the final pose (death, hit reaction)
      } else {
        a.setLoop(THREE.LoopRepeat, Infinity);
      }
      return a;
    };
    const actions: LiveUnit['actions'] = {
      idle: mk('Idle'),
      walk: mk('Walking_A'),
      attack: mk(ATTACK_CLIP[u.archetype] ?? '1H_Melee_Attack_Chop'),
      hit: mk('Hit_A', true),
      death: mk('Death_A', true),
    };
    // walk a touch faster than authored so it matches the sim's march speed
    if (actions.walk) actions.walk.timeScale = 1.25;
    if (actions.attack) actions.attack.timeScale = 1.15;
    actions.walk?.play();

    group.position.set(u.x / FP, 0, u.y / FP);
    group.scale.setScalar(0.01);
    return {
      group, mixer, actions, motion: 'walk',
      ring: shockwave, ringDone: false,
      spawning: 0, dying: 0, hitFlash: 0,
      lastHp: u.hp, lastX: u.x / FP, lastZ: u.y / FP,
      facing: u.owner === 0 ? 0 : Math.PI,
    };
  };

  /** Cross-fade to a motion, only when it actually changes. */
  const setMotion = (lu: LiveUnit, next: Motion) => {
    if (lu.motion === next) return;
    const from = lu.actions[lu.motion];
    const to = lu.actions[next];
    if (!to) return;
    to.reset().fadeIn(FADE).play();
    from?.fadeOut(FADE);
    lu.motion = next;
  };

  useFrame((state, dtRaw) => {
    const store = useMatch.getState();
    const sim: SimState | null = store.sim;
    if (!sim || !root.current) return;
    const dt = Math.min(dtRaw, 0.05); // a backgrounded tab must not jump the rigs
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
        const want = Math.atan2(dx, dz);
        let delta = want - lu.facing;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        lu.facing += delta * Math.min(1, dt * 12);
      }
      lu.group.rotation.y = lu.facing;
      lu.lastX = tx; lu.lastZ = tz;

      // motion state: the rig now says what the unit is doing
      if (u.hp < lu.lastHp) lu.hitFlash = HIT_FLASH;
      lu.lastHp = u.hp;
      setMotion(lu, u.state === 'attack' ? 'attack' : moving ? 'walk' : 'idle');

      if (lu.spawning < SPAWN_POP) {
        lu.spawning += dt;
        const t = Math.min(1, lu.spawning / SPAWN_POP);
        const eased = 1 - Math.pow(1 - t, 3);
        lu.group.scale.setScalar(eased * (1 + 0.16 * Math.sin(Math.PI * t)));
        lu.ring.scale.setScalar(0.4 + t * 3.4);
        (lu.ring.material as THREE.MeshBasicMaterial).opacity = 0.95 * (1 - t);
        if (t >= 1 && !lu.ringDone) {
          lu.ringDone = true;
          lu.group.remove(lu.ring);
          (lu.ring.material as THREE.Material).dispose();
        }
      }

      // damage tint only — the rig owns the pose
      if (lu.hitFlash > 0) {
        lu.hitFlash = Math.max(0, lu.hitFlash - dt);
        const f = lu.hitFlash / HIT_FLASH;
        lu.group.traverse((o) => {
          const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
          if (m?.emissive) m.emissive.setRGB(0.9 * f, 0.06 * f, 0.12 * f);
        });
      }

      const sigil = lu.group.getObjectByName('sigil') as THREE.Mesh | null;
      if (sigil) {
        sigil.lookAt(state.camera.position);
        const mat = sigil.material as THREE.MeshBasicMaterial;
        mat.transparent = true;
        mat.opacity = 0.5 + 0.5 * (u.hp / u.maxHp);
      }

      lu.mixer.update(dt);
    }

    // deaths play the death clip, then sink and release
    for (const [id, lu] of live.current) {
      if (seen.has(id)) continue;
      if (lu.dying === 0) setMotion(lu, 'death');
      lu.dying += dt;
      lu.mixer.update(dt);
      const t = Math.min(1, lu.dying / DEATH_TIME);
      if (t > 0.55) {
        const f = (t - 0.55) / 0.45;
        lu.group.position.y = -f * 0.9;
        lu.group.traverse((o) => {
          const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
          if (m) { m.transparent = true; m.opacity = 1 - f; }
        });
      }
      if (lu.dying >= DEATH_TIME) {
        root.current.remove(lu.group);
        disposeUnit(lu);
        live.current.delete(id);
      }
    }
  });

  // Release cloned materials on unmount. The shared geometries are deliberately
  // not disposed — StrictMode double-invokes cleanup in dev.
  useEffect(() => {
    const pool = live.current;
    return () => { pool.forEach(disposeUnit); pool.clear(); };
  }, []);

  return <group ref={root} />;
}

Object.values(MODEL).forEach((m) => useGLTF.preload(m, undefined, undefined, withMeshopt));
