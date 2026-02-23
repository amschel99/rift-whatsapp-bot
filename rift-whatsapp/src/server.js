require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const express = require('express');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { fetchUsersWithDetails, closePool } = require('./db');
const { categorizeAllUsers, printCategorySummary, CATEGORIES } = require('./categorize');
const { generateMessage } = require('./messageGen');
const { initWhatsApp, sendMessage, randomDelay, sessionBreak, destroyWhatsApp, getQR, isReady } = require('./whatsapp');
const { appendLog } = require('./logger');

// --- Config ---
const PORT = process.env.PORT || 3478;
const ALERT_PHONE = '+254797168636';
const DAILY_CAP = 50;
const SESSION_BREAK_EVERY = 10;
const SENT_TRACKER_FILE = path.join(__dirname, '..', 'logs', 'sent_users.json');

const CATEGORY_PRIORITY = [
  CATEGORIES.DORMANT,
  CATEGORIES.KYC_NO_TRANSACTIONS,
  CATEGORIES.KYC_LOW_ACTIVITY,
  CATEGORIES.ACTIVE_NO_REFERRALS,
  CATEGORIES.ACTIVE_WITH_REFERRALS,
  CATEGORIES.NO_KYC,
];

// --- State ---
let isRunning = false;
let lastRun = null;
let nextRunTime = null;
let scheduledTimeout = null;
let waConnected = false;
let stats = { totalSent: 0, totalSkipped: 0, totalFailed: 0, batchesRun: 0 };

// --- Sent tracker ---

function loadSentTracker() {
  if (!fs.existsSync(SENT_TRACKER_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(SENT_TRACKER_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveSentTracker(tracker) {
  const dir = path.dirname(SENT_TRACKER_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SENT_TRACKER_FILE, JSON.stringify(tracker, null, 2));
}

function markUserSent(tracker, userId, category) {
  tracker[userId] = { category, sentAt: new Date().toISOString() };
  saveSentTracker(tracker);
}

// --- Category picker ---

function pickCategory(categorizedUsers, sentTracker) {
  for (const cat of CATEGORY_PRIORITY) {
    const unsent = categorizedUsers.filter(u => u.category === cat && !sentTracker[u.id]);
    if (unsent.length > 0) return { category: cat, users: unsent };
  }
  return null;
}

// --- Batch runner ---

async function runBatch() {
  if (isRunning) {
    console.log('Batch already running, skipping...');
    return { skipped: true, reason: 'already_running' };
  }

  if (!waConnected) {
    console.log('WhatsApp not connected. Visit /qr to scan first.');
    return { skipped: true, reason: 'whatsapp_not_connected' };
  }

  isRunning = true;
  const startTime = new Date();
  console.log(`\n[${startTime.toISOString()}] Starting batch...`);

  try {
    const rawUsers = await fetchUsersWithDetails();
    const categorizedUsers = categorizeAllUsers(rawUsers);
    printCategorySummary(categorizedUsers);

    const sentTracker = loadSentTracker();
    const totalPreviouslySent = Object.keys(sentTracker).length;

    const pick = pickCategory(categorizedUsers, sentTracker);
    if (!pick) {
      console.log('All users messaged. Campaign complete.');
      isRunning = false;
      lastRun = { time: startTime, status: 'complete', message: 'All users messaged' };
      return { complete: true };
    }

    const { category, users } = pick;
    const batch = users.slice(0, DAILY_CAP);
    console.log(`Category: ${category} | ${batch.length}/${users.length} unsent`);

    // Alert admin
    await sendMessage(ALERT_PHONE,
      `[Rift Auto] Batch starting:\nCategory: ${category}\nUsers: ${batch.length}/${users.length}\nProgress: ${totalPreviouslySent}/${categorizedUsers.length}\nTime: ${new Date().toLocaleString('en-KE')}`
    );
    await randomDelay(5000, 10000);

    let sentCount = 0, skipCount = 0, failCount = 0;

    for (let i = 0; i < batch.length; i++) {
      const user = batch[i];
      console.log(`[${i + 1}/${batch.length}] ${user.firstName || 'Unknown'} (${user.phoneNumber})`);

      try {
        const message = await generateMessage(user);
        const result = await sendMessage(user.phoneNumber, message);

        if (result.status === 'sent') {
          sentCount++;
          markUserSent(sentTracker, user.id, category);
          appendLog({ userId: user.id, phone: user.phoneNumber, name: user.firstName, category, message, ...result });
          await sendMessage(ALERT_PHONE, `[${i + 1}/${batch.length}] ${user.firstName || 'Unknown'} (${user.phoneNumber}):\n\n${message}`);
          console.log('  Sent.');
        } else if (result.status === 'skipped') {
          skipCount++;
          markUserSent(sentTracker, user.id, category);
          console.log(`  Skipped: ${result.error}`);
        } else {
          failCount++;
          console.log(`  Failed: ${result.error}`);
        }

        if (sentCount > 0 && sentCount % SESSION_BREAK_EVERY === 0 && i < batch.length - 1) {
          await sessionBreak();
        } else if (i < batch.length - 1) {
          await randomDelay();
        }
      } catch (err) {
        failCount++;
        console.error(`  Error: ${err.message}`);
      }
    }

    const elapsed = ((Date.now() - startTime.getTime()) / 60000).toFixed(1);
    const summary = `[Rift Auto] Done:\n${category}: ${sentCount} sent, ${skipCount} skipped, ${failCount} failed\nDuration: ${elapsed}min\nProgress: ${Object.keys(sentTracker).length}/${categorizedUsers.length}`;
    await sendMessage(ALERT_PHONE, summary);
    console.log(summary.replace(/\n/g, ' | '));

    stats.totalSent += sentCount;
    stats.totalSkipped += skipCount;
    stats.totalFailed += failCount;
    stats.batchesRun++;
    lastRun = { time: startTime, category, sentCount, skipCount, failCount, elapsed };

    return lastRun;
  } catch (err) {
    console.error('Batch error:', err);
    lastRun = { time: startTime, status: 'error', error: err.message };
    try {
      await sendMessage(ALERT_PHONE, `[Rift Auto] ERROR: ${err.message}`);
    } catch {}
    return lastRun;
  } finally {
    isRunning = false;
  }
}

// --- Scheduler ---

function scheduleNextRun() {
  const hour = 9 + Math.floor(Math.random() * 8);
  const minute = Math.floor(Math.random() * 60);

  const now = new Date();
  const next = new Date();
  next.setHours(hour, minute, 0, 0);

  if (next <= now) next.setDate(next.getDate() + 1);

  nextRunTime = next;
  const delay = next.getTime() - now.getTime();

  console.log(`Next batch: ${next.toLocaleString('en-KE')} (in ${(delay / 60000).toFixed(0)} min)`);

  if (scheduledTimeout) clearTimeout(scheduledTimeout);
  scheduledTimeout = setTimeout(async () => {
    await runBatch();
    scheduleNextRun();
  }, delay);
}

// --- Express server ---

const app = express();
app.use(express.json());

// QR code page — scan this from your phone browser
app.get('/qr', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  const qr = getQR();
  const ready = isReady();

  if (ready) {
    return res.send('<html><body style="font-family:monospace;text-align:center;padding:50px"><h1>WhatsApp Connected</h1><p>Already authenticated and ready.</p><a href="/">Dashboard</a></body></html>');
  }

  if (!qr) {
    return res.send('<html><body style="font-family:monospace;text-align:center;padding:50px"><h1>Waiting for QR...</h1><p>WhatsApp is initializing. Refresh in a few seconds.</p><script>setTimeout(()=>location.reload(),3000)</script></body></html>');
  }

  // Render QR as a simple HTML page using a QR API
  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
  res.send(`<html><body style="font-family:monospace;text-align:center;padding:30px">
    <h1>Scan QR Code with WhatsApp</h1>
    <p>Open WhatsApp > Linked Devices > Link a Device</p>
    <img src="${qrImageUrl}" style="margin:20px"/>
    <p>Waiting for scan...</p>
    <script>setInterval(()=>{fetch('/').then(r=>r.json()).then(d=>{if(d.whatsapp==='connected')location.href='/'})},3000)</script>
  </body></html>`);
});

// Health / dashboard
app.get('/', (req, res) => {
  const sentTracker = loadSentTracker();
  res.json({
    status: 'running',
    whatsapp: isReady() ? 'connected' : (getQR() ? 'waiting_for_scan' : 'initializing'),
    uptime: process.uptime(),
    isRunning,
    lastRun,
    nextRunTime,
    stats: {
      ...stats,
      totalTracked: Object.keys(sentTracker).length,
    },
  });
});

// Category breakdown
app.get('/categories', async (req, res) => {
  try {
    const rawUsers = await fetchUsersWithDetails();
    const categorized = categorizeAllUsers(rawUsers);
    const sentTracker = loadSentTracker();

    const summary = {};
    for (const cat of Object.values(CATEGORIES)) {
      const all = categorized.filter(u => u.category === cat);
      const unsent = all.filter(u => !sentTracker[u.id]);
      summary[cat] = { total: all.length, sent: all.length - unsent.length, remaining: unsent.length };
    }

    res.json({ total: categorized.length, tracked: Object.keys(sentTracker).length, categories: summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger batch
app.post('/run', async (req, res) => {
  if (isRunning) return res.status(409).json({ error: 'Batch already running' });
  if (!waConnected) return res.status(400).json({ error: 'WhatsApp not connected. Visit /qr first.' });
  res.json({ message: 'Batch started' });
  runBatch().then(() => console.log('Manual batch complete'));
});

// Reset tracker
app.post('/reset', (req, res) => {
  saveSentTracker({});
  stats = { totalSent: 0, totalSkipped: 0, totalFailed: 0, batchesRun: 0 };
  res.json({ message: 'Sent tracker reset. All users will be re-messaged.' });
});

// View logs
app.get('/logs', (req, res) => {
  const logFile = path.join(__dirname, '..', 'logs', 'send_log.json');
  if (!fs.existsSync(logFile)) return res.json([]);
  try {
    const logs = JSON.parse(fs.readFileSync(logFile, 'utf8'));
    const limit = parseInt(req.query.limit) || 50;
    res.json(logs.slice(-limit));
  } catch {
    res.json([]);
  }
});

// --- Boot ---

async function boot() {
  console.log('Rift WhatsApp Reactivation Server');
  console.log('==================================\n');

  if (!process.env.DATABASE_URL || !process.env.ANTHROPIC_API_KEY) {
    console.error('ERROR: DATABASE_URL and ANTHROPIC_API_KEY required in .env');
    process.exit(1);
  }

  // Start Express first so health checks pass
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`  GET  /qr          — scan WhatsApp QR code`);
    console.log(`  GET  /            — status dashboard`);
    console.log(`  GET  /categories  — category breakdown`);
    console.log(`  POST /run         — trigger batch now`);
    console.log(`  POST /reset       — reset sent tracker`);
    console.log(`  GET  /logs        — view send logs\n`);
  });

  // Connect WhatsApp in background
  console.log('Connecting WhatsApp...');
  try {
    await initWhatsApp();
    waConnected = true;
    console.log('WhatsApp connected! Scheduling batches...\n');
    scheduleNextRun();
  } catch (err) {
    console.error('WhatsApp init failed:', err.message);
    console.log('Visit /qr to scan the QR code when ready.\n');
  }

  // Health check cron
  cron.schedule('0 */6 * * *', () => {
    console.log(`[${new Date().toISOString()}] Health check — alive | WA: ${waConnected}`);
  });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    if (scheduledTimeout) clearTimeout(scheduledTimeout);
    await closePool();
    await destroyWhatsApp();
    process.exit(0);
  });
}

boot().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
