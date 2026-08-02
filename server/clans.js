/**
 * Clans.
 *
 * Clash Royale's clan loop, translated into Mempire's economy rather than copied
 * from it. Two deliberate substitutions:
 *
 *  - **Trophies → crowns.** Mempire already earns crowns per felled tower, so a
 *    clan's standing is the sum of its members' crowns. No parallel ladder.
 *  - **Card donations → lend requests.** Clash donates fungible cards. Mempire's
 *    cards are NFTs backed by staked tokens, so they cannot be duplicated on
 *    request. A lend request is a favour: a clanmate answers it, the answer is
 *    counted, and the lender earns gems. The card itself only ever changes hands
 *    onchain — this tracks the social contract, not custody of the asset, and the
 *    UI says so.
 *
 * Members are embedded in the clan document. Fifty members is nowhere near the
 * 16MB ceiling, it makes reading a clan one query, and it makes join/leave a
 * single atomic update so the member count can never drift from the roster.
 */

export const MEMBER_CAP = 50;
export const CLAN_CREATE_GEM_COST = 500;
const NAME_MAX = 22;
const DESC_MAX = 120;
const FEED_MAX = 60;

const ROLES = ['leader', 'coleader', 'elder', 'member'];
/** Rank order for sorting and for permission checks; lower is more senior. */
const RANK = Object.fromEntries(ROLES.map((r, i) => [r, i]));

export const REGIONS = [
  'Global', 'North America', 'South America', 'Europe', 'Asia', 'Africa', 'Oceania',
];

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TAG = /^[A-HJ-NP-Z2-9]{6}$/;

/** Ambiguous glyphs (0/O, 1/I/L) are excluded so a tag can be read aloud. */
const TAG_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomTag() {
  let out = '';
  for (let i = 0; i < 6; i += 1) {
    out += TAG_ALPHABET[Math.floor(Math.random() * TAG_ALPHABET.length)];
  }
  return out;
}

const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Crest as four small integers rather than an image.
 *
 * Composable crests are infinite, weigh nothing, need no upload path and no
 * moderation queue, and render crisply at any size — a generated bitmap per clan
 * would be worse on every one of those counts.
 */
function normaliseCrest(c) {
  const n = (v, mod) => {
    const i = Number.parseInt(v, 10);
    return Number.isFinite(i) && i >= 0 ? i % mod : 0;
  };
  return {
    shape: n(c?.shape, 6),
    emblem: n(c?.emblem, 12),
    hue: n(c?.hue, 360),
    tone: n(c?.tone, 3),
  };
}

const publicMember = (m) => ({
  address: m.address,
  name: m.name ?? null,
  role: m.role,
  crowns: m.crowns ?? 0,
  lent: m.lent ?? 0,
  received: m.received ?? 0,
  power: m.power ?? 0,
  joinedAt: m.joinedAt,
  lastSeenAt: m.lastSeenAt ?? m.joinedAt,
});

/** Members ranked by crowns — the order the roster is displayed in. */
const rankMembers = (members) => [...(members ?? [])]
  .sort((a, b) => (b.crowns ?? 0) - (a.crowns ?? 0) || RANK[a.role] - RANK[b.role])
  .map(publicMember);

/** List/search shape — deliberately smaller than the detail shape. */
const clanSummary = (c) => ({
  tag: c._id,
  name: c.name,
  description: c.description,
  crest: c.crest,
  region: c.region,
  requiredPower: c.requiredPower ?? 0,
  joinMode: c.joinMode ?? 'open',
  memberCount: c.members?.length ?? 0,
  memberCap: MEMBER_CAP,
  crowns: c.crowns ?? 0,
  weeklyLent: c.weeklyLent ?? 0,
  createdAt: c.createdAt,
});

const clanDetail = (c) => ({
  ...clanSummary(c),
  members: rankMembers(c.members),
  feed: (c.feed ?? []).slice(0, FEED_MAX),
  treasurySol: c.treasurySol ?? 0,
});

function feedEntry(kind, address, extra = {}) {
  return { kind, address, at: new Date(), ...extra };
}

/**
 * Registers every clan route.
 *
 * Auth is by wallet address in the body, which is the same trust model the rest
 * of this service already uses: the client owns game logic, this stores results,
 * and nothing here can move funds. Anything that touches money stays onchain.
 * A signature check is the obvious next hardening step and is noted in ROADMAP.
 */
export function registerClanRoutes(app, db) {
  const clans = db.collection('clans');

  const ready = (async () => {
    // Unique on name so two clans cannot share one; case-insensitive via collation.
    await clans.createIndex({ name: 1 }, {
      unique: true, collation: { locale: 'en', strength: 2 },
    });
    // "which clan is this wallet in" — multikey over the embedded roster
    await clans.createIndex({ 'members.address': 1 });
    await clans.createIndex({ crowns: -1 });
    await clans.createIndex({ region: 1, crowns: -1 });
  })();

  const badAddress = (a) => !a || !ADDRESS.test(a);

  const fail = (res, code, error) => res.status(code).json({ error });

  /** The clan this wallet belongs to, or null. */
  async function clanOf(address) {
    return clans.findOne({ 'members.address': address });
  }

  function memberIn(clan, address) {
    return (clan.members ?? []).find((m) => m.address === address) ?? null;
  }

  // ── search / list ────────────────────────────────────────────────────────
  // Matches the "Search or create a new clan" sheet: free-text over name and
  // tag, plus the filters that sheet exposes.
  app.get('/api/clans', async (req, res) => {
    await ready;
    const { q, region, maxRequiredPower, openOnly, hasRoom } = req.query;
    const filter = {};

    const term = clean(q, 24);
    if (term) {
      // A tag is exact; a name is a prefix-ish contains. Escape the term so a
      // stray ( or * from a player cannot break the query.
      const safe = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { _id: term.toUpperCase() },
        { name: { $regex: safe, $options: 'i' } },
      ];
    }
    if (region && region !== 'Global' && REGIONS.includes(region)) filter.region = region;
    if (maxRequiredPower) {
      const p = Number(maxRequiredPower);
      if (Number.isFinite(p)) filter.requiredPower = { $lte: p };
    }
    if (openOnly === 'true') filter.joinMode = 'open';

    try {
      const rows = await clans.find(filter).sort({ crowns: -1 }).limit(40).toArray();
      let out = rows.map(clanSummary);
      // Post-filter: memberCount is derived, so it cannot be a query predicate
      // without denormalising a field that could then disagree with the roster.
      if (hasRoom === 'true') out = out.filter((c) => c.memberCount < c.memberCap);
      res.json({ clans: out });
    } catch (e) {
      fail(res, 500, e.message);
    }
  });

  // ── my clan ──────────────────────────────────────────────────────────────
  app.get('/api/clans/mine/:address', async (req, res) => {
    await ready;
    const { address } = req.params;
    if (badAddress(address)) return fail(res, 400, 'bad address');
    try {
      const clan = await clanOf(address);
      res.json(clan ? clanDetail(clan) : null);
    } catch (e) {
      fail(res, 500, e.message);
    }
  });

  // ── detail ───────────────────────────────────────────────────────────────
  app.get('/api/clans/:tag', async (req, res) => {
    await ready;
    const tag = String(req.params.tag).toUpperCase();
    if (!TAG.test(tag)) return fail(res, 400, 'bad clan tag');
    try {
      const clan = await clans.findOne({ _id: tag });
      if (!clan) return fail(res, 404, 'clan not found');
      res.json(clanDetail(clan));
    } catch (e) {
      fail(res, 500, e.message);
    }
  });

  // ── create ───────────────────────────────────────────────────────────────
  app.post('/api/clans', async (req, res) => {
    await ready;
    const {
      address, name, description, region, crest, requiredPower, joinMode, memberName, power,
    } = req.body ?? {};
    if (badAddress(address)) return fail(res, 400, 'bad address');

    const cleanName = clean(name, NAME_MAX);
    if (cleanName.length < 3) return fail(res, 400, 'name must be at least 3 characters');

    try {
      // One clan per wallet. Checked before insert so the error is the useful
      // one ("already in a clan") rather than a duplicate-key surprise.
      if (await clanOf(address)) return fail(res, 409, 'you are already in a clan');

      const now = new Date();
      const doc = {
        name: cleanName,
        description: clean(description, DESC_MAX) || 'a new empire rises',
        region: REGIONS.includes(region) ? region : 'Global',
        crest: normaliseCrest(crest),
        requiredPower: Math.max(0, Math.min(9999, Number(requiredPower) || 0)),
        joinMode: ['open', 'request', 'closed'].includes(joinMode) ? joinMode : 'open',
        crowns: 0,
        weeklyLent: 0,
        treasurySol: 0,
        createdBy: address,
        createdAt: now,
        updatedAt: now,
        members: [{
          address,
          name: clean(memberName, 20) || null,
          role: 'leader',
          crowns: 0,
          lent: 0,
          received: 0,
          power: Number(power) || 0,
          joinedAt: now,
          lastSeenAt: now,
        }],
        feed: [feedEntry('founded', address, { name: cleanName })],
      };

      // Tag collisions are possible but rare; retry a few times rather than
      // failing the request.
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const tag = randomTag();
        try {
          await clans.insertOne({ _id: tag, ...doc });
          return res.status(201).json(clanDetail({ _id: tag, ...doc }));
        } catch (e) {
          if (e?.code !== 11000) throw e;
          // Duplicate name is a user error and will never resolve by retrying.
          if (String(e.message).includes('name')) return fail(res, 409, 'that name is taken');
        }
      }
      return fail(res, 500, 'could not allocate a clan tag');
    } catch (e) {
      return fail(res, 500, e.message);
    }
  });

  // ── join ─────────────────────────────────────────────────────────────────
  app.post('/api/clans/:tag/join', async (req, res) => {
    await ready;
    const tag = String(req.params.tag).toUpperCase();
    const { address, memberName, power } = req.body ?? {};
    if (!TAG.test(tag)) return fail(res, 400, 'bad clan tag');
    if (badAddress(address)) return fail(res, 400, 'bad address');

    try {
      if (await clanOf(address)) return fail(res, 409, 'leave your current clan first');
      const clan = await clans.findOne({ _id: tag });
      if (!clan) return fail(res, 404, 'clan not found');
      if (clan.joinMode === 'closed') return fail(res, 403, 'this clan is closed');
      if ((clan.members?.length ?? 0) >= MEMBER_CAP) return fail(res, 409, 'clan is full');

      const deckPower = Number(power) || 0;
      if (deckPower < (clan.requiredPower ?? 0)) {
        return fail(res, 403, `needs ${clan.requiredPower} deck power — yours is ${deckPower}`);
      }

      const now = new Date();
      const member = {
        address,
        name: clean(memberName, 20) || null,
        role: 'member',
        crowns: 0,
        lent: 0,
        received: 0,
        power: deckPower,
        joinedAt: now,
        lastSeenAt: now,
      };

      // The size guard is inside the filter, not just the check above, so two
      // simultaneous joins into slot 50 cannot both succeed.
      const result = await clans.findOneAndUpdate(
        { _id: tag, [`members.${MEMBER_CAP - 1}`]: { $exists: false }, 'members.address': { $ne: address } },
        {
          $push: {
            members: member,
            feed: { $each: [feedEntry('joined', address)], $position: 0, $slice: FEED_MAX },
          },
          $set: { updatedAt: now },
        },
        { returnDocument: 'after' },
      );
      if (!result) return fail(res, 409, 'clan filled up — try another');
      res.json(clanDetail(result));
    } catch (e) {
      fail(res, 500, e.message);
    }
  });

  // ── leave ────────────────────────────────────────────────────────────────
  app.post('/api/clans/:tag/leave', async (req, res) => {
    await ready;
    const tag = String(req.params.tag).toUpperCase();
    const { address } = req.body ?? {};
    if (!TAG.test(tag)) return fail(res, 400, 'bad clan tag');
    if (badAddress(address)) return fail(res, 400, 'bad address');

    try {
      const clan = await clans.findOne({ _id: tag });
      if (!clan) return fail(res, 404, 'clan not found');
      const me = memberIn(clan, address);
      if (!me) return fail(res, 403, 'you are not in this clan');

      const others = (clan.members ?? []).filter((m) => m.address !== address);

      // A leader leaving must not orphan the clan. Empty → delete it; otherwise
      // the most senior remaining member is promoted, so there is always a leader.
      if (!others.length) {
        await clans.deleteOne({ _id: tag });
        return res.json({ ok: true, disbanded: true });
      }

      const now = new Date();
      const update = {
        $pull: { members: { address } },
        $set: { updatedAt: now },
        $push: { feed: { $each: [feedEntry('left', address)], $position: 0, $slice: FEED_MAX } },
      };
      await clans.updateOne({ _id: tag }, update);

      if (me.role === 'leader') {
        const heir = rankMembers(others)[0];
        await clans.updateOne(
          { _id: tag, 'members.address': heir.address },
          {
            $set: { 'members.$.role': 'leader' },
            $push: {
              feed: {
                $each: [feedEntry('promoted', heir.address, { role: 'leader', by: address })],
                $position: 0,
                $slice: FEED_MAX,
              },
            },
          },
        );
      }
      res.json({ ok: true, disbanded: false });
    } catch (e) {
      fail(res, 500, e.message);
    }
  });

  // ── settings (leader / co-leader) ────────────────────────────────────────
  app.patch('/api/clans/:tag', async (req, res) => {
    await ready;
    const tag = String(req.params.tag).toUpperCase();
    const { address, description, region, requiredPower, joinMode, crest } = req.body ?? {};
    if (!TAG.test(tag)) return fail(res, 400, 'bad clan tag');
    if (badAddress(address)) return fail(res, 400, 'bad address');

    try {
      const clan = await clans.findOne({ _id: tag });
      if (!clan) return fail(res, 404, 'clan not found');
      const me = memberIn(clan, address);
      if (!me || RANK[me.role] > RANK.coleader) return fail(res, 403, 'leaders only');

      const $set = { updatedAt: new Date() };
      if (description !== undefined) $set.description = clean(description, DESC_MAX);
      if (region !== undefined && REGIONS.includes(region)) $set.region = region;
      if (requiredPower !== undefined) {
        $set.requiredPower = Math.max(0, Math.min(9999, Number(requiredPower) || 0));
      }
      if (joinMode !== undefined && ['open', 'request', 'closed'].includes(joinMode)) {
        $set.joinMode = joinMode;
      }
      if (crest !== undefined) $set.crest = normaliseCrest(crest);

      const updated = await clans.findOneAndUpdate({ _id: tag }, { $set }, { returnDocument: 'after' });
      res.json(clanDetail(updated));
    } catch (e) {
      fail(res, 500, e.message);
    }
  });

  // ── promote / demote / kick ──────────────────────────────────────────────
  app.post('/api/clans/:tag/role', async (req, res) => {
    await ready;
    const tag = String(req.params.tag).toUpperCase();
    const { address, target, role } = req.body ?? {};
    if (!TAG.test(tag)) return fail(res, 400, 'bad clan tag');
    if (badAddress(address) || badAddress(target)) return fail(res, 400, 'bad address');
    if (!ROLES.includes(role)) return fail(res, 400, 'bad role');

    try {
      const clan = await clans.findOne({ _id: tag });
      if (!clan) return fail(res, 404, 'clan not found');
      const me = memberIn(clan, address);
      const them = memberIn(clan, target);
      if (!me || !them) return fail(res, 403, 'not in this clan');
      if (RANK[me.role] > RANK.coleader) return fail(res, 403, 'leaders only');
      // You may not act on a peer or a senior, and may not mint a second leader.
      if (RANK[them.role] <= RANK[me.role] && address !== target) {
        return fail(res, 403, 'you cannot change someone at or above your rank');
      }
      if (role === 'leader') return fail(res, 400, 'transfer leadership is not supported yet');

      const now = new Date();
      await clans.updateOne(
        { _id: tag, 'members.address': target },
        {
          $set: { 'members.$.role': role, updatedAt: now },
          $push: {
            feed: {
              $each: [feedEntry('promoted', target, { role, by: address })],
              $position: 0,
              $slice: FEED_MAX,
            },
          },
        },
      );
      const after = await clans.findOne({ _id: tag });
      res.json(clanDetail(after));
    } catch (e) {
      fail(res, 500, e.message);
    }
  });

  app.post('/api/clans/:tag/kick', async (req, res) => {
    await ready;
    const tag = String(req.params.tag).toUpperCase();
    const { address, target } = req.body ?? {};
    if (!TAG.test(tag)) return fail(res, 400, 'bad clan tag');
    if (badAddress(address) || badAddress(target)) return fail(res, 400, 'bad address');
    if (address === target) return fail(res, 400, 'use leave instead');

    try {
      const clan = await clans.findOne({ _id: tag });
      if (!clan) return fail(res, 404, 'clan not found');
      const me = memberIn(clan, address);
      const them = memberIn(clan, target);
      if (!me || !them) return fail(res, 403, 'not in this clan');
      if (RANK[me.role] > RANK.elder) return fail(res, 403, 'elders and above only');
      if (RANK[them.role] <= RANK[me.role]) {
        return fail(res, 403, 'you cannot kick someone at or above your rank');
      }

      await clans.updateOne({ _id: tag }, {
        $pull: { members: { address: target } },
        $set: { updatedAt: new Date() },
        $push: {
          feed: {
            $each: [feedEntry('kicked', target, { by: address })],
            $position: 0,
            $slice: FEED_MAX,
          },
        },
      });
      const after = await clans.findOne({ _id: tag });
      res.json(clanDetail(after));
    } catch (e) {
      fail(res, 500, e.message);
    }
  });

  // ── lend requests ────────────────────────────────────────────────────────
  // The clan's social loop. A request names an archetype rather than a specific
  // card, because what a deck is missing is a role, not a coin.
  app.post('/api/clans/:tag/request', async (req, res) => {
    await ready;
    const tag = String(req.params.tag).toUpperCase();
    const { address, archetype, note } = req.body ?? {};
    if (!TAG.test(tag)) return fail(res, 400, 'bad clan tag');
    if (badAddress(address)) return fail(res, 400, 'bad address');
    const arch = Number(archetype);
    if (!Number.isInteger(arch) || arch < 0 || arch > 5) return fail(res, 400, 'bad archetype');

    try {
      const clan = await clans.findOne({ _id: tag });
      if (!clan) return fail(res, 404, 'clan not found');
      if (!memberIn(clan, address)) return fail(res, 403, 'you are not in this clan');

      // One open request at a time, so the feed cannot be flooded.
      const open = (clan.feed ?? []).find(
        (f) => f.kind === 'request' && f.address === address && !f.filledBy,
      );
      if (open) return fail(res, 409, 'you already have an open request');

      const entry = feedEntry('request', address, {
        id: `${address}_${Date.now()}`,
        archetype: arch,
        note: clean(note, 60) || null,
        filledBy: null,
      });
      const updated = await clans.findOneAndUpdate(
        { _id: tag },
        {
          $push: { feed: { $each: [entry], $position: 0, $slice: FEED_MAX } },
          $set: { updatedAt: new Date() },
        },
        { returnDocument: 'after' },
      );
      res.json(clanDetail(updated));
    } catch (e) {
      fail(res, 500, e.message);
    }
  });

  /** Answer someone's request. The lender's count goes up; so does the clan's. */
  app.post('/api/clans/:tag/lend', async (req, res) => {
    await ready;
    const tag = String(req.params.tag).toUpperCase();
    const { address, requestId } = req.body ?? {};
    if (!TAG.test(tag)) return fail(res, 400, 'bad clan tag');
    if (badAddress(address)) return fail(res, 400, 'bad address');

    try {
      const clan = await clans.findOne({ _id: tag });
      if (!clan) return fail(res, 404, 'clan not found');
      if (!memberIn(clan, address)) return fail(res, 403, 'you are not in this clan');

      const entry = (clan.feed ?? []).find((f) => f.kind === 'request' && f.id === requestId);
      if (!entry) return fail(res, 404, 'request not found');
      if (entry.filledBy) return fail(res, 409, 'already answered');
      if (entry.address === address) return fail(res, 400, 'you cannot answer your own request');

      const now = new Date();
      // Two positional updates in one statement would need arrayFilters on both
      // arrays; three targeted updates are clearer and each is idempotent-safe.
      await clans.updateOne(
        { _id: tag, 'feed.id': requestId },
        { $set: { 'feed.$.filledBy': address, 'feed.$.filledAt': now, updatedAt: now } },
      );
      await clans.updateOne(
        { _id: tag, 'members.address': address },
        { $inc: { 'members.$.lent': 1, weeklyLent: 1 } },
      );
      await clans.updateOne(
        { _id: tag, 'members.address': entry.address },
        { $inc: { 'members.$.received': 1 } },
      );

      const after = await clans.findOne({ _id: tag });
      res.json({ ...clanDetail(after), reward: { gems: 5 } });
    } catch (e) {
      fail(res, 500, e.message);
    }
  });

  // ── crown contribution ───────────────────────────────────────────────────
  /**
   * Called when a member settles a win. Crowns roll up to the clan, which is
   * what the clan leaderboard ranks on.
   */
  app.post('/api/clans/:tag/crowns', async (req, res) => {
    await ready;
    const tag = String(req.params.tag).toUpperCase();
    const { address, crowns, power } = req.body ?? {};
    if (!TAG.test(tag)) return fail(res, 400, 'bad clan tag');
    if (badAddress(address)) return fail(res, 400, 'bad address');
    const n = Math.max(0, Math.min(3, Number(crowns) || 0));

    try {
      const now = new Date();
      const set = { 'members.$.lastSeenAt': now, updatedAt: now };
      if (power !== undefined) set['members.$.power'] = Number(power) || 0;
      const r = await clans.updateOne(
        { _id: tag, 'members.address': address },
        { $inc: { 'members.$.crowns': n, crowns: n }, $set: set },
      );
      if (!r.matchedCount) return fail(res, 403, 'you are not in this clan');
      res.json({ ok: true, added: n });
    } catch (e) {
      fail(res, 500, e.message);
    }
  });

  // ── clan leaderboard ─────────────────────────────────────────────────────
  app.get('/api/clans-top', async (req, res) => {
    await ready;
    const region = req.query.region;
    const filter = region && region !== 'Global' && REGIONS.includes(region) ? { region } : {};
    try {
      const rows = await clans.find(filter).sort({ crowns: -1 }).limit(25).toArray();
      res.json({ clans: rows.map(clanSummary) });
    } catch (e) {
      fail(res, 500, e.message);
    }
  });
}
