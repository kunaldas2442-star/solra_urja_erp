import bcrypt from 'bcryptjs';
import type mysql from 'mysql2/promise';
import type { AccountType } from './authService';

export interface DefaultAuthAccountSpec {
  id: string;
  employeeCode: string | null;
  customerId: string | null;
  name: string;
  email: string;
  defaultPassword: string;
  role: string;
  department: string;
  designation: string;
  accountType: AccountType;
  isFieldWorker: 0 | 1;
}

export const DEFAULT_AUTH_ACCOUNTS: DefaultAuthAccountSpec[] = [
  {
    id: 'usr-admin-1',
    employeeCode: 'EMP-001',
    customerId: null,
    name: 'Administrator',
    email: 'admin@solar.klyiatechnology.com',
    defaultPassword: 'SolarAdmin@2026',
    role: 'Admin',
    department: 'Administration',
    designation: 'System Administrator',
    accountType: 'ADMIN',
    isFieldWorker: 0
  },
  {
    id: 'usr-salesmgr-1',
    employeeCode: 'EMP-002',
    customerId: null,
    name: 'Sales Manager',
    email: 'salesmanager@solar.klyiatechnology.com',
    defaultPassword: 'SolarSales@2026',
    role: 'Sales Manager',
    department: 'Sales',
    designation: 'Sales Manager',
    accountType: 'EMPLOYEE',
    isFieldWorker: 0
  },
  {
    id: 'usr-pm-1',
    employeeCode: 'EMP-003',
    customerId: null,
    name: 'Project Manager',
    email: 'projectmanager@solar.klyiatechnology.com',
    defaultPassword: 'SolarProject@2026',
    role: 'Project Manager',
    department: 'Operations',
    designation: 'Project Manager',
    accountType: 'EMPLOYEE',
    isFieldWorker: 0
  },
  {
    id: 'usr-survey-1',
    employeeCode: 'EMP-004',
    customerId: null,
    name: 'Site Surveyor',
    email: 'surveyor@solar.klyiatechnology.com',
    defaultPassword: 'SolarSurvey@2026',
    role: 'Site Survey Engineer',
    department: 'Engineering',
    designation: 'Site Surveyor',
    accountType: 'EMPLOYEE',
    isFieldWorker: 1
  },
  {
    id: 'usr-insp-1',
    employeeCode: 'EMP-005',
    customerId: null,
    name: 'Site Inspector',
    email: 'inspector@solar.klyiatechnology.com',
    defaultPassword: 'SolarInspect@2026',
    role: 'Site Inspector',
    department: 'Engineering',
    designation: 'Site Inspector',
    accountType: 'EMPLOYEE',
    isFieldWorker: 1
  },
  {
    id: 'usr-civil-1',
    employeeCode: 'EMP-006',
    customerId: null,
    name: 'Civil Team',
    email: 'civil@solar.klyiatechnology.com',
    defaultPassword: 'SolarCivil@2026',
    role: 'Civil Team',
    department: 'Civil',
    designation: 'Civil Team Lead',
    accountType: 'EMPLOYEE',
    isFieldWorker: 1
  },
  {
    id: 'usr-elec-1',
    employeeCode: 'EMP-007',
    customerId: null,
    name: 'Electrical Team',
    email: 'electrical@solar.klyiatechnology.com',
    defaultPassword: 'SolarElec@2026',
    role: 'Electrical Team',
    department: 'Electrical',
    designation: 'Electrical Team Lead',
    accountType: 'EMPLOYEE',
    isFieldWorker: 1
  },
  {
    id: 'usr-inst-1',
    employeeCode: 'EMP-008',
    customerId: null,
    name: 'Installation Team',
    email: 'installation@solar.klyiatechnology.com',
    defaultPassword: 'SolarInstall@2026',
    role: 'Installation Team',
    department: 'Installation',
    designation: 'Installation Team Lead',
    accountType: 'EMPLOYEE',
    isFieldWorker: 1
  },
  {
    id: 'usr-hr-1',
    employeeCode: 'EMP-009',
    customerId: null,
    name: 'HR Manager',
    email: 'hr@solar.klyiatechnology.com',
    defaultPassword: 'SolarHr@2026',
    role: 'HR Manager',
    department: 'HR',
    designation: 'HR Manager',
    accountType: 'EMPLOYEE',
    isFieldWorker: 0
  },
  {
    id: 'usr-acc-1',
    employeeCode: 'EMP-010',
    customerId: null,
    name: 'Accounts Manager',
    email: 'accounts@solar.klyiatechnology.com',
    defaultPassword: 'SolarAccounts@2026',
    role: 'Accountant',
    department: 'Finance',
    designation: 'Accounts Manager',
    accountType: 'EMPLOYEE',
    isFieldWorker: 0
  },
  {
    id: 'usr-cust-demo-1',
    employeeCode: null,
    customerId: null,
    name: 'Customer Demo Account',
    email: 'customer@solar.klyiatechnology.com',
    defaultPassword: 'SolarCustomer@2026',
    role: 'Customer',
    department: 'Customer',
    designation: 'Customer Portal Demo',
    accountType: 'CUSTOMER',
    isFieldWorker: 0
  }
];

export interface SyncDefaultAuthResult {
  total: number;
  createdUsers: number;
  existingUsers: number;
  createdCredentials: number;
  existingCredentials: number;
  accounts: Array<{
    id: string;
    email: string;
    role: string;
    accountType: AccountType;
    userAction: 'created' | 'existing';
    credentialAction: 'created' | 'existing';
  }>;
}

async function ensurePasswordChangeColumn(pool: mysql.Pool, tableName: string): Promise<void> {
  try {
    const [cols]: any = await pool.query(`SHOW COLUMNS FROM \`${tableName}\` LIKE 'must_change_password'`);
    if (!Array.isArray(cols) || cols.length === 0) {
      await pool.query(
        `ALTER TABLE \`${tableName}\` ADD COLUMN \`must_change_password\` TINYINT(1) NOT NULL DEFAULT 0`
      );
    }
  } catch {
    // Table may not exist yet; caller handles table creation
  }
}

function isBcryptHash(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (value.startsWith('$2a$') || value.startsWith('$2b$') || value.startsWith('$2y$'))
  );
}

/**
 * Idempotently ensures all 11 default portal accounts exist in solar_users and solar_auth_credentials.
 * - Never duplicates existing users.
 * - Never overwrites existing passwords or user profile/status fields.
 */
export async function syncDefaultAuthAccounts(pool: mysql.Pool): Promise<SyncDefaultAuthResult> {
  await ensurePasswordChangeColumn(pool, 'solar_users');
  await ensurePasswordChangeColumn(pool, 'solar_auth_credentials');

  let createdUsers = 0;
  let existingUsers = 0;
  let createdCredentials = 0;
  let existingCredentials = 0;
  const accounts: SyncDefaultAuthResult['accounts'] = [];

  for (const spec of DEFAULT_AUTH_ACCOUNTS) {
    const cleanEmail = spec.email.trim().toLowerCase();

    const [userRows]: any = await pool.query(
      'SELECT `id`, `email`, `password`, `role`, `employee_id`, `customer_id`, `status`, `must_change_password` FROM `solar_users` WHERE `id` = ? OR LOWER(`email`) = ? LIMIT 1',
      [spec.id, cleanEmail]
    );

    let effectiveUserId = spec.id;
    let effectiveHash = '';
    let effectiveRole = spec.role;
    let effectiveStatus = 'ACTIVE';
    let effectiveLinkedId: string | null = spec.employeeCode || spec.customerId || spec.id;
    let effectiveMustChange = 1;
    let userAction: 'created' | 'existing' = 'existing';

    if (Array.isArray(userRows) && userRows.length > 0) {
      const existing = userRows[0];
      effectiveUserId = existing.id;
      effectiveRole = existing.role || spec.role;
      effectiveStatus =
        existing.status === 'DISABLED' || existing.status === 'INACTIVE' ? 'DISABLED' : 'ACTIVE';
      effectiveLinkedId = existing.employee_id || existing.customer_id || existing.id;
      effectiveMustChange = existing.must_change_password ? 1 : 0;

      if (isBcryptHash(existing.password)) {
        effectiveHash = existing.password;
      } else if (existing.password && String(existing.password).trim()) {
        // Legacy plaintext password present: upgrade in place without replacing user's chosen password
        effectiveHash = await bcrypt.hash(String(existing.password).trim(), 10);
        await pool.query('UPDATE `solar_users` SET `password` = ? WHERE `id` = ?', [
          effectiveHash,
          existing.id
        ]);
      } else {
        effectiveHash = await bcrypt.hash(spec.defaultPassword, 10);
        await pool.query(
          'UPDATE `solar_users` SET `password` = ?, `must_change_password` = 1 WHERE `id` = ?',
          [effectiveHash, existing.id]
        );
        effectiveMustChange = 1;
      }

      existingUsers++;
    } else {
      effectiveHash = await bcrypt.hash(spec.defaultPassword, 10);
      await pool.query(
        `INSERT INTO \`solar_users\` (
          \`id\`, \`name\`, \`email\`, \`password\`, \`role\`, \`phone\`,
          \`department\`, \`designation\`, \`employee_id\`, \`customer_id\`,
          \`is_field_worker\`, \`must_change_password\`, \`status\`
        ) VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, 1, 'ACTIVE')`,
        [
          spec.id,
          spec.name,
          cleanEmail,
          effectiveHash,
          spec.role,
          spec.department,
          spec.designation,
          spec.employeeCode,
          spec.customerId,
          spec.isFieldWorker
        ]
      );
      effectiveMustChange = 1;
      userAction = 'created';
      createdUsers++;
    }

    // Ensure matching record in solar_auth_credentials without overwriting existing passwords
    const [credRows]: any = await pool.query(
      'SELECT `id`, `password_hash` FROM `solar_auth_credentials` WHERE `user_id` = ? OR LOWER(`email`) = ? LIMIT 1',
      [effectiveUserId, cleanEmail]
    );

    let credentialAction: 'created' | 'existing' = 'existing';
    if (!Array.isArray(credRows) || credRows.length === 0) {
      await pool.query(
        `INSERT INTO \`solar_auth_credentials\` (
          \`id\`, \`user_id\`, \`email\`, \`password_hash\`, \`role\`,
          \`account_type\`, \`linked_entity_id\`, \`must_change_password\`, \`status\`
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          `cred-${effectiveUserId}`,
          effectiveUserId,
          cleanEmail,
          effectiveHash,
          effectiveRole,
          spec.accountType,
          effectiveLinkedId,
          effectiveMustChange,
          effectiveStatus
        ]
      );
      credentialAction = 'created';
      createdCredentials++;
    } else {
      existingCredentials++;
    }

    accounts.push({
      id: effectiveUserId,
      email: cleanEmail,
      role: effectiveRole,
      accountType: spec.accountType,
      userAction,
      credentialAction
    });
  }

  await pool
    .query(
      `INSERT IGNORE INTO \`solar_schema_migrations\` (\`version\`, \`description\`) VALUES (?, ?)`,
      [
        '2026_11_27_sync_default_auth_accounts',
        'Idempotent sync of all 11 Solar Urja ERP default portal accounts with bcrypt hashes and must_change_password flag'
      ]
    )
    .catch(() => {});

  return {
    total: DEFAULT_AUTH_ACCOUNTS.length,
    createdUsers,
    existingUsers,
    createdCredentials,
    existingCredentials,
    accounts
  };
}
