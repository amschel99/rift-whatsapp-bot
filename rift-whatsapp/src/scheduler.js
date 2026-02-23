require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { fetchUsersWithDetails, closePool } = require('./db');
const { categorizeAllUsers, printCategorySummary, CATEGORIES } = require('./categorize');
const { generateMessage } = require('./messageGen');
const { initWhatsApp, sendMessage, randomDelay, sessionBreak, destroyWhatsApp } = require('./whatsapp');
const { appendLog } = require('./logger');

const ALERT_PHONE = '+254797168636';
const DAILY_CAP = 50;
const SESSION_BREAK_EVERY = 10;
const SENT_TRACKER_FILE = path.join(__dirname, '..', 'logs', 'sent_users.json');

// Category rotation order — prioritize high-value segments first
const CATEGORY_PRIORITY = [
  CATEGORIES.DORMANT,
  CATEGORIES.KYC_NO_TRANSACTIONS,
  CATEGORIES.KYC_LOW_ACTIVITY,
  CATEGORIES.ACTIVE_NO_REFERRALS,
  CATEGORIES.ACTIVE_WITH_REFERRALS,
  CATEGORIES.NO_KYC,
];

// --- Sent tracker: avoid messaging same user twice ---

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

// --- Pick today's category intelligently ---

function pickCategory(categorizedUsers, sentTracker) {
  for (const cat of CATEGORY_PRIORITY) {
    const unsent = categorizedUsers.filter(
      u => u.category === cat && !sentTracker[u.id]
    );
    if (unsent.length > 0) {
      return { category: cat, users: unsent };
    }
  }
  return null; // All users messaged
}

// --- Main send batch ---

async function runBatch() {
  const startTime = new Date();
  console.log(`\n[${startTime.toISOString()}] Starting automated batch...`);

  try {
    // Fetch and categorize
    const rawUsers = await fetchUsersWithDetails();
    const categorizedUsers = categorizeAllUsers(rawUsers);
    printCategorySummary(categorizedUsers);

    const sentTracker = loadSentTracker();
    const totalSent = Object.keys(sentTracker).length;
    console.log(`Previously messaged: ${totalSent} users`);

    // Pick category
    const pick = pickCategory(categorizedUsers, sentTracker);
    if (!pick) {
      console.log('All users have been messaged! Nothing to do.');
      await sendAlertOnly(`[Rift Reactivation] All ${totalSent} users have been messaged. Campaign complete.`);
      return;
    }

    const { category, users } = pick;
    const batch = users.slice(0, DAILY_CAP);
    console.log(`Auto-selected category: ${category} (${users.length} unsent, sending ${batch.length})`);

    // Init WhatsApp
    console.log('Initializing WhatsApp...');
    await initWhatsApp();

    // Alert admin
    const alertMsg = `[Rift Auto] Starting batch:\nCategory: ${category}\nUsers: ${batch.length}/${users.length} unsent\nTime: ${new Date().toLocaleString('en-KE')}\nTotal campaign progress: ${totalSent}/${categorizedUsers.length}`;
    await sendMessage(ALERT_PHONE, alertMsg);
    await randomDelay(5000, 10000);

    let sentCount = 0;
    let skipCount = 0;
    let failCount = 0;

    for (let i = 0; i < batch.length; i++) {
      const user = batch[i];
      const progress = `[${i + 1}/${batch.length}]`;

      console.log(`${progress} ${user.firstName || 'Unknown'} (${user.phoneNumber})...`);

      try {
        const message = await generateMessage(user);
        const result = await sendMessage(user.phoneNumber, message);

        if (result.status === 'sent') {
          sentCount++;
          markUserSent(sentTracker, user.id, category);
          appendLog({ userId: user.id, phone: user.phoneNumber, name: user.firstName, category, message, ...result });

          // Forward to admin
          const fwd = `[${i + 1}/${batch.length}] ${user.firstName || 'Unknown'} (${user.phoneNumber}):\n\n${message}`;
          await sendMessage(ALERT_PHONE, fwd);
          console.log(`  Sent.`);
        } else if (result.status === 'skipped') {
          skipCount++;
          markUserSent(sentTracker, user.id, category); // Don't retry non-WhatsApp numbers
          console.log(`  Skipped: ${result.error}`);
        } else {
          failCount++;
          console.log(`  Failed: ${result.error}`);
        }

        // Delays
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

    // Summary alert
    const elapsed = ((Date.now() - startTime.getTime()) / 60000).toFixed(1);
    const summaryMsg = `[Rift Auto] Batch complete:\nCategory: ${category}\nSent: ${sentCount}\nSkipped: ${skipCount}\nFailed: ${failCount}\nDuration: ${elapsed}min\nCampaign progress: ${Object.keys(sentTracker).length}/${categorizedUsers.length}`;
    await sendMessage(ALERT_PHONE, summaryMsg);
    console.log(summaryMsg.replace(/\n/g, ' | '));

    await destroyWhatsApp();
  } catch (err) {
    console.error('Batch error:', err);
    try {
      await sendAlertOnly(`[Rift Auto] ERROR: ${err.message}`);
    } catch {}
  }
}

// Helper to send a single alert without full WhatsApp session
async function sendAlertOnly(msg) {
  try {
    await initWhatsApp();
    await sendMessage(ALERT_PHONE, msg);
    await destroyWhatsApp();
  } catch (e) {
    console.error('Alert send failed:', e.message);
  }
}

// --- Random time picker within a window ---

function randomHourMinute(startHour, endHour) {
  const hour = startHour + Math.floor(Math.random() * (endHour - startHour));
  const minute = Math.floor(Math.random() * 60);
  return { hour, minute };
}

// --- Scheduler ---

let scheduledTimeout = null;

function scheduleNextRun() {
  // Pick a random time between 9am and 5pm EAT (UTC+3)
  const { hour, minute } = randomHourMinute(9, 17);

  const now = new Date();
  const next = new Date();
  next.setHours(hour, minute, 0, 0);

  // If the time already passed today, schedule for tomorrow
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  const delay = next.getTime() - now.getTime();
  const delayMins = (delay / 60000).toFixed(0);

  console.log(`Next batch scheduled for: ${next.toLocaleString('en-KE')} (in ${delayMins} minutes)`);

  if (scheduledTimeout) clearTimeout(scheduledTimeout);

  scheduledTimeout = setTimeout(async () => {
    await runBatch();
    scheduleNextRun(); // Schedule next day
  }, delay);
}

// --- Main ---

async function main() {
  console.log('Rift WhatsApp Reactivation — Automated Scheduler');
  console.log('=================================================\n');

  if (!process.env.DATABASE_URL || !process.env.ANTHROPIC_API_KEY) {
    console.error('ERROR: DATABASE_URL and ANTHROPIC_API_KEY must be set in .env');
    process.exit(1);
  }

  const args = process.argv.slice(2);

  if (args.includes('--now')) {
    // Run immediately then schedule
    console.log('Running batch NOW, then scheduling daily...\n');
    await runBatch();
  }

  if (args.includes('--once')) {
    // Run once and exit
    console.log('Running single batch...\n');
    await runBatch();
    await closePool();
    process.exit(0);
  }

  // Start the scheduler
  scheduleNextRun();

  // Also run a health check cron every 6 hours
  cron.schedule('0 */6 * * *', () => {
    console.log(`[${new Date().toISOString()}] Health check — scheduler alive`);
  });

  console.log('Scheduler running. Press Ctrl+C to stop.\n');

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    if (scheduledTimeout) clearTimeout(scheduledTimeout);
    await closePool();
    await destroyWhatsApp();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
