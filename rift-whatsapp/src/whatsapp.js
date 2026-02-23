const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

let waClient;
let currentQR = null;
let waReady = false;

function initWhatsApp() {
  return new Promise((resolve, reject) => {
    const authPath = process.env.WWEBJS_AUTH_PATH || './.wwebjs_auth';

    waClient = new Client({
      authStrategy: new LocalAuth({ dataPath: authPath }),
      puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-zygote',
          '--single-process',
        ],
      },
    });

    waClient.on('qr', qr => {
      currentQR = qr;
      console.log('\nQR code received. Scan at /qr endpoint or terminal:\n');
      qrcode.generate(qr, { small: true });
    });

    waClient.on('authenticated', () => {
      currentQR = null;
      console.log('WhatsApp authenticated.');
    });

    waClient.on('ready', () => {
      currentQR = null;
      waReady = true;
      console.log('WhatsApp client ready.');
      resolve(waClient);
    });

    waClient.on('auth_failure', err => {
      waReady = false;
      reject(new Error(`WhatsApp auth failed: ${err}`));
    });

    waClient.on('disconnected', reason => {
      waReady = false;
      console.log('WhatsApp disconnected:', reason);
    });

    waClient.initialize().catch(reject);
  });
}

function getQR() {
  return currentQR;
}

function isReady() {
  return waReady;
}

function formatKenyanNumber(phone) {
  let cleaned = phone.replace(/[\s\-\+]/g, '');

  if (cleaned.startsWith('07') || cleaned.startsWith('01')) {
    cleaned = '254' + cleaned.slice(1);
  }

  if (!cleaned.startsWith('254')) return null;
  if (cleaned.length !== 12 || !/^\d+$/.test(cleaned)) return null;

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
  const mins = 2 + Math.random() * 3;
  const ms = mins * 60 * 1000;
  console.log(`\n  --- Session break: ${mins.toFixed(1)} minutes ---\n`);
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function destroyWhatsApp() {
  if (waClient) {
    await waClient.destroy();
    waClient = null;
    waReady = false;
  }
}

function getClient() {
  return waClient;
}

module.exports = { initWhatsApp, sendMessage, randomDelay, sessionBreak, destroyWhatsApp, formatKenyanNumber, getClient, getQR, isReady };
