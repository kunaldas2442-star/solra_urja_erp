import { execSync, spawn } from 'child_process';
import net from 'net';
import fs from 'fs';
import path from 'path';

export interface DaemonDbConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
}

function resolveEnvDbConfig(overrides?: DaemonDbConfig) {
  return {
    host: (overrides?.host || process.env.DB_HOST || '127.0.0.1').trim(),
    port: Number(overrides?.port || process.env.DB_PORT || 3306),
    user: (overrides?.user || process.env.DB_USER || '').trim(),
    password: overrides?.password ?? process.env.DB_PASS ?? process.env.DB_PASSWORD ?? '',
    database: (overrides?.database || process.env.DB_NAME || '').trim()
  };
}

function isSafeIdentifier(val: string): boolean {
  return /^[a-zA-Z0-9_]+$/.test(val);
}

function escapeSqlLiteral(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function isPortOpen(port: number, host: string = '127.0.0.1', timeoutMs: number = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

function bootstrapDatabaseFromEnv(cfg: ReturnType<typeof resolveEnvDbConfig>): void {
  if (!cfg.database || !cfg.user || !cfg.password) {
    console.warn('[MySQL Supervisor] Skipping database user provisioning: DB_NAME, DB_USER, or DB_PASS not set.');
    return;
  }
  if (!isSafeIdentifier(cfg.database) || !isSafeIdentifier(cfg.user)) {
    console.warn('[MySQL Supervisor] Skipping database provisioning due to unsupported identifier characters.');
    return;
  }

  const escapedPass = escapeSqlLiteral(cfg.password);
  try {
    const setupSql = [
      `CREATE DATABASE IF NOT EXISTS \`${cfg.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
      `CREATE USER IF NOT EXISTS '${cfg.user}'@'localhost' IDENTIFIED BY '${escapedPass}';`,
      `CREATE USER IF NOT EXISTS '${cfg.user}'@'127.0.0.1' IDENTIFIED BY '${escapedPass}';`,
      `CREATE USER IF NOT EXISTS '${cfg.user}'@'%' IDENTIFIED BY '${escapedPass}';`,
      `ALTER USER '${cfg.user}'@'localhost' IDENTIFIED BY '${escapedPass}';`,
      `ALTER USER '${cfg.user}'@'127.0.0.1' IDENTIFIED BY '${escapedPass}';`,
      `ALTER USER '${cfg.user}'@'%' IDENTIFIED BY '${escapedPass}';`,
      `GRANT ALL PRIVILEGES ON \`${cfg.database}\`.* TO '${cfg.user}'@'localhost';`,
      `GRANT ALL PRIVILEGES ON \`${cfg.database}\`.* TO '${cfg.user}'@'127.0.0.1';`,
      `GRANT ALL PRIVILEGES ON \`${cfg.database}\`.* TO '${cfg.user}'@'%';`,
      'FLUSH PRIVILEGES;'
    ].join('\n');
    execSync('mysql', { input: setupSql, stdio: ['pipe', 'ignore', 'ignore'] });
    console.log(`[MySQL Supervisor] Verified database "${cfg.database}" & user privileges from environment.`);
  } catch (e: any) {
    console.warn('[MySQL Supervisor] Notice provisioning local DB user:', e?.message || e);
  }

  // Import database.sql ONLY if database currently has zero tables (non-destructive on existing DBs)
  try {
    const tableCheck = execSync('mysql -N -s', {
      input: `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '${escapeSqlLiteral(cfg.database)}';`,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();
    const existingCount = Number(tableCheck || '0');
    const dumpPath = path.join(process.cwd(), 'database.sql');
    if (existingCount === 0 && fs.existsSync(dumpPath)) {
      const dumpSql = fs.readFileSync(dumpPath, 'utf-8');
      execSync(`mysql \`${cfg.database}\``, { input: dumpSql, stdio: ['pipe', 'ignore', 'ignore'] });
      console.log(`[MySQL Supervisor] Applied baseline database.sql schema to empty database "${cfg.database}".`);
    }
  } catch (e: any) {
    console.warn('[MySQL Supervisor] Notice checking/applying baseline schema:', e?.message || e);
  }
}

export async function ensureLocalMySqlRunning(
  host: string = '127.0.0.1',
  port: number = 3306,
  overrides?: DaemonDbConfig
): Promise<boolean> {
  const cfg = resolveEnvDbConfig({ host, port, ...overrides });
  const isLocalHost = cfg.host === '127.0.0.1' || cfg.host === 'localhost' || cfg.host === '::1' || !cfg.host;

  if (!isLocalHost) {
    return isPortOpen(cfg.port, cfg.host, 3000);
  }

  // Check if MySQL/MariaDB is already responding
  if (await isPortOpen(cfg.port, '127.0.0.1')) {
    console.log(`[MySQL Supervisor] MySQL daemon already active on 127.0.0.1:${cfg.port}`);
    bootstrapDatabaseFromEnv(cfg);
    return true;
  }

  console.log(`[MySQL Supervisor] Port ${cfg.port} not active. Launching local MySQL/MariaDB service...`);

  const hasMysqld =
    fs.existsSync('/usr/sbin/mariadbd') ||
    fs.existsSync('/usr/bin/mariadbd-safe') ||
    fs.existsSync('/usr/bin/mysqld_safe') ||
    fs.existsSync('/usr/sbin/mysqld');
  if (!hasMysqld) {
    console.warn('[MySQL Supervisor] No local mysqld binary found in system paths.');
    return false;
  }

  // Ensure datadir and runtime socket directory exist with correct permissions
  const datadir = '/var/lib/mysql';
  try {
    if (!fs.existsSync('/run/mysqld')) {
      fs.mkdirSync('/run/mysqld', { recursive: true });
    }
    if (!fs.existsSync(datadir)) {
      fs.mkdirSync(datadir, { recursive: true });
    }
    try {
      execSync('chown -R mysql:mysql /run/mysqld /var/lib/mysql', { stdio: 'ignore' });
    } catch {
      try { execSync('useradd -r -s /bin/false mysql', { stdio: 'ignore' }); } catch {}
      try { execSync('chown -R mysql:mysql /run/mysqld /var/lib/mysql', { stdio: 'ignore' }); } catch {}
    }
  } catch {}

  if (!fs.existsSync(path.join(datadir, 'mysql'))) {
    console.log('[MySQL Supervisor] Initializing MariaDB system tables in /var/lib/mysql...');
    try {
      if (fs.existsSync('/usr/bin/mariadb-install-db')) {
        execSync('mariadb-install-db --user=mysql --datadir=/var/lib/mysql', { stdio: 'inherit' });
      } else if (fs.existsSync('/usr/bin/mysql_install_db')) {
        execSync('mysql_install_db --user=mysql --datadir=/var/lib/mysql', { stdio: 'inherit' });
      }
    } catch (e: any) {
      console.warn('[MySQL Supervisor] Notice during system tables initialization:', e?.message || e);
    }
  }

  const binary = fs.existsSync('/usr/bin/mariadbd-safe')
    ? '/usr/bin/mariadbd-safe'
    : fs.existsSync('/usr/bin/mysqld_safe')
      ? '/usr/bin/mysqld_safe'
      : '/usr/sbin/mariadbd';

  console.log(`[MySQL Supervisor] Starting daemon using ${binary}...`);
  try {
    const args = binary.includes('safe')
      ? ['--user=mysql', '--datadir=/var/lib/mysql', '--nowatch']
      : ['--user=mysql', '--datadir=/var/lib/mysql'];
    const child = spawn(binary, args, {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
  } catch (err: any) {
    console.error('[MySQL Supervisor] Error spawning daemon:', err?.message || err);
  }

  // Poll until MySQL accepts connections (up to 15 seconds)
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isPortOpen(cfg.port, '127.0.0.1')) {
      console.log(`[MySQL Supervisor] MySQL daemon successfully started and accepting connections on port ${cfg.port}!`);
      bootstrapDatabaseFromEnv(cfg);
      return true;
    }
  }

  console.error(`[MySQL Supervisor] Timeout: MySQL daemon did not start within 15 seconds.`);
  return false;
}
