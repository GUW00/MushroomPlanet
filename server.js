import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

// Load Firebase Admin SDK
const serviceAccount = JSON.parse(fs.readFileSync('./firebase.json', 'utf8'));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://drbots---live-default-rtdb.firebaseio.com',
});

const db = admin.database();
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ----------------------------------------------------------------
// POST /api/send-code
// Body: { discord_id: "123456789" }
// Writes VerifyCode + DM_Pending to Firebase. Bot polls DM_Pending
// and sends the DM, then clears the flag.
// ----------------------------------------------------------------
app.post('/api/send-code', async (req, res) => {
  const discord = req.body.discord_id;
  if (!discord) return res.status(400).json({ success: false, message: 'Missing Discord ID' });

  try {
    // Check user exists
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
// Body: { discord_id: "123456789", code: "123456" }
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
// Lookup by Discord ID or username
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

    // Fallback: scan by username
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
// Returns top 10 farmers, foragers, stakers
// ----------------------------------------------------------------
app.get('/api/leaderboard', async (req, res) => {
  try {
    const [sporebotSnap, pixieSnap] = await Promise.all([
      db.ref('Sporebot/Users').get(),
      db.ref('Pixie/Users').get(),
    ]);

    const farmers  = [];
    const foragers = [];
    const stakers  = [];
    let total_staked = 0, staker_count = 0, farm_count = 0;

    // Farm + staking data from Sporebot/Users (matches lb.py build_farm_embed / build_plant_embed)
    if (sporebotSnap.exists()) {
      sporebotSnap.forEach(child => {
        const data     = child.val();
        const username = data?.Misc?.username || child.key;
        const farm     = data?.Farm || {};
        const balance  = data?.Balance || {};
        const staking  = data?.Staking || {};

        const lifetime_spores = farm.lifetime_spores || 0;
        const streak          = farm.streak || 0;
        const staked          = staking.staked_spores || 0;
        const stage           = farm.current_stage;

        // Top Farmers = lifetime_spores (matches build_plant_embed shroom_farm / spore_rate logic)
        if (lifetime_spores > 0) farmers.push({ id: child.key, username, value: lifetime_spores });

        // Top Foragers = forage streak (matches build_farm_embed streak)
        if (streak > 0) foragers.push({ id: child.key, username, value: streak });

        // Top Stakers
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
// Start server
// ----------------------------------------------------------------
const TESTING = process.env.TESTING === 'true';
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});