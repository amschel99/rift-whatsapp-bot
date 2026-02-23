const { Pool } = require('pg');

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return pool;
}

async function fetchUsersWithDetails() {
  const db = getPool();

  const query = `
    WITH user_onramp AS (
      SELECT
        user_id,
        COUNT(*) AS onramp_count,
        COALESCE(SUM(CASE WHEN amount IS NOT NULL THEN amount::numeric ELSE 0 END), 0) AS onramp_volume,
        MAX(created_at) AS last_onramp
      FROM "OnrampOrder"
      WHERE LOWER(status) IN ('complete', 'completed')
      GROUP BY user_id
    ),
    user_offramp AS (
      SELECT
        user_id,
        COUNT(*) AS offramp_count,
        COALESCE(SUM(amount::numeric), 0) AS offramp_volume,
        MAX(created_at) AS last_offramp
      FROM "OfframpOrder"
      WHERE LOWER(status) IN ('complete', 'completed')
      GROUP BY user_id
    ),
    user_referrals AS (
      SELECT
        u.id AS user_id,
        COUNT(referred.id) AS referral_count
      FROM users u
      LEFT JOIN users referred ON referred.referrer = u.referral_code
      WHERE u.referral_code IS NOT NULL
      GROUP BY u.id
    ),
    user_referral_earnings AS (
      SELECT
        referrer_user_id AS user_id,
        SUM(amount_local) AS total_earnings_kes
      FROM referral_fee_entries
      GROUP BY referrer_user_id
    )
    SELECT
      u.id,
      u.display_name,
      u.phone_number,
      u.email,
      u.kyc_verified,
      u.kyc_verified_at,
      u.created_at,
      u.is_suspended,
      COALESCE(uo.onramp_count, 0)::int AS onramp_count,
      COALESCE(uo.onramp_volume, 0)::numeric AS onramp_volume,
      uo.last_onramp,
      COALESCE(uoff.offramp_count, 0)::int AS offramp_count,
      COALESCE(uoff.offramp_volume, 0)::numeric AS offramp_volume,
      uoff.last_offramp,
      COALESCE(ur.referral_count, 0)::int AS referral_count,
      COALESCE(ure.total_earnings_kes, 0)::numeric AS referral_earnings_kes
    FROM users u
    LEFT JOIN user_onramp uo ON uo.user_id = u.id
    LEFT JOIN user_offramp uoff ON uoff.user_id = u.id
    LEFT JOIN user_referrals ur ON ur.user_id = u.id
    LEFT JOIN user_referral_earnings ure ON ure.user_id = u.id
    WHERE u.phone_number IS NOT NULL
      AND u.is_suspended = false
    ORDER BY u.created_at DESC
  `;

  const result = await db.query(query);
  return result.rows;
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { fetchUsersWithDetails, closePool };
