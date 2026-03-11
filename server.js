import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

const serviceAccount = JSON.parse(fs.readFileSync('./firebase.json', 'utf8'));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://drbots---live-default-rtdb.firebaseio.com',
});

const TESTING = process.env.TESTING === 'true';
const db = admin.database();
const app = express();
app.use(cors({
  origin: ['https://mushroomplanet.earth', 'http://localhost:8080'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: true,
}));
app.use(express.json());
app.use(express.static('public'));

// ----------------------------------------------------------------
// POST /api/send-code
// ----------------------------------------------------------------
app.post('/api/send-code', async (req, res) => {
  const discord = req.body.discord_id;
  if (!discord) return res.status(400).json({ success: false, message: 'Missing Discord ID' });

  try {
    const userSnap = await db.ref(`Pixie/Users/${discord}`).get();
    if (!userSnap.exists()) {
      return res.status(404).json({
        success: false,
        message: 'Discord ID not found. Make sure you have used the bot at least once.'
      });
    }

    const code = Math.floor(100000 + Math.random() * 900000);

    await db.ref(`Pixie/Users/${discord}/Security`).update({
      DM_Pending: !TESTING,
      DM_Sent: TESTING,
      Website_Link: false,
      VerifyCode: code,
    });

    console.log(`[SEND-CODE] Code ${code} ${TESTING ? '(TESTING - no DM)' : 'queued for DM'} to ${discord}`);
    res.json({ success: true, code: TESTING ? code : undefined });

  } catch (err) {
    console.error('[SEND-CODE] Error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ----------------------------------------------------------------
// POST /api/verify-code
// ----------------------------------------------------------------
app.post('/api/verify-code', async (req, res) => {
  const { discord_id, code } = req.body;
  if (!discord_id || !code) return res.status(400).json({ success: false, message: 'Missing fields' });

  try {
    const snap = await db.ref(`Pixie/Users/${discord_id}/Security/VerifyCode`).get();
    const expected = snap.val();

    if (expected == null) {
      return res.status(400).json({ success: false, message: 'No code found. Please request a new one.' });
    }

    if (String(expected) !== String(code)) {
      return res.status(400).json({ success: false, message: 'Invalid code. Please try again.' });
    }

    await db.ref(`Pixie/Users/${discord_id}/Security`).update({
      Website_Link: true,
      DM_Sent: false,
      DM_Pending: false,
      VerifyCode: null,
    });

    console.log(`[VERIFY] User ${discord_id} successfully verified`);
    res.json({ success: true });

  } catch (err) {
    console.error('[VERIFY] Error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ----------------------------------------------------------------
// GET /api/user/:id
// ----------------------------------------------------------------
app.get('/api/user/:id', async (req, res) => {
  const input = req.params.id;

  try {
    const [pixieSnap, sporebotSnap] = await Promise.all([
      db.ref(`Pixie/Users/${input}`).get(),
      db.ref(`Sporebot/Users/${input}`).get(),
    ]);

    if (pixieSnap.exists() || sporebotSnap.exists()) {
      return res.json({
        pixie: pixieSnap.exists() ? pixieSnap.val() : null,
        sporebot: sporebotSnap.exists() ? sporebotSnap.val() : null,
      });
    }

    const [allPixie, allSporebot] = await Promise.all([
      db.ref('Pixie/Users').get(),
      db.ref('Sporebot/Users').get(),
    ]);

    let matchedId = null;

    allPixie.forEach(child => {
      if (child.val()?.Misc?.username?.toLowerCase() === input.toLowerCase()) {
        matchedId = child.key;
      }
    });

    if (!matchedId) {
      allSporebot.forEach(child => {
        if (child.val()?.Misc?.username?.toLowerCase() === input.toLowerCase()) {
          matchedId = child.key;
        }
      });
    }

    if (!matchedId) return res.json({ pixie: null, sporebot: null });

    const [matchedPixie, matchedSporebot] = await Promise.all([
      db.ref(`Pixie/Users/${matchedId}`).get(),
      db.ref(`Sporebot/Users/${matchedId}`).get(),
    ]);

    return res.json({
      pixie: matchedPixie.exists() ? matchedPixie.val() : null,
      sporebot: matchedSporebot.exists() ? matchedSporebot.val() : null,
    });

  } catch (err) {
    console.error('[USER] Firebase lookup error:', err);
    res.status(500).json({ error: 'Failed to fetch user data' });
  }
});

// ----------------------------------------------------------------
// GET /api/leaderboard
// ----------------------------------------------------------------
app.get('/api/leaderboard', async (req, res) => {
  try {
    const sporebotSnap = await db.ref('Sporebot/Users').get();

    const farmers  = [];
    const foragers = [];
    const stakers  = [];
    let total_staked = 0, staker_count = 0, farm_count = 0;

    if (sporebotSnap.exists()) {
      sporebotSnap.forEach(child => {
        const data     = child.val();
        const username = data?.Misc?.username || child.key;
        const farm     = data?.Farm || {};
        const balance  = data?.Balance || {};
        const staking  = data?.Staking || {};

        const shroom_farm = balance.shroom_farm || 0;
        const streak      = farm.streak || 0;
        const staked      = staking.staked_spores || 0;
        const stage       = farm.current_stage;

        if (shroom_farm > 0) farmers.push({ id: child.key, username, value: shroom_farm });
        if (streak > 0) foragers.push({ id: child.key, username, value: streak });

        if (staked > 0) {
          stakers.push({ id: child.key, username, value: staked });
          total_staked += staked;
          staker_count++;
        }

        if (stage && stage !== 'Inactive') farm_count++;
      });
    }

    farmers.sort((a, b)  => b.value - a.value);
    foragers.sort((a, b) => b.value - a.value);
    stakers.sort((a, b)  => b.value - a.value);

    res.json({
      farmers:  farmers.slice(0, 10),
      foragers: foragers.slice(0, 10),
      stakers:  stakers.slice(0, 10),
      stats: { total_staked, staker_count, farm_count },
    });

  } catch (err) {
    console.error('[LEADERBOARD] Error:', err);
    res.status(500).json({ error: 'Failed to load leaderboard' });
  }
});

// ----------------------------------------------------------------
// GET /api/treasury-txs
// ----------------------------------------------------------------
// Fetches both tokens, groups by blockNumber (Gnosis Safe executes
// all legs of a multisig batch atomically in one block), detects
// which batch type it is, and returns clean events instead of raw rows.

const SHROOM_CONTRACT = '0x924B16Dfb993EEdEcc91c6D08b831e94135dEaE1';
const SPORE_CONTRACT  = '0x089582AC20ea563c69408a79E1061de594b61bED';
const TREASURY_ADDR   = '0x5873002348cd4DF2aBD2624a6FC30E90573019F5';

function inRange(value, target, tolerance) {
  return value >= target * (1 - tolerance) && value <= target * (1 + tolerance);
}

const BATCH_RULES = [
  {
    type: 'lp_rewards', label: 'Weekly LP Rewards', emoji: '💧', colorClass: 'lp',
    // Both tokens, ~35 txs each, SHROOM total ~3.5M, SPORE total ~500M (±30%)
    match(legs) {
      const s = legs.find(l => l.token === 'shroom');
      const p = legs.find(l => l.token === 'spore');
      if (!s || !p) return false;
      return s.txCount >= 20 && s.txCount <= 60
          && p.txCount >= 20 && p.txCount <= 60
          && inRange(s.total, 3_500_000,   0.30)
          && inRange(p.total, 500_000_000, 0.30);
    },
  },
  {
    type: 'kid_shroom', label: 'Kid Shroom Airdrop', emoji: '🍄', colorClass: 'airdrop',
    // Both tokens, ~340 txs each
    match(legs) {
      const s = legs.find(l => l.token === 'shroom');
      const p = legs.find(l => l.token === 'spore');
      if (!s || !p) return false;
      return s.txCount >= 200 && s.txCount <= 500
          && p.txCount >= 200 && p.txCount <= 500;
    },
  },
  {
    type: 'gold_mooshie', label: 'Gold Mooshie Airdrop', emoji: '🌟', colorClass: 'airdrop',
    // Both tokens, ~164 txs each
    match(legs) {
      const s = legs.find(l => l.token === 'shroom');
      const p = legs.find(l => l.token === 'spore');
      if (!s || !p) return false;
      return s.txCount >= 100 && s.txCount <= 200
          && p.txCount >= 100 && p.txCount <= 200;
    },
  },
  {
    type: 'onchain_airdrop', label: 'Onchain Airdrop', emoji: '🎁', colorClass: 'airdrop',
    // SPORE only, ~200 txs, ~200M total (±50%)
    match(legs) {
      const p = legs.find(l => l.token === 'spore');
      const s = legs.find(l => l.token === 'shroom');
      if (!p || s) return false;
      return p.txCount >= 100 && p.txCount <= 350
          && inRange(p.total, 200_000_000, 0.50);
    },
  },
  {
    type: 'transfer', label: 'Transfer', emoji: '➡️', colorClass: 'transfer',
    match: () => true, // catch-all
  },
];

async function fetchTokenTxs(contractAddress) {
  const url = `https://api.etherscan.io/v2/api?chainid=137`
    + `&module=account&action=tokentx`
    + `&contractaddress=${contractAddress}`
    + `&address=${TREASURY_ADDR}`
    + `&page=1&offset=10000&sort=desc`
    + `&apikey=${process.env.ETHERSCAN_API_KEY}`;
  const response = await fetch(url);
  const data = await response.json();
  if (data.status !== '1' || !Array.isArray(data.result)) return [];
  return data.result;
}

function groupIntoBatches(shroomRows, sporeRows) {
  const all = [
    ...shroomRows.map(r => ({ ...r, _token: 'shroom' })),
    ...sporeRows.map(r  => ({ ...r, _token: 'spore'  })),
  ];

  const byBlock = {};
  for (const tx of all) {
    if (!byBlock[tx.blockNumber]) byBlock[tx.blockNumber] = [];
    byBlock[tx.blockNumber].push(tx);
  }

  const batches = [];
  for (const rows of Object.values(byBlock)) {
    const legMap = {};
    for (const row of rows) {
      const t = row._token;
      if (!legMap[t]) legMap[t] = { token: t, txCount: 0, total: 0, recipients: new Set() };
      legMap[t].txCount++;
      legMap[t].total += parseFloat(row.value) / 1e18;
      legMap[t].recipients.add(row.to.toLowerCase());
    }
    const legs = Object.values(legMap).map(l => ({
      token: l.token, txCount: l.txCount, total: l.total,
      recipientCount: l.recipients.size,
    }));
    const rule = BATCH_RULES.find(r => r.match(legs));
    batches.push({
      type:       rule.type,
      label:      rule.label,
      emoji:      rule.emoji,
      colorClass: rule.colorClass,
      timestamp:  Math.max(...rows.map(r => parseInt(r.timeStamp))),
      sampleHash: rows[0].hash,
      legs,
      transfers: rows.map(r => ({
        hash:      r.hash,
        from:      r.from,
        to:        r.to,
        token:     r._token,
        amount:    parseFloat(r.value) / 1e18,
        timestamp: parseInt(r.timeStamp),
      })),
    });
  }
  return batches.sort((a, b) => b.timestamp - a.timestamp);
}

app.get('/api/treasury-txs', async (req, res) => {
  try {
    const [shroomRows, sporeRows] = await Promise.all([
      fetchTokenTxs(SHROOM_CONTRACT),
      fetchTokenTxs(SPORE_CONTRACT),
    ]);
    const batches = groupIntoBatches(shroomRows, sporeRows);
    res.json({ ok: true, batches });
  } catch (err) {
    console.error('[TREASURY-TXS] Error:', err);
    res.status(500).json({ ok: false, error: 'Failed to fetch transactions' });
  }
});

// ----------------------------------------------------------------
// Start server
// ----------------------------------------------------------------
const PORT = process.env.PORT || 3001;
console.log(`[CONFIG] TESTING=${TESTING}`);
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});