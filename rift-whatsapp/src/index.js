require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { fetchUsersWithDetails, closePool } = require('./db');
const { CATEGORIES, categorizeAllUsers, printCategorySummary } = require('./categorize');
const { generateMessage } = require('./messageGen');
const { initWhatsApp, sendMessage, randomDelay, sessionBreak, destroyWhatsApp } = require('./whatsapp');
const { appendLog, writeDryRunLog } = require('./logger');

const DAILY_CAP = 50;
const SESSION_BREAK_EVERY = 10;
const ALERT_PHONE = '+254797168636';

const argv = yargs(hideBin(process.argv))
  .option('category', {
    alias: 'c',
    type: 'string',
    description: 'User category to target',
    choices: Object.values(CATEGORIES),
  })
  .option('dry-run', {
    alias: 'd',
    type: 'boolean',
    default: false,
    description: 'Generate messages without sending them',
  })
  .option('limit', {
    alias: 'l',
    type: 'number',
    default: DAILY_CAP,
    description: 'Max number of messages to send',
  })
  .option('summary', {
    alias: 's',
    type: 'boolean',
    default: false,
    description: 'Only show category summary, do not send',
  })
  .help()
  .argv;

async function main() {
  console.log('Rift WhatsApp Reactivation System');
  console.log('==================================\n');

  // Validate env
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL not set in .env');
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ERROR: ANTHROPIC_API_KEY not set in .env');
    process.exit(1);
  }

  // Step 1: Fetch and categorize users
  console.log('Fetching users from database...');
  const rawUsers = await fetchUsersWithDetails();
  console.log(`Found ${rawUsers.length} users with phone numbers.`);

  const categorizedUsers = categorizeAllUsers(rawUsers);
  printCategorySummary(categorizedUsers);

  // Summary only mode
  if (argv.summary) {
    await closePool();
    return;
  }

  // Must specify a category to proceed
  if (!argv.category) {
    console.log('Specify a --category to target. Use --summary to see counts.');
    console.log('Example: node src/index.js --category NO_KYC --dry-run');
    await closePool();
    return;
  }

  const targetUsers = categorizedUsers.filter(u => u.category === argv.category);
  const cap = Math.min(argv.limit, DAILY_CAP);
  const batch = targetUsers.slice(0, cap);

  console.log(`Targeting ${argv.category}: ${targetUsers.length} users total, processing ${batch.length}`);

  if (batch.length === 0) {
    console.log('No users in this category. Exiting.');
    await closePool();
    return;
  }

  // Step 2: Generate messages
  const isDryRun = argv['dry-run'] || argv.dryRun;
  if (isDryRun) {
    console.log('\n--- DRY RUN MODE: Generating messages only ---\n');
  }

  const results = [];
  let sentCount = 0;

  // Init WhatsApp only if not dry run
  if (!isDryRun) {
    console.log('Initializing WhatsApp client...');
    await initWhatsApp();
    console.log('');
  }

  // Send alert to admin before starting batch
  if (!isDryRun) {
    const alertMsg = `[Rift Reactivation] Starting batch send:\nCategory: ${argv.category}\nUsers: ${batch.length}\nTime: ${new Date().toLocaleString('en-KE')}`;
    console.log(`Sending alert to ${ALERT_PHONE}...`);
    await sendMessage(ALERT_PHONE, alertMsg);
    await randomDelay(5000, 10000);
  }

  for (let i = 0; i < batch.length; i++) {
    const user = batch[i];
    const progress = `[${i + 1}/${batch.length}]`;

    console.log(`${progress} Generating message for ${user.firstName || 'Unknown'} (${user.phoneNumber})...`);

    try {
      const message = await generateMessage(user);
      console.log(`  Message: "${message.substring(0, 80)}..."`);

      if (isDryRun) {
        results.push({
          userId: user.id,
          phone: user.phoneNumber,
          name: user.firstName,
          category: user.category,
          message,
          status: 'dry_run',
          timestamp: new Date().toISOString(),
        });
      } else {
        // Send via WhatsApp
        const sendResult = await sendMessage(user.phoneNumber, message);
        const logEntry = {
          userId: user.id,
          phone: user.phoneNumber,
          name: user.firstName,
          category: user.category,
          message,
          ...sendResult,
        };
        results.push(logEntry);
        appendLog(logEntry);

        if (sendResult.status === 'sent') {
          sentCount++;
          console.log(`  Sent successfully.`);
          // Forward copy to alert number
          const fwd = `[${i + 1}/${batch.length}] Sent to ${user.firstName || 'Unknown'} (${user.phoneNumber}):\n\n${message}`;
          await sendMessage(ALERT_PHONE, fwd);
        } else {
          console.log(`  ${sendResult.status}: ${sendResult.error || ''}`);
        }

        // Session break every N messages
        if (sentCount > 0 && sentCount % SESSION_BREAK_EVERY === 0 && i < batch.length - 1) {
          await sessionBreak();
        } else if (i < batch.length - 1) {
          await randomDelay();
        }
      }
    } catch (err) {
      console.error(`  ERROR generating/sending for ${user.phoneNumber}: ${err.message}`);
      results.push({
        userId: user.id,
        phone: user.phoneNumber,
        name: user.firstName,
        category: user.category,
        status: 'error',
        error: err.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Save results
  if (isDryRun) {
    writeDryRunLog(results, argv.category);
  }

  // Summary
  console.log('\n--- Session Summary ---');
  const sent = results.filter(r => r.status === 'sent').length;
  const failed = results.filter(r => r.status === 'failed').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const errors = results.filter(r => r.status === 'error').length;
  const dryRun = results.filter(r => r.status === 'dry_run').length;

  if (isDryRun) {
    console.log(`  Messages generated: ${dryRun}`);
  } else {
    console.log(`  Sent: ${sent}`);
    console.log(`  Failed: ${failed}`);
    console.log(`  Skipped (bad number): ${skipped}`);
    console.log(`  Errors: ${errors}`);
  }

  // Cleanup
  if (!isDryRun) {
    await destroyWhatsApp();
  }
  await closePool();
  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
