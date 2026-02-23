require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const { generateMessage } = require('./messageGen');
const { initWhatsApp, destroyWhatsApp, formatKenyanNumber, getClient } = require('./whatsapp');

const TEST_PHONES = ['+254797168636', '+254713322025'];

const testUser = {
  id: 'test',
  firstName: 'Amschel',
  phoneNumber: TEST_PHONES[0],
  category: 'ACTIVE_NO_REFERRALS',
  totalTxns: 5,
  onrampCount: 3,
  offrampCount: 2,
  onrampVolume: 150,
  offrampVolume: 80,
  lastTxnDate: new Date(),
  referralCount: 0,
  referralEarningsKes: 0,
};

async function main() {
  console.log('=== Test Send (Debug Mode) ===\n');

  console.log('Generating message via Claude...');
  const message = await generateMessage(testUser);
  console.log(`\n--- Generated Message ---\n${message}\n-------------------------\n`);

  console.log('Initializing WhatsApp...');
  const client = await initWhatsApp();

  // Log connected account info
  const info = client.info;
  console.log(`\nConnected as: ${info.pushname} (${info.wid.user})`);
  console.log(`Platform: ${info.platform}\n`);

  for (const phone of TEST_PHONES) {
    const formatted = formatKenyanNumber(phone);
    console.log(`\n========== ${phone} ==========`);
    console.log(`  Formatted: ${formatted}`);

    // Check registration
    try {
      const isRegistered = await client.isRegisteredUser(formatted + '@c.us');
      console.log(`  Registered on WhatsApp: ${isRegistered}`);

      if (!isRegistered) {
        console.log(`  SKIPPING - number not on WhatsApp`);
        continue;
      }
    } catch (e) {
      console.log(`  Registration check failed: ${e.message}`);
    }

    // Get contact info
    try {
      const contact = await client.getContactById(formatted + '@c.us');
      console.log(`  Contact name: ${contact.pushname || contact.name || 'N/A'}`);
      console.log(`  Is business: ${contact.isBusiness}`);
    } catch (e) {
      console.log(`  Contact lookup failed: ${e.message}`);
    }

    // Send and track delivery
    try {
      console.log(`  Sending message...`);
      const msg = await client.sendMessage(formatted + '@c.us', message);
      console.log(`  Message ID: ${msg.id._serialized}`);
      console.log(`  ACK status: ${msg.ack} (0=pending, 1=sent, 2=delivered, 3=read)`);
      console.log(`  Timestamp: ${new Date(msg.timestamp * 1000).toISOString()}`);

      // Wait a few seconds and recheck ack
      console.log(`  Waiting 5s to check delivery...`);
      await new Promise(r => setTimeout(r, 5000));

      const info = await msg.getInfo();
      console.log(`  Delivery info: ${JSON.stringify(info, null, 2)}`);
    } catch (e) {
      console.log(`  Send FAILED: ${e.message}`);
      console.log(`  Stack: ${e.stack}`);
    }
  }

  console.log('\n\nWaiting 10s before cleanup...');
  await new Promise(r => setTimeout(r, 10000));

  await destroyWhatsApp();
  console.log('Done.');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
