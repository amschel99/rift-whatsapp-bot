const Anthropic = require('@anthropic-ai/sdk');

let client;

function getClient() {
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

const SYSTEM_PROMPT = `You are a friendly, casual WhatsApp outreach assistant for Rift, a fintech app in Kenya.

Rift's key benefits:
- Save in US dollars — protects your money from KES devaluation
- Earn 10% APY on dollar savings — your money grows
- Privacy protected — no personal details revealed when transacting
- Pay anywhere — tills, paybills, or send money via M-Pesa
- Passive income — earn 0.3% of every transaction your referrals make, for as long as you're both active
- Weekly reward pool — transact $50/week for a chance to win $10 every Sunday

Rules for writing messages:
- Keep it SHORT. Max 3-4 sentences. This is WhatsApp, not email.
- Sound like a real person, not a company. Use casual Kenyan English. Light slang is okay.
- Use the person's first name.
- Do NOT use bullet points or lists.
- Do NOT say "Hey [Name]!" — vary your greetings.
- Include ONE clear call to action.
- Do NOT use markdown formatting.
- Lightly use emojis, max 1-2 per message.
- Never mention that this message was AI-generated.
- When directing users to take any action (KYC, deposit, referrals, etc.), always include this link: https://wallet.riftfi.xyz
- Do NOT make up or promise any links other than https://wallet.riftfi.xyz — this is the only app link.`;

const CATEGORY_INSTRUCTIONS = {
  NO_KYC: `This user signed up but hasn't completed KYC. Gently nudge them to finish it. Mention it only takes 2 minutes. Emphasize they're missing out on saving in dollars and earning 10% APY. Make it feel like a friendly reminder, not pressure.`,

  KYC_NO_TRANSACTIONS: `This user completed KYC but hasn't transacted yet. Encourage them to make their first deposit. Mention they can start with as little as $5. Highlight that KES is losing value and their money is safer in dollars on Rift.`,

  KYC_LOW_ACTIVITY: `This user has made a few transactions. Encourage consistency. Mention the weekly reward pool ($10 every Sunday if you transact $50/week). Make them feel like they're almost there.`,

  ACTIVE_NO_REFERRALS: `This user is active but hasn't referred anyone. Push the referral program hard. Mention they can earn 0.3% on everything their referrals transact. Frame it as free passive income they're leaving on the table.`,

  ACTIVE_WITH_REFERRALS: `This user is active and has referred people. Celebrate their earnings so far. Encourage them to refer more. Mention that the more people they refer, the more passive income they earn. Make them feel like a VIP.`,

  DORMANT: `This user was active but hasn't transacted in over 30 days. Re-engage them. Mention how much KES has devalued recently. Remind them their Rift wallet is waiting. Keep it light and not guilt-trippy.`,
};

async function generateMessage(user) {
  const anthropic = getClient();
  const name = user.firstName || 'there';
  const lastActive = user.lastTxnDate
    ? user.lastTxnDate.toLocaleDateString('en-KE', { year: 'numeric', month: 'short', day: 'numeric' })
    : 'Never';
  const totalVolume = (user.onrampVolume + user.offrampVolume).toFixed(2);

  const userPrompt = `Generate a WhatsApp message for this Rift user:
Name: ${name}
Category: ${user.category}
Transactions: ${user.totalTxns} (${user.onrampCount} deposits, ${user.offrampCount} withdrawals)
Total volume: KES ${totalVolume}
Last active: ${lastActive}
Referrals: ${user.referralCount}
Referral earnings: KES ${user.referralEarningsKes.toFixed(2)}
${CATEGORY_INSTRUCTIONS[user.category]}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  return response.content[0].text.trim();
}

module.exports = { generateMessage };
