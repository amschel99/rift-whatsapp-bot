const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const CATEGORIES = {
  NO_KYC: 'NO_KYC',
  KYC_NO_TRANSACTIONS: 'KYC_NO_TRANSACTIONS',
  KYC_LOW_ACTIVITY: 'KYC_LOW_ACTIVITY',
  ACTIVE_NO_REFERRALS: 'ACTIVE_NO_REFERRALS',
  ACTIVE_WITH_REFERRALS: 'ACTIVE_WITH_REFERRALS',
  DORMANT: 'DORMANT',
};

function categorizeUser(user) {
  const totalTxns = user.onramp_count + user.offramp_count;
  const lastTxnDate = user.last_onramp && user.last_offramp
    ? new Date(Math.max(new Date(user.last_onramp), new Date(user.last_offramp)))
    : user.last_onramp
      ? new Date(user.last_onramp)
      : user.last_offramp
        ? new Date(user.last_offramp)
        : null;

  const daysSinceLastTxn = lastTxnDate
    ? (Date.now() - lastTxnDate.getTime()) / (1000 * 60 * 60 * 24)
    : null;

  // Not KYC verified
  if (!user.kyc_verified) {
    return CATEGORIES.NO_KYC;
  }

  // KYC verified but zero transactions
  if (totalTxns === 0) {
    return CATEGORIES.KYC_NO_TRANSACTIONS;
  }

  // Was active (4+ txns) but dormant for 30+ days
  if (totalTxns >= 4 && daysSinceLastTxn !== null && daysSinceLastTxn > 30) {
    return CATEGORIES.DORMANT;
  }

  // Low activity: 1-3 transactions
  if (totalTxns >= 1 && totalTxns <= 3) {
    return CATEGORIES.KYC_LOW_ACTIVITY;
  }

  // Active (4+ txns), check referrals
  if (totalTxns >= 4) {
    if (user.referral_count > 0) {
      return CATEGORIES.ACTIVE_WITH_REFERRALS;
    }
    return CATEGORIES.ACTIVE_NO_REFERRALS;
  }

  return CATEGORIES.NO_KYC; // fallback
}

function categorizeAllUsers(users) {
  return users.map(user => {
    const totalTxns = user.onramp_count + user.offramp_count;
    const lastTxnDate = user.last_onramp && user.last_offramp
      ? new Date(Math.max(new Date(user.last_onramp), new Date(user.last_offramp)))
      : user.last_onramp
        ? new Date(user.last_onramp)
        : user.last_offramp
          ? new Date(user.last_offramp)
          : null;

    const firstName = extractFirstName(user.display_name);

    return {
      id: user.id,
      firstName,
      phoneNumber: user.phone_number,
      email: user.email,
      kycVerified: user.kyc_verified,
      totalTxns,
      onrampCount: user.onramp_count,
      offrampCount: user.offramp_count,
      onrampVolume: parseFloat(user.onramp_volume) || 0,
      offrampVolume: parseFloat(user.offramp_volume) || 0,
      lastTxnDate,
      referralCount: user.referral_count,
      referralEarningsKes: parseFloat(user.referral_earnings_kes) || 0,
      category: categorizeUser(user),
    };
  });
}

function extractFirstName(displayName) {
  if (!displayName || displayName.trim() === '') return null;
  return displayName.trim().split(/\s+/)[0];
}

function printCategorySummary(categorizedUsers) {
  const summary = {};
  for (const cat of Object.values(CATEGORIES)) {
    summary[cat] = categorizedUsers.filter(u => u.category === cat).length;
  }
  console.log('\n--- User Category Summary ---');
  for (const [cat, count] of Object.entries(summary)) {
    console.log(`  ${cat}: ${count}`);
  }
  console.log(`  TOTAL: ${categorizedUsers.length}\n`);
  return summary;
}

module.exports = { CATEGORIES, categorizeAllUsers, printCategorySummary };
