/**
 * Demo data for local development. Idempotent: re-running leaves existing
 * users untouched. All demo accounts use the password "password123".
 *
 *   npm run seed                                   (host)
 *   docker compose exec server node dist/database/seed.js   (container)
 */
import { randomUUID } from 'node:crypto';
import { pool, query, queryOne, transaction } from './pool.js';
import { migrate } from './migrate.js';
import { hashPassword } from '../modules/auth/password.js';
import { directKey } from '../modules/conversations/service.js';
import { logger } from '../lib/logger.js';
import { isProd } from '../config/env.js';

if (isProd) {
  console.error('Refusing to seed demo data into a production database.');
  process.exit(1);
}

const PASSWORD = 'password123';
const people = [
  { phone: '+15550000001', name: 'Alice Rivera', about: 'Coffee first ☕' },
  { phone: '+15550000002', name: 'Bob Okafor', about: 'Available' },
  { phone: '+15550000003', name: 'Carol Nguyen', about: 'At the gym 🏋️' },
];

await migrate(pool);
const hash = await hashPassword(PASSWORD);
const ids: Record<string, string> = {};

for (const p of people) {
  const existing = await queryOne<{ id: string }>('SELECT id FROM users WHERE phone_number = $1', [p.phone]);
  if (existing) {
    ids[p.phone] = existing.id;
    continue;
  }
  ids[p.phone] = await transaction(async (tx) => {
    const u = await queryOne<{ id: string }>('INSERT INTO users (phone_number, name, about) VALUES ($1, $2, $3) RETURNING id', [p.phone, p.name, p.about], tx);
    await query('INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)', [u!.id, hash], tx);
    await query('INSERT INTO user_privacy (user_id) VALUES ($1)', [u!.id], tx);
    return u!.id;
  });
  logger.info({ phone: p.phone }, 'seed: created user');
}

const [alice, bob, carol] = people.map((p) => ids[p.phone]!) as [string, string, string];

// Everyone saved everyone (so 'contacts' privacy lets statuses through).
for (const a of [alice, bob, carol]) {
  for (const b of [alice, bob, carol]) {
    if (a !== b) await query('INSERT INTO contacts (owner_id, contact_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [a, b]);
  }
}

async function conversation(a: string, b: string, lines: [string, string][]) {
  const existing = await queryOne<{ id: string }>('SELECT id FROM conversations WHERE direct_key = $1', [directKey(a, b)]);
  if (existing) return;
  await transaction(async (tx) => {
    const c = await queryOne<{ id: string }>(
      `INSERT INTO conversations (type, direct_key, created_by, last_message_at) VALUES ('direct', $1, $2, now()) RETURNING id`,
      [directKey(a, b), a],
      tx,
    );
    await query('INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3)', [c!.id, a, b], tx);
    let minutesAgo = lines.length * 3;
    for (const [from, body] of lines) {
      const to = from === a ? b : a;
      const m = await queryOne<{ id: string }>(
        `INSERT INTO messages (conversation_id, sender_id, client_msg_id, body, created_at)
         VALUES ($1, $2, $3, $4, now() - make_interval(mins => $5)) RETURNING id`,
        [c!.id, from, randomUUID(), body, minutesAgo],
        tx,
      );
      await query(
        `INSERT INTO message_receipts (message_id, user_id, sender_id, status, delivered_at, read_at) VALUES ($1, $2, $3, 'read', now(), now())`,
        [m!.id, to, from],
        tx,
      );
      minutesAgo -= 3;
    }
    await query(
      `UPDATE conversation_members SET last_read_seq = (SELECT max(order_seq) FROM messages WHERE conversation_id = $1) WHERE conversation_id = $1`,
      [c!.id],
      tx,
    );
  });
  logger.info('seed: created conversation');
}

await conversation(alice, bob, [
  [alice, 'Hey Bob! 👋'],
  [bob, 'Hi Alice, how was the trip?'],
  [alice, 'Amazing. Photos coming soon 📷'],
  [bob, "Can't wait!"],
]);
await conversation(alice, carol, [
  [carol, 'Lunch tomorrow?'],
  [alice, 'Yes! 12:30 at the usual place?'],
  [carol, 'Perfect 👍'],
]);

const hasStatus = await queryOne(`SELECT 1 FROM status_updates WHERE user_id = $1 AND expires_at > now()`, [bob]);
if (!hasStatus) {
  await query(`INSERT INTO status_updates (user_id, type, text, bg_color) VALUES ($1, 'text', $2, '#0e7490')`, [bob, 'Working on something new 🚀']);
}

logger.info('seed: done');
console.log(`\nDemo users (password "${PASSWORD}"):\n${people.map((p) => `  ${p.phone}  ${p.name}`).join('\n')}\n`);
await pool.end();
process.exit(0);
