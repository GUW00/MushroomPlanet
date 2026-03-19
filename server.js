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
  origin: ['https://mushroomplanet.earth', 'http://localhost:8080', 'http://localhost:5500'],
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
// GET /api/treasury-holdings
// ----------------------------------------------------------------
const TREASURY_HOLDINGS_ADDR = '0x5873002348cd4DF2aBD2624a6FC30E90573019F5';
const SPOREBOT_WALLET_ADDR   = '0xa00C9a4c1F40cdB30105E1402dD4c0ac7048863A';
const LP_POOL_WETH_SHROOM    = '0x28def03d8dc0d186fabae9c46043e8ef9bffcc28';
const LP_POOL_SPR_SHROOM     = '0xc373382eec590374278534494109a0cdae1fbbc8';
const LP_POOL_SPR_WETH       = '0x2a91571238303c6700a9336342c754e159243168';
const HOLDINGS_TOKENS_LIST = [
  { symbol: '$HROOM', contract: '0x924B16Dfb993EEdEcc91c6D08b831e94135dEaE1', decimals: 18 },
  { symbol: 'SPORE',  contract: '0x089582AC20ea563c69408a79E1061de594b61bED', decimals: 18 },
  { symbol: 'WETH',   contract: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', decimals: 18 },
  { symbol: 'WBTC',   contract: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', decimals: 8  },
];

app.get('/api/treasury-holdings', async (req, res) => {
  try {
    const rpcUrl = process.env.ALCHEMY_POLYGON_URL;
    const balanceData = '0x70a08231' + TREASURY_HOLDINGS_ADDR.slice(2).padStart(64, '0');

    const tokenResults = await Promise.all(HOLDINGS_TOKENS_LIST.map(async t => {
      const body = JSON.stringify({
        jsonrpc: '2.0', method: 'eth_call',
        params: [{ to: t.contract, data: balanceData }, 'latest'], id: 1,
      });
      const r = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      const j = await r.json();
      const raw = parseInt(j.result, 16);
      return { symbol: t.symbol, balance: raw / Math.pow(10, t.decimals) };
    }));

    // Native POL balance
    const polBody = JSON.stringify({
      jsonrpc: '2.0', method: 'eth_getBalance',
      params: [TREASURY_HOLDINGS_ADDR, 'latest'], id: 1,
    });
    const polR = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: polBody });
    const polJ = await polR.json();
    const polBal = parseInt(polJ.result, 16) / 1e18;

    res.json({ ok: true, balances: [...tokenResults, { symbol: 'POL', balance: polBal }] });
  } catch (err) {
    console.error('[TREASURY-HOLDINGS] Error:', err);
    res.status(500).json({ ok: false, error: 'Failed to fetch holdings' });
  }
});

// ----------------------------------------------------------------
// GET /api/lp-holdings
// ----------------------------------------------------------------
const LP_ERC20_ABI_FRAG = [
  { name: 'getReserves', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: 'reserve0', type: 'uint112' }, { name: 'reserve1', type: 'uint112' }, { name: 'blockTimestampLast', type: 'uint32' }] },
  { name: 'token0', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { name: 'token1', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { name: 'totalSupply', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
];

const LP_TOKEN_DECIMALS = {
  '0x924b16dfb993eedecc91c6d08b831e94135deae1': { symbol: 'SHROOM', decimals: 18 },
  '0x089582ac20ea563c69408a79e1061de594b61bed': { symbol: 'SPORE',  decimals: 18 },
  '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619': { symbol: 'WETH',   decimals: 18 },
};

async function getRpcCall(rpcUrl, method, params) {
  const r = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  const j = await r.json();
  if (j.result === undefined) {
    console.error('[RPC] undefined result:', JSON.stringify(j), 'params:', JSON.stringify(params));
  }
  return j.result;
}

async function getLPInfo(rpcUrl, poolAddr, holderAddr) {
  const encode32 = (addr) => addr.replace('0x', '').toLowerCase().padStart(64, '0');

  // token0, token1, totalSupply, reserves, holder balance — parallel
  const [t0res, t1res, tsRes, rvRes, balRes] = await Promise.all([
    getRpcCall(rpcUrl, 'eth_call', [{ to: poolAddr, data: '0x0dfe1681' }, 'latest']), // token0
    getRpcCall(rpcUrl, 'eth_call', [{ to: poolAddr, data: '0xd21220a7' }, 'latest']), // token1
    getRpcCall(rpcUrl, 'eth_call', [{ to: poolAddr, data: '0x18160ddd' }, 'latest']), // totalSupply
    getRpcCall(rpcUrl, 'eth_call', [{ to: poolAddr, data: '0x0902f1ac' }, 'latest']), // getReserves
    getRpcCall(rpcUrl, 'eth_call', [{ to: poolAddr, data: '0x70a08231' + encode32(holderAddr) }, 'latest']), // balanceOf
  ]);

  const token0 = '0x' + t0res.slice(26).toLowerCase();
  const token1 = '0x' + t1res.slice(26).toLowerCase();
  const totalSupply = BigInt(tsRes);
  const holderBal   = BigInt(balRes);

  // getReserves returns packed: reserve0 (112bit), reserve1 (112bit), timestamp (32bit)
  const reserveHex = rvRes.slice(2);
  const reserve0 = BigInt('0x' + reserveHex.slice(0, 64));
  const reserve1 = BigInt('0x' + reserveHex.slice(64, 128));

  if (totalSupply === 0n) return null;
  const share = Number(holderBal) / Number(totalSupply);

  const meta0 = LP_TOKEN_DECIMALS[token0] || { symbol: token0.slice(0,8), decimals: 18 };
  const meta1 = LP_TOKEN_DECIMALS[token1] || { symbol: token1.slice(0,8), decimals: 18 };

  return {
    pool: poolAddr,
    share: share,
    lpBalance: Number(holderBal) / 1e18,
    token0: { symbol: meta0.symbol, balance: Number(reserve0) / Math.pow(10, meta0.decimals) * share },
    token1: { symbol: meta1.symbol, balance: Number(reserve1) / Math.pow(10, meta1.decimals) * share },
  };
}

app.get('/api/lp-holdings', async (req, res) => {
  const rpcUrl = process.env.ALCHEMY_POLYGON_URL;
  try {
    const [wethShroom, sprShroom, sprWeth, sporebotBal, sporebotSpore] = await Promise.all([
      getLPInfo(rpcUrl, LP_POOL_WETH_SHROOM, TREASURY_HOLDINGS_ADDR),
      getLPInfo(rpcUrl, LP_POOL_SPR_SHROOM,  TREASURY_HOLDINGS_ADDR),
      getLPInfo(rpcUrl, LP_POOL_SPR_WETH,    TREASURY_HOLDINGS_ADDR),
      getRpcCall(rpcUrl, 'eth_call', [{
        to: '0x924B16Dfb993EEdEcc91c6D08b831e94135dEaE1',
        data: '0x70a08231' + SPOREBOT_WALLET_ADDR.replace('0x', '').toLowerCase().padStart(64,'0'),
      }, 'latest']),
      getRpcCall(rpcUrl, 'eth_call', [{
        to: '0x089582AC20ea563c69408a79E1061de594b61bED',
        data: '0x70a08231' + SPOREBOT_WALLET_ADDR.replace('0x', '').toLowerCase().padStart(64,'0'),
      }, 'latest']),
    ]);
    res.json({
      ok: true,
      lp_weth_shroom: wethShroom,
      lp_spr_shroom: sprShroom,
      lp_spr_weth: sprWeth,
      sporebot_shroom: parseInt(sporebotBal, 16) / 1e18,
      sporebot_spore: parseInt(sporebotSpore, 16) / 1e18,
    });
  } catch (err) {
    console.error('[LP-HOLDINGS] Error:', err);
    res.status(500).json({ ok: false, error: 'Failed to fetch LP holdings' });
  }
});

// ----------------------------------------------------------------
// GET /api/treasury-txs
// ----------------------------------------------------------------

const SHROOM_CONTRACT = '0x924B16Dfb993EEdEcc91c6D08b831e94135dEaE1';
const SPORE_CONTRACT  = '0x089582AC20ea563c69408a79E1061de594b61bED';
const WETH_CONTRACT   = '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619';
const TREASURY_ADDR   = '0x5873002348cd4DF2aBD2624a6FC30E90573019F5';

function inRange(value, target, tolerance) {
  return value >= target * (1 - tolerance) && value <= target * (1 + tolerance);
}

function recipientOverlap(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let shared = 0;
  for (const addr of setA) if (setB.has(addr)) shared++;
  return shared / Math.min(setA.size, setB.size);
}

function classifyEvent(legs, isIncoming) {
  if (isIncoming) {
    return { type: 'transfer', label: 'Deposit', emoji: '⬇️', colorClass: 'transfer' };
  }

  const s = legs.find(l => l.token === 'shroom');
  const p = legs.find(l => l.token === 'spore');

  // Weekly LP Rewards: always exactly 3,500,000 SHROOM + 500,000,000 SPORE
  if (s && p &&
      inRange(s.total, 3_500_000,   0.01) &&
      inRange(p.total, 500_000_000, 0.01)) {
    return { type: 'lp_rewards', label: 'Weekly LP Rewards', emoji: '💧', colorClass: 'lp' };
  }

  // Onchain Airdrop: SPORE only, ~200M total (relaxed tx count)
  if (p && !s && inRange(p.total, 200_000_000, 0.01)) {
    return { type: 'onchain_airdrop', label: 'Onchain Airdrop', emoji: '🎁', colorClass: 'airdrop' };
  }

  // Kid Shroom vs Gold Mooshie by per-recipient amounts
  if (s && p) {
    const shroomPer = s.total / s.recipientCount;
    const sporePer  = p.total / p.recipientCount;
    // Gold Mooshie: ~28,500 SHROOM + ~3,800,000 SPORE per NFT (163 holders)
    if (inRange(shroomPer, 28_500, 0.30) && inRange(sporePer, 3_800_000, 0.30)) {
      return { type: 'gold_mooshie', label: 'Gold Mooshie Airdrop', emoji: '🌟', colorClass: 'airdrop' };
    }
    // Kid Shroom: ~29,300 SHROOM + ~2,200,000 SPORE per NFT (337 holders)
    if (inRange(shroomPer, 29_300, 0.30) && inRange(sporePer, 2_200_000, 0.30)) {
      return { type: 'kid_shroom', label: 'Kid Shroom Airdrop', emoji: '🍄', colorClass: 'airdrop' };
    }
    // Kid Shroom legacy: ~20k SHROOM + ~1.5M SPORE
    if (inRange(shroomPer, 20_000, 0.40) && inRange(sporePer, 1_500_000, 0.40)) {
      return { type: 'kid_shroom', label: 'Kid Shroom Airdrop', emoji: '🍄', colorClass: 'airdrop' };
    }
  }

  // Single-token Gold Mooshie half (only SHROOM or only SPORE leg)
  if (s && !p) {
    const shroomPer = s.total / s.recipientCount;
    if (inRange(shroomPer, 28_000, 0.45) || inRange(shroomPer, 15_000, 0.45)) {
      return { type: 'gold_mooshie', label: 'Gold Mooshie Airdrop', emoji: '🌟', colorClass: 'airdrop' };
    }
  }
  if (p && !s) {
    const sporePer = p.total / p.recipientCount;
    if (inRange(sporePer, 3_800_000, 0.45) || inRange(sporePer, 2_000_000, 0.45)) {
      return { type: 'gold_mooshie', label: 'Gold Mooshie Airdrop', emoji: '🌟', colorClass: 'airdrop' };
    }
  }

  const anyLeg = s || p;
  if (anyLeg && anyLeg.txCount >= 50) {
    return { type: 'airdrop', label: 'Airdrop', emoji: '🎁', colorClass: 'airdrop' };
  }

  return { type: 'transfer', label: 'Transfer', emoji: '➡️', colorClass: 'transfer' };
}

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

function groupIntoBatches(shroomRows, sporeRows, wethRows = []) {
  const shroomByBlock = {};
  const sporeByBlock  = {};
  const wethByBlock   = {};

  for (const r of shroomRows) {
    if (!shroomByBlock[r.blockNumber]) shroomByBlock[r.blockNumber] = [];
    shroomByBlock[r.blockNumber].push(r);
  }
  for (const r of sporeRows) {
    if (!sporeByBlock[r.blockNumber]) sporeByBlock[r.blockNumber] = [];
    sporeByBlock[r.blockNumber].push(r);
  }
  for (const r of wethRows) {
    if (!wethByBlock[r.blockNumber]) wethByBlock[r.blockNumber] = [];
    wethByBlock[r.blockNumber].push(r);
  }

  function summariseBlock(rows, token) {
    const recipients = new Set(rows.map(r => r.to.toLowerCase()));
    const total      = rows.reduce((s, r) => s + parseFloat(r.value) / 1e18, 0);
    const timestamp  = Math.max(...rows.map(r => parseInt(r.timeStamp)));
    const isOut      = rows[0].from.toLowerCase() === TREASURY_ADDR.toLowerCase();
    return {
      token, rows, recipients, total,
      txCount: rows.length, recipientCount: recipients.size,
      timestamp, isOut,
      blockNumber: rows[0].blockNumber,
      sampleHash: rows[0].hash,
    };
  }

  const shroomBlocks = Object.entries(shroomByBlock).map(([, rows]) => summariseBlock(rows, 'shroom'));
  const sporeBlocks  = Object.entries(sporeByBlock).map(([, rows])  => summariseBlock(rows, 'spore'));

  const AIRDROP_MIN    = 50;
  const TIME_WINDOW    = 30 * 60;
  const OVERLAP_THRESH = 0.50;

  const usedShroomBlocks = new Set();
  const usedSporeBlocks  = new Set();
  const events           = [];

  // Pre-pass: pair LP Rewards by amount match (3.5M SHROOM + 500M SPORE) regardless of tx count
  for (const sb of shroomBlocks) {
    if (!sb.isOut || !inRange(sb.total, 3_500_000, 0.01) || sb.recipientCount > 50) continue;
    let bestMatch = null, bestDelta = Infinity;
    for (const pb of sporeBlocks) {
      if (usedSporeBlocks.has(pb.blockNumber)) continue;
      if (!pb.isOut) continue;
      if (!inRange(pb.total, 500_000_000, 0.01)) continue;
      // LP Rewards go to <=50 recipients (small set), reject large airdrop blocks
      if (pb.recipientCount > 50) continue;
      const delta = Math.abs(sb.timestamp - pb.timestamp);
      if (delta < TIME_WINDOW && delta < bestDelta) { bestDelta = delta; bestMatch = pb; }
    }
    if (bestMatch) {
      usedShroomBlocks.add(sb.blockNumber);
      usedSporeBlocks.add(bestMatch.blockNumber);
      const legs = [
        { token: 'shroom', txCount: sb.txCount,        total: sb.total,        recipientCount: sb.recipientCount },
        { token: 'spore',  txCount: bestMatch.txCount, total: bestMatch.total, recipientCount: bestMatch.recipientCount },
      ];
      events.push({
        type: 'lp_rewards', label: 'Weekly LP Rewards', emoji: '💧', colorClass: 'lp',
        timestamp:  Math.max(sb.timestamp, bestMatch.timestamp),
        sampleHash: sb.sampleHash,
        legs,
        transfers: [
          ...sb.rows.map(r => ({ hash: r.hash, from: r.from, to: r.to, token: 'shroom', amount: parseFloat(r.value)/1e18, timestamp: parseInt(r.timeStamp) })),
          ...bestMatch.rows.map(r => ({ hash: r.hash, from: r.from, to: r.to, token: 'spore', amount: parseFloat(r.value)/1e18, timestamp: parseInt(r.timeStamp) })),
        ],
      });
    }
  }

  // Pair large SHROOM blocks with matching SPORE blocks (airdrop overlap pass)
  for (const sb of shroomBlocks) {
    if (!sb.isOut || sb.txCount < AIRDROP_MIN) continue;
    if (usedShroomBlocks.has(sb.blockNumber)) continue;

    let bestMatch = null, bestOverlap = 0;
    for (const pb of sporeBlocks) {
      if (usedSporeBlocks.has(pb.blockNumber)) continue;
      if (!pb.isOut) continue;
      if (Math.abs(sb.timestamp - pb.timestamp) > TIME_WINDOW) continue;
      const overlap = recipientOverlap(sb.recipients, pb.recipients);
      if (overlap >= OVERLAP_THRESH && overlap > bestOverlap) {
        bestOverlap = overlap;
        bestMatch   = pb;
      }
    }

    if (bestMatch) {
      usedShroomBlocks.add(sb.blockNumber);
      usedSporeBlocks.add(bestMatch.blockNumber);
      const legs = [
        { token: 'shroom', txCount: sb.txCount,        total: sb.total,        recipientCount: sb.recipientCount },
        { token: 'spore',  txCount: bestMatch.txCount, total: bestMatch.total, recipientCount: bestMatch.recipientCount },
      ];
      const cls = classifyEvent(legs, false);
      events.push({
        ...cls,
        timestamp:  Math.max(sb.timestamp, bestMatch.timestamp),
        sampleHash: sb.sampleHash,
        legs,
        transfers: [
          ...sb.rows.map(r => ({ hash: r.hash, from: r.from, to: r.to, token: 'shroom', amount: parseFloat(r.value)/1e18, timestamp: parseInt(r.timeStamp) })),
          ...bestMatch.rows.map(r => ({ hash: r.hash, from: r.from, to: r.to, token: 'spore', amount: parseFloat(r.value)/1e18, timestamp: parseInt(r.timeStamp) })),
        ],
      });
    }
  }

  // Remaining unpaired blocks become individual events
  // Second pass: pair large single-token OUT blocks by recipient overlap + time
  // (catches Gold Mooshie where SHROOM and SPORE land in different blocks)
  const shroomSingles = shroomBlocks.filter(b => !usedShroomBlocks.has(b.blockNumber) && b.isOut && b.txCount >= 20);
  const sporeSingles  = sporeBlocks.filter(b  => !usedSporeBlocks.has(b.blockNumber)  && b.isOut && b.txCount >= 20);
  for (const sb of shroomSingles) {
    let bestMatch = null, bestOverlap = 0;
    for (const pb of sporeSingles) {
      if (usedSporeBlocks.has(pb.blockNumber)) continue;
      if (Math.abs(sb.timestamp - pb.timestamp) > 24 * 60 * 60) continue; // 24h window for cross-block
      const overlap = recipientOverlap(sb.recipients, pb.recipients);
      if (overlap >= 0.30 && overlap > bestOverlap) { // lower threshold for separate blocks
        bestOverlap = overlap;
        bestMatch   = pb;
      }
    }
    if (bestMatch) {
      usedShroomBlocks.add(sb.blockNumber);
      usedSporeBlocks.add(bestMatch.blockNumber);
      const legs = [
        { token: 'shroom', txCount: sb.txCount,        total: sb.total,        recipientCount: sb.recipientCount },
        { token: 'spore',  txCount: bestMatch.txCount, total: bestMatch.total, recipientCount: bestMatch.recipientCount },
      ];
      const cls = classifyEvent(legs, false);
      events.push({
        ...cls,
        timestamp:  Math.max(sb.timestamp, bestMatch.timestamp),
        sampleHash: sb.sampleHash,
        legs,
        transfers: [
          ...sb.rows.map(r => ({ hash: r.hash, from: r.from, to: r.to, token: 'shroom', amount: parseFloat(r.value)/1e18, timestamp: parseInt(r.timeStamp) })),
          ...bestMatch.rows.map(r => ({ hash: r.hash, from: r.from, to: r.to, token: 'spore', amount: parseFloat(r.value)/1e18, timestamp: parseInt(r.timeStamp) })),
        ],
      });
    }
  }

  // Detect swaps by grouping all rows by tx hash — same hash + 2 tokens = swap
  const allRows = [
    ...shroomRows.map(r => ({ ...r, token: 'shroom' })),
    ...sporeRows.map(r  => ({ ...r, token: 'spore'  })),
    ...wethRows.map(r   => ({ ...r, token: 'weth'   })),
  ];
  const byHash = {};
  for (const r of allRows) {
    if (!byHash[r.hash]) byHash[r.hash] = [];
    byHash[r.hash].push(r);
  }
  const swapUsedBlocks = new Set();
  for (const [hash, rows] of Object.entries(byHash)) {
    const tokens = new Set(rows.map(r => r.token));
    if (tokens.size < 2) continue;
    // Skip if any row belongs to an already-classified airdrop block
    const alreadyUsed = rows.some(r =>
      usedShroomBlocks.has(r.blockNumber) || usedSporeBlocks.has(r.blockNumber)
    );
    if (alreadyUsed) continue;
    const transfers = rows.map(r => ({
      hash: r.hash, from: r.from, to: r.to, token: r.token,
      amount: parseFloat(r.value) / 1e18, timestamp: parseInt(r.timeStamp),
    }));
    const legMap = {};
    for (const r of rows) {
      if (!legMap[r.token]) legMap[r.token] = { token: r.token, txCount: 0, total: 0, recipients: new Set() };
      legMap[r.token].txCount++;
      legMap[r.token].total += parseFloat(r.value) / 1e18;
      legMap[r.token].recipients.add(r.to.toLowerCase());
    }
    const legs = Object.values(legMap).map(l => ({ token: l.token, txCount: l.txCount, total: l.total, recipientCount: l.recipients.size }));
    events.push({
      type: 'swap', label: 'Swap', emoji: '🔄', colorClass: 'swap',
      timestamp: Math.max(...rows.map(r => parseInt(r.timeStamp))),
      sampleHash: hash, legs, transfers,
    });
    for (const r of rows) swapUsedBlocks.add(r.blockNumber);
  }
  const wethBlocks = Object.entries(wethByBlock).map(([, rows]) => summariseBlock(rows, 'weth'));

  shroomBlocks.forEach(b => {
  });
  const remaining = [
    ...shroomBlocks.filter(b => !usedShroomBlocks.has(b.blockNumber) && !swapUsedBlocks.has(b.blockNumber)),
    ...sporeBlocks.filter(b  => !usedSporeBlocks.has(b.blockNumber)  && !swapUsedBlocks.has(b.blockNumber)),
    ...wethBlocks.filter(b   => !swapUsedBlocks.has(b.blockNumber)),
  ];

  for (const blk of remaining) {
    const legs = [{
      token: blk.token, txCount: blk.txCount,
      total: blk.total, recipientCount: blk.recipientCount,
    }];
    const cls = classifyEvent(legs, !blk.isOut);
    events.push({
      ...cls,
      timestamp:  blk.timestamp,
      sampleHash: blk.sampleHash,
      legs,
      transfers: blk.rows.map(r => ({
        hash: r.hash, from: r.from, to: r.to,
        token: blk.token,
        amount: parseFloat(r.value) / 1e18,
        timestamp: parseInt(r.timeStamp),
      })),
    });
  }

  return events.sort((a, b) => b.timestamp - a.timestamp);
}

app.get('/api/treasury-txs', async (req, res) => {
  try {
    const [shroomRows, sporeRows, wethRows] = await Promise.all([
      fetchTokenTxs(SHROOM_CONTRACT),
      fetchTokenTxs(SPORE_CONTRACT),
      fetchTokenTxs(WETH_CONTRACT),
    ]);
    const batches = groupIntoBatches(shroomRows, sporeRows, wethRows);
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
app.get('/api/sporebot-totals', async (req, res) => {
  try {
    const snap = await db.ref('Sporebot/Admin/Total_Balance').get();
    if (!snap.exists()) return res.json({ ok: false });
    res.json({ ok: true, totals: snap.val() });
  } catch (err) {
    console.error('[SPOREBOT-TOTALS]', err);
    res.status(500).json({ ok: false });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});