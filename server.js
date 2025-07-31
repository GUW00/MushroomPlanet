import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';
import fs from 'fs';

// Load Firebase Admin SDK
const serviceAccount = JSON.parse(fs.readFileSync('./firebase-adminsdk.json', 'utf8'));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://sporebot-test-default-rtdb.firebaseio.com',
});

const db = admin.database();
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // serve your profile.html and other static files

// 🔐 /api/send-code (simulate sending a code)
app.get('/api/send-code', async (req, res) => {
  const discord = req.query.discord;
  if (!discord) return res.status(400).json({ success: false, message: 'Missing Discord ID' });

  const ref = db.ref(`Pixie/Users/${discord}/Security`);
  await ref.update({ DM_Sent: true, Website_Link: false });

  // simulate sending a 6-digit code
  const code = Math.floor(100000 + Math.random() * 900000);
  await db.ref(`Pixie/Users/${discord}/Security/VerifyCode`).set(code);

  console.log(`[SEND] Code ${code} sent to ${discord}`);
  res.json({ success: true });
});

// 🔒 /api/verify-code
app.get('/api/verify-code', async (req, res) => {
  const { discord, code } = req.query;
  if (!discord || !code) return res.status(400).json({ success: false });

  const snap = await db.ref(`Pixie/Users/${discord}/Security/VerifyCode`).get();
  const expectedCode = snap.val();

  if (expectedCode == code) {
    await db.ref(`Pixie/Users/${discord}/Security`).update({
      Website_Link: true,
      VerifyCode: null
    });
    return res.json({ success: true, profile: { verified: true, username: discord } });
  }

  res.json({ success: false, message: 'Invalid code' });
});

// Start server
const PORT = 3001;
app.listen(PORT, () => {
  console.log(`✅ API server running at http://localhost:${PORT}`);
});


// 📥 GET /api/user/:id → Read user data for profile.html
app.get('/api/user/:id', async (req, res) => {
  const input = req.params.id;

  let pixieSnap, sporebotSnap;

  const pixieRef = db.ref(`Pixie/Users/${input}`);
  const sporebotRef = db.ref(`Sporebot/Users/${input}`);

  try {
    // First try direct ID lookup
    [pixieSnap, sporebotSnap] = await Promise.all([
      pixieRef.get(),
      sporebotRef.get(),
    ]);

    if (pixieSnap.exists() || sporebotSnap.exists()) {
      return res.json({
        pixie: pixieSnap.exists() ? pixieSnap.val() : null,
        sporebot: sporebotSnap.exists() ? sporebotSnap.val() : null,
      });
    }

    // If not found by ID, scan all users to find by username
    const allPixieUsersSnap = await db.ref('Pixie/Users').get();
    const allSporebotUsersSnap = await db.ref('Sporebot/Users').get();

    let matchedId = null;

    allPixieUsersSnap.forEach(child => {
      if (child.val()?.Misc?.username?.toLowerCase() === input.toLowerCase()) {
        matchedId = child.key;
      }
    });

    if (!matchedId) {
      allSporebotUsersSnap.forEach(child => {
        if (child.val()?.Misc?.username?.toLowerCase() === input.toLowerCase()) {
          matchedId = child.key;
        }
      });
    }

    if (!matchedId) return res.json({ pixie: null, sporebot: null });

    // Try again using matchedId
    const [matchedPixie, matchedSporebot] = await Promise.all([
      db.ref(`Pixie/Users/${matchedId}`).get(),
      db.ref(`Sporebot/Users/${matchedId}`).get(),
    ]);

    return res.json({
      pixie: matchedPixie.exists() ? matchedPixie.val() : null,
      sporebot: matchedSporebot.exists() ? matchedSporebot.val() : null,
    });

  } catch (err) {
    console.error('🔥 Firebase lookup error:', err);
    res.status(500).json({ error: 'Failed to fetch user data' });
  }
});
