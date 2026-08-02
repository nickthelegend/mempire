/**
 * Demo clans, so the browse screen shows a populated ladder instead of an empty
 * list on first run. Idempotent: re-running skips clans that already exist.
 *
 * Run: node seed-clans.mjs      (server must be running)
 */
const API = process.env.API ?? 'http://localhost:8787';

/**
 * Deterministic base58 wallet addresses.
 *
 * These are shaped like Solana pubkeys and pass the server's validation, but
 * they are not derived from any keypair and no funds can ever reach them — they
 * exist only to populate rosters. Real members join with real wallets.
 */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function fakeAddress(seed) {
  let h = 0x811c9dc5;
  const out = [];
  for (let i = 0; i < 44; i += 1) {
    h ^= seed.charCodeAt(i % seed.length) + i;
    h = Math.imul(h, 0x01000193) >>> 0;
    out.push(B58[h % B58.length]);
  }
  return out.join('');
}

const CLANS = [
  {
    name: 'Degen Dynasty', description: 'we only hold what we can defend', region: 'Global',
    crest: { shape: 0, emblem: 0, hue: 268, tone: 0 }, requiredPower: 0, joinMode: 'open', members: 11,
  },
  {
    name: 'Rug Survivors', description: 'exit liquidity for nobody', region: 'Europe',
    crest: { shape: 2, emblem: 1, hue: 8, tone: 2 }, requiredPower: 120, joinMode: 'open', members: 8,
  },
  {
    name: 'Bonk Battalion', description: 'one coin, one army', region: 'North America',
    crest: { shape: 3, emblem: 6, hue: 32, tone: 1 }, requiredPower: 60, joinMode: 'open', members: 14,
  },
  {
    name: 'Liquidity Lords', description: 'depth over hype', region: 'Asia',
    crest: { shape: 1, emblem: 4, hue: 212, tone: 0 }, requiredPower: 240, joinMode: 'request', members: 6,
  },
  {
    name: 'Moon Mandate', description: 'up only, allegedly', region: 'Global',
    crest: { shape: 5, emblem: 3, hue: 190, tone: 1 }, requiredPower: 0, joinMode: 'open', members: 9,
  },
  {
    name: 'Diamond Paws', description: 'we do not sell, we accumulate', region: 'Oceania',
    crest: { shape: 4, emblem: 10, hue: 320, tone: 0 }, requiredPower: 180, joinMode: 'open', members: 4,
  },
  {
    name: 'Tower Tacticians', description: 'crowns are earned at the bridge', region: 'South America',
    crest: { shape: 0, emblem: 11, hue: 145, tone: 2 }, requiredPower: 100, joinMode: 'closed', members: 12,
  },
];

async function req(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
}

async function main() {
  const existing = await req('GET', '/api/clans');
  const have = new Set((existing.data?.clans ?? []).map((c) => c.name));

  for (const spec of CLANS) {
    if (have.has(spec.name)) { console.log(`${spec.name} — already seeded`); continue; }

    const leader = fakeAddress(`${spec.name}:leader`);
    const created = await req('POST', '/api/clans', {
      address: leader,
      name: spec.name,
      description: spec.description,
      region: spec.region,
      crest: spec.crest,
      // Seed as open, then tighten after members join — a power gate or a closed
      // door would block the very joins that populate the roster.
      requiredPower: 0,
      joinMode: 'open',
      memberName: `${spec.name.split(' ')[0].toLowerCase()}_king`,
      power: 600,
    });
    if (created.status !== 201) {
      console.log(`${spec.name} — FAILED: ${created.data?.error}`);
      continue;
    }
    const { tag } = created.data;

    for (let i = 1; i < spec.members; i += 1) {
      const addr = fakeAddress(`${spec.name}:${i}`);
      const joined = await req('POST', `/api/clans/${tag}/join`, {
        address: addr,
        memberName: `anon_${(i * 977) % 9000 + 1000}`,
        power: 200 + ((i * 137) % 400),
      });
      if (joined.status !== 200) continue;
      // Crowns give the roster a real ranking rather than a flat list of zeroes.
      const rounds = 1 + ((i * 7) % 9);
      for (let r = 0; r < rounds; r += 1) {
        await req('POST', `/api/clans/${tag}/crowns`, { address: addr, crowns: 1 + ((i + r) % 3) });
      }
      if (i % 3 === 0) {
        await req('POST', `/api/clans/${tag}/role`, {
          address: leader, target: addr, role: i % 6 === 0 ? 'coleader' : 'elder',
        });
      }
    }

    for (let r = 0; r < 6; r += 1) {
      await req('POST', `/api/clans/${tag}/crowns`, { address: leader, crowns: 3 });
    }

    // A couple of open lend requests so the clan feed is not empty.
    await req('POST', `/api/clans/${tag}/request`, {
      address: fakeAddress(`${spec.name}:1`), archetype: 2, note: 'need a ranged',
    });

    if (spec.requiredPower || spec.joinMode !== 'open') {
      await req('PATCH', `/api/clans/${tag}`, {
        address: leader, requiredPower: spec.requiredPower, joinMode: spec.joinMode,
      });
    }

    console.log(`${spec.name} — #${tag}, ${spec.members} members`);
  }

  const after = await req('GET', '/api/clans');
  console.log(`\n${after.data?.clans?.length ?? 0} clans in the ladder`);
}

main().catch((e) => { console.error(e); process.exit(1); });
