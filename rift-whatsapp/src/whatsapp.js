const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

let waClient;

function initWhatsApp() {
  return new Promise((resolve, reject) => {
    waClient = new Client({
      authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
    });

    waClient.on('qr', qr => {
      console.log('\nScan this QR code with WhatsApp:\n');
      qrcode.generate(qr, { small: true });
    });

    waClient.on('ready', () => {
      console.log('WhatsApp client ready.');
      resolve(waClient);
    });

    waClient.on('auth_failure', err => {
      reject(new Error(`WhatsApp auth failed: ${err}`));
    });

    waClient.on('disconnected', reason => {
      console.log('WhatsApp disconnected:', reason);
    });

    waClient.initialize().catch(reject);
  });
}

function formatKenyanNumber(phone) {
  // Remove spaces, dashes, and plus signs
  let cleaned = phone.replace(/[\s\-\+]/g, '');

  // Convert 07XX to 2547XX
  if (cleaned.startsWith('07') || cleaned.startsWith('01')) {
    cleaned = '254' + cleaned.slice(1);
  }

  // Ensure it starts with 254
  if (!cleaned.startsWith('254')) {
    return null; // Invalid format
  }

  // Validate length (254 + 9 digits = 12)
  if (cleaned.length !== 12 || !/^\d+$/.test(cleaned)) {
    return null;
  }

  return cleaned;
}

async function isOnWhatsApp(phone) {
  if (!waClient) return false;
  const formatted = formatKenyanNumber(phone);
  if (!formatted) return false;
  try {
    return await waClient.isRegisteredUser(formatted + '@c.us');
  } catch {
    return false;
  }
}

async function sendMessage(phone, message) {
  if (!waClient) throw new Error('WhatsApp client not initialized');

  const formatted = formatKenyanNumber(phone);
  if (!formatted) {
    return { phone, status: 'skipped', error: 'Invalid phone number format', timestamp: new Date().toISOString() };
  }

  // Check if number is on WhatsApp first
  const registered = await isOnWhatsApp(phone);
  if (!registered) {
    return { phone: formatted, status: 'skipped', error: 'Not registered on WhatsApp', timestamp: new Date().toISOString() };
  }

  const chatId = formatted + '@c.us';
  try {
    await waClient.sendMessage(chatId, message);
    return { phone: formatted, status: 'sent', timestamp: new Date().toISOString() };
  } catch (err) {
    return { phone: formatted, status: 'failed', error: err.message, timestamp: new Date().toISOString() };
  }
}

function randomDelay(min = 8000, max = 15000) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  console.log(`  Waiting ${(ms / 1000).toFixed(0)}s before next message...`);
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sessionBreak() {
  const mins = 2 + Math.random() * 3; // 2-5 minutes
  const ms = mins * 60 * 1000;
  console.log(`\n  --- Session break: ${mins.toFixed(1)} minutes ---\n`);
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function destroyWhatsApp() {
  if (waClient) {
    await waClient.destroy();
    waClient = null;
  }
}

function getClient() {
  return waClient;
}

module.exports = { initWhatsApp, sendMessage, randomDelay, sessionBreak, destroyWhatsApp, formatKenyanNumber, getClient };
