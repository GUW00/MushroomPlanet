import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';
import webpush from 'web-push';
import cron from 'node-cron';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config();

webpush.setVapidDetails(
  process.env.VAPID_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const serviceAccount = JSON.parse(fs.readFileSync('./firebase.json', 'utf8'));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://drbots---live-default-rtdb.firebaseio.com',
});

const TESTING = process.env.TESTING === 'true';
const db = admin.database();
const app = express();

async function getUserNotifPrefs(discord_id) {
  const snap = await db.ref(`Pixie/Notifications/Prefs/${discord_id}`).get();
  return snap.val() || {};
}

app.use(cors({
  origin: ['https://mushroomplanet.earth', 'http://localhost:8080', 'http://localhost:5500'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-discord-id'],
  credentials: true,
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieParser());

// ----------------------------------------------------------------
// Push notification timing (UTC)
// ----------------------------------------------------------------
const RESET_HOUR = 12;
const RESET_MINUTE = 20;

// ----------------------------------------------------------------
// Firebase listener - fires push when raffle winner is recorded
// ----------------------------------------------------------------
app.post('/api/push-subscribe', async (req, res) => {
  const { discord_id, subscription } = req.body;
  if (!discord_id || !subscription) return res.status(400).json({ success: false });
  try {
    await db.ref(`Pixie/Users/${discord_id}/Notifications`).update({
      endpoint: subscription.endpoint,
      keys: subscription.keys,
    });
    console.log(`[PUSH] Subscribed: ${discord_id}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[PUSH] Subscribe error:', err);
    res.status(500).json({ success: false });
  }
});

// ----------------------------------------------------------------
// POST /api/push-unsubscribe
// ----------------------------------------------------------------
app.post('/api/push-unsubscribe', async (req, res) => {
  const { discord_id } = req.body;
  if (!discord_id) return res.status(400).json({ success: false });
  try {
    await Promise.all([
      db.ref(`Pixie/Users/${discord_id}/Notifications`).remove(),
      db.ref(`Pixie/Notifications/Reminders/${discord_id}`).remove(),
      db.ref(`Pixie/Notifications/Pipe/${discord_id}`).remove(),
    ]);
    console.log(`[PUSH] Unsubscribed: ${discord_id}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[PUSH] Unsubscribe error:', err);
    res.status(500).json({ success: false });
  }
});

// ----------------------------------------------------------------
// GET /api/inbox-meta/:discord_id  (read + archived keys)
// ----------------------------------------------------------------
app.get('/api/inbox-meta/:discord_id', async (req, res) => {
  try {
    const [readSnap, archSnap] = await Promise.all([
      db.ref(`Pixie/Users/${req.params.discord_id}/Inbox_Read`).get(),
      db.ref(`Pixie/Users/${req.params.discord_id}/Inbox_Archived`).get(),
    ]);
    res.json({ ok: true, read: readSnap.val() || {}, archived: archSnap.val() || {} });
  } catch (err) {
    res.status(500).json({ ok: false });
  }
});

// ----------------------------------------------------------------
// POST /api/inbox-meta  (save read + archived keys)
// ----------------------------------------------------------------
app.post('/api/inbox-meta', async (req, res) => {
  const { discord_id, read, archived } = req.body;
  if (!discord_id) return res.status(400).json({ ok: false });
  try {
    const updates = {};
    if (read     !== undefined) updates[`Pixie/Users/${discord_id}/Inbox_Read`]     = read;
    if (archived !== undefined) updates[`Pixie/Users/${discord_id}/Inbox_Archived`] = archived;
    await db.ref().update(updates);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false });
  }
});

// ----------------------------------------------------------------
// GET /api/push-prefs/:discord_id
// ----------------------------------------------------------------
app.get('/api/push-prefs/:discord_id', async (req, res) => {
  try {
    const snap = await db.ref(`Pixie/Notifications/Prefs/${req.params.discord_id}`).get();
    res.json({ success: true, prefs: snap.val() || null });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// ----------------------------------------------------------------
// POST /api/push-prefs
// ----------------------------------------------------------------
app.post('/api/push-prefs', async (req, res) => {
  const { discord_id, prefs } = req.body;
  if (!discord_id || !prefs) return res.status(400).json({ success: false });
  try {
    await db.ref(`Pixie/Notifications/Prefs/${discord_id}`).update(prefs);
    // Maintain Reminders index for efficient cron targeting
    const wantsReminders = prefs.forage !== false || prefs.social !== false;
    if (wantsReminders && prefs.reminders !== false) {
      await db.ref(`Pixie/Notifications/Reminders/${discord_id}`).set(true);
    } else {
      await db.ref(`Pixie/Notifications/Reminders/${discord_id}`).remove();
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[PUSH] Prefs error:', err);
    res.status(500).json({ success: false });
  }
});

// ----------------------------------------------------------------
// CRON - Daily farm reset notification (12:20 UTC)
// ----------------------------------------------------------------
cron.schedule(`${RESET_MINUTE} ${RESET_HOUR} * * *`, async () => {
  console.log('[PUSH] Sending daily reset notifications...');
  try {
    const snap = await db.ref('Pixie/Users').get();
    if (!snap.exists()) return;
    const payload = JSON.stringify({
      title: 'Farm Reset!',
      body: 'A New Farming Day Begins!',
      url: 'https://discord.com/channels/1190059108368400535/1305415396928655452'
    });
    const users = snap.val();
    const sends = Object.entries(users).map(async ([discord_id, user]) => {
      const sub = user?.Notifications;
      if (!sub || !sub.endpoint) return;
      try {
        const prefs = await getUserNotifPrefs(discord_id);
        if (prefs.reset === false) return;
        await webpush.sendNotification(sub, payload);
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await db.ref(`Pixie/Users/${discord_id}/Notifications`).remove();
          console.log(`[PUSH] Removed stale subscription: ${discord_id}`);
        } else {
          console.error(`[PUSH] Failed for ${discord_id}:`, err.message);
        }
      }
    });
    await Promise.all(sends);
    console.log(`[PUSH] Done. Notified ${Object.keys(users).length} users.`);
  } catch (err) {
    console.error('[PUSH] Cron error:', err);
  }
}, { timezone: 'UTC' });

// ----------------------------------------------------------------
// CRON - Daily reminder notification (11:20 UTC, 1hr before reset)
// ----------------------------------------------------------------
cron.schedule('0 */1 * * *', async () => {
  console.log('[PUSH] Sending daily reminder notifications...');
  try {
    const reminderSnap = await db.ref('Pixie/Notifications/Reminders').get();
    if (!reminderSnap.exists()) return;
    const opted_in = Object.keys(reminderSnap.val());

    const sends = opted_in.map(async (discord_id) => {
      try {
        const [subSnap, forageSnap, socialSnap] = await Promise.all([
          db.ref(`Pixie/Users/${discord_id}/Notifications`).get(),
          db.ref(`Sporebot/Users/${discord_id}/Daily_Check/daily_forage`).get(),
          db.ref(`Pixie/Users/${discord_id}/Message_XP/daily_limit`).get(),
        ]);

        if (!subSnap.exists()) return;
        const sub = subSnap.val();
        if (!sub.endpoint) return;

        const foragesDone = forageSnap.val() === true;
        const socialDone  = (socialSnap.val() || 0) >= 200;
        if (foragesDone && socialDone) return;

        const prefs = await getUserNotifPrefs(discord_id);

        if (!foragesDone && prefs.forage !== false) {
          await webpush.sendNotification(sub, JSON.stringify({
            title: 'Forage Reminder!',
            body: 'You still need to !forage today to keep your streak alive.',
            url: 'https://discord.com/channels/1190059108368400535/1305415396928655452'
          }));
          const fRef = db.ref(`Pixie/Messages/${discord_id}/inbox`).push();
          await fRef.set({ title: 'Forage Reminder!', body: 'You still need to !forage today to keep your streak alive.', sent_at: new Date().toISOString(), from: 'system', read: false });
        }

        if (!socialDone && prefs.social !== false) {
          await webpush.sendNotification(sub, JSON.stringify({
            title: 'Social Butterfly Reminder!',
            body: 'You have not completed the Social Butterfly today.',
            url: 'https://discord.com/channels/1190059108368400535/1190059109085614082'
          }));
          const sRef = db.ref(`Pixie/Messages/${discord_id}/inbox`).push();
          await sRef.set({ title: 'Social Butterfly Reminder!', body: 'You have not completed your Social Butterfly (200 XP) today.', sent_at: new Date().toISOString(), from: 'system', read: false });
        }

      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await db.ref(`Pixie/Users/${discord_id}/Notifications`).remove();
          await db.ref(`Pixie/Notifications/Reminders/${discord_id}`).remove();
          console.log(`[PUSH] Removed stale reminder subscription: ${discord_id}`);
        } else {
          console.error(`[PUSH] Reminder failed for ${discord_id}:`, err.message);
        }
      }
    });

    await Promise.all(sends);
    console.log('[PUSH] Reminder cron done.');
  } catch (err) {
    console.error('[PUSH] Reminder cron error:', err);
  }
}, { timezone: 'UTC' });

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
// POST /api/push-schedule-pipe
// ----------------------------------------------------------------
app.post('/api/push-schedule-pipe', async (req, res) => {
  const { discord_id, ready_at } = req.body;
  if (!discord_id || !ready_at) return res.status(400).json({ ok: false });
  try {
    await db.ref(`Pixie/Notifications/Pipe/${discord_id}`).set(ready_at);
    console.log(`[PUSH] Pipe scheduled for ${discord_id} at ${ready_at}`);
    res.json({ ok: true });
  } catch(err) {
    console.error('[PUSH] Schedule pipe error:', err.message);
    res.status(500).json({ ok: false });
  }
});

// ----------------------------------------------------------------
// POST /api/push-raffle-win
// ----------------------------------------------------------------
app.post('/api/push-raffle-win', async (req, res) => {
  const { discord_id, amount, currency, host } = req.body;
  if (!discord_id) return res.status(400).json({ ok: false });
  try {
    const subSnap = await db.ref(`Pixie/Users/${discord_id}/Notifications`).get();
    if (!subSnap.exists()) return res.json({ ok: true, sent: false });
    const sub = subSnap.val();
    if (!sub.endpoint) return res.json({ ok: true, sent: false });
    const prefs = await getUserNotifPrefs(discord_id);
    if (prefs.raffle === false) return res.json({ ok: true, sent: false });
    const payload = JSON.stringify({
      title: 'You Won a Raffle!',
      body: `You won ${Number(amount).toLocaleString()} ${currency} from ${host}'s raffle!`,
      url: 'https://discord.com/channels/1190059108368400535/1369734800864444499'
    });
    await webpush.sendNotification(sub, payload);
    console.log(`[PUSH] Raffle win sent to ${discord_id}`);
    res.json({ ok: true, sent: true });
  } catch(err) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      await db.ref(`Pixie/Users/${discord_id}/Notifications`).remove();
    }
    console.error('[PUSH] Raffle win error:', err.message);
    res.json({ ok: true, sent: false });
  }
});

// ----------------------------------------------------------------
// CRON - Pipe ready notifications (every hour)
// ----------------------------------------------------------------
cron.schedule('0 * * * *', async () => {
  try {
    const snap = await db.ref('Pixie/Notifications/Pipe').get();
    if (!snap.exists()) return;
    const schedule = snap.val();
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 3600000);

    await Promise.all(Object.entries(schedule).map(async ([discord_id, readyAt]) => {
      const readyTime = new Date(readyAt);
      if (readyTime > now || readyTime < oneHourAgo) return;

      await db.ref(`Pixie/Notifications/Pipe/${discord_id}`).remove();

      const subSnap = await db.ref(`Pixie/Users/${discord_id}/Notifications`).get();
      if (!subSnap.exists()) return;
      const sub = subSnap.val();
      if (!sub.endpoint) return;
      const prefs = await getUserNotifPrefs(discord_id);
      if (prefs.pipe === false) return;

      try {
        await webpush.sendNotification(sub, JSON.stringify({
          title: 'Elder Pipe is Ready!',
          body: 'Your Elder Pipe cooldown has reset. Use !pipe to reset all your daily cooldowns.',
          url: 'https://discord.com/channels/1190059108368400535/1305415396928655452'
        }));
        console.log(`[PUSH] Pipe ready sent to ${discord_id}`);
      } catch(err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await db.ref(`Pixie/Users/${discord_id}/Notifications`).remove();
        }
      }
    }));
  } catch(err) {
    console.error('[PUSH] Pipe cron error:', err.message);
  }
}, { timezone: 'UTC' });

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
const TREASURY_HOLDINGS_ADDR  = '0x5873002348cd4DF2aBD2624a6FC30E90573019F5';
const TREASURY_HOLDINGS_ADDR2 = '0xc96905CF923Aa75a074b9795D7064Eb295E42ce6';
const SPOREBOT_WALLET_ADDR    = '0xa00C9a4c1F40cdB30105E1402dD4c0ac7048863A';
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

    // Fetch second treasury wallet (SHROOM + SPORE only, added to discretionary)
    const wallet2Results = await Promise.all(
      HOLDINGS_TOKENS_LIST.filter(t => t.symbol === '$HROOM' || t.symbol === 'SPORE').map(async t => {
        const data2 = '0x70a08231' + TREASURY_HOLDINGS_ADDR2.slice(2).padStart(64, '0');
        const body2 = JSON.stringify({
          jsonrpc: '2.0', method: 'eth_call',
          params: [{ to: t.contract, data: data2 }, 'latest'], id: 1,
        });
        const r2 = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body2 });
        const j2 = await r2.json();
        return { symbol: t.symbol, balance: parseInt(j2.result, 16) / Math.pow(10, t.decimals) };
      })
    );

    // Merge wallet2 into main balances (same symbols, just add the amounts)
    const mergedBalances = [...tokenResults, { symbol: 'POL', balance: polBal }].map(b => {
      const w2 = wallet2Results.find(w => w.symbol === b.symbol);
      return w2 ? { ...b, balance: b.balance + w2.balance, wallet2: w2.balance } : b;
    });

    res.json({ ok: true, balances: mergedBalances, wallet2_shroom: wallet2Results.find(w => w.symbol === '$HROOM')?.balance || 0, wallet2_spore: wallet2Results.find(w => w.symbol === 'SPORE')?.balance || 0 });
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

app.get('/api/config/public', (req, res) => {
  res.json({ discord_client_id: process.env.DISCORD_CLIENT_ID });
});

// ================================================================
// GOVERNANCE ENDPOINTS
// Add these to server.js BEFORE app.listen()
// Requires: npm install node-fetch (already used) + set env vars:
//   DISCORD_CLIENT_ID=your_client_id
//   DISCORD_CLIENT_SECRET=your_client_secret
//   SESSION_SECRET=any_random_string
// Also: npm install cookie-parser
// Add near top of server.js: import cookieParser from 'cookie-parser';
//                             app.use(cookieParser());
// ================================================================

const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const SESSION_SECRET        = process.env.SESSION_SECRET || 'mushroom-planet-secret';
const PROPOSAL_BURN_AMOUNT  = 6874;
const PROPOSAL_DURATION_DAYS   = 5;
const VOTE_DURATION_DAYS       = 5;

// Simple in-memory session map: token -> discord_id
// For production you could swap this for Redis or Firebase
const sessions = new Map();

function generateToken() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function getSessionUser(req) {
  const token = req.cookies?.gov_session;
  if (token && sessions.has(token)) return sessions.get(token);
  // Fallback: trust x-discord-id header (user validated via Discord OAuth on frontend)
  const discordId = req.headers['x-discord-id'];
  if (discordId) {
    // Check Map first in case session still exists
    for (const user of sessions.values()) {
      if (user.discord_id === discordId) return user;
    }
    // Return a minimal user object — username will be resolved in the route handler
    return { discord_id: discordId, username: null };
  }
  return null;
}

// ----------------------------------------------------------------
// POST /api/auth/discord/callback
// Exchanges Discord OAuth code for user identity, creates session
// ----------------------------------------------------------------
app.post('/api/auth/discord/callback', async (req, res) => {
  const { code, redirect_uri } = req.body;
  if (!code) return res.status(400).json({ success: false, message: 'Missing code' });

  try {
    // Exchange code for access token
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type:    'authorization_code',
        code,
        redirect_uri,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return res.status(400).json({ success: false, message: 'Discord auth failed' });
    }

    // Fetch Discord user identity
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const discordUser = await userRes.json();
    const discord_id  = discordUser.id;

    // Check user exists in our Firebase
    const pixieSnap = await db.ref(`Pixie/Users/${discord_id}`).get();
    if (!pixieSnap.exists()) {
      return res.status(404).json({ success: false, message: 'Discord account not found in Mushroom Planet. Make sure you have used the bot first.' });
    }

    // Read MVP from Firebase
    const mvpSnap = await db.ref(`Pixie/Users/${discord_id}/MVP/total`).get();
    const mvp     = mvpSnap.exists() ? mvpSnap.val() : 0;

    // Store username + avatar in Misc so fallback auth can retrieve them
    await db.ref(`Pixie/Users/${discord_id}/Misc`).update({
      username:    discordUser.username,
      avatar_hash: discordUser.avatar || null,
    });

    const user = {
      discord_id,
      username: discordUser.username,
      avatar:   discordUser.avatar,
      mvp,
    };

    // Create session
    const token = generateToken();
    sessions.set(token, user);

    res.cookie('gov_session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    console.log(`[GOVERNANCE-AUTH] User ${discordUser.username} (${discord_id}) logged in`);
    res.json({ success: true, user });

  } catch (err) {
    console.error('[GOVERNANCE-AUTH] Error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ----------------------------------------------------------------
// GET /api/vote/user/:discord_id
// Returns current MVP for auth bar refresh
// ----------------------------------------------------------------
app.get('/api/vote/user/:discord_id', async (req, res) => {
  try {
    const snap = await db.ref(`Pixie/Users/${req.params.discord_id}/MVP/total`).get();
    res.json({ ok: true, mvp: snap.exists() ? snap.val() : 0 });
  } catch (err) {
    res.json({ ok: false, mvp: 0 });
  }
});

// ----------------------------------------------------------------
// GET /api/proposals
// Returns all proposals, sorted newest first
// ----------------------------------------------------------------
app.get('/api/proposals', async (req, res) => {
  try {
    const snap = await db.ref('Governance/Proposals').get();
    if (!snap.exists()) return res.json({ ok: true, proposals: [] });

    const proposals = [];
    snap.forEach(child => {
      const p = child.val();
      proposals.push({ id: child.key, ...p });
    });

    // Auto-close any expired active proposals
    const now = new Date();
    const closeOps = [];
    for (const p of proposals) {
      if (p.status === 'active' && p.ends_at && new Date(p.ends_at) < now) {
        let finalStatus = 'failed';
        const totals = p.vote_totals || {};
        if (p.stage === 'vote') {
          const winner = Object.entries(totals).sort((a, b) => b[1] - a[1])[0];
          finalStatus = winner ? 'passed' : 'failed';
        } else if (p.stage === 'proposal') {
          const yes = totals.yes || totals.Yes || 0;
          const no = totals.no || totals.No || 0;
          const total = yes + no;
          const voterCount = p.voter_count || 0;
          finalStatus = (total > 0 && voterCount >= 42 && yes / total >= 0.70) ? 'passed' : 'failed';
        }
        closeOps.push(db.ref(`Governance/Proposals/${p.id}`).update({
          status: finalStatus,
          closed_at: now.toISOString(),
        }));
        p.status = finalStatus;
        p.closed_at = now.toISOString();
        console.log(`[GOVERNANCE-AUTO-CLOSE] "${p.title}" auto-closed as ${finalStatus}`);
        const autoEmoji = finalStatus === 'passed' ? 'PASSED' : 'FAILED';
        const autoStage = p.stage === 'vote' ? 'Official Vote' : 'Official Proposal';
        sendInboxToAll(
          autoStage + ' ' + autoEmoji + ': ' + p.title.slice(0, 50),
          '"' + p.title.slice(0, 80) + '" has ended and ' + (finalStatus === 'passed' ? 'passed! The team will now implement the decision.' : 'did not pass. Discussion continues in Discord.'),
          '/vote.html'
        );
      }
    }
    if (closeOps.length) await Promise.all(closeOps);

    proposals.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json({ ok: true, proposals });
  } catch (err) {
    console.error('[PROPOSALS] Error:', err);
    res.status(500).json({ ok: false, error: 'Failed to load proposals' });
  }
});

// ----------------------------------------------------------------
// GET /api/proposals/:id
// Single proposal detail
// ----------------------------------------------------------------
app.get('/api/proposals/:id', async (req, res) => {
  try {
    const snap = await db.ref(`Governance/Proposals/${req.params.id}`).get();
    if (!snap.exists()) return res.status(404).json({ ok: false });
    const p = { id: req.params.id, ...snap.val() };
    // Hide vote breakdown until closed
    if (p.status === 'active') {
      p.vote_totals = null;
    }
    // Attach my_vote if user is identified
    const discordId = req.headers['x-discord-id'];
    if (discordId) {
      const voteSnap = await db.ref(`Governance/Votes/${req.params.id}/${discordId}`).get();
      p.my_vote = voteSnap.exists() ? voteSnap.val().choice : null;
    }
    res.json({ ok: true, proposal: p });
  } catch (err) {
    res.status(500).json({ ok: false });
  }
});

// ----------------------------------------------------------------
// GET /api/proposals/:id/comments
// ----------------------------------------------------------------
app.get('/api/proposals/:id/comments', async (req, res) => {
  try {
    const snap = await db.ref(`Governance/Proposals/${req.params.id}/Comments`).get();
    if (!snap.exists()) return res.json({ ok: true, comments: [] });
    const comments = [];
    const val = snap.val();
    Object.entries(val).forEach(([key, data]) => {
      if (data && typeof data === 'object' && data.text) {
        comments.push({ id: key, ...data });
      }
    });
    comments.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    res.json({ ok: true, comments });
  } catch (err) {
    console.error('[COMMENTS-ERROR]', err);
    res.status(500).json({ ok: false, comments: [] });
  }
});

// ----------------------------------------------------------------
// POST /api/proposals/:id/comments
// Auth required
// ----------------------------------------------------------------
app.post('/api/proposals/:id/comments', async (req, res) => {
  const sessionUser = getSessionUser(req);
  if (!sessionUser) return res.status(401).json({ ok: false, message: 'Not authenticated' });

  const { text } = req.body;
  if (!text || text.trim().length < 3) return res.status(400).json({ ok: false, message: 'Comment too short' });
  if (text.length > 1000) return res.status(400).json({ ok: false, message: 'Comment too long (max 1000 chars)' });

  try {
    const proposalSnap = await db.ref(`Governance/Proposals/${req.params.id}`).get();
    if (!proposalSnap.exists()) return res.status(404).json({ ok: false, message: 'Proposal not found' });

    const mvpSnap = await db.ref(`Pixie/Users/${sessionUser.discord_id}/MVP/total`).get();
    const mvp     = mvpSnap.exists() ? mvpSnap.val() : 0;

    // Resolve username/avatar if fallback auth was used
    let authorName   = sessionUser.username;
    let authorAvatar = sessionUser.avatar || null;
    if (!authorName || !authorAvatar) {
      const miscSnap = await db.ref(`Pixie/Users/${sessionUser.discord_id}/Misc`).get();
      const misc = miscSnap.val() || {};
      if (!authorName)   authorName   = misc.username   || sessionUser.discord_id;
      if (!authorAvatar) authorAvatar = misc.avatar_hash || null;
    }

    const commentRef = db.ref(`Governance/Proposals/${req.params.id}/Comments`).push();
    await commentRef.set({
      author_id:     sessionUser.discord_id,
      author_name:   authorName,
      author_avatar: authorAvatar,
      author_mvp:    mvp,
      text:          text.trim(),
      created_at:    new Date().toISOString(),
    });

    // Increment comment count on proposal
    const countRef = db.ref(`Governance/Proposals/${req.params.id}/comment_count`);
    const countSnap = await countRef.get();
    await countRef.set((countSnap.val() || 0) + 1);

    console.log(`[GOVERNANCE-COMMENT] ${sessionUser.username} commented on ${req.params.id}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[GOVERNANCE-COMMENT] Error:', err);
    res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// ----------------------------------------------------------------
// POST /api/proposals/:id/vote
// Auth required. Handles both official-proposal (1p1v) and official-vote (MVP)
// ----------------------------------------------------------------
app.post('/api/proposals/:id/vote', async (req, res) => {
  const sessionUser = getSessionUser(req);
  if (!sessionUser) return res.status(401).json({ ok: false, message: 'Not authenticated' });

  const { choice } = req.body;
  if (!choice) return res.status(400).json({ ok: false, message: 'No choice provided' });

  try {
    const proposalSnap = await db.ref(`Governance/Proposals/${req.params.id}`).get();
    if (!proposalSnap.exists()) return res.status(404).json({ ok: false, message: 'Proposal not found' });

    const proposal = proposalSnap.val();

    if (proposal.status !== 'active') return res.status(400).json({ ok: false, message: 'This vote is closed' });

    const now = new Date();
    if (proposal.ends_at && new Date(proposal.ends_at) < now) {
      return res.status(400).json({ ok: false, message: 'Voting period has ended' });
    }

    // Check already voted
    const existingSnap = await db.ref(`Governance/Votes/${req.params.id}/${sessionUser.discord_id}`).get();
    if (existingSnap.exists()) return res.status(400).json({ ok: false, message: 'You have already voted' });

    // For official votes, require MVP > 0
    const mvpSnap = await db.ref(`Pixie/Users/${sessionUser.discord_id}/MVP/total`).get();
    const mvp     = mvpSnap.exists() ? mvpSnap.val() : 0;

    if (proposal.stage === 'vote' && mvp <= 0) {
      return res.status(400).json({ ok: false, message: 'You need MVP > 0 to vote in Official Votes' });
    }

    // Validate choice is one of the proposal options
    const validOptions = proposal.stage === 'proposal'
      ? (proposal.options && proposal.options.length >= 2 ? proposal.options : ['yes', 'no'])
      : (proposal.options || []);
    if (!validOptions.includes(choice)) {
      return res.status(400).json({ ok: false, message: 'Invalid vote option' });
    }

    // Record the vote weight
    const weight = proposal.stage === 'vote' ? mvp : 1;

    // Atomic update: record vote + update tally
    const currentTotals  = proposal.vote_totals  || {};
    const currentVoters  = proposal.voter_count   || 0;
    currentTotals[choice] = (currentTotals[choice] || 0) + weight;

    const updates = {};
    updates[`Governance/Votes/${req.params.id}/${sessionUser.discord_id}`] = {
      choice,
      weight,
      voted_at: new Date().toISOString(),
    };
    updates[`Governance/Proposals/${req.params.id}/vote_totals`]  = currentTotals;
    updates[`Governance/Proposals/${req.params.id}/voter_count`]  = currentVoters + 1;

    await db.ref().update(updates);

    // Award flat 1M SPORE reward for voting (both proposal and official vote), once per proposal
    const VOTE_REWARD = 100;
    const walletRef = db.ref(`Pixie/Users/${sessionUser.discord_id}/Wallet`);
    const walletSnap = await walletRef.get();
    const wallet = walletSnap.val() || {};
    await walletRef.update({
      spore_wallet: (wallet.spore_wallet || 0) + VOTE_REWARD,
    });
    console.log(`[GOVERNANCE-VOTE] ${sessionUser.username} voted on ${req.params.id} (stage:${proposal.stage}, choice:${choice}, weight:${weight}, reward:${VOTE_REWARD})`);

    res.json({ ok: true });
  } catch (err) {
    console.error('[GOVERNANCE-VOTE] Error:', err);
    res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// ----------------------------------------------------------------
// POST /api/proposals/create
// Auth required. Burns SPORE from Discord wallet, creates proposal.
// ----------------------------------------------------------------
app.post('/api/proposals/create', async (req, res) => {
  const sessionUser = getSessionUser(req);
  if (!sessionUser) return res.status(401).json({ ok: false, message: 'Not authenticated' });

  const { title, description, category, options, discord_link, yes_meaning, no_meaning } = req.body;

  // Resolve username if fallback auth was used
  if (!sessionUser.username) {
    try {
      const pixSnap = await db.ref(`Pixie/Users/${sessionUser.discord_id}/Misc/username`).get();
      sessionUser.username = pixSnap.exists() ? pixSnap.val() : sessionUser.discord_id;
    } catch { sessionUser.username = sessionUser.discord_id; }
  }

  if (!title || title.length < 10)       return res.status(400).json({ ok: false, message: 'Title too short' });
  if (!description || description.length < 50) return res.status(400).json({ ok: false, message: 'Description too short' });
  if (!options || options.length < 2)    return res.status(400).json({ ok: false, message: 'Need at least 2 options' });
  if (options.length > 4)                return res.status(400).json({ ok: false, message: 'Max 4 options' });

  try {
    // Check wallet has enough SPORE
    const walletRef  = db.ref(`Pixie/Users/${sessionUser.discord_id}/Wallet`);
    const walletSnap = await walletRef.get();
    const wallet     = walletSnap.val() || {};
    const sporeBalance = wallet.spore_wallet || 0;

    if (sporeBalance < PROPOSAL_BURN_AMOUNT) {
      return res.status(400).json({
        ok: false,
        message: `Insufficient SPORE. Need ${PROPOSAL_BURN_AMOUNT.toLocaleString()} but you have ${sporeBalance.toLocaleString()}.`,
      });
    }

    // Burn SPORE (deduct from wallet — the tokens stay in bot economy as burned)
    await walletRef.update({
      spore_wallet: sporeBalance - PROPOSAL_BURN_AMOUNT,
    });

    // Log burn
    await db.ref('Governance/Burns').push({
      discord_id:  sessionUser.discord_id,
      username:    sessionUser.username,
      amount:      PROPOSAL_BURN_AMOUNT,
      burned_at:   new Date().toISOString(),
    });

    const now     = new Date();
    const endsAt  = new Date(now.getTime() + PROPOSAL_DURATION_DAYS * 24 * 60 * 60 * 1000);

    const proposalRef = db.ref('Governance/Proposals').push();
    await proposalRef.set({
      title:        title.trim(),
      description:  description.trim(),
      category:     category || 'other',
      options:      options.filter(Boolean),
      stage:        'proposal',
      status:       'active',
      author_id:    sessionUser.discord_id,
      author_name:  sessionUser.username,
      discord_link: discord_link || null,
      yes_meaning:  yes_meaning  || null,
      no_meaning:   no_meaning   || null,
      created_at:   now.toISOString(),
      ends_at:      endsAt.toISOString(),
      vote_totals:  {},
      voter_count:  0,
      comment_count: 0,
      spore_burned: PROPOSAL_BURN_AMOUNT,
    });

    console.log(`[GOVERNANCE-CREATE] ${sessionUser.username} created proposal "${title}" (burned ${PROPOSAL_BURN_AMOUNT} SPORE)`);
    sendInboxToAll(
      'New Proposal: ' + title.slice(0, 60),
      sessionUser.username + ' submitted a new Official Proposal. Vote ends in ' + PROPOSAL_DURATION_DAYS + ' days. Cast your vote to earn 1M SPORE.',
      '/vote.html'
    );
    res.json({ ok: true, id: proposalRef.key });

  } catch (err) {
    console.error('[GOVERNANCE-CREATE] Error:', err);
    res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// ----------------------------------------------------------------
// POST /api/proposals/:id/advance
// Admin only — advance proposal from 'proposal' stage to 'vote' stage
// ----------------------------------------------------------------
app.post('/api/proposals/:id/advance', async (req, res) => {
  const sessionUser = getSessionUser(req);
  if (!sessionUser) return res.status(401).json({ ok: false, message: 'Not authenticated' });

  const ADMIN_IDS = (process.env.ADMIN_DISCORD_IDS || '').split(',');
  const MOD_IDS   = ['1233612802883719261'];
  const allowed   = [...ADMIN_IDS, ...MOD_IDS];
  if (!allowed.includes(sessionUser.discord_id)) {
    return res.status(403).json({ ok: false, message: 'Mod only' });
  }

  try {
    const snap = await db.ref(`Governance/Proposals/${req.params.id}`).get();
    if (!snap.exists()) return res.status(404).json({ ok: false });
    const proposal = snap.val();
    if (proposal.stage !== 'proposal') return res.status(400).json({ ok: false, message: 'Can only advance Official Proposals to Official Vote' });

    const now    = new Date();
    const endsAt = new Date(now.getTime() + VOTE_DURATION_DAYS * 24 * 60 * 60 * 1000);

    await db.ref(`Governance/Proposals/${req.params.id}`).update({
      stage:       'vote',
      status:      'active',
      vote_totals: {},
      voter_count: 0,
      ends_at:     endsAt.toISOString(),
      advanced_at: now.toISOString(),
    });

    // Reset votes for the new stage
    await db.ref(`Governance/Votes/${req.params.id}`).remove();

    console.log(`[GOVERNANCE-ADVANCE] Admin advanced "${proposal.title}" to Official Vote`);
    sendInboxToAll(
      'Official Vote Started: ' + proposal.title.slice(0, 55),
      'This proposal has passed and is now an Official Vote. Your MVP score is your vote weight. Voting closes in ' + VOTE_DURATION_DAYS + ' days.',
      '/vote.html'
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[GOVERNANCE-ADVANCE] Error:', err);
    res.status(500).json({ ok: false });
  }
});

// ----------------------------------------------------------------
// POST /api/proposals/:id/close
// Admin only — close a vote and set final status (passed/failed)
// ----------------------------------------------------------------
app.post('/api/proposals/:id/close', async (req, res) => {
  const sessionUser = getSessionUser(req);
  if (!sessionUser) return res.status(401).json({ ok: false, message: 'Not authenticated' });

  const ADMIN_IDS = (process.env.ADMIN_DISCORD_IDS || '').split(',');
  if (!ADMIN_IDS.includes(sessionUser.discord_id)) {
    return res.status(403).json({ ok: false, message: 'Admin only' });
  }

  try {
    const snap = await db.ref(`Governance/Proposals/${req.params.id}`).get();
    if (!snap.exists()) return res.status(404).json({ ok: false });
    const proposal = snap.val();

    // Determine outcome
    let finalStatus = 'failed';
    const totals = proposal.vote_totals || {};

    if (proposal.stage === 'vote') {
      // Highest MVP sum wins
      const winner = Object.entries(totals).sort((a, b) => b[1] - a[1])[0];
      finalStatus = winner ? 'passed' : 'failed';
    } else if (proposal.stage === 'proposal') {
      const yes   = totals.yes || 0;
      const total = yes + (totals.no || 0);
      const yesPct = total > 0 ? yes / total : 0;
      finalStatus = yesPct >= 0.70 ? 'passed' : 'failed';
    }

    await db.ref(`Governance/Proposals/${req.params.id}`).update({
      status:    finalStatus,
      closed_at: new Date().toISOString(),
    });

    console.log(`[GOVERNANCE-CLOSE] "${proposal.title}" closed as ${finalStatus}`);
    const closeEmoji = finalStatus === 'passed' ? 'PASSED' : 'FAILED';
    const closeStage = proposal.stage === 'vote' ? 'Official Vote' : 'Official Proposal';
    sendInboxToAll(
      closeStage + ' ' + closeEmoji + ': ' + proposal.title.slice(0, 50),
      '"' + proposal.title.slice(0, 80) + '" has ended and ' + (finalStatus === 'passed' ? 'passed! The team will now implement the decision.' : 'did not pass. Discussion continues in Discord.'),
      '/vote.html'
    );
    res.json({ ok: true, status: finalStatus });
  } catch (err) {
    console.error('[GOVERNANCE-CLOSE] Error:', err);
    res.status(500).json({ ok: false });
  }
});
// ----------------------------------------------------------------
// POST /api/admin/broadcast
// Admin only — sends a message to all users' Inbox + push notification
// ----------------------------------------------------------------
const BROADCAST_ADMIN_ID = '1233612802883719261';

// ----------------------------------------------------------------
// Helper — write to all users' Inbox + send push if pref enabled
// ----------------------------------------------------------------
async function sendInboxToAll(title, body, url) {
  try {
    const snap = await db.ref('Pixie/Users').get();
    if (!snap.exists()) return;
    const users = snap.val();
    const now = new Date().toISOString();
    const dbWrites = [];
    const pushSends = [];
    for (const [uid, user] of Object.entries(users)) {
      const msgRef = db.ref(`Pixie/Messages/${uid}/inbox`).push();
      dbWrites.push(msgRef.set({ title, body, sent_at: now, from: 'system', read: false }));
      const sub = user?.Notifications;
      if (sub && sub.endpoint) {
        const prefs = await getUserNotifPrefs(uid);
        if (prefs.inbox !== false) {
          pushSends.push(
            webpush.sendNotification(sub, JSON.stringify({ title, body, url: url || '/vote.html' }))
              .catch(async (err) => {
                if (err.statusCode === 404 || err.statusCode === 410) {
                  await db.ref(`Pixie/Users/${uid}/Notifications`).remove();
                }
              })
          );
        }
      }
    }
    await Promise.all([...dbWrites, ...pushSends]);
    console.log(`[INBOX] Sent "${title}" to ${Object.keys(users).length} users`);
  } catch (err) {
    console.error('[INBOX] sendInboxToAll error:', err.message);
  }
}

app.post('/api/admin/broadcast', async (req, res) => {
  const { discord_id, message, title } = req.body;
  if (!discord_id || discord_id !== BROADCAST_ADMIN_ID) {
    return res.status(403).json({ ok: false, message: 'Not authorized' });
  }
  if (!message || message.trim().length < 3) {
    return res.status(400).json({ ok: false, message: 'Message too short' });
  }

  try {
    // Fetch all Pixie users
    const snap = await db.ref('Pixie/Users').get();
    if (!snap.exists()) return res.json({ ok: true, sent: 0 });

    const users = snap.val();
    const now = new Date().toISOString();
    const msgTitle = (title || 'Message from Admin').trim();
    const msgBody  = message.trim();

    const dbWrites = [];
    const pushSends = [];
    let sentCount = 0;

    for (const [uid, user] of Object.entries(users)) {
      const msgRef = db.ref(`Pixie/Messages/${uid}/inbox`).push();
      dbWrites.push(msgRef.set({
        title:      msgTitle,
        body:       msgBody,
        sent_at:    now,
        from:       'admin',
        read:       false,
      }));

      const sub = user?.Notifications;
      if (sub && sub.endpoint) {
        const prefs = await getUserNotifPrefs(uid);
        if (prefs.inbox !== false) {
          pushSends.push(
            webpush.sendNotification(sub, JSON.stringify({
              title: msgTitle,
              body:  msgBody,
              url:   '/profile.html',
            })).catch(async (err) => {
              if (err.statusCode === 404 || err.statusCode === 410) {
                await db.ref(`Pixie/Users/${uid}/Notifications`).remove();
              }
            })
          );
        }
      }
      sentCount++;
    }

    await Promise.all(dbWrites);
    await Promise.all(pushSends);

    console.log(`[BROADCAST] Admin sent "${msgTitle}" to ${sentCount} users`);
    res.json({ ok: true, sent: sentCount });
  } catch (err) {
    console.error('[BROADCAST] Error:', err);
    res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// ----------------------------------------------------------------
// GET /api/messages/:discord_id  - load inbox + archived
// ----------------------------------------------------------------
app.get('/api/messages/:discord_id', async (req, res) => {
  try {
    const [inboxSnap, archSnap] = await Promise.all([
      db.ref(`Pixie/Messages/${req.params.discord_id}/inbox`).get(),
      db.ref(`Pixie/Messages/${req.params.discord_id}/archived`).get(),
    ]);
    res.json({
      ok: true,
      inbox:    inboxSnap.val()  || {},
      archived: archSnap.val()   || {},
    });
  } catch (err) {
    res.status(500).json({ ok: false });
  }
});

// ----------------------------------------------------------------
// POST /api/messages/:discord_id/read/:key
// ----------------------------------------------------------------
app.post('/api/messages/:discord_id/read/:key', async (req, res) => {
  try {
    await db.ref(`Pixie/Messages/${req.params.discord_id}/inbox/${req.params.key}`).update({ read: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false });
  }
});

// ----------------------------------------------------------------
// POST /api/messages/:discord_id/archive/:key
// Moves message from inbox to archived
// ----------------------------------------------------------------
app.post('/api/messages/:discord_id/archive/:key', async (req, res) => {
  const { discord_id, key } = req.params;
  try {
    const snap = await db.ref(`Pixie/Messages/${discord_id}/inbox/${key}`).get();
    if (!snap.exists()) return res.status(404).json({ ok: false });
    const msg = snap.val();
    await db.ref(`Pixie/Messages/${discord_id}/archived/${key}`).set(msg);
    await db.ref(`Pixie/Messages/${discord_id}/inbox/${key}`).remove();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false });
  }
});

// ----------------------------------------------------------------
// POST /api/messages/:discord_id/unarchive/:key
// Moves message from archived back to inbox
// ----------------------------------------------------------------
app.post('/api/messages/:discord_id/unarchive/:key', async (req, res) => {
  const { discord_id, key } = req.params;
  try {
    const snap = await db.ref(`Pixie/Messages/${discord_id}/archived/${key}`).get();
    if (!snap.exists()) return res.status(404).json({ ok: false });
    const msg = snap.val();
    await db.ref(`Pixie/Messages/${discord_id}/inbox/${key}`).set(msg);
    await db.ref(`Pixie/Messages/${discord_id}/archived/${key}`).remove();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false });
  }
});

// ----------------------------------------------------------------
// DELETE /api/messages/:discord_id/:folder/:key
// Permanently deletes a message (inbox or archived)
// ----------------------------------------------------------------
app.post('/api/messages/:discord_id/delete/:folder/:key', async (req, res) => {
  const { discord_id, folder, key } = req.params;
  if (folder !== 'inbox' && folder !== 'archived') return res.status(400).json({ ok: false });
  try {
    await db.ref(`Pixie/Messages/${discord_id}/${folder}/${key}`).remove();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false });
  }
});

// ----------------------------------------------------------------
// GET /api/giveaways/:discord_id  - NOT needed - shared data below
// GET /api/giveaways  - public: active + archived raffles & airdrops
// ----------------------------------------------------------------
app.get('/api/giveaways', async (req, res) => {
  try {
    const [raffleActive, raffleCompleted, airdropActive, airdropCompleted] = await Promise.all([
      db.ref('Pixie/Logs/Raffles/Active').get(),
      db.ref('Pixie/Logs/Raffles/Completed').get(),
      db.ref('Pixie/Logs/Airdrops/Active').get(),
      db.ref('Pixie/Logs/Airdrops/Completed').get(),
    ]);
    // Completed entries are nested: {timestamp: {FullData: {...}, Summary: {...}}}
    // Flatten to {timestamp: FullData} so the frontend gets the same shape as Active
    function flattenCompleted(val) {
      if (!val) return {};
      const out = {};
      for (const [ts, entry] of Object.entries(val)) {
        let record = null;
        if (entry && entry.FullData) {
          record = Object.assign({}, entry.FullData);
          // Summary has the resolved Winner {DisplayName, UserID} — merge it in
          if (entry.Summary && entry.Summary.Winner) record.Winner = entry.Summary.Winner;
        } else if (entry && entry.Summary) {
          record = entry.Summary;
        } else if (entry && (entry.Amount || entry.Currency)) {
          record = entry;
        }
        if (!record) continue;
        out[ts] = record;
      }
      // Keep only the 10 most recent (keys are timestamp strings, sort descending)
      const sorted = Object.keys(out).sort((a, b) => b.localeCompare(a)).slice(0, 10);
      const trimmed = {};
      for (const k of sorted) trimmed[k] = out[k];
      return trimmed;
    }
    res.set('Cache-Control', 'public, max-age=30');
    res.json({
      ok: true,
      raffles:  { active: raffleActive.val()  || {}, closed: flattenCompleted(raffleCompleted.val())  },
      airdrops: { active: airdropActive.val() || {}, closed: flattenCompleted(airdropCompleted.val()) },
    });
  } catch (err) {
    console.error('[GIVEAWAYS]', err);
    res.status(500).json({ ok: false });
  }
});


app.post('/api/rpc/polygon', async (req, res) => {
  try {
    const r = await fetch(process.env.ALCHEMY_POLYGON_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'RPC proxy failed' });
  }
});
// ----------------------------------------------------------------
// POST /api/user/:id/megabot
// ----------------------------------------------------------------
app.post('/api/user/:id/megabot', async (req, res) => {
  const discord_id = req.params.id;
  const { megabot } = req.body;

  if (!discord_id || !megabot) {
    return res.status(400).json({ success: false, message: 'Missing data' });
  }

  try {
    await db.ref(`Sporebot/Users/${discord_id}/Megabot`).update({
      build: megabot,
      saved_at: new Date().toISOString(),
    });
    console.log('[MEGABOT] Saved for', discord_id);
    res.json({ success: true });
  } catch (err) {
    console.error('[MEGABOT] Save error:', err);
    res.status(500).json({ success: false, message: 'Failed to save' });
  }
});
// ----------------------------------------------------------------
// GET /api/user/:id/megabot
// ----------------------------------------------------------------
app.get('/api/user/:id/megabot', async (req, res) => {
  const discord_id = req.params.id;
  try {
    const snap = await db.ref(`Sporebot/Users/${discord_id}/Megabot/build`).get();
    res.json({ megabot: snap.exists() ? snap.val() : null });
  } catch (err) {
    console.error('[MEGABOT] Load error:', err);
    res.status(500).json({ megabot: null });
  }
});
// ----------------------------------------------------------------
// GET /api/reddit-user/:username
// Returns Reddit/Users/{username} data by discord_id lookup
// ----------------------------------------------------------------
app.get('/api/reddit-user/:discord_id', async (req, res) => {
  try {
    const discord_id = req.params.discord_id;
    // Find Reddit username via Pixie link
    const pixieSnap = await db.ref(`Pixie/Users/${discord_id}/Security/RedditName`).get();
    const redditName = pixieSnap.exists() ? pixieSnap.val() : null;
    if (!redditName) return res.json({ ok: true, reddit: null, redditName: null });

    const snap = await db.ref(`Reddit/Users/${redditName}`).get();
    res.json({ ok: true, reddit: snap.exists() ? snap.val() : null, redditName });
  } catch (err) {
    console.error('[REDDIT-USER] Error:', err);
    res.status(500).json({ ok: false });
  }
});

app.get('/api/leaderboard/snapshot', async (req, res) => {
  try {
    const [snap, pixieSnap] = await Promise.all([
      db.ref('Pixie/Leaderboard').get(),
      db.ref('Pixie/Users').get(),
    ]);
    if (!snap.exists()) return res.json({ ok: false });

    // Build name->avatar lookup from Pixie/Users Misc
    const avatarMap = {};
    if (pixieSnap.exists()) {
      pixieSnap.forEach(child => {
        const misc = (child.val() || {}).Misc || {};
        if (misc.username && misc.avatar_hash) {
          avatarMap[misc.username] = { discord_id: child.key, avatar: misc.avatar_hash };
        }
      });
    }

    // Build discord_id -> name map for reverse lookup
    const idToName = {};
    if (pixieSnap.exists()) {
      pixieSnap.forEach(child => {
        const misc = (child.val() || {}).Misc || {};
        if (misc.username) idToName[child.key] = misc.username;
      });
    }

    // Collect ALL unique names from the leaderboard snapshot that need avatars
    const namesToFetch = new Set();
    const snapData = snap.val();
    function collectNames(arr) {
      if (!Array.isArray(arr)) return;
      arr.forEach(u => { if (u.name && !avatarMap[u.name]) namesToFetch.add(u.name); });
    }
    for (const section of Object.keys(snapData)) {
      for (const key of Object.keys(snapData[section] || {})) {
        if (Array.isArray(snapData[section][key])) collectNames(snapData[section][key]);
      }
    }

    // Build reverse map: name -> discord_id from Firebase (case-insensitive)
    const nameToId = {};
    if (pixieSnap.exists()) {
      pixieSnap.forEach(child => {
        const misc = (child.val() || {}).Misc || {};
        if (misc.username) nameToId[misc.username.toLowerCase()] = child.key;
      });
    }

    // Fetch avatars for all missing leaderboard names
    await Promise.all([...namesToFetch].map(async name => {
      const discordId = nameToId[name.toLowerCase()];
      if (!discordId) return;
      try {
        const r = await fetch('https://discord.com/api/v10/users/' + discordId, {
          headers: { Authorization: 'Bot ' + process.env.DISCORD_BOT_TOKEN }
        });
        const u = await r.json();
        if (u.avatar) {
          avatarMap[name] = { discord_id: discordId, avatar: u.avatar };
          db.ref(`Pixie/Users/${discordId}/Misc`).update({ avatar_hash: u.avatar }).catch(() => {});
        } else if (u.id) {
          // User exists but has no avatar - store discord_id so we at least have that
          avatarMap[name] = { discord_id: discordId, avatar: null };
        }
      } catch(e) {}
    }));

    // Enrich all leaderboard array entries with discord_id + avatar
    const data = snap.val();
    function enrichList(arr) {
      if (!Array.isArray(arr)) return arr;
      return arr.map(u => {
        if (u.discord_id && u.avatar) return u;
        const match = u.name && avatarMap[u.name];
        if (match) return { ...u, discord_id: match.discord_id, avatar: match.avatar };
        return u;
      });
    }
    for (const section of Object.keys(data)) {
      for (const key of Object.keys(data[section] || {})) {
        if (Array.isArray(data[section][key])) {
          data[section][key] = enrichList(data[section][key]);
        }
      }
    }

    const missing = [];
    for (const section of Object.keys(data)) {
      for (const key of Object.keys(data[section] || {})) {
        if (Array.isArray(data[section][key])) {
          data[section][key].forEach(u => { if (u.name && !u.avatar) missing.push(u.name); });
        }
      }
    }
    console.log('[LB-SNAPSHOT] Missing avatars:', [...new Set(missing)].join(', '));
    res.set('Cache-Control', 'public, max-age=14400, stale-while-revalidate=3600');
    res.json({ ok: true, data });
  } catch (err) {
    console.error('[LB-SNAPSHOT]', err);
    res.status(500).json({ ok: false });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

app.get('/api/discord-avatar/:id', async (req, res) => {
  try {
    const r = await fetch('https://discord.com/api/v10/users/' + req.params.id, {
      headers: { Authorization: 'Bot ' + process.env.DISCORD_BOT_TOKEN }
    });
    const data = await r.json();
    res.json({ avatar: data.avatar || null });
  } catch(e) {
    res.json({ avatar: null });
  }
});