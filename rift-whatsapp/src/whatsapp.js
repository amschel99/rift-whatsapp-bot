const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const puppeteer = require('puppeteer');

// Resolve Chrome path from puppeteer's own install
let chromePath;
try {
  chromePath = process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath();
  console.log('Chrome found at:', chromePath);
} catch (err) {
  console.error('Could not find Chrome:', err.message);
}

let waClient;
let currentQR = null;
let waReady = false;
let initStatus = 'not_started';
let initError = null;

function initWhatsApp() {
  return new Promise((resolve, reject) => {
    const authPath = process.env.WWEBJS_AUTH_PATH || './.wwebjs_auth';

    initStatus = 'creating_client';
    initError = null;
    console.log('WhatsApp: creating client...');

    waClient = new Client({
      authStrategy: new LocalAuth({ dataPath: authPath }),
      puppeteer: {
        headless: true,
        executablePath: chromePath,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-zygote',
          '--single-process',
          '--disable-software-rasterizer',
        ],
      },
    });

    // Timeout: if no QR or ready within 2 minutes, something is wrong
    const initTimeout = setTimeout(() => {
      if (!waReady && !currentQR) {
        initStatus = 'timeout';
        initError = 'Chromium failed to start within 2 minutes. Check memory/logs on Render.';
        console.error('WhatsApp: init timeout — Chromium likely failed to start');
      }
    }, 120000);

    waClient.on('qr', qr => {
      clearTimeout(initTimeout);
      currentQR = qr;
      initStatus = 'waiting_for_scan';
      console.log('\nQR code received. Scan at /qr endpoint or terminal:\n');
      qrcode.generate(qr, { small: true });
    });

    waClient.on('authenticated', () => {
      currentQR = null;
      initStatus = 'authenticated';
      console.log('WhatsApp authenticated.');
    });

    waClient.on('ready', () => {
      clearTimeout(initTimeout);
      currentQR = null;
      waReady = true;
      initStatus = 'ready';
      console.log('WhatsApp client ready.');
      resolve(waClient);
    });

    waClient.on('auth_failure', err => {
      clearTimeout(initTimeout);
      waReady = false;
      initStatus = 'auth_failed';
      initError = String(err);
      reject(new Error(`WhatsApp auth failed: ${err}`));
    });

    waClient.on('disconnected', reason => {
      waReady = false;
      initStatus = 'disconnected';
      console.log('WhatsApp disconnected:', reason);
    });

    initStatus = 'initializing';
    console.log('WhatsApp: calling initialize() — launching Chromium...');
    waClient.initialize().catch(err => {
      clearTimeout(initTimeout);
      initStatus = 'init_error';
      initError = err.message;
      console.error('WhatsApp: initialize() failed:', err.message);
      reject(err);
    });
  });
}

function getInitStatus() {
  return { status: initStatus, error: initError };
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

module.exports = { initWhatsApp, sendMessage, randomDelay, sessionBreak, destroyWhatsApp, formatKenyanNumber, getClient, getQR, isReady, getInitStatus };
