import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';
import { Request, Response } from 'express';

export type AccountType = 'ADMIN' | 'EMPLOYEE' | 'CUSTOMER';

export interface AuthCredentialRecord {
  id: string;
  user_id: string;
  email: string;
  password_hash: string;
  role: string;
  account_type: AccountType;
  linked_entity_id?: string | null;
  must_change_password?: number | boolean;
  status: string;
  failed_login_attempts: number;
  last_login_at?: string | null;
  password_changed_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface SanitizedUser {
  id: string;
  userId: string;
  employeeId?: string;
  customerId?: string;
  name: string;
  email: string;
  role: string;
  phone?: string;
  department?: string;
  designation?: string;
  isFieldWorker: boolean;
  mustChangePassword?: boolean;
  accountType: AccountType;
  status: string;
}

export class AuthService {
  private static instance: AuthService;

  public static getInstance(): AuthService {
    if (!AuthService.instance) {
      AuthService.instance = new AuthService();
    }
    return AuthService.instance;
  }

  /**
   * Safe bcrypt hashing with cost factor 10
   */
  public async hashPassword(password: string): Promise<string> {
    const clean = String(password || '').trim();
    if (!clean) {
      throw new Error('Password cannot be empty.');
    }
    if (clean.startsWith('$2a$') || clean.startsWith('$2b$') || clean.startsWith('$2y$') || clean.startsWith('$argon2id$')) {
      return clean;
    }
    return bcrypt.hash(clean, 10);
  }

  /**
   * Password verification comparing plaintext against bcrypt hash
   */
  public async verifyPassword(plain: string, hash: string): Promise<boolean> {
    const clean = String(plain || '').trim();
    if (!clean || !hash) return false;
    if (hash.startsWith('$2a$') || hash.startsWith('$2b$') || hash.startsWith('$2y$')) {
      return bcrypt.compare(clean, hash);
    }
    return false;
  }

  /**
   * Initializes MySQL tables for centralized auth credentials and server sessions
   */
  public async initAuthSchema(pool: mysql.Pool): Promise<void> {
    try {
      // 1. Create centralized credentials table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS \`solar_auth_credentials\` (
          \`id\` VARCHAR(64) PRIMARY KEY,
          \`user_id\` VARCHAR(64) NOT NULL UNIQUE,
          \`email\` VARCHAR(191) NOT NULL UNIQUE,
          \`password_hash\` VARCHAR(255) NOT NULL,
          \`role\` VARCHAR(64) NOT NULL,
          \`account_type\` ENUM('ADMIN', 'EMPLOYEE', 'CUSTOMER') NOT NULL,
          \`linked_entity_id\` VARCHAR(64) DEFAULT NULL,
          \`must_change_password\` TINYINT(1) NOT NULL DEFAULT 0,
          \`status\` VARCHAR(32) DEFAULT 'ACTIVE',
          \`failed_login_attempts\` INT DEFAULT 0,
          \`last_login_at\` TIMESTAMP NULL DEFAULT NULL,
          \`password_changed_at\` TIMESTAMP NULL DEFAULT NULL,
          \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX \`idx_auth_cred_role\` (\`role\`),
          INDEX \`idx_auth_cred_type\` (\`account_type\`),
          INDEX \`idx_auth_cred_linked\` (\`linked_entity_id\`),
          INDEX \`idx_auth_cred_status\` (\`status\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      try {
        const [credCols]: any = await pool.query("SHOW COLUMNS FROM `solar_auth_credentials` LIKE 'must_change_password'");
        if (!Array.isArray(credCols) || credCols.length === 0) {
          await pool.query('ALTER TABLE `solar_auth_credentials` ADD COLUMN `must_change_password` TINYINT(1) NOT NULL DEFAULT 0 AFTER `linked_entity_id`');
        }
      } catch {}

      // 2. Create server-managed session storage table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS \`solar_auth_sessions\` (
          \`id\` VARCHAR(128) PRIMARY KEY,
          \`user_id\` VARCHAR(64) NOT NULL,
          \`email\` VARCHAR(191) NOT NULL,
          \`role\` VARCHAR(64) NOT NULL,
          \`account_type\` VARCHAR(32) NOT NULL,
          \`linked_entity_id\` VARCHAR(64) DEFAULT NULL,
          \`ip_address\` VARCHAR(64) DEFAULT NULL,
          \`user_agent\` TEXT DEFAULT NULL,
          \`expires_at\` TIMESTAMP NOT NULL,
          \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          \`last_active_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX \`idx_auth_sess_user_id\` (\`user_id\`),
          INDEX \`idx_auth_sess_expires_at\` (\`expires_at\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      console.log('[Auth Service] Centralized auth tables verified (solar_auth_credentials, solar_auth_sessions).');

      // 3. Migrate and synchronize existing accounts into solar_auth_credentials
      await this.migrateExistingAccounts(pool);
    } catch (err: any) {
      console.error('[Auth Service] Schema initialization notice:', err?.message || err);
      throw err;
    }
  }

  /**
   * Migrate existing solar_users, solar_employee, and solar_customers into solar_auth_credentials
   */
  public async migrateExistingAccounts(pool: mysql.Pool): Promise<void> {
    try {
      let migratedUsers = 0;
      let migratedEmployees = 0;
      let migratedCustomers = 0;

      // Migrate from solar_users
      try {
        const [users]: any = await pool.query('SELECT * FROM `solar_users`');
        if (Array.isArray(users)) {
          for (const u of users) {
            if (!u.email || !u.password) continue;
            const email = String(u.email).trim().toLowerCase();
            const rawPass = String(u.password);
            const passwordHash = await this.hashPassword(rawPass);
            if (rawPass !== passwordHash) {
              await pool.query('UPDATE `solar_users` SET `password` = ? WHERE `id` = ?', [passwordHash, u.id]).catch(() => {});
            }
            const accountType: AccountType = (u.role === 'Customer') ? 'CUSTOMER' : (u.role === 'Admin' || u.role === 'Super Admin') ? 'ADMIN' : 'EMPLOYEE';
            const linkedEntityId = u.employee_id || u.customer_id || u.id;
            const status = u.status === 'DISABLED' || u.status === 'INACTIVE' ? 'DISABLED' : 'ACTIVE';
            const mustChange = u.must_change_password ? 1 : 0;

            const [existingCred]: any = await pool.query(
              'SELECT `id`, `password_hash` FROM `solar_auth_credentials` WHERE `user_id` = ? OR LOWER(`email`) = ? LIMIT 1',
              [u.id, email]
            );

            if (!Array.isArray(existingCred) || existingCred.length === 0) {
              await pool.query(`
                INSERT IGNORE INTO \`solar_auth_credentials\` (
                  \`id\`, \`user_id\`, \`email\`, \`password_hash\`, \`role\`,
                  \`account_type\`, \`linked_entity_id\`, \`must_change_password\`, \`status\`
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              `, [
                `cred-${u.id}`,
                u.id,
                email,
                passwordHash,
                u.role || 'Admin',
                accountType,
                linkedEntityId,
                mustChange,
                status
              ]);
              migratedUsers++;
            }
          }
        }
      } catch (err: any) {
        console.warn('[Auth Service] Notice migrating users to credentials:', err.message);
      }

      // Migrate from solar_employees (and fallback to solar_employee) — skip accounts without explicit password
      try {
        let employees: any[] = [];
        try {
          const [empRows]: any = await pool.query('SELECT * FROM `solar_employees`');
          if (Array.isArray(empRows)) employees = empRows;
        } catch {}
        if (employees.length === 0) {
          try {
            const [empRowsOld]: any = await pool.query('SELECT * FROM `solar_employee`');
            if (Array.isArray(empRowsOld)) employees = empRowsOld;
          } catch {}
        }
        if (Array.isArray(employees)) {
          for (const emp of employees) {
            if (!emp.email) continue;
            // Respect login_enabled and disabled statuses — never auto-provision credentials for disabled or login-disabled employees
            const isLoginDisabled = emp.login_enabled === 0 || emp.login_enabled === false || emp.status === 'INACTIVE' || emp.status === 'TERMINATED' || emp.account_status === 'DISABLED';
            if (isLoginDisabled && !emp.password) continue;

            // Only migrate employee rows that explicitly have a password OR already have a corresponding solar_users record
            let hasUserRow = false;
            try {
              const [uCheck]: any = await pool.query(
                'SELECT id FROM `solar_users` WHERE `id` = ? OR `employee_id` = ? OR LOWER(`email`) = ? LIMIT 1',
                [emp.id, emp.employee_code || emp.id, String(emp.email).trim().toLowerCase()]
              );
              hasUserRow = Array.isArray(uCheck) && uCheck.length > 0;
            } catch {}

            if (!emp.password && !hasUserRow) continue;

            const email = String(emp.email).trim().toLowerCase();
            // Do not overwrite or assign a weak static password; generate unguessable random secret if employee row lacks password
            const rawEmpPass = emp.password ? String(emp.password) : `${emp.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const role = emp.system_role || emp.assigned_role || emp.designation || 'Technician';
            const accountType: AccountType = (role === 'Admin' || role === 'Super Admin') ? 'ADMIN' : 'EMPLOYEE';
            const status = isLoginDisabled ? 'DISABLED' : 'ACTIVE';
            const passwordHash = await this.hashPassword(rawEmpPass);

            const [existingCred]: any = await pool.query(
              'SELECT id FROM `solar_auth_credentials` WHERE `user_id` = ? OR LOWER(`email`) = ? LIMIT 1',
              [emp.id, email]
            );
            if (!Array.isArray(existingCred) || existingCred.length === 0) {
              await pool.query(`
                INSERT IGNORE INTO \`solar_auth_credentials\` (
                  \`id\`, \`user_id\`, \`email\`, \`password_hash\`, \`role\`,
                  \`account_type\`, \`linked_entity_id\`, \`status\`
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              `, [
                `cred-${emp.id}`,
                emp.id,
                email,
                passwordHash,
                role,
                accountType,
                emp.id,
                status
              ]);
              migratedEmployees++;
            }
          }
        }
      } catch (err: any) {
        console.warn('[Auth Service] Notice migrating employees to credentials:', err.message);
      }

      // Migrate from solar_customers
      try {
        const [customers]: any = await pool.query('SELECT * FROM `solar_customers`');
        if (Array.isArray(customers)) {
          for (const c of customers) {
            if (!c.email || !c.password) continue;
            const email = String(c.email).trim().toLowerCase();
            const rawPass = String(c.password);
            const passwordHash = await this.hashPassword(rawPass);
            const status = c.status === 'INACTIVE' ? 'DISABLED' : 'ACTIVE';

            await pool.query(`
              INSERT IGNORE INTO \`solar_auth_credentials\` (
                \`id\`, \`user_id\`, \`email\`, \`password_hash\`, \`role\`,
                \`account_type\`, \`linked_entity_id\`, \`must_change_password\`, \`status\`
              ) VALUES (?, ?, ?, ?, 'Customer', 'CUSTOMER', ?, 0, ?)
            `, [
              `cred-cust-${c.id}`,
              `usr-${c.id}`,
              email,
              passwordHash,
              c.id,
              status
            ]);
            migratedCustomers++;
          }
        }
      } catch (err: any) {
        console.warn('[Auth Service] Notice migrating customers to credentials:', err.message);
      }

      console.log(`[Auth Service] Completed credential sync: ${migratedUsers} users, ${migratedEmployees} employees, ${migratedCustomers} customers synced to solar_auth_credentials.`);
    } catch (e: any) {
      console.warn('[Auth Service] Migration notice:', e?.message || e);
    }
  }

  /**
   * Create or update a credential record in solar_auth_credentials
   */
  public async setCredential(pool: mysql.Pool, data: {
    userId: string;
    email: string;
    password?: string;
    role: string;
    accountType: AccountType;
    linkedEntityId?: string | null;
    mustChangePassword?: boolean;
    status?: string;
  }): Promise<void> {
    const cleanEmail = data.email.trim().toLowerCase();
    const status = data.status || 'ACTIVE';
    const mustChangeFlag = data.mustChangePassword ? 1 : 0;

    if (data.password) {
      const passwordHash = await this.hashPassword(data.password);
      await pool.query(`
        INSERT INTO \`solar_auth_credentials\` (
          \`id\`, \`user_id\`, \`email\`, \`password_hash\`, \`role\`,
          \`account_type\`, \`linked_entity_id\`, \`must_change_password\`, \`status\`
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          \`email\` = VALUES(\`email\`),
          \`password_hash\` = VALUES(\`password_hash\`),
          \`role\` = VALUES(\`role\`),
          \`account_type\` = VALUES(\`account_type\`),
          \`linked_entity_id\` = VALUES(\`linked_entity_id\`),
          \`must_change_password\` = VALUES(\`must_change_password\`),
          \`status\` = VALUES(\`status\`),
          \`password_changed_at\` = NOW()
      `, [
        `cred-${data.userId}`,
        data.userId,
        cleanEmail,
        passwordHash,
        data.role,
        data.accountType,
        data.linkedEntityId || data.userId,
        mustChangeFlag,
        status
      ]);
    } else {
      await pool.query(`
        UPDATE \`solar_auth_credentials\`
        SET \`email\` = ?, \`role\` = ?, \`account_type\` = ?, \`linked_entity_id\` = ?, \`status\` = ?
        WHERE \`user_id\` = ? OR \`email\` = ?
      `, [
        cleanEmail,
        data.role,
        data.accountType,
        data.linkedEntityId || data.userId,
        status,
        data.userId,
        cleanEmail
      ]);
    }
  }

  /**
   * Authenticate email and password against solar_auth_credentials
   */
  public async authenticate(pool: mysql.Pool, email: string, pass: string, clientInfo?: { ip?: string; userAgent?: string }): Promise<{
    user: SanitizedUser;
    sessionToken: string;
  } | null> {
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanPass = String(pass || '').trim();

    if (!cleanEmail || !cleanPass) return null;

    const [rows]: any = await pool.query(
      'SELECT * FROM `solar_auth_credentials` WHERE LOWER(`email`) = ? LIMIT 1',
      [cleanEmail]
    );

    if (!Array.isArray(rows) || rows.length === 0) {
      return null;
    }

    const cred: AuthCredentialRecord = rows[0];

    // Check account status
    const credStatusUpper = String(cred.status || 'ACTIVE').trim().toUpperCase();
    if (['DISABLED', 'INACTIVE', 'TERMINATED', 'SUSPENDED'].includes(credStatusUpper)) {
      throw new Error('This account has been disabled. Please contact system administrator.');
    }

    // Verify password with bcrypt
    const isMatch = await this.verifyPassword(cleanPass, cred.password_hash);
    if (!isMatch) {
      // Increment failed attempts
      await pool.query(
        'UPDATE `solar_auth_credentials` SET `failed_login_attempts` = `failed_login_attempts` + 1 WHERE `id` = ?',
        [cred.id]
      ).catch(() => {});
      return null;
    }

    // Build unified user profile from authoritative tables and verify entity-level active status
    const userProfile = await this.fetchUserProfile(pool, cred);
    if (['DISABLED', 'INACTIVE', 'TERMINATED', 'SUSPENDED'].includes(String(userProfile.status || 'ACTIVE').toUpperCase())) {
      throw new Error('This account has been disabled. Please contact system administrator.');
    }

    // Upgrade hash if legacy plaintext was detected
    if (!cred.password_hash.startsWith('$2a$') && !cred.password_hash.startsWith('$2b$') && !cred.password_hash.startsWith('$2y$')) {
      const upgradedHash = await this.hashPassword(cleanPass);
      await pool.query(
        'UPDATE `solar_auth_credentials` SET `password_hash` = ?, `failed_login_attempts` = 0, `last_login_at` = NOW() WHERE `id` = ?',
        [upgradedHash, cred.id]
      ).catch(() => {});
    } else {
      await pool.query(
        'UPDATE `solar_auth_credentials` SET `failed_login_attempts` = 0, `last_login_at` = NOW() WHERE `id` = ?',
        [cred.id]
      ).catch(() => {});
    }

    // Create server-managed session in solar_auth_sessions
    const sessionToken = await this.createSession(pool, {
      userId: userProfile.id || cred.user_id,
      email: cred.email,
      role: userProfile.role || cred.role,
      accountType: cred.account_type,
      linkedEntityId: cred.linked_entity_id,
      ipAddress: clientInfo?.ip,
      userAgent: clientInfo?.userAgent
    });

    return {
      user: userProfile,
      sessionToken
    };
  }

  /**
   * Fetch full user profile from linked table
   */
  public async fetchUserProfile(pool: mysql.Pool, cred: AuthCredentialRecord): Promise<SanitizedUser> {
    const isFieldWorkerRole = [
      'Site Survey Engineer',
      'Site Inspector',
      'Civil Team',
      'Structure Team',
      'Installation Team',
      'Electrical Team',
      'Technician'
    ].includes(cred.role);

    const resolveCustomer = async (): Promise<SanitizedUser | null> => {
      const custId = String(cred.linked_entity_id || cred.user_id || '').replace(/^usr-/, '');
      const [cRows]: any = await pool.query(
        'SELECT * FROM `solar_customers` WHERE `id` = ? OR `id` = ? OR LOWER(`email`) = ? LIMIT 1',
        [custId, cred.user_id, cred.email]
      );
      if (Array.isArray(cRows) && cRows.length > 0) {
        const c = cRows[0];
        const rawCid = String(c.id).replace(/^usr-/, '');
        return {
          id: `usr-${rawCid}`,
          userId: `usr-${rawCid}`,
          customerId: c.id,
          employeeId: `CUST-${c.id}`,
          name: c.name,
          email: c.email,
          role: 'Customer',
          phone: c.phone || '',
          department: 'Customer Portal',
          designation: 'Customer',
          isFieldWorker: false,
          accountType: 'CUSTOMER',
          status: c.status || 'ACTIVE'
        };
      }
      return null;
    };

    const resolveEmployee = async (): Promise<SanitizedUser | null> => {
      const empId = cred.linked_entity_id || cred.user_id;
      let eRows: any[] = [];
      try {
        const [rows]: any = await pool.query(
          'SELECT * FROM `solar_employees` WHERE `id` = ? OR `id` = ? OR `auth_uid` = ? OR LOWER(`email`) = ? LIMIT 1',
          [empId, cred.user_id, cred.user_id, cred.email]
        );
        if (Array.isArray(rows) && rows.length > 0) eRows = rows;
      } catch {}

      if (eRows.length === 0) {
        try {
          const [rowsOld]: any = await pool.query(
            'SELECT * FROM `solar_employee` WHERE `id` = ? OR `id` = ? OR `auth_uid` = ? OR LOWER(`email`) = ? LIMIT 1',
            [empId, cred.user_id, cred.user_id, cred.email]
          );
          if (Array.isArray(rowsOld) && rowsOld.length > 0) eRows = rowsOld;
        } catch {}
      }

      if (Array.isArray(eRows) && eRows.length > 0) {
        const e = eRows[0];
        const isDisabledEmp = e.login_enabled === 0 || e.login_enabled === false
          || ['DISABLED', 'INACTIVE', 'TERMINATED'].includes(String(e.status || 'ACTIVE').toUpperCase())
          || String(e.account_status || 'ACTIVE').toUpperCase() === 'DISABLED';
        return {
          id: e.id,
          userId: e.auth_uid || cred.user_id,
          employeeId: e.employee_code || e.id,
          name: e.name,
          email: e.email,
          role: cred.role || e.system_role || e.designation || 'Technician',
          phone: e.phone || '',
          department: e.department || 'Operations',
          designation: e.designation || cred.role,
          isFieldWorker: Boolean(e.is_field_worker || isFieldWorkerRole),
          accountType: cred.account_type,
          status: isDisabledEmp ? 'DISABLED' : (e.status || 'ACTIVE')
        };
      }
      return null;
    };

    const resolveUser = async (): Promise<SanitizedUser | null> => {
      const [uRows]: any = await pool.query(
        'SELECT * FROM `solar_users` WHERE `id` = ? OR LOWER(`email`) = ? LIMIT 1',
        [cred.user_id, cred.email]
      );
      if (Array.isArray(uRows) && uRows.length > 0) {
        const u = uRows[0];
        return {
          id: u.id,
          userId: u.id,
          employeeId: u.employee_id || u.id,
          name: u.name,
          email: u.email,
          role: cred.role || u.role,
          phone: u.phone || '',
          department: u.department || 'Administration',
          designation: u.designation || cred.role,
          isFieldWorker: Boolean(u.is_field_worker || isFieldWorkerRole),
          accountType: cred.account_type,
          status: u.status || 'ACTIVE'
        };
      }
      return null;
    };

    const mustChangePassword = Boolean(cred.must_change_password);
    const withMustChange = (profile: SanitizedUser): SanitizedUser => ({
      ...profile,
      mustChangePassword
    });

    if (cred.account_type === 'CUSTOMER') {
      const cProf = await resolveCustomer();
      if (cProf) return withMustChange(cProf);
      const uProf = await resolveUser();
      if (uProf) return withMustChange(uProf);
    } else if (cred.account_type === 'ADMIN') {
      const uProf = await resolveUser();
      if (uProf) return withMustChange(uProf);
      const eProf = await resolveEmployee();
      if (eProf) return withMustChange(eProf);
    } else {
      const eProf = await resolveEmployee();
      if (eProf) return withMustChange(eProf);
      const uProf = await resolveUser();
      if (uProf) return withMustChange(uProf);
    }

    // Default fallback from credential record
    return {
      id: cred.user_id,
      userId: cred.user_id,
      name: cred.email.split('@')[0],
      email: cred.email,
      role: cred.role,
      isFieldWorker: isFieldWorkerRole,
      mustChangePassword,
      accountType: cred.account_type,
      status: cred.status
    };
  }

  /**
   * Create server session in solar_auth_sessions
   */
  public async createSession(pool: mysql.Pool, data: {
    userId: string;
    email: string;
    role: string;
    accountType: string;
    linkedEntityId?: string | null;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<string> {
    const sessionToken = crypto.randomBytes(32).toString('hex');

    // Use MySQL's authoritative clock to prevent UTC vs local timezone mismatch
    await pool.query(`
      INSERT INTO \`solar_auth_sessions\` (
        \`id\`, \`user_id\`, \`email\`, \`role\`, \`account_type\`,
        \`linked_entity_id\`, \`ip_address\`, \`user_agent\`, \`expires_at\`
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 14 DAY))
    `, [
      sessionToken,
      data.userId,
      data.email.toLowerCase(),
      data.role,
      data.accountType,
      data.linkedEntityId || null,
      data.ipAddress || null,
      data.userAgent || null
    ]);

    return sessionToken;
  }

  /**
   * Validate server session from solar_auth_sessions
   */
  public async validateSession(pool: mysql.Pool, sessionToken: string): Promise<{ valid: boolean; user?: SanitizedUser; error?: string }> {
    if (!sessionToken || typeof sessionToken !== 'string') {
      return { valid: false, error: 'No session token provided.' };
    }

    const cleanToken = sessionToken.trim();
    const [rows]: any = await pool.query(
      'SELECT *, UNIX_TIMESTAMP(`expires_at`) AS `expires_unix`, UNIX_TIMESTAMP(NOW()) AS `now_unix` FROM `solar_auth_sessions` WHERE `id` = ? LIMIT 1',
      [cleanToken]
    );

    if (!Array.isArray(rows) || rows.length === 0) {
      return { valid: false, error: 'Session not found or expired.' };
    }

    const sess = rows[0];
    const expiresUnix = Number(sess.expires_unix || 0);
    const nowUnix = Number(sess.now_unix || 0);

    if (expiresUnix > 0 && nowUnix > 0 && nowUnix > expiresUnix) {
      await pool.query('DELETE FROM `solar_auth_sessions` WHERE `id` = ?', [cleanToken]).catch(() => {});
      return { valid: false, error: 'Session has expired.' };
    }

    // Touch last_active_at
    await pool.query('UPDATE `solar_auth_sessions` SET `last_active_at` = NOW() WHERE `id` = ?', [cleanToken]).catch(() => {});

    // Require an authoritative record in solar_auth_credentials (no synthetic session fallback)
    const [credRows]: any = await pool.query(
      'SELECT * FROM `solar_auth_credentials` WHERE `user_id` = ? OR LOWER(`email`) = ? LIMIT 1',
      [sess.user_id, String(sess.email || '').toLowerCase()]
    );

    if (!Array.isArray(credRows) || credRows.length === 0) {
      return { valid: false, error: 'Account credentials not found in MySQL.' };
    }

    const cred: AuthCredentialRecord = credRows[0];

    if (['DISABLED', 'INACTIVE', 'TERMINATED', 'SUSPENDED'].includes(String(cred.status || 'ACTIVE').toUpperCase())) {
      return { valid: false, error: 'Account has been disabled.' };
    }

    const userProfile = await this.fetchUserProfile(pool, cred);
    if (['DISABLED', 'INACTIVE', 'TERMINATED', 'SUSPENDED'].includes(String(userProfile.status || 'ACTIVE').toUpperCase())) {
      return { valid: false, error: 'Account has been disabled.' };
    }

    return { valid: true, user: userProfile };
  }

  /**
   * Destroy server session on logout
   */
  public async destroySession(pool: mysql.Pool, sessionToken: string): Promise<boolean> {
    if (!sessionToken) return true;
    try {
      await pool.query('DELETE FROM `solar_auth_sessions` WHERE `id` = ?', [sessionToken.trim()]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Securely update password with bcrypt hash
   */
  public async updatePassword(pool: mysql.Pool, userIdOrEmail: string, newPass: string): Promise<boolean> {
    const cleanPass = String(newPass || '').trim();
    if (!cleanPass || cleanPass.length < 6) {
      throw new Error('New password must be at least 6 characters in length.');
    }

    const passwordHash = await this.hashPassword(cleanPass);
    const idOrEmail = String(userIdOrEmail).trim().toLowerCase();

    // 1. Update solar_auth_credentials and clear mandatory password change flag
    await pool.query(`
      UPDATE \`solar_auth_credentials\`
      SET \`password_hash\` = ?, \`must_change_password\` = 0, \`password_changed_at\` = NOW()
      WHERE \`user_id\` = ? OR LOWER(\`email\`) = ?
    `, [passwordHash, idOrEmail, idOrEmail]);

    // 2. Synchronize to solar_users if exists
    await pool.query(`
      UPDATE \`solar_users\`
      SET \`password\` = ?, \`must_change_password\` = 0
      WHERE \`id\` = ? OR LOWER(\`email\`) = ?
    `, [passwordHash, idOrEmail, idOrEmail]).catch(() => {});

    // 3. Synchronize to solar_customers if exists
    await pool.query(`
      UPDATE \`solar_customers\`
      SET \`password\` = ?
      WHERE \`id\` = ? OR LOWER(\`email\`) = ?
    `, [passwordHash, idOrEmail.replace(/^usr-/, ''), idOrEmail]).catch(() => {});

    return true;
  }

  /**
   * Robust detection of HTTPS and Cloud Run / proxy environments
   */
  public isSecureRequest(req: Request): boolean {
    if (req.secure) return true;
    if (req.protocol === 'https') return true;
    const proto = String(req.headers['x-forwarded-proto'] || '');
    if (proto.toLowerCase().includes('https')) return true;
    if (String(req.headers['x-forwarded-ssl'] || '').toLowerCase() === 'on') return true;
    if (String(req.headers['x-forwarded-scheme'] || '').toLowerCase() === 'https') return true;
    if (String(req.headers['cf-visitor'] || '').toLowerCase().includes('"https"')) return true;
    if (req.headers['x-cloud-trace-context']) return true;
    const origin = String(req.headers.origin || '').toLowerCase();
    if (origin.startsWith('https://')) return true;
    const referer = String(req.headers.referer || '').toLowerCase();
    if (referer.startsWith('https://')) return true;
    return false;
  }

  /**
   * Attach HttpOnly, Secure, SameSite, and Partitioned cookie to Express response
   */
  public setSessionCookie(res: Response, req: Request, sessionToken: string): void {
    const isHttps = this.isSecureRequest(req);
    const maxAgeMs = 14 * 24 * 3600 * 1000; // 14 days

    if (isHttps) {
      // Primary cookie for iframes (SameSite=None, Secure, Partitioned)
      res.cookie('rejoysolar_session', sessionToken, {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        path: '/',
        maxAge: maxAgeMs,
        partitioned: true
      } as any);

      // Fallback cookie for top-level browser direct navigation (SameSite=Lax, Secure)
      res.cookie('rejoysolar_session_lax', sessionToken, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: maxAgeMs
      });
    } else {
      // Local development over plain HTTP on localhost / 127.0.0.1
      res.cookie('rejoysolar_session', sessionToken, {
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        path: '/',
        maxAge: maxAgeMs
      });
    }
  }

  /**
   * Clear session cookie on Express response
   */
  public clearSessionCookie(res: Response, req: Request): void {
    const isHttps = this.isSecureRequest(req);
    const cookieOpts: any = {
      httpOnly: true,
      secure: isHttps,
      sameSite: isHttps ? 'none' : 'lax',
      path: '/'
    };
    if (isHttps) {
      cookieOpts.partitioned = true;
    }

    res.clearCookie('rejoysolar_session', cookieOpts);
    res.clearCookie('rejoysolar_session_lax', {
      httpOnly: true,
      secure: isHttps,
      sameSite: 'lax',
      path: '/'
    });
    // Also clear legacy tokens
    res.clearCookie('rejoysolar_auth_token', {
      ...cookieOpts,
      httpOnly: false
    });
  }
}

export const authService = AuthService.getInstance();
