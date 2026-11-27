import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import { ensureLocalMySqlRunning } from '../server/mysqlDaemon';
import { authService } from '../server/services/authService';
import { syncDefaultAuthAccounts } from '../server/services/defaultAuthAccounts';

async function main() {
  const host = (process.env.DB_HOST || '127.0.0.1').trim();
  const port = Number(process.env.DB_PORT) || 3306;
  const user = (process.env.DB_USER || '').trim();
  const password = process.env.DB_PASS ?? process.env.DB_PASSWORD ?? '';
  const database = (process.env.DB_NAME || '').trim();

  if (!user || !database) {
    console.error('[Auth Migration] Missing DB_USER or DB_NAME in environment/.env. Aborting without fallback.');
    process.exit(1);
  }

  const isLocalHost = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (isLocalHost) {
    const started = await ensureLocalMySqlRunning(host, port, { host, port, user, password, database });
    if (!started) {
      console.error('[Auth Migration] Local MySQL/MariaDB daemon could not be started.');
      process.exit(1);
    }
  }

  const pool = mysql.createPool({
    host,
    port,
    user,
    password,
    database,
    charset: 'utf8mb4_unicode_ci',
    waitForConnections: true,
    connectionLimit: 5,
    multipleStatements: true,
    connectTimeout: 5000
  });

  try {
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();

    // Ensure baseline schema tables exist if database was empty
    const [existingTables]: any = await pool.query('SHOW TABLES');
    if (!Array.isArray(existingTables) || existingTables.length === 0) {
      const dumpPath = path.join(process.cwd(), 'database.sql');
      if (fs.existsSync(dumpPath)) {
        const sql = fs.readFileSync(dumpPath, 'utf-8');
        await pool.query(sql);
        console.log('[Auth Migration] Applied baseline schema from database.sql.');
      }
    }

    // Apply idempotent auth schema migration SQL
    const migPath = path.join(process.cwd(), 'migrations', '2026_11_27_sync_default_auth_accounts.sql');
    if (fs.existsSync(migPath)) {
      const migSql = fs.readFileSync(migPath, 'utf-8');
      await pool.query(migSql);
    }

    // Upgrade any legacy plaintext passwords in solar_users or solar_customers to bcrypt
    const [legacyUsers]: any = await pool.query('SELECT id, password FROM `solar_users`');
    let upgradedHashes = 0;
    for (const u of Array.isArray(legacyUsers) ? legacyUsers : []) {
      const pw = String(u.password || '');
      if (pw && !pw.startsWith('$2a$') && !pw.startsWith('$2b$') && !pw.startsWith('$2y$')) {
        const hashed = await bcrypt.hash(pw, 10);
        await pool.query('UPDATE `solar_users` SET `password` = ? WHERE `id` = ?', [hashed, u.id]);
        upgradedHashes++;
      }
    }

    // Initialize centralized auth tables and sync missing default accounts idempotently
    await authService.initAuthSchema(pool);
    const result = await syncDefaultAuthAccounts(pool);

    console.log('[Auth Migration] Completed idempotent MySQL auth synchronization:');
    console.log(
      JSON.stringify(
        {
          totalDefaultRoles: result.total,
          createdUsers: result.createdUsers,
          existingUsersPreserved: result.existingUsers,
          createdCredentials: result.createdCredentials,
          existingCredentialsPreserved: result.existingCredentials,
          upgradedLegacyHashes: upgradedHashes,
          accounts: result.accounts
        },
        null,
        2
      )
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[Auth Migration] Fatal error:', err?.message || err);
  process.exit(1);
});
