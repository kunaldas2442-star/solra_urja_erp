import dotenv from 'dotenv';
dotenv.config();

import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { ensureLocalMySqlRunning } from './mysqlDaemon';
import { authService } from './services/authService';
import { accountingService } from './services/accountingService';
import { inMemoryDbStore } from './inMemoryFallback';
import {
  EmailSettingsRecord,
  SanitizedEmailSettings,
  SmtpSecurity,
  sanitizeEmailConfig
} from './services/emailService';
import {
  computeVendorSalesInvoiceTotals,
  determineVendorSupplyType,
  roundCurrency
} from '../src/utils/gstTaxUtils';

export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
}

export function getDbConfigFromEnv(): DbConfig {
  const host = (process.env.DB_HOST || '127.0.0.1').trim();
  return {
    host,
    port: Number(process.env.DB_PORT) || 3306,
    user: (process.env.DB_USER || 'u238683373_rejoy_solar').trim(),
    password: process.env.DB_PASS || process.env.DB_PASSWORD || ';Fl:$tn/9C&d',
    database: (process.env.DB_NAME || 'u238683373_rejoy_solar').trim()
  };
}

export class DbConnectionError extends Error {
  public readonly code = 'DB_UNAVAILABLE';
  public readonly statusCode = 503;
  constructor(message: string) {
    super(message);
    this.name = 'DbConnectionError';
  }
}

class MySqlDatabaseManager {
  private pool: mysql.Pool | null = null;
  private isConnected: boolean = false;
  private collections: Map<string, any[]> = new Map();
  private settingsStore: Record<string, any> = {};
  private config: DbConfig;

  private loadDiskSnapshot(): void {
    // Disabled: MySQL is the sole authoritative store. Never seed runtime state from JSON snapshots.
  }

  public saveDiskSnapshot(): void {
    // Disabled: MySQL is the sole authoritative store.
  }

  private parseBoolFlag(val: any, fallback: boolean = false): boolean {
    if (typeof val === 'boolean') return val;
    if (typeof val === 'number') return val !== 0;
    if (typeof val === 'string') {
      const normalized = val.trim().toLowerCase();
      if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
      if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === '') return false;
    }
    return fallback;
  }

  constructor() {
    this.config = getDbConfigFromEnv();
    this.pool = null;
  }

  public async init(): Promise<{ connected: boolean; error?: string }> {
    this.config = getDbConfigFromEnv();

    const isLocalHost = this.config.host === '127.0.0.1' || this.config.host === 'localhost' || this.config.host === '::1' || !this.config.host;
    if (isLocalHost) {
      console.log('[MySQL] Target host is local. Ensuring local MySQL/MariaDB daemon is running...');
      const isRunning = await ensureLocalMySqlRunning(this.config.host || '127.0.0.1', this.config.port);
      if (!isRunning) {
        this.isConnected = false;
        this.pool = null;
        console.warn(`[MySQL] Unavailable (${this.config.host}:${this.config.port} unreachable). Running in strict MySQL-only mode — API data requests will return HTTP 503 until MySQL connects.`);
        return { connected: false, error: 'Local MySQL daemon is not running' };
      }
    }

    try {
      // Ensure database exists
      try {
        const adminConn = await mysql.createConnection({
          host: this.config.host,
          port: this.config.port,
          user: this.config.user,
          password: this.config.password,
          charset: 'utf8mb4_unicode_ci',
          connectTimeout: 5000
        });
        await adminConn.query(`CREATE DATABASE IF NOT EXISTS \`${this.config.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        await adminConn.end();
      } catch (adminErr: any) {
        console.warn('[MySQL] Notice during database creation check:', adminErr?.message || adminErr);
      }

      this.pool = mysql.createPool({
        host: this.config.host,
        port: this.config.port,
        user: this.config.user,
        password: this.config.password,
        database: this.config.database,
        charset: 'utf8mb4_unicode_ci',
        waitForConnections: true,
        connectionLimit: 15,
        queueLimit: 0,
        multipleStatements: true,
        connectTimeout: 5000
      });

      const connection = await this.pool.getConnection();
      await connection.ping();
      connection.release();

      this.isConnected = true;
      console.log(`[MySQL] Successfully connected to MySQL database "${this.config.database}" on ${this.config.host}:${this.config.port}`);

      // Ensure all tables and baseline schema exist
      await this.ensureSchema();

      return { connected: true };
    } catch (err: any) {
      this.isConnected = false;
      this.pool = null;
      console.warn(`[MySQL] Connection unavailable (${this.config.host}:${this.config.port}):`, err?.message || err);
      return { connected: false, error: err.message };
    }
  }

  public async testConnection(customConfig: Partial<DbConfig>): Promise<{ success: boolean; message: string; version?: string }> {
    const cfg = { ...this.config, ...customConfig };
    let tempConn: mysql.Connection | null = null;
    try {
      tempConn = await mysql.createConnection({
        host: cfg.host,
        port: cfg.port,
        user: cfg.user,
        password: cfg.password,
        database: cfg.database,
        charset: 'utf8mb4_unicode_ci',
        connectTimeout: 5000
      });
      const [rows]: any = await tempConn.query('SELECT VERSION() as version');
      const version = rows && rows[0] ? rows[0].version : 'MySQL 8+';
      await tempConn.end();
      return { success: true, message: `Successfully connected to MySQL ${version} on ${cfg.host}`, version };
    } catch (err: any) {
      if (tempConn) {
        try { await tempConn.end(); } catch {}
      }
      return { success: false, message: err?.message || 'Connection failed' };
    }
  }

  public async ensureSchema(): Promise<void> {
    if (!this.pool || !this.isConnected) return;
    try {
      const dumpPath = path.join(process.cwd(), 'database.sql');
      if (fs.existsSync(dumpPath)) {
        const sql = fs.readFileSync(dumpPath, 'utf-8');
        await this.pool.query(sql);
        console.log('[MySQL] Schema and production baseline verified in MySQL database.');
      }

      // Check and migrate columns on solar_customers if table already existed with older schema
      try {
        const [cols]: any = await this.pool.query("SHOW COLUMNS FROM `solar_customers`");
        const existing = new Set<string>((cols as any[]).map(c => String(c.Field).toLowerCase()));
        const needed: Record<string, string> = {
          company_name: "VARCHAR(255) DEFAULT ''",
          customer_type: "VARCHAR(32) DEFAULT 'Residential'",
          site_address: "TEXT",
          city: "VARCHAR(128) NOT NULL DEFAULT 'Ahmedabad'",
          state: "VARCHAR(128) DEFAULT 'Gujarat'",
          pincode: "VARCHAR(16) DEFAULT '380001'",
          gst_number: "VARCHAR(32) DEFAULT ''",
          electricity_consumer_no: "VARCHAR(64) DEFAULT ''",
          sanctioned_load_kw: "DECIMAL(10,2) DEFAULT 0.00",
          status: "VARCHAR(32) DEFAULT 'ACTIVE'",
          active_project_id: "VARCHAR(64) DEFAULT NULL",
          updated_at: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"
        };
        for (const [col, typeDef] of Object.entries(needed)) {
          if (!existing.has(col.toLowerCase())) {
            try {
              await this.pool.query(`ALTER TABLE \`solar_customers\` ADD COLUMN \`${col}\` ${typeDef}`);
            } catch {}
          }
        }
      } catch {}

      // Check and migrate columns on solar_attendance
      try {
        const [cols]: any = await this.pool.query("SHOW COLUMNS FROM `solar_attendance`");
        const existing = new Set<string>((cols as any[]).map(c => String(c.Field).toLowerCase()));
        if (!existing.has('fuel_expense_json')) {
          try {
            await this.pool.query("ALTER TABLE `solar_attendance` ADD COLUMN `fuel_expense_json` LONGTEXT DEFAULT NULL");
          } catch {}
        }
      } catch {}

      // Check and migrate columns on solar_payslips
      try {
        const [cols]: any = await this.pool.query("SHOW COLUMNS FROM `solar_payslips`");
        const existing = new Set<string>((cols as any[]).map(c => String(c.Field).toLowerCase()));
        const neededPayslipCols: Record<string, string> = {
          additional_expenses_json: "LONGTEXT DEFAULT NULL",
          deductions_json: "LONGTEXT DEFAULT NULL",
          overtime_hours: "DECIMAL(6,2) DEFAULT 0.00",
          overtime_rate: "DECIMAL(10,2) DEFAULT 0.00",
          payment_mode: "VARCHAR(64) DEFAULT 'NEFT/RTGS Bank Transfer'",
          bank_reference_no: "VARCHAR(128) DEFAULT ''"
        };
        for (const [col, typeDef] of Object.entries(neededPayslipCols)) {
          if (!existing.has(col.toLowerCase())) {
            try {
              await this.pool.query(`ALTER TABLE \`solar_payslips\` ADD COLUMN \`${col}\` ${typeDef}`);
            } catch {}
          }
        }
      } catch {}

      // Auto-migrate extended columns on Sales & Purchase ERP tables
      const salesPurchaseMigrations: Record<string, Record<string, string>> = {
        solar_projects: {
          received_inflow: "DECIMAL(18,2) DEFAULT NULL"
        },
        solar_products: {
          gst_rate: "DECIMAL(5,2) DEFAULT 18.00",
          selling_price: "DECIMAL(12,2) DEFAULT 0.00",
          location: "VARCHAR(255) DEFAULT ''",
          warehouse_name: "VARCHAR(255) DEFAULT ''",
          warehouse_stocks_json: "LONGTEXT DEFAULT NULL",
          preferred_vendor_id: "VARCHAR(64) DEFAULT ''",
          preferred_vendor_name: "VARCHAR(255) DEFAULT ''",
          updated_at: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"
        },
        solar_vendors: {
          bank_details_json: "LONGTEXT DEFAULT NULL",
          updated_at: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"
        },
        solar_purchase_orders: {
          project_title: "VARCHAR(255) DEFAULT ''",
          warehouse_id: "VARCHAR(64) DEFAULT ''",
          warehouse_name: "VARCHAR(255) DEFAULT ''",
          payment_due_date: "DATE DEFAULT NULL",
          invoice_reference: "VARCHAR(128) DEFAULT ''",
          stock_updated: "TINYINT(1) DEFAULT 0",
          received_date: "DATE DEFAULT NULL",
          paid_amount: "DECIMAL(14,2) NOT NULL DEFAULT 0.00",
          returned_amount: "DECIMAL(14,2) NOT NULL DEFAULT 0.00",
          refunded_amount: "DECIMAL(14,2) NOT NULL DEFAULT 0.00",
          balance_amount: "DECIMAL(14,2) NOT NULL DEFAULT 0.00",
          bank_account_id: "VARCHAR(64) DEFAULT ''",
          vendor_bills_json: "LONGTEXT DEFAULT NULL",
          vendor_bill_url: "TEXT DEFAULT NULL",
          vendor_bill_name: "VARCHAR(255) DEFAULT ''",
          vendor_bill_mime: "VARCHAR(128) DEFAULT ''",
          vendor_bill_size: "BIGINT DEFAULT 0",
          vendor_bill_uploaded_at: "VARCHAR(64) DEFAULT ''",
          updated_at: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"
        },
        solar_boms: {
          project_code: "VARCHAR(64) DEFAULT ''",
          customer_name: "VARCHAR(255) DEFAULT ''",
          warehouse_id: "VARCHAR(64) DEFAULT ''",
          warehouse_name: "VARCHAR(255) DEFAULT ''",
          stock_allocated: "TINYINT(1) DEFAULT 0",
          eway_bill_number: "VARCHAR(64) DEFAULT ''",
          eway_bill_date: "VARCHAR(32) DEFAULT ''",
          approved_at: "DATETIME DEFAULT NULL",
          updated_at: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"
        },
        solar_payments: {
          invoice_id: "VARCHAR(64) DEFAULT ''",
          invoice_number: "VARCHAR(64) DEFAULT ''",
          bank_account_id: "VARCHAR(64) DEFAULT ''",
          journal_entry_id: "VARCHAR(64) DEFAULT ''"
        },
        solar_expenses: {
          expense_type: "VARCHAR(32) DEFAULT 'DIRECT_EXPENSE'",
          status: "VARCHAR(32) DEFAULT 'PAID'",
          employee_id: "VARCHAR(64) DEFAULT ''",
          employee_name: "VARCHAR(255) DEFAULT ''",
          gst_amount: "DECIMAL(14,2) DEFAULT 0.00",
          itc_eligible: "TINYINT(1) DEFAULT 0",
          bank_account_id: "VARCHAR(64) DEFAULT ''",
          expense_account_id: "VARCHAR(64) DEFAULT ''",
          journal_entry_id: "VARCHAR(64) DEFAULT ''",
          approved_at: "VARCHAR(64) DEFAULT NULL",
          rejection_reason: "TEXT",
          paid_at: "VARCHAR(64) DEFAULT NULL",
          paid_by: "VARCHAR(255) DEFAULT ''"
        },
        solar_sales_invoices: {
          invoice_type: "VARCHAR(64) DEFAULT 'TAX_INVOICE'",
          customer_gst: "VARCHAR(64) DEFAULT ''",
          customer_address: "TEXT",
          project_title: "VARCHAR(255) DEFAULT ''",
          payment_terms: "VARCHAR(128) DEFAULT '15 Days Net'",
          deduct_stock: "TINYINT(1) DEFAULT 1",
          stock_deducted: "TINYINT(1) DEFAULT 0",
          cgst_amount: "DECIMAL(14,2) DEFAULT 0.00",
          sgst_amount: "DECIMAL(14,2) DEFAULT 0.00",
          igst_amount: "DECIMAL(14,2) DEFAULT 0.00",
          einvoice_irn: "VARCHAR(128) DEFAULT ''",
          einvoice_ack_no: "VARCHAR(64) DEFAULT ''",
          einvoice_ack_date: "VARCHAR(64) DEFAULT ''",
          einvoice_status: "VARCHAR(32) DEFAULT 'NOT_GENERATED'",
          returned_amount: "DECIMAL(14,2) NOT NULL DEFAULT 0.00",
          refunded_amount: "DECIMAL(14,2) NOT NULL DEFAULT 0.00",
          bank_account_id: "VARCHAR(64) DEFAULT ''",
          updated_at: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"
        },
        solar_vendor_sales_invoices: {
          returned_amount: "DECIMAL(14,2) NOT NULL DEFAULT 0.00",
          refunded_amount: "DECIMAL(14,2) NOT NULL DEFAULT 0.00",
          bank_account_id: "VARCHAR(64) DEFAULT ''"
        },
        solar_vendor_sales_payments: {
          bank_account_id: "VARCHAR(64) DEFAULT ''",
          journal_entry_id: "VARCHAR(64) DEFAULT ''"
        },
        solar_acc_vendor_bills: {
          returned_amount: "DECIMAL(14,2) NOT NULL DEFAULT 0.00",
          refunded_amount: "DECIMAL(14,2) NOT NULL DEFAULT 0.00"
        },
        solar_warehouses: {
          email: "VARCHAR(191) DEFAULT ''",
          capacity_sq_ft: "DECIMAL(12,2) DEFAULT 15000.00",
          status: "VARCHAR(32) DEFAULT 'ACTIVE'",
          is_default: "TINYINT(1) DEFAULT 0",
          notes: "TEXT",
          updated_at: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"
        },
        solar_stock_movements: {
          warehouse_name: "VARCHAR(255) DEFAULT ''",
          target_warehouse_id: "VARCHAR(64) DEFAULT ''",
          target_warehouse_name: "VARCHAR(255) DEFAULT ''",
          reference_id: "VARCHAR(64) DEFAULT ''"
        },
        solar_stock_audits: {
          items_audited: "INT DEFAULT 0",
          net_adjustment_value: "DECIMAL(14,2) DEFAULT 0.00"
        }
      };
      for (const [tableName, colsMap] of Object.entries(salesPurchaseMigrations)) {
        try {
          const [cols]: any = await this.pool.query(`SHOW COLUMNS FROM \`${tableName}\``);
          const existing = new Set<string>((cols as any[]).map(c => String(c.Field).toLowerCase()));
          for (const [col, typeDef] of Object.entries(colsMap)) {
            if (!existing.has(col.toLowerCase())) {
              try {
                await this.pool.query(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${col}\` ${typeDef}`);
              } catch {}
            }
          }
        } catch {}
      }

      // Safely widen currency columns to DECIMAL(18,2) so large contract values / inflows never hit 14,2 caps
      const widenMigrations: Array<[string, string, string]> = [
        ['solar_projects', 'total_value', 'DECIMAL(18,2) NOT NULL DEFAULT 0.00'],
        ['solar_projects', 'received_inflow', 'DECIMAL(18,2) DEFAULT NULL'],
        ['solar_payments', 'amount', 'DECIMAL(18,2) NOT NULL DEFAULT 0.00']
      ];
      for (const [tbl, col, colDef] of widenMigrations) {
        try {
          const [colRows]: any = await this.pool.query(`SHOW COLUMNS FROM \`${tbl}\` LIKE ?`, [col]);
          const currentType = String(colRows?.[0]?.Type || '').toLowerCase();
          if (currentType && !currentType.includes('(18,')) {
            await this.pool.query(`ALTER TABLE \`${tbl}\` MODIFY COLUMN \`${col}\` ${colDef}`);
          }
        } catch {}
      }

      // Check and migrate table & columns on solar_employee (authoritative employee table)
      try {
        // Ensure base table solar_employee exists
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS \`solar_employee\` (
            \`id\` VARCHAR(64) PRIMARY KEY,
            \`employee_code\` VARCHAR(32) NOT NULL UNIQUE,
            \`name\` VARCHAR(255) NOT NULL,
            \`photo_url\` TEXT DEFAULT NULL,
            \`documents_json\` LONGTEXT DEFAULT NULL,
            \`department\` VARCHAR(64) NOT NULL,
            \`designation\` VARCHAR(128) NOT NULL,
            \`phone\` VARCHAR(32) NOT NULL,
            \`email\` VARCHAR(191) NOT NULL,
            \`joining_date\` DATE DEFAULT NULL,
            \`salary_monthly\` DECIMAL(12,2) DEFAULT 0.00,
            \`status\` VARCHAR(32) DEFAULT 'ACTIVE',
            \`current_site_location\` VARCHAR(255) DEFAULT '',
            \`esic_number\` VARCHAR(64) DEFAULT '',
            \`bank_account_number\` VARCHAR(64) DEFAULT '',
            \`bank_name\` VARCHAR(150) DEFAULT '',
            \`ifsc_code\` VARCHAR(32) DEFAULT '',
            \`emergency_contact_person\` VARCHAR(150) DEFAULT '',
            \`emergency_contact_number\` VARCHAR(40) DEFAULT '',
            \`login_enabled\` TINYINT(1) DEFAULT 1,
            \`auth_uid\` VARCHAR(64) DEFAULT NULL,
            \`system_role\` VARCHAR(64) DEFAULT 'Super Admin',
            \`assigned_role\` VARCHAR(64) DEFAULT NULL,
            \`is_field_worker\` TINYINT(1) DEFAULT 0,
            \`account_status\` VARCHAR(32) DEFAULT 'ACTIVE',
            \`account_created_at\` VARCHAR(64) DEFAULT NULL,
            \`account_created_by\` VARCHAR(255) DEFAULT NULL,
            \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX \`idx_solar_emp_dept\` (\`department\`),
            INDEX \`idx_solar_emp_status\` (\`status\`),
            INDEX \`idx_solar_emp_auth_uid\` (\`auth_uid\`),
            INDEX \`idx_solar_emp_email\` (\`email\`)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        // Check if solar_employees is still a base table instead of a view
        const [tableTypeRows]: any = await this.pool.query("SHOW FULL TABLES LIKE 'solar_employees'");
        if (Array.isArray(tableTypeRows) && tableTypeRows.length > 0) {
          const type = String(Object.values(tableTypeRows[0])[1] || '').toUpperCase();
          if (type === 'BASE TABLE') {
            const [srcCols]: any = await this.pool.query("SHOW COLUMNS FROM `solar_employees`");
            const [dstCols]: any = await this.pool.query("SHOW COLUMNS FROM `solar_employee`");
            const srcSet = new Set<string>((srcCols as any[]).map(c => String(c.Field).toLowerCase()));
            const commonCols = (dstCols as any[])
              .map(c => String(c.Field))
              .filter(c => srcSet.has(c.toLowerCase()));

            let copySucceeded = false;
            if (commonCols.length > 0) {
              const targetCols = [...commonCols];
              const selectExprs = commonCols.map(c => `\`${c}\``);
              if (!srcSet.has('salary_monthly') && srcSet.has('salary')) {
                targetCols.push('salary_monthly');
                selectExprs.push('COALESCE(`salary`, 0.00)');
              }
              await this.pool.query(
                `INSERT IGNORE INTO \`solar_employee\` (${targetCols.map(c => `\`${c}\``).join(', ')}) SELECT ${selectExprs.join(', ')} FROM \`solar_employees\``
              );
              copySucceeded = true;
            } else {
              const [srcCountRows]: any = await this.pool.query("SELECT COUNT(*) as cnt FROM `solar_employees`");
              copySucceeded = Number(srcCountRows?.[0]?.cnt || 0) === 0;
            }
            if (copySucceeded) {
              await this.pool.query("DROP TABLE IF EXISTS `solar_employees`");
            }
          }
        }

        // Verify and migrate all columns on solar_employee BEFORE refreshing the view
        const [empCols]: any = await this.pool.query("SHOW COLUMNS FROM `solar_employee`");
        const existingEmpCols = new Set<string>((empCols as any[]).map(c => String(c.Field).toLowerCase()));

        if (!existingEmpCols.has('photo_url')) {
          await this.pool.query("ALTER TABLE `solar_employee` ADD COLUMN `photo_url` TEXT DEFAULT NULL AFTER `name`").catch(() => {});
        }

        if (!existingEmpCols.has('documents_json')) {
          await this.pool.query("ALTER TABLE `solar_employee` ADD COLUMN `documents_json` LONGTEXT DEFAULT NULL AFTER `photo_url`").catch(() => {});
        }

        if (!existingEmpCols.has('department')) {
          await this.pool.query("ALTER TABLE `solar_employee` ADD COLUMN `department` VARCHAR(64) NOT NULL DEFAULT 'Operations'").catch(() => {});
        }

        if (!existingEmpCols.has('designation')) {
          await this.pool.query("ALTER TABLE `solar_employee` ADD COLUMN `designation` VARCHAR(128) NOT NULL DEFAULT 'Solar Engineer'").catch(() => {});
        }

        if (!existingEmpCols.has('phone')) {
          await this.pool.query("ALTER TABLE `solar_employee` ADD COLUMN `phone` VARCHAR(32) NOT NULL DEFAULT ''").catch(() => {});
        }

        if (!existingEmpCols.has('email')) {
          await this.pool.query("ALTER TABLE `solar_employee` ADD COLUMN `email` VARCHAR(191) NOT NULL DEFAULT ''").catch(() => {});
        }

        if (!existingEmpCols.has('joining_date')) {
          await this.pool.query("ALTER TABLE `solar_employee` ADD COLUMN `joining_date` DATE DEFAULT NULL AFTER `email`").catch(() => {});
        } else {
          await this.pool.query("ALTER TABLE `solar_employee` MODIFY COLUMN `joining_date` DATE DEFAULT NULL").catch(() => {});
        }

        if (!existingEmpCols.has('salary_monthly')) {
          await this.pool.query("ALTER TABLE `solar_employee` ADD COLUMN `salary_monthly` DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER `joining_date`").catch(() => {});
          existingEmpCols.add('salary_monthly');
        }

        if (existingEmpCols.has('salary') && existingEmpCols.has('salary_monthly')) {
          await this.pool.query(
            "UPDATE `solar_employee` SET `salary_monthly` = COALESCE(`salary`, 0.00) WHERE (`salary_monthly` IS NULL OR `salary_monthly` = 0) AND `salary` IS NOT NULL AND `salary` > 0"
          ).catch(() => {});
        }

        if (!existingEmpCols.has('status')) {
          await this.pool.query("ALTER TABLE `solar_employee` ADD COLUMN `status` VARCHAR(32) DEFAULT 'ACTIVE'").catch(() => {});
        }

        if (!existingEmpCols.has('current_site_location')) {
          await this.pool.query("ALTER TABLE `solar_employee` ADD COLUMN `current_site_location` VARCHAR(255) DEFAULT ''").catch(() => {});
        }

        if (!existingEmpCols.has('esic_number')) {
          await this.pool.query("ALTER TABLE `solar_employee` ADD COLUMN `esic_number` VARCHAR(64) DEFAULT '' AFTER `current_site_location`").catch(() => {});
        }

        if (!existingEmpCols.has('bank_account_number')) {
          await this.pool.query("ALTER TABLE `solar_employee` ADD COLUMN `bank_account_number` VARCHAR(64) DEFAULT '' AFTER `esic_number`").catch(() => {});
        }

        if (!existingEmpCols.has('bank_name')) {
          await this.pool.query("ALTER TABLE `solar_employee` ADD COLUMN `bank_name` VARCHAR(150) DEFAULT '' AFTER `bank_account_number`").catch(() => {});
        }

        if (!existingEmpCols.has('ifsc_code')) {
          await this.pool.query("ALTER TABLE `solar_employee` ADD COLUMN `ifsc_code` VARCHAR(32) DEFAULT '' AFTER `bank_name`").catch(() => {});
        }

        if (!existingEmpCols.has('emergency_contact_person')) {
          await this.pool.query("ALTER TABLE `solar_employee` ADD COLUMN `emergency_contact_person` VARCHAR(150) DEFAULT '' AFTER `ifsc_code`").catch(() => {});
        }

        if (!existingEmpCols.has('emergency_contact_number')) {
          await this.pool.query("ALTER TABLE `solar_employee` ADD COLUMN `emergency_contact_number` VARCHAR(40) DEFAULT '' AFTER `emergency_contact_person`").catch(() => {});
        }

        if (!existingEmpCols.has('login_enabled')) {
          await this.pool.query("ALTER TABLE `solar_employee` ADD COLUMN `login_enabled` TINYINT(1) DEFAULT 1 AFTER `current_site_location`").catch(() => {});
        }

        if (!existingEmpCols.has('auth_uid')) {
          await this.pool.query("ALTER TABLE `solar_employee` ADD COLUMN `auth_uid` VARCHAR(64) DEFAULT NULL AFTER `login_enabled`").catch(() => {});
        }

        if (!existingEmpCols.has('system_role')) {
          await this.pool.query("ALTER TABLE `solar_employee` ADD COLUMN `system_role` VARCHAR(64) DEFAULT 'Super Admin' AFTER `auth_uid`").catch(() => {});
        }

        if (!existingEmpCols.has('assigned_role')) {
          await this.pool.query("ALTER TABLE `solar_employee` ADD COLUMN `assigned_role` VARCHAR(64) DEFAULT NULL AFTER `system_role`").catch(() => {});
        }

        if (!existingEmpCols.has('is_field_worker')) {
          await this.pool.query("ALTER TABLE `solar_employee` ADD COLUMN `is_field_worker` TINYINT(1) DEFAULT 0 AFTER `assigned_role`").catch(() => {});
        }

        if (!existingEmpCols.has('account_status')) {
          await this.pool.query("ALTER TABLE `solar_employee` ADD COLUMN `account_status` VARCHAR(32) DEFAULT 'ACTIVE' AFTER `is_field_worker`").catch(() => {});
        }

        if (!existingEmpCols.has('account_created_at')) {
          await this.pool.query("ALTER TABLE `solar_employee` ADD COLUMN `account_created_at` VARCHAR(64) DEFAULT NULL AFTER `account_status`").catch(() => {});
        }

        if (!existingEmpCols.has('account_created_by')) {
          await this.pool.query("ALTER TABLE `solar_employee` ADD COLUMN `account_created_by` VARCHAR(255) DEFAULT NULL AFTER `account_created_at`").catch(() => {});
        }

        if (!existingEmpCols.has('updated_at')) {
          await this.pool.query("ALTER TABLE `solar_employee` ADD COLUMN `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP").catch(() => {});
        }

        // Refresh backward-compatible updatable view AFTER all column migrations so view exposes every column
        await this.pool.query("CREATE OR REPLACE SQL SECURITY INVOKER VIEW `solar_employees` AS SELECT * FROM `solar_employee`")
          .catch(() => this.pool!.query("CREATE OR REPLACE VIEW `solar_employees` AS SELECT * FROM `solar_employee`"));
      } catch (err: any) {
        console.warn('[MySQL Migration] Notice verifying solar_employee schema:', err.message);
      }

      // Verify and migrate missing columns on solar_users (is_field_worker, avatar, photo_url)
      try {
        const [uCols]: any = await this.pool.query("SHOW COLUMNS FROM `solar_users`");
        const existingUserCols = new Set<string>((uCols as any[]).map(c => String(c.Field).toLowerCase()));
        if (!existingUserCols.has('avatar')) {
          await this.pool.query("ALTER TABLE `solar_users` ADD COLUMN `avatar` TEXT DEFAULT NULL AFTER `customer_id`").catch(() => {});
        }
        if (!existingUserCols.has('photo_url')) {
          await this.pool.query("ALTER TABLE `solar_users` ADD COLUMN `photo_url` TEXT DEFAULT NULL AFTER `avatar`").catch(() => {});
        }
        if (!existingUserCols.has('is_field_worker')) {
          await this.pool.query("ALTER TABLE `solar_users` ADD COLUMN `is_field_worker` TINYINT(1) DEFAULT 0 AFTER `photo_url`").catch(() => {});
        }
      } catch (err: any) {
        console.warn('[MySQL Migration] Notice verifying solar_users schema:', err.message);
      }

      // Ensure persistent solar_employee_documents table exists
      try {
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS \`solar_employee_documents\` (
            \`id\` VARCHAR(64) PRIMARY KEY,
            \`employee_id\` VARCHAR(64) NOT NULL,
            \`category\` VARCHAR(64) NOT NULL,
            \`name\` VARCHAR(255) NOT NULL,
            \`file_name\` VARCHAR(255) NOT NULL,
            \`file_path\` VARCHAR(500) NOT NULL,
            \`file_url\` VARCHAR(500) NOT NULL,
            \`mime_type\` VARCHAR(128) NOT NULL,
            \`file_size\` BIGINT DEFAULT 0,
            \`uploaded_at\` DATETIME DEFAULT CURRENT_TIMESTAMP,
            \`uploaded_by\` VARCHAR(255) DEFAULT 'HR Administrator',
            \`notes\` TEXT,
            INDEX \`idx_emp_docs_empid\` (\`employee_id\`),
            INDEX \`idx_emp_docs_cat\` (\`category\`)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);
      } catch (err: any) {
        console.warn('[MySQL Migration] Notice creating solar_employee_documents table:', err.message);
      }

      // Ensure persistent solar_email_settings table exists (isolated from bootstrap/general settings)
      try {
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS \`solar_email_settings\` (
            \`id\` VARCHAR(64) PRIMARY KEY,
            \`gmail_address\` VARCHAR(255) NOT NULL,
            \`smtp_host\` VARCHAR(255) NOT NULL DEFAULT 'smtp.gmail.com',
            \`smtp_port\` INT NOT NULL DEFAULT 587,
            \`smtp_security\` VARCHAR(16) NOT NULL DEFAULT 'TLS',
            \`sender_name\` VARCHAR(255) NOT NULL DEFAULT 'Solar Urja ERP',
            \`encrypted_app_password\` TEXT NOT NULL,
            \`iv\` VARCHAR(64) NOT NULL,
            \`auth_tag\` VARCHAR(64) NOT NULL,
            \`enabled\` TINYINT(1) NOT NULL DEFAULT 1,
            \`last_tested_at\` VARCHAR(64) DEFAULT NULL,
            \`last_test_status\` VARCHAR(32) DEFAULT NULL,
            \`last_test_message\` TEXT DEFAULT NULL,
            \`updated_by\` VARCHAR(255) DEFAULT NULL,
            \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);
      } catch (err: any) {
        console.warn('[MySQL Migration] Notice creating solar_email_settings table:', err.message);
      }

      // Ensure persistent solar_service_tickets extended columns & solar_service_ticket_history table exist
      try {
        const [tkCols]: any = await this.pool.query("SHOW COLUMNS FROM `solar_service_tickets`");
        const existingTkCols = new Set<string>((tkCols as any[]).map(c => String(c.Field).toLowerCase()));
        if (!existingTkCols.has('technician_remarks')) {
          await this.pool.query("ALTER TABLE `solar_service_tickets` ADD COLUMN `technician_remarks` TEXT DEFAULT NULL AFTER `notes`").catch(() => {});
        }
        if (!existingTkCols.has('resolution_details')) {
          await this.pool.query("ALTER TABLE `solar_service_tickets` ADD COLUMN `resolution_details` TEXT DEFAULT NULL AFTER `technician_remarks`").catch(() => {});
        }
        if (!existingTkCols.has('assigned_at')) {
          await this.pool.query("ALTER TABLE `solar_service_tickets` ADD COLUMN `assigned_at` DATETIME DEFAULT NULL AFTER `resolution_details`").catch(() => {});
        }
        if (!existingTkCols.has('assigned_by_user_id')) {
          await this.pool.query("ALTER TABLE `solar_service_tickets` ADD COLUMN `assigned_by_user_id` VARCHAR(64) DEFAULT NULL AFTER `assigned_at`").catch(() => {});
        }
        if (!existingTkCols.has('assigned_by_name')) {
          await this.pool.query("ALTER TABLE `solar_service_tickets` ADD COLUMN `assigned_by_name` VARCHAR(255) DEFAULT NULL AFTER `assigned_by_user_id`").catch(() => {});
        }
        if (!existingTkCols.has('updated_at')) {
          await this.pool.query("ALTER TABLE `solar_service_tickets` ADD COLUMN `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER `created_at`").catch(() => {});
        }

        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS \`solar_service_ticket_history\` (
            \`id\` VARCHAR(64) PRIMARY KEY,
            \`ticket_record_id\` VARCHAR(64) NOT NULL,
            \`ticket_code\` VARCHAR(64) DEFAULT '',
            \`action_type\` VARCHAR(64) NOT NULL,
            \`previous_value\` TEXT DEFAULT NULL,
            \`new_value\` TEXT DEFAULT NULL,
            \`remarks\` TEXT DEFAULT NULL,
            \`actor_user_id\` VARCHAR(64) DEFAULT '',
            \`actor_name\` VARCHAR(255) DEFAULT '',
            \`actor_role\` VARCHAR(64) DEFAULT '',
            \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX \`idx_srv_hist_ticket\` (\`ticket_record_id\`),
            INDEX \`idx_srv_hist_created\` (\`created_at\`)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);
      } catch (err: any) {
        console.warn('[MySQL Migration] Notice ensuring solar_service_tickets / history schema:', err.message);
      }

      // Ensure Employee Leave Management tables exist
      try {
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS \`solar_leave_requests\` (
            \`id\` VARCHAR(64) PRIMARY KEY,
            \`employee_id\` VARCHAR(64) NOT NULL,
            \`employee_code\` VARCHAR(64) DEFAULT '',
            \`employee_name\` VARCHAR(255) NOT NULL,
            \`department\` VARCHAR(100) DEFAULT '',
            \`designation\` VARCHAR(128) DEFAULT '',
            \`leave_type\` VARCHAR(32) NOT NULL,
            \`start_date\` DATE NOT NULL,
            \`end_date\` DATE NOT NULL,
            \`total_days\` DECIMAL(5,2) NOT NULL DEFAULT 1.00,
            \`is_half_day\` TINYINT(1) NOT NULL DEFAULT 0,
            \`half_day_session\` VARCHAR(24) DEFAULT '',
            \`reason\` TEXT NOT NULL,
            \`status\` VARCHAR(24) NOT NULL DEFAULT 'PENDING',
            \`leave_year\` INT NOT NULL,
            \`applied_at\` DATETIME DEFAULT CURRENT_TIMESTAMP,
            \`reviewed_by\` VARCHAR(255) DEFAULT NULL,
            \`reviewer_id\` VARCHAR(64) DEFAULT NULL,
            \`reviewed_at\` DATETIME DEFAULT NULL,
            \`admin_remarks\` TEXT DEFAULT NULL,
            \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX \`idx_leave_emp\` (\`employee_id\`),
            INDEX \`idx_leave_status\` (\`status\`),
            INDEX \`idx_leave_dates\` (\`start_date\`, \`end_date\`),
            INDEX \`idx_leave_year\` (\`leave_year\`)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS \`solar_leave_balances\` (
            \`id\` VARCHAR(96) PRIMARY KEY,
            \`employee_id\` VARCHAR(64) NOT NULL,
            \`leave_year\` INT NOT NULL,
            \`casual_total\` DECIMAL(5,2) NOT NULL DEFAULT 12.00,
            \`casual_used\` DECIMAL(5,2) NOT NULL DEFAULT 0.00,
            \`sick_total\` DECIMAL(5,2) NOT NULL DEFAULT 8.00,
            \`sick_used\` DECIMAL(5,2) NOT NULL DEFAULT 0.00,
            \`earned_total\` DECIMAL(5,2) NOT NULL DEFAULT 15.00,
            \`earned_used\` DECIMAL(5,2) NOT NULL DEFAULT 0.00,
            \`unpaid_used\` DECIMAL(5,2) NOT NULL DEFAULT 0.00,
            \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY \`uq_emp_leave_year\` (\`employee_id\`, \`leave_year\`),
            INDEX \`idx_leave_bal_emp\` (\`employee_id\`)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);
      } catch (err: any) {
        console.warn('[MySQL Migration] Notice ensuring leave management tables:', err.message);
      }

      // Ensure normalized Vendor Sales Invoices tables exist
      try {
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS \`solar_vendor_sales_invoices\` (
            \`id\` VARCHAR(64) PRIMARY KEY,
            \`invoice_number\` VARCHAR(64) NOT NULL UNIQUE,
            \`vendor_id\` VARCHAR(64) NOT NULL,
            \`vendor_code\` VARCHAR(64) DEFAULT '',
            \`vendor_name\` VARCHAR(255) NOT NULL,
            \`vendor_gst\` VARCHAR(64) DEFAULT '',
            \`vendor_address\` TEXT,
            \`vendor_city\` VARCHAR(128) DEFAULT '',
            \`vendor_state\` VARCHAR(128) DEFAULT '',
            \`vendor_contact_person\` VARCHAR(128) DEFAULT '',
            \`vendor_phone\` VARCHAR(64) DEFAULT '',
            \`vendor_email\` VARCHAR(191) DEFAULT '',
            \`company_state\` VARCHAR(128) DEFAULT 'Chhattisgarh',
            \`supply_type\` VARCHAR(32) NOT NULL DEFAULT 'INTRA_STATE',
            \`invoice_date\` DATE NOT NULL,
            \`due_date\` DATE DEFAULT NULL,
            \`payment_terms\` VARCHAR(128) DEFAULT '30 Days',
            \`notes\` TEXT,
            \`gross_amount\` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
            \`discount_amount\` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
            \`subtotal\` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
            \`cgst_amount\` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
            \`sgst_amount\` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
            \`igst_amount\` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
            \`tax_amount\` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
            \`total_amount\` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
            \`paid_amount\` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
            \`returned_amount\` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
            \`refunded_amount\` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
            \`balance_amount\` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
            \`bank_account_id\` VARCHAR(64) DEFAULT '',
            \`status\` VARCHAR(32) NOT NULL DEFAULT 'ISSUED',
            \`created_by\` VARCHAR(255) DEFAULT '',
            \`updated_by\` VARCHAR(255) DEFAULT '',
            \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX \`idx_vsi_vendor\` (\`vendor_id\`),
            INDEX \`idx_vsi_status\` (\`status\`),
            INDEX \`idx_vsi_date\` (\`invoice_date\`)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS \`solar_vendor_sales_invoice_items\` (
            \`id\` VARCHAR(64) PRIMARY KEY,
            \`invoice_id\` VARCHAR(64) NOT NULL,
            \`product_id\` VARCHAR(64) DEFAULT NULL,
            \`line_order\` INT NOT NULL DEFAULT 0,
            \`description\` VARCHAR(500) NOT NULL,
            \`hsn_code\` VARCHAR(32) DEFAULT '',
            \`quantity\` DECIMAL(12,3) NOT NULL DEFAULT 1.000,
            \`unit\` VARCHAR(32) NOT NULL DEFAULT 'NOS',
            \`rate\` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
            \`discount_type\` VARCHAR(16) NOT NULL DEFAULT 'PERCENT',
            \`discount_value\` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
            \`discount_amount\` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
            \`taxable_amount\` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
            \`gst_rate\` DECIMAL(5,2) NOT NULL DEFAULT 18.00,
            \`cgst_rate\` DECIMAL(5,2) NOT NULL DEFAULT 0.00,
            \`cgst_amount\` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
            \`sgst_rate\` DECIMAL(5,2) NOT NULL DEFAULT 0.00,
            \`sgst_amount\` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
            \`igst_rate\` DECIMAL(5,2) NOT NULL DEFAULT 0.00,
            \`igst_amount\` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
            \`tax_amount\` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
            \`total_amount\` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
            \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX \`idx_vsii_invoice\` (\`invoice_id\`),
            INDEX \`idx_vsii_product\` (\`product_id\`),
            CONSTRAINT \`fk_vsii_invoice\` FOREIGN KEY (\`invoice_id\`) REFERENCES \`solar_vendor_sales_invoices\` (\`id\`) ON DELETE CASCADE
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS \`solar_vendor_sales_payments\` (
            \`id\` VARCHAR(64) PRIMARY KEY,
            \`invoice_id\` VARCHAR(64) NOT NULL,
            \`vendor_id\` VARCHAR(64) NOT NULL,
            \`payment_date\` DATE NOT NULL,
            \`amount\` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
            \`payment_mode\` VARCHAR(64) NOT NULL DEFAULT 'Bank NEFT/RTGS',
            \`reference_no\` VARCHAR(128) DEFAULT '',
            \`notes\` TEXT,
            \`bank_account_id\` VARCHAR(64) DEFAULT '',
            \`journal_entry_id\` VARCHAR(64) DEFAULT '',
            \`recorded_by\` VARCHAR(255) DEFAULT '',
            \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX \`idx_vsip_invoice\` (\`invoice_id\`),
            INDEX \`idx_vsip_vendor\` (\`vendor_id\`),
            CONSTRAINT \`fk_vsip_invoice\` FOREIGN KEY (\`invoice_id\`) REFERENCES \`solar_vendor_sales_invoices\` (\`id\`) ON DELETE CASCADE
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);
      } catch (err: any) {
        console.warn('[MySQL Migration] Notice ensuring vendor sales invoice tables:', err.message);
      }

      // Ensure schema migration tracking & centralized audit logs tables exist
      try {
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS \`solar_schema_migrations\` (
            \`version\` VARCHAR(128) PRIMARY KEY,
            \`description\` VARCHAR(500) NOT NULL DEFAULT '',
            \`applied_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS \`solar_audit_logs\` (
            \`id\` VARCHAR(64) PRIMARY KEY,
            \`actor_id\` VARCHAR(64) NOT NULL DEFAULT 'system',
            \`actor_name\` VARCHAR(255) NOT NULL DEFAULT 'System',
            \`actor_role\` VARCHAR(64) NOT NULL DEFAULT 'System',
            \`module\` VARCHAR(64) NOT NULL,
            \`action\` VARCHAR(64) NOT NULL,
            \`entity_type\` VARCHAR(64) DEFAULT '',
            \`entity_id\` VARCHAR(64) DEFAULT '',
            \`summary\` TEXT NOT NULL,
            \`details_json\` LONGTEXT DEFAULT NULL,
            \`ip_address\` VARCHAR(64) DEFAULT '',
            \`user_agent\` VARCHAR(500) DEFAULT '',
            \`status\` VARCHAR(24) NOT NULL DEFAULT 'SUCCESS',
            \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX \`idx_audit_module\` (\`module\`),
            INDEX \`idx_audit_action\` (\`action\`),
            INDEX \`idx_audit_actor\` (\`actor_id\`),
            INDEX \`idx_audit_entity\` (\`entity_type\`, \`entity_id\`),
            INDEX \`idx_audit_created\` (\`created_at\`)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);
      } catch (err: any) {
        console.warn('[MySQL Migration] Notice ensuring migrations/audit tables:', err.message);
      }

      await this.ensureHashedPasswords();
      await this.seedDefaultDemoUsersIfEmpty();
      await authService.initAuthSchema(this.pool);
      await accountingService.ensureAccountingSchema(this.pool);
      await this.ensureRelationalForeignKeys();
    } catch (err: any) {
      console.error('[MySQL] Schema execution notice:', err?.message || err);
      throw err;
    }
  }

  private async ensureRelationalForeignKeys(): Promise<void> {
    if (!this.pool || !this.isConnected) return;
    const fkSpecs: Array<{
      table: string;
      name: string;
      column: string;
      refTable: string;
      refColumn: string;
      onDelete: string;
    }> = [
      { table: 'solar_projects', name: 'fk_proj_customer', column: 'customer_id', refTable: 'solar_customers', refColumn: 'id', onDelete: 'RESTRICT' },
      { table: 'solar_project_stages', name: 'fk_stage_project', column: 'project_id', refTable: 'solar_projects', refColumn: 'id', onDelete: 'CASCADE' },
      { table: 'solar_payments', name: 'fk_payment_project', column: 'project_id', refTable: 'solar_projects', refColumn: 'id', onDelete: 'CASCADE' },
      { table: 'solar_boms', name: 'fk_bom_project', column: 'project_id', refTable: 'solar_projects', refColumn: 'id', onDelete: 'CASCADE' },
      { table: 'solar_purchase_orders', name: 'fk_po_vendor', column: 'vendor_id', refTable: 'solar_vendors', refColumn: 'id', onDelete: 'RESTRICT' },
      { table: 'solar_sales_invoices', name: 'fk_sinv_customer', column: 'customer_id', refTable: 'solar_customers', refColumn: 'id', onDelete: 'RESTRICT' },
      { table: 'solar_vendor_sales_invoices', name: 'fk_vsi_vendor', column: 'vendor_id', refTable: 'solar_vendors', refColumn: 'id', onDelete: 'RESTRICT' },
      { table: 'solar_service_tickets', name: 'fk_ticket_customer', column: 'customer_id', refTable: 'solar_customers', refColumn: 'id', onDelete: 'CASCADE' },
      { table: 'solar_service_ticket_history', name: 'fk_srv_hist_ticket', column: 'ticket_record_id', refTable: 'solar_service_tickets', refColumn: 'id', onDelete: 'CASCADE' },
      { table: 'solar_amc_contracts', name: 'fk_amc_customer', column: 'customer_id', refTable: 'solar_customers', refColumn: 'id', onDelete: 'CASCADE' },
      { table: 'solar_amc_contracts', name: 'fk_amc_project', column: 'project_id', refTable: 'solar_projects', refColumn: 'id', onDelete: 'CASCADE' },
      { table: 'solar_stock_movements', name: 'fk_sm_product', column: 'product_id', refTable: 'solar_products', refColumn: 'id', onDelete: 'CASCADE' },
      { table: 'solar_acc_vendor_payments', name: 'fk_vp_bill', column: 'bill_id', refTable: 'solar_acc_vendor_bills', refColumn: 'id', onDelete: 'CASCADE' },
      { table: 'solar_acc_bank_reconciliations', name: 'fk_br_bank', column: 'bank_account_id', refTable: 'solar_acc_bank_accounts', refColumn: 'id', onDelete: 'CASCADE' },
      { table: 'solar_auth_credentials', name: 'fk_auth_cred_user', column: 'user_id', refTable: 'solar_users', refColumn: 'id', onDelete: 'CASCADE' },
      { table: 'solar_auth_sessions', name: 'fk_auth_sess_user', column: 'user_id', refTable: 'solar_users', refColumn: 'id', onDelete: 'CASCADE' },
      { table: 'solar_employee_documents', name: 'fk_emp_docs_emp', column: 'employee_id', refTable: 'solar_employee', refColumn: 'id', onDelete: 'CASCADE' },
      { table: 'solar_attendance', name: 'fk_att_emp', column: 'employee_id', refTable: 'solar_employee', refColumn: 'id', onDelete: 'CASCADE' },
      { table: 'solar_payslips', name: 'fk_pay_emp', column: 'employee_id', refTable: 'solar_employee', refColumn: 'id', onDelete: 'CASCADE' },
      { table: 'solar_leave_requests', name: 'fk_leave_req_emp', column: 'employee_id', refTable: 'solar_employee', refColumn: 'id', onDelete: 'CASCADE' },
      { table: 'solar_leave_balances', name: 'fk_leave_bal_emp', column: 'employee_id', refTable: 'solar_employee', refColumn: 'id', onDelete: 'CASCADE' }
    ];

    try {
      const [existingRows]: any = await this.pool.query(
        `SELECT TABLE_NAME, CONSTRAINT_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
         WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_TYPE = 'FOREIGN KEY'`
      );
      const existingFks = new Set<string>(
        (existingRows || []).map((r: any) => `${r.TABLE_NAME}.${r.CONSTRAINT_NAME}`.toLowerCase())
      );
      const [baseTableRows]: any = await this.pool.query(
        `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'`
      );
      const baseTables = new Set<string>((baseTableRows || []).map((r: any) => String(r.TABLE_NAME).toLowerCase()));

      for (const fk of fkSpecs) {
        if (!baseTables.has(fk.table.toLowerCase()) || !baseTables.has(fk.refTable.toLowerCase())) continue;
        if (existingFks.has(`${fk.table}.${fk.name}`.toLowerCase())) continue;
        await this.pool
          .query(
            `ALTER TABLE \`${fk.table}\` ADD CONSTRAINT \`${fk.name}\` FOREIGN KEY (\`${fk.column}\`) REFERENCES \`${fk.refTable}\` (\`${fk.refColumn}\`) ON DELETE ${fk.onDelete}`
          )
          .catch(() => {});
      }

      await this.pool
        .query(
          `INSERT IGNORE INTO \`solar_schema_migrations\` (\`version\`, \`description\`) VALUES (?, ?)`,
          ['2026_11_26_production_schema_fk_and_audit', 'Production schema with relational foreign keys and centralized audit logs']
        )
        .catch(() => {});
    } catch (err: any) {
      console.warn('[MySQL FK Bootstrap] Notice:', err?.message || err);
    }
  }

  public async runFullMigration(customConfig?: Partial<DbConfig>): Promise<{ success: boolean; message: string; tablesCount?: number }> {
    const dumpPath = path.join(process.cwd(), 'database.sql');
    if (!fs.existsSync(dumpPath)) {
      return { success: false, message: 'database.sql dump file not found on server.' };
    }
    const sql = fs.readFileSync(dumpPath, 'utf-8');

    if (customConfig && customConfig.host) {
      let conn: mysql.Connection | null = null;
      try {
        const cfg = { ...this.config, ...customConfig };
        try {
          const setupConn = await mysql.createConnection({
            host: cfg.host,
            port: cfg.port,
            user: cfg.user,
            password: cfg.password,
            charset: 'utf8mb4_unicode_ci',
            connectTimeout: 5000
          });
          await setupConn.query(`CREATE DATABASE IF NOT EXISTS \`${cfg.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
          await setupConn.end();
        } catch {}

        conn = await mysql.createConnection({
          host: cfg.host,
          port: cfg.port,
          user: cfg.user,
          password: cfg.password,
          database: cfg.database,
          charset: 'utf8mb4_unicode_ci',
          multipleStatements: true
        });
        await conn.query(sql);
        const [tables]: any = await conn.query('SHOW TABLES');
        await conn.end();

        this.config = { ...this.config, ...customConfig };
        await this.init();

        return {
          success: true,
          message: `Successfully executed schema & pushed tables to ${cfg.database} on ${cfg.host}!`,
          tablesCount: Array.isArray(tables) ? tables.length : 28
        };
      } catch (err: any) {
        if (conn) try { await conn.end(); } catch {}
        return { success: false, message: `Migration error: ${err.message}` };
      }
    }

    if (!this.isConnected || !this.pool) {
      throw new Error('MySQL connection is not active.');
    }

    try {
      await this.pool.query(sql);
      const [tables]: any = await this.pool.query('SHOW TABLES');
      return {
        success: true,
        message: `Successfully applied schema and synchronized data with MySQL ${this.config.database}!`,
        tablesCount: Array.isArray(tables) ? tables.length : 28
      };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }

  public getStatus() {
    return {
      connected: this.isConnected,
      host: this.config.host || '127.0.0.1',
      database: this.config.database,
      port: this.config.port,
      user: this.config.user,
      mode: this.isConnected ? 'LIVE_MYSQL_POOL' : 'IN_MEMORY_FALLBACK',
      dumpAvailable: fs.existsSync(path.join(process.cwd(), 'database.sql')),
      dumpPath: '/database.sql'
    };
  }

  public isDbConnected(): boolean {
    return this.isConnected && Boolean(this.pool);
  }

  public getPool(): mysql.Pool | null {
    return this.isConnected ? this.pool : null;
  }

  private assertDbConnected(): void {
    if (!this.isConnected || !this.pool) {
      throw new DbConnectionError(
        `MySQL database "${this.config.database}" at ${this.config.host}:${this.config.port} is disconnected. Cannot read or mutate business records without a live MySQL connection.`
      );
    }
  }

  public getFallbackItems(_collection: string): any[] {
    this.assertDbConnected();
    return [];
  }

  public setFallbackItems(_collection: string, _items: any[]): void {
    // No-op: MySQL is the single source of truth; no disk/memory fallback cache is written.
  }

  public upsertFallback(_collection: string, item: any): any {
    return item;
  }

  public deleteFallback(_collection: string, _id: string): boolean {
    return true;
  }

  public async query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    this.assertDbConnected();
    const [rows] = await this.pool!.query(sql, params);
    return rows as T[];
  }

  private async getExistingRow(table: string, id: string): Promise<any | null> {
    if (!id) return null;
    this.assertDbConnected();
    try {
      const [rows]: any = await this.pool!.query(`SELECT * FROM \`${table}\` WHERE \`id\` = ? LIMIT 1`, [id]);
      return (Array.isArray(rows) && rows.length > 0) ? rows[0] : null;
    } catch {
      return null;
    }
  }

  private toSqlDate(d: any): string | null {
    if (!d) return null;
    if (d instanceof Date) {
      if (isNaN(d.getTime())) return null;
      return d.toISOString().split('T')[0];
    }
    const s = String(d).trim();
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const dmy = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (dmy) {
      return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
    }
    const parsed = new Date(s);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString().split('T')[0];
    }
    return s.slice(0, 10);
  }

  private toSqlDateTime(d: any): string {
    if (!d) return new Date().toISOString().slice(0, 19).replace('T', ' ');
    if (d instanceof Date) {
      if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 19).replace('T', ' ');
      return d.toISOString().slice(0, 19).replace('T', ' ');
    }
    const s = String(d).trim();
    const parsed = new Date(s);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 19).replace('T', ' ');
    }
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
  }

  // ==========================================================
  // CRUD: CUSTOMERS
  // ==========================================================
  public async getCustomers(): Promise<any[]> {
    if (!this.isConnected) return this.getFallbackItems('customers');
    this.assertDbConnected();
    const [rows] = await this.pool!.query('SELECT * FROM `solar_customers` ORDER BY `created_at` DESC');
    const mapped = (rows as any[]).map(r => ({
      id: r.id,
      customerCode: r.customer_code,
      name: r.name,
      companyName: r.company_name,
      customerType: r.customer_type,
      phone: r.phone,
      email: r.email,
      siteAddress: r.site_address,
      city: r.city,
      state: r.state,
      pincode: r.pincode,
      gstNumber: r.gst_number,
      electricityConsumerNo: r.electricity_consumer_no,
      sanctionedLoadKw: Number(r.sanctioned_load_kw) || 0,
      status: r.status,
      activeProjectId: r.active_project_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }));
    this.setFallbackItems('customers', mapped);
    return mapped;
  }

  public async saveCustomer(cust: any): Promise<any> {
    this.assertDbConnected();
    const timestamp = new Date().toISOString();
    const item = { ...cust, updatedAt: timestamp };
    if (!item.createdAt) item.createdAt = timestamp;

    const existing = await this.getExistingRow('solar_customers', item.id);
    const customerCode = item.customerCode ?? item.customer_code ?? existing?.customer_code ?? item.id;
    const name = item.name ?? existing?.name ?? '';
    const companyName = item.companyName ?? item.company_name ?? existing?.company_name ?? '';
    const customerType = item.customerType ?? item.customer_type ?? existing?.customer_type ?? 'Residential';
    const phone = item.phone ?? existing?.phone ?? '';
    const email = item.email ?? existing?.email ?? '';
    let password = item.password ?? existing?.password ?? `Cust@${Date.now().toString().slice(-6)}`;
    if (password && !password.startsWith('$2a$') && !password.startsWith('$2b$') && !password.startsWith('$2y$')) {
      password = await bcrypt.hash(password, 10);
    }
    const siteAddress = item.siteAddress ?? item.site_address ?? existing?.site_address ?? 'Not specified';
    const city = item.city ?? existing?.city ?? 'Not specified';
    const state = item.state ?? existing?.state ?? 'Gujarat';
    const pincode = item.pincode ?? existing?.pincode ?? '';
    const gstNumber = item.gstNumber ?? item.gst_number ?? existing?.gst_number ?? '';
    const electricityConsumerNo = item.electricityConsumerNo ?? item.electricity_consumer_no ?? existing?.electricity_consumer_no ?? '';
    const sanctionedLoadKw = Number(item.sanctionedLoadKw ?? item.sanctioned_load_kw ?? existing?.sanctioned_load_kw) || 0;
    const status = item.status ?? existing?.status ?? 'ACTIVE';
    const activeProjectId = item.activeProjectId ?? item.active_project_id ?? existing?.active_project_id ?? null;

    const sql = `
      INSERT INTO \`solar_customers\` (
        \`id\`, \`customer_code\`, \`name\`, \`company_name\`, \`customer_type\`,
        \`phone\`, \`email\`, \`password\`, \`site_address\`, \`city\`, \`state\`,
        \`pincode\`, \`gst_number\`, \`electricity_consumer_no\`, \`sanctioned_load_kw\`,
        \`status\`, \`active_project_id\`
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        \`name\` = VALUES(\`name\`), \`company_name\` = VALUES(\`company_name\`),
        \`customer_type\` = VALUES(\`customer_type\`), \`phone\` = VALUES(\`phone\`),
        \`email\` = VALUES(\`email\`), \`password\` = VALUES(\`password\`),
        \`site_address\` = VALUES(\`site_address\`), \`city\` = VALUES(\`city\`),
        \`state\` = VALUES(\`state\`), \`pincode\` = VALUES(\`pincode\`),
        \`gst_number\` = VALUES(\`gst_number\`), \`electricity_consumer_no\` = VALUES(\`electricity_consumer_no\`),
        \`sanctioned_load_kw\` = VALUES(\`sanctioned_load_kw\`), \`status\` = VALUES(\`status\`),
        \`active_project_id\` = VALUES(\`active_project_id\`)
    `;
    await this.pool!.query(sql, [
      item.id,
      customerCode,
      name,
      companyName,
      customerType,
      phone,
      email,
      password,
      siteAddress,
      city,
      state,
      pincode,
      gstNumber,
      electricityConsumerNo,
      sanctionedLoadKw,
      status,
      activeProjectId
    ]);

    // Synchronize customer credentials to centralized solar_auth_credentials
    if (this.pool && email) {
      try {
        await authService.setCredential(this.pool, {
          userId: `usr-${item.id}`,
          email,
          password: password,
          role: 'Customer',
          accountType: 'CUSTOMER',
          linkedEntityId: item.id,
          status
        });
      } catch (err: any) {
        console.warn('[DB Manager] Notice syncing customer credential:', err.message);
      }
    }

    const items = this.getFallbackItems('customers');
    const idx = items.findIndex(c => c.id === item.id);
    if (idx >= 0) items[idx] = { ...items[idx], ...item };
    else items.unshift(item);
    this.setFallbackItems('customers', items);
    return item;
  }

  public async deleteCustomer(id: string): Promise<boolean> {
    this.assertDbConnected();
    if (this.pool) {
      await this.pool.query('DELETE FROM `solar_customers` WHERE `id` = ?', [id]);
      await this.pool.query('DELETE FROM `solar_auth_credentials` WHERE `user_id` = ? OR `linked_entity_id` = ?', [`usr-${id}`, id]).catch(() => {});
      await this.pool.query('DELETE FROM `solar_auth_sessions` WHERE `user_id` = ? OR `linked_entity_id` = ?', [`usr-${id}`, id]).catch(() => {});
    }
    const items = this.getFallbackItems('customers').filter(c => c.id !== id);
    this.setFallbackItems('customers', items);
    return true;
  }

  public async updateCustomerPassword(customerId: string, newPass: string): Promise<boolean> {
    const clean = newPass.trim();
    const hashed = (clean.startsWith('$2a$') || clean.startsWith('$2b$') || clean.startsWith('$2y$'))
      ? clean
      : await bcrypt.hash(clean, 10);

    const items = this.getFallbackItems('customers');
    const target = items.find(c => c.id === customerId);
    if (target) {
      target.password = hashed;
      this.setFallbackItems('customers', items);
    }

    if (!this.isConnected || !this.pool) return true;

    this.assertDbConnected();
    await this.pool.query('UPDATE `solar_customers` SET `password` = ? WHERE `id` = ?', [hashed, customerId]);
    await authService.updatePassword(this.pool, `usr-${customerId}`, clean);
    return true;
  }

  public async importCustomers(customerList: any[]): Promise<{
    success: boolean;
    total: number;
    imported: number;
    skipped: number;
    failed: number;
    importedRecords: any[];
    skippedRecords: { row: number; name: string; reason: string }[];
    failedRecords: { row: number; reason: string }[];
    errors: string[];
  }> {
    this.assertDbConnected();

    if (!Array.isArray(customerList) || customerList.length === 0) {
      return {
        success: true,
        total: 0,
        imported: 0,
        skipped: 0,
        failed: 0,
        importedRecords: [],
        skippedRecords: [],
        failedRecords: [],
        errors: []
      };
    }

    // 1. Fetch existing customers from MySQL to check duplicates accurately
    let existingCustomers: any[] = [];
    if (this.isConnected && this.pool) {
      const [rows] = await this.pool.query(
        'SELECT id, customer_code, name, company_name, phone, email, gst_number, city FROM `solar_customers`'
      );
      existingCustomers = rows as any[];
    } else {
      existingCustomers = this.getFallbackItems('customers');
    }

    // Helper normalization functions
    const normalizeDigits = (p: any) => String(p || '').replace(/\D/g, '');
    const normalizeEmail = (e: any) => String(e || '').trim().toLowerCase();
    const normalizeGst = (g: any) => String(g || '').trim().toUpperCase().replace(/[\s-]/g, '');
    const normalizeText = (t: any) => String(t || '').trim().toLowerCase().replace(/\s+/g, ' ');

    // Track existing values to prevent duplicates
    const phoneSet = new Map<string, string>();
    const emailSet = new Map<string, string>();
    const gstSet = new Map<string, string>();
    const nameCitySet = new Set<string>();
    const nameCompSet = new Set<string>();
    const existingCodes = new Set<string>();

    for (const ec of existingCustomers) {
      if (ec.customer_code) existingCodes.add(String(ec.customer_code).toUpperCase());
      const p = normalizeDigits(ec.phone);
      if (p.length >= 7) phoneSet.set(p, ec.name);
      const em = normalizeEmail(ec.email);
      if (em) emailSet.set(em, ec.name);
      const gst = normalizeGst(ec.gst_number);
      if (gst) gstSet.set(gst, ec.name);
      const nm = normalizeText(ec.name);
      const city = normalizeText(ec.city);
      const comp = normalizeText(ec.company_name);
      if (nm && city) nameCitySet.add(`${nm}:::${city}`);
      if (nm && comp) nameCompSet.add(`${nm}:::${comp}`);
    }

    const importedRecords: any[] = [];
    const skippedRecords: { row: number; name: string; reason: string }[] = [];
    const failedRecords: { row: number; reason: string }[] = [];
    const errors: string[] = [];

    let codeSeq = Date.now() % 10000;

    for (let i = 0; i < customerList.length; i++) {
      const rowNum = i + 1;
      const raw = customerList[i];
      if (!raw || typeof raw !== 'object') {
        failedRecords.push({ row: rowNum, reason: 'Empty or malformed record.' });
        errors.push(`Row ${rowNum}: Empty or malformed record.`);
        continue;
      }

      const name = String(raw.name || raw.customerName || '').trim();
      if (!name) {
        failedRecords.push({ row: rowNum, reason: 'Customer name is mandatory.' });
        errors.push(`Row ${rowNum}: Customer name is mandatory.`);
        continue;
      }

      const phoneRaw = String(raw.phone || '').trim();
      const phoneDigits = normalizeDigits(phoneRaw);
      if (phoneDigits.length < 7) {
        failedRecords.push({ row: rowNum, reason: `Valid phone number is required (got "${phoneRaw || 'empty'}").` });
        errors.push(`Row ${rowNum}: Valid phone number is required (got "${phoneRaw || 'empty'}").`);
        continue;
      }

      const email = normalizeEmail(raw.email);
      const gst = normalizeGst(raw.gstNumber || raw.gst_number);
      const companyName = String(raw.companyName || raw.company_name || '').trim();
      const city = String(raw.city || 'Ahmedabad').trim();
      const normName = normalizeText(name);
      const normCity = normalizeText(city);
      const normComp = normalizeText(companyName);

      // Check duplicates
      let isDuplicate = false;
      let dupReason = '';

      for (const [existingPhone, custName] of phoneSet.entries()) {
        if (
          existingPhone === phoneDigits ||
          (phoneDigits.length >= 10 && existingPhone.endsWith(phoneDigits.slice(-10))) ||
          (existingPhone.length >= 10 && phoneDigits.endsWith(existingPhone.slice(-10)))
        ) {
          isDuplicate = true;
          dupReason = `Phone number "${phoneRaw}" is already registered to "${custName}".`;
          break;
        }
      }

      if (!isDuplicate && email && emailSet.has(email)) {
        isDuplicate = true;
        dupReason = `Email address "${email}" is already registered to "${emailSet.get(email)}".`;
      }

      if (!isDuplicate && gst && gstSet.has(gst)) {
        isDuplicate = true;
        dupReason = `GSTIN "${gst}" is already registered to "${gstSet.get(gst)}".`;
      }

      if (!isDuplicate && normName && normComp && nameCompSet.has(`${normName}:::${normComp}`)) {
        isDuplicate = true;
        dupReason = `Customer "${name}" under company "${companyName}" is already registered.`;
      } else if (!isDuplicate && normName && normCity && nameCitySet.has(`${normName}:::${normCity}`)) {
        isDuplicate = true;
        dupReason = `Customer "${name}" in "${city}" is already registered.`;
      }

      if (isDuplicate) {
        skippedRecords.push({ row: rowNum, name, reason: dupReason });
        errors.push(`Row ${rowNum} Skipped (Duplicate): ${dupReason}`);
        continue;
      }

      // Generate unique customer ID and unique customer code
      const custId = raw.id && String(raw.id).startsWith('cust-')
        ? String(raw.id)
        : `cust-${Date.now()}-${i + 1}-${Math.random().toString(36).substring(2, 6)}`;

      let customerCode = raw.customerCode || raw.customer_code || '';
      if (!customerCode || existingCodes.has(String(customerCode).toUpperCase())) {
        do {
          codeSeq++;
          customerCode = `CUST-${new Date().getFullYear()}-${String(codeSeq).padStart(4, '0')}`;
        } while (existingCodes.has(customerCode.toUpperCase()));
      }
      existingCodes.add(customerCode.toUpperCase());

      // Hash password
      const rawPass = String(raw.password || '123456').trim();
      const hashedPassword = (rawPass.startsWith('$2a$') || rawPass.startsWith('$2b$') || rawPass.startsWith('$2y$'))
        ? rawPass
        : await bcrypt.hash(rawPass, 10);

      const customerType = raw.customerType || raw.customer_type || (companyName ? 'Commercial' : 'Residential');
      const siteAddress = String(raw.siteAddress || raw.site_address || raw.address || `${city}, Gujarat`).trim();
      const state = String(raw.state || 'Gujarat').trim();
      const pincode = String(raw.pincode || '380001').trim();
      const sanctionedLoadKw = Number(raw.sanctionedLoadKw ?? raw.sanctioned_load_kw) || 0;
      const status = raw.status || 'ACTIVE';
      const electricityConsumerNo = String(raw.electricityConsumerNo || raw.electricity_consumer_no || '').trim();
      const nowIso = new Date().toISOString();

      const customerObj = {
        id: custId,
        customerCode,
        name,
        companyName,
        customerType,
        phone: phoneRaw,
        email,
        password: hashedPassword,
        siteAddress,
        city,
        state,
        pincode,
        gstNumber: gst,
        electricityConsumerNo,
        sanctionedLoadKw,
        status,
        activeProjectId: raw.activeProjectId || null,
        createdAt: nowIso,
        updatedAt: nowIso
      };

      if (this.isConnected && this.pool) {
        const sql = `
          INSERT INTO \`solar_customers\` (
            \`id\`, \`customer_code\`, \`name\`, \`company_name\`, \`customer_type\`,
            \`phone\`, \`email\`, \`password\`, \`site_address\`, \`city\`, \`state\`,
            \`pincode\`, \`gst_number\`, \`electricity_consumer_no\`, \`sanctioned_load_kw\`,
            \`status\`, \`active_project_id\`
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        await this.pool.query(sql, [
          custId,
          customerCode,
          name,
          companyName,
          customerType,
          phoneRaw,
          email,
          hashedPassword,
          siteAddress,
          city,
          state,
          pincode,
          gst,
          electricityConsumerNo,
          sanctionedLoadKw,
          status,
          customerObj.activeProjectId
        ]);

        if (email) {
          try {
            await authService.setCredential(this.pool, {
              userId: `usr-${custId}`,
              email,
              password: rawPass,
              role: 'Customer',
              accountType: 'CUSTOMER',
              linkedEntityId: custId,
              status
            });
          } catch {}
        }
      }

      phoneSet.set(phoneDigits, name);
      if (email) emailSet.set(email, name);
      if (gst) gstSet.set(gst, name);
      if (normName && normCity) nameCitySet.add(`${normName}:::${normCity}`);
      if (normName && normComp) nameCompSet.add(`${normName}:::${normComp}`);

      const fallbackList = this.getFallbackItems('customers');
      const fIdx = fallbackList.findIndex(c => c.id === custId);
      if (fIdx >= 0) fallbackList[fIdx] = customerObj;
      else fallbackList.unshift(customerObj);
      this.setFallbackItems('customers', fallbackList);

      importedRecords.push(customerObj);
    }

    return {
      success: true,
      total: customerList.length,
      imported: importedRecords.length,
      skipped: skippedRecords.length,
      failed: failedRecords.length,
      importedRecords,
      skippedRecords,
      failedRecords,
      errors
    };
  }

  // ==========================================================
  // CRUD: LEADS
  // ==========================================================
  public async getLeads(): Promise<any[]> {
    if (!this.isConnected) return this.getFallbackItems('leads');
    this.assertDbConnected();
    const [rows] = await this.pool!.query('SELECT * FROM `solar_leads` ORDER BY `created_at` DESC');
    const mapped = (rows as any[]).map(r => ({
      id: r.id,
      customerName: r.customer_name,
      companyName: r.company_name,
      phone: r.phone,
      email: r.email,
      address: r.address,
      city: r.city,
      solarCapacityKw: Number(r.solar_capacity_kw) || 0,
      estimatedValue: Number(r.estimated_value) || 0,
      source: r.source,
      assignedSalespersonId: r.assigned_salesperson_id,
      assignedSalespersonName: r.assigned_salesperson_name,
      status: r.status,
      notes: r.notes,
      nextFollowUpDate: r.next_follow_up_date,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }));
    this.setFallbackItems('leads', mapped);
    return mapped;
  }

  public async getLeadById(id: string): Promise<any | null> {
    if (!this.isConnected) {
      return this.getFallbackItems('leads').find((l: any) => l.id === id) || null;
    }
    this.assertDbConnected();
    const [rows]: any = await this.pool!.query('SELECT * FROM `solar_leads` WHERE `id` = ? LIMIT 1', [id]);
    const r = Array.isArray(rows) ? rows[0] : null;
    if (!r) return null;
    return {
      id: r.id,
      customerName: r.customer_name,
      companyName: r.company_name ?? '',
      phone: r.phone,
      email: r.email ?? '',
      address: r.address ?? '',
      city: r.city ?? '',
      solarCapacityKw: Number(r.solar_capacity_kw) || 0,
      estimatedValue: Number(r.estimated_value) || 0,
      source: r.source ?? 'Website',
      assignedSalespersonId: r.assigned_salesperson_id ?? '',
      assignedSalespersonName: r.assigned_salesperson_name ?? '',
      status: r.status ?? 'NEW',
      notes: r.notes ?? '',
      nextFollowUpDate: r.next_follow_up_date || '',
      createdAt: r.created_at,
      updatedAt: r.updated_at
    };
  }

  public async saveLead(lead: any): Promise<any> {
    this.assertDbConnected();
    const timestamp = new Date().toISOString();
    const item = { ...lead, updatedAt: timestamp };
    if (!item.id) item.id = `lead-${Date.now()}`;
    if (!item.createdAt) item.createdAt = timestamp;

    const existing = await this.getExistingRow('solar_leads', item.id);
    const has = (k: string) => Object.prototype.hasOwnProperty.call(item, k) && item[k] !== undefined;

    const customerName = has('customerName') ? String(item.customerName).trim() : (has('customer_name') ? String(item.customer_name).trim() : (existing?.customer_name ?? ''));
    const companyName = has('companyName') ? String(item.companyName ?? '').trim() : (has('company_name') ? String(item.company_name ?? '').trim() : (existing?.company_name ?? ''));
    const phone = has('phone') ? String(item.phone).trim() : (existing?.phone ?? '');
    const email = has('email') ? String(item.email ?? '').trim() : (existing?.email ?? '');
    const address = has('address') ? String(item.address ?? '').trim() : (existing?.address ?? '');
    const city = has('city') ? String(item.city ?? '').trim() : (existing?.city ?? '');
    const solarCapacityKw = has('solarCapacityKw')
      ? (Number(item.solarCapacityKw) || 0)
      : (has('solar_capacity_kw') ? (Number(item.solar_capacity_kw) || 0) : (Number(existing?.solar_capacity_kw) || 0));
    const estimatedValue = has('estimatedValue')
      ? (Number(item.estimatedValue) || 0)
      : (has('estimated_value') ? (Number(item.estimated_value) || 0) : (Number(existing?.estimated_value) || 0));
    const source = has('source') ? (String(item.source || '').trim() || 'Website') : (existing?.source ?? 'Website');

    const assignedSalespersonId = has('assignedSalespersonId')
      ? String(item.assignedSalespersonId ?? '').trim()
      : (has('assigned_salesperson_id')
          ? String(item.assigned_salesperson_id ?? '').trim()
          : (has('assignedToId') ? String(item.assignedToId ?? '').trim() : (existing?.assigned_salesperson_id ?? '')));

    const assignedSalespersonName = has('assignedSalespersonName')
      ? String(item.assignedSalespersonName ?? '').trim()
      : (has('assigned_salesperson_name')
          ? String(item.assigned_salesperson_name ?? '').trim()
          : (has('assignedToName') ? String(item.assignedToName ?? '').trim() : (existing?.assigned_salesperson_name ?? '')));

    const status = has('status') ? (String(item.status || '').trim() || 'NEW') : (existing?.status ?? 'NEW');
    const notes = has('notes') ? String(item.notes ?? '') : (existing?.notes ?? '');
    const rawNextFollowUp = has('nextFollowUpDate')
      ? item.nextFollowUpDate
      : (has('next_follow_up_date') ? item.next_follow_up_date : existing?.next_follow_up_date);
    const nextFollowUpDate = rawNextFollowUp ? String(rawNextFollowUp).split('T')[0] : null;

    const sql = `
      INSERT INTO \`solar_leads\` (
        \`id\`, \`customer_name\`, \`company_name\`, \`phone\`, \`email\`,
        \`address\`, \`city\`, \`solar_capacity_kw\`, \`estimated_value\`,
        \`source\`, \`assigned_salesperson_id\`, \`assigned_salesperson_name\`,
        \`status\`, \`notes\`, \`next_follow_up_date\`
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        \`customer_name\` = VALUES(\`customer_name\`), \`company_name\` = VALUES(\`company_name\`),
        \`phone\` = VALUES(\`phone\`), \`email\` = VALUES(\`email\`),
        \`address\` = VALUES(\`address\`), \`city\` = VALUES(\`city\`),
        \`solar_capacity_kw\` = VALUES(\`solar_capacity_kw\`), \`estimated_value\` = VALUES(\`estimated_value\`),
        \`source\` = VALUES(\`source\`), \`assigned_salesperson_id\` = VALUES(\`assigned_salesperson_id\`),
        \`assigned_salesperson_name\` = VALUES(\`assigned_salesperson_name\`), \`status\` = VALUES(\`status\`),
        \`notes\` = VALUES(\`notes\`), \`next_follow_up_date\` = VALUES(\`next_follow_up_date\`)
    `;
    await this.pool!.query(sql, [
      item.id,
      customerName,
      companyName,
      phone,
      email,
      address,
      city,
      solarCapacityKw,
      estimatedValue,
      source,
      assignedSalespersonId,
      assignedSalespersonName,
      status,
      notes,
      nextFollowUpDate
    ]);

    const savedLead = (await this.getLeadById(item.id)) || {
      id: item.id,
      customerName,
      companyName,
      phone,
      email,
      address,
      city,
      solarCapacityKw,
      estimatedValue,
      source,
      assignedSalespersonId,
      assignedSalespersonName,
      status,
      notes,
      nextFollowUpDate: nextFollowUpDate || '',
      createdAt: existing?.created_at || item.createdAt,
      updatedAt: timestamp
    };

    const items = this.getFallbackItems('leads');
    const idx = items.findIndex(l => l.id === savedLead.id);
    if (idx >= 0) items[idx] = savedLead;
    else items.unshift(savedLead);
    this.setFallbackItems('leads', items);
    return savedLead;
  }

  public async deleteLead(id: string): Promise<boolean> {
    this.assertDbConnected();
    await this.pool!.query('DELETE FROM `solar_leads` WHERE `id` = ?', [id]);
    const items = this.getFallbackItems('leads').filter(l => l.id !== id);
    this.setFallbackItems('leads', items);
    return true;
  }

  // ==========================================================
  // CRUD: PROJECTS & PROJECT STAGES
  // ==========================================================
  public async getProjects(): Promise<any[]> {
    if (!this.isConnected) return this.getFallbackItems('projects');
    this.assertDbConnected();
    const [rows]: any = await this.pool!.query('SELECT * FROM `solar_projects` ORDER BY `created_at` DESC');
    const [stagesRows]: any = await this.pool!.query('SELECT * FROM `solar_project_stages` ORDER BY `stage_order` ASC');

    const stagesByProject = new Map<string, any[]>();
    if (Array.isArray(stagesRows)) {
      for (const s of stagesRows) {
        if (!stagesByProject.has(s.project_id)) {
          stagesByProject.set(s.project_id, []);
        }
        let checklist = [];
        let photos = [];
        let documents = [];
        let gpsLocation = undefined;
        try { if (s.checklist_json) checklist = JSON.parse(s.checklist_json); } catch {}
        try { if (s.photos_json) photos = JSON.parse(s.photos_json); } catch {}
        try { if (s.documents_json) documents = JSON.parse(s.documents_json); } catch {}
        try { if (s.gps_location_json) gpsLocation = JSON.parse(s.gps_location_json); } catch {}

        stagesByProject.get(s.project_id)!.push({
          id: s.id,
          stageKey: s.stage_key,
          title: s.title,
          order: Number(s.stage_order) || 1,
          department: s.department,
          assignedRole: s.assigned_role,
          assignedEmployeeId: s.assigned_employee_id || '',
          assignedEmployeeName: s.assigned_employee_name || '',
          assignedToName: s.assigned_employee_name || '',
          status: s.status || 'NOT STARTED',
          priority: s.priority || 'MEDIUM',
          startDate: s.start_date,
          dueDate: s.due_date,
          completedDate: s.completed_date,
          checklist,
          photos,
          documents,
          gpsLocation,
          notes: s.notes || '',
          approvedBy: s.approved_by || '',
          approvedAt: s.approved_at,
          rejectionReason: s.rejection_reason || '',
          activities: []
        });
      }
    }

    const mapped = (rows as any[]).map(r => {
      let assignments = [];
      try {
        if (r.assignments_json) assignments = JSON.parse(r.assignments_json);
      } catch {}
      return {
        id: r.id,
        projectCode: r.project_code,
        customerId: r.customer_id,
        customerName: r.customer_name,
        title: r.title,
        capacityKw: Number(r.capacity_kw) || 0,
        totalValue: Number(r.total_value) || 0,
        receivedInflow: r.received_inflow !== null && r.received_inflow !== undefined ? Number(r.received_inflow) : null,
        status: r.status,
        currentStageKey: r.current_stage_key,
        completionPercentage: Number(r.completion_percentage) || 0,
        progressPercentage: Number(r.completion_percentage) || 0,
        projectManagerId: r.project_manager_id,
        projectManagerName: r.project_manager_name,
        siteAddress: r.site_address,
        city: r.city,
        location: r.city || r.site_address || '',
        inverterModel: r.inverter_model,
        panelModel: r.panel_model,
        structureType: r.structure_type,
        startDate: r.start_date,
        expectedCompletionDate: r.expected_completion_date,
        notes: r.notes,
        assignedUsers: assignments,
        stages: stagesByProject.get(r.id) || [],
        createdAt: r.created_at,
        updatedAt: r.updated_at
      };
    });
    this.setFallbackItems('projects', mapped);
    return mapped;
  }

  public async saveProject(proj: any): Promise<any> {
    this.assertDbConnected();
    const timestamp = new Date().toISOString();
    const item = { ...proj, updatedAt: timestamp };
    if (!item.createdAt) item.createdAt = timestamp;

    const existing = await this.getExistingRow('solar_projects', item.id);
    const projectCode = item.projectCode ?? item.project_code ?? existing?.project_code ?? item.id;
    const customerId = item.customerId ?? item.customer_id ?? existing?.customer_id ?? '';
    const customerName = item.customerName ?? item.customer_name ?? existing?.customer_name ?? '';
    const title = item.title ?? existing?.title ?? 'Solar EPC Project';
    const rawCap = item.capacityKw ?? item.capacity_kw;
    const capacityKw = rawCap !== undefined ? Number(rawCap) : (Number(existing?.capacity_kw) || 0);
    const rawVal = item.totalValue ?? item.total_value;
    const totalValue = rawVal !== undefined ? Number(rawVal) : (Number(existing?.total_value) || 0);
    const rawInflow = item.receivedInflow !== undefined ? item.receivedInflow : item.received_inflow;
    const receivedInflow =
      rawInflow !== undefined
        ? (rawInflow === null || rawInflow === '' ? null : Number(rawInflow))
        : (existing?.received_inflow !== null && existing?.received_inflow !== undefined
            ? Number(existing.received_inflow)
            : null);
    const status = item.status ?? existing?.status ?? 'PLANNING';
    const currentStageKey = item.currentStageKey ?? item.current_stage_key ?? existing?.current_stage_key ?? 'site_survey';
    const completionPercentage = Number(item.completionPercentage ?? item.completion_percentage ?? existing?.completion_percentage) || 0;
    const projectManagerId = item.projectManagerId ?? item.project_manager_id ?? existing?.project_manager_id ?? '';
    const projectManagerName = item.projectManagerName ?? item.project_manager_name ?? existing?.project_manager_name ?? '';
    const siteAddress = item.siteAddress ?? item.site_address ?? existing?.site_address ?? 'Not specified';
    const city = item.city ?? item.location ?? existing?.city ?? 'Not specified';
    const inverterModel = item.inverterModel ?? item.inverter_model ?? existing?.inverter_model ?? '';
    const panelModel = item.panelModel ?? item.panel_model ?? existing?.panel_model ?? '';
    const structureType = item.structureType ?? item.structure_type ?? existing?.structure_type ?? 'Elevated GI Structure';
    const rawStart = item.startDate ?? item.start_date ?? existing?.start_date;
    const startDate = rawStart ? String(rawStart).split('T')[0] : null;
    const rawExp = item.expectedCompletionDate ?? item.expected_completion_date ?? existing?.expected_completion_date;
    const expectedCompletionDate = rawExp ? String(rawExp).split('T')[0] : null;
    const notes = item.notes ?? existing?.notes ?? '';
    const assignmentsJson = JSON.stringify(item.assignedUsers ?? item.assignments ?? (existing?.assignments_json ? JSON.parse(existing.assignments_json) : []));

    const sql = `
      INSERT INTO \`solar_projects\` (
        \`id\`, \`project_code\`, \`customer_id\`, \`customer_name\`, \`title\`,
        \`capacity_kw\`, \`total_value\`, \`received_inflow\`, \`status\`, \`current_stage_key\`,
        \`completion_percentage\`, \`project_manager_id\`, \`project_manager_name\`,
        \`site_address\`, \`city\`, \`inverter_model\`, \`panel_model\`,
        \`structure_type\`, \`start_date\`, \`expected_completion_date\`,
        \`notes\`, \`assignments_json\`
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        \`customer_name\` = VALUES(\`customer_name\`),
        \`title\` = VALUES(\`title\`), \`capacity_kw\` = VALUES(\`capacity_kw\`),
        \`total_value\` = VALUES(\`total_value\`),
        \`received_inflow\` = VALUES(\`received_inflow\`),
        \`status\` = VALUES(\`status\`),
        \`current_stage_key\` = VALUES(\`current_stage_key\`),
        \`completion_percentage\` = VALUES(\`completion_percentage\`),
        \`project_manager_id\` = VALUES(\`project_manager_id\`),
        \`project_manager_name\` = VALUES(\`project_manager_name\`),
        \`site_address\` = VALUES(\`site_address\`),
        \`city\` = VALUES(\`city\`),
        \`inverter_model\` = VALUES(\`inverter_model\`),
        \`panel_model\` = VALUES(\`panel_model\`),
        \`structure_type\` = VALUES(\`structure_type\`),
        \`start_date\` = VALUES(\`start_date\`),
        \`expected_completion_date\` = VALUES(\`expected_completion_date\`),
        \`notes\` = VALUES(\`notes\`), \`assignments_json\` = VALUES(\`assignments_json\`)
    `;
    await this.pool!.query(sql, [
      item.id,
      projectCode,
      customerId,
      customerName,
      title,
      capacityKw,
      totalValue,
      receivedInflow,
      status,
      currentStageKey,
      completionPercentage,
      projectManagerId,
      projectManagerName,
      siteAddress,
      city,
      inverterModel,
      panelModel,
      structureType,
      startDate,
      expectedCompletionDate,
      notes,
      assignmentsJson
    ]);

    // Save or update stages in solar_project_stages
    if (Array.isArray(item.stages) && item.stages.length > 0) {
      for (const s of item.stages) {
        const stageSql = `
          INSERT INTO \`solar_project_stages\` (
            \`id\`, \`project_id\`, \`stage_key\`, \`title\`, \`stage_order\`,
            \`department\`, \`assigned_role\`, \`assigned_employee_id\`, \`assigned_employee_name\`,
            \`status\`, \`priority\`, \`start_date\`, \`due_date\`, \`completed_date\`,
            \`checklist_json\`, \`photos_json\`, \`documents_json\`, \`gps_location_json\`,
            \`notes\`, \`approved_by\`, \`rejection_reason\`
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            \`status\` = VALUES(\`status\`), \`priority\` = VALUES(\`priority\`),
            \`assigned_employee_id\` = VALUES(\`assigned_employee_id\`),
            \`assigned_employee_name\` = VALUES(\`assigned_employee_name\`),
            \`start_date\` = VALUES(\`start_date\`), \`due_date\` = VALUES(\`due_date\`),
            \`completed_date\` = VALUES(\`completed_date\`),
            \`checklist_json\` = VALUES(\`checklist_json\`),
            \`photos_json\` = VALUES(\`photos_json\`),
            \`documents_json\` = VALUES(\`documents_json\`),
            \`gps_location_json\` = VALUES(\`gps_location_json\`),
            \`notes\` = VALUES(\`notes\`), \`approved_by\` = VALUES(\`approved_by\`),
            \`rejection_reason\` = VALUES(\`rejection_reason\`)
        `;
        let resolvedStageId = s.id;
        const stageKeyVal = s.stageKey || s.key || 'stage';
        if (!resolvedStageId) {
          const [exStageRows]: any = await this.pool!.query(
            'SELECT `id` FROM `solar_project_stages` WHERE `project_id` = ? AND `stage_key` = ? LIMIT 1',
            [item.id, stageKeyVal]
          );
          resolvedStageId = exStageRows?.[0]?.id || `${item.id}-${stageKeyVal}`;
        }
        await this.pool!.query(stageSql, [
          resolvedStageId,
          item.id,
          stageKeyVal,
          s.title || s.name || 'Stage',
          Number(s.order ?? s.stageOrder) || 1,
          s.department || 'Operations',
          s.assignedRole || 'Technician',
          s.assignedEmployeeId || '',
          s.assignedEmployeeName || s.assignedToName || '',
          s.status || 'NOT STARTED',
          s.priority || 'MEDIUM',
          s.startDate ? String(s.startDate).split('T')[0] : null,
          s.dueDate ? String(s.dueDate).split('T')[0] : null,
          s.completedDate ? String(s.completedDate).split('T')[0] : null,
          JSON.stringify(s.checklist || []),
          JSON.stringify(s.photos || []),
          JSON.stringify(s.documents || []),
          s.gpsLocation ? JSON.stringify(s.gpsLocation) : null,
          s.notes || '',
          s.approvedBy || '',
          s.rejectionReason || ''
        ]);
      }
    }

    const normalizedSaved = {
      ...item,
      projectCode,
      customerId,
      customerName,
      title,
      capacityKw,
      totalValue,
      receivedInflow,
      status,
      currentStageKey,
      completionPercentage,
      progressPercentage: completionPercentage,
      projectManagerId,
      projectManagerName,
      siteAddress,
      city,
      location: city || siteAddress || '',
      inverterModel,
      panelModel,
      structureType,
      startDate: startDate || '',
      expectedCompletionDate: expectedCompletionDate || '',
      notes
    };

    const items = this.getFallbackItems('projects');
    const idx = items.findIndex(p => p.id === item.id);
    if (idx >= 0) items[idx] = { ...items[idx], ...normalizedSaved };
    else items.unshift(normalizedSaved);
    this.setFallbackItems('projects', items);
    return normalizedSaved;
  }

  public async deleteProject(id: string): Promise<boolean> {
    this.assertDbConnected();
    await this.pool!.query('DELETE FROM `solar_project_stages` WHERE `project_id` = ?', [id]);
    await this.pool!.query('DELETE FROM `solar_projects` WHERE `id` = ?', [id]);
    const items = this.getFallbackItems('projects').filter(p => p.id !== id);
    this.setFallbackItems('projects', items);
    return true;
  }

  public async updateStageInProject(
    projectId: string,
    stageKey: string,
    updates: any,
    actorName: string = 'Staff',
    actorRole: string = 'Employee'
  ): Promise<any> {
    if (!this.isConnected) return null;
    this.assertDbConnected();

    const projects = await this.getProjects();
    const project = projects.find(p => p.id === projectId);
    if (!project) return null;

    const stages: any[] = project.stages || [];
    const stageIndex = stages.findIndex(s => s.stageKey === stageKey || s.id === stageKey);
    if (stageIndex === -1) return null;

    const currentStage = stages[stageIndex];
    const updatedStage = { ...currentStage, ...updates };

    if (updates.status === 'COMPLETED' || updates.status === 'APPROVED') {
      const today = new Date().toISOString().slice(0, 10);
      updatedStage.completedDate = updatedStage.completedDate || today;
      updatedStage.actualEndDate = updatedStage.actualEndDate || today;
      if (updates.status === 'APPROVED') {
        updatedStage.approvedBy = actorName;
        updatedStage.approvedAt = today;
      }
      if (stageIndex + 1 < stages.length) {
        const nextStage = stages[stageIndex + 1];
        if (nextStage.status === 'NOT STARTED') {
          nextStage.status = 'IN PROGRESS';
          nextStage.startDate = today;
          project.currentStageKey = nextStage.stageKey;
        }
      }
    } else if (updates.status === 'IN PROGRESS') {
      project.currentStageKey = currentStage.stageKey;
      for (let j = stageIndex + 1; j < stages.length; j++) {
        if (stages[j].status === 'IN PROGRESS' || stages[j].status === 'COMPLETED' || stages[j].status === 'APPROVED') {
          stages[j].status = 'NOT STARTED';
          stages[j].actualEndDate = null;
          stages[j].completedDate = null;
          stages[j].approvedBy = null;
        }
      }
    }

    stages[stageIndex] = updatedStage;
    project.stages = stages;

    const totalStages = stages.length;
    const completedStages = stages.filter(s => s.status === 'COMPLETED' || s.status === 'APPROVED').length;
    project.completionPercentage = totalStages > 0 ? Math.round((completedStages / totalStages) * 100) : 0;
    project.progressPercentage = project.completionPercentage;

    if (completedStages === totalStages && totalStages > 0) {
      project.status = 'COMPLETED';
    } else if (completedStages === 0) {
      project.status = 'SURVEY';
    } else if (completedStages < 4) {
      project.status = 'DESIGN & APPROVALS';
    } else if (completedStages < 10) {
      project.status = 'CIVIL & STRUCTURE';
    } else {
      project.status = 'INSTALLATION';
    }

    const saved = await this.saveProject(project);
    return saved;
  }

  public async addStagePhotoToProject(
    projectId: string,
    stageKey: string,
    photo: any
  ): Promise<{ photo: any; photos: any[] } | null> {
    this.assertDbConnected();
    const conn = await this.pool!.getConnection();
    try {
      await conn.beginTransaction();
      const [projRows]: any = await conn.query('SELECT `id` FROM `solar_projects` WHERE `id` = ? LIMIT 1', [projectId]);
      if (!projRows || projRows.length === 0) {
        await conn.rollback();
        return null;
      }
      const [stageRows]: any = await conn.query(
        'SELECT `id`, `photos_json` FROM `solar_project_stages` WHERE `project_id` = ? AND (`stage_key` = ? OR `id` = ?) LIMIT 1 FOR UPDATE',
        [projectId, stageKey, stageKey]
      );
      let photos: any[] = [];
      if (!stageRows || stageRows.length === 0) {
        const sId = `${projectId}-${String(stageKey).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        photos = [photo];
        await conn.query(
          `INSERT INTO \`solar_project_stages\` (
            \`id\`, \`project_id\`, \`stage_key\`, \`title\`, \`stage_order\`,
            \`department\`, \`assigned_role\`, \`status\`, \`priority\`,
            \`checklist_json\`, \`photos_json\`, \`documents_json\`
          ) VALUES (?, ?, ?, ?, 1, 'Operations', 'Technician', 'IN PROGRESS', 'MEDIUM', '[]', ?, '[]')`,
          [sId, projectId, stageKey, stageKey.replace(/_/g, ' '), JSON.stringify(photos)]
        );
      } else {
        let existing: any[] = [];
        try {
          existing = stageRows[0].photos_json ? JSON.parse(stageRows[0].photos_json) : [];
        } catch {
          existing = [];
        }
        if (!Array.isArray(existing)) existing = [];
        photos = [...existing, photo];
        await conn.query('UPDATE `solar_project_stages` SET `photos_json` = ? WHERE `id` = ?', [
          JSON.stringify(photos),
          stageRows[0].id
        ]);
      }
      await conn.commit();
      return { photo, photos };
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }

  public async removeStagePhotoFromProject(
    projectId: string,
    stageKey: string,
    photoId: string
  ): Promise<{ removedPhoto: any | null; photos: any[] } | null> {
    this.assertDbConnected();
    const conn = await this.pool!.getConnection();
    try {
      await conn.beginTransaction();
      const [stageRows]: any = await conn.query(
        'SELECT `id`, `photos_json` FROM `solar_project_stages` WHERE `project_id` = ? AND (`stage_key` = ? OR `id` = ?) LIMIT 1 FOR UPDATE',
        [projectId, stageKey, stageKey]
      );
      if (!stageRows || stageRows.length === 0) {
        await conn.rollback();
        return null;
      }
      let existing: any[] = [];
      try {
        existing = stageRows[0].photos_json ? JSON.parse(stageRows[0].photos_json) : [];
      } catch {
        existing = [];
      }
      if (!Array.isArray(existing)) existing = [];
      let removedPhoto: any = null;
      const nextPhotos = existing.filter(p => {
        if (p && p.id === photoId) {
          removedPhoto = p;
          return false;
        }
        return true;
      });
      await conn.query('UPDATE `solar_project_stages` SET `photos_json` = ? WHERE `id` = ?', [
        JSON.stringify(nextPhotos),
        stageRows[0].id
      ]);
      await conn.commit();
      return { removedPhoto, photos: nextPhotos };
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }

  public async updateProjectProgress(
    projectId: string,
    progressPercentage: number,
    status?: string
  ): Promise<any> {
    if (!this.isConnected) return null;
    this.assertDbConnected();

    const projects = await this.getProjects();
    const project = projects.find(p => p.id === projectId);
    if (!project) return null;

    project.completionPercentage = Math.max(0, Math.min(100, Number(progressPercentage) || 0));
    project.progressPercentage = project.completionPercentage;
    if (status) {
      project.status = status;
    }

    const saved = await this.saveProject(project);
    return saved;
  }

  public async updateProjectControlCenter(
    projectId: string,
    payload: {
      capacityKw?: number;
      totalValue?: number;
      receivedInflow?: number;
      city?: string;
      siteAddress?: string;
      location?: string;
    },
    actor?: any
  ): Promise<{ project: any; customer: any | null; payments: any[] }> {
    this.assertDbConnected();
    const existing = await this.getExistingRow('solar_projects', projectId);
    if (!existing) {
      throw Object.assign(new Error(`Project "${projectId}" not found.`), { statusCode: 404 });
    }

    const parseCleanNumber = (val: any): number => {
      if (typeof val === 'number') return val;
      if (typeof val === 'string') {
        const cleaned = val.replace(/,/g, '').trim();
        if (!cleaned) return Number.NaN;
        return Number(cleaned);
      }
      return Number(val);
    };

    const nextCapacity =
      payload.capacityKw !== undefined ? parseCleanNumber(payload.capacityKw) : Number(existing.capacity_kw || 0);
    if (!Number.isFinite(nextCapacity) || nextCapacity <= 0) {
      throw Object.assign(new Error('Project capacity must be greater than 0 kW.'), { statusCode: 400 });
    }

    const nextTotalValue =
      payload.totalValue !== undefined
        ? Math.round(parseCleanNumber(payload.totalValue) * 100) / 100
        : Number(existing.total_value || 0);
    if (!Number.isFinite(nextTotalValue) || nextTotalValue < 0) {
      throw Object.assign(new Error('Total project/contract value cannot be negative.'), { statusCode: 400 });
    }

    const nextCityRaw =
      payload.city !== undefined
        ? String(payload.city).trim()
        : payload.location !== undefined
        ? String(payload.location).trim()
        : String(existing.city || '');
    if (payload.city !== undefined && !nextCityRaw) {
      throw Object.assign(new Error('Site location cannot be empty.'), { statusCode: 400 });
    }
    const nextCity = nextCityRaw || String(existing.city || 'Not specified');

    const nextSiteAddress =
      payload.siteAddress !== undefined ? String(payload.siteAddress).trim() : String(existing.site_address || '');

    let nextReceivedInflowCol: number | null =
      existing.received_inflow !== null && existing.received_inflow !== undefined
        ? Number(existing.received_inflow)
        : null;

    if (payload.receivedInflow !== undefined && payload.receivedInflow !== null && String(payload.receivedInflow).trim() !== '') {
      const targetInflow = Math.round(parseCleanNumber(payload.receivedInflow) * 100) / 100;
      if (!Number.isFinite(targetInflow) || targetInflow < 0) {
        throw Object.assign(new Error('Received inflow must be a valid amount (0 or greater).'), { statusCode: 400 });
      }

      const adjId = 'pay-cc-' + String(projectId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 56);
      const [otherPaidRows]: any = await this.pool!.query(
        "SELECT COALESCE(SUM(`amount`), 0) AS total_paid FROM `solar_payments` WHERE `project_id` = ? AND `status` = 'PAID' AND `id` <> ?",
        [projectId, adjId]
      );
      const otherPaidSum = Math.round(Number(otherPaidRows?.[0]?.total_paid || 0) * 100) / 100;

      if (targetInflow >= otherPaidSum - 0.009) {
        const delta = Math.round(Math.max(0, targetInflow - otherPaidSum) * 100) / 100;
        if (delta > 0.009) {
          const today = new Date().toISOString().slice(0, 10);
          const safeRecNo = 'CC-INF-' + String(projectId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 54);
          await this.savePayment({
            id: adjId,
            receiptNumber: safeRecNo,
            projectId,
            customerId: existing.customer_id || '',
            customerName: existing.customer_name || 'Customer',
            milestone: 'Direct Inflow (Control Center)',
            amount: delta,
            status: 'PAID',
            dueDate: today,
            paidDate: today,
            paymentMode: 'Bank NEFT/RTGS',
            notes: `Updated by ${actor?.name || 'Admin'} in Control Center`
          });
        } else {
          await this.pool!.query('DELETE FROM `solar_payments` WHERE `id` = ?', [adjId]);
        }
        nextReceivedInflowCol = null;
      } else {
        await this.pool!.query('DELETE FROM `solar_payments` WHERE `id` = ?', [adjId]);
        nextReceivedInflowCol = targetInflow;
      }
    }

    await this.pool!.query(
      'UPDATE `solar_projects` SET `capacity_kw` = ?, `total_value` = ?, `received_inflow` = ?, `city` = ?, `site_address` = ? WHERE `id` = ?',
      [nextCapacity, nextTotalValue, nextReceivedInflowCol, nextCity, nextSiteAddress, projectId]
    );

    if (existing.customer_id && (payload.city !== undefined || payload.siteAddress !== undefined || payload.location !== undefined)) {
      const custExisting = await this.getExistingRow('solar_customers', existing.customer_id);
      if (custExisting) {
        const custCity = nextCity || custExisting.city;
        const custAddr = payload.siteAddress !== undefined ? nextSiteAddress : custExisting.site_address;
        await this.pool!.query(
          'UPDATE `solar_customers` SET `city` = ?, `site_address` = ? WHERE `id` = ?',
          [custCity, custAddr, existing.customer_id]
        );
      }
    }

    const projects = await this.getProjects();
    const updatedProject = projects.find(p => p.id === projectId) || null;
    let updatedCustomer: any | null = null;
    if (existing.customer_id) {
      const customers = await this.getCustomers();
      updatedCustomer = customers.find(c => c.id === existing.customer_id) || null;
    }
    const payments = await this.getPayments();
    return {
      project: updatedProject,
      customer: updatedCustomer,
      payments
    };
  }

  private generateDefaultProjectStages(projId: string, status: string): any[] {
      const stageDefs = [
      { key: 'site_survey', title: 'Site Survey', order: 1, dept: 'Engineering', role: 'Site Survey Engineer' },
      { key: 'cad_design', title: 'CAD & 3D Engineering Design', order: 2, dept: 'Engineering', role: 'Design Engineer' },
      { key: 'statutory_approvals', title: 'Statutory Approvals & CEIG', order: 3, dept: 'Liaisoning', role: 'Liaisoning Officer' },
      { key: 'procurement', title: 'BOM Procurement & Dispatch', order: 4, dept: 'Procurement', role: 'Procurement Manager' },
      { key: 'civil_foundations', title: 'Civil Foundations & Pier Casting', order: 5, dept: 'Civil', role: 'Civil Supervisor' },
      { key: 'structure_assembly', title: 'Module Mounting Structure (MMS)', order: 6, dept: 'Mechanical', role: 'Mechanical Team' },
      { key: 'earthing_pits', title: 'Chemical Earthing Pits', order: 7, dept: 'Electrical', role: 'Electrical Team' },
      { key: 'solar_installation', title: 'Solar Module Installation', order: 8, dept: 'Installation', role: 'Installation Team' },
      { key: 'dc_cabling', title: 'DC Cabling & Array Combiner Box', order: 9, dept: 'Electrical', role: 'Electrical Team' },
      { key: 'inverter_installation', title: 'Grid-Tie Inverter & PCU Mounting', order: 10, dept: 'Electrical', role: 'Electrical Team' },
      { key: 'ac_distribution', title: 'AC Distribution Board (ACDB) & LT Panel', order: 11, dept: 'Electrical', role: 'Electrical Team' },
      { key: 'testing_commissioning', title: 'Pre-Commissioning Testing & Insulation Resistance', order: 12, dept: 'Quality & Testing', role: 'Quality Inspector' },
      { key: 'discom_inspection', title: 'DISCOM Joint Inspection & Net Metering', order: 13, dept: 'Liaisoning', role: 'Liaisoning Officer' },
      { key: 'grid_synchronization', title: 'Grid Synchronization & Power Flow Test', order: 14, dept: 'Electrical', role: 'Commissioning Lead' },
      { key: 'scada_rms', title: 'SCADA & IoT Remote Monitoring Setup', order: 15, dept: 'Instrumentation', role: 'IoT Specialist' },
      { key: 'handover_documentation', title: 'Client Handover, Warranty & O&M Manuals', order: 16, dept: 'Project Management', role: 'Project Manager' }
    ];

    const isCompleted = status === 'COMPLETED';
    const isInstallation = status === 'INSTALLATION';

    return stageDefs.map(def => {
      let stStatus = 'NOT STARTED';
      if (isCompleted) {
        stStatus = 'COMPLETED';
      } else if (isInstallation) {
        if (def.order < 8) stStatus = 'COMPLETED';
        else if (def.order === 8) stStatus = 'IN PROGRESS';
        else stStatus = 'NOT STARTED';
      } else if (def.order === 1) {
        stStatus = 'IN PROGRESS';
      }

      return {
        id: `${projId}-stage-${def.order}`,
        stageKey: def.key,
        title: def.title,
        order: def.order,
        department: def.dept,
        assignedRole: def.role,
        assignedEmployeeId: null,
        assignedEmployeeName: 'Unassigned',
        assignedToName: 'Unassigned',
        status: stStatus,
        priority: 'MEDIUM',
        startDate: stStatus !== 'NOT STARTED' ? new Date().toISOString().split('T')[0] : null,
        dueDate: new Date(Date.now() + def.order * 3 * 86400000).toISOString().split('T')[0],
        completedDate: stStatus === 'COMPLETED' ? new Date().toISOString().split('T')[0] : null,
        approvedBy: null,
        checklist: [
          { title: `${def.title} engineering verification completed`, completed: stStatus === 'COMPLETED' },
          { title: `${def.title} quality checklist signed off`, completed: stStatus === 'COMPLETED' }
        ],
        photos: [],
        documents: [],
        activities: []
      };
    });
  }

  public async importProjects(projectList: any[]): Promise<{
    success: boolean;
    total: number;
    imported: number;
    skipped: number;
    failed: number;
    importedRecords: any[];
    skippedRecords: { row: number; name: string; reason: string }[];
    failedRecords: { row: number; reason: string }[];
    errors: string[];
  }> {
    if (!Array.isArray(projectList) || projectList.length === 0) {
      return {
        success: false,
        total: 0,
        imported: 0,
        skipped: 0,
        failed: 0,
        importedRecords: [],
        skippedRecords: [],
        failedRecords: [],
        errors: ['No project rows provided for import.']
      };
    }

    // Helper normalizers
    const normText = (s: any) => String(s || '').trim().toLowerCase();
    const normCode = (s: any) => String(s || '').trim().toUpperCase();

    // 1. Gather existing projects and customers for duplicate checking and customer linking
    let existingProjects: any[] = [];
    let existingCustomers: any[] = [];

    if (this.isConnected && this.pool) {
      try {
        const [projRows]: any = await this.pool.query('SELECT `id`, `project_code`, `customer_id`, `customer_name`, `title`, `capacity_kw`, `site_address` FROM `solar_projects`');
        if (Array.isArray(projRows)) existingProjects = projRows;
      } catch (err: any) {
        console.warn('Could not read existing projects from MySQL:', err.message);
      }

      try {
        const [custRows]: any = await this.pool.query('SELECT `id`, `customer_code`, `name`, `company_name`, `phone`, `email`, `site_address`, `city` FROM `solar_customers`');
        if (Array.isArray(custRows)) existingCustomers = custRows;
      } catch (err: any) {
        console.warn('Could not read existing customers from MySQL:', err.message);
      }
    }

    if (existingProjects.length === 0) {
      existingProjects = this.getFallbackItems('projects');
    }
    if (existingCustomers.length === 0) {
      existingCustomers = this.getFallbackItems('customers');
    }

    // Duplicate tracking maps
    const projectCodeMap = new Map<string, string>(); // code -> title
    const custTitleMap = new Map<string, string>(); // cust:::title -> code
    const custCapAddrMap = new Map<string, string>(); // cust:::cap:::addr -> code

    for (const p of existingProjects) {
      const code = normCode(p.project_code || p.projectCode);
      const cust = normText(p.customer_name || p.customerName);
      const title = normText(p.title);
      const cap = Number(p.capacity_kw || p.capacityKw) || 0;
      const addr = normText(p.site_address || p.siteAddress);

      if (code) projectCodeMap.set(code, p.title || p.project_code || 'Project');
      if (cust && title) custTitleMap.set(`${cust}:::${title}`, code || p.id);
      if (cust && cap > 0 && addr) custCapAddrMap.set(`${cust}:::${cap}:::${addr}`, code || p.id);
    }

    // Customer lookup map: normName -> customer object
    const customerMap = new Map<string, any>();
    for (const c of existingCustomers) {
      const name = normText(c.name);
      const company = normText(c.company_name || c.companyName);
      if (name) customerMap.set(name, c);
      if (company) customerMap.set(company, c);
    }

    const importedRecords: any[] = [];
    const skippedRecords: { row: number; name: string; reason: string }[] = [];
    const failedRecords: { row: number; reason: string }[] = [];
    const errors: string[] = [];

    let codeSeq = Date.now() % 10000;

    for (let i = 0; i < projectList.length; i++) {
      const rowNum = i + 1;
      const raw = projectList[i];
      if (!raw || typeof raw !== 'object') {
        failedRecords.push({ row: rowNum, reason: 'Empty or malformed record.' });
        errors.push(`Row ${rowNum}: Empty or malformed record.`);
        continue;
      }

      const rawCode = String(raw.projectCode || raw.project_code || '').trim();
      const customerName = String(raw.customerName || raw.customer_name || raw.client || raw.name || '').trim();
      const rawTitle = String(raw.title || '').trim();
      const rawCap = String(raw.capacityKw || raw.capacity_kw || raw.capacity || '').replace(/[^0-9.]/g, '');
      const capacityKw = parseFloat(rawCap);
      const rawVal = String(raw.totalValue || raw.total_value || '').replace(/[^0-9.]/g, '');
      let totalValue = parseFloat(rawVal);
      const rawStatus = String(raw.status || 'SURVEY').trim().toUpperCase();
      const rawCity = String(raw.city || 'Ahmedabad').trim();
      const rawAddress = String(raw.siteAddress || raw.site_address || '').trim();
      const siteAddress = rawAddress || `${rawCity}, Gujarat`;
      const city = rawCity || 'Ahmedabad';

      if (!customerName && !rawTitle) {
        failedRecords.push({ row: rowNum, reason: 'Customer name or project title is mandatory.' });
        errors.push(`Row ${rowNum}: Customer name or project title is mandatory.`);
        continue;
      }

      const effectiveCustomerName = customerName || rawTitle;

      if (isNaN(capacityKw) || capacityKw <= 0) {
        failedRecords.push({ row: rowNum, reason: `Valid solar capacity in kW (> 0) is required (got "${rawCap || 'empty'}").` });
        errors.push(`Row ${rowNum}: Valid solar capacity in kW (> 0) is required (got "${rawCap || 'empty'}").`);
        continue;
      }

      if (isNaN(totalValue) || totalValue <= 0) {
        totalValue = Math.round(capacityKw * 48000);
      }

      const title = rawTitle || `${capacityKw} kW Rooftop Solar - ${effectiveCustomerName}`;
      const projectCode = rawCode || `SOL-${new Date().getFullYear()}-${codeSeq++}`;

      // Duplicate Check
      const normC = normCode(projectCode);
      const normCust = normText(effectiveCustomerName);
      const normT = normText(title);
      const normAddr = normText(siteAddress);

      if (rawCode && projectCodeMap.has(normC)) {
        const existingName = projectCodeMap.get(normC);
        skippedRecords.push({
          row: rowNum,
          name: `${projectCode} (${effectiveCustomerName})`,
          reason: `Project code "${projectCode}" already exists (${existingName}).`
        });
        errors.push(`Row ${rowNum} Skipped (Duplicate): Project code "${projectCode}" already exists.`);
        continue;
      }

      const custTitleKey = `${normCust}:::${normT}`;
      if (custTitleMap.has(custTitleKey)) {
        const exCode = custTitleMap.get(custTitleKey);
        skippedRecords.push({
          row: rowNum,
          name: `${projectCode} (${effectiveCustomerName})`,
          reason: `Project "${title}" for customer "${effectiveCustomerName}" already exists (Code: ${exCode}).`
        });
        errors.push(`Row ${rowNum} Skipped (Duplicate): Project "${title}" for "${effectiveCustomerName}" already exists.`);
        continue;
      }

      const custCapAddrKey = `${normCust}:::${capacityKw}:::${normAddr}`;
      if (normAddr && custCapAddrMap.has(custCapAddrKey)) {
        const exCode = custCapAddrMap.get(custCapAddrKey);
        skippedRecords.push({
          row: rowNum,
          name: `${projectCode} (${effectiveCustomerName})`,
          reason: `A ${capacityKw} kW project for "${effectiveCustomerName}" at "${siteAddress}" already exists (Code: ${exCode}).`
        });
        errors.push(`Row ${rowNum} Skipped (Duplicate): Duplicate project at site address.`);
        continue;
      }

      // Customer Linking / Auto-creation
      let customerId = '';
      const matchedCust = customerMap.get(normCust);
      if (matchedCust) {
        customerId = matchedCust.id;
      } else {
        // Auto-create customer in solar_customers
        customerId = `cust-imp-${Date.now()}-${rowNum}`;
        const newCustCode = `CUST-${new Date().getFullYear()}-${codeSeq + 500}`;
        const newCustomerObj = {
          id: customerId,
          customerCode: newCustCode,
          name: effectiveCustomerName,
          companyName: effectiveCustomerName,
          customerType: 'Commercial',
          phone: raw.phone || '+91 98000 00000',
          email: raw.email || `${normCust.replace(/[^a-z0-9]/g, '') || 'client'}@example.com`,
          password: '$2y$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi',
          siteAddress,
          city,
          state: 'Gujarat',
          pincode: '380001',
          gstNumber: raw.gstNumber || raw.gst_number || '',
          sanctionedLoadKw: capacityKw,
          status: 'ACTIVE'
        };

        if (this.isConnected && this.pool) {
          try {
            await this.pool.query(
              `INSERT INTO \`solar_customers\` (
                \`id\`, \`customer_code\`, \`name\`, \`company_name\`, \`customer_type\`,
                \`phone\`, \`email\`, \`password\`, \`site_address\`, \`city\`, \`state\`,
                \`pincode\`, \`gst_number\`, \`sanctioned_load_kw\`, \`status\`
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON DUPLICATE KEY UPDATE \`name\` = VALUES(\`name\`)`,
              [
                newCustomerObj.id, newCustomerObj.customerCode, newCustomerObj.name,
                newCustomerObj.companyName, newCustomerObj.customerType, newCustomerObj.phone,
                newCustomerObj.email, newCustomerObj.password, newCustomerObj.siteAddress,
                newCustomerObj.city, newCustomerObj.state, newCustomerObj.pincode,
                newCustomerObj.gstNumber, newCustomerObj.sanctionedLoadKw, newCustomerObj.status
              ]
            );
          } catch (cErr: any) {
            console.warn('Notice auto-linking customer during project import:', cErr.message);
          }
        }
        this.upsertFallback('customers', newCustomerObj);
        customerMap.set(normCust, newCustomerObj);
      }

      // Generate Project ID and Stages
      const projId = raw.id || `proj-imp-${Date.now()}-${rowNum}`;
      const validStatuses = [
        'PLANNING', 'SURVEY', 'DESIGN', 'APPROVALS', 'PROCUREMENT',
        'CIVIL_WORK', 'INSTALLATION', 'TESTING', 'COMMISSIONING',
        'HANDOVER', 'COMPLETED', 'ON_HOLD', 'CANCELLED'
      ];
      const status = validStatuses.includes(rawStatus) ? rawStatus : 'SURVEY';
      const startDate = raw.startDate ? String(raw.startDate).split('T')[0] : new Date().toISOString().split('T')[0];
      const expectedCompletionDate = raw.expectedCompletionDate
        ? String(raw.expectedCompletionDate).split('T')[0]
        : new Date(Date.now() + 45 * 86400000).toISOString().split('T')[0];

      // Standard stages definition
      const stagesList = Array.isArray(raw.stages) && raw.stages.length > 0 ? raw.stages : this.generateDefaultProjectStages(projId, status);

      const projectRecord: any = {
        id: projId,
        projectCode,
        customerId,
        customerName: effectiveCustomerName,
        title,
        capacityKw,
        totalValue,
        status,
        currentStageKey: status === 'COMPLETED' ? 'handover_documentation' : 'site_survey',
        completionPercentage: status === 'COMPLETED' ? 100 : (status === 'INSTALLATION' ? 68 : 0),
        progressPercentage: status === 'COMPLETED' ? 100 : (status === 'INSTALLATION' ? 68 : 0),
        projectManagerId: raw.projectManagerId || '',
        projectManagerName: raw.projectManagerName || '',
        siteAddress,
        city,
        inverterModel: raw.inverterModel || '',
        panelModel: raw.panelModel || '',
        structureType: raw.structureType || 'Elevated GI Structure',
        startDate,
        expectedCompletionDate,
        notes: raw.notes || 'Imported via CSV Hub',
        assignedUsers: Array.isArray(raw.assignedUsers) ? raw.assignedUsers : [],
        stages: stagesList,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      // Persistence to MySQL
      if (this.isConnected && this.pool) {
        try {
          const sql = `
            INSERT INTO \`solar_projects\` (
              \`id\`, \`project_code\`, \`customer_id\`, \`customer_name\`, \`title\`,
              \`capacity_kw\`, \`total_value\`, \`status\`, \`current_stage_key\`,
              \`completion_percentage\`, \`project_manager_id\`, \`project_manager_name\`,
              \`site_address\`, \`city\`, \`inverter_model\`, \`panel_model\`,
              \`structure_type\`, \`start_date\`, \`expected_completion_date\`,
              \`notes\`, \`assignments_json\`
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
              \`title\` = VALUES(\`title\`), \`capacity_kw\` = VALUES(\`capacity_kw\`),
              \`total_value\` = VALUES(\`total_value\`), \`status\` = VALUES(\`status\`),
              \`current_stage_key\` = VALUES(\`current_stage_key\`),
              \`completion_percentage\` = VALUES(\`completion_percentage\`),
              \`notes\` = VALUES(\`notes\`)
          `;
          await this.pool.query(sql, [
            projectRecord.id,
            projectRecord.projectCode,
            projectRecord.customerId,
            projectRecord.customerName,
            projectRecord.title,
            projectRecord.capacityKw,
            projectRecord.totalValue,
            projectRecord.status,
            projectRecord.currentStageKey,
            projectRecord.completionPercentage,
            projectRecord.projectManagerId,
            projectRecord.projectManagerName,
            projectRecord.siteAddress,
            projectRecord.city,
            projectRecord.inverterModel,
            projectRecord.panelModel,
            projectRecord.structureType,
            projectRecord.startDate,
            projectRecord.expectedCompletionDate,
            projectRecord.notes,
            JSON.stringify(projectRecord.assignedUsers)
          ]);

          // Insert stages into solar_project_stages
          for (const s of stagesList) {
            const stageSql = `
              INSERT INTO \`solar_project_stages\` (
                \`id\`, \`project_id\`, \`stage_key\`, \`title\`, \`stage_order\`,
                \`department\`, \`assigned_role\`, \`assigned_employee_id\`, \`assigned_employee_name\`,
                \`status\`, \`priority\`, \`start_date\`, \`due_date\`, \`completed_date\`,
                \`checklist_json\`, \`photos_json\`, \`documents_json\`, \`gps_location_json\`,
                \`notes\`, \`approved_by\`, \`rejection_reason\`
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON DUPLICATE KEY UPDATE
                \`status\` = VALUES(\`status\`), \`priority\` = VALUES(\`priority\`),
                \`start_date\` = VALUES(\`start_date\`), \`due_date\` = VALUES(\`due_date\`),
                \`completed_date\` = VALUES(\`completed_date\`)
            `;
            await this.pool.query(stageSql, [
              s.id || `${projId}-${s.stageKey || 'stage'}`,
              projId,
              s.stageKey || 'stage',
              s.title || 'Stage',
              Number(s.order ?? s.stageOrder) || 1,
              s.department || 'Operations',
              s.assignedRole || 'Technician',
              s.assignedEmployeeId || '',
              s.assignedEmployeeName || s.assignedToName || '',
              s.status || 'NOT STARTED',
              s.priority || 'MEDIUM',
              s.startDate ? String(s.startDate).split('T')[0] : null,
              s.dueDate ? String(s.dueDate).split('T')[0] : null,
              s.completedDate ? String(s.completedDate).split('T')[0] : null,
              JSON.stringify(s.checklist || []),
              JSON.stringify(s.photos || []),
              JSON.stringify(s.documents || []),
              s.gpsLocation ? JSON.stringify(s.gpsLocation) : null,
              s.notes || '',
              s.approvedBy || '',
              s.rejectionReason || ''
            ]);
          }
        } catch (dbErr: any) {
          failedRecords.push({ row: rowNum, reason: `MySQL write error: ${dbErr.message}` });
          errors.push(`Row ${rowNum}: MySQL write error: ${dbErr.message}`);
          continue;
        }
      }

      // In-memory fallback persistence
      this.upsertFallback('projects', projectRecord);

      // Register into duplicate maps
      projectCodeMap.set(normC, title);
      custTitleMap.set(custTitleKey, projectCode);
      if (normAddr) custCapAddrMap.set(custCapAddrKey, projectCode);

      importedRecords.push(projectRecord);
    }

    this.saveDiskSnapshot();

    return {
      success: true,
      total: projectList.length,
      imported: importedRecords.length,
      skipped: skippedRecords.length,
      failed: failedRecords.length,
      importedRecords,
      skippedRecords,
      failedRecords,
      errors
    };
  }

  // ==========================================================
  // BATCH IMPORT: LEADS
  // ==========================================================
  public async importLeads(leadList: any[]): Promise<{
    success: boolean;
    total: number;
    imported: number;
    skipped: number;
    failed: number;
    importedRecords: any[];
    skippedRecords: { row: number; name: string; reason: string }[];
    failedRecords: { row: number; reason: string }[];
    errors: string[];
  }> {
    if (!Array.isArray(leadList) || leadList.length === 0) {
      return { success: false, total: 0, imported: 0, skipped: 0, failed: 0, importedRecords: [], skippedRecords: [], failedRecords: [], errors: ['No lead rows provided for import.'] };
    }

    const normText = (s: any) => String(s || '').trim().toLowerCase();
    const normDigits = (s: any) => String(s || '').replace(/\D/g, '');

    let existingLeads: any[] = [];
    if (this.isConnected && this.pool) {
      try {
        const [rows]: any = await this.pool.query('SELECT `id`, `customer_name`, `company_name`, `phone`, `email` FROM `solar_leads`');
        if (Array.isArray(rows)) existingLeads = rows;
      } catch (err: any) {
        console.warn('Notice reading existing leads:', err.message);
      }
    }
    if (existingLeads.length === 0) existingLeads = this.getFallbackItems('leads');

    const phoneMap = new Map<string, string>();
    const emailMap = new Map<string, string>();
    const nameCompMap = new Map<string, string>();

    for (const l of existingLeads) {
      const p = normDigits(l.phone);
      const em = normText(l.email);
      const name = normText(l.customer_name || l.customerName);
      const comp = normText(l.company_name || l.companyName);
      if (p.length >= 7) phoneMap.set(p, l.customer_name || l.customerName || 'Lead');
      if (em) emailMap.set(em, l.customer_name || l.customerName || 'Lead');
      if (name && comp) nameCompMap.set(`${name}:::${comp}`, l.customer_name || 'Lead');
    }

    const importedRecords: any[] = [];
    const skippedRecords: { row: number; name: string; reason: string }[] = [];
    const failedRecords: { row: number; reason: string }[] = [];
    const errors: string[] = [];

    for (let i = 0; i < leadList.length; i++) {
      const rowNum = i + 1;
      const raw = leadList[i];
      if (!raw || typeof raw !== 'object') {
        failedRecords.push({ row: rowNum, reason: 'Empty or malformed record.' });
        errors.push(`Row ${rowNum}: Empty or malformed record.`);
        continue;
      }

      const customerName = String(raw.customerName || raw.customer_name || raw.name || '').trim();
      const companyName = String(raw.companyName || raw.company_name || '').trim();
      const phone = String(raw.phone || raw.mobile || '').trim();
      const email = String(raw.email || '').trim().toLowerCase();
      const address = String(raw.address || raw.siteAddress || '').trim();
      const city = String(raw.city || 'Ahmedabad').trim();
      const rawCap = String(raw.solarCapacityKw ?? raw.solar_capacity_kw ?? raw.capacity ?? '').replace(/[^0-9.]/g, '');
      const solarCapacityKw = parseFloat(rawCap) || 10;
      const rawVal = String(raw.estimatedValue ?? raw.estimated_value ?? '').replace(/[^0-9.]/g, '');
      const estimatedValue = parseFloat(rawVal) || Math.round(solarCapacityKw * 48000);
      const source = String(raw.source || 'Website').trim();
      const status = String(raw.status || 'NEW').trim().toUpperCase();
      const notes = String(raw.notes || 'Imported via CSV Hub').trim();

      if (!customerName) {
        failedRecords.push({ row: rowNum, reason: 'Customer name is mandatory.' });
        errors.push(`Row ${rowNum}: Customer name is mandatory.`);
        continue;
      }

      const pDigits = normDigits(phone);
      if (pDigits.length < 7) {
        failedRecords.push({ row: rowNum, reason: `Valid phone number is required (got "${phone || 'empty'}").` });
        errors.push(`Row ${rowNum}: Valid phone number is required (got "${phone || 'empty'}").`);
        continue;
      }

      // Duplicates
      let isDup = false;
      let dupReason = '';
      for (const [exP, exName] of phoneMap.entries()) {
        if (exP === pDigits || (pDigits.length >= 10 && exP.endsWith(pDigits.slice(-10))) || (exP.length >= 10 && pDigits.endsWith(exP.slice(-10)))) {
          isDup = true;
          dupReason = `Phone number "${phone}" is already registered to lead "${exName}".`;
          break;
        }
      }

      if (!isDup && email && emailMap.has(email)) {
        isDup = true;
        dupReason = `Email address "${email}" is already registered to lead "${emailMap.get(email)}".`;
      }

      const nameCompKey = `${normText(customerName)}:::${normText(companyName)}`;
      if (!isDup && companyName && nameCompMap.has(nameCompKey)) {
        isDup = true;
        dupReason = `Lead for "${customerName}" at "${companyName}" already exists.`;
      }

      if (isDup) {
        skippedRecords.push({ row: rowNum, name: customerName, reason: dupReason });
        errors.push(`Row ${rowNum} Skipped (Duplicate): ${dupReason}`);
        continue;
      }

      const leadId = raw.id || `lead-imp-${Date.now()}-${rowNum}`;
      const record: any = {
        id: leadId,
        customerName,
        companyName,
        phone,
        email,
        address,
        city,
        solarCapacityKw,
        estimatedValue,
        source,
        assignedSalespersonId: raw.assignedSalespersonId || '',
        assignedSalespersonName: raw.assignedSalespersonName || '',
        status,
        notes,
        nextFollowUpDate: raw.nextFollowUpDate ? String(raw.nextFollowUpDate).split('T')[0] : null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      if (this.isConnected && this.pool) {
        try {
          const sql = `
            INSERT INTO \`solar_leads\` (
              \`id\`, \`customer_name\`, \`company_name\`, \`phone\`, \`email\`,
              \`address\`, \`city\`, \`solar_capacity_kw\`, \`estimated_value\`,
              \`source\`, \`assigned_salesperson_id\`, \`assigned_salesperson_name\`,
              \`status\`, \`notes\`, \`next_follow_up_date\`
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
              \`customer_name\` = VALUES(\`customer_name\`), \`company_name\` = VALUES(\`company_name\`),
              \`phone\` = VALUES(\`phone\`), \`email\` = VALUES(\`email\`),
              \`solar_capacity_kw\` = VALUES(\`solar_capacity_kw\`), \`estimated_value\` = VALUES(\`estimated_value\`),
              \`status\` = VALUES(\`status\`), \`notes\` = VALUES(\`notes\`)
          `;
          await this.pool.query(sql, [
            record.id, record.customerName, record.companyName, record.phone, record.email,
            record.address, record.city, record.solarCapacityKw, record.estimatedValue,
            record.source, record.assignedSalespersonId, record.assignedSalespersonName,
            record.status, record.notes, record.nextFollowUpDate
          ]);
        } catch (dbErr: any) {
          failedRecords.push({ row: rowNum, reason: `MySQL write error: ${dbErr.message}` });
          errors.push(`Row ${rowNum}: MySQL write error: ${dbErr.message}`);
          continue;
        }
      }

      this.upsertFallback('leads', record);
      phoneMap.set(pDigits, customerName);
      if (email) emailMap.set(email, customerName);
      if (companyName) nameCompMap.set(nameCompKey, customerName);
      importedRecords.push(record);
    }

    this.saveDiskSnapshot();
    return {
      success: true,
      total: leadList.length,
      imported: importedRecords.length,
      skipped: skippedRecords.length,
      failed: failedRecords.length,
      importedRecords,
      skippedRecords,
      failedRecords,
      errors
    };
  }

  // ==========================================================
  // BATCH IMPORT: EMPLOYEES
  // ==========================================================
  public async importEmployees(employeeList: any[]): Promise<{
    success: boolean;
    total: number;
    imported: number;
    skipped: number;
    failed: number;
    importedRecords: any[];
    skippedRecords: { row: number; name: string; reason: string }[];
    failedRecords: { row: number; reason: string }[];
    errors: string[];
  }> {
    if (!Array.isArray(employeeList) || employeeList.length === 0) {
      return { success: false, total: 0, imported: 0, skipped: 0, failed: 0, importedRecords: [], skippedRecords: [], failedRecords: [], errors: ['No employee rows provided for import.'] };
    }

    const normText = (s: any) => String(s || '').trim().toLowerCase();
    const normCode = (s: any) => String(s || '').trim().toUpperCase();
    const normDigits = (s: any) => String(s || '').replace(/\D/g, '');

    let existingEmps: any[] = [];
    if (this.isConnected && this.pool) {
      try {
        const [rows]: any = await this.pool.query('SELECT `id`, `employee_code`, `name`, `phone`, `email` FROM `solar_employee`');
        if (Array.isArray(rows)) existingEmps = rows;
      } catch (err: any) {
        console.warn('Notice reading existing employees:', err.message);
      }
    }
    if (existingEmps.length === 0) existingEmps = this.getFallbackItems('employees');

    const codeMap = new Map<string, string>();
    const emailMap = new Map<string, string>();
    const phoneMap = new Map<string, string>();

    for (const e of existingEmps) {
      const c = normCode(e.employee_code || e.employeeCode);
      const em = normText(e.email);
      const p = normDigits(e.phone);
      if (c) codeMap.set(c, e.name || 'Employee');
      if (em) emailMap.set(em, e.name || 'Employee');
      if (p.length >= 7) phoneMap.set(p, e.name || 'Employee');
    }

    const importedRecords: any[] = [];
    const skippedRecords: { row: number; name: string; reason: string }[] = [];
    const failedRecords: { row: number; reason: string }[] = [];
    const errors: string[] = [];

    let codeSeq = Date.now() % 10000;

    for (let i = 0; i < employeeList.length; i++) {
      const rowNum = i + 1;
      const raw = employeeList[i];
      if (!raw || typeof raw !== 'object') {
        failedRecords.push({ row: rowNum, reason: 'Empty or malformed record.' });
        errors.push(`Row ${rowNum}: Empty or malformed record.`);
        continue;
      }

      const name = String(raw.name || '').trim();
      const rawCode = String(raw.employeeCode || raw.employee_code || '').trim();
      const department = String(raw.department || 'Operations').trim();
      const designation = String(raw.designation || 'Staff Member').trim();
      const phone = String(raw.phone || '').trim();
      const email = String(raw.email || '').trim().toLowerCase();
      const rawJoin = raw.joiningDate ?? raw.joining_date ?? raw['joining date'] ?? raw['Joining Date'] ?? raw.date_of_joining ?? raw.doj ?? raw.startDate ?? raw.start_date;
      const joiningDate = this.toSqlDate(rawJoin) || new Date().toISOString().split('T')[0];
      const rawSalary = String(raw.salaryMonthly ?? raw.salary_monthly ?? raw.salary ?? '').replace(/[^0-9.]/g, '');
      const salaryMonthly = parseFloat(rawSalary) || 0;
      const status = String(raw.status || 'ACTIVE').trim().toUpperCase();
      const systemRole = String(raw.systemRole || raw.system_role || raw.role || 'Staff Member').trim();
      const isFieldWorker = Boolean(raw.isFieldWorker || raw.is_field_worker);
      const loginEnabled = raw.loginEnabled !== undefined ? Boolean(raw.loginEnabled) : true;

      if (!name) {
        failedRecords.push({ row: rowNum, reason: 'Employee name is mandatory.' });
        errors.push(`Row ${rowNum}: Employee name is mandatory.`);
        continue;
      }

      const employeeCode = rawCode || `EMP-${new Date().getFullYear()}-${String(++codeSeq).padStart(4, '0')}`;
      const cNorm = normCode(employeeCode);
      const pDigits = normDigits(phone);

      if (rawCode && codeMap.has(cNorm)) {
        const exName = codeMap.get(cNorm);
        skippedRecords.push({ row: rowNum, name, reason: `Employee code "${employeeCode}" already exists (${exName}).` });
        errors.push(`Row ${rowNum} Skipped (Duplicate): Employee code "${employeeCode}" already exists.`);
        continue;
      }

      if (email && emailMap.has(email)) {
        const exName = emailMap.get(email);
        skippedRecords.push({ row: rowNum, name, reason: `Email "${email}" is already registered to "${exName}".` });
        errors.push(`Row ${rowNum} Skipped (Duplicate): Email "${email}" already exists.`);
        continue;
      }

      if (pDigits.length >= 7 && phoneMap.has(pDigits)) {
        const exName = phoneMap.get(pDigits);
        skippedRecords.push({ row: rowNum, name, reason: `Phone "${phone}" is already registered to "${exName}".` });
        errors.push(`Row ${rowNum} Skipped (Duplicate): Phone "${phone}" already exists.`);
        continue;
      }

      const empId = raw.id || `emp-imp-${Date.now()}-${rowNum}`;
      const record: any = {
        id: empId,
        employeeCode,
        name,
        photoUrl: raw.photoUrl || raw.photo_url || '',
        documents: [],
        department,
        designation,
        phone,
        email: email || `${cNorm.toLowerCase()}@solar.klyiatechnology.com`,
        joiningDate,
        salaryMonthly,
        status,
        currentSiteLocation: raw.currentSiteLocation || '',
        loginEnabled,
        systemRole,
        isFieldWorker,
        accountStatus: status === 'DISABLED' ? 'DISABLED' : 'ACTIVE',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      if (this.isConnected && this.pool) {
        try {
          const sql = `
            INSERT INTO \`solar_employee\` (
              \`id\`, \`employee_code\`, \`name\`, \`photo_url\`, \`documents_json\`, \`department\`,
              \`designation\`, \`phone\`, \`email\`, \`joining_date\`, \`salary_monthly\`,
              \`status\`, \`current_site_location\`, \`login_enabled\`, \`system_role\`,
              \`is_field_worker\`, \`account_status\`
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
              \`name\` = VALUES(\`name\`), \`photo_url\` = VALUES(\`photo_url\`),
              \`department\` = VALUES(\`department\`), \`designation\` = VALUES(\`designation\`),
              \`phone\` = VALUES(\`phone\`), \`email\` = VALUES(\`email\`),
              \`joining_date\` = VALUES(\`joining_date\`),
              \`salary_monthly\` = VALUES(\`salary_monthly\`), \`status\` = VALUES(\`status\`),
              \`login_enabled\` = VALUES(\`login_enabled\`), \`system_role\` = VALUES(\`system_role\`),
              \`is_field_worker\` = VALUES(\`is_field_worker\`)
          `;
          await this.pool.query(sql, [
            record.id, record.employeeCode, record.name, record.photoUrl, '[]',
            record.department, record.designation, record.phone, record.email,
            record.joiningDate, record.salaryMonthly, record.status,
            record.currentSiteLocation, record.loginEnabled ? 1 : 0, record.systemRole,
            record.isFieldWorker ? 1 : 0, record.accountStatus
          ]);

          // Synchronize to solar_users if loginEnabled
          if (record.loginEnabled) {
            try {
              const tempImportPass = raw.password || `Emp@${Math.random().toString(36).slice(-8)}`;
              const defaultPasswordHash = bcrypt.hashSync(tempImportPass, 10);
              await this.pool.query(`
                INSERT INTO \`solar_users\` (
                  \`id\`, \`name\`, \`email\`, \`password\`, \`role\`, \`phone\`,
                  \`department\`, \`designation\`, \`employee_id\`, \`is_field_worker\`, \`status\`
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                  \`name\` = VALUES(\`name\`), \`phone\` = VALUES(\`phone\`),
                  \`department\` = VALUES(\`department\`), \`designation\` = VALUES(\`designation\`),
                  \`status\` = VALUES(\`status\`)
              `, [
                record.id, record.name, record.email, defaultPasswordHash, record.systemRole,
                record.phone, record.department, record.designation, record.employeeCode,
                record.isFieldWorker ? 1 : 0, record.status
              ]);

              if (record.email) {
                await authService.setCredential(this.pool, {
                  userId: record.id,
                  email: record.email,
                  password: tempImportPass,
                  role: record.systemRole || 'Technician',
                  accountType: (record.systemRole === 'Admin' || record.systemRole === 'Super Admin') ? 'ADMIN' : 'EMPLOYEE',
                  linkedEntityId: record.id,
                  status: record.status
                }).catch(() => {});
              }
            } catch (uErr: any) {
              console.warn('Notice syncing employee to users:', uErr.message);
            }
          }
        } catch (dbErr: any) {
          failedRecords.push({ row: rowNum, reason: `MySQL write error: ${dbErr.message}` });
          errors.push(`Row ${rowNum}: MySQL write error: ${dbErr.message}`);
          continue;
        }
      }

      this.upsertFallback('employees', record);
      codeMap.set(cNorm, name);
      if (email) emailMap.set(email, name);
      if (pDigits.length >= 7) phoneMap.set(pDigits, name);
      importedRecords.push(record);
    }

    this.saveDiskSnapshot();
    return {
      success: true,
      total: employeeList.length,
      imported: importedRecords.length,
      skipped: skippedRecords.length,
      failed: failedRecords.length,
      importedRecords,
      skippedRecords,
      failedRecords,
      errors
    };
  }

  // ==========================================================
  // BATCH IMPORT: PRODUCTS
  // ==========================================================
  public async importProducts(productList: any[]): Promise<{
    success: boolean;
    total: number;
    imported: number;
    skipped: number;
    failed: number;
    importedRecords: any[];
    skippedRecords: { row: number; name: string; reason: string }[];
    failedRecords: { row: number; reason: string }[];
    errors: string[];
  }> {
    if (!Array.isArray(productList) || productList.length === 0) {
      return { success: false, total: 0, imported: 0, skipped: 0, failed: 0, importedRecords: [], skippedRecords: [], failedRecords: [], errors: ['No product rows provided for import.'] };
    }

    const normText = (s: any) => String(s || '').trim().toLowerCase();
    const normCode = (s: any) => String(s || '').trim().toUpperCase();

    let existingProducts: any[] = [];
    if (this.isConnected && this.pool) {
      try {
        const [rows]: any = await this.pool.query('SELECT `id`, `sku`, `name` FROM `solar_products`');
        if (Array.isArray(rows)) existingProducts = rows;
      } catch (err: any) {
        console.warn('Notice reading existing products:', err.message);
      }
    }
    if (existingProducts.length === 0) existingProducts = this.getFallbackItems('products');

    const skuMap = new Map<string, string>();
    const nameMap = new Map<string, string>();

    for (const p of existingProducts) {
      const sku = normCode(p.sku || p.itemCode);
      const name = normText(p.name);
      if (sku) skuMap.set(sku, p.name || 'Product');
      if (name) nameMap.set(name, p.sku || 'SKU');
    }

    const importedRecords: any[] = [];
    const skippedRecords: { row: number; name: string; reason: string }[] = [];
    const failedRecords: { row: number; reason: string }[] = [];
    const errors: string[] = [];

    let codeSeq = Date.now() % 10000;

    for (let i = 0; i < productList.length; i++) {
      const rowNum = i + 1;
      const raw = productList[i];
      if (!raw || typeof raw !== 'object') {
        failedRecords.push({ row: rowNum, reason: 'Empty or malformed record.' });
        errors.push(`Row ${rowNum}: Empty or malformed record.`);
        continue;
      }

      const name = String(raw.name || '').trim();
      const rawSku = String(raw.sku || raw.itemCode || '').trim();
      const category = String(raw.category || 'Solar Panels').trim();
      const brand = String(raw.brand || '').trim();
      const model = String(raw.model || '').trim();
      const specifications = String(raw.specifications || raw.specification || '').trim();
      const unit = String(raw.unit || 'Nos').trim();
      const hsnCode = String(raw.hsnCode || raw.hsn_code || '85414011').trim();
      const rawPrice = String(raw.unitPrice ?? raw.unit_price ?? raw.sellingPrice ?? '').replace(/[^0-9.]/g, '');
      const unitPrice = parseFloat(rawPrice) || 0;
      const rawSelling = String(raw.sellingPrice ?? raw.selling_price ?? '').replace(/[^0-9.]/g, '');
      const sellingPrice = rawSelling !== '' ? (parseFloat(rawSelling) || 0) : Math.round(unitPrice * 1.15);
      const rawStock = String(raw.currentStock ?? raw.current_stock ?? raw.stock ?? '').replace(/[^0-9.]/g, '');
      const currentStock = parseFloat(rawStock) || 0;
      const rawReorder = String(raw.minStockThreshold ?? raw.reorderLevel ?? raw.minStockLevel ?? raw.reorder_level ?? '').replace(/[^0-9.]/g, '');
      const reorderLevel = rawReorder !== '' ? (parseFloat(rawReorder) ?? 10) : 10;
      const rawGstInput = String(raw.gstRate ?? raw.gst_rate ?? '').trim();
      const rawGst = rawGstInput.replace(/[^0-9.-]/g, '');
      const parsedImportGst = rawGst !== '' ? parseFloat(rawGst) : 18;
      if (rawGst !== '' && (!Number.isFinite(parsedImportGst) || parsedImportGst < 0 || parsedImportGst > 100)) {
        failedRecords.push({ row: rowNum, reason: `Invalid GST rate "${rawGstInput}". Must be between 0 and 100.` });
        errors.push(`Row ${rowNum}: Invalid GST rate "${rawGstInput}". Must be between 0 and 100.`);
        continue;
      }
      const gstRate = Math.round(parsedImportGst * 100) / 100;
      const warehouseId = String(raw.warehouseId || raw.warehouse_id || '').trim();
      const warehouseName = String(raw.warehouseName || raw.warehouse_name || '').trim();
      const location = String(raw.location || warehouseName || '').trim();
      const status = String(raw.status || 'ACTIVE').trim().toUpperCase();

      if (!name) {
        failedRecords.push({ row: rowNum, reason: 'Product name is mandatory.' });
        errors.push(`Row ${rowNum}: Product name is mandatory.`);
        continue;
      }

      const sku = rawSku || `PROD-${new Date().getFullYear()}-${String(++codeSeq).padStart(4, '0')}`;
      const skuNorm = normCode(sku);
      const nameNorm = normText(name);

      if (rawSku && skuMap.has(skuNorm)) {
        const exName = skuMap.get(skuNorm);
        skippedRecords.push({ row: rowNum, name, reason: `Product SKU "${sku}" already exists (${exName}).` });
        errors.push(`Row ${rowNum} Skipped (Duplicate): SKU "${sku}" already exists.`);
        continue;
      }

      if (nameMap.has(nameNorm)) {
        const exSku = nameMap.get(nameNorm);
        skippedRecords.push({ row: rowNum, name, reason: `Product with name "${name}" already exists (SKU: ${exSku}).` });
        errors.push(`Row ${rowNum} Skipped (Duplicate): Product name "${name}" already exists.`);
        continue;
      }

      const prodId = raw.id || `prod-imp-${Date.now()}-${rowNum}`;
      const warehouseStocks = (raw.warehouseStocks && typeof raw.warehouseStocks === 'object')
        ? raw.warehouseStocks
        : (warehouseId ? { [warehouseId]: currentStock } : {});
      const warehouseStocksJson = JSON.stringify(warehouseStocks);
      const preferredVendorId = String(raw.preferredVendorId || raw.preferred_vendor_id || '').trim();
      const preferredVendorName = String(raw.preferredVendorName || raw.preferred_vendor_name || '').trim();

      const record: any = {
        id: prodId,
        sku,
        itemCode: sku,
        name,
        category,
        brand,
        model,
        specifications,
        specification: specifications,
        unit,
        hsnCode,
        gstRate,
        taxRate: gstRate,
        unitPrice,
        sellingPrice,
        currentStock,
        reorderLevel,
        minStockLevel: reorderLevel,
        minStockThreshold: reorderLevel,
        location,
        warehouseId,
        warehouseName,
        warehouseStocks,
        preferredVendorId,
        preferredVendorName,
        status,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      if (this.isConnected && this.pool) {
        try {
          const sql = `
            INSERT INTO \`solar_products\` (
              \`id\`, \`name\`, \`sku\`, \`category\`, \`brand\`, \`model\`,
              \`specifications\`, \`unit\`, \`hsn_code\`, \`gst_rate\`,
              \`unit_price\`, \`selling_price\`, \`current_stock\`, \`reorder_level\`,
              \`location\`, \`warehouse_id\`, \`warehouse_name\`, \`warehouse_stocks_json\`,
              \`preferred_vendor_id\`, \`preferred_vendor_name\`, \`status\`
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
              \`name\` = VALUES(\`name\`), \`sku\` = VALUES(\`sku\`),
              \`category\` = VALUES(\`category\`), \`brand\` = VALUES(\`brand\`),
              \`model\` = VALUES(\`model\`), \`specifications\` = VALUES(\`specifications\`),
              \`unit\` = VALUES(\`unit\`), \`hsn_code\` = VALUES(\`hsn_code\`),
              \`gst_rate\` = VALUES(\`gst_rate\`), \`unit_price\` = VALUES(\`unit_price\`),
              \`selling_price\` = VALUES(\`selling_price\`), \`current_stock\` = VALUES(\`current_stock\`),
              \`reorder_level\` = VALUES(\`reorder_level\`), \`location\` = VALUES(\`location\`),
              \`warehouse_id\` = VALUES(\`warehouse_id\`), \`warehouse_name\` = VALUES(\`warehouse_name\`),
              \`warehouse_stocks_json\` = VALUES(\`warehouse_stocks_json\`),
              \`preferred_vendor_id\` = VALUES(\`preferred_vendor_id\`), \`preferred_vendor_name\` = VALUES(\`preferred_vendor_name\`),
              \`status\` = VALUES(\`status\`)
          `;
          await this.pool.query(sql, [
            record.id, record.name, record.sku, record.category, record.brand, record.model,
            record.specifications, record.unit, record.hsnCode, record.gstRate,
            record.unitPrice, record.sellingPrice, record.currentStock, record.reorderLevel,
            record.location, record.warehouseId, record.warehouseName, warehouseStocksJson,
            record.preferredVendorId, record.preferredVendorName, record.status
          ]);
        } catch (dbErr: any) {
          failedRecords.push({ row: rowNum, reason: `MySQL write error: ${dbErr.message}` });
          errors.push(`Row ${rowNum}: MySQL write error: ${dbErr.message}`);
          continue;
        }
      }

      this.upsertFallback('products', record);
      skuMap.set(skuNorm, name);
      nameMap.set(nameNorm, sku);
      importedRecords.push(record);
    }

    this.saveDiskSnapshot();
    return {
      success: true,
      total: productList.length,
      imported: importedRecords.length,
      skipped: skippedRecords.length,
      failed: failedRecords.length,
      importedRecords,
      skippedRecords,
      failedRecords,
      errors
    };
  }

  // ==========================================================
  // BATCH IMPORT: VENDORS
  // ==========================================================
  public async importVendors(vendorList: any[]): Promise<{
    success: boolean;
    total: number;
    imported: number;
    skipped: number;
    failed: number;
    importedRecords: any[];
    skippedRecords: { row: number; name: string; reason: string }[];
    failedRecords: { row: number; reason: string }[];
    errors: string[];
  }> {
    if (!Array.isArray(vendorList) || vendorList.length === 0) {
      return { success: false, total: 0, imported: 0, skipped: 0, failed: 0, importedRecords: [], skippedRecords: [], failedRecords: [], errors: ['No vendor rows provided for import.'] };
    }

    const normText = (s: any) => String(s || '').trim().toLowerCase();
    const normCode = (s: any) => String(s || '').trim().toUpperCase();
    const normDigits = (s: any) => String(s || '').replace(/\D/g, '');
    const normGst = (s: any) => String(s || '').trim().toUpperCase().replace(/[\s-]/g, '');

    let existingVendors: any[] = [];
    if (this.isConnected && this.pool) {
      try {
        const [rows]: any = await this.pool.query('SELECT `id`, `vendor_code`, `name`, `phone`, `email`, `gst_number` FROM `solar_vendors`');
        if (Array.isArray(rows)) existingVendors = rows;
      } catch (err: any) {
        console.warn('Notice reading existing vendors:', err.message);
      }
    }
    if (existingVendors.length === 0) existingVendors = this.getFallbackItems('vendors');

    const codeMap = new Map<string, string>();
    const nameMap = new Map<string, string>();
    const gstMap = new Map<string, string>();
    const phoneMap = new Map<string, string>();
    const emailMap = new Map<string, string>();

    for (const v of existingVendors) {
      const code = normCode(v.vendor_code || v.vendorCode);
      const name = normText(v.name);
      const gst = normGst(v.gst_number || v.gstNumber);
      const phone = normDigits(v.phone);
      const email = normText(v.email);

      if (code) codeMap.set(code, v.name || 'Vendor');
      if (name) nameMap.set(name, v.vendor_code || 'VND');
      if (gst) gstMap.set(gst, v.name || 'Vendor');
      if (phone.length >= 7) phoneMap.set(phone, v.name || 'Vendor');
      if (email) emailMap.set(email, v.name || 'Vendor');
    }

    const importedRecords: any[] = [];
    const skippedRecords: { row: number; name: string; reason: string }[] = [];
    const failedRecords: { row: number; reason: string }[] = [];
    const errors: string[] = [];

    let codeSeq = Date.now() % 10000;

    for (let i = 0; i < vendorList.length; i++) {
      const rowNum = i + 1;
      const raw = vendorList[i];
      if (!raw || typeof raw !== 'object') {
        failedRecords.push({ row: rowNum, reason: 'Empty or malformed record.' });
        errors.push(`Row ${rowNum}: Empty or malformed record.`);
        continue;
      }

      const name = String(raw.name || '').trim();
      const rawCode = String(raw.vendorCode || raw.vendor_code || '').trim();
      const contactPerson = String(raw.contactPerson || raw.contact_person || '').trim();
      const phone = String(raw.phone || '').trim();
      const email = String(raw.email || '').trim().toLowerCase();
      const address = String(raw.address || '').trim();
      const city = String(raw.city || 'Ahmedabad').trim();
      const state = String(raw.state || 'Gujarat').trim();
      const gstNumber = normGst(raw.gstNumber || raw.gst_number);
      const panNumber = String(raw.panNumber || raw.pan_number || '').trim().toUpperCase();
      const paymentTerms = String(raw.paymentTerms || raw.payment_terms || '30 Days').trim();
      const rawRating = String(raw.rating || '4.5').replace(/[^0-9.]/g, '');
      const rating = parseFloat(rawRating) || 4.5;
      const status = String(raw.status || 'ACTIVE').trim().toUpperCase();
      const rawCat = raw.categories || (raw.category ? [raw.category] : ['Solar Modules']);
      const categories = (Array.isArray(rawCat) ? rawCat : [String(rawCat)]).map(c => String(c).trim()).filter(Boolean);
      const bankDetails = raw.bankDetails && typeof raw.bankDetails === 'object' ? raw.bankDetails : null;
      const bankDetailsJson = bankDetails ? JSON.stringify(bankDetails) : null;

      if (!name) {
        failedRecords.push({ row: rowNum, reason: 'Vendor name is mandatory.' });
        errors.push(`Row ${rowNum}: Vendor name is mandatory.`);
        continue;
      }

      const vendorCode = rawCode || `VND-${new Date().getFullYear()}-${String(++codeSeq).padStart(4, '0')}`;
      const codeNorm = normCode(vendorCode);
      const nameNorm = normText(name);
      const phoneNorm = normDigits(phone);

      if (rawCode && codeMap.has(codeNorm)) {
        const exName = codeMap.get(codeNorm);
        skippedRecords.push({ row: rowNum, name, reason: `Vendor code "${vendorCode}" already exists (${exName}).` });
        errors.push(`Row ${rowNum} Skipped (Duplicate): Vendor code "${vendorCode}" already exists.`);
        continue;
      }

      if (nameMap.has(nameNorm)) {
        const exCode = nameMap.get(nameNorm);
        skippedRecords.push({ row: rowNum, name, reason: `Vendor name "${name}" already exists (Code: ${exCode}).` });
        errors.push(`Row ${rowNum} Skipped (Duplicate): Vendor name "${name}" already exists.`);
        continue;
      }

      if (gstNumber && gstMap.has(gstNumber)) {
        const exName = gstMap.get(gstNumber);
        skippedRecords.push({ row: rowNum, name, reason: `GSTIN "${gstNumber}" is already registered to "${exName}".` });
        errors.push(`Row ${rowNum} Skipped (Duplicate): GSTIN "${gstNumber}" already exists.`);
        continue;
      }

      if (phoneNorm.length >= 7 && phoneMap.has(phoneNorm)) {
        const exName = phoneMap.get(phoneNorm);
        skippedRecords.push({ row: rowNum, name, reason: `Phone "${phone}" is already registered to "${exName}".` });
        errors.push(`Row ${rowNum} Skipped (Duplicate): Phone "${phone}" already exists.`);
        continue;
      }

      if (email && emailMap.has(email)) {
        const exName = emailMap.get(email);
        skippedRecords.push({ row: rowNum, name, reason: `Email "${email}" is already registered to "${exName}".` });
        errors.push(`Row ${rowNum} Skipped (Duplicate): Email "${email}" already exists.`);
        continue;
      }

      const vendId = raw.id || `vend-imp-${Date.now()}-${rowNum}`;
      const record: any = {
        id: vendId,
        vendorCode,
        name,
        contactPerson,
        phone,
        email,
        address,
        city,
        state,
        gstNumber,
        panNumber,
        paymentTerms,
        rating,
        category: raw.category || categories[0] || 'Solar Modules',
        categories,
        categoriesJson: JSON.stringify(categories),
        bankDetails: bankDetails || undefined,
        status,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      if (this.isConnected && this.pool) {
        try {
          const sql = `
            INSERT INTO \`solar_vendors\` (
              \`id\`, \`name\`, \`vendor_code\`, \`contact_person\`, \`phone\`, \`email\`,
              \`address\`, \`city\`, \`state\`, \`gst_number\`, \`pan_number\`,
              \`payment_terms\`, \`rating\`, \`categories_json\`, \`bank_details_json\`, \`status\`
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
              \`name\` = VALUES(\`name\`), \`vendor_code\` = VALUES(\`vendor_code\`),
              \`contact_person\` = VALUES(\`contact_person\`), \`phone\` = VALUES(\`phone\`),
              \`email\` = VALUES(\`email\`), \`address\` = VALUES(\`address\`),
              \`city\` = VALUES(\`city\`), \`state\` = VALUES(\`state\`),
              \`gst_number\` = VALUES(\`gst_number\`), \`payment_terms\` = VALUES(\`payment_terms\`),
              \`rating\` = VALUES(\`rating\`), \`categories_json\` = VALUES(\`categories_json\`),
              \`bank_details_json\` = VALUES(\`bank_details_json\`), \`status\` = VALUES(\`status\`)
          `;
          await this.pool.query(sql, [
            record.id, record.name, record.vendorCode, record.contactPerson,
            record.phone, record.email, record.address, record.city, record.state,
            record.gstNumber, record.panNumber, record.paymentTerms, record.rating,
            record.categoriesJson, bankDetailsJson, record.status
          ]);
        } catch (dbErr: any) {
          failedRecords.push({ row: rowNum, reason: `MySQL write error: ${dbErr.message}` });
          errors.push(`Row ${rowNum}: MySQL write error: ${dbErr.message}`);
          continue;
        }
      }

      this.upsertFallback('vendors', record);
      codeMap.set(codeNorm, name);
      nameMap.set(nameNorm, vendorCode);
      if (gstNumber) gstMap.set(gstNumber, name);
      if (phoneNorm.length >= 7) phoneMap.set(phoneNorm, name);
      if (email) emailMap.set(email, name);
      importedRecords.push(record);
    }

    this.saveDiskSnapshot();
    return {
      success: true,
      total: vendorList.length,
      imported: importedRecords.length,
      skipped: skippedRecords.length,
      failed: failedRecords.length,
      importedRecords,
      skippedRecords,
      failedRecords,
      errors
    };
  }

  // ==========================================================
  // BATCH IMPORT: PAYMENTS
  // ==========================================================
  public async importPayments(paymentList: any[]): Promise<{
    success: boolean;
    total: number;
    imported: number;
    skipped: number;
    failed: number;
    importedRecords: any[];
    skippedRecords: { row: number; name: string; reason: string }[];
    failedRecords: { row: number; reason: string }[];
    errors: string[];
  }> {
    if (!Array.isArray(paymentList) || paymentList.length === 0) {
      return { success: false, total: 0, imported: 0, skipped: 0, failed: 0, importedRecords: [], skippedRecords: [], failedRecords: [], errors: ['No payment rows provided for import.'] };
    }

    const normCode = (s: any) => String(s || '').trim().toUpperCase();

    let existingPayments: any[] = [];
    if (this.isConnected && this.pool) {
      try {
        const [rows]: any = await this.pool.query('SELECT `id`, `receipt_number`, `transaction_reference` FROM `solar_payments`');
        if (Array.isArray(rows)) existingPayments = rows;
      } catch (err: any) {
        console.warn('Notice reading existing payments:', err.message);
      }
    }
    if (existingPayments.length === 0) existingPayments = this.getFallbackItems('payments');

    const receiptMap = new Map<string, string>();
    const txMap = new Map<string, string>();

    for (const p of existingPayments) {
      const rec = normCode(p.receipt_number || p.receiptNumber);
      const tx = normCode(p.transaction_reference || p.transactionReference);
      if (rec) receiptMap.set(rec, p.id);
      if (tx && tx.length > 3) txMap.set(tx, p.receipt_number || p.id);
    }

    const importedRecords: any[] = [];
    const skippedRecords: { row: number; name: string; reason: string }[] = [];
    const failedRecords: { row: number; reason: string }[] = [];
    const errors: string[] = [];

    let codeSeq = Date.now() % 10000;

    for (let i = 0; i < paymentList.length; i++) {
      const rowNum = i + 1;
      const raw = paymentList[i];
      if (!raw || typeof raw !== 'object') {
        failedRecords.push({ row: rowNum, reason: 'Empty or malformed record.' });
        errors.push(`Row ${rowNum}: Empty or malformed record.`);
        continue;
      }

      const rawAmountStr = String(raw.amount ?? raw.amount_inr ?? '').trim();
      const parsedAmount = typeof raw.amount === 'number' ? raw.amount : parseFloat(rawAmountStr.replace(/[^0-9.-]/g, ''));
      const customerName = String(raw.customerName || raw.customer_name || raw.client || raw.name || '').trim();
      const milestone = String(raw.milestone || 'Project Milestone').trim();
      const rawReceipt = String(raw.receiptNumber || raw.receipt_number || raw.receiptNo || '').trim();
      const status = String(raw.status || 'PAID').trim().toUpperCase();
      const dueDate = raw.dueDate ? String(raw.dueDate).split('T')[0] : (raw.due_date ? String(raw.due_date).split('T')[0] : null);
      const paidDate = raw.paidDate ? String(raw.paidDate).split('T')[0] : (raw.paid_date ? String(raw.paid_date).split('T')[0] : new Date().toISOString().split('T')[0]);
      const paymentMode = String(raw.paymentMode || raw.payment_mode || 'Bank NEFT/RTGS').trim();
      const txRef = String(raw.transactionReference || raw.transaction_reference || '').trim();
      const notes = String(raw.notes || 'Imported via CSV Hub').trim();

      if (!customerName) {
        failedRecords.push({ row: rowNum, reason: 'Customer name is mandatory.' });
        errors.push(`Row ${rowNum}: Customer name is mandatory.`);
        continue;
      }

      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        failedRecords.push({ row: rowNum, reason: `Valid positive payment amount (> 0) is required (got "${raw.amount ?? 'empty'}").` });
        errors.push(`Row ${rowNum}: Valid positive payment amount (> 0) is required (got "${raw.amount ?? 'empty'}").`);
        continue;
      }
      const amount = parsedAmount;

      const receiptNumber = rawReceipt || `RCPT-${new Date().getFullYear()}-${String(++codeSeq).padStart(4, '0')}`;
      const recNorm = normCode(receiptNumber);
      const txNorm = normCode(txRef);

      if (rawReceipt && receiptMap.has(recNorm)) {
        skippedRecords.push({ row: rowNum, name: receiptNumber, reason: `Receipt number "${receiptNumber}" already exists.` });
        errors.push(`Row ${rowNum} Skipped (Duplicate): Receipt number "${receiptNumber}" already exists.`);
        continue;
      }

      if (txNorm && txNorm.length > 3 && txMap.has(txNorm)) {
        const exRec = txMap.get(txNorm);
        skippedRecords.push({ row: rowNum, name: receiptNumber, reason: `Transaction reference "${txRef}" already exists on receipt "${exRec}".` });
        errors.push(`Row ${rowNum} Skipped (Duplicate): Transaction reference "${txRef}" already exists.`);
        continue;
      }

      const payId = raw.id || `pay-imp-${Date.now()}-${rowNum}`;
      const record: any = {
        id: payId,
        receiptNumber,
        projectId: raw.projectId || raw.project_id || '',
        customerId: raw.customerId || raw.customer_id || '',
        customerName,
        milestone,
        amount,
        status,
        dueDate,
        paidDate,
        paymentMode,
        transactionReference: txRef,
        notes,
        tallySyncStatus: raw.tallySyncStatus || 'NOT SYNCED',
        tallyReference: raw.tallyReference || '',
        createdAt: new Date().toISOString()
      };

      if (this.isConnected && this.pool) {
        try {
          const sql = `
            INSERT INTO \`solar_payments\` (
              \`id\`, \`receipt_number\`, \`project_id\`, \`customer_id\`, \`customer_name\`,
              \`milestone\`, \`amount\`, \`status\`, \`due_date\`, \`paid_date\`,
              \`payment_mode\`, \`transaction_reference\`, \`notes\`, \`tally_sync_status\`, \`tally_reference\`
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
              \`customer_name\` = VALUES(\`customer_name\`), \`milestone\` = VALUES(\`milestone\`),
              \`amount\` = VALUES(\`amount\`), \`status\` = VALUES(\`status\`),
              \`paid_date\` = VALUES(\`paid_date\`), \`notes\` = VALUES(\`notes\`)
          `;
          await this.pool.query(sql, [
            record.id, record.receiptNumber, record.projectId, record.customerId,
            record.customerName, record.milestone, record.amount, record.status,
            record.dueDate, record.paidDate, record.paymentMode, record.transactionReference,
            record.notes, record.tallySyncStatus, record.tallyReference
          ]);
        } catch (dbErr: any) {
          failedRecords.push({ row: rowNum, reason: `MySQL write error: ${dbErr.message}` });
          errors.push(`Row ${rowNum}: MySQL write error: ${dbErr.message}`);
          continue;
        }
      }

      this.upsertFallback('payments', record);
      receiptMap.set(recNorm, payId);
      if (txNorm && txNorm.length > 3) txMap.set(txNorm, receiptNumber);
      importedRecords.push(record);
    }

    this.saveDiskSnapshot();
    return {
      success: true,
      total: paymentList.length,
      imported: importedRecords.length,
      skipped: skippedRecords.length,
      failed: failedRecords.length,
      importedRecords,
      skippedRecords,
      failedRecords,
      errors
    };
  }

  // ==========================================================
  // BATCH IMPORT: EXPENSES
  // ==========================================================
  public async importExpenses(expenseList: any[]): Promise<{
    success: boolean;
    total: number;
    imported: number;
    skipped: number;
    failed: number;
    importedRecords: any[];
    skippedRecords: { row: number; name: string; reason: string }[];
    failedRecords: { row: number; reason: string }[];
    errors: string[];
  }> {
    if (!Array.isArray(expenseList) || expenseList.length === 0) {
      return { success: false, total: 0, imported: 0, skipped: 0, failed: 0, importedRecords: [], skippedRecords: [], failedRecords: [], errors: ['No expense rows provided for import.'] };
    }

    const normCode = (s: any) => String(s || '').trim().toUpperCase();

    let existingExpenses: any[] = [];
    if (this.isConnected && this.pool) {
      try {
        const [rows]: any = await this.pool.query('SELECT `id`, `expense_number`, `reference_no` FROM `solar_expenses`');
        if (Array.isArray(rows)) existingExpenses = rows;
      } catch (err: any) {
        console.warn('Notice reading existing expenses:', err.message);
      }
    }
    if (existingExpenses.length === 0) existingExpenses = this.getFallbackItems('expenses');

    const expMap = new Map<string, string>();
    const refMap = new Map<string, string>();

    for (const e of existingExpenses) {
      const num = normCode(e.expense_number || e.expenseNumber);
      const ref = normCode(e.reference_no || e.referenceNo);
      if (num) expMap.set(num, e.id);
      if (ref && ref.length > 3) refMap.set(ref, e.expense_number || e.id);
    }

    const importedRecords: any[] = [];
    const skippedRecords: { row: number; name: string; reason: string }[] = [];
    const failedRecords: { row: number; reason: string }[] = [];
    const errors: string[] = [];

    let codeSeq = Date.now() % 10000;

    for (let i = 0; i < expenseList.length; i++) {
      const rowNum = i + 1;
      const raw = expenseList[i];
      if (!raw || typeof raw !== 'object') {
        failedRecords.push({ row: rowNum, reason: 'Empty or malformed record.' });
        errors.push(`Row ${rowNum}: Empty or malformed record.`);
        continue;
      }

      const rawAmountStr = String(raw.amount ?? raw.amount_inr ?? '').trim();
      const parsedAmount = typeof raw.amount === 'number' ? raw.amount : parseFloat(rawAmountStr.replace(/[^0-9.-]/g, ''));
      const vendorName = String(raw.vendorName || raw.vendor_name || raw.vendor || raw.payee || '').trim();
      const category = String(raw.category || raw.expenseCategory || 'Site Expenses').trim();
      const rawExpNo = String(raw.expenseNumber || raw.expense_number || raw.expenseNo || '').trim();
      const expenseDate = raw.date ? String(raw.date).split('T')[0] : (raw.expenseDate ? String(raw.expenseDate).split('T')[0] : new Date().toISOString().split('T')[0]);
      const paymentMode = String(raw.paymentMode || raw.payment_mode || 'Bank Payment').trim();
      const refNo = String(raw.referenceNo || raw.reference_no || raw.refNo || '').trim();
      const notes = String(raw.notes || 'Imported via CSV Hub').trim();

      if (!vendorName) {
        failedRecords.push({ row: rowNum, reason: 'Vendor name is mandatory.' });
        errors.push(`Row ${rowNum}: Vendor name is mandatory.`);
        continue;
      }

      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        failedRecords.push({ row: rowNum, reason: `Valid positive expense amount (> 0) is required (got "${raw.amount ?? 'empty'}").` });
        errors.push(`Row ${rowNum}: Valid positive expense amount (> 0) is required (got "${raw.amount ?? 'empty'}").`);
        continue;
      }
      const amount = parsedAmount;

      const expenseNumber = rawExpNo || `EXP-${new Date().getFullYear()}-${String(++codeSeq).padStart(4, '0')}`;
      const expNorm = normCode(expenseNumber);
      const refNorm = normCode(refNo);

      if (rawExpNo && expMap.has(expNorm)) {
        skippedRecords.push({ row: rowNum, name: expenseNumber, reason: `Expense number "${expenseNumber}" already exists.` });
        errors.push(`Row ${rowNum} Skipped (Duplicate): Expense number "${expenseNumber}" already exists.`);
        continue;
      }

      if (refNorm && refNorm.length > 3 && refMap.has(refNorm)) {
        const exNum = refMap.get(refNorm);
        skippedRecords.push({ row: rowNum, name: expenseNumber, reason: `Reference number "${refNo}" already exists on expense "${exNum}".` });
        errors.push(`Row ${rowNum} Skipped (Duplicate): Reference number "${refNo}" already exists.`);
        continue;
      }

      const expId = raw.id || `exp-imp-${Date.now()}-${rowNum}`;
      const record: any = {
        id: expId,
        expenseNumber,
        projectId: raw.projectId || raw.project_id || '',
        projectCode: raw.projectCode || raw.project_code || '',
        vendorName,
        category,
        amount,
        expenseDate,
        paymentMode,
        referenceNo: refNo,
        notes,
        receiptUrl: raw.receiptUrl || '',
        approvedBy: raw.approvedBy || '',
        tallySyncStatus: raw.tallySyncStatus || 'NOT SYNCED',
        createdAt: new Date().toISOString()
      };

      if (this.isConnected && this.pool) {
        try {
          const sql = `
            INSERT INTO \`solar_expenses\` (
              \`id\`, \`expense_number\`, \`project_id\`, \`project_code\`, \`vendor_name\`,
              \`category\`, \`amount\`, \`expense_date\`, \`payment_mode\`, \`reference_no\`,
              \`notes\`, \`receipt_url\`, \`approved_by\`, \`tally_sync_status\`
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
              \`vendor_name\` = VALUES(\`vendor_name\`), \`category\` = VALUES(\`category\`),
              \`amount\` = VALUES(\`amount\`), \`expense_date\` = VALUES(\`expense_date\`),
              \`notes\` = VALUES(\`notes\`)
          `;
          await this.pool.query(sql, [
            record.id, record.expenseNumber, record.projectId, record.projectCode,
            record.vendorName, record.category, record.amount, record.expenseDate,
            record.paymentMode, record.referenceNo, record.notes, record.receiptUrl,
            record.approvedBy, record.tallySyncStatus
          ]);
        } catch (dbErr: any) {
          failedRecords.push({ row: rowNum, reason: `MySQL write error: ${dbErr.message}` });
          errors.push(`Row ${rowNum}: MySQL write error: ${dbErr.message}`);
          continue;
        }
      }

      this.upsertFallback('expenses', record);
      expMap.set(expNorm, expId);
      if (refNorm && refNorm.length > 3) refMap.set(refNorm, expenseNumber);
      importedRecords.push(record);
    }

    this.saveDiskSnapshot();
    return {
      success: true,
      total: expenseList.length,
      imported: importedRecords.length,
      skipped: skippedRecords.length,
      failed: failedRecords.length,
      importedRecords,
      skippedRecords,
      failedRecords,
      errors
    };
  }

  // ==========================================================
  // BATCH IMPORT: ATTENDANCE
  // ==========================================================
  public async importAttendance(attendanceList: any[]): Promise<{
    success: boolean;
    total: number;
    imported: number;
    skipped: number;
    failed: number;
    importedRecords: any[];
    skippedRecords: { row: number; name: string; reason: string }[];
    failedRecords: { row: number; reason: string }[];
    errors: string[];
  }> {
    if (!Array.isArray(attendanceList) || attendanceList.length === 0) {
      return { success: false, total: 0, imported: 0, skipped: 0, failed: 0, importedRecords: [], skippedRecords: [], failedRecords: [], errors: ['No attendance rows provided for import.'] };
    }

    const normText = (s: any) => String(s || '').trim().toLowerCase();

    let existingAtt: any[] = [];
    let existingEmps: any[] = [];
    if (this.isConnected && this.pool) {
      try {
        const [aRows]: any = await this.pool.query('SELECT `id`, `employee_id`, `employee_name`, `attendance_date` FROM `solar_attendance`');
        if (Array.isArray(aRows)) existingAtt = aRows;
      } catch (err: any) {
        console.warn('Notice reading existing attendance:', err.message);
      }
      try {
        const [eRows]: any = await this.pool.query('SELECT `id`, `employee_code`, `name` FROM `solar_employee`');
        if (Array.isArray(eRows)) existingEmps = eRows;
      } catch (err: any) {
        console.warn('Notice reading existing employees for attendance:', err.message);
      }
    }
    if (existingAtt.length === 0) existingAtt = this.getFallbackItems('attendance');
    if (existingEmps.length === 0) existingEmps = this.getFallbackItems('employees');

    const empLookup = new Map<string, string>();
    for (const e of existingEmps) {
      if (e.id) empLookup.set(normText(e.id), e.id);
      if (e.employee_code || e.employeeCode) empLookup.set(normText(e.employee_code || e.employeeCode), e.id);
      if (e.name) empLookup.set(normText(e.name), e.id);
    }

    const attMap = new Map<string, string>();
    for (const a of existingAtt) {
      const dt = a.attendance_date ? String(a.attendance_date).split('T')[0] : (a.date ? String(a.date).split('T')[0] : '');
      const empId = normText(a.employee_id || a.employeeId);
      const empName = normText(a.employee_name || a.employeeName);
      if (empId && dt) attMap.set(`${empId}:::${dt}`, a.id);
      if (empName && dt) attMap.set(`${empName}:::${dt}`, a.id);
    }

    const importedRecords: any[] = [];
    const skippedRecords: { row: number; name: string; reason: string }[] = [];
    const failedRecords: { row: number; reason: string }[] = [];
    const errors: string[] = [];

    for (let i = 0; i < attendanceList.length; i++) {
      const rowNum = i + 1;
      const raw = attendanceList[i];
      if (!raw || typeof raw !== 'object') {
        failedRecords.push({ row: rowNum, reason: 'Empty or malformed record.' });
        errors.push(`Row ${rowNum}: Empty or malformed record.`);
        continue;
      }

      const empName = String(raw.employeeName || raw.employee_name || raw.name || '').trim();
      const rawEmpId = String(raw.employeeId || raw.employee_id || '').trim();
      const attendanceDate = raw.date ? String(raw.date).split('T')[0] : (raw.attendanceDate ? String(raw.attendanceDate).split('T')[0] : new Date().toISOString().split('T')[0]);
      const checkInTime = String(raw.checkInTime || raw.check_in_time || '09:00 AM').trim();
      const checkOutTime = raw.checkOutTime || raw.check_out_time || null;
      const status = String(raw.status || 'PRESENT').trim().toUpperCase();
      const siteProjectTitle = String(raw.siteLocation || raw.siteProjectTitle || raw.site_project_title || '').trim();

      if (!empName && !rawEmpId) {
        failedRecords.push({ row: rowNum, reason: 'Employee name or ID is mandatory.' });
        errors.push(`Row ${rowNum}: Employee name or ID is mandatory.`);
        continue;
      }

      const effectiveEmpId = rawEmpId || empLookup.get(normText(empName)) || `emp-auto-${normText(empName).replace(/\s+/g, '')}`;
      const effectiveEmpName = empName || 'Employee';

      const keyId = `${normText(effectiveEmpId)}:::${attendanceDate}`;
      const keyName = `${normText(effectiveEmpName)}:::${attendanceDate}`;

      if (attMap.has(keyId) || attMap.has(keyName)) {
        skippedRecords.push({ row: rowNum, name: `${effectiveEmpName} (${attendanceDate})`, reason: `Attendance record for "${effectiveEmpName}" on date "${attendanceDate}" already exists.` });
        errors.push(`Row ${rowNum} Skipped (Duplicate): Attendance record on "${attendanceDate}" already exists.`);
        continue;
      }

      const attId = raw.id || `att-imp-${Date.now()}-${rowNum}`;
      const record: any = {
        id: attId,
        employeeId: effectiveEmpId,
        employeeName: effectiveEmpName,
        attendanceDate,
        date: attendanceDate,
        checkInTime,
        checkOutTime,
        siteProjectId: raw.siteProjectId || '',
        siteProjectTitle,
        status,
        checkInGPS: raw.checkInGPS || null,
        checkOutGPS: raw.checkOutGPS || null,
        fuelExpense: raw.fuelExpense || null,
        createdAt: new Date().toISOString()
      };

      if (this.isConnected && this.pool) {
        try {
          const sql = `
            INSERT INTO \`solar_attendance\` (
              \`id\`, \`employee_id\`, \`employee_name\`, \`attendance_date\`,
              \`check_in_time\`, \`check_out_time\`, \`site_project_id\`, \`site_project_title\`,
              \`status\`
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
              \`check_in_time\` = VALUES(\`check_in_time\`), \`check_out_time\` = VALUES(\`check_out_time\`),
              \`status\` = VALUES(\`status\`), \`site_project_title\` = VALUES(\`site_project_title\`)
          `;
          await this.pool.query(sql, [
            record.id, record.employeeId, record.employeeName, record.attendanceDate,
            record.checkInTime, record.checkOutTime, record.siteProjectId,
            record.siteProjectTitle, record.status
          ]);
        } catch (dbErr: any) {
          failedRecords.push({ row: rowNum, reason: `MySQL write error: ${dbErr.message}` });
          errors.push(`Row ${rowNum}: MySQL write error: ${dbErr.message}`);
          continue;
        }
      }

      this.upsertFallback('attendance', record);
      attMap.set(keyId, attId);
      attMap.set(keyName, attId);
      importedRecords.push(record);
    }

    this.saveDiskSnapshot();
    return {
      success: true,
      total: attendanceList.length,
      imported: importedRecords.length,
      skipped: skippedRecords.length,
      failed: failedRecords.length,
      importedRecords,
      skippedRecords,
      failedRecords,
      errors
    };
  }

  // ==========================================================
  // BATCH IMPORT: SERVICE TICKETS
  // ==========================================================
  public async importServiceTickets(ticketList: any[]): Promise<{
    success: boolean;
    total: number;
    imported: number;
    skipped: number;
    failed: number;
    importedRecords: any[];
    skippedRecords: { row: number; name: string; reason: string }[];
    failedRecords: { row: number; reason: string }[];
    errors: string[];
  }> {
    if (!Array.isArray(ticketList) || ticketList.length === 0) {
      return { success: false, total: 0, imported: 0, skipped: 0, failed: 0, importedRecords: [], skippedRecords: [], failedRecords: [], errors: ['No service ticket rows provided for import.'] };
    }

    const normCode = (s: any) => String(s || '').trim().toUpperCase();

    let existingTickets: any[] = [];
    if (this.isConnected && this.pool) {
      try {
        const [rows]: any = await this.pool.query('SELECT `id`, `ticket_id` FROM `solar_service_tickets`');
        if (Array.isArray(rows)) existingTickets = rows;
      } catch (err: any) {
        console.warn('Notice reading existing tickets:', err.message);
      }
    }
    if (existingTickets.length === 0) existingTickets = this.getFallbackItems('service_tickets');

    const ticketMap = new Map<string, string>();
    for (const t of existingTickets) {
      const code = normCode(t.ticket_id || t.ticketId || t.ticketNumber);
      if (code) ticketMap.set(code, t.id);
    }

    const importedRecords: any[] = [];
    const skippedRecords: { row: number; name: string; reason: string }[] = [];
    const failedRecords: { row: number; reason: string }[] = [];
    const errors: string[] = [];

    let codeSeq = Date.now() % 10000;

    for (let i = 0; i < ticketList.length; i++) {
      const rowNum = i + 1;
      const raw = ticketList[i];
      if (!raw || typeof raw !== 'object') {
        failedRecords.push({ row: rowNum, reason: 'Empty or malformed record.' });
        errors.push(`Row ${rowNum}: Empty or malformed record.`);
        continue;
      }

      const rawTicketId = String(raw.ticketId || raw.ticket_id || raw.ticketNumber || '').trim();
      const customerName = String(raw.customerName || raw.customer_name || raw.client || '').trim();
      const issue = String(raw.issue || raw.title || raw.description || '').trim();
      const category = String(raw.category || 'Inverter Error / Offline').trim();
      const priority = String(raw.priority || 'MEDIUM').trim().toUpperCase();
      const status = String(raw.status || 'OPEN').trim().toUpperCase();
      const notes = String(raw.notes || 'Imported via CSV Hub').trim();

      if (!issue) {
        failedRecords.push({ row: rowNum, reason: 'Issue description is mandatory.' });
        errors.push(`Row ${rowNum}: Issue description is mandatory.`);
        continue;
      }

      if (!customerName) {
        failedRecords.push({ row: rowNum, reason: 'Customer name is mandatory.' });
        errors.push(`Row ${rowNum}: Customer name is mandatory.`);
        continue;
      }

      const ticketId = rawTicketId || `SRV-${new Date().getFullYear()}-${String(++codeSeq).padStart(4, '0')}`;
      const codeNorm = normCode(ticketId);

      if (rawTicketId && ticketMap.has(codeNorm)) {
        skippedRecords.push({ row: rowNum, name: ticketId, reason: `Service ticket ID "${ticketId}" already exists.` });
        errors.push(`Row ${rowNum} Skipped (Duplicate): Service ticket ID "${ticketId}" already exists.`);
        continue;
      }

      const tId = raw.id || `srv-imp-${Date.now()}-${rowNum}`;
      const record: any = {
        id: tId,
        ticketId,
        ticketNumber: ticketId,
        customerId: raw.customerId || raw.customer_id || '',
        customerName,
        projectId: raw.projectId || raw.project_id || '',
        projectTitle: raw.projectTitle || raw.project_title || 'Solar Rooftop Installation',
        issue: issue || 'Solar System Inspection',
        title: issue || 'Solar System Inspection',
        category,
        priority,
        assignedTechnicianId: raw.assignedTechnicianId || '',
        assignedTechnicianName: raw.assignedTechnicianName || '',
        status,
        scheduledDate: raw.scheduledDate ? String(raw.scheduledDate).split('T')[0] : null,
        resolvedDate: raw.resolvedDate ? String(raw.resolvedDate).split('T')[0] : null,
        notes,
        photos: [],
        createdAt: new Date().toISOString()
      };

      if (this.isConnected && this.pool) {
        try {
          const sql = `
            INSERT INTO \`solar_service_tickets\` (
              \`id\`, \`ticket_id\`, \`customer_id\`, \`customer_name\`, \`project_id\`,
              \`project_title\`, \`issue\`, \`category\`, \`priority\`,
              \`assigned_technician_id\`, \`assigned_technician_name\`, \`status\`,
              \`scheduled_date\`, \`resolved_date\`, \`notes\`, \`photos_json\`
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
              \`customer_name\` = VALUES(\`customer_name\`), \`issue\` = VALUES(\`issue\`),
              \`category\` = VALUES(\`category\`), \`priority\` = VALUES(\`priority\`),
              \`status\` = VALUES(\`status\`), \`notes\` = VALUES(\`notes\`)
          `;
          await this.pool.query(sql, [
            record.id, record.ticketId, record.customerId, record.customerName,
            record.projectId, record.projectTitle, record.issue, record.category,
            record.priority, record.assignedTechnicianId, record.assignedTechnicianName,
            record.status, record.scheduledDate, record.resolvedDate, record.notes,
            JSON.stringify(record.photos)
          ]);
        } catch (dbErr: any) {
          failedRecords.push({ row: rowNum, reason: `MySQL write error: ${dbErr.message}` });
          errors.push(`Row ${rowNum}: MySQL write error: ${dbErr.message}`);
          continue;
        }
      }

      this.upsertFallback('service_tickets', record);
      ticketMap.set(codeNorm, tId);
      importedRecords.push(record);
    }

    this.saveDiskSnapshot();
    return {
      success: true,
      total: ticketList.length,
      imported: importedRecords.length,
      skipped: skippedRecords.length,
      failed: failedRecords.length,
      importedRecords,
      skippedRecords,
      failedRecords,
      errors
    };
  }

  // ==========================================================
  // CRUD: EMPLOYEES
  // ==========================================================
  public async getEmployees(): Promise<any[]> {
    if (!this.isConnected) return this.getFallbackItems('employees');
    this.assertDbConnected();
    const [rows] = await this.pool!.query('SELECT * FROM `solar_employee` ORDER BY `created_at` ASC');
    const existingIds = new Set((rows as any[]).map(r => r.id));
    const existingEmails = new Set((rows as any[]).map(r => (r.email || '').toLowerCase()).filter(Boolean));

    try {
      const [userRows]: any = await this.pool!.query("SELECT * FROM `solar_users` WHERE `role` != 'Customer'");
      if (Array.isArray(userRows)) {
        for (const u of userRows) {
          const uEmail = (u.email || '').toLowerCase().trim();
          if (!existingIds.has(u.id) && (!uEmail || !existingEmails.has(uEmail))) {
            (rows as any[]).push({
              id: u.id,
              employee_code: u.employee_id || `EMP-${u.id.slice(-4).toUpperCase()}`,
              name: u.name,
              photo_url: u.photo_url || u.avatar || '',
              department: u.department || 'Operations',
              designation: u.designation || u.role || 'Staff Member',
              phone: u.phone || '',
              email: u.email,
              joining_date: u.created_at ? String(u.created_at).slice(0, 10) : null,
              salary_monthly: 0,
              status: u.status || 'ACTIVE',
              current_site_location: '',
              login_enabled: u.status !== 'DISABLED',
              auth_uid: u.id,
              system_role: u.role || 'Admin',
              assigned_role: u.role || 'Admin',
              is_field_worker: Boolean(u.is_field_worker),
              account_status: u.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE',
              created_at: u.created_at
            });
            existingIds.add(u.id);
            if (uEmail) existingEmails.add(uEmail);
          }
        }
      }
    } catch {}

    const docMap = new Map<string, any[]>();
    try {
      const [docRows]: any = await this.pool!.query('SELECT * FROM `solar_employee_documents` ORDER BY `uploaded_at` DESC');
      if (Array.isArray(docRows)) {
        for (const d of docRows) {
          const list = docMap.get(d.employee_id) || [];
          list.push({
            id: d.id,
            category: d.category,
            name: d.name,
            fileName: d.file_name,
            filePath: d.file_path,
            fileUrl: d.file_url,
            mimeType: d.mime_type,
            fileSize: Number(d.file_size) || 0,
            uploadedAt: d.uploaded_at ? new Date(d.uploaded_at).toISOString() : new Date().toISOString(),
            uploadedBy: d.uploaded_by,
            notes: d.notes
          });
          docMap.set(d.employee_id, list);
        }
      }
    } catch {}

    const formatSqlDate = (val: any): string | null => {
      if (!val) return null;
      if (typeof val === 'string') return val.slice(0, 10);
      if (val instanceof Date) {
        const y = val.getFullYear();
        const m = String(val.getMonth() + 1).padStart(2, '0');
        const d = String(val.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
      }
      return String(val).slice(0, 10);
    };

    const mapped = (rows as any[]).map(r => {
      let docs: any[] = docMap.get(r.id) || [];
      if (docs.length === 0 && r.documents_json) {
        try {
          const parsed = JSON.parse(r.documents_json);
          if (Array.isArray(parsed)) docs = parsed;
        } catch {}
      }

      return {
        id: r.id,
        employeeCode: r.employee_code || r.employeeCode || `EMP-${r.id.slice(-4).toUpperCase()}`,
        name: r.name,
        photoUrl: r.photo_url || r.photoUrl || '',
        documents: docs,
        department: r.department || 'Operations',
        designation: r.designation || 'Staff',
        assignedRole: r.assigned_role || r.assignedRole || r.system_role || 'Staff',
        phone: r.phone || '',
        email: r.email,
        joiningDate: formatSqlDate(r.joining_date || r.joiningDate),
        salaryMonthly: Number(r.salary_monthly ?? r.salaryMonthly) || 0,
        status: r.status || 'ACTIVE',
        currentSiteLocation: r.current_site_location || r.currentSiteLocation || '',
        esicNumber: r.esic_number || r.esicNumber || '',
        bankAccountNumber: r.bank_account_number || r.bankAccountNumber || '',
        bankName: r.bank_name || r.bankName || '',
        ifscCode: r.ifsc_code || r.ifscCode || '',
        emergencyContactPerson: r.emergency_contact_person || r.emergencyContactPerson || '',
        emergencyContactNumber: r.emergency_contact_number || r.emergencyContactNumber || '',
        loginEnabled: Boolean(r.login_enabled ?? r.loginEnabled ?? true),
        authUid: r.auth_uid || r.authUid || r.id,
        systemRole: r.system_role || r.systemRole || 'Staff',
        isFieldWorker: Boolean(r.is_field_worker ?? r.isFieldWorker),
        accountStatus: r.account_status || r.accountStatus || 'ACTIVE',
        accountCreatedAt: r.account_created_at || r.accountCreatedAt,
        accountCreatedBy: r.account_created_by || r.accountCreatedBy,
        createdAt: r.created_at || r.createdAt,
        updatedAt: r.updated_at || r.updatedAt
      };
    });
    this.setFallbackItems('employees', mapped);
    return mapped;
  }

  public async saveEmployee(emp: any): Promise<any> {
    this.assertDbConnected();
    const item = { ...emp };
    if (!item.id) item.id = `emp-${Date.now()}`;
    const requestedId = String(item.id);
    if (!item.createdAt) item.createdAt = new Date().toISOString();

    let existing = await this.getExistingRow('solar_employee', item.id);
    if (!existing && this.pool && (item.authUid || item.auth_uid)) {
      const [authRows]: any = await this.pool.query(
        'SELECT * FROM `solar_employee` WHERE `auth_uid` = ? LIMIT 1',
        [item.authUid || item.auth_uid]
      ).catch(() => [[]]);
      if (Array.isArray(authRows) && authRows.length > 0) {
        existing = authRows[0];
        item.id = existing.id;
      }
    }
    const employeeCode = String(item.employeeCode ?? item.employee_code ?? existing?.employee_code ?? item.id).trim();
    const name = item.name ?? existing?.name ?? (item.firstName ? `${item.firstName} ${item.lastName || ''}`.trim() : 'Employee');
    const photoUrl = item.photoUrl ?? item.photo_url ?? existing?.photo_url ?? '';
    const hasExplicitDocs = Array.isArray(item.documents);
    const rawDocs = hasExplicitDocs ? item.documents : (existing?.documents_json ? JSON.parse(existing.documents_json) : []);
    const documents = Array.isArray(rawDocs) ? rawDocs : [];
    const documentsJson = JSON.stringify(documents);
    const department = item.department ?? existing?.department ?? 'Operations';
    const designation = item.designation ?? existing?.designation ?? 'Solar Engineer';
    const phone = item.phone ?? existing?.phone ?? '+91 99999 00000';
    const email = String(item.email ?? existing?.email ?? `${item.id}@example.com`).trim().toLowerCase();
    const rawJoin = item.joiningDate ?? item.joining_date ?? existing?.joining_date;
    const joiningDate = this.toSqlDate(rawJoin) ?? '2025-01-01';
    const salaryMonthly = Number(item.salaryMonthly ?? item.salary_monthly ?? item.salary ?? existing?.salary_monthly ?? existing?.salary) || 0;
    const status = item.status ?? existing?.status ?? 'ACTIVE';
    const currentSiteLocation = item.currentSiteLocation ?? item.current_site_location ?? existing?.current_site_location ?? '';
    const esicNumber = String(item.esicNumber ?? item.esic_number ?? existing?.esic_number ?? '').trim();
    const bankAccountNumber = String(item.bankAccountNumber ?? item.bank_account_number ?? existing?.bank_account_number ?? '').trim();
    const bankName = String(item.bankName ?? item.bank_name ?? existing?.bank_name ?? '').trim();
    const ifscCode = String(item.ifscCode ?? item.ifsc_code ?? existing?.ifsc_code ?? '').trim().toUpperCase();
    const emergencyContactPerson = String(item.emergencyContactPerson ?? item.emergency_contact_person ?? existing?.emergency_contact_person ?? '').trim();
    const emergencyContactNumber = String(item.emergencyContactNumber ?? item.emergency_contact_number ?? existing?.emergency_contact_number ?? '').trim();
    const loginEnabled = this.parseBoolFlag(
      item.loginEnabled !== undefined ? item.loginEnabled : item.login_enabled,
      existing?.login_enabled !== undefined ? Boolean(existing.login_enabled) : true
    ) ? 1 : 0;
    const authUid = item.authUid ?? item.auth_uid ?? existing?.auth_uid ?? item.id;
    const systemRole = item.systemRole ?? item.system_role ?? existing?.system_role ?? 'Super Admin';
    const assignedRole = item.assignedRole ?? item.assigned_role ?? existing?.assigned_role ?? systemRole;
    const isFieldWorker = this.parseBoolFlag(
      item.isFieldWorker !== undefined ? item.isFieldWorker : item.is_field_worker,
      Boolean(existing?.is_field_worker)
    ) ? 1 : 0;
    const accountStatus = item.accountStatus ?? item.account_status ?? existing?.account_status ?? (loginEnabled ? 'ACTIVE' : 'DISABLED');
    const accountCreatedAt = item.accountCreatedAt ?? item.account_created_at ?? existing?.account_created_at ?? null;
    const accountCreatedBy = item.accountCreatedBy ?? item.account_created_by ?? existing?.account_created_by ?? null;

    if (this.pool) {
      if (employeeCode) {
        const [dupCode]: any = await this.pool.query(
          'SELECT id, name FROM `solar_employee` WHERE UPPER(`employee_code`) = UPPER(?) AND `id` != ? LIMIT 1',
          [employeeCode, item.id]
        );
        if (Array.isArray(dupCode) && dupCode.length > 0) {
          const err: any = new Error(`Employee code "${employeeCode}" is already assigned to ${dupCode[0].name}.`);
          err.statusCode = 409;
          throw err;
        }
      }
      if (email) {
        const [dupEmail]: any = await this.pool.query(
          'SELECT id, name FROM `solar_employee` WHERE LOWER(`email`) = ? AND `email` != "" AND `id` != ? LIMIT 1',
          [email, item.id]
        );
        if (Array.isArray(dupEmail) && dupEmail.length > 0) {
          const err: any = new Error(`Email "${email}" is already assigned to employee ${dupEmail[0].name}.`);
          err.statusCode = 409;
          throw err;
        }
      }
    }

    const sql = `
      INSERT INTO \`solar_employee\` (
        \`id\`, \`employee_code\`, \`name\`, \`photo_url\`, \`documents_json\`, \`department\`,
        \`designation\`, \`phone\`, \`email\`, \`joining_date\`, \`salary_monthly\`,
        \`status\`, \`current_site_location\`,
        \`esic_number\`, \`bank_account_number\`, \`bank_name\`, \`ifsc_code\`,
        \`emergency_contact_person\`, \`emergency_contact_number\`,
        \`login_enabled\`, \`auth_uid\`, \`system_role\`,
        \`assigned_role\`, \`is_field_worker\`, \`account_status\`, \`account_created_at\`, \`account_created_by\`
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        \`employee_code\` = VALUES(\`employee_code\`),
        \`name\` = VALUES(\`name\`),
        \`photo_url\` = VALUES(\`photo_url\`),
        \`documents_json\` = VALUES(\`documents_json\`),
        \`department\` = VALUES(\`department\`),
        \`designation\` = VALUES(\`designation\`),
        \`phone\` = VALUES(\`phone\`),
        \`email\` = VALUES(\`email\`),
        \`joining_date\` = VALUES(\`joining_date\`),
        \`salary_monthly\` = VALUES(\`salary_monthly\`),
        \`status\` = VALUES(\`status\`),
        \`current_site_location\` = VALUES(\`current_site_location\`),
        \`esic_number\` = VALUES(\`esic_number\`),
        \`bank_account_number\` = VALUES(\`bank_account_number\`),
        \`bank_name\` = VALUES(\`bank_name\`),
        \`ifsc_code\` = VALUES(\`ifsc_code\`),
        \`emergency_contact_person\` = VALUES(\`emergency_contact_person\`),
        \`emergency_contact_number\` = VALUES(\`emergency_contact_number\`),
        \`login_enabled\` = VALUES(\`login_enabled\`),
        \`auth_uid\` = VALUES(\`auth_uid\`),
        \`system_role\` = VALUES(\`system_role\`),
        \`assigned_role\` = VALUES(\`assigned_role\`),
        \`is_field_worker\` = VALUES(\`is_field_worker\`),
        \`account_status\` = VALUES(\`account_status\`),
        \`account_created_at\` = COALESCE(VALUES(\`account_created_at\`), \`solar_employee\`.\`account_created_at\`),
        \`account_created_by\` = COALESCE(VALUES(\`account_created_by\`), \`solar_employee\`.\`account_created_by\`),
        \`updated_at\` = CURRENT_TIMESTAMP
    `;
    await this.pool!.query(sql, [
      item.id,
      employeeCode,
      name,
      photoUrl,
      documentsJson,
      department,
      designation,
      phone,
      email,
      joiningDate,
      salaryMonthly,
      status,
      currentSiteLocation,
      esicNumber,
      bankAccountNumber,
      bankName,
      ifscCode,
      emergencyContactPerson,
      emergencyContactNumber,
      loginEnabled,
      authUid,
      systemRole,
      assignedRole,
      isFieldWorker,
      accountStatus,
      accountCreatedAt,
      accountCreatedBy
    ]);

    if (this.pool && requestedId !== String(item.id)) {
      await this.pool.query(
        'UPDATE `solar_employee_documents` SET `employee_id` = ? WHERE `employee_id` = ?',
        [item.id, requestedId]
      ).catch(() => {});
    }

    // Synchronize documents into solar_employee_documents audit table
    if (this.pool && hasExplicitDocs) {
      try {
        const keepIds = documents.map((d: any) => d.id).filter(Boolean);
        if (keepIds.length === 0) {
          await this.pool.query('DELETE FROM `solar_employee_documents` WHERE `employee_id` = ?', [item.id]).catch(() => {});
        } else {
          const placeholders = keepIds.map(() => '?').join(',');
          await this.pool.query(
            `DELETE FROM \`solar_employee_documents\` WHERE \`employee_id\` = ? AND \`id\` NOT IN (${placeholders})`,
            [item.id, ...keepIds]
          ).catch(() => {});
        }
      } catch {}

      for (const doc of documents) {
        if (!doc.id || !doc.fileName) continue;
        try {
          await this.pool.query(`
            INSERT INTO \`solar_employee_documents\` (
              \`id\`, \`employee_id\`, \`category\`, \`name\`, \`file_name\`,
              \`file_path\`, \`file_url\`, \`mime_type\`, \`file_size\`,
              \`uploaded_at\`, \`uploaded_by\`, \`notes\`
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)
            ON DUPLICATE KEY UPDATE
              \`employee_id\` = VALUES(\`employee_id\`),
              \`category\` = VALUES(\`category\`),
              \`name\` = VALUES(\`name\`),
              \`file_name\` = VALUES(\`file_name\`),
              \`file_path\` = VALUES(\`file_path\`),
              \`file_url\` = VALUES(\`file_url\`),
              \`mime_type\` = VALUES(\`mime_type\`),
              \`file_size\` = VALUES(\`file_size\`),
              \`notes\` = VALUES(\`notes\`)
          `, [
            doc.id,
            item.id,
            doc.category || 'Other',
            doc.name || doc.fileName,
            doc.fileName,
            doc.filePath || doc.fileUrl || '',
            doc.fileUrl || '',
            doc.mimeType || 'application/octet-stream',
            Number(doc.fileSize) || 0,
            doc.uploadedBy || 'HR Administrator',
            doc.notes || null
          ]);
        } catch (e: any) {
          console.warn('[DB Manager] Notice syncing employee doc to table:', e.message);
        }
      }
    }

    // Authoritatively synchronize employee account to solar_users
    if (this.pool) {
      try {
        const [existingUserRows]: any = await this.pool.query(
          'SELECT id, password FROM `solar_users` WHERE `id` = ? OR `id` = ? OR `employee_id` = ? OR (LOWER(`email`) = ? AND `email` != "") LIMIT 1',
          [item.id, authUid, employeeCode, email.toLowerCase()]
        );
        const existingUser = Array.isArray(existingUserRows) && existingUserRows.length > 0 ? existingUserRows[0] : null;
        const rawPass = item.password || item.tempPassword;
        const isActiveLogin = Boolean(loginEnabled) && status !== 'INACTIVE' && status !== 'TERMINATED' && accountStatus !== 'DISABLED';

        // Allow creating a solar_users record only if:
        // (a) existingUser already exists (update it), OR
        // (b) this is a brand-new employee (!existing), OR
        // (c) caller explicitly supplied a password/tempPassword to enable login
        const shouldSyncUser = isActiveLogin && (Boolean(existingUser) || !existing || Boolean(rawPass && typeof rawPass === 'string' && rawPass.trim().length >= 6));

        if (shouldSyncUser) {
          let passwordHash = existingUser?.password;
          if (rawPass && typeof rawPass === 'string' && rawPass.trim().length >= 6) {
            const cleanPass = rawPass.trim();
            if (!cleanPass.startsWith('$2a$') && !cleanPass.startsWith('$2b$') && !cleanPass.startsWith('$2y$') && !cleanPass.startsWith('$argon2id$')) {
              passwordHash = await bcrypt.hash(cleanPass, 10);
            } else {
              passwordHash = cleanPass;
            }
          } else if (!passwordHash) {
            passwordHash = await bcrypt.hash(`Emp@${Math.random().toString(36).slice(-8)}`, 10);
          }

          const cleanPhotoUrl = String(photoUrl || '').trim();
          const hasPhotoUrl = cleanPhotoUrl !== '';
          const targetUserId = existingUser?.id || item.id;
          if (existingUser) {
            await this.pool.query(`
              UPDATE \`solar_users\`
              SET \`name\` = ?, \`email\` = ?, \`role\` = ?, \`phone\` = ?,
                  \`department\` = ?, \`designation\` = ?, \`employee_id\` = ?,
                  ${hasPhotoUrl ? '`avatar` = ?, `photo_url` = ?,' : ''}
                  \`is_field_worker\` = ?, \`status\` = 'ACTIVE', \`updated_at\` = CURRENT_TIMESTAMP
                  ${rawPass ? ', `password` = ?' : ''}
              WHERE \`id\` = ?
            `, [
              name, email.toLowerCase(), systemRole, phone,
              department, designation, employeeCode,
              ...(hasPhotoUrl ? [cleanPhotoUrl, cleanPhotoUrl] : []),
              isFieldWorker,
              ...(rawPass ? [passwordHash] : []),
              targetUserId
            ]);
          } else {
            await this.pool.query(`
              INSERT INTO \`solar_users\` (
                \`id\`, \`name\`, \`email\`, \`password\`, \`role\`, \`phone\`,
                \`department\`, \`designation\`, \`employee_id\`, \`avatar\`, \`photo_url\`, \`is_field_worker\`, \`status\`
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
            `, [
              targetUserId, name, email.toLowerCase(), passwordHash, systemRole, phone,
              department, designation, employeeCode, cleanPhotoUrl || null, cleanPhotoUrl || null, isFieldWorker
            ]);
            console.log('[Audit][solar_users]', JSON.stringify({
              timestamp: new Date().toISOString(),
              operation: 'INSERT',
              source: 'dbManager.saveEmployee',
              targetUserId,
              email: email.toLowerCase()
            }));
          }

          await authService.setCredential(this.pool, {
            userId: targetUserId,
            email: email.toLowerCase(),
            password: rawPass || undefined,
            role: systemRole || 'Technician',
            accountType: (systemRole === 'Admin' || systemRole === 'Super Admin') ? 'ADMIN' : 'EMPLOYEE',
            linkedEntityId: item.id,
            status: 'ACTIVE'
          });
        } else if (!isActiveLogin && existingUser) {
          const cleanPhotoUrl = String(photoUrl || '').trim();
          const hasPhotoUrl = cleanPhotoUrl !== '';
          // Disable existing login account while still keeping is_field_worker, metadata, and photo synced
          await this.pool.query(
            `UPDATE \`solar_users\`
             SET \`name\` = ?, \`department\` = ?, \`designation\` = ?, \`employee_id\` = ?,
                 \`is_field_worker\` = ?,
                 ${hasPhotoUrl ? '`photo_url` = ?, `avatar` = ?,' : ''}
                 \`status\` = 'DISABLED', \`updated_at\` = CURRENT_TIMESTAMP
             WHERE \`id\` = ?`,
            [
              name, department, designation, employeeCode, isFieldWorker,
              ...(hasPhotoUrl ? [cleanPhotoUrl, cleanPhotoUrl] : []),
              existingUser.id
            ]
          ).catch(() => {});
          await this.pool.query(
            "UPDATE `solar_auth_credentials` SET `status` = 'DISABLED' WHERE `user_id` = ? OR `linked_entity_id` = ? OR LOWER(`email`) = ?",
            [existingUser.id, item.id, email.toLowerCase()]
          ).catch(() => {});
          await this.pool.query(
            'DELETE FROM `solar_auth_sessions` WHERE `user_id` = ? OR `linked_entity_id` = ? OR LOWER(`email`) = ?',
            [existingUser.id, item.id, email.toLowerCase()]
          ).catch(() => {});
        }
      } catch (syncErr: any) {
        console.warn('[DB Manager] Notice syncing user from employee:', syncErr?.message || syncErr);
      }
    }

    const savedEmp: any = {
      ...item,
      authUid,
      salaryMonthly,
      esicNumber,
      bankAccountNumber,
      bankName,
      ifscCode,
      emergencyContactPerson,
      emergencyContactNumber,
      isFieldWorker: Boolean(isFieldWorker),
      photoUrl,
      documents
    };
    delete savedEmp.password;
    delete savedEmp.tempPassword;

    const items = this.getFallbackItems('employees');
    const idx = items.findIndex(e => e.id === item.id);
    if (idx >= 0) items[idx] = { ...items[idx], ...savedEmp };
    else items.push(savedEmp);
    this.setFallbackItems('employees', items);
    return savedEmp;
  }

  public async deleteEmployee(id: string): Promise<boolean> {
    this.assertDbConnected();
    const matchedIds = new Set<string>([id]);
    const matchedEmails = new Set<string>();
    const matchedCodes = new Set<string>();

    const collect = (val: any, target: Set<string>, lower = false) => {
      const clean = String(val || '').trim();
      if (!clean) return;
      target.add(lower ? clean.toLowerCase() : clean);
    };

    if (this.pool) {
      const getTableType = async (tbl: string): Promise<'NONE' | 'BASE TABLE' | 'VIEW'> => {
        try {
          const [rows]: any = await this.pool!.query(`SHOW FULL TABLES LIKE '${tbl}'`);
          if (!Array.isArray(rows) || rows.length === 0) return 'NONE';
          const type = String(Object.values(rows[0])[1] || '').toUpperCase();
          return type === 'VIEW' ? 'VIEW' : 'BASE TABLE';
        } catch {
          return 'NONE';
        }
      };

      const empBaseType = await getTableType('solar_employee');
      const empAliasType = await getTableType('solar_employees');
      const usersType = await getTableType('solar_users');

      if (empBaseType !== 'NONE') {
        try {
          const [eRows]: any = await this.pool.query(
            'SELECT id, auth_uid, employee_code, email FROM `solar_employee` WHERE `id` = ? OR `auth_uid` = ? OR `employee_code` = ? LIMIT 5',
            [id, id, id]
          );
          for (const r of (eRows || [])) {
            collect(r.id, matchedIds);
            collect(r.auth_uid, matchedIds);
            collect(r.employee_code, matchedCodes);
            collect(r.email, matchedEmails, true);
          }
        } catch {}
      }

      if (usersType !== 'NONE') {
        try {
          const [uRows]: any = await this.pool.query(
            'SELECT id, employee_id, email FROM `solar_users` WHERE `id` = ? OR `employee_id` = ? LIMIT 5',
            [id, id]
          );
          for (const r of (uRows || [])) {
            collect(r.id, matchedIds);
            collect(r.employee_id, matchedCodes);
            collect(r.email, matchedEmails, true);
          }
        } catch {}
      }

      const idList = Array.from(matchedIds);
      const emailList = Array.from(matchedEmails);
      const codeList = Array.from(matchedCodes);
      const idPh = idList.map(() => '?').join(',');
      const emailPh = emailList.map(() => '?').join(',');
      const codePh = codeList.map(() => '?').join(',');

      const conn = await this.pool.getConnection();
      try {
        await conn.beginTransaction();

        await conn
          .query(`DELETE FROM \`solar_employee_documents\` WHERE \`employee_id\` IN (${idPh})`, idList)
          .catch(() => {});

        await conn
          .query(
            `DELETE FROM \`solar_auth_sessions\` WHERE \`user_id\` IN (${idPh}) OR \`linked_entity_id\` IN (${idPh})` +
              (emailList.length ? ` OR LOWER(\`email\`) IN (${emailPh})` : ''),
            [...idList, ...idList, ...emailList]
          )
          .catch(() => {});

        await conn
          .query(
            `DELETE FROM \`solar_auth_credentials\` WHERE \`user_id\` IN (${idPh}) OR \`linked_entity_id\` IN (${idPh})` +
              (emailList.length ? ` OR LOWER(\`email\`) IN (${emailPh})` : ''),
            [...idList, ...idList, ...emailList]
          )
          .catch(() => {});

        await conn
          .query(
            `DELETE FROM \`solar_workforce_locations\` WHERE \`user_id\` IN (${idPh})` +
              (emailList.length ? ` OR LOWER(\`email\`) IN (${emailPh})` : ''),
            [...idList, ...emailList]
          )
          .catch(() => {});

        await conn
          .query(
            `UPDATE \`solar_service_tickets\` SET \`assigned_technician_id\` = '', \`assigned_technician_name\` = '', \`assigned_to_name\` = 'Unassigned' WHERE \`assigned_technician_id\` IN (${idPh}) AND COALESCE(\`status\`, 'OPEN') NOT IN ('RESOLVED', 'CLOSED')`,
            idList
          )
          .catch(() => {});

        if (empBaseType === 'BASE TABLE') {
          const eConds = [`\`id\` IN (${idPh})`, `\`auth_uid\` IN (${idPh})`];
          const eParams: any[] = [...idList, ...idList];
          if (codeList.length) {
            eConds.push(`\`employee_code\` IN (${codePh})`);
            eParams.push(...codeList);
          }
          if (emailList.length) {
            eConds.push(`LOWER(\`email\`) IN (${emailPh})`);
            eParams.push(...emailList);
          }
          await conn.query(`DELETE FROM \`solar_employee\` WHERE ${eConds.join(' OR ')}`, eParams);
        }

        if (empAliasType === 'BASE TABLE') {
          const eConds = [`\`id\` IN (${idPh})`];
          const eParams: any[] = [...idList];
          if (codeList.length) {
            eConds.push(`\`employee_code\` IN (${codePh})`);
            eParams.push(...codeList);
          }
          if (emailList.length) {
            eConds.push(`LOWER(\`email\`) IN (${emailPh})`);
            eParams.push(...emailList);
          }
          await conn.query(`DELETE FROM \`solar_employees\` WHERE ${eConds.join(' OR ')}`, eParams);
        }

        if (usersType === 'BASE TABLE') {
          const uConds = [`\`id\` IN (${idPh})`, `\`employee_id\` IN (${idPh})`];
          const uParams: any[] = [...idList, ...idList];
          if (codeList.length) {
            uConds.push(`\`employee_id\` IN (${codePh})`);
            uParams.push(...codeList);
          }
          if (emailList.length) {
            uConds.push(`LOWER(\`email\`) IN (${emailPh})`);
            uParams.push(...emailList);
          }
          await conn.query(`DELETE FROM \`solar_users\` WHERE ${uConds.join(' OR ')}`, uParams);
        }

        await conn.commit();
      } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
      } finally {
        conn.release();
      }

      console.log('[Audit][solar_users]', JSON.stringify({
        timestamp: new Date().toISOString(),
        operation: 'DELETE',
        source: 'dbManager.deleteEmployee',
        targetUserId: id,
        email: Array.from(matchedEmails)[0] || undefined
      }));
    }

    const items = this.getFallbackItems('employees').filter(
      e =>
        e &&
        !matchedIds.has(String(e.id)) &&
        !matchedIds.has(String(e.authUid || '')) &&
        (!e.employeeCode || !matchedCodes.has(String(e.employeeCode))) &&
        (!e.email || !matchedEmails.has(String(e.email).trim().toLowerCase()))
    );
    this.setFallbackItems('employees', items);
    const fallbackUsers = this.getFallbackItems('users').filter(
      u =>
        u &&
        !matchedIds.has(String(u.id)) &&
        (!u.employeeId || (!matchedIds.has(String(u.employeeId)) && !matchedCodes.has(String(u.employeeId)))) &&
        (!u.email || !matchedEmails.has(String(u.email).trim().toLowerCase()))
    );
    this.setFallbackItems('users', fallbackUsers);
    return true;
  }

  public async saveEmployeeDocument(doc: {
    id?: string;
    employeeId: string;
    category?: string;
    name: string;
    fileName: string;
    filePath: string;
    fileUrl: string;
    mimeType?: string;
    fileSize?: number;
    uploadedBy?: string;
    notes?: string;
  }): Promise<any> {
    this.assertDbConnected();
    const docId = doc.id || `doc-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const category = doc.category || 'Other';
    const mimeType = doc.mimeType || 'application/octet-stream';
    const fileSize = Number(doc.fileSize) || 0;
    const uploadedBy = doc.uploadedBy || 'HR Administrator';
    const notes = doc.notes || null;

    if (this.pool) {
      await this.pool.query(`
        INSERT INTO \`solar_employee_documents\` (
          \`id\`, \`employee_id\`, \`category\`, \`name\`, \`file_name\`,
          \`file_path\`, \`file_url\`, \`mime_type\`, \`file_size\`,
          \`uploaded_at\`, \`uploaded_by\`, \`notes\`
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)
        ON DUPLICATE KEY UPDATE
          \`category\` = VALUES(\`category\`),
          \`name\` = VALUES(\`name\`),
          \`file_name\` = VALUES(\`file_name\`),
          \`file_path\` = VALUES(\`file_path\`),
          \`file_url\` = VALUES(\`file_url\`),
          \`mime_type\` = VALUES(\`mime_type\`),
          \`file_size\` = VALUES(\`file_size\`),
          \`notes\` = VALUES(\`notes\`)
      `, [
        docId, doc.employeeId, category, doc.name, doc.fileName,
        doc.filePath, doc.fileUrl, mimeType, fileSize, uploadedBy, notes
      ]);

      // Sync documents_json in solar_employee
      try {
        const [rows]: any = await this.pool.query(
          'SELECT * FROM `solar_employee_documents` WHERE `employee_id` = ? ORDER BY `uploaded_at` DESC',
          [doc.employeeId]
        );
        const docsJson = JSON.stringify(rows.map((d: any) => ({
          id: d.id,
          category: d.category,
          name: d.name,
          fileName: d.file_name,
          filePath: d.file_path,
          fileUrl: d.file_url,
          mimeType: d.mime_type,
          fileSize: Number(d.file_size) || 0,
          uploadedAt: d.uploaded_at ? new Date(d.uploaded_at).toISOString() : new Date().toISOString(),
          uploadedBy: d.uploaded_by,
          notes: d.notes
        })));
        await this.pool.query(
          'UPDATE `solar_employee` SET `documents_json` = ? WHERE `id` = ? OR `auth_uid` = ? OR `employee_code` = ?',
          [docsJson, doc.employeeId, doc.employeeId, doc.employeeId]
        );
      } catch {}
    }

    return {
      id: docId,
      employeeId: doc.employeeId,
      category,
      name: doc.name,
      fileName: doc.fileName,
      filePath: doc.filePath,
      fileUrl: doc.fileUrl,
      mimeType,
      fileSize,
      uploadedAt: new Date().toISOString(),
      uploadedBy,
      notes
    };
  }

  public async deleteEmployeeDocument(employeeId: string, docId: string): Promise<boolean> {
    this.assertDbConnected();
    if (this.pool) {
      try {
        const [rows]: any = await this.pool.query(
          'SELECT file_path FROM `solar_employee_documents` WHERE `id` = ? AND `employee_id` = ?',
          [docId, employeeId]
        );
        if (Array.isArray(rows) && rows.length > 0 && rows[0].file_path) {
          const fullPath = path.isAbsolute(rows[0].file_path) ? rows[0].file_path : path.join(process.cwd(), rows[0].file_path);
          if (fs.existsSync(fullPath)) {
            try { fs.unlinkSync(fullPath); } catch {}
          }
        }
      } catch {}

      await this.pool.query('DELETE FROM `solar_employee_documents` WHERE `id` = ? AND `employee_id` = ?', [docId, employeeId]);

      // Sync documents_json in solar_employee
      try {
        const [rows]: any = await this.pool.query(
          'SELECT * FROM `solar_employee_documents` WHERE `employee_id` = ? ORDER BY `uploaded_at` DESC',
          [employeeId]
        );
        const docsJson = JSON.stringify(rows.map((d: any) => ({
          id: d.id,
          category: d.category,
          name: d.name,
          fileName: d.file_name,
          filePath: d.file_path,
          fileUrl: d.file_url,
          mimeType: d.mime_type,
          fileSize: Number(d.file_size) || 0,
          uploadedAt: d.uploaded_at ? new Date(d.uploaded_at).toISOString() : new Date().toISOString(),
          uploadedBy: d.uploaded_by,
          notes: d.notes
        })));
        await this.pool.query(
          'UPDATE `solar_employee` SET `documents_json` = ? WHERE `id` = ? OR `auth_uid` = ? OR `employee_code` = ?',
          [docsJson, employeeId, employeeId, employeeId]
        );
      } catch {}
    }
    return true;
  }

  public async getEmployeeDocuments(employeeId: string): Promise<any[]> {
    if (!this.isConnected || !this.pool) return [];
    try {
      const [rows]: any = await this.pool.query(
        'SELECT * FROM `solar_employee_documents` WHERE `employee_id` = ? ORDER BY `uploaded_at` DESC',
        [employeeId]
      );
      return (rows || []).map((d: any) => ({
        id: d.id,
        employeeId: d.employee_id,
        category: d.category,
        name: d.name,
        fileName: d.file_name,
        filePath: d.file_path,
        fileUrl: d.file_url,
        mimeType: d.mime_type,
        fileSize: Number(d.file_size) || 0,
        uploadedAt: d.uploaded_at ? new Date(d.uploaded_at).toISOString() : new Date().toISOString(),
        uploadedBy: d.uploaded_by,
        notes: d.notes
      }));
    } catch {
      return [];
    }
  }

  public async updateEmployeePhoto(id: string, photoUrl: string): Promise<boolean> {
    if (this.pool) {
      let linkedAuthUid = id;
      let linkedEmpCode = id;
      let linkedEmpEmail = '';
      try {
        const [empRows]: any = await this.pool.query(
          'SELECT id, auth_uid, employee_code, email FROM `solar_employee` WHERE `id` = ? OR `auth_uid` = ? OR `employee_code` = ? LIMIT 1',
          [id, id, id]
        );
        if (Array.isArray(empRows) && empRows.length > 0) {
          linkedAuthUid = empRows[0].auth_uid || empRows[0].id || id;
          linkedEmpCode = empRows[0].employee_code || id;
          linkedEmpEmail = String(empRows[0].email || '').trim().toLowerCase();
        }
      } catch {}

      await this.pool.query(
        'UPDATE `solar_employee` SET `photo_url` = ?, `updated_at` = CURRENT_TIMESTAMP WHERE `id` = ? OR `auth_uid` = ? OR `employee_code` = ?',
        [photoUrl, id, id, id]
      ).catch(() => {});

      const uWhere = '`id` = ? OR `id` = ? OR `employee_id` = ? OR `employee_id` = ?' + (linkedEmpEmail ? ' OR LOWER(`email`) = ?' : '');
      const uMatchParams = [id, linkedAuthUid, id, linkedEmpCode, ...(linkedEmpEmail ? [linkedEmpEmail] : [])];
      await this.pool.query(
        `UPDATE \`solar_users\` SET \`avatar\` = ?, \`photo_url\` = ?, \`updated_at\` = CURRENT_TIMESTAMP WHERE ${uWhere}`,
        [photoUrl, photoUrl, ...uMatchParams]
      ).catch(() => {
        // Fallback if a legacy solar_users schema only has avatar
        this.pool?.query(
          'UPDATE `solar_users` SET `avatar` = ?, `updated_at` = CURRENT_TIMESTAMP WHERE `id` = ? OR `id` = ? OR `employee_id` = ?',
          [photoUrl, id, linkedAuthUid, linkedEmpCode]
        ).catch(() => {});
      });
    }
    const items = this.getFallbackItems('employees');
    const idx = items.findIndex(e => e.id === id);
    if (idx >= 0) items[idx].photoUrl = photoUrl;
    this.setFallbackItems('employees', items);
    return true;
  }

  // ==========================================================
  // CRUD: PAYMENTS
  // ==========================================================
  public async getPayments(): Promise<any[]> {
    if (!this.isConnected) return this.getFallbackItems('payments');
    this.assertDbConnected();
    const [rows] = await this.pool!.query('SELECT * FROM `solar_payments` ORDER BY `created_at` DESC');
    const mapped = (rows as any[]).map(r => ({
      id: r.id,
      receiptNumber: r.receipt_number,
      projectId: r.project_id,
      customerId: r.customer_id,
      customerName: r.customer_name,
      milestone: r.milestone,
      amount: Number(r.amount) || 0,
      status: r.status,
      dueDate: r.due_date,
      paidDate: r.paid_date,
      paymentMode: r.payment_mode,
      transactionReference: r.transaction_reference,
      notes: r.notes,
      invoiceId: r.invoice_id || '',
      invoiceNumber: r.invoice_number || '',
      bankAccountId: r.bank_account_id || '',
      journalEntryId: r.journal_entry_id || '',
      tallySyncStatus: r.tally_sync_status,
      tallyReference: r.tally_reference,
      createdAt: r.created_at
    }));
    this.setFallbackItems('payments', mapped);
    return mapped;
  }

  public async savePayment(item: any): Promise<any> {
    this.assertDbConnected();
    const id = item.id || `pay-${Date.now()}`;
    const existing = await this.getExistingRow('solar_payments', id);
    const receiptNumber = item.receiptNumber ?? item.receiptNo ?? item.receipt_number ?? existing?.receipt_number ?? id;
    const projectId = item.projectId ?? item.project_id ?? existing?.project_id ?? '';
    const customerId = item.customerId ?? item.customer_id ?? existing?.customer_id ?? '';
    const customerName = item.customerName ?? item.customer_name ?? existing?.customer_name ?? 'Solar Customer';
    const milestone = item.milestone ?? existing?.milestone ?? 'Project Milestone';
    const rawPaymentAmount = item.amount ?? existing?.amount;
    const amount = rawPaymentAmount !== undefined && rawPaymentAmount !== null ? Number(rawPaymentAmount) : 0;
    const status = item.status ?? existing?.status ?? 'PENDING';
    const dueDate = (item.dueDate ?? item.due_date ?? existing?.due_date) ? this.toSqlDate(item.dueDate ?? item.due_date ?? existing?.due_date) : null;
    const rawPaid = item.paidDate ?? item.paymentDate ?? item.paid_date ?? existing?.paid_date;
    const paidDate = rawPaid ? this.toSqlDate(rawPaid) : null;
    const paymentMode = item.paymentMode ?? item.paymentMethod ?? item.payment_mode ?? existing?.payment_mode ?? 'Bank NEFT/RTGS';
    const txRef = item.transactionReference ?? item.transactionRef ?? item.referenceNumber ?? item.transaction_reference ?? existing?.transaction_reference ?? '';
    const notes = item.notes ?? existing?.notes ?? '';
    const invoiceId = item.invoiceId ?? item.invoice_id ?? existing?.invoice_id ?? '';
    const invoiceNumber = item.invoiceNumber ?? item.invoice_number ?? existing?.invoice_number ?? '';
    const bankAccountId = item.bankAccountId ?? item.bank_account_id ?? existing?.bank_account_id ?? '';
    const journalEntryId = item.journalEntryId ?? item.journal_entry_id ?? existing?.journal_entry_id ?? '';
    const tallySyncStatus = item.tallySyncStatus ?? item.tally_sync_status ?? existing?.tally_sync_status ?? 'NOT SYNCED';
    const tallyReference = item.tallyReference ?? item.tally_reference ?? existing?.tally_reference ?? '';

    const sql = `
      INSERT INTO \`solar_payments\` (
        \`id\`, \`receipt_number\`, \`project_id\`, \`customer_id\`, \`customer_name\`,
        \`milestone\`, \`amount\`, \`status\`, \`due_date\`, \`paid_date\`,
        \`payment_mode\`, \`transaction_reference\`, \`notes\`,
        \`invoice_id\`, \`invoice_number\`, \`bank_account_id\`, \`journal_entry_id\`,
        \`tally_sync_status\`, \`tally_reference\`
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        \`customer_id\` = VALUES(\`customer_id\`), \`customer_name\` = VALUES(\`customer_name\`),
        \`project_id\` = VALUES(\`project_id\`), \`milestone\` = VALUES(\`milestone\`),
        \`amount\` = VALUES(\`amount\`), \`status\` = VALUES(\`status\`),
        \`due_date\` = VALUES(\`due_date\`), \`paid_date\` = VALUES(\`paid_date\`),
        \`payment_mode\` = VALUES(\`payment_mode\`), \`transaction_reference\` = VALUES(\`transaction_reference\`),
        \`notes\` = VALUES(\`notes\`), \`invoice_id\` = VALUES(\`invoice_id\`),
        \`invoice_number\` = VALUES(\`invoice_number\`), \`bank_account_id\` = VALUES(\`bank_account_id\`),
        \`journal_entry_id\` = VALUES(\`journal_entry_id\`), \`tally_sync_status\` = VALUES(\`tally_sync_status\`),
        \`tally_reference\` = VALUES(\`tally_reference\`)
    `;
    await this.pool!.query(sql, [
      id, receiptNumber, projectId, customerId, customerName,
      milestone, amount, status, dueDate, paidDate,
      paymentMode, txRef, notes,
      invoiceId, invoiceNumber, bankAccountId, journalEntryId,
      tallySyncStatus, tallyReference
    ]);

    const normalized = {
      ...item,
      id,
      receiptNumber,
      projectId,
      customerId,
      customerName,
      milestone,
      amount,
      status,
      dueDate: dueDate || '',
      paidDate: paidDate || '',
      paymentMode,
      transactionReference: txRef,
      notes,
      invoiceId,
      invoiceNumber,
      bankAccountId,
      journalEntryId,
      tallySyncStatus,
      tallyReference
    };
    const items = this.getFallbackItems('payments');
    const idx = items.findIndex(p => p.id === id);
    if (idx >= 0) items[idx] = { ...items[idx], ...normalized };
    else items.unshift(normalized);
    this.setFallbackItems('payments', items);
    return normalized;
  }

  public async deletePayment(id: string): Promise<boolean> {
    this.assertDbConnected();
    await this.pool!.query('DELETE FROM `solar_payments` WHERE `id` = ?', [id]);
    const items = this.getFallbackItems('payments').filter(p => p.id !== id);
    this.setFallbackItems('payments', items);
    return true;
  }

  // ==========================================================
  // CRUD: EXPENSES
  // ==========================================================
  public async getExpenses(): Promise<any[]> {
    if (!this.isConnected) return this.getFallbackItems('expenses');
    this.assertDbConnected();
    const [rows] = await this.pool!.query('SELECT * FROM `solar_expenses` ORDER BY `created_at` DESC');
    const formatDateOnly = (raw: any): string => {
      if (raw instanceof Date) {
        return `${raw.getFullYear()}-${String(raw.getMonth() + 1).padStart(2, '0')}-${String(raw.getDate()).padStart(2, '0')}`;
      }
      if (!raw) return '';
      const s = String(raw).trim();
      return s.includes('T') ? s.split('T')[0] : (s.length >= 10 ? s.slice(0, 10) : s);
    };
    const mapped = (rows as any[]).map(r => {
      const expDate = formatDateOnly(r.expense_date);
      return {
        id: r.id,
        expenseNumber: r.expense_number,
        projectId: r.project_id,
        projectCode: r.project_code,
        vendorName: r.vendor_name,
        category: r.category,
        amount: Number(r.amount) || 0,
        expenseDate: expDate,
        date: expDate,
        paymentMode: r.payment_mode,
        referenceNo: r.reference_no,
        notes: r.notes,
        receiptUrl: r.receipt_url,
        approvedBy: r.approved_by,
        expenseType: r.expense_type || 'DIRECT_EXPENSE',
        status: r.status || 'PAID',
        employeeId: r.employee_id || '',
        employeeName: r.employee_name || '',
        gstAmount: Number(r.gst_amount) || 0,
        itcEligible: Boolean(r.itc_eligible),
        bankAccountId: r.bank_account_id || '',
        expenseAccountId: r.expense_account_id || '',
        journalEntryId: r.journal_entry_id || '',
        approvedAt: r.approved_at || '',
        rejectionReason: r.rejection_reason || '',
        paidAt: r.paid_at || '',
        paidBy: r.paid_by || '',
        tallySyncStatus: r.tally_sync_status,
        createdAt: r.created_at
      };
    });
    this.setFallbackItems('expenses', mapped);
    return mapped;
  }

  public async saveExpense(item: any): Promise<any> {
    this.assertDbConnected();
    const id = item.id || `exp-${Date.now()}`;
    const existing = await this.getExistingRow('solar_expenses', id);
    const expDate = this.toSqlDate(item.expenseDate ?? item.date ?? item.expense_date ?? existing?.expense_date) || new Date().toISOString().split('T')[0];

    const expenseNumber = item.expenseNumber ?? item.expenseNo ?? item.expense_number ?? existing?.expense_number ?? id;
    const projectId = item.projectId ?? item.project_id ?? existing?.project_id ?? '';
    const projectCode = item.projectCode ?? item.project_code ?? existing?.project_code ?? '';
    const vendorName = item.vendorName ?? item.vendor ?? item.vendor_name ?? existing?.vendor_name ?? 'General Vendor';
    const category = item.category ?? item.expenseCategory ?? existing?.category ?? 'General';
    const amount = Number(item.amount ?? existing?.amount) || 0;
    const paymentMode = item.paymentMode ?? item.paymentMethod ?? item.payment_mode ?? existing?.payment_mode ?? 'Bank Payment';
    const referenceNo = item.referenceNo ?? item.referenceNumber ?? item.reference_no ?? existing?.reference_no ?? '';
    const notes = item.notes ?? existing?.notes ?? '';
    const receiptUrl = item.receiptUrl ?? item.receipt_url ?? existing?.receipt_url ?? '';
    const approvedBy = item.approvedBy ?? item.approved_by ?? existing?.approved_by ?? '';
    const expenseType = item.expenseType ?? item.expense_type ?? existing?.expense_type ?? 'DIRECT_EXPENSE';
    const status = item.status ?? existing?.status ?? 'PAID';
    const employeeId = item.employeeId ?? item.employee_id ?? existing?.employee_id ?? '';
    const employeeName = item.employeeName ?? item.employee_name ?? existing?.employee_name ?? '';
    const gstAmount = Number(item.gstAmount ?? item.gst_amount ?? existing?.gst_amount) || 0;
    const itcEligible = (item.itcEligible !== undefined ? item.itcEligible : (existing?.itc_eligible !== undefined ? Boolean(existing.itc_eligible) : false)) ? 1 : 0;
    const bankAccountId = item.bankAccountId ?? item.bank_account_id ?? existing?.bank_account_id ?? '';
    const expenseAccountId = item.expenseAccountId ?? item.expense_account_id ?? existing?.expense_account_id ?? '';
    const journalEntryId = item.journalEntryId ?? item.journal_entry_id ?? existing?.journal_entry_id ?? '';
    const approvedAt = item.approvedAt ?? item.approved_at ?? existing?.approved_at ?? null;
    const rejectionReason = item.rejectionReason ?? item.rejection_reason ?? existing?.rejection_reason ?? '';
    const paidAt = item.paidAt ?? item.paid_at ?? existing?.paid_at ?? null;
    const paidBy = item.paidBy ?? item.paid_by ?? existing?.paid_by ?? '';
    const tallySyncStatus = item.tallySyncStatus ?? item.tally_sync_status ?? existing?.tally_sync_status ?? 'NOT SYNCED';

    const sql = `
      INSERT INTO \`solar_expenses\` (
        \`id\`, \`expense_number\`, \`project_id\`, \`project_code\`, \`vendor_name\`,
        \`category\`, \`amount\`, \`expense_date\`, \`payment_mode\`, \`reference_no\`,
        \`notes\`, \`receipt_url\`, \`approved_by\`,
        \`expense_type\`, \`status\`, \`employee_id\`, \`employee_name\`, \`gst_amount\`, \`itc_eligible\`,
        \`bank_account_id\`, \`expense_account_id\`, \`journal_entry_id\`, \`approved_at\`, \`rejection_reason\`, \`paid_at\`, \`paid_by\`,
        \`tally_sync_status\`
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        \`project_id\` = VALUES(\`project_id\`), \`project_code\` = VALUES(\`project_code\`),
        \`vendor_name\` = VALUES(\`vendor_name\`), \`category\` = VALUES(\`category\`),
        \`amount\` = VALUES(\`amount\`), \`expense_date\` = VALUES(\`expense_date\`),
        \`payment_mode\` = VALUES(\`payment_mode\`), \`reference_no\` = VALUES(\`reference_no\`),
        \`notes\` = VALUES(\`notes\`), \`receipt_url\` = VALUES(\`receipt_url\`),
        \`approved_by\` = VALUES(\`approved_by\`), \`expense_type\` = VALUES(\`expense_type\`),
        \`status\` = VALUES(\`status\`), \`employee_id\` = VALUES(\`employee_id\`),
        \`employee_name\` = VALUES(\`employee_name\`), \`gst_amount\` = VALUES(\`gst_amount\`),
        \`itc_eligible\` = VALUES(\`itc_eligible\`), \`bank_account_id\` = VALUES(\`bank_account_id\`),
        \`expense_account_id\` = VALUES(\`expense_account_id\`), \`journal_entry_id\` = VALUES(\`journal_entry_id\`),
        \`approved_at\` = VALUES(\`approved_at\`), \`rejection_reason\` = VALUES(\`rejection_reason\`),
        \`paid_at\` = VALUES(\`paid_at\`), \`paid_by\` = VALUES(\`paid_by\`),
        \`tally_sync_status\` = VALUES(\`tally_sync_status\`)
    `;
    await this.pool!.query(sql, [
      id, expenseNumber, projectId, projectCode, vendorName,
      category, amount, expDate, paymentMode, referenceNo,
      notes, receiptUrl, approvedBy,
      expenseType, status, employeeId, employeeName, gstAmount, itcEligible,
      bankAccountId, expenseAccountId, journalEntryId, approvedAt, rejectionReason, paidAt, paidBy,
      tallySyncStatus
    ]);

    const normalized = {
      ...item,
      id,
      expenseNumber,
      projectId,
      projectCode,
      vendorName,
      category,
      amount,
      expenseDate: expDate,
      date: expDate,
      paymentMode,
      referenceNo,
      notes,
      receiptUrl,
      approvedBy,
      expenseType,
      status,
      employeeId,
      employeeName,
      gstAmount,
      itcEligible: Boolean(itcEligible),
      bankAccountId,
      expenseAccountId,
      journalEntryId,
      approvedAt: approvedAt || '',
      rejectionReason,
      paidAt: paidAt || '',
      paidBy,
      tallySyncStatus
    };
    const items = this.getFallbackItems('expenses');
    const idx = items.findIndex(e => e.id === id);
    if (idx >= 0) items[idx] = { ...items[idx], ...normalized };
    else items.unshift(normalized);
    this.setFallbackItems('expenses', items);
    return normalized;
  }

  public async deleteExpense(id: string): Promise<boolean> {
    this.assertDbConnected();
    await this.pool!.query('DELETE FROM `solar_expenses` WHERE `id` = ?', [id]);
    const items = this.getFallbackItems('expenses').filter(e => e.id !== id);
    this.setFallbackItems('expenses', items);
    return true;
  }

  // ==========================================================
  // CRUD: PRODUCTS (INVENTORY)
  // ==========================================================
  // ==========================================================
  // CRUD: PRODUCTS (INVENTORY)
  // ==========================================================
  public async getProducts(): Promise<any[]> {
    if (!this.isConnected) return this.getFallbackItems('products');
    this.assertDbConnected();
    const [rows] = await this.pool!.query('SELECT * FROM `solar_products` ORDER BY `created_at` DESC');
    const mapped = (rows as any[]).map(r => {
      let warehouseStocks: Record<string, number> = {};
      try {
        if (r.warehouse_stocks_json) warehouseStocks = JSON.parse(r.warehouse_stocks_json) || {};
      } catch {}
      const minStock = r.reorder_level != null ? Number(r.reorder_level) : 0;
      const gst = r.gst_rate != null ? Number(r.gst_rate) : 18;
      const unitPrice = r.unit_price != null ? Number(r.unit_price) : 0;
      const sellingPrice = r.selling_price != null ? Number(r.selling_price) : 0;
      return {
        id: r.id,
        name: r.name,
        sku: r.sku,
        itemCode: r.sku,
        category: r.category,
        brand: r.brand || '',
        model: r.model || '',
        specifications: r.specifications || '',
        specification: r.specifications || '',
        unit: r.unit || 'Nos',
        hsnCode: r.hsn_code || '',
        gstRate: gst,
        taxRate: gst,
        unitPrice,
        sellingPrice,
        currentStock: Number(r.current_stock ?? 0),
        reorderLevel: minStock,
        minStockLevel: minStock,
        minStockThreshold: minStock,
        location: r.location || r.warehouse_name || '',
        warehouseId: r.warehouse_id || '',
        warehouseName: r.warehouse_name || '',
        warehouseStocks,
        preferredVendorId: r.preferred_vendor_id || '',
        preferredVendorName: r.preferred_vendor_name || '',
        status: r.status || 'ACTIVE',
        createdAt: r.created_at,
        updatedAt: r.updated_at || r.created_at
      };
    });
    this.setFallbackItems('products', mapped);
    return mapped;
  }

  public async saveProduct(item: any): Promise<any> {
    this.assertDbConnected();
    const id = item.id || `prod-${Date.now()}`;
    const existing = await this.getExistingRow('solar_products', id);
    const name = item.name ?? existing?.name ?? 'Solar Product';
    const sku = item.sku ?? item.itemCode ?? existing?.sku ?? id;
    const category = item.category ?? existing?.category ?? 'Solar Panels';
    const brand = item.brand ?? existing?.brand ?? '';
    const model = item.model ?? existing?.model ?? '';
    const specifications = item.specification ?? item.specifications ?? existing?.specifications ?? '';
    const unit = item.unit ?? existing?.unit ?? 'Nos';
    const hsnCode = item.hsnCode ?? item.hsn_code ?? existing?.hsn_code ?? '';
    const providedGst = item.gstRate ?? item.taxRate ?? item.gst_rate ?? item.tax_rate;
    let gstRate: number;
    if (providedGst !== undefined && providedGst !== null && String(providedGst).trim() !== '') {
      const parsedGst = Number(providedGst);
      if (!Number.isFinite(parsedGst) || parsedGst < 0 || parsedGst > 100) {
        const err: any = new Error('GST Rate (%) must be a valid non-negative percentage between 0 and 100.');
        err.statusCode = 400;
        throw err;
      }
      gstRate = Math.round(parsedGst * 100) / 100;
    } else {
      gstRate = existing?.gst_rate != null ? Number(existing.gst_rate) : 18;
    }
    const rawUnitPrice = item.unitPrice ?? item.unit_price ?? existing?.unit_price;
    const unitPrice = rawUnitPrice != null ? Number(rawUnitPrice) : 0;
    const rawSellingPrice = item.sellingPrice ?? item.selling_price ?? existing?.selling_price;
    const sellingPrice = rawSellingPrice != null ? Number(rawSellingPrice) : unitPrice;
    const rawCurrentStock = item.currentStock ?? item.current_stock ?? existing?.current_stock;
    const currentStock = rawCurrentStock != null ? Number(rawCurrentStock) : 0;
    const rawReorder = item.minStockThreshold ?? item.reorderLevel ?? item.minStockLevel ?? item.reorder_level ?? existing?.reorder_level;
    const reorderLevel = rawReorder != null ? Number(rawReorder) : 10;
    const warehouseId = item.warehouseId ?? item.warehouse_id ?? existing?.warehouse_id ?? '';
    const warehouseName = item.warehouseName ?? item.warehouse_name ?? existing?.warehouse_name ?? '';
    const location = item.location ?? existing?.location ?? warehouseName ?? '';
    const preferredVendorId = item.preferredVendorId ?? item.preferred_vendor_id ?? existing?.preferred_vendor_id ?? '';
    const preferredVendorName = item.preferredVendorName ?? item.preferred_vendor_name ?? existing?.preferred_vendor_name ?? '';
    let existingStocks: Record<string, number> = {};
    try { if (existing?.warehouse_stocks_json) existingStocks = JSON.parse(existing.warehouse_stocks_json) || {}; } catch {}
    const warehouseStocks = (item.warehouseStocks && typeof item.warehouseStocks === 'object') ? item.warehouseStocks : existingStocks;
    const warehouseStocksJson = JSON.stringify(warehouseStocks);
    const status = item.status ?? existing?.status ?? 'ACTIVE';

    const sql = `
      INSERT INTO \`solar_products\` (
        \`id\`, \`name\`, \`sku\`, \`category\`, \`brand\`, \`model\`,
        \`specifications\`, \`unit\`, \`hsn_code\`, \`gst_rate\`,
        \`unit_price\`, \`selling_price\`, \`current_stock\`, \`reorder_level\`,
        \`location\`, \`warehouse_id\`, \`warehouse_name\`, \`warehouse_stocks_json\`,
        \`preferred_vendor_id\`, \`preferred_vendor_name\`, \`status\`
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        \`name\` = VALUES(\`name\`), \`sku\` = VALUES(\`sku\`),
        \`category\` = VALUES(\`category\`), \`brand\` = VALUES(\`brand\`),
        \`model\` = VALUES(\`model\`), \`specifications\` = VALUES(\`specifications\`),
        \`unit\` = VALUES(\`unit\`), \`hsn_code\` = VALUES(\`hsn_code\`),
        \`gst_rate\` = VALUES(\`gst_rate\`), \`unit_price\` = VALUES(\`unit_price\`),
        \`selling_price\` = VALUES(\`selling_price\`), \`current_stock\` = VALUES(\`current_stock\`),
        \`reorder_level\` = VALUES(\`reorder_level\`), \`location\` = VALUES(\`location\`),
        \`warehouse_id\` = VALUES(\`warehouse_id\`), \`warehouse_name\` = VALUES(\`warehouse_name\`),
        \`warehouse_stocks_json\` = VALUES(\`warehouse_stocks_json\`),
        \`preferred_vendor_id\` = VALUES(\`preferred_vendor_id\`),
        \`preferred_vendor_name\` = VALUES(\`preferred_vendor_name\`),
        \`status\` = VALUES(\`status\`)
    `;
    await this.pool!.query(sql, [
      id, name, sku, category, brand, model,
      specifications, unit, hsnCode, gstRate,
      unitPrice, sellingPrice, currentStock, reorderLevel,
      location, warehouseId, warehouseName, warehouseStocksJson,
      preferredVendorId, preferredVendorName, status
    ]);

    const saved = {
      ...item,
      id,
      name,
      sku,
      itemCode: sku,
      category,
      brand,
      model,
      specifications,
      specification: specifications,
      unit,
      hsnCode,
      gstRate,
      taxRate: gstRate,
      unitPrice,
      sellingPrice,
      currentStock,
      reorderLevel,
      minStockLevel: reorderLevel,
      minStockThreshold: reorderLevel,
      location,
      warehouseId,
      warehouseName,
      warehouseStocks,
      preferredVendorId,
      preferredVendorName,
      status,
      createdAt: item.createdAt || existing?.created_at || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const items = this.getFallbackItems('products');
    const idx = items.findIndex(p => p.id === id);
    if (idx >= 0) items[idx] = saved;
    else items.unshift(saved);
    this.setFallbackItems('products', items);
    return saved;
  }

  public async deleteProduct(id: string): Promise<boolean> {
    this.assertDbConnected();
    await this.pool!.query('DELETE FROM `solar_products` WHERE `id` = ?', [id]);
    const items = this.getFallbackItems('products').filter(p => p.id !== id);
    this.setFallbackItems('products', items);
    return true;
  }

  // ==========================================================
  // CRUD: VENDORS
  // ==========================================================
  public async getVendors(): Promise<any[]> {
    if (!this.isConnected) return this.getFallbackItems('vendors');
    this.assertDbConnected();
    const [rows] = await this.pool!.query('SELECT * FROM `solar_vendors` ORDER BY `created_at` DESC');
    const mapped = (rows as any[]).map(r => {
      let cats: string[] = [];
      try { if (r.categories_json) cats = JSON.parse(r.categories_json) || []; } catch {}
      let bankDetails: any = undefined;
      try { if (r.bank_details_json) bankDetails = JSON.parse(r.bank_details_json); } catch {}
      const category = cats[0] || 'Solar Modules';
      return {
        id: r.id,
        name: r.name,
        vendorCode: r.vendor_code,
        contactPerson: r.contact_person || '',
        phone: r.phone || '',
        email: r.email || '',
        address: r.address || '',
        city: r.city || '',
        state: r.state || '',
        gstNumber: r.gst_number || '',
        panNumber: r.pan_number || '',
        paymentTerms: r.payment_terms || '30 Days',
        rating: r.rating != null ? Number(r.rating) : 4.5,
        category,
        categories: cats.length > 0 ? cats : [category],
        bankDetails,
        status: r.status || 'ACTIVE',
        createdAt: r.created_at,
        updatedAt: r.updated_at || r.created_at
      };
    });
    this.setFallbackItems('vendors', mapped);
    return mapped;
  }

  public async saveVendor(item: any): Promise<any> {
    this.assertDbConnected();
    const id = item.id || `ven-${Date.now()}`;
    const existing = await this.getExistingRow('solar_vendors', id);
    const name = item.name ?? existing?.name ?? 'Solar Vendor';
    const vendorCode = item.vendorCode ?? item.vendor_code ?? existing?.vendor_code ?? id;
    const contactPerson = item.contactPerson ?? item.contact_person ?? existing?.contact_person ?? '';
    const phone = item.phone ?? existing?.phone ?? '';
    const email = item.email ?? existing?.email ?? '';
    const address = item.address ?? existing?.address ?? '';
    const city = item.city ?? existing?.city ?? '';
    const state = item.state ?? existing?.state ?? '';
    const gstNumber = item.gstNumber ?? item.gst_number ?? existing?.gst_number ?? '';
    const panNumber = item.panNumber ?? item.pan_number ?? existing?.pan_number ?? '';
    const paymentTerms = item.paymentTerms ?? item.payment_terms ?? existing?.payment_terms ?? '30 Days';
    const rating = item.rating != null ? Number(item.rating) : (existing?.rating != null ? Number(existing.rating) : 4.5);

    let existingCats: string[] = [];
    try { if (existing?.categories_json) existingCats = JSON.parse(existing.categories_json) || []; } catch {}
    let categories: string[] = [];
    if (Array.isArray(item.categories) && item.categories.length > 0) {
      categories = item.categories.map((c: any) => String(c).trim()).filter(Boolean);
    } else if (item.category) {
      categories = [String(item.category).trim()];
    } else if (typeof item.categoriesJson === 'string') {
      try { categories = JSON.parse(item.categoriesJson) || []; } catch {}
    } else {
      categories = existingCats;
    }
    if (categories.length === 0) categories = ['Solar Modules'];
    if (item.category && !categories.includes(String(item.category).trim())) {
      categories = [String(item.category).trim(), ...categories];
    }
    const categoriesJson = JSON.stringify(categories);
    const category = item.category || categories[0] || 'Solar Modules';

    let existingBank: any = undefined;
    try { if (existing?.bank_details_json) existingBank = JSON.parse(existing.bank_details_json); } catch {}
    const bankDetails = item.bankDetails !== undefined ? item.bankDetails : existingBank;
    const bankDetailsJson = bankDetails ? JSON.stringify(bankDetails) : null;
    const status = item.status ?? existing?.status ?? 'ACTIVE';

    const sql = `
      INSERT INTO \`solar_vendors\` (
        \`id\`, \`name\`, \`vendor_code\`, \`contact_person\`, \`phone\`, \`email\`,
        \`address\`, \`city\`, \`state\`, \`gst_number\`, \`pan_number\`,
        \`payment_terms\`, \`rating\`, \`categories_json\`, \`bank_details_json\`, \`status\`
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        \`name\` = VALUES(\`name\`), \`vendor_code\` = VALUES(\`vendor_code\`),
        \`contact_person\` = VALUES(\`contact_person\`), \`phone\` = VALUES(\`phone\`),
        \`email\` = VALUES(\`email\`), \`address\` = VALUES(\`address\`),
        \`city\` = VALUES(\`city\`), \`state\` = VALUES(\`state\`),
        \`gst_number\` = VALUES(\`gst_number\`), \`pan_number\` = VALUES(\`pan_number\`),
        \`payment_terms\` = VALUES(\`payment_terms\`), \`rating\` = VALUES(\`rating\`),
        \`categories_json\` = VALUES(\`categories_json\`), \`bank_details_json\` = VALUES(\`bank_details_json\`),
        \`status\` = VALUES(\`status\`)
    `;
    await this.pool!.query(sql, [
      id, name, vendorCode, contactPerson, phone, email,
      address, city, state, gstNumber, panNumber,
      paymentTerms, rating, categoriesJson, bankDetailsJson, status
    ]);

    const saved = {
      ...item,
      id,
      name,
      vendorCode,
      contactPerson,
      phone,
      email,
      address,
      city,
      state,
      gstNumber,
      panNumber,
      paymentTerms,
      rating,
      category,
      categories,
      bankDetails,
      status,
      createdAt: item.createdAt || existing?.created_at || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const items = this.getFallbackItems('vendors');
    const idx = items.findIndex(v => v.id === id);
    if (idx >= 0) items[idx] = saved;
    else items.unshift(saved);
    this.setFallbackItems('vendors', items);
    return saved;
  }

  public async deleteVendor(id: string): Promise<boolean> {
    this.assertDbConnected();
    await this.pool!.query('DELETE FROM `solar_vendors` WHERE `id` = ?', [id]);
    const items = this.getFallbackItems('vendors').filter(v => v.id !== id);
    this.setFallbackItems('vendors', items);
    return true;
  }

  private mapVendorBillsFromRow(r: any): {
    vendorBills: any[];
    vendorBillUrl: string;
    vendorBillName: string;
    vendorBillMimeType: string;
    vendorBillSize: number;
    vendorBillUploadedAt: string;
  } {
    let bills: any[] = [];
    if (r?.vendor_bills_json) {
      try {
        const parsed = JSON.parse(r.vendor_bills_json);
        if (Array.isArray(parsed)) {
          bills = parsed
            .filter((b: any) => b && b.fileUrl)
            .map((b: any) => ({
              id: String(b.id || `bill-${Date.now()}`),
              fileName: String(b.fileName || 'vendor-bill'),
              fileUrl: String(b.fileUrl),
              filePath: String(b.filePath || ''),
              mimeType: String(b.mimeType || 'application/pdf'),
              fileSize: Number(b.fileSize || 0),
              uploadedAt: String(b.uploadedAt || new Date().toISOString()),
              uploadedBy: String(b.uploadedBy || '')
            }));
        }
      } catch {
        bills = [];
      }
    }
    if (bills.length === 0 && r?.vendor_bill_url) {
      bills.push({
        id: `bill-primary-${String(r.id || 'po').replace(/[^a-zA-Z0-9_-]/g, '')}`,
        fileName: String(r.vendor_bill_name || 'Vendor Bill'),
        fileUrl: String(r.vendor_bill_url),
        filePath: '',
        mimeType: String(r.vendor_bill_mime || 'application/pdf'),
        fileSize: Number(r.vendor_bill_size || 0),
        uploadedAt: String(r.vendor_bill_uploaded_at || r.updated_at || new Date().toISOString()),
        uploadedBy: ''
      });
    }
    const primary = bills[0] || null;
    return {
      vendorBills: bills,
      vendorBillUrl: primary ? primary.fileUrl : String(r?.vendor_bill_url || ''),
      vendorBillName: primary ? primary.fileName : String(r?.vendor_bill_name || ''),
      vendorBillMimeType: primary ? primary.mimeType : String(r?.vendor_bill_mime || ''),
      vendorBillSize: primary ? Number(primary.fileSize || 0) : Number(r?.vendor_bill_size || 0),
      vendorBillUploadedAt: primary ? primary.uploadedAt : String(r?.vendor_bill_uploaded_at || '')
    };
  }

  public async getPurchaseOrders(): Promise<any[]> {
    if (!this.isConnected) return this.getFallbackItems('purchase_orders');
    this.assertDbConnected();
    const [rows] = await this.pool!.query('SELECT * FROM `solar_purchase_orders` ORDER BY `created_at` DESC');
    const [bankRows]: any = await this.pool!.query('SELECT `id`, `account_name` FROM `solar_acc_bank_accounts`').catch(() => [[]]);
    const bankMap = new Map<string, string>((bankRows || []).map((b: any) => [b.id, b.account_name]));
    const mapped = (rows as any[]).map(r => {
      const poDate = this.toSqlDate(r.po_date) || '';
      const expDate = this.toSqlDate(r.expected_delivery_date) || '';
      const payDue = this.toSqlDate(r.payment_due_date) || undefined;
      const recDate = this.toSqlDate(r.received_date) || undefined;
      const receipts = r.receipts_json ? JSON.parse(r.receipts_json) : [];
      const totalAmount = roundCurrency(Number(r.total_amount) || 0);
      const paidAmount = roundCurrency(Number(r.paid_amount) || 0);
      const returnedAmount = roundCurrency(Number(r.returned_amount) || 0);
      const refundedAmount = roundCurrency(Number(r.refunded_amount) || 0);
      const netPaid = roundCurrency(Math.max(0, paidAmount - refundedAmount));
      const balanceAmount = roundCurrency(
        r.balance_amount !== undefined && r.balance_amount !== null && (paidAmount > 0 || returnedAmount > 0 || Number(r.balance_amount) > 0)
          ? Math.max(0, Number(r.balance_amount))
          : (String(r.payment_status || '').toUpperCase() === 'PAID' ? 0 : Math.max(0, totalAmount - returnedAmount - netPaid))
      );
      const billMeta = this.mapVendorBillsFromRow(r);
      return {
        id: r.id,
        purchaseNumber: r.po_number,
        poNumber: r.po_number,
        vendorId: r.vendor_id,
        vendorName: r.vendor_name,
        projectId: r.project_id || '',
        projectTitle: r.project_title || '',
        warehouseId: r.warehouse_id || '',
        warehouseName: r.warehouse_name || '',
        purchaseDate: poDate,
        orderDate: poDate,
        poDate,
        expectedDeliveryDate: expDate,
        paymentDueDate: payDue,
        invoiceReference: r.invoice_reference || '',
        stockUpdated: Boolean(r.stock_updated),
        receivedDate: recDate,
        subtotal: Number(r.subtotal) || 0,
        gstAmount: Number(r.gst_amount) || 0,
        taxAmount: Number(r.gst_amount) || 0,
        totalAmount,
        grandTotal: totalAmount,
        paidAmount,
        returnedAmount,
        refundedAmount,
        balanceAmount,
        bankAccountId: r.bank_account_id || '',
        bankAccountName: r.bank_account_id ? (bankMap.get(r.bank_account_id) || '') : '',
        status: r.status || 'ISSUED',
        paymentStatus: r.payment_status || 'PENDING',
        items: r.items_json ? JSON.parse(r.items_json) : [],
        deliveryReceipts: receipts,
        receipts,
        vendorBills: billMeta.vendorBills,
        vendorBillUrl: billMeta.vendorBillUrl,
        vendorBillName: billMeta.vendorBillName,
        vendorBillMimeType: billMeta.vendorBillMimeType,
        vendorBillSize: billMeta.vendorBillSize,
        vendorBillUploadedAt: billMeta.vendorBillUploadedAt,
        notes: r.notes || '',
        createdAt: r.created_at,
        updatedAt: r.updated_at || r.created_at
      };
    });
    this.setFallbackItems('purchase_orders', mapped);
    return mapped;
  }

  public async savePurchaseOrder(item: any, actor?: any): Promise<any> {
    this.assertDbConnected();
    const id = item.id || `po-${Date.now()}`;
    const existing = await this.getExistingRow('solar_purchase_orders', id);
    const poNumber = item.purchaseNumber ?? item.poNumber ?? item.po_number ?? existing?.po_number ?? id;
    const vendorId = item.vendorId ?? item.vendor_id ?? existing?.vendor_id ?? '';
    const vendorName = item.vendorName ?? item.vendor_name ?? existing?.vendor_name ?? 'Vendor';
    const rawDate = item.purchaseDate ?? item.poDate ?? item.orderDate ?? item.po_date ?? item.order_date ?? existing?.po_date;
    const poDate = this.toSqlDate(rawDate) ?? new Date().toISOString().split('T')[0];
    const rawExp = item.expectedDeliveryDate ?? item.expected_delivery_date ?? existing?.expected_delivery_date;
    const expectedDeliveryDate = this.toSqlDate(rawExp);
    const projectId = item.projectId ?? item.project_id ?? existing?.project_id ?? '';
    const projectTitle = item.projectTitle ?? item.project_title ?? existing?.project_title ?? '';
    const warehouseId = item.warehouseId ?? item.warehouse_id ?? existing?.warehouse_id ?? '';
    const warehouseName = item.warehouseName ?? item.warehouse_name ?? existing?.warehouse_name ?? '';
    const rawPayDue = item.paymentDueDate ?? item.payment_due_date ?? existing?.payment_due_date;
    const paymentDueDate = this.toSqlDate(rawPayDue);
    const invoiceReference = item.invoiceReference ?? item.invoice_reference ?? existing?.invoice_reference ?? '';
    const stockUpdated = (item.stockUpdated !== undefined ? item.stockUpdated : Boolean(existing?.stock_updated)) ? 1 : 0;
    const rawRecDate = item.receivedDate ?? item.received_date ?? existing?.received_date;
    const receivedDate = this.toSqlDate(rawRecDate);
    const rawItems = item.items ?? (existing?.items_json ? JSON.parse(existing.items_json) : []);
    const itemsArr = typeof rawItems === 'string' ? JSON.parse(rawItems) : rawItems;
    const itemsJson = typeof rawItems === 'string' ? rawItems : JSON.stringify(rawItems);
    const subtotal = roundCurrency(Number(item.subtotal ?? existing?.subtotal) || 0);
    const gstAmount = roundCurrency(Number(item.taxAmount ?? item.gstAmount ?? item.gst_amount ?? existing?.gst_amount) || 0);
    const totalAmount = roundCurrency(Number(item.totalAmount ?? item.grandTotal ?? item.total_amount ?? existing?.total_amount) || (subtotal + gstAmount));
    const status = item.status ?? existing?.status ?? 'ISSUED';
    const returnedAmount = roundCurrency(Number(existing?.returned_amount ?? item.returnedAmount ?? 0) || 0);
    const refundedAmount = roundCurrency(Number(existing?.refunded_amount ?? item.refundedAmount ?? 0) || 0);
    const existingPaid = roundCurrency(Number(existing?.paid_amount || 0));
    const requestedPayStatus = String(item.paymentStatus ?? item.payment_status ?? existing?.payment_status ?? 'PENDING').toUpperCase();
    const rawReqPaid = Number(item.paidAmount ?? (requestedPayStatus === 'PAID' ? totalAmount : 0)) || 0;
    const initialPayToRecord = !existing && status !== 'CANCELLED' && status !== 'DRAFT' && rawReqPaid > 0.01
      ? roundCurrency(Math.min(totalAmount, rawReqPaid))
      : 0;
    const storedPaid = existing ? existingPaid : 0;
    const netPaid = roundCurrency(Math.max(0, storedPaid - refundedAmount));
    const balanceAmount = roundCurrency(Math.max(0, totalAmount - returnedAmount - netPaid));
    const paymentStatus = totalAmount > 0 && balanceAmount <= 0.01
      ? 'PAID'
      : (netPaid > 0.01 ? 'PARTIALLY_PAID' : 'PENDING');
    const bankAccountId = String(item.bankAccountId ?? existing?.bank_account_id ?? '').trim();
    const rawReceipts = item.deliveryReceipts ?? item.receipts ?? (existing?.receipts_json ? JSON.parse(existing.receipts_json) : []);
    const receiptsArr = typeof rawReceipts === 'string' ? JSON.parse(rawReceipts) : rawReceipts;
    const receiptsJson = typeof rawReceipts === 'string' ? rawReceipts : JSON.stringify(rawReceipts);
    const notes = item.notes ?? existing?.notes ?? '';

    let vendorBills: any[] = [];
    if (Array.isArray(item.vendorBills)) {
      vendorBills = item.vendorBills.filter((b: any) => b && b.fileUrl);
    } else if (existing) {
      vendorBills = this.mapVendorBillsFromRow(existing).vendorBills;
    }
    if (vendorBills.length === 0 && item.vendorBillUrl) {
      vendorBills.push({
        id: `bill-primary-${String(id).replace(/[^a-zA-Z0-9_-]/g, '')}`,
        fileName: String(item.vendorBillName || 'Vendor Bill'),
        fileUrl: String(item.vendorBillUrl),
        filePath: '',
        mimeType: String(item.vendorBillMimeType || 'application/pdf'),
        fileSize: Number(item.vendorBillSize || 0),
        uploadedAt: String(item.vendorBillUploadedAt || new Date().toISOString()),
        uploadedBy: String(actor?.name || '')
      });
    }
    const primaryBill = vendorBills[0] || null;
    const vendorBillsJson = JSON.stringify(vendorBills);
    const vendorBillUrl = primaryBill ? String(primaryBill.fileUrl) : (Array.isArray(item.vendorBills) ? '' : String(existing?.vendor_bill_url || ''));
    const vendorBillName = primaryBill ? String(primaryBill.fileName) : (Array.isArray(item.vendorBills) ? '' : String(existing?.vendor_bill_name || ''));
    const vendorBillMime = primaryBill ? String(primaryBill.mimeType) : (Array.isArray(item.vendorBills) ? '' : String(existing?.vendor_bill_mime || ''));
    const vendorBillSize = primaryBill ? Number(primaryBill.fileSize || 0) : (Array.isArray(item.vendorBills) ? 0 : Number(existing?.vendor_bill_size || 0));
    const vendorBillUploadedAt = primaryBill ? String(primaryBill.uploadedAt || '') : (Array.isArray(item.vendorBills) ? '' : String(existing?.vendor_bill_uploaded_at || ''));

    const sql = `
      INSERT INTO \`solar_purchase_orders\` (
        \`id\`, \`po_number\`, \`vendor_id\`, \`vendor_name\`, \`po_date\`,
        \`expected_delivery_date\`, \`project_id\`, \`project_title\`,
        \`warehouse_id\`, \`warehouse_name\`, \`payment_due_date\`,
        \`invoice_reference\`, \`stock_updated\`, \`received_date\`,
        \`items_json\`, \`subtotal\`, \`gst_amount\`, \`total_amount\`,
        \`paid_amount\`, \`returned_amount\`, \`refunded_amount\`, \`balance_amount\`, \`bank_account_id\`,
        \`status\`, \`payment_status\`, \`receipts_json\`,
        \`vendor_bills_json\`, \`vendor_bill_url\`, \`vendor_bill_name\`, \`vendor_bill_mime\`, \`vendor_bill_size\`, \`vendor_bill_uploaded_at\`,
        \`notes\`
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        \`po_number\` = VALUES(\`po_number\`), \`vendor_id\` = VALUES(\`vendor_id\`),
        \`vendor_name\` = VALUES(\`vendor_name\`), \`po_date\` = VALUES(\`po_date\`),
        \`expected_delivery_date\` = VALUES(\`expected_delivery_date\`),
        \`project_id\` = VALUES(\`project_id\`), \`project_title\` = VALUES(\`project_title\`),
        \`warehouse_id\` = VALUES(\`warehouse_id\`), \`warehouse_name\` = VALUES(\`warehouse_name\`),
        \`payment_due_date\` = VALUES(\`payment_due_date\`), \`invoice_reference\` = VALUES(\`invoice_reference\`),
        \`stock_updated\` = VALUES(\`stock_updated\`), \`received_date\` = VALUES(\`received_date\`),
        \`items_json\` = VALUES(\`items_json\`), \`subtotal\` = VALUES(\`subtotal\`),
        \`gst_amount\` = VALUES(\`gst_amount\`), \`total_amount\` = VALUES(\`total_amount\`),
        \`paid_amount\` = VALUES(\`paid_amount\`), \`returned_amount\` = VALUES(\`returned_amount\`),
        \`refunded_amount\` = VALUES(\`refunded_amount\`), \`balance_amount\` = VALUES(\`balance_amount\`),
        \`bank_account_id\` = VALUES(\`bank_account_id\`),
        \`status\` = VALUES(\`status\`), \`payment_status\` = VALUES(\`payment_status\`),
        \`receipts_json\` = VALUES(\`receipts_json\`),
        \`vendor_bills_json\` = VALUES(\`vendor_bills_json\`),
        \`vendor_bill_url\` = VALUES(\`vendor_bill_url\`),
        \`vendor_bill_name\` = VALUES(\`vendor_bill_name\`),
        \`vendor_bill_mime\` = VALUES(\`vendor_bill_mime\`),
        \`vendor_bill_size\` = VALUES(\`vendor_bill_size\`),
        \`vendor_bill_uploaded_at\` = VALUES(\`vendor_bill_uploaded_at\`),
        \`notes\` = VALUES(\`notes\`)
    `;
    await this.pool!.query(sql, [
      id, poNumber, vendorId, vendorName, poDate,
      expectedDeliveryDate, projectId, projectTitle,
      warehouseId, warehouseName, paymentDueDate,
      invoiceReference, stockUpdated, receivedDate,
      itemsJson, subtotal, gstAmount, totalAmount,
      storedPaid, returnedAmount, refundedAmount, balanceAmount, bankAccountId,
      status, paymentStatus, receiptsJson,
      vendorBillsJson, vendorBillUrl, vendorBillName, vendorBillMime, vendorBillSize, vendorBillUploadedAt,
      notes
    ]);

    if (initialPayToRecord > 0.01) {
      const effectiveBankId = await accountingService.resolveBankAccountIdOrPrimary(this.pool!, bankAccountId, item.paymentMode);
      if (!effectiveBankId) {
        const err: any = new Error('Please configure or select an active Cash/Bank account to record this PO payment.');
        err.statusCode = 400;
        throw err;
      }
      await accountingService.recordPurchaseOrderPayment(
        this.pool!,
        id,
        {
          amount: initialPayToRecord,
          tdsDeducted: Number(item.tdsDeducted || 0),
          tdsSection: item.tdsSection || '194C',
          paymentDate: poDate,
          paymentMode: item.paymentMode || 'Bank NEFT/RTGS',
          bankAccountId: effectiveBankId,
          referenceNo: item.referenceNo || '',
          notes: 'Initial payment recorded on Purchase Order creation'
        },
        actor
      );
      const fresh = (await this.getPurchaseOrders()).find(p => p.id === id);
      if (fresh) return fresh;
    }

    const saved = {
      ...item,
      id,
      purchaseNumber: poNumber,
      poNumber,
      vendorId,
      vendorName,
      purchaseDate: poDate,
      poDate,
      orderDate: poDate,
      expectedDeliveryDate: expectedDeliveryDate || '',
      projectId,
      projectTitle,
      warehouseId,
      warehouseName,
      paymentDueDate: paymentDueDate || undefined,
      invoiceReference,
      stockUpdated: Boolean(stockUpdated),
      receivedDate: receivedDate || undefined,
      items: itemsArr,
      subtotal,
      taxAmount: gstAmount,
      gstAmount,
      totalAmount,
      grandTotal: totalAmount,
      paidAmount: storedPaid,
      returnedAmount,
      refundedAmount,
      balanceAmount,
      bankAccountId,
      status,
      paymentStatus,
      deliveryReceipts: receiptsArr,
      receipts: receiptsArr,
      vendorBills,
      vendorBillUrl,
      vendorBillName,
      vendorBillMimeType: vendorBillMime,
      vendorBillSize,
      vendorBillUploadedAt,
      notes,
      createdAt: item.createdAt || existing?.created_at || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const items = this.getFallbackItems('purchase_orders');
    const idx = items.findIndex(p => p.id === id);
    if (idx >= 0) items[idx] = saved;
    else items.unshift(saved);
    this.setFallbackItems('purchase_orders', items);
    return saved;
  }

  public async attachBillToPurchaseOrder(poId: string, bill: any): Promise<any[]> {
    this.assertDbConnected();
    const conn = await this.pool!.getConnection();
    try {
      await conn.beginTransaction();
      const [rows]: any = await conn.query('SELECT * FROM `solar_purchase_orders` WHERE `id` = ? LIMIT 1 FOR UPDATE', [poId]);
      if (!rows || rows.length === 0) {
        await conn.commit();
        return [bill];
      }
      const existingBills = this.mapVendorBillsFromRow(rows[0]).vendorBills;
      const allBills = [...existingBills, bill];
      const primary = allBills[0];
      await conn.query(
        'UPDATE `solar_purchase_orders` SET `vendor_bills_json` = ?, `vendor_bill_url` = ?, `vendor_bill_name` = ?, `vendor_bill_mime` = ?, `vendor_bill_size` = ?, `vendor_bill_uploaded_at` = ? WHERE `id` = ?',
        [JSON.stringify(allBills), primary.fileUrl, primary.fileName, primary.mimeType, Number(primary.fileSize || 0), primary.uploadedAt, poId]
      );
      await conn.commit();
      return allBills;
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }

  public async removeBillFromPurchaseOrder(poId: string, billId: string): Promise<{ removedBill: any | null; vendorBills: any[] }> {
    this.assertDbConnected();
    const conn = await this.pool!.getConnection();
    try {
      await conn.beginTransaction();
      const [rows]: any = await conn.query('SELECT * FROM `solar_purchase_orders` WHERE `id` = ? LIMIT 1 FOR UPDATE', [poId]);
      if (!rows || rows.length === 0) {
        await conn.commit();
        return { removedBill: null, vendorBills: [] };
      }
      const existingBills = this.mapVendorBillsFromRow(rows[0]).vendorBills;
      let removedBill: any = null;
      const nextBills = existingBills.filter(b => {
        if (b.id === billId) {
          removedBill = b;
          return false;
        }
        return true;
      });
      const primary = nextBills[0] || null;
      await conn.query(
        'UPDATE `solar_purchase_orders` SET `vendor_bills_json` = ?, `vendor_bill_url` = ?, `vendor_bill_name` = ?, `vendor_bill_mime` = ?, `vendor_bill_size` = ?, `vendor_bill_uploaded_at` = ? WHERE `id` = ?',
        [
          JSON.stringify(nextBills),
          primary ? primary.fileUrl : '',
          primary ? primary.fileName : '',
          primary ? primary.mimeType : '',
          primary ? Number(primary.fileSize || 0) : 0,
          primary ? primary.uploadedAt : '',
          poId
        ]
      );
      await conn.commit();
      return { removedBill, vendorBills: nextBills };
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }

  public async deletePurchaseOrder(id: string): Promise<boolean> {
    this.assertDbConnected();
    const [prRows]: any = await this.pool!.query('SELECT COUNT(*) AS cnt FROM `solar_purchase_returns` WHERE `purchase_order_id` = ?', [id]).catch(() => [[{ cnt: 0 }]]);
    if (Number(prRows?.[0]?.cnt || 0) > 0) {
      const err: any = new Error('Cannot delete Purchase Order with Purchase Returns recorded. Reverse/delete the Purchase Returns first.');
      err.statusCode = 400;
      throw err;
    }
    const [vbRows]: any = await this.pool!.query('SELECT * FROM `solar_acc_vendor_bills` WHERE `po_id` = ? LIMIT 1', [id]).catch(() => [[]]);
    if (vbRows?.[0]) {
      const [vpRows]: any = await this.pool!.query('SELECT COUNT(*) AS cnt FROM `solar_acc_vendor_payments` WHERE `bill_id` = ?', [vbRows[0].id]).catch(() => [[{ cnt: 0 }]]);
      if (Number(vbRows[0].paid_amount || 0) > 0 || Number(vpRows?.[0]?.cnt || 0) > 0) {
        const err: any = new Error('Cannot delete Purchase Order with vendor payments recorded. Reverse vendor payments first.');
        err.statusCode = 400;
        throw err;
      }
      if (vbRows[0].journal_entry_id) {
        await this.pool!.query('DELETE FROM `solar_acc_journal_entries` WHERE `id` = ?', [vbRows[0].journal_entry_id]).catch(() => {});
        await accountingService.recalculateAccountBalances(this.pool!).catch(() => {});
      }
      await this.pool!.query('DELETE FROM `solar_acc_vendor_bills` WHERE `id` = ?', [vbRows[0].id]).catch(() => {});
    }
    const exPo = await this.getExistingRow('solar_purchase_orders', id).catch(() => null);
    if (exPo) {
      const billInfo = this.mapVendorBillsFromRow(exPo);
      for (const b of billInfo.vendorBills) {
        if (b?.filePath) {
          const uploadsBase = path.resolve(process.cwd(), 'uploads');
          const resolved = path.resolve(uploadsBase, b.filePath);
          if (resolved.startsWith(uploadsBase + path.sep) && fs.existsSync(resolved)) {
            try { fs.unlinkSync(resolved); } catch {}
          }
        }
      }
    }
    await this.pool!.query('DELETE FROM `solar_purchase_orders` WHERE `id` = ?', [id]);
    const items = this.getFallbackItems('purchase_orders').filter(p => p.id !== id);
    this.setFallbackItems('purchase_orders', items);
    return true;
  }

  // ==========================================================
  // CRUD: BILL OF MATERIALS (BOM)
  // ==========================================================
  public async getBOMs(): Promise<any[]> {
    if (!this.isConnected) return this.getFallbackItems('boms');
    this.assertDbConnected();
    const [rows] = await this.pool!.query('SELECT * FROM `solar_boms` ORDER BY `created_at` DESC');
    const mapped = (rows as any[]).map(r => {
      const cap = Number(r.system_capacity_kw) || 0;
      const cost = Number(r.total_estimated_cost) || 0;
      return {
        id: r.id,
        bomNumber: r.bom_number,
        projectId: r.project_id,
        projectCode: r.project_code || '',
        projectTitle: r.project_title,
        customerName: r.customer_name || '',
        capacityKw: cap,
        systemCapacityKw: cap,
        version: r.version || '1.0',
        status: r.status || 'APPROVED',
        warehouseId: r.warehouse_id || '',
        warehouseName: r.warehouse_name || '',
        stockAllocated: Boolean(r.stock_allocated),
        ewayBillNumber: r.eway_bill_number || '',
        ewayBillDate: r.eway_bill_date || '',
        items: r.items_json ? JSON.parse(r.items_json) : [],
        totalCost: cost,
        totalEstimatedCost: cost,
        createdBy: r.created_by || '',
        approvedBy: r.approved_by || '',
        approvedAt: r.approved_at || undefined,
        notes: r.notes || '',
        createdAt: r.created_at,
        updatedAt: r.updated_at || r.created_at
      };
    });
    this.setFallbackItems('boms', mapped);
    return mapped;
  }

  public async saveBOM(item: any): Promise<any> {
    this.assertDbConnected();
    const id = item.id || `bom-${Date.now()}`;
    const existing = await this.getExistingRow('solar_boms', id);
    const bomNumber = item.bomNumber ?? item.bom_number ?? existing?.bom_number ?? id;
    const projectId = item.projectId ?? item.project_id ?? existing?.project_id ?? '';
    const projectCode = item.projectCode ?? item.project_code ?? existing?.project_code ?? '';
    const projectTitle = item.projectTitle ?? item.project_title ?? item.title ?? existing?.project_title ?? 'Solar Project Installation';
    const customerName = item.customerName ?? item.customer_name ?? existing?.customer_name ?? '';
    const systemCapacityKw = Number(item.capacityKw ?? item.systemCapacityKw ?? item.system_capacity_kw ?? existing?.system_capacity_kw) || 0;
    const version = item.version ?? existing?.version ?? '1.0';
    const status = item.status ?? existing?.status ?? 'APPROVED';
    const warehouseId = item.warehouseId ?? item.warehouse_id ?? existing?.warehouse_id ?? '';
    const warehouseName = item.warehouseName ?? item.warehouse_name ?? existing?.warehouse_name ?? '';
    const stockAllocated = (item.stockAllocated !== undefined ? item.stockAllocated : Boolean(existing?.stock_allocated)) ? 1 : 0;
    const ewayBillNumber = item.ewayBillNumber ?? item.eway_bill_number ?? existing?.eway_bill_number ?? '';
    const ewayBillDate = item.ewayBillDate ?? item.eway_bill_date ?? existing?.eway_bill_date ?? '';
    const rawItems = item.items ?? (existing?.items_json ? JSON.parse(existing.items_json) : []);
    const itemsArr = typeof rawItems === 'string' ? JSON.parse(rawItems) : rawItems;
    const itemsJson = typeof rawItems === 'string' ? rawItems : JSON.stringify(rawItems);
    const totalEstimatedCost = Number(item.totalCost ?? item.totalEstimatedCost ?? item.total_estimated_cost ?? existing?.total_estimated_cost) || 0;
    const createdBy = item.createdBy ?? item.created_by ?? existing?.created_by ?? '';
    const approvedBy = item.approvedBy ?? item.approved_by ?? existing?.approved_by ?? '';
    const approvedAt = (item.approvedAt || existing?.approved_at) ? this.toSqlDateTime(item.approvedAt || existing?.approved_at) : null;
    const notes = item.notes ?? existing?.notes ?? '';

    const sql = `
      INSERT INTO \`solar_boms\` (
        \`id\`, \`bom_number\`, \`project_id\`, \`project_code\`, \`project_title\`, \`customer_name\`,
        \`system_capacity_kw\`, \`version\`, \`status\`, \`warehouse_id\`, \`warehouse_name\`,
        \`stock_allocated\`, \`eway_bill_number\`, \`eway_bill_date\`,
        \`items_json\`, \`total_estimated_cost\`, \`created_by\`, \`approved_by\`, \`approved_at\`, \`notes\`
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        \`bom_number\` = VALUES(\`bom_number\`), \`project_id\` = VALUES(\`project_id\`),
        \`project_code\` = VALUES(\`project_code\`), \`project_title\` = VALUES(\`project_title\`),
        \`customer_name\` = VALUES(\`customer_name\`), \`system_capacity_kw\` = VALUES(\`system_capacity_kw\`),
        \`version\` = VALUES(\`version\`), \`status\` = VALUES(\`status\`),
        \`warehouse_id\` = VALUES(\`warehouse_id\`), \`warehouse_name\` = VALUES(\`warehouse_name\`),
        \`stock_allocated\` = VALUES(\`stock_allocated\`), \`eway_bill_number\` = VALUES(\`eway_bill_number\`),
        \`eway_bill_date\` = VALUES(\`eway_bill_date\`), \`items_json\` = VALUES(\`items_json\`),
        \`total_estimated_cost\` = VALUES(\`total_estimated_cost\`), \`approved_by\` = VALUES(\`approved_by\`),
        \`approved_at\` = VALUES(\`approved_at\`), \`notes\` = VALUES(\`notes\`)
    `;
    await this.pool!.query(sql, [
      id, bomNumber, projectId, projectCode, projectTitle, customerName,
      systemCapacityKw, version, status, warehouseId, warehouseName,
      stockAllocated, ewayBillNumber, ewayBillDate,
      itemsJson, totalEstimatedCost, createdBy, approvedBy, approvedAt, notes
    ]);

    const saved = {
      ...item,
      id,
      bomNumber,
      projectId,
      projectCode,
      projectTitle,
      customerName,
      capacityKw: systemCapacityKw,
      systemCapacityKw,
      version,
      status,
      warehouseId,
      warehouseName,
      stockAllocated: Boolean(stockAllocated),
      ewayBillNumber,
      ewayBillDate,
      items: itemsArr,
      totalCost: totalEstimatedCost,
      totalEstimatedCost,
      createdBy,
      approvedBy,
      approvedAt: item.approvedAt || existing?.approved_at || undefined,
      notes,
      createdAt: item.createdAt || existing?.created_at || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const items = this.getFallbackItems('boms');
    const idx = items.findIndex(b => b.id === id);
    if (idx >= 0) items[idx] = saved;
    else items.unshift(saved);
    this.setFallbackItems('boms', items);
    return saved;
  }

  public async deleteBOM(id: string): Promise<boolean> {
    this.assertDbConnected();
    await this.pool!.query('DELETE FROM `solar_boms` WHERE `id` = ?', [id]);
    const items = this.getFallbackItems('boms').filter(b => b.id !== id);
    this.setFallbackItems('boms', items);
    return true;
  }

  // ==========================================================
  // CRUD: SALES INVOICES
  // ==========================================================
  public async getSalesInvoices(): Promise<any[]> {
    if (!this.isConnected) return this.getFallbackItems('sales_invoices');
    this.assertDbConnected();
    const [rows] = await this.pool!.query('SELECT * FROM `solar_sales_invoices` ORDER BY `created_at` DESC');
    const [bankRows]: any = await this.pool!.query('SELECT `id`, `account_name` FROM `solar_acc_bank_accounts`').catch(() => [[]]);
    const bankMap = new Map<string, string>((bankRows || []).map((b: any) => [b.id, b.account_name]));
    const mapped = (rows as any[]).map(r => {
      const invDate = this.toSqlDate(r.invoice_date) || '';
      const dueDate = this.toSqlDate(r.due_date) || '';
      let ewayBillDetails: any = undefined;
      try { if (r.eway_bill_details_json) ewayBillDetails = JSON.parse(r.eway_bill_details_json); } catch {}
      const totalAmount = Number(r.total_amount) || 0;
      const paidAmount = Number(r.paid_amount) || 0;
      const returnedAmount = Number(r.returned_amount) || 0;
      const refundedAmount = Number(r.refunded_amount) || 0;
      const balanceAmount = Number(r.balance_amount) || 0;
      return {
        id: r.id,
        invoiceNumber: r.invoice_number,
        invoiceType: r.invoice_type || 'TAX_INVOICE',
        projectId: r.project_id || '',
        projectTitle: r.project_title || '',
        customerId: r.customer_id,
        customerName: r.customer_name,
        customerGst: r.customer_gst || '',
        customerAddress: r.customer_address || '',
        invoiceDate: invDate,
        dueDate,
        paymentTerms: r.payment_terms || '15 Days Net',
        subtotal: Number(r.subtotal) || 0,
        gstAmount: Number(r.gst_amount) || 0,
        taxAmount: Number(r.gst_amount) || 0,
        totalAmount,
        grandTotal: totalAmount,
        paymentStatus: r.payment_status || 'ISSUED',
        status: r.payment_status || 'ISSUED',
        paidAmount,
        amountPaid: paidAmount,
        returnedAmount,
        refundedAmount,
        balanceAmount,
        balanceDue: balanceAmount,
        bankAccountId: r.bank_account_id || '',
        bankAccountName: r.bank_account_id ? (bankMap.get(r.bank_account_id) || '') : '',
        ewayBillNumber: r.eway_bill_number || '',
        ewayBillDetails,
        cgstAmount: Number(r.cgst_amount) || 0,
        sgstAmount: Number(r.sgst_amount) || 0,
        igstAmount: Number(r.igst_amount) || 0,
        einvoiceIrn: r.einvoice_irn || '',
        einvoiceAckNo: r.einvoice_ack_no || '',
        einvoiceAckDate: r.einvoice_ack_date || '',
        einvoiceStatus: r.einvoice_status || 'NOT_GENERATED',
        warehouseId: r.warehouse_id || '',
        deductStock: r.deduct_stock != null ? Boolean(r.deduct_stock) : true,
        stockDeducted: Boolean(r.stock_deducted),
        notes: r.notes || '',
        items: r.items_json ? JSON.parse(r.items_json) : [],
        createdAt: r.created_at,
        updatedAt: r.updated_at || r.created_at
      };
    });
    this.setFallbackItems('sales_invoices', mapped);
    return mapped;
  }

  public async saveSalesInvoice(item: any, actor?: any): Promise<any> {
    this.assertDbConnected();
    const id = item.id || `inv-${Date.now()}`;
    const existing = await this.getExistingRow('solar_sales_invoices', id);
    const invoiceNumber = item.invoiceNumber ?? item.invoice_number ?? existing?.invoice_number ?? id;
    const invoiceType = item.invoiceType ?? item.invoice_type ?? existing?.invoice_type ?? 'TAX_INVOICE';
    const projectId = item.projectId ?? item.project_id ?? existing?.project_id ?? '';
    const projectTitle = item.projectTitle ?? item.project_title ?? existing?.project_title ?? '';
    const customerId = item.customerId ?? item.customer_id ?? existing?.customer_id ?? '';
    const customerName = item.customerName ?? item.customer_name ?? existing?.customer_name ?? 'Solar Customer';
    const customerGst = item.customerGst ?? item.customer_gst ?? existing?.customer_gst ?? '';
    const customerAddress = item.customerAddress ?? item.customer_address ?? existing?.customer_address ?? '';
    const rawInvDate = item.invoiceDate ?? item.invoice_date ?? existing?.invoice_date;
    const invoiceDate = this.toSqlDate(rawInvDate) ?? new Date().toISOString().split('T')[0];
    const rawDueDate = item.dueDate ?? item.due_date ?? existing?.due_date;
    const dueDate = this.toSqlDate(rawDueDate);
    const paymentTerms = item.paymentTerms ?? item.payment_terms ?? existing?.payment_terms ?? '15 Days Net';
    const rawItems = item.items ?? (existing?.items_json ? JSON.parse(existing.items_json) : []);
    const itemsArr = typeof rawItems === 'string' ? JSON.parse(rawItems) : rawItems;
    const itemsJson = typeof rawItems === 'string' ? rawItems : JSON.stringify(rawItems);
    const subtotal = roundCurrency(Number(item.subtotal ?? existing?.subtotal) || 0);
    const gstAmount = roundCurrency(Number(item.taxAmount ?? item.gstAmount ?? item.gst_amount ?? existing?.gst_amount) || 0);
    const rawTotal = item.totalAmount ?? item.grandTotal ?? item.total_amount;
    const totalAmount = roundCurrency(
      rawTotal !== undefined && rawTotal !== null
        ? (Number(rawTotal) || 0)
        : (item.subtotal !== undefined || item.taxAmount !== undefined || item.gstAmount !== undefined
            ? subtotal + gstAmount
            : (Number(existing?.total_amount) || (subtotal + gstAmount)))
    );
    const returnedAmount = roundCurrency(Number(existing?.returned_amount ?? item.returnedAmount ?? 0) || 0);
    const refundedAmount = roundCurrency(Number(existing?.refunded_amount ?? item.refundedAmount ?? 0) || 0);
    const bankAccountId = String(item.bankAccountId ?? existing?.bank_account_id ?? '').trim();
    const requestedStatus = String(item.status ?? item.paymentStatus ?? item.payment_status ?? existing?.payment_status ?? 'ISSUED').toUpperCase();
    const existingPaid = roundCurrency(Number(existing?.paid_amount || 0));
    const rawRequestedPaid = Number(item.amountPaid ?? item.paidAmount ?? item.paid_amount ?? (requestedStatus === 'PAID' ? totalAmount : existingPaid)) || 0;
    const requestedPaid = (requestedStatus === 'DRAFT' || requestedStatus === 'CANCELLED')
      ? existingPaid
      : roundCurrency(Math.min(totalAmount, rawRequestedPaid));

    const netExistingPaid = roundCurrency(Math.max(0, existingPaid - refundedAmount));
    const maxPayableRemaining = roundCurrency(Math.max(0, totalAmount - returnedAmount - netExistingPaid));
    const paymentDelta = (requestedStatus !== 'DRAFT' && requestedStatus !== 'CANCELLED' && requestedPaid > existingPaid + 0.01)
      ? roundCurrency(Math.min(maxPayableRemaining, requestedPaid - existingPaid))
      : 0;

    const storedPaid = existingPaid;
    const storedBalance = roundCurrency(Math.max(0, totalAmount - returnedAmount - netExistingPaid));
    const baseStatus = (requestedStatus === 'DRAFT' || requestedStatus === 'CANCELLED')
      ? requestedStatus
      : (totalAmount > 0 && storedBalance <= 0.01 ? 'PAID' : (netExistingPaid > 0.01 ? 'PARTIAL' : 'ISSUED'));
    const status = baseStatus;
    const ewayBillNumber = item.ewayBillNumber ?? item.eway_bill_number ?? existing?.eway_bill_number ?? '';
    const ewayObj = item.ewayBillDetails !== undefined ? item.ewayBillDetails : (existing?.eway_bill_details_json ? JSON.parse(existing.eway_bill_details_json) : null);
    const ewayBillDetailsJson = ewayObj ? JSON.stringify(ewayObj) : null;
    const warehouseId = item.warehouseId ?? item.warehouse_id ?? existing?.warehouse_id ?? '';
    const deductStock = (item.deductStock !== undefined ? item.deductStock : (existing?.deduct_stock !== undefined ? Boolean(existing.deduct_stock) : true)) ? 1 : 0;
    const stockDeducted = (item.stockDeducted !== undefined ? item.stockDeducted : Boolean(existing?.stock_deducted)) ? 1 : 0;
    const hasExplicitTaxSplit =
      item.cgstAmount !== undefined ||
      item.cgst_amount !== undefined ||
      item.sgstAmount !== undefined ||
      item.sgst_amount !== undefined ||
      item.igstAmount !== undefined ||
      item.igst_amount !== undefined;
    const existingIgst = Number(existing?.igst_amount ?? 0);
    const igstAmount = roundCurrency(
      Number(
        item.igstAmount ??
          item.igst_amount ??
          (!hasExplicitTaxSplit && existingIgst > 0 ? gstAmount : existingIgst)
      ) || 0
    );
    const defaultHalfCgst = igstAmount > 0 ? 0 : roundCurrency(gstAmount / 2);
    const defaultHalfSgst = igstAmount > 0 ? 0 : roundCurrency(gstAmount - defaultHalfCgst);
    const cgstAmount = roundCurrency(
      Number(item.cgstAmount ?? item.cgst_amount ?? (!hasExplicitTaxSplit ? defaultHalfCgst : existing?.cgst_amount)) || 0
    );
    const sgstAmount = roundCurrency(
      Number(item.sgstAmount ?? item.sgst_amount ?? (!hasExplicitTaxSplit ? defaultHalfSgst : existing?.sgst_amount)) || 0
    );
    const einvoiceIrn = item.einvoiceIrn ?? item.einvoice_irn ?? existing?.einvoice_irn ?? '';
    const einvoiceAckNo = item.einvoiceAckNo ?? item.einvoice_ack_no ?? existing?.einvoice_ack_no ?? '';
    const einvoiceAckDate = item.einvoiceAckDate ?? item.einvoice_ack_date ?? existing?.einvoice_ack_date ?? '';
    const einvoiceStatus = item.einvoiceStatus ?? item.einvoice_status ?? existing?.einvoice_status ?? 'NOT_GENERATED';
    const notes = item.notes ?? existing?.notes ?? '';

    const sql = `
      INSERT INTO \`solar_sales_invoices\` (
        \`id\`, \`invoice_number\`, \`invoice_type\`, \`project_id\`, \`project_title\`,
        \`customer_id\`, \`customer_name\`, \`customer_gst\`, \`customer_address\`,
        \`invoice_date\`, \`due_date\`, \`payment_terms\`, \`items_json\`, \`subtotal\`, \`gst_amount\`,
        \`cgst_amount\`, \`sgst_amount\`, \`igst_amount\`,
        \`einvoice_irn\`, \`einvoice_ack_no\`, \`einvoice_ack_date\`, \`einvoice_status\`,
        \`total_amount\`, \`payment_status\`, \`paid_amount\`, \`returned_amount\`, \`refunded_amount\`, \`balance_amount\`, \`bank_account_id\`,
        \`eway_bill_number\`, \`eway_bill_details_json\`, \`warehouse_id\`, \`deduct_stock\`, \`stock_deducted\`, \`notes\`
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        \`invoice_type\` = VALUES(\`invoice_type\`), \`project_id\` = VALUES(\`project_id\`),
        \`project_title\` = VALUES(\`project_title\`), \`customer_id\` = VALUES(\`customer_id\`),
        \`customer_name\` = VALUES(\`customer_name\`), \`customer_gst\` = VALUES(\`customer_gst\`),
        \`customer_address\` = VALUES(\`customer_address\`), \`invoice_date\` = VALUES(\`invoice_date\`),
        \`due_date\` = VALUES(\`due_date\`), \`payment_terms\` = VALUES(\`payment_terms\`),
        \`items_json\` = VALUES(\`items_json\`), \`subtotal\` = VALUES(\`subtotal\`),
        \`gst_amount\` = VALUES(\`gst_amount\`), \`cgst_amount\` = VALUES(\`cgst_amount\`),
        \`sgst_amount\` = VALUES(\`sgst_amount\`), \`igst_amount\` = VALUES(\`igst_amount\`),
        \`einvoice_irn\` = VALUES(\`einvoice_irn\`), \`einvoice_ack_no\` = VALUES(\`einvoice_ack_no\`),
        \`einvoice_ack_date\` = VALUES(\`einvoice_ack_date\`), \`einvoice_status\` = VALUES(\`einvoice_status\`),
        \`total_amount\` = VALUES(\`total_amount\`), \`payment_status\` = VALUES(\`payment_status\`),
        \`paid_amount\` = VALUES(\`paid_amount\`), \`returned_amount\` = VALUES(\`returned_amount\`),
        \`refunded_amount\` = VALUES(\`refunded_amount\`), \`balance_amount\` = VALUES(\`balance_amount\`),
        \`bank_account_id\` = VALUES(\`bank_account_id\`),
        \`eway_bill_number\` = VALUES(\`eway_bill_number\`), \`eway_bill_details_json\` = VALUES(\`eway_bill_details_json\`),
        \`warehouse_id\` = VALUES(\`warehouse_id\`), \`deduct_stock\` = VALUES(\`deduct_stock\`),
        \`stock_deducted\` = VALUES(\`stock_deducted\`), \`notes\` = VALUES(\`notes\`)
    `;
    await this.pool!.query(sql, [
      id, invoiceNumber, invoiceType, projectId, projectTitle,
      customerId, customerName, customerGst, customerAddress,
      invoiceDate, dueDate, paymentTerms, itemsJson, subtotal, gstAmount,
      cgstAmount, sgstAmount, igstAmount,
      einvoiceIrn, einvoiceAckNo, einvoiceAckDate, einvoiceStatus,
      totalAmount, baseStatus, storedPaid, returnedAmount, refundedAmount, storedBalance, bankAccountId,
      ewayBillNumber, ewayBillDetailsJson, warehouseId, deductStock, stockDeducted, notes
    ]);

    if (existing && existingPaid === 0 && returnedAmount === 0) {
      await this.pool!.query(
        "DELETE FROM `solar_acc_journal_entries` WHERE `reference_type` = 'SALES_INVOICE' AND `reference_id` = ? AND `status` = 'POSTED'",
        [id]
      ).catch(() => {});
      await accountingService.recalculateAccountBalances(this.pool!).catch(() => {});
    }

    if (baseStatus !== 'DRAFT' && baseStatus !== 'CANCELLED' && totalAmount > 0) {
      await accountingService.ensureSalesInvoiceJournal(this.pool!, id, actor).catch(() => {});
    }

    if (paymentDelta > 0.01) {
      const effectiveBankId = await accountingService.resolveBankAccountIdOrPrimary(this.pool!, bankAccountId, item.paymentMode);
      if (!effectiveBankId) {
        const err: any = new Error('Please configure or select an active Cash/Bank account to record this invoice payment.');
        err.statusCode = 400;
        throw err;
      }
      await accountingService.recordSalesInvoicePayment(
        this.pool!,
        id,
        {
          amount: paymentDelta,
          paymentDate: invoiceDate,
          paymentMode: item.paymentMode || 'Bank NEFT/RTGS',
          bankAccountId: effectiveBankId,
          referenceNo: item.transactionReference || item.referenceNo || '',
          notes: existing ? 'Payment recorded on invoice update' : 'Initial payment recorded on invoice creation'
        },
        actor
      );
      const fresh = (await this.getSalesInvoices()).find(i => i.id === id);
      if (fresh) return fresh;
    }

    const saved = {
      ...item,
      id,
      invoiceNumber,
      invoiceType,
      projectId,
      projectTitle,
      customerId,
      customerName,
      customerGst,
      customerAddress,
      invoiceDate,
      dueDate: dueDate || '',
      paymentTerms,
      items: itemsArr,
      subtotal,
      taxAmount: gstAmount,
      gstAmount,
      cgstAmount,
      sgstAmount,
      igstAmount,
      einvoiceIrn,
      einvoiceAckNo,
      einvoiceAckDate,
      einvoiceStatus,
      totalAmount,
      grandTotal: totalAmount,
      status,
      paymentStatus: status,
      paidAmount: storedPaid,
      amountPaid: storedPaid,
      returnedAmount,
      refundedAmount,
      balanceAmount: storedBalance,
      balanceDue: storedBalance,
      bankAccountId,
      ewayBillNumber,
      ewayBillDetails: ewayObj || undefined,
      warehouseId,
      deductStock: Boolean(deductStock),
      stockDeducted: Boolean(stockDeducted),
      notes,
      createdAt: item.createdAt || existing?.created_at || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const items = this.getFallbackItems('sales_invoices');
    const idx = items.findIndex(i => i.id === id);
    if (idx >= 0) items[idx] = saved;
    else items.unshift(saved);
    this.setFallbackItems('sales_invoices', items);
    return saved;
  }

  public async deleteSalesInvoice(id: string): Promise<boolean> {
    this.assertDbConnected();
    const [srRows]: any = await this.pool!.query(
      "SELECT COUNT(*) AS cnt FROM `solar_sales_returns` WHERE `target_type` = 'CUSTOMER_INVOICE' AND `invoice_id` = ?",
      [id]
    ).catch(() => [[{ cnt: 0 }]]);
    if (Number(srRows?.[0]?.cnt || 0) > 0) {
      const err: any = new Error('Cannot delete invoice with Sales Returns recorded. Delete the Sales Returns first.');
      err.statusCode = 400;
      throw err;
    }
    const [payRows]: any = await this.pool!.query('SELECT COUNT(*) AS cnt FROM `solar_payments` WHERE `invoice_id` = ?', [id]).catch(() => [[{ cnt: 0 }]]);
    if (Number(payRows?.[0]?.cnt || 0) > 0) {
      const err: any = new Error('Cannot delete invoice with Customer Receipts recorded. Delete the receipts first.');
      err.statusCode = 400;
      throw err;
    }
    await this.pool!.query(
      "DELETE FROM `solar_acc_journal_entries` WHERE `reference_type` = 'SALES_INVOICE' AND `reference_id` = ?",
      [id]
    ).catch(() => {});
    await accountingService.recalculateAccountBalances(this.pool!).catch(() => {});
    await this.pool!.query('DELETE FROM `solar_sales_invoices` WHERE `id` = ?', [id]);
    const items = this.getFallbackItems('sales_invoices').filter(i => i.id !== id);
    this.setFallbackItems('sales_invoices', items);
    return true;
  }

  // ==========================================================
  // CRUD: VENDOR SALES INVOICES (NORMALIZED HEADER + ITEMS + PAYMENTS)
  // ==========================================================
  private resolveEffectiveVendorInvoiceStatus(
    rawStatus: string,
    dueDate: string,
    totalAmount: number,
    paidAmount: number,
    returnedAmount: number = 0,
    refundedAmount: number = 0
  ): string {
    const status = String(rawStatus || 'ISSUED').toUpperCase();
    const netPaid = roundCurrency(Math.max(0, paidAmount - refundedAmount));
    const balance = roundCurrency(Math.max(0, totalAmount - returnedAmount - netPaid));
    if (status === 'DRAFT' && paidAmount <= 0 && returnedAmount <= 0) {
      return 'DRAFT';
    }
    if (totalAmount > 0 && balance <= 0.01) {
      return 'PAID';
    }
    if (netPaid > 0.01) {
      return 'PARTIALLY_PAID';
    }
    if (dueDate) {
      const today = new Date().toISOString().slice(0, 10);
      if (dueDate < today) {
        return 'OVERDUE';
      }
    }
    return status === 'OVERDUE' ? 'OVERDUE' : 'ISSUED';
  }

  private mapVendorSalesInvoiceRow(row: any, items: any[], payments: any[], bankMap?: Map<string, string>): any {
    const invoiceDate = this.toSqlDate(row.invoice_date) || '';
    const dueDate = this.toSqlDate(row.due_date) || '';
    const totalAmount = roundCurrency(Number(row.total_amount) || 0);
    const paidAmount = roundCurrency(Number(row.paid_amount) || 0);
    const returnedAmount = roundCurrency(Number(row.returned_amount) || 0);
    const refundedAmount = roundCurrency(Number(row.refunded_amount) || 0);
    const netPaid = roundCurrency(Math.max(0, paidAmount - refundedAmount));
    const balanceAmount = roundCurrency(Math.max(0, totalAmount - returnedAmount - netPaid));
    const status = this.resolveEffectiveVendorInvoiceStatus(
      row.status || 'ISSUED',
      dueDate,
      totalAmount,
      paidAmount,
      returnedAmount,
      refundedAmount
    );
    const bankAccountId = row.bank_account_id || '';

    return {
      id: row.id,
      invoiceNumber: row.invoice_number,
      vendorId: row.vendor_id,
      vendorCode: row.vendor_code || '',
      vendorName: row.vendor_name,
      vendorGst: row.vendor_gst || '',
      vendorAddress: row.vendor_address || '',
      vendorCity: row.vendor_city || '',
      vendorState: row.vendor_state || '',
      vendorContactPerson: row.vendor_contact_person || '',
      vendorPhone: row.vendor_phone || '',
      vendorEmail: row.vendor_email || '',
      companyState: row.company_state || 'Chhattisgarh',
      supplyType: row.supply_type === 'INTER_STATE' ? 'INTER_STATE' : 'INTRA_STATE',
      invoiceDate,
      dueDate,
      paymentTerms: row.payment_terms || '30 Days',
      notes: row.notes || '',
      items,
      grossAmount: roundCurrency(Number(row.gross_amount) || 0),
      discountAmount: roundCurrency(Number(row.discount_amount) || 0),
      subtotal: roundCurrency(Number(row.subtotal) || 0),
      cgstAmount: roundCurrency(Number(row.cgst_amount) || 0),
      sgstAmount: roundCurrency(Number(row.sgst_amount) || 0),
      igstAmount: roundCurrency(Number(row.igst_amount) || 0),
      taxAmount: roundCurrency(Number(row.tax_amount) || 0),
      totalAmount,
      paidAmount,
      returnedAmount,
      refundedAmount,
      balanceAmount,
      bankAccountId,
      bankAccountName: bankAccountId ? (bankMap?.get(bankAccountId) || '') : '',
      status,
      payments,
      createdBy: row.created_by || '',
      updatedBy: row.updated_by || '',
      createdAt: row.created_at,
      updatedAt: row.updated_at || row.created_at
    };
  }

  private mapVendorSalesItemRow(r: any): any {
    return {
      id: r.id,
      productId: r.product_id || undefined,
      description: r.description,
      hsnCode: r.hsn_code || '',
      quantity: Number(r.quantity) || 0,
      unit: r.unit || 'NOS',
      rate: roundCurrency(Number(r.rate) || 0),
      discountType: r.discount_type === 'FLAT' ? 'FLAT' : 'PERCENT',
      discountValue: roundCurrency(Number(r.discount_value) || 0),
      discountAmount: roundCurrency(Number(r.discount_amount) || 0),
      taxableAmount: roundCurrency(Number(r.taxable_amount) || 0),
      gstRate: Number(r.gst_rate) || 0,
      cgstRate: Number(r.cgst_rate) || 0,
      cgstAmount: roundCurrency(Number(r.cgst_amount) || 0),
      sgstRate: Number(r.sgst_rate) || 0,
      sgstAmount: roundCurrency(Number(r.sgst_amount) || 0),
      igstRate: Number(r.igst_rate) || 0,
      igstAmount: roundCurrency(Number(r.igst_amount) || 0),
      taxAmount: roundCurrency(Number(r.tax_amount) || 0),
      totalAmount: roundCurrency(Number(r.total_amount) || 0)
    };
  }

  private mapVendorSalesPaymentRow(r: any, bankMap?: Map<string, string>): any {
    const bankAccountId = r.bank_account_id || '';
    return {
      id: r.id,
      invoiceId: r.invoice_id,
      vendorId: r.vendor_id,
      paymentDate: this.toSqlDate(r.payment_date) || '',
      amount: roundCurrency(Number(r.amount) || 0),
      paymentMode: r.payment_mode || 'Bank NEFT/RTGS',
      referenceNo: r.reference_no || '',
      notes: r.notes || '',
      bankAccountId,
      bankAccountName: bankAccountId ? (bankMap?.get(bankAccountId) || '') : '',
      journalEntryId: r.journal_entry_id || '',
      recordedBy: r.recorded_by || '',
      createdAt: r.created_at
    };
  }

  public async getNextVendorSalesInvoiceNumber(conn?: mysql.PoolConnection): Promise<string> {
    this.assertDbConnected();
    const runner: any = conn || this.pool!;
    const year = new Date().getFullYear();
    const prefix = `VSI-${year}-`;
    const [rows]: any = await runner.query(
      'SELECT `invoice_number` FROM `solar_vendor_sales_invoices` WHERE `invoice_number` LIKE ?',
      [`${prefix}%`]
    );
    let maxSeq = 0;
    for (const r of (rows || []) as any[]) {
      const numStr = String(r.invoice_number || '').slice(prefix.length);
      const parsed = parseInt(numStr, 10);
      if (Number.isFinite(parsed) && parsed > maxSeq) {
        maxSeq = parsed;
      }
    }
    return `${prefix}${String(maxSeq + 1).padStart(3, '0')}`;
  }

  public async getVendorSalesInvoices(): Promise<any[]> {
    if (!this.isConnected) return [];
    this.assertDbConnected();

    const [invoiceRows]: any = await this.pool!.query(
      'SELECT * FROM `solar_vendor_sales_invoices` ORDER BY `invoice_date` DESC, `created_at` DESC'
    );
    if (!Array.isArray(invoiceRows) || invoiceRows.length === 0) return [];

    const [itemRows]: any = await this.pool!.query(
      'SELECT * FROM `solar_vendor_sales_invoice_items` ORDER BY `line_order` ASC, `created_at` ASC'
    );
    const [paymentRows]: any = await this.pool!.query(
      'SELECT * FROM `solar_vendor_sales_payments` ORDER BY `payment_date` DESC, `created_at` DESC'
    );
    const [bankRows]: any = await this.pool!.query('SELECT `id`, `account_name` FROM `solar_acc_bank_accounts`').catch(() => [[]]);
    const bankMap = new Map<string, string>((bankRows || []).map((b: any) => [b.id, b.account_name]));

    const itemsByInv = new Map<string, any[]>();
    for (const r of (itemRows || []) as any[]) {
      const list = itemsByInv.get(r.invoice_id) || [];
      list.push(this.mapVendorSalesItemRow(r));
      itemsByInv.set(r.invoice_id, list);
    }

    const paymentsByInv = new Map<string, any[]>();
    for (const r of (paymentRows || []) as any[]) {
      const list = paymentsByInv.get(r.invoice_id) || [];
      list.push(this.mapVendorSalesPaymentRow(r, bankMap));
      paymentsByInv.set(r.invoice_id, list);
    }

    return invoiceRows.map((row: any) =>
      this.mapVendorSalesInvoiceRow(
        row,
        itemsByInv.get(row.id) || [],
        paymentsByInv.get(row.id) || [],
        bankMap
      )
    );
  }

  public async getVendorSalesInvoiceById(id: string): Promise<any | null> {
    this.assertDbConnected();
    const [invoiceRows]: any = await this.pool!.query(
      'SELECT * FROM `solar_vendor_sales_invoices` WHERE `id` = ? LIMIT 1',
      [id]
    );
    if (!Array.isArray(invoiceRows) || invoiceRows.length === 0) return null;

    const [itemRows]: any = await this.pool!.query(
      'SELECT * FROM `solar_vendor_sales_invoice_items` WHERE `invoice_id` = ? ORDER BY `line_order` ASC, `created_at` ASC',
      [id]
    );
    const [paymentRows]: any = await this.pool!.query(
      'SELECT * FROM `solar_vendor_sales_payments` WHERE `invoice_id` = ? ORDER BY `payment_date` DESC, `created_at` DESC',
      [id]
    );
    const [bankRows]: any = await this.pool!.query('SELECT `id`, `account_name` FROM `solar_acc_bank_accounts`').catch(() => [[]]);
    const bankMap = new Map<string, string>((bankRows || []).map((b: any) => [b.id, b.account_name]));

    return this.mapVendorSalesInvoiceRow(
      invoiceRows[0],
      (itemRows || []).map((r: any) => this.mapVendorSalesItemRow(r)),
      (paymentRows || []).map((r: any) => this.mapVendorSalesPaymentRow(r, bankMap)),
      bankMap
    );
  }

  public async saveVendorSalesInvoice(item: any, actor?: any): Promise<any> {
    this.assertDbConnected();
    const conn = await this.pool!.getConnection();
    try {
      await conn.beginTransaction();

      const id = String(item?.id || '').trim() || `vsi-${Date.now()}`;
      const [existingRows]: any = await conn.query(
        'SELECT * FROM `solar_vendor_sales_invoices` WHERE `id` = ? LIMIT 1',
        [id]
      );
      const existing = Array.isArray(existingRows) && existingRows.length > 0 ? existingRows[0] : null;

      const vendorId = String(item?.vendorId ?? item?.vendor_id ?? existing?.vendor_id ?? '').trim();
      if (!vendorId) {
        const err: any = new Error('Please select an existing vendor from MySQL records.');
        err.statusCode = 400;
        throw err;
      }

      const [vendorRows]: any = await conn.query(
        'SELECT * FROM `solar_vendors` WHERE `id` = ? LIMIT 1',
        [vendorId]
      );
      if (!Array.isArray(vendorRows) || vendorRows.length === 0) {
        const err: any = new Error(`Selected vendor (${vendorId}) does not exist in MySQL vendor records.`);
        err.statusCode = 400;
        throw err;
      }
      const vendorRow = vendorRows[0];

      const rawItems = Array.isArray(item?.items) ? item.items : [];
      if (rawItems.length === 0) {
        const err: any = new Error('Invoice must include at least one line item.');
        err.statusCode = 400;
        throw err;
      }

      const productIds = Array.from(
        new Set(
          rawItems
            .map((li: any) => String(li?.productId || '').trim())
            .filter(Boolean)
        )
      );
      if (productIds.length > 0) {
        const placeholders = productIds.map(() => '?').join(',');
        const [prodRows]: any = await conn.query(
          `SELECT \`id\` FROM \`solar_products\` WHERE \`id\` IN (${placeholders})`,
          productIds
        );
        const foundProdIds = new Set((prodRows || []).map((p: any) => String(p.id)));
        const missingProd = productIds.find(pid => !foundProdIds.has(pid));
        if (missingProd) {
          const err: any = new Error(`Referenced product (${missingProd}) was not found in MySQL product catalog.`);
          err.statusCode = 400;
          throw err;
        }
      }

      for (let i = 0; i < rawItems.length; i++) {
        const li = rawItems[i];
        const desc = String(li?.description || '').trim();
        const qty = Number(li?.quantity);
        const rate = Number(li?.rate);
        const gst = Number(li?.gstRate ?? li?.taxRatePercent ?? 0);
        const disc = Number(li?.discountValue ?? 0);
        if (!desc) {
          const err: any = new Error(`Line item #${i + 1}: description is required.`);
          err.statusCode = 400;
          throw err;
        }
        if (!Number.isFinite(qty) || qty <= 0) {
          const err: any = new Error(`Line item #${i + 1}: quantity must be greater than 0.`);
          err.statusCode = 400;
          throw err;
        }
        if (!Number.isFinite(rate) || rate < 0) {
          const err: any = new Error(`Line item #${i + 1}: rate cannot be negative.`);
          err.statusCode = 400;
          throw err;
        }
        if (!Number.isFinite(gst) || gst < 0 || gst > 100) {
          const err: any = new Error(`Line item #${i + 1}: GST rate must be between 0% and 100%.`);
          err.statusCode = 400;
          throw err;
        }
        if (!Number.isFinite(disc) || disc < 0) {
          const err: any = new Error(`Line item #${i + 1}: discount cannot be negative.`);
          err.statusCode = 400;
          throw err;
        }
      }

      const settings = await this.getSettings().catch(() => ({} as any));

      const vendorCode = vendorRow.vendor_code || item.vendorCode || '';
      const vendorName = vendorRow.name || item.vendorName || 'Solar Vendor';
      const vendorGst = String(item.vendorGst ?? vendorRow.gst_number ?? '').trim();
      const vendorCity = String(item.vendorCity ?? vendorRow.city ?? '').trim();
      const vendorState = String(item.vendorState ?? vendorRow.state ?? '').trim();
      const formattedVendorAddress = [vendorRow.address, vendorCity, vendorState]
        .map(s => String(s || '').trim())
        .filter(Boolean)
        .join(', ');
      const vendorAddress = String(item.vendorAddress ?? formattedVendorAddress).trim();
      const vendorContactPerson = String(item.vendorContactPerson ?? vendorRow.contact_person ?? '').trim();
      const vendorPhone = String(item.vendorPhone ?? vendorRow.phone ?? '').trim();
      const vendorEmail = String(item.vendorEmail ?? vendorRow.email ?? '').trim();

      const jurisdiction = determineVendorSupplyType({
        companyState: item.companyState || settings?.companyState,
        companyGst: settings?.companyGst,
        companyAddress: settings?.companyAddress,
        vendorState,
        vendorGst,
        vendorAddress
      });

      const computed = computeVendorSalesInvoiceTotals(
        rawItems.map((li: any) => ({
          id: li.id,
          productId: li.productId || undefined,
          description: li.description,
          hsnCode: li.hsnCode || '',
          quantity: Number(li.quantity) || 0,
          unit: li.unit || 'NOS',
          rate: Number(li.rate) || 0,
          discountType: li.discountType === 'FLAT' ? 'FLAT' : 'PERCENT',
          discountValue: Number(li.discountValue ?? 0) || 0,
          gstRate: Number(li.gstRate ?? li.taxRatePercent ?? 18) || 0
        })),
        jurisdiction.supplyType
      );

      let invoiceNumber = String(item?.invoiceNumber ?? existing?.invoice_number ?? '').trim();
      if (!invoiceNumber) {
        invoiceNumber = await this.getNextVendorSalesInvoiceNumber(conn);
      }

      const [dupRows]: any = await conn.query(
        'SELECT `id` FROM `solar_vendor_sales_invoices` WHERE `invoice_number` = ? AND `id` <> ? LIMIT 1',
        [invoiceNumber, id]
      );
      if (Array.isArray(dupRows) && dupRows.length > 0) {
        const err: any = new Error(`Invoice number "${invoiceNumber}" already exists.`);
        err.statusCode = 409;
        throw err;
      }

      const invoiceDate = this.toSqlDate(item.invoiceDate ?? existing?.invoice_date) || new Date().toISOString().slice(0, 10);
      const dueDate = this.toSqlDate(item.dueDate ?? existing?.due_date) || invoiceDate;
      const paymentTerms = String(item.paymentTerms ?? existing?.payment_terms ?? vendorRow.payment_terms ?? '30 Days').trim();
      const notes = String(item.notes ?? existing?.notes ?? '').trim();

      const [paySumRows]: any = await conn.query(
        'SELECT COALESCE(SUM(`amount`), 0) AS paidSum FROM `solar_vendor_sales_payments` WHERE `invoice_id` = ?',
        [id]
      );
      const recordedPaymentsTotal = roundCurrency(Number(paySumRows?.[0]?.paidSum) || 0);
      const paidAmount = existing ? recordedPaymentsTotal : Math.min(computed.totalAmount, roundCurrency(Number(item.paidAmount) || 0));
      const returnedAmount = roundCurrency(Number(existing?.returned_amount ?? 0) || 0);
      const refundedAmount = roundCurrency(Number(existing?.refunded_amount ?? 0) || 0);
      const initialPayToRecord = !existing && paidAmount > 0 ? paidAmount : 0;
      const storedPaid = existing ? paidAmount : 0;
      const netPaid = roundCurrency(Math.max(0, storedPaid - refundedAmount));
      const balanceAmount = roundCurrency(Math.max(0, computed.totalAmount - returnedAmount - netPaid));
      const bankAccountId = String(item.bankAccountId ?? existing?.bank_account_id ?? '').trim();

      const requestedStatus = String(item.status || existing?.status || 'ISSUED').toUpperCase();
      const status = this.resolveEffectiveVendorInvoiceStatus(
        requestedStatus,
        dueDate,
        computed.totalAmount,
        storedPaid,
        returnedAmount,
        refundedAmount
      );

      const actorName = String(actor?.name || actor?.email || item.updatedBy || item.createdBy || 'Admin');
      const createdBy = existing?.created_by || String(item.createdBy || actorName);

      await conn.query(
        `INSERT INTO \`solar_vendor_sales_invoices\` (
          \`id\`, \`invoice_number\`, \`vendor_id\`, \`vendor_code\`, \`vendor_name\`, \`vendor_gst\`,
          \`vendor_address\`, \`vendor_city\`, \`vendor_state\`, \`vendor_contact_person\`, \`vendor_phone\`, \`vendor_email\`,
          \`company_state\`, \`supply_type\`, \`invoice_date\`, \`due_date\`, \`payment_terms\`, \`notes\`,
          \`gross_amount\`, \`discount_amount\`, \`subtotal\`, \`cgst_amount\`, \`sgst_amount\`, \`igst_amount\`, \`tax_amount\`,
          \`total_amount\`, \`paid_amount\`, \`returned_amount\`, \`refunded_amount\`, \`balance_amount\`, \`bank_account_id\`, \`status\`, \`created_by\`, \`updated_by\`
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          \`invoice_number\` = VALUES(\`invoice_number\`),
          \`vendor_id\` = VALUES(\`vendor_id\`),
          \`vendor_code\` = VALUES(\`vendor_code\`),
          \`vendor_name\` = VALUES(\`vendor_name\`),
          \`vendor_gst\` = VALUES(\`vendor_gst\`),
          \`vendor_address\` = VALUES(\`vendor_address\`),
          \`vendor_city\` = VALUES(\`vendor_city\`),
          \`vendor_state\` = VALUES(\`vendor_state\`),
          \`vendor_contact_person\` = VALUES(\`vendor_contact_person\`),
          \`vendor_phone\` = VALUES(\`vendor_phone\`),
          \`vendor_email\` = VALUES(\`vendor_email\`),
          \`company_state\` = VALUES(\`company_state\`),
          \`supply_type\` = VALUES(\`supply_type\`),
          \`invoice_date\` = VALUES(\`invoice_date\`),
          \`due_date\` = VALUES(\`due_date\`),
          \`payment_terms\` = VALUES(\`payment_terms\`),
          \`notes\` = VALUES(\`notes\`),
          \`gross_amount\` = VALUES(\`gross_amount\`),
          \`discount_amount\` = VALUES(\`discount_amount\`),
          \`subtotal\` = VALUES(\`subtotal\`),
          \`cgst_amount\` = VALUES(\`cgst_amount\`),
          \`sgst_amount\` = VALUES(\`sgst_amount\`),
          \`igst_amount\` = VALUES(\`igst_amount\`),
          \`tax_amount\` = VALUES(\`tax_amount\`),
          \`total_amount\` = VALUES(\`total_amount\`),
          \`paid_amount\` = VALUES(\`paid_amount\`),
          \`returned_amount\` = VALUES(\`returned_amount\`),
          \`refunded_amount\` = VALUES(\`refunded_amount\`),
          \`balance_amount\` = VALUES(\`balance_amount\`),
          \`bank_account_id\` = VALUES(\`bank_account_id\`),
          \`status\` = VALUES(\`status\`),
          \`updated_by\` = VALUES(\`updated_by\`)`,
        [
          id,
          invoiceNumber,
          vendorId,
          vendorCode,
          vendorName,
          vendorGst,
          vendorAddress,
          vendorCity,
          jurisdiction.vendorStateName || vendorState,
          vendorContactPerson,
          vendorPhone,
          vendorEmail,
          jurisdiction.companyStateName,
          jurisdiction.supplyType,
          invoiceDate,
          dueDate,
          paymentTerms,
          notes,
          computed.grossAmount,
          computed.discountAmount,
          computed.subtotal,
          computed.cgstAmount,
          computed.sgstAmount,
          computed.igstAmount,
          computed.taxAmount,
          computed.totalAmount,
          storedPaid,
          returnedAmount,
          refundedAmount,
          balanceAmount,
          bankAccountId,
          status,
          createdBy,
          actorName
        ]
      );

      await conn.query('DELETE FROM `solar_vendor_sales_invoice_items` WHERE `invoice_id` = ?', [id]);
      for (let idx = 0; idx < computed.items.length; idx++) {
        const li = computed.items[idx];
        const lineId = `vsii-${id}-${idx}-${Date.now().toString(36)}`;
        await conn.query(
          `INSERT INTO \`solar_vendor_sales_invoice_items\` (
            \`id\`, \`invoice_id\`, \`product_id\`, \`line_order\`, \`description\`, \`hsn_code\`,
            \`quantity\`, \`unit\`, \`rate\`, \`discount_type\`, \`discount_value\`, \`discount_amount\`,
            \`taxable_amount\`, \`gst_rate\`, \`cgst_rate\`, \`cgst_amount\`, \`sgst_rate\`, \`sgst_amount\`,
            \`igst_rate\`, \`igst_amount\`, \`tax_amount\`, \`total_amount\`
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            lineId,
            id,
            li.productId || null,
            idx,
            li.description,
            li.hsnCode || '',
            li.quantity,
            li.unit,
            li.rate,
            li.discountType,
            li.discountValue,
            li.discountAmount,
            li.taxableAmount,
            li.gstRate,
            li.cgstRate,
            li.cgstAmount,
            li.sgstRate,
            li.sgstAmount,
            li.igstRate,
            li.igstAmount,
            li.taxAmount,
            li.totalAmount
          ]
        );
      }

      await conn.commit();
      conn.release();

      if (status !== 'DRAFT') {
        await accountingService.ensureVendorSalesInvoiceJournal(this.pool!, id, actor).catch(() => {});
      }

      if (initialPayToRecord > 0) {
        const effectiveBankId = await accountingService.resolveBankAccountIdOrPrimary(this.pool!, bankAccountId, item.paymentMode);
        await accountingService.recordVendorSalesInvoicePayment(
          this.pool!,
          id,
          {
            amount: initialPayToRecord,
            paymentDate: invoiceDate,
            paymentMode: item.paymentMode || 'Bank NEFT/RTGS',
            bankAccountId: effectiveBankId,
            notes: 'Initial payment recorded on invoice creation'
          },
          actor
        );
      }

      return await this.getVendorSalesInvoiceById(id);
    } catch (err) {
      try { await conn.rollback(); } catch {}
      conn.release();
      throw err;
    }
  }

  public async recordVendorSalesPayment(
    invoiceId: string,
    payment: {
      amount: number;
      paymentDate?: string;
      paymentMode?: string;
      referenceNo?: string;
      notes?: string;
      bankAccountId?: string;
    },
    actor?: any
  ): Promise<any> {
    this.assertDbConnected();
    await accountingService.recordVendorSalesInvoicePayment(this.pool!, invoiceId, payment, actor);
    return await this.getVendorSalesInvoiceById(invoiceId);
  }

  public async deleteVendorSalesInvoice(id: string): Promise<boolean> {
    this.assertDbConnected();
    const conn = await this.pool!.getConnection();
    try {
      await conn.beginTransaction();
      const [srRows]: any = await conn.query(
        "SELECT COUNT(*) AS cnt FROM `solar_sales_returns` WHERE `target_type` = 'VENDOR_INVOICE' AND `invoice_id` = ?",
        [id]
      );
      if (Number(srRows?.[0]?.cnt || 0) > 0) {
        const err: any = new Error('Cannot delete vendor sales invoice with Sales Returns recorded. Delete the Sales Returns first.');
        err.statusCode = 400;
        throw err;
      }

      const [payRows]: any = await conn.query('SELECT * FROM `solar_vendor_sales_payments` WHERE `invoice_id` = ?', [id]);
      for (const vp of payRows || []) {
        if (vp.bank_account_id && Number(vp.amount || 0) > 0) {
          await conn.query(
            'UPDATE `solar_acc_bank_accounts` SET `current_balance` = ROUND(`current_balance` - ?, 2) WHERE `id` = ?',
            [roundCurrency(Number(vp.amount || 0)), vp.bank_account_id]
          );
        }
        if (vp.journal_entry_id) {
          await conn.query('DELETE FROM `solar_acc_journal_entries` WHERE `id` = ?', [vp.journal_entry_id]);
        }
      }
      await conn.query(
        "DELETE FROM `solar_acc_journal_entries` WHERE `reference_type` = 'VENDOR_SALES_INVOICE' AND `reference_id` = ?",
        [id]
      );
      await accountingService.recalculateAccountBalances(conn);
      await conn.query('DELETE FROM `solar_vendor_sales_invoices` WHERE `id` = ?', [id]);
      await conn.commit();
      conn.release();
      return true;
    } catch (err) {
      try { await conn.rollback(); } catch {}
      conn.release();
      throw err;
    }
  }

  // ==========================================================
  // CRUD: WAREHOUSES & STOCK
  // ==========================================================
  public async getWarehouses(): Promise<any[]> {
    if (!this.isConnected) return this.getFallbackItems('warehouses');
    this.assertDbConnected();
    const [rows] = await this.pool!.query('SELECT * FROM `solar_warehouses` ORDER BY `is_default` DESC, `created_at` ASC');
    const mapped = (rows as any[]).map(r => {
      const status = r.status || (r.is_active ? 'ACTIVE' : 'INACTIVE');
      const contactPerson = r.manager_name || '';
      const contactPhone = r.manager_phone || '';
      return {
        id: r.id,
        name: r.name,
        code: r.code,
        address: r.address || '',
        city: r.city || '',
        state: r.state || '',
        pincode: r.pincode || '',
        contactPerson,
        contactPhone,
        managerName: contactPerson,
        managerPhone: contactPhone,
        email: r.email || '',
        gstNumber: r.gst_number || '',
        capacitySqFt: r.capacity_sq_ft != null ? Number(r.capacity_sq_ft) : 15000,
        isActive: status === 'ACTIVE' || Boolean(r.is_active),
        isDefault: Boolean(r.is_default),
        status,
        notes: r.notes || '',
        createdAt: r.created_at,
        updatedAt: r.updated_at || r.created_at
      };
    });
    this.setFallbackItems('warehouses', mapped);
    return mapped;
  }

  public async saveWarehouse(item: any): Promise<any> {
    this.assertDbConnected();
    const id = item.id || `wh-${Date.now()}`;
    const existing = await this.getExistingRow('solar_warehouses', id);
    const name = item.name ?? existing?.name ?? 'Solar Warehouse';
    const code = item.code ?? existing?.code ?? id;
    const address = item.address ?? existing?.address ?? 'Not specified';
    const city = item.city ?? existing?.city ?? 'Not specified';
    const state = item.state ?? existing?.state ?? '';
    const pincode = item.pincode ?? existing?.pincode ?? '';
    const contactPerson = item.contactPerson ?? item.managerName ?? item.manager_name ?? existing?.manager_name ?? '';
    const contactPhone = item.contactPhone ?? item.managerPhone ?? item.manager_phone ?? existing?.manager_phone ?? '';
    const email = item.email ?? existing?.email ?? '';
    const gstNumber = item.gstNumber ?? item.gst_number ?? existing?.gst_number ?? '';
    const capacitySqFt = item.capacitySqFt != null ? Number(item.capacitySqFt) : (existing?.capacity_sq_ft != null ? Number(existing.capacity_sq_ft) : 15000);
    const status = item.status ?? (item.isActive === false ? 'INACTIVE' : (existing?.status ?? (existing?.is_active === 0 ? 'INACTIVE' : 'ACTIVE')));
    const isActive = status === 'ACTIVE' ? 1 : 0;
    const isDefault = (item.isDefault !== undefined ? Boolean(item.isDefault) : Boolean(existing?.is_default)) ? 1 : 0;
    const notes = item.notes ?? existing?.notes ?? '';

    if (isDefault) {
      await this.pool!.query('UPDATE `solar_warehouses` SET `is_default` = 0 WHERE `id` != ?', [id]);
    }

    const sql = `
      INSERT INTO \`solar_warehouses\` (
        \`id\`, \`name\`, \`code\`, \`address\`, \`city\`, \`state\`,
        \`pincode\`, \`manager_name\`, \`manager_phone\`, \`email\`, \`gst_number\`,
        \`capacity_sq_ft\`, \`is_active\`, \`status\`, \`is_default\`, \`notes\`
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        \`name\` = VALUES(\`name\`), \`code\` = VALUES(\`code\`),
        \`address\` = VALUES(\`address\`), \`city\` = VALUES(\`city\`),
        \`state\` = VALUES(\`state\`), \`pincode\` = VALUES(\`pincode\`),
        \`manager_name\` = VALUES(\`manager_name\`), \`manager_phone\` = VALUES(\`manager_phone\`),
        \`email\` = VALUES(\`email\`), \`gst_number\` = VALUES(\`gst_number\`),
        \`capacity_sq_ft\` = VALUES(\`capacity_sq_ft\`), \`is_active\` = VALUES(\`is_active\`),
        \`status\` = VALUES(\`status\`), \`is_default\` = VALUES(\`is_default\`),
        \`notes\` = VALUES(\`notes\`)
    `;
    await this.pool!.query(sql, [
      id, name, code, address, city, state,
      pincode, contactPerson, contactPhone, email, gstNumber,
      capacitySqFt, isActive, status, isDefault, notes
    ]);

    const saved = {
      ...item,
      id,
      name,
      code,
      address,
      city,
      state,
      pincode,
      contactPerson,
      contactPhone,
      managerName: contactPerson,
      managerPhone: contactPhone,
      email,
      gstNumber,
      capacitySqFt,
      isActive: Boolean(isActive),
      status,
      isDefault: Boolean(isDefault),
      notes,
      createdAt: item.createdAt || existing?.created_at || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const items = this.getFallbackItems('warehouses').map(w => isDefault && w.id !== id ? { ...w, isDefault: false } : w);
    const idx = items.findIndex(w => w.id === id);
    if (idx >= 0) items[idx] = saved;
    else items.push(saved);
    this.setFallbackItems('warehouses', items);
    return saved;
  }

  public async deleteWarehouse(id: string): Promise<boolean> {
    this.assertDbConnected();
    const existing = await this.getExistingRow('solar_warehouses', id);
    if (existing && Boolean(existing.is_default)) {
      throw new Error('Cannot delete the Primary/Default warehouse. Assign another default warehouse first.');
    }
    await this.pool!.query('DELETE FROM `solar_warehouses` WHERE `id` = ?', [id]);
    const items = this.getFallbackItems('warehouses').filter(w => w.id !== id);
    this.setFallbackItems('warehouses', items);
    return true;
  }

  // Stock Movements
  public async getStockMovements(): Promise<any[]> {
    if (!this.isConnected) return this.getFallbackItems('stock_movements');
    this.assertDbConnected();
    const [rows] = await this.pool!.query('SELECT * FROM `solar_stock_movements` ORDER BY `timestamp` DESC LIMIT 200');
    const mapped = (rows as any[]).map(r => ({
      id: r.id,
      productId: r.product_id,
      productName: r.product_name,
      sku: r.sku || '',
      type: r.movement_type,
      movementType: r.movement_type,
      quantity: Number(r.quantity) || 0,
      balanceAfter: Number(r.balance_after) || 0,
      referenceNumber: r.reference_number || '',
      referenceId: r.reference_id || '',
      movementNumber: r.reference_number || r.id,
      warehouseId: r.warehouse_id || '',
      warehouseName: r.warehouse_name || '',
      targetWarehouseId: r.target_warehouse_id || undefined,
      targetWarehouseName: r.target_warehouse_name || undefined,
      notes: r.notes || '',
      timestamp: r.timestamp,
      movementDate: r.timestamp,
      performedBy: r.performed_by || ''
    }));
    this.setFallbackItems('stock_movements', mapped);
    return mapped;
  }

  public async saveStockMovement(item: any): Promise<any> {
    this.assertDbConnected();
    const id = item.id || `sm-${Date.now()}`;
    const existing = await this.getExistingRow('solar_stock_movements', id);
    const productId = item.productId ?? item.product_id ?? existing?.product_id ?? '';
    const productName = item.productName ?? item.product_name ?? existing?.product_name ?? 'Solar Product';
    const sku = item.sku ?? existing?.sku ?? '';
    const movementType = item.type ?? item.movementType ?? item.movement_type ?? existing?.movement_type ?? 'IN';
    const quantity = Number(item.quantity ?? existing?.quantity) || 0;
    const balanceAfter = Number(item.balanceAfter ?? item.balance_after ?? existing?.balance_after) || 0;
    const referenceNumber = item.referenceNumber ?? item.reference_number ?? item.movementNumber ?? existing?.reference_number ?? '';
    const referenceId = item.referenceId ?? item.reference_id ?? existing?.reference_id ?? '';
    const warehouseId = item.warehouseId ?? item.warehouse_id ?? existing?.warehouse_id ?? '';
    const warehouseName = item.warehouseName ?? item.warehouse_name ?? existing?.warehouse_name ?? '';
    const targetWarehouseId = item.targetWarehouseId ?? item.target_warehouse_id ?? existing?.target_warehouse_id ?? '';
    const targetWarehouseName = item.targetWarehouseName ?? item.target_warehouse_name ?? existing?.target_warehouse_name ?? '';
    const notes = item.notes ?? existing?.notes ?? '';
    const rawTs = item.timestamp ?? item.movementDate ?? existing?.timestamp;
    const ts = this.toSqlDateTime(rawTs);
    const performedBy = item.performedBy ?? item.performed_by ?? existing?.performed_by ?? 'System';

    const sql = `
      INSERT INTO \`solar_stock_movements\` (
        \`id\`, \`product_id\`, \`product_name\`, \`sku\`, \`movement_type\`,
        \`quantity\`, \`balance_after\`, \`reference_number\`, \`reference_id\`,
        \`warehouse_id\`, \`warehouse_name\`, \`target_warehouse_id\`, \`target_warehouse_name\`,
        \`notes\`, \`timestamp\`, \`performed_by\`
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        \`product_name\` = VALUES(\`product_name\`),
        \`movement_type\` = VALUES(\`movement_type\`),
        \`quantity\` = VALUES(\`quantity\`),
        \`balance_after\` = VALUES(\`balance_after\`),
        \`warehouse_id\` = VALUES(\`warehouse_id\`),
        \`warehouse_name\` = VALUES(\`warehouse_name\`),
        \`target_warehouse_id\` = VALUES(\`target_warehouse_id\`),
        \`target_warehouse_name\` = VALUES(\`target_warehouse_name\`),
        \`notes\` = VALUES(\`notes\`),
        \`reference_number\` = VALUES(\`reference_number\`)
    `;
    await this.pool!.query(sql, [
      id, productId, productName, sku, movementType,
      quantity, balanceAfter, referenceNumber, referenceId,
      warehouseId, warehouseName, targetWarehouseId, targetWarehouseName,
      notes, ts, performedBy
    ]);

    const saved = {
      ...item,
      id,
      productId,
      productName,
      sku,
      type: movementType,
      movementType,
      quantity,
      balanceAfter,
      referenceNumber,
      referenceId,
      warehouseId,
      warehouseName,
      targetWarehouseId: targetWarehouseId || undefined,
      targetWarehouseName: targetWarehouseName || undefined,
      notes,
      timestamp: item.timestamp || new Date().toISOString(),
      performedBy
    };
    const items = this.getFallbackItems('stock_movements');
    const idx = items.findIndex(s => s.id === id);
    if (idx >= 0) items[idx] = saved;
    else items.unshift(saved);
    this.setFallbackItems('stock_movements', items.slice(0, 200));
    return saved;
  }

  public async deleteStockMovement(id: string): Promise<boolean> {
    this.assertDbConnected();
    await this.pool!.query('DELETE FROM `solar_stock_movements` WHERE `id` = ?', [id]);
    const items = this.getFallbackItems('stock_movements').filter(s => s.id !== id);
    this.setFallbackItems('stock_movements', items);
    return true;
  }

  // Stock Audits
  public async getStockAudits(): Promise<any[]> {
    if (!this.isConnected) return this.getFallbackItems('stock_audits');
    this.assertDbConnected();
    const [rows] = await this.pool!.query('SELECT * FROM `solar_stock_audits` ORDER BY `audit_date` DESC, `created_at` DESC');
    const mapped = (rows as any[]).map(r => {
      const items = r.items_json ? JSON.parse(r.items_json) : [];
      const discrepancies = Number(r.discrepancies_count) || 0;
      const itemsAudited = r.items_audited != null ? Number(r.items_audited) : items.length;
      return {
        id: r.id,
        auditNumber: r.audit_number,
        warehouseId: r.warehouse_id,
        warehouseName: r.warehouse_name,
        auditDate: this.toSqlDate(r.audit_date) || '',
        auditedBy: r.auditor_name,
        auditorName: r.auditor_name,
        status: r.status || 'COMPLETED',
        itemsAudited,
        discrepanciesFound: discrepancies,
        discrepanciesCount: discrepancies,
        netAdjustmentValue: Number(r.net_adjustment_value) || 0,
        items,
        notes: r.notes || '',
        createdAt: r.created_at
      };
    });
    this.setFallbackItems('stock_audits', mapped);
    return mapped;
  }

  public async saveStockAudit(item: any): Promise<any> {
    this.assertDbConnected();
    const id = item.id || `audit-${Date.now()}`;
    const existing = await this.getExistingRow('solar_stock_audits', id);
    const auditNumber = item.auditNumber ?? item.audit_number ?? existing?.audit_number ?? id;
    const warehouseId = item.warehouseId ?? item.warehouse_id ?? existing?.warehouse_id ?? '';
    const warehouseName = item.warehouseName ?? item.warehouse_name ?? existing?.warehouse_name ?? 'Main Warehouse';
    const rawDate = item.auditDate ?? item.audit_date ?? existing?.audit_date;
    const auditDate = this.toSqlDate(rawDate) ?? new Date().toISOString().split('T')[0];
    const auditorName = item.auditedBy ?? item.auditorName ?? item.auditor_name ?? existing?.auditor_name ?? 'Auditor';
    const status = item.status ?? existing?.status ?? 'COMPLETED';
    const rawItems = item.items ?? (existing?.items_json ? JSON.parse(existing.items_json) : []);
    const itemsArr = typeof rawItems === 'string' ? JSON.parse(rawItems) : rawItems;
    const itemsJson = typeof rawItems === 'string' ? rawItems : JSON.stringify(rawItems);
    const discrepanciesCount = Number(item.discrepanciesFound ?? item.discrepanciesCount ?? item.discrepancies_count ?? existing?.discrepancies_count) || 0;
    const itemsAudited = Number(item.itemsAudited ?? item.items_audited ?? existing?.items_audited ?? itemsArr.length) || 0;
    const netAdjustmentValue = Number(item.netAdjustmentValue ?? item.net_adjustment_value ?? existing?.net_adjustment_value) || 0;
    const notes = item.notes ?? existing?.notes ?? '';

    const sql = `
      INSERT INTO \`solar_stock_audits\` (
        \`id\`, \`audit_number\`, \`warehouse_id\`, \`warehouse_name\`,
        \`audit_date\`, \`auditor_name\`, \`status\`, \`items_audited\`,
        \`discrepancies_count\`, \`net_adjustment_value\`, \`items_json\`, \`notes\`
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        \`warehouse_name\` = VALUES(\`warehouse_name\`),
        \`auditor_name\` = VALUES(\`auditor_name\`),
        \`status\` = VALUES(\`status\`),
        \`items_audited\` = VALUES(\`items_audited\`),
        \`discrepancies_count\` = VALUES(\`discrepancies_count\`),
        \`net_adjustment_value\` = VALUES(\`net_adjustment_value\`),
        \`items_json\` = VALUES(\`items_json\`),
        \`notes\` = VALUES(\`notes\`)
    `;
    await this.pool!.query(sql, [
      id, auditNumber, warehouseId, warehouseName,
      auditDate, auditorName, status, itemsAudited,
      discrepanciesCount, netAdjustmentValue, itemsJson, notes
    ]);

    const saved = {
      ...item,
      id,
      auditNumber,
      warehouseId,
      warehouseName,
      auditDate,
      auditedBy: auditorName,
      auditorName,
      status,
      itemsAudited,
      discrepanciesFound: discrepanciesCount,
      discrepanciesCount,
      netAdjustmentValue,
      items: itemsArr,
      notes,
      createdAt: item.createdAt || existing?.created_at || new Date().toISOString()
    };
    const items = this.getFallbackItems('stock_audits');
    const idx = items.findIndex(a => a.id === id);
    if (idx >= 0) items[idx] = saved;
    else items.unshift(saved);
    this.setFallbackItems('stock_audits', items);
    return saved;
  }

  public async deleteStockAudit(id: string): Promise<boolean> {
    this.assertDbConnected();
    await this.pool!.query('DELETE FROM `solar_stock_audits` WHERE `id` = ?', [id]);
    const items = this.getFallbackItems('stock_audits').filter(a => a.id !== id);
    this.setFallbackItems('stock_audits', items);
    return true;
  }

  // ==========================================================
  // CRUD: ATTENDANCE
  // ==========================================================
  public async getAttendance(): Promise<any[]> {
    if (!this.isConnected) return this.getFallbackItems('attendance');
    this.assertDbConnected();
    const [rows] = await this.pool!.query('SELECT * FROM `solar_attendance` ORDER BY `attendance_date` DESC, `check_in_time` DESC');
    const mapped = (rows as any[]).map(r => {
      let fuelExpense: any = undefined;
      if (r.fuel_expense_json) {
        try {
          fuelExpense = typeof r.fuel_expense_json === 'string' ? JSON.parse(r.fuel_expense_json) : r.fuel_expense_json;
        } catch {}
      }

      // Format date strictly as YYYY-MM-DD regardless of mysql2 Date object or string format
      let formattedDate = '';
      if (r.attendance_date instanceof Date) {
        const y = r.attendance_date.getFullYear();
        const m = String(r.attendance_date.getMonth() + 1).padStart(2, '0');
        const d = String(r.attendance_date.getDate()).padStart(2, '0');
        formattedDate = `${y}-${m}-${d}`;
      } else if (r.attendance_date) {
        const s = String(r.attendance_date).trim();
        formattedDate = s.includes('T') ? s.split('T')[0] : (s.length >= 10 ? s.slice(0, 10) : s);
      }

      // If fuelExpense has initial & final readings but missing totalKmDriven, compute it
      if (fuelExpense) {
        if (fuelExpense.totalKmDriven == null && fuelExpense.finalOdometerReading != null && fuelExpense.initialOdometerReading != null) {
          const diff = Number(fuelExpense.finalOdometerReading) - Number(fuelExpense.initialOdometerReading);
          if (diff >= 0) {
            fuelExpense.totalKmDriven = Math.round(diff * 10) / 10;
          }
        }
      }

      const parsedCheckInGps = r.check_in_gps_json ? (typeof r.check_in_gps_json === 'string' ? JSON.parse(r.check_in_gps_json) : r.check_in_gps_json) : undefined;
      const parsedCheckOutGps = r.check_out_gps_json ? (typeof r.check_out_gps_json === 'string' ? JSON.parse(r.check_out_gps_json) : r.check_out_gps_json) : undefined;

      return {
        id: r.id,
        employeeId: r.employee_id,
        employeeName: r.employee_name,
        date: formattedDate,
        attendanceDate: formattedDate,
        checkInTime: r.check_in_time,
        checkOutTime: r.check_out_time,
        checkInGPS: parsedCheckInGps,
        checkInGps: parsedCheckInGps,
        checkOutGPS: parsedCheckOutGps,
        checkOutGps: parsedCheckOutGps,
        siteProjectId: r.site_project_id,
        siteProjectTitle: r.site_project_title,
        status: r.status,
        fuelExpense,
        createdAt: r.created_at
      };
    });
    this.setFallbackItems('attendance', mapped);
    return mapped;
  }

  public async saveAttendance(item: any): Promise<any> {
    this.assertDbConnected();
    let attDate = '';
    const rawDate = item.attendanceDate || item.date || item.attendance_date;
    if (rawDate instanceof Date) {
      const y = rawDate.getFullYear();
      const m = String(rawDate.getMonth() + 1).padStart(2, '0');
      const d = String(rawDate.getDate()).padStart(2, '0');
      attDate = `${y}-${m}-${d}`;
    } else if (rawDate) {
      const s = String(rawDate).trim();
      attDate = s.includes('T') ? s.split('T')[0] : (s.length >= 10 ? s.slice(0, 10) : s);
    } else {
      attDate = new Date().toISOString().split('T')[0];
    }

    const rawInGps = item.checkInGPS ?? item.checkInGps ?? item.gpsCheckIn ?? item.check_in_gps_json ?? null;
    const rawOutGps = item.checkOutGPS ?? item.checkOutGps ?? item.gpsCheckOut ?? item.check_out_gps_json ?? null;
    const inGpsObj = typeof rawInGps === 'string' ? (() => { try { return JSON.parse(rawInGps); } catch { return undefined; } })() : (rawInGps || undefined);
    const outGpsObj = typeof rawOutGps === 'string' ? (() => { try { return JSON.parse(rawOutGps); } catch { return undefined; } })() : (rawOutGps || undefined);

    let fuelExpense = item.fuelExpense;
    if (!fuelExpense && item.fuel_expense_json) {
      try {
        fuelExpense = typeof item.fuel_expense_json === 'string' ? JSON.parse(item.fuel_expense_json) : item.fuel_expense_json;
      } catch {}
    }
    if (fuelExpense && typeof fuelExpense === 'object') {
      if (fuelExpense.totalKmDriven == null && fuelExpense.finalOdometerReading != null && fuelExpense.initialOdometerReading != null) {
        const diff = Number(fuelExpense.finalOdometerReading) - Number(fuelExpense.initialOdometerReading);
        if (diff >= 0) {
          fuelExpense = { ...fuelExpense, totalKmDriven: Math.round(diff * 10) / 10 };
        }
      }
    }

    const fuelExpenseJson = fuelExpense ? JSON.stringify(fuelExpense) : null;

    const sql = `
      INSERT INTO \`solar_attendance\` (
        \`id\`, \`employee_id\`, \`employee_name\`, \`attendance_date\`,
        \`check_in_time\`, \`check_out_time\`, \`check_in_gps_json\`, \`check_out_gps_json\`,
        \`site_project_id\`, \`site_project_title\`, \`status\`, \`fuel_expense_json\`
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        \`employee_id\` = VALUES(\`employee_id\`),
        \`employee_name\` = VALUES(\`employee_name\`),
        \`attendance_date\` = VALUES(\`attendance_date\`),
        \`check_in_time\` = VALUES(\`check_in_time\`),
        \`check_out_time\` = VALUES(\`check_out_time\`),
        \`status\` = VALUES(\`status\`),
        \`check_in_gps_json\` = VALUES(\`check_in_gps_json\`),
        \`check_out_gps_json\` = VALUES(\`check_out_gps_json\`),
        \`site_project_id\` = VALUES(\`site_project_id\`),
        \`site_project_title\` = VALUES(\`site_project_title\`),
        \`fuel_expense_json\` = VALUES(\`fuel_expense_json\`)
    `;
    await this.pool!.query(sql, [
      item.id,
      item.employeeId || '',
      item.employeeName || 'Employee',
      attDate,
      item.checkInTime || '09:00 AM',
      item.checkOutTime || null,
      inGpsObj ? JSON.stringify(inGpsObj) : null,
      outGpsObj ? JSON.stringify(outGpsObj) : null,
      item.siteProjectId || '',
      item.siteProjectTitle || '',
      item.status || 'PRESENT',
      fuelExpenseJson
    ]);

    const normalized = {
      ...item,
      date: attDate,
      attendanceDate: attDate,
      ...(inGpsObj ? { checkInGPS: inGpsObj, checkInGps: inGpsObj } : {}),
      ...(outGpsObj ? { checkOutGPS: outGpsObj, checkOutGps: outGpsObj } : {}),
      ...(fuelExpense ? { fuelExpense } : {})
    };
    const items = this.getFallbackItems('attendance');
    const idx = items.findIndex(a => a.id === normalized.id);
    if (idx >= 0) items[idx] = { ...items[idx], ...normalized };
    else items.unshift(normalized);
    this.setFallbackItems('attendance', items);
    return normalized;
  }

  public async deleteAttendance(id: string): Promise<boolean> {
    this.assertDbConnected();
    await this.pool!.query('DELETE FROM `solar_attendance` WHERE `id` = ?', [id]);
    const items = this.getFallbackItems('attendance').filter(a => a.id !== id);
    this.setFallbackItems('attendance', items);
    return true;
  }

  // ==========================================================
  // CRUD: PAYSLIPS
  // ==========================================================
  public async getPayslips(): Promise<any[]> {
    if (!this.isConnected) return this.getFallbackItems('payslips');
    this.assertDbConnected();
    const [rows] = await this.pool!.query('SELECT * FROM `solar_payslips` ORDER BY `year` DESC, `month` DESC');
    const mapped = (rows as any[]).map(r => {
      const basicSalary = Number(r.basic_salary) || 0;
      const allowances = Number(r.allowances) || 0;
      const netSalary = Number(r.net_salary) || 0;
      let additionalExpenses: any[] = [];
      try {
        if (r.additional_expenses_json) {
          additionalExpenses = typeof r.additional_expenses_json === 'string'
            ? JSON.parse(r.additional_expenses_json)
            : r.additional_expenses_json;
        }
      } catch {}
      let deductionsList: any[] = [];
      try {
        if (r.deductions_json) {
          deductionsList = typeof r.deductions_json === 'string'
            ? JSON.parse(r.deductions_json)
            : r.deductions_json;
        }
      } catch {}
      const totalAdditionalExpenses = Array.isArray(additionalExpenses)
        ? additionalExpenses.reduce((s, it) => s + (Number(it.amount) || 0), 0)
        : 0;
      const totalDeductions = deductionsList.length > 0
        ? deductionsList.reduce((s, it) => s + (Number(it.amount) || 0), 0)
        : (Number(r.deductions) || 0);

      return {
        id: r.id,
        payslipNumber: r.id,
        employeeId: r.employee_id,
        employeeName: r.employee_name,
        employeeCode: r.employee_id,
        month: r.month,
        year: Number(r.year) || 2026,
        baseSalary: basicSalary,
        basicSalary: basicSalary,
        allowances: allowances,
        overtimeAmount: allowances,
        overtimeType: (r.overtime_hours && Number(r.overtime_hours) > 0) ? 'CALCULATED' : 'DIRECT',
        overtimeHours: Number(r.overtime_hours) || 0,
        overtimeRatePerHour: Number(r.overtime_rate) || 0,
        totalAdditionalExpenses,
        additionalExpenses: Array.isArray(additionalExpenses) ? additionalExpenses : [],
        deductions: Array.isArray(deductionsList) ? deductionsList : [],
        totalDeductions,
        grossEarnings: basicSalary + allowances + totalAdditionalExpenses,
        netPay: netSalary || Math.max(0, basicSalary + allowances + totalAdditionalExpenses - totalDeductions),
        netSalary: netSalary || Math.max(0, basicSalary + allowances + totalAdditionalExpenses - totalDeductions),
        paymentStatus: r.payment_status || 'PAID',
        status: r.payment_status === 'PAID' ? 'PAID' : (r.payment_status || 'GENERATED'),
        paymentDate: r.payment_date,
        paymentMode: r.payment_mode || 'NEFT/RTGS Bank Transfer',
        bankReferenceNo: r.bank_reference_no || '',
        notes: r.notes || '',
        createdAt: r.created_at
      };
    });
    this.setFallbackItems('payslips', mapped);
    return mapped;
  }

  public async savePayslip(item: any): Promise<any> {
    this.assertDbConnected();
    const basicSalary = Number(item.baseSalary ?? item.basicSalary ?? item.basic_salary) || 0;
    const allowances = Number(item.overtimeAmount ?? item.allowances) || 0;
    const deductions = Number(item.totalDeductions ?? (Array.isArray(item.deductions) ? item.deductions.reduce((s: number, d: any) => s + (Number(d.amount) || 0), 0) : item.deductions)) || 0;
    const additionalExpensesJson = item.additionalExpenses ? JSON.stringify(item.additionalExpenses) : (item.additional_expenses_json || '[]');
    const deductionsJson = item.deductions ? (Array.isArray(item.deductions) ? JSON.stringify(item.deductions) : JSON.stringify([])) : (item.deductions_json || '[]');
    const totalAdditionalExpenses = Number(item.totalAdditionalExpenses ?? (Array.isArray(item.additionalExpenses) ? item.additionalExpenses.reduce((s: number, e: any) => s + (Number(e.amount) || 0), 0) : 0)) || 0;
    const netSalary = Number(item.netPay ?? item.netSalary ?? item.net_salary) || Math.max(0, basicSalary + allowances + totalAdditionalExpenses - deductions);
    const overtimeHours = Number(item.overtimeHours ?? item.overtime_hours) || 0;
    const overtimeRate = Number(item.overtimeRatePerHour ?? item.overtime_rate) || 0;
    const paymentMode = item.paymentMode ?? item.payment_mode ?? 'NEFT/RTGS Bank Transfer';
    const bankRefNo = item.bankReferenceNo ?? item.bank_reference_no ?? '';

    const sql = `
      INSERT INTO \`solar_payslips\` (
        \`id\`, \`employee_id\`, \`employee_name\`, \`month\`, \`year\`,
        \`basic_salary\`, \`allowances\`, \`deductions\`, \`net_salary\`,
        \`payment_status\`, \`payment_date\`, \`notes\`,
        \`additional_expenses_json\`, \`deductions_json\`, \`overtime_hours\`, \`overtime_rate\`,
        \`payment_mode\`, \`bank_reference_no\`
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        \`employee_name\` = VALUES(\`employee_name\`),
        \`month\` = VALUES(\`month\`),
        \`year\` = VALUES(\`year\`),
        \`basic_salary\` = VALUES(\`basic_salary\`),
        \`allowances\` = VALUES(\`allowances\`),
        \`deductions\` = VALUES(\`deductions\`),
        \`net_salary\` = VALUES(\`net_salary\`),
        \`payment_status\` = VALUES(\`payment_status\`),
        \`payment_date\` = VALUES(\`payment_date\`),
        \`notes\` = VALUES(\`notes\`),
        \`additional_expenses_json\` = VALUES(\`additional_expenses_json\`),
        \`deductions_json\` = VALUES(\`deductions_json\`),
        \`overtime_hours\` = VALUES(\`overtime_hours\`),
        \`overtime_rate\` = VALUES(\`overtime_rate\`),
        \`payment_mode\` = VALUES(\`payment_mode\`),
        \`bank_reference_no\` = VALUES(\`bank_reference_no\`)
    `;

    await this.pool!.query(sql, [
      item.id,
      item.employeeId,
      item.employeeName,
      item.month,
      Number(item.year) || 2026,
      basicSalary,
      allowances,
      deductions,
      netSalary,
      item.status || item.paymentStatus || 'UNPAID',
      item.paymentDate ? String(item.paymentDate).split('T')[0] : null,
      item.notes || '',
      additionalExpensesJson,
      deductionsJson,
      overtimeHours,
      overtimeRate,
      paymentMode,
      bankRefNo
    ]);

    const items = this.getFallbackItems('payslips');
    const idx = items.findIndex(p => p.id === item.id);
    if (idx >= 0) items[idx] = { ...items[idx], ...item };
    else items.unshift(item);
    this.setFallbackItems('payslips', items);
    return item;
  }

  public async deletePayslip(id: string): Promise<boolean> {
    this.assertDbConnected();
    await this.pool!.query('DELETE FROM `solar_payslips` WHERE `id` = ?', [id]);
    const items = this.getFallbackItems('payslips').filter(p => p.id !== id);
    this.setFallbackItems('payslips', items);
    return true;
  }

  // ==========================================================
  // CRUD: HOLIDAYS
  // ==========================================================
  public async getHolidays(): Promise<any[]> {
    if (!this.isConnected) return this.getFallbackItems('holidays');
    this.assertDbConnected();
    const [rows] = await this.pool!.query('SELECT * FROM `solar_holidays` ORDER BY `holiday_date` ASC');
    const mapped = (rows as any[]).map(r => {
      let hDate = '';
      if (r.holiday_date instanceof Date) {
        const y = r.holiday_date.getFullYear();
        const m = String(r.holiday_date.getMonth() + 1).padStart(2, '0');
        const d = String(r.holiday_date.getDate()).padStart(2, '0');
        hDate = `${y}-${m}-${d}`;
      } else if (r.holiday_date) {
        const s = String(r.holiday_date).trim();
        hDate = s.includes('T') ? s.split('T')[0] : (s.length >= 10 ? s.slice(0, 10) : s);
      }
      return {
        id: r.id,
        name: r.name,
        holidayDate: hDate,
        date: hDate,
        type: r.type,
        description: r.description,
        createdAt: r.created_at
      };
    });
    this.setFallbackItems('holidays', mapped);
    return mapped;
  }

  public async saveHoliday(item: any): Promise<any> {
    this.assertDbConnected();
    const rawDate = item.holidayDate || item.date || item.holiday_date;
    let hDate = '';
    if (rawDate instanceof Date) {
      const y = rawDate.getFullYear();
      const m = String(rawDate.getMonth() + 1).padStart(2, '0');
      const d = String(rawDate.getDate()).padStart(2, '0');
      hDate = `${y}-${m}-${d}`;
    } else if (rawDate) {
      const s = String(rawDate).trim();
      hDate = s.includes('T') ? s.split('T')[0] : (s.length >= 10 ? s.slice(0, 10) : s);
    } else {
      hDate = new Date().toISOString().split('T')[0];
    }

    const sql = `
      INSERT INTO \`solar_holidays\` (\`id\`, \`name\`, \`holiday_date\`, \`type\`, \`description\`)
      VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        \`name\` = VALUES(\`name\`), \`holiday_date\` = VALUES(\`holiday_date\`),
        \`type\` = VALUES(\`type\`), \`description\` = VALUES(\`description\`)
    `;
    await this.pool!.query(sql, [
      item.id,
      item.name || '',
      hDate,
      item.type || 'Mandatory',
      item.description || ''
    ]);

    const normalized = { ...item, holidayDate: hDate, date: hDate };
    const items = this.getFallbackItems('holidays');
    const idx = items.findIndex(h => h.id === normalized.id);
    if (idx >= 0) items[idx] = { ...items[idx], ...normalized };
    else items.push(normalized);
    items.sort((a, b) => (a.date || a.holidayDate || '').localeCompare(b.date || b.holidayDate || ''));
    this.setFallbackItems('holidays', items);
    return normalized;
  }

  public async deleteHoliday(id: string): Promise<boolean> {
    this.assertDbConnected();
    await this.pool!.query('DELETE FROM `solar_holidays` WHERE `id` = ?', [id]);
    const items = this.getFallbackItems('holidays').filter(h => h.id !== id);
    this.setFallbackItems('holidays', items);
    return true;
  }

  // ==========================================================
  // CRUD: EMPLOYEE LEAVE MANAGEMENT
  // ==========================================================
  private mapLeaveRow(r: any) {
    const fmtDate = (v: any) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10));
    const fmtIso = (v: any) => (v ? (v instanceof Date ? v.toISOString() : String(v)) : null);
    return {
      id: r.id,
      employeeId: r.employee_id,
      employeeCode: r.employee_code || '',
      employeeName: r.employee_name || '',
      department: r.department || '',
      designation: r.designation || '',
      leaveType: r.leave_type || 'CASUAL',
      startDate: fmtDate(r.start_date),
      endDate: fmtDate(r.end_date),
      totalDays: Number(r.total_days) || 0,
      isHalfDay: Boolean(r.is_half_day),
      halfDaySession: r.half_day_session || '',
      reason: r.reason || '',
      status: r.status || 'PENDING',
      leaveYear: Number(r.leave_year) || new Date().getFullYear(),
      appliedAt: fmtIso(r.applied_at || r.created_at) || new Date().toISOString(),
      reviewedBy: r.reviewed_by || null,
      reviewerId: r.reviewer_id || null,
      reviewedAt: fmtIso(r.reviewed_at),
      adminRemarks: r.admin_remarks || null,
      createdAt: fmtIso(r.created_at),
      updatedAt: fmtIso(r.updated_at)
    };
  }

  private async resolveEmployeeForLeave(actor: any, requestedEmployeeId?: string) {
    this.assertDbConnected();
    const roleUpper = String(actor?.role || '').trim().toUpperCase();
    const isAdminOrHr = roleUpper === 'ADMIN' || roleUpper === 'SUPER ADMIN' || roleUpper === 'HR MANAGER';

    if (isAdminOrHr && requestedEmployeeId && requestedEmployeeId.trim()) {
      const targetId = requestedEmployeeId.trim();
      const [rows]: any = await this.pool!.query(
        'SELECT * FROM `solar_employee` WHERE `id` = ? OR `auth_uid` = ? OR `employee_code` = ? LIMIT 1',
        [targetId, targetId, targetId]
      );
      if (Array.isArray(rows) && rows.length > 0) {
        const e = rows[0];
        return {
          employeeId: e.id,
          employeeCode: e.employee_code || e.id,
          employeeName: e.name,
          department: e.department || 'Operations',
          designation: e.designation || ''
        };
      }
      const [uRows]: any = await this.pool!.query(
        'SELECT * FROM `solar_users` WHERE `id` = ? OR `employee_id` = ? LIMIT 1',
        [targetId, targetId]
      );
      if (Array.isArray(uRows) && uRows.length > 0) {
        const u = uRows[0];
        return {
          employeeId: u.id,
          employeeCode: u.employee_id || u.id,
          employeeName: u.name,
          department: u.department || 'Operations',
          designation: u.designation || u.role || ''
        };
      }
      const err: any = new Error('Selected employee not found in MySQL.');
      err.statusCode = 404;
      throw err;
    }

    // Non-admin (or admin applying for self without override): strictly resolve caller
    const actorId = String(actor?.id || '').trim();
    const actorEmpId = String(actor?.employeeId || '').trim();
    const actorEmail = String(actor?.email || '').trim().toLowerCase();

    const [empRows]: any = await this.pool!.query(
      'SELECT * FROM `solar_employee` WHERE `id` = ? OR `auth_uid` = ? OR (`employee_code` != "" AND `employee_code` = ?) OR (`email` != "" AND LOWER(`email`) = ?) LIMIT 1',
      [actorId, actorId, actorEmpId, actorEmail]
    );
    if (Array.isArray(empRows) && empRows.length > 0) {
      const e = empRows[0];
      return {
        employeeId: e.id,
        employeeCode: e.employee_code || e.id,
        employeeName: e.name,
        department: e.department || 'Operations',
        designation: e.designation || ''
      };
    }

    return {
      employeeId: actorId,
      employeeCode: actorEmpId || `EMP-${actorId.slice(-4).toUpperCase()}`,
      employeeName: actor?.name || 'Employee',
      department: actor?.department || 'Operations',
      designation: actor?.designation || actor?.role || ''
    };
  }

  private async ensureLeaveBalanceRow(connOrPool: any, employeeId: string, leaveYear: number) {
    const balId = `lbal-${employeeId}-${leaveYear}`;
    await connOrPool.query(
      `INSERT IGNORE INTO \`solar_leave_balances\` (\`id\`, \`employee_id\`, \`leave_year\`, \`casual_total\`, \`casual_used\`, \`sick_total\`, \`sick_used\`, \`earned_total\`, \`earned_used\`, \`unpaid_used\`)
       VALUES (?, ?, ?, 12.00, 0.00, 8.00, 0.00, 15.00, 0.00, 0.00)`,
      [balId, employeeId, leaveYear]
    );
  }

  public async getLeaveData(actor: any, year?: number) {
    this.assertDbConnected();
    const leaveYear = Number.isFinite(Number(year)) && Number(year) >= 2000 ? Number(year) : new Date().getFullYear();
    const roleUpper = String(actor?.role || '').trim().toUpperCase();
    const isAdminOrHr = roleUpper === 'ADMIN' || roleUpper === 'SUPER ADMIN' || roleUpper === 'HR MANAGER';
    const myProfile = await this.resolveEmployeeForLeave(actor);

    const allEmployees = await this.getEmployees();
    const targetEmployees = isAdminOrHr
      ? allEmployees.filter((e: any) => String(e.status || '').toUpperCase() !== 'TERMINATED')
      : allEmployees.filter((e: any) =>
          e.id === myProfile.employeeId ||
          e.authUid === actor?.id ||
          (myProfile.employeeCode && e.employeeCode === myProfile.employeeCode) ||
          (actor?.email && String(e.email || '').toLowerCase() === String(actor.email).toLowerCase())
        );

    const empListForBalances = targetEmployees.length > 0 ? targetEmployees : [
      {
        id: myProfile.employeeId,
        employeeCode: myProfile.employeeCode,
        name: myProfile.employeeName,
        department: myProfile.department,
        designation: myProfile.designation
      }
    ];

    for (const emp of empListForBalances) {
      await this.ensureLeaveBalanceRow(this.pool!, emp.id, leaveYear);
    }

    const myIdVariants = Array.from(new Set([
      myProfile.employeeId,
      String(actor?.id || '').trim(),
      String(actor?.employeeId || '').trim()
    ].filter(Boolean)));

    let leaveRows: any[] = [];
    if (isAdminOrHr) {
      const [rows]: any = await this.pool!.query(
        'SELECT * FROM `solar_leave_requests` WHERE `leave_year` = ? ORDER BY FIELD(`status`, "PENDING", "APPROVED", "REJECTED", "CANCELLED"), `applied_at` DESC',
        [leaveYear]
      );
      leaveRows = rows || [];
    } else {
      const ph = myIdVariants.map(() => '?').join(',');
      const [rows]: any = await this.pool!.query(
        `SELECT * FROM \`solar_leave_requests\` WHERE \`leave_year\` = ? AND \`employee_id\` IN (${ph}) ORDER BY \`applied_at\` DESC`,
        [leaveYear, ...myIdVariants]
      );
      leaveRows = rows || [];
    }

    const leaves = leaveRows.map(r => this.mapLeaveRow(r));

    let balRows: any[] = [];
    if (isAdminOrHr) {
      const [rows]: any = await this.pool!.query(
        'SELECT * FROM `solar_leave_balances` WHERE `leave_year` = ?',
        [leaveYear]
      );
      balRows = rows || [];
    } else {
      const ph = myIdVariants.map(() => '?').join(',');
      const [rows]: any = await this.pool!.query(
        `SELECT * FROM \`solar_leave_balances\` WHERE \`leave_year\` = ? AND \`employee_id\` IN (${ph})`,
        [leaveYear, ...myIdVariants]
      );
      balRows = rows || [];
    }

    const balByEmp = new Map<string, any>();
    for (const b of balRows) {
      balByEmp.set(b.employee_id, b);
    }

    const pendingMap = new Map<string, { CASUAL: number; SICK: number; EARNED: number }>();
    for (const lv of leaves) {
      if (lv.status === 'PENDING') {
        const cur = pendingMap.get(lv.employeeId) || { CASUAL: 0, SICK: 0, EARNED: 0 };
        if (lv.leaveType === 'CASUAL') cur.CASUAL += lv.totalDays;
        else if (lv.leaveType === 'SICK') cur.SICK += lv.totalDays;
        else if (lv.leaveType === 'EARNED') cur.EARNED += lv.totalDays;
        pendingMap.set(lv.employeeId, cur);
      }
    }

    const balances = empListForBalances.map((emp: any) => {
      const b = balByEmp.get(emp.id) || {};
      const pend = pendingMap.get(emp.id) || { CASUAL: 0, SICK: 0, EARNED: 0 };
      const casualTotal = b.casual_total !== undefined ? Number(b.casual_total) : 12;
      const casualUsed = Number(b.casual_used) || 0;
      const sickTotal = b.sick_total !== undefined ? Number(b.sick_total) : 8;
      const sickUsed = Number(b.sick_used) || 0;
      const earnedTotal = b.earned_total !== undefined ? Number(b.earned_total) : 15;
      const earnedUsed = Number(b.earned_used) || 0;
      const unpaidUsed = Number(b.unpaid_used) || 0;
      const totalAllocated = casualTotal + sickTotal + earnedTotal;
      const totalUsed = casualUsed + sickUsed + earnedUsed;
      return {
        id: b.id || `lbal-${emp.id}-${leaveYear}`,
        employeeId: emp.id,
        employeeCode: emp.employeeCode || '',
        employeeName: emp.name || '',
        department: emp.department || '',
        designation: emp.designation || '',
        leaveYear,
        casualTotal,
        casualUsed,
        casualPending: pend.CASUAL,
        casualRemaining: Math.max(0, Number((casualTotal - casualUsed).toFixed(2))),
        sickTotal,
        sickUsed,
        sickPending: pend.SICK,
        sickRemaining: Math.max(0, Number((sickTotal - sickUsed).toFixed(2))),
        earnedTotal,
        earnedUsed,
        earnedPending: pend.EARNED,
        earnedRemaining: Math.max(0, Number((earnedTotal - earnedUsed).toFixed(2))),
        unpaidUsed,
        totalAllocated,
        totalUsed,
        totalRemaining: Math.max(0, Number((totalAllocated - totalUsed).toFixed(2))),
        updatedAt: b.updated_at ? new Date(b.updated_at).toISOString() : undefined
      };
    });

    return {
      leaveYear,
      canReview: isAdminOrHr,
      myEmployee: myProfile,
      leaves,
      balances
    };
  }

  public async applyLeave(actor: any, payload: any) {
    this.assertDbConnected();
    const targetEmp = await this.resolveEmployeeForLeave(actor, payload?.employeeId);
    const leaveType = String(payload?.leaveType || 'CASUAL').trim().toUpperCase();
    if (!['CASUAL', 'SICK', 'EARNED', 'UNPAID'].includes(leaveType)) {
      const err: any = new Error('Invalid leave type. Choose CASUAL, SICK, EARNED, or UNPAID.');
      err.statusCode = 400;
      throw err;
    }

    const startDate = String(payload?.startDate || '').trim().slice(0, 10);
    const endDate = String(payload?.endDate || startDate).trim().slice(0, 10);
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRe.test(startDate) || !dateRe.test(endDate)) {
      const err: any = new Error('Valid start date and end date (YYYY-MM-DD) are required.');
      err.statusCode = 400;
      throw err;
    }
    if (endDate < startDate) {
      const err: any = new Error('End date cannot be earlier than start date.');
      err.statusCode = 400;
      throw err;
    }

    const isHalfDay = Boolean(payload?.isHalfDay);
    if (isHalfDay && startDate !== endDate) {
      const err: any = new Error('Half-day leave can only be applied for a single date (start date = end date).');
      err.statusCode = 400;
      throw err;
    }
    const halfDaySession = isHalfDay ? String(payload?.halfDaySession || 'FIRST_HALF').trim() : '';

    const sMs = Date.parse(`${startDate}T00:00:00Z`);
    const eMs = Date.parse(`${endDate}T00:00:00Z`);
    const totalDays = isHalfDay ? 0.5 : Math.round((eMs - sMs) / 86400000) + 1;
    if (totalDays <= 0 || totalDays > 180) {
      const err: any = new Error('Leave duration must be between 0.5 and 180 days.');
      err.statusCode = 400;
      throw err;
    }

    const reason = String(payload?.reason || '').trim();
    if (reason.length < 3) {
      const err: any = new Error('Please enter a valid reason for leave (minimum 3 characters).');
      err.statusCode = 400;
      throw err;
    }

    const leaveYear = Number(startDate.slice(0, 4));
    const conn = await this.pool!.getConnection();
    try {
      await conn.beginTransaction();
      await this.ensureLeaveBalanceRow(conn, targetEmp.employeeId, leaveYear);

      // Prevent overlapping PENDING/APPROVED applications
      const [overlapRows]: any = await conn.query(
        `SELECT id, start_date, end_date, status FROM \`solar_leave_requests\`
         WHERE \`employee_id\` = ? AND \`status\` IN ('PENDING', 'APPROVED')
           AND \`start_date\` <= ? AND \`end_date\` >= ?
         LIMIT 1 FOR UPDATE`,
        [targetEmp.employeeId, endDate, startDate]
      );
      if (Array.isArray(overlapRows) && overlapRows.length > 0) {
        const err: any = new Error(`Leave dates overlap with an existing ${overlapRows[0].status} application (${String(overlapRows[0].start_date).slice(0, 10)} to ${String(overlapRows[0].end_date).slice(0, 10)}).`);
        err.statusCode = 409;
        throw err;
      }

      // Enforce paid leave balance check
      if (leaveType !== 'UNPAID') {
        const [balRows]: any = await conn.query(
          'SELECT * FROM `solar_leave_balances` WHERE `employee_id` = ? AND `leave_year` = ? LIMIT 1 FOR UPDATE',
          [targetEmp.employeeId, leaveYear]
        );
        const bal = balRows?.[0] || {};
        const [pendRows]: any = await conn.query(
          `SELECT COALESCE(SUM(\`total_days\`), 0) AS pend_days FROM \`solar_leave_requests\`
           WHERE \`employee_id\` = ? AND \`leave_year\` = ? AND \`leave_type\` = ? AND \`status\` = 'PENDING'`,
          [targetEmp.employeeId, leaveYear, leaveType]
        );
        const pendDays = Number(pendRows?.[0]?.pend_days) || 0;
        const totalQuota = leaveType === 'CASUAL'
          ? Number(bal.casual_total ?? 12)
          : leaveType === 'SICK'
            ? Number(bal.sick_total ?? 8)
            : Number(bal.earned_total ?? 15);
        const usedDays = leaveType === 'CASUAL'
          ? Number(bal.casual_used ?? 0)
          : leaveType === 'SICK'
            ? Number(bal.sick_used ?? 0)
            : Number(bal.earned_used ?? 0);
        const available = totalQuota - usedDays - pendDays;
        if (totalDays > available + 0.001) {
          const err: any = new Error(`Insufficient ${leaveType} leave balance. Available (after pending): ${Math.max(0, available)} day(s). Select UNPAID leave if exhausted.`);
          err.statusCode = 400;
          throw err;
        }
      }

      const id = `lv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      await conn.query(
        `INSERT INTO \`solar_leave_requests\` (
          \`id\`, \`employee_id\`, \`employee_code\`, \`employee_name\`, \`department\`, \`designation\`,
          \`leave_type\`, \`start_date\`, \`end_date\`, \`total_days\`, \`is_half_day\`, \`half_day_session\`,
          \`reason\`, \`status\`, \`leave_year\`, \`applied_at\`
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, NOW())`,
        [
          id,
          targetEmp.employeeId,
          targetEmp.employeeCode,
          targetEmp.employeeName,
          targetEmp.department,
          targetEmp.designation,
          leaveType,
          startDate,
          endDate,
          totalDays,
          isHalfDay ? 1 : 0,
          halfDaySession,
          reason,
          leaveYear
        ]
      );

      const [savedRows]: any = await conn.query('SELECT * FROM `solar_leave_requests` WHERE `id` = ? LIMIT 1', [id]);
      await conn.commit();
      return this.mapLeaveRow(savedRows[0]);
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }

  public async reviewLeave(actor: any, leaveId: string, action: string, remarks?: string) {
    this.assertDbConnected();
    const nextAction = String(action || '').trim().toUpperCase();
    const targetStatus = nextAction === 'APPROVE' || nextAction === 'APPROVED'
      ? 'APPROVED'
      : nextAction === 'REJECT' || nextAction === 'REJECTED'
        ? 'REJECTED'
        : '';
    if (!targetStatus) {
      const err: any = new Error('Invalid review action. Must be APPROVE or REJECT.');
      err.statusCode = 400;
      throw err;
    }

    const cleanRemarks = String(remarks || '').trim();
    const conn = await this.pool!.getConnection();
    try {
      await conn.beginTransaction();
      const [rows]: any = await conn.query(
        'SELECT * FROM `solar_leave_requests` WHERE `id` = ? LIMIT 1 FOR UPDATE',
        [leaveId]
      );
      if (!Array.isArray(rows) || rows.length === 0) {
        const err: any = new Error('Leave application not found.');
        err.statusCode = 404;
        throw err;
      }

      const lv = rows[0];
      const prevStatus = String(lv.status || 'PENDING').toUpperCase();
      if (prevStatus === 'CANCELLED') {
        const err: any = new Error('Cannot review a cancelled leave application.');
        err.statusCode = 400;
        throw err;
      }

      const empId = lv.employee_id;
      const leaveYear = Number(lv.leave_year) || new Date().getFullYear();
      const totalDays = Number(lv.total_days) || 0;
      const lType = String(lv.leave_type || 'CASUAL').toUpperCase();
      const usedCol = lType === 'CASUAL'
        ? 'casual_used'
        : lType === 'SICK'
          ? 'sick_used'
          : lType === 'EARNED'
            ? 'earned_used'
            : 'unpaid_used';

      await this.ensureLeaveBalanceRow(conn, empId, leaveYear);
      const [balRows]: any = await conn.query(
        'SELECT * FROM `solar_leave_balances` WHERE `employee_id` = ? AND `leave_year` = ? LIMIT 1 FOR UPDATE',
        [empId, leaveYear]
      );
      const bal = balRows?.[0] || {};

      if (targetStatus === 'APPROVED' && prevStatus !== 'APPROVED') {
        if (lType !== 'UNPAID') {
          const totalCol = lType === 'CASUAL' ? 'casual_total' : lType === 'SICK' ? 'sick_total' : 'earned_total';
          const quota = Number(bal[totalCol] ?? (lType === 'CASUAL' ? 12 : lType === 'SICK' ? 8 : 15));
          const used = Number(bal[usedCol] ?? 0);
          if (used + totalDays > quota + 0.001) {
            const err: any = new Error(`Cannot approve: ${lType} balance insufficient (Remaining: ${Math.max(0, quota - used)} day(s), Requested: ${totalDays} day(s)).`);
            err.statusCode = 400;
            throw err;
          }
        }
        await conn.query(
          `UPDATE \`solar_leave_balances\` SET \`${usedCol}\` = \`${usedCol}\` + ? WHERE \`employee_id\` = ? AND \`leave_year\` = ?`,
          [totalDays, empId, leaveYear]
        );
      } else if (targetStatus === 'REJECTED' && prevStatus === 'APPROVED') {
        await conn.query(
          `UPDATE \`solar_leave_balances\` SET \`${usedCol}\` = GREATEST(0, \`${usedCol}\` - ?) WHERE \`employee_id\` = ? AND \`leave_year\` = ?`,
          [totalDays, empId, leaveYear]
        );
      }

      await conn.query(
        `UPDATE \`solar_leave_requests\`
         SET \`status\` = ?, \`reviewed_by\` = ?, \`reviewer_id\` = ?, \`reviewed_at\` = NOW(), \`admin_remarks\` = ?, \`updated_at\` = CURRENT_TIMESTAMP
         WHERE \`id\` = ?`,
        [targetStatus, actor?.name || 'Administrator', actor?.id || '', cleanRemarks || null, leaveId]
      );

      const [updatedRows]: any = await conn.query('SELECT * FROM `solar_leave_requests` WHERE `id` = ? LIMIT 1', [leaveId]);
      await conn.commit();
      return this.mapLeaveRow(updatedRows[0]);
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }

  public async cancelLeave(actor: any, leaveId: string, remarks?: string) {
    this.assertDbConnected();
    const roleUpper = String(actor?.role || '').trim().toUpperCase();
    const isAdminOrHr = roleUpper === 'ADMIN' || roleUpper === 'SUPER ADMIN' || roleUpper === 'HR MANAGER';
    const myProfile = await this.resolveEmployeeForLeave(actor);
    const myIdVariants = new Set([
      myProfile.employeeId,
      String(actor?.id || '').trim(),
      String(actor?.employeeId || '').trim()
    ].filter(Boolean));

    const conn = await this.pool!.getConnection();
    try {
      await conn.beginTransaction();
      const [rows]: any = await conn.query(
        'SELECT * FROM `solar_leave_requests` WHERE `id` = ? LIMIT 1 FOR UPDATE',
        [leaveId]
      );
      if (!Array.isArray(rows) || rows.length === 0) {
        const err: any = new Error('Leave application not found.');
        err.statusCode = 404;
        throw err;
      }

      const lv = rows[0];
      if (!isAdminOrHr && !myIdVariants.has(String(lv.employee_id))) {
        const err: any = new Error('Access denied: You can only cancel your own leave requests.');
        err.statusCode = 403;
        throw err;
      }
      const prevStatus = String(lv.status || 'PENDING').toUpperCase();
      if (!isAdminOrHr && prevStatus !== 'PENDING') {
        const err: any = new Error('Only pending leave applications can be cancelled by an employee.');
        err.statusCode = 400;
        throw err;
      }

      if (prevStatus === 'APPROVED') {
        const lType = String(lv.leave_type || 'CASUAL').toUpperCase();
        const usedCol = lType === 'CASUAL'
          ? 'casual_used'
          : lType === 'SICK'
            ? 'sick_used'
            : lType === 'EARNED'
              ? 'earned_used'
              : 'unpaid_used';
        await conn.query(
          `UPDATE \`solar_leave_balances\` SET \`${usedCol}\` = GREATEST(0, \`${usedCol}\` - ?) WHERE \`employee_id\` = ? AND \`leave_year\` = ?`,
          [Number(lv.total_days) || 0, lv.employee_id, Number(lv.leave_year) || new Date().getFullYear()]
        );
      }

      await conn.query(
        `UPDATE \`solar_leave_requests\`
         SET \`status\` = 'CANCELLED', \`admin_remarks\` = COALESCE(?, \`admin_remarks\`), \`updated_at\` = CURRENT_TIMESTAMP
         WHERE \`id\` = ?`,
        [remarks ? String(remarks).trim() : null, leaveId]
      );

      const [updatedRows]: any = await conn.query('SELECT * FROM `solar_leave_requests` WHERE `id` = ? LIMIT 1', [leaveId]);
      await conn.commit();
      return this.mapLeaveRow(updatedRows[0]);
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }

  // ==========================================================
  // CRUD: QUOTATIONS
  // ==========================================================
  public async getQuotations(): Promise<any[]> {
    if (!this.isConnected) return this.getFallbackItems('quotations');
    this.assertDbConnected();
    const [rows] = await this.pool!.query('SELECT * FROM `solar_quotations` ORDER BY `created_at` DESC');
    const mapped = (rows as any[]).map(r => {
      let items = [];
      try { if (r.items_json) items = JSON.parse(r.items_json); } catch {}
      return {
        id: r.id,
        quotationNumber: r.quotation_number,
        customerId: r.customer_id,
        customerName: r.customer_name,
        projectId: r.project_id,
        capacityKw: Number(r.capacity_kw) || 0,
        ratePerWp: Number(r.rate_per_wp) || 0,
        baseAmount: Number(r.base_amount) || 0,
        taxAmount: Number(r.tax_amount) || 0,
        panelBrand: r.panel_brand,
        inverterBrand: r.inverter_brand,
        structureType: r.structure_type,
        items,
        subtotal: Number(r.subtotal) || 0,
        discountAmount: Number(r.discount_amount) || 0,
        gstPercent: Number(r.gst_percent) || 13.80,
        gstAmount: Number(r.gst_amount) || 0,
        totalAmount: Number(r.total_amount) || 0,
        paymentTerms: r.payment_terms,
        warrantyDetails: r.warranty_details,
        termsAndConditions: r.terms_and_conditions,
        status: r.status,
        validUntil: r.valid_until,
        createdAt: r.created_at,
        acceptedAt: r.accepted_at
      };
    });
    this.setFallbackItems('quotations', mapped);
    return mapped;
  }

  public async saveQuotation(item: any): Promise<any> {
    this.assertDbConnected();
    const sql = `
      INSERT INTO \`solar_quotations\` (
        \`id\`, \`quotation_number\`, \`customer_id\`, \`customer_name\`, \`project_id\`,
        \`capacity_kw\`, \`rate_per_wp\`, \`base_amount\`, \`tax_amount\`,
        \`panel_brand\`, \`inverter_brand\`, \`structure_type\`, \`items_json\`,
        \`subtotal\`, \`discount_amount\`, \`gst_percent\`, \`gst_amount\`, \`total_amount\`,
        \`payment_terms\`,\`warranty_details\`,\`terms_and_conditions\`,\`status\`, \`valid_until\`
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        \`customer_name\` = VALUES(\`customer_name\`), \`capacity_kw\` = VALUES(\`capacity_kw\`),
        \`rate_per_wp\` = VALUES(\`rate_per_wp\`), \`base_amount\` = VALUES(\`base_amount\`),
        \`tax_amount\` = VALUES(\`tax_amount\`), \`panel_brand\` = VALUES(\`panel_brand\`),
        \`inverter_brand\` = VALUES(\`inverter_brand\`), \`structure_type\` = VALUES(\`structure_type\`),
        \`items_json\` = VALUES(\`items_json\`), \`subtotal\` = VALUES(\`subtotal\`),
        \`discount_amount\` = VALUES(\`discount_amount\`), \`gst_percent\` = VALUES(\`gst_percent\`),
        \`gst_amount\` = VALUES(\`gst_amount\`), \`total_amount\` = VALUES(\`total_amount\`),
        \`payment_terms\` = VALUES(\`payment_terms\`), \`warranty_details\` = VALUES(\`warranty_details\`),
        \`terms_and_conditions\` = VALUES(\`terms_and_conditions\`), \`status\` = VALUES(\`status\`),
        \`valid_until\` = VALUES(\`valid_until\`)
    `;
    await this.pool!.query(sql, [
      item.id,
      item.quotationNumber || item.id,
      item.customerId || '',
      item.customerName || '',
      item.projectId || '',
      Number(item.capacityKw) || 0,
      Number(item.ratePerWp) || 0,
      Number(item.baseAmount) || 0,
      Number(item.taxAmount) || 0,
      item.panelBrand || '',
      item.inverterBrand || '',
      item.structureType || '',
      JSON.stringify(item.items || []),
      Number(item.subtotal) || 0,
      Number(item.discountAmount) || 0,
      Number(item.gstPercent) || 13.80,
      Number(item.gstAmount) || 0,
      Number(item.totalAmount) || 0,
      item.paymentTerms || '',
      item.warrantyDetails || '',
      item.termsAndConditions || '',
      item.status || 'SENT',
      item.validUntil ? String(item.validUntil).split('T')[0] : null
    ]);

    const items = this.getFallbackItems('quotations');
    const idx = items.findIndex(q => q.id === item.id);
    if (idx >= 0) items[idx] = { ...items[idx], ...item };
    else items.unshift(item);
    this.setFallbackItems('quotations', items);
    return item;
  }

  public async deleteQuotation(id: string): Promise<boolean> {
    this.assertDbConnected();
    await this.pool!.query('DELETE FROM `solar_quotations` WHERE `id` = ?', [id]);
    const items = this.getFallbackItems('quotations').filter(q => q.id !== id);
    this.setFallbackItems('quotations', items);
    return true;
  }

  // ==========================================================
  // CRUD: SITE SURVEYS
  // ==========================================================
  public async getSurveys(): Promise<any[]> {
    if (!this.isConnected) return this.getFallbackItems('surveys');
    this.assertDbConnected();
    const [rows] = await this.pool!.query('SELECT * FROM `solar_site_surveys` ORDER BY `survey_date` DESC');
    const mapped = (rows as any[]).map(r => ({
      id: r.id,
      projectId: r.project_id,
      customerId: r.customer_id,
      engineerId: r.engineer_id,
      engineerName: r.engineer_name,
      surveyDate: r.survey_date,
      status: r.status,
      siteAddress: r.site_address,
      latitude: r.latitude ? Number(r.latitude) : null,
      longitude: r.longitude ? Number(r.longitude) : null,
      locationName: r.location_name,
      roofType: r.roof_type,
      roofAreaSqft: Number(r.roof_area_sqft) || 0,
      shadowFreeAreaSqft: Number(r.shadow_free_area_sqft) || 0,
      recommendedCapacityKw: Number(r.recommended_capacity_kw) || 0,
      feasibilityScore: r.feasibility_score,
      photos: r.photos_json ? JSON.parse(r.photos_json) : [],
      notes: r.notes,
      createdAt: r.created_at
    }));
    this.setFallbackItems('surveys', mapped);
    return mapped;
  }

  public async saveSurvey(item: any): Promise<any> {
    this.assertDbConnected();
    const sql = `
      INSERT INTO \`solar_site_surveys\` (
        \`id\`, \`project_id\`, \`customer_id\`, \`engineer_id\`, \`engineer_name\`,
        \`survey_date\`, \`status\`, \`site_address\`, \`latitude\`, \`longitude\`,
        \`location_name\`, \`roof_type\`, \`roof_area_sqft\`, \`shadow_free_area_sqft\`,
        \`recommended_capacity_kw\`, \`feasibility_score\`, \`photos_json\`, \`notes\`
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        \`engineer_name\` = VALUES(\`engineer_name\`), \`status\` = VALUES(\`status\`),
        \`site_address\` = VALUES(\`site_address\`), \`latitude\` = VALUES(\`latitude\`),
        \`longitude\` = VALUES(\`longitude\`), \`roof_type\` = VALUES(\`roof_type\`),
        \`recommended_capacity_kw\` = VALUES(\`recommended_capacity_kw\`),
        \`feasibility_score\` = VALUES(\`feasibility_score\`),
        \`photos_json\` = VALUES(\`photos_json\`), \`notes\` = VALUES(\`notes\`)
    `;
    await this.pool!.query(sql, [
      item.id,
      item.projectId || item.leadId || '',
      item.customerId || '',
      item.engineerId || '',
      item.engineerName || item.engineer_name || 'Site Engineer',
      item.surveyDate ? String(item.surveyDate).split('T')[0] : new Date().toISOString().split('T')[0],
      item.status || 'APPROVED',
      item.siteAddress || item.address || 'Site Address',
      item.latitude || null,
      item.longitude || null,
      item.locationName || item.city || '',
      item.roofType || 'RCC Flat',
      Number(item.roofAreaSqft || item.roofAreaSqFt) || 0,
      Number(item.shadowFreeAreaSqft || item.shadowFreeAreaSqFt) || 0,
      Number(item.recommendedCapacityKw || item.proposedCapacityKw) || 0,
      item.feasibilityScore || 'EXCELLENT',
      JSON.stringify(item.photos || []),
      item.notes || ''
    ]);

    const items = this.getFallbackItems('surveys');
    const idx = items.findIndex(s => s.id === item.id);
    if (idx >= 0) items[idx] = { ...items[idx], ...item };
    else items.unshift(item);
    this.setFallbackItems('surveys', items);
    return item;
  }

  public async deleteSurvey(id: string): Promise<boolean> {
    this.assertDbConnected();
    await this.pool!.query('DELETE FROM `solar_site_surveys` WHERE `id` = ?', [id]);
    const items = this.getFallbackItems('surveys').filter(s => s.id !== id);
    this.setFallbackItems('surveys', items);
    return true;
  }

  // ==========================================================
  // CRUD: SERVICE TICKETS
  // ==========================================================
  // ==========================================================
  // CRUD: SERVICE TICKETS (WITH ADMIN ASSIGNMENT & AUDIT HISTORY)
  // ==========================================================
  private normalizeTicketTechnician(techIdRaw?: any, techNameRaw?: any): {
    assignedTechnicianId: string;
    assignedTechnicianName: string;
    assignmentStatus: 'ASSIGNED' | 'UNASSIGNED';
  } {
    const cleanId = String(techIdRaw || '').trim();
    const cleanName = String(techNameRaw || '').trim();
    const isPlaceholderName =
      !cleanName ||
      cleanName.toLowerCase() === 'unassigned' ||
      cleanName.toLowerCase() === 'to be assigned';
    if (!cleanId && isPlaceholderName) {
      return {
        assignedTechnicianId: '',
        assignedTechnicianName: '',
        assignmentStatus: 'UNASSIGNED'
      };
    }
    return {
      assignedTechnicianId: cleanId,
      assignedTechnicianName: isPlaceholderName ? '' : cleanName,
      assignmentStatus: cleanId || !isPlaceholderName ? 'ASSIGNED' : 'UNASSIGNED'
    };
  }

  private mapServiceTicketRow(r: any, historyRows: any[] = []): any {
    const tech = this.normalizeTicketTechnician(r.assigned_technician_id, r.assigned_technician_name);
    let photos: any[] = [];
    if (r.photos_json) {
      try {
        const parsed = JSON.parse(r.photos_json);
        photos = Array.isArray(parsed) ? parsed : [];
      } catch {
        photos = [];
      }
    }
    return {
      id: r.id,
      ticketId: r.ticket_id,
      ticketNumber: r.ticket_id,
      customerId: r.customer_id || '',
      customerName: r.customer_name || '',
      projectId: r.project_id || '',
      projectTitle: r.project_title || '',
      projectCode: r.project_title || '',
      title: r.issue,
      issue: r.issue,
      description: r.issue,
      category: r.category || 'Inverter Warning',
      priority: r.priority || 'MEDIUM',
      status: r.status || 'OPEN',
      assignedTechnicianId: tech.assignedTechnicianId,
      assignedTechnicianName: tech.assignedTechnicianName,
      assignedToName: tech.assignedTechnicianName || 'Unassigned',
      assignedEngineerId: tech.assignedTechnicianId,
      assignedEngineerName: tech.assignedTechnicianName,
      assignmentStatus: tech.assignmentStatus,
      scheduledDate: r.scheduled_date || null,
      visitScheduledDate: r.scheduled_date || null,
      createdDate: r.scheduled_date || r.created_at,
      resolvedDate: r.resolved_date || null,
      notes: r.notes || '',
      technicianRemarks: r.technician_remarks || '',
      resolutionDetails: r.resolution_details || '',
      assignedAt: r.assigned_at || null,
      assignedByUserId: r.assigned_by_user_id || null,
      assignedByName: r.assigned_by_name || null,
      photos,
      createdAt: r.created_at,
      updatedAt: r.updated_at || r.created_at,
      activityHistory: historyRows
    };
  }

  private mapTicketHistoryRow(h: any): any {
    return {
      id: h.id,
      ticketRecordId: h.ticket_record_id,
      ticketCode: h.ticket_code || '',
      actionType: h.action_type,
      previousValue: h.previous_value ?? null,
      newValue: h.new_value ?? null,
      remarks: h.remarks ?? null,
      actorUserId: h.actor_user_id || '',
      actorName: h.actor_name || 'System',
      actorRole: h.actor_role || '',
      createdAt: h.created_at
    };
  }

  public async recordServiceTicketHistory(entry: {
    ticketRecordId: string;
    ticketCode?: string;
    actionType: string;
    previousValue?: string | null;
    newValue?: string | null;
    remarks?: string | null;
    actor?: any;
  }): Promise<any> {
    this.assertDbConnected();
    const id = `srvhist-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const actorId = String(entry.actor?.id || entry.actor?.userId || '').trim();
    const actorName = String(entry.actor?.name || entry.actor?.email || 'System').trim();
    const actorRole = String(entry.actor?.role || '').trim();
    await this.pool!.query(
      `INSERT INTO \`solar_service_ticket_history\`
       (\`id\`, \`ticket_record_id\`, \`ticket_code\`, \`action_type\`, \`previous_value\`, \`new_value\`, \`remarks\`, \`actor_user_id\`, \`actor_name\`, \`actor_role\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        entry.ticketRecordId,
        entry.ticketCode || '',
        entry.actionType,
        entry.previousValue ?? null,
        entry.newValue ?? null,
        entry.remarks ?? null,
        actorId,
        actorName,
        actorRole
      ]
    );
    return {
      id,
      ticketRecordId: entry.ticketRecordId,
      ticketCode: entry.ticketCode || '',
      actionType: entry.actionType,
      previousValue: entry.previousValue ?? null,
      newValue: entry.newValue ?? null,
      remarks: entry.remarks ?? null,
      actorUserId: actorId,
      actorName,
      actorRole,
      createdAt: new Date().toISOString()
    };
  }

  public async getServiceTicketHistory(ticketRecordId: string): Promise<any[]> {
    this.assertDbConnected();
    const [rows]: any = await this.pool!.query(
      'SELECT * FROM `solar_service_ticket_history` WHERE `ticket_record_id` = ? ORDER BY `created_at` DESC, `id` DESC',
      [ticketRecordId]
    );
    return (rows || []).map((h: any) => this.mapTicketHistoryRow(h));
  }

  public async getEligibleServiceTechnicians(): Promise<any[]> {
    this.assertDbConnected();
    const seenIds = new Set<string>();
    const seenEmails = new Set<string>();
    const results: any[] = [];

    const addIfEligible = (rec: {
      id: string;
      employeeCode: string;
      name: string;
      email: string;
      role: string;
      department: string;
      designation: string;
      phone: string;
      isFieldWorker: boolean;
      active: boolean;
    }) => {
      if (!rec.active) return;
      if (!this.isEligibleFieldWorkerRole(rec.role, rec.isFieldWorker, rec.department)) return;
      const idKey = rec.id.trim().toLowerCase();
      const emailKey = rec.email.trim().toLowerCase();
      if (!idKey) return;
      if (seenIds.has(idKey) || (emailKey && seenEmails.has(emailKey))) return;
      seenIds.add(idKey);
      if (emailKey) seenEmails.add(emailKey);
      results.push({
        id: rec.id,
        employeeCode: rec.employeeCode || rec.id,
        name: rec.name,
        email: rec.email,
        phone: rec.phone,
        role: rec.role,
        department: rec.department,
        designation: rec.designation || rec.role,
        isFieldWorker: true,
        status: 'ACTIVE'
      });
    };

    for (const table of ['solar_employees', 'solar_employee']) {
      try {
        const [empRows]: any = await this.pool!.query(`SELECT * FROM \`${table}\` ORDER BY \`name\` ASC`);
        if (Array.isArray(empRows)) {
          for (const e of empRows) {
            const status = String(e.status || 'ACTIVE').toUpperCase();
            const acctStatus = String(e.account_status || 'ACTIVE').toUpperCase();
            const role = String(e.system_role || e.assigned_role || e.designation || 'Technician');
            const active =
              status !== 'DISABLED' &&
              status !== 'INACTIVE' &&
              status !== 'TERMINATED' &&
              acctStatus !== 'DISABLED' &&
              role.toLowerCase() !== 'customer';
            addIfEligible({
              id: String(e.id || ''),
              employeeCode: String(e.employee_code || e.id || ''),
              name: String(e.name || 'Technician'),
              email: String(e.email || '').trim().toLowerCase(),
              role,
              department: String(e.department || 'Service'),
              designation: String(e.designation || role),
              phone: String(e.phone || ''),
              isFieldWorker: Boolean(e.is_field_worker),
              active
            });
          }
        }
        if (empRows && empRows.length > 0) break;
      } catch {
        // Fallback to solar_employee if needed
      }
    }

    try {
      const [userRows]: any = await this.pool!.query('SELECT * FROM `solar_users` ORDER BY `name` ASC');
      if (Array.isArray(userRows)) {
        for (const u of userRows) {
          const status = String(u.status || 'ACTIVE').toUpperCase();
          const role = String(u.role || 'Staff');
          const active =
            status !== 'DISABLED' &&
            status !== 'INACTIVE' &&
            role.toLowerCase() !== 'customer';
          addIfEligible({
            id: String(u.id || ''),
            employeeCode: String(u.employee_id || u.id || ''),
            name: String(u.name || 'Technician'),
            email: String(u.email || '').trim().toLowerCase(),
            role,
            department: String(u.department || 'Service'),
            designation: String(u.designation || role),
            phone: String(u.phone || ''),
            isFieldWorker: Boolean(u.is_field_worker),
            active
          });
        }
      }
    } catch {
      // Ignore
    }

    results.sort((a, b) => a.name.localeCompare(b.name));
    return results;
  }

  public async getServiceTickets(): Promise<any[]> {
    if (!this.isConnected) return this.getFallbackItems('service_tickets');
    this.assertDbConnected();
    const [rows] = await this.pool!.query('SELECT * FROM `solar_service_tickets` ORDER BY `created_at` DESC');
    const historyByTicket = new Map<string, any[]>();
    try {
      const [hRows]: any = await this.pool!.query(
        'SELECT * FROM `solar_service_ticket_history` ORDER BY `created_at` DESC, `id` DESC'
      );
      for (const h of hRows || []) {
        const key = String(h.ticket_record_id || '');
        if (!historyByTicket.has(key)) historyByTicket.set(key, []);
        historyByTicket.get(key)!.push(this.mapTicketHistoryRow(h));
      }
    } catch {
      // History table optional if unmigrated
    }
    const mapped = (rows as any[]).map(r => this.mapServiceTicketRow(r, historyByTicket.get(r.id) || []));
    this.setFallbackItems('service_tickets', mapped);
    return mapped;
  }

  public async getServiceTicketRowByIdOrCode(idOrCode: string): Promise<any | null> {
    this.assertDbConnected();
    const clean = String(idOrCode || '').trim();
    if (!clean) return null;
    const [rows]: any = await this.pool!.query(
      'SELECT * FROM `solar_service_tickets` WHERE `id` = ? OR `ticket_id` = ? LIMIT 1',
      [clean, clean]
    );
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  }

  public async getServiceTicketDetails(idOrCode: string): Promise<any | null> {
    this.assertDbConnected();
    const row = await this.getServiceTicketRowByIdOrCode(idOrCode);
    if (!row) return null;
    const history = await this.getServiceTicketHistory(row.id);
    const ticket = this.mapServiceTicketRow(row, history);

    // Resolve Customer contact details from MySQL
    let customer: any = null;
    try {
      if (row.customer_id) {
        const [cRows]: any = await this.pool!.query('SELECT * FROM `solar_customers` WHERE `id` = ? LIMIT 1', [row.customer_id]);
        if (cRows?.length) customer = cRows[0];
      }
      if (!customer && row.customer_name) {
        const [cRows]: any = await this.pool!.query('SELECT * FROM `solar_customers` WHERE LOWER(`name`) = LOWER(?) LIMIT 1', [row.customer_name]);
        if (cRows?.length) customer = cRows[0];
      }
    } catch {}

    // Resolve Project / Site details from MySQL
    let project: any = null;
    try {
      if (row.project_id) {
        const [pRows]: any = await this.pool!.query('SELECT * FROM `solar_projects` WHERE `id` = ? OR `project_code` = ? LIMIT 1', [row.project_id, row.project_id]);
        if (pRows?.length) project = pRows[0];
      }
      if (!project && (customer?.active_project_id || customer?.id)) {
        const [pRows]: any = await this.pool!.query(
          'SELECT * FROM `solar_projects` WHERE `id` = ? OR `customer_id` = ? ORDER BY `created_at` DESC LIMIT 1',
          [customer?.active_project_id || '', customer?.id || '']
        );
        if (pRows?.length) project = pRows[0];
      }
    } catch {}

    // Resolve AMC / Warranty contracts from MySQL
    let amcContract: any = null;
    try {
      const targetProjId = project?.id || row.project_id || '';
      const targetCustId = customer?.id || row.customer_id || '';
      if (targetProjId || targetCustId) {
        const [aRows]: any = await this.pool!.query(
          'SELECT * FROM `solar_amc_contracts` WHERE (`project_id` = ? AND ? != "") OR (`customer_id` = ? AND ? != "") ORDER BY `end_date` DESC LIMIT 1',
          [targetProjId, targetProjId, targetCustId, targetCustId]
        );
        if (aRows?.length) amcContract = aRows[0];
      }
    } catch {}

    // Resolve Assigned Technician profile from MySQL
    let assignedTechnician: any = null;
    if (ticket.assignedTechnicianId) {
      try {
        const [eRows]: any = await this.pool!.query(
          'SELECT `id`, `employee_code`, `name`, `email`, `phone`, `department`, `designation`, `system_role`, `status` FROM `solar_employees` WHERE `id` = ? OR `auth_uid` = ? OR `employee_code` = ? LIMIT 1',
          [ticket.assignedTechnicianId, ticket.assignedTechnicianId, ticket.assignedTechnicianId]
        );
        if (eRows?.length) {
          const e = eRows[0];
          assignedTechnician = {
            id: e.id,
            employeeCode: e.employee_code || e.id,
            name: e.name,
            email: e.email || '',
            phone: e.phone || '',
            department: e.department || 'Service',
            designation: e.designation || e.system_role || 'Technician',
            role: e.system_role || 'Technician',
            status: e.status || 'ACTIVE'
          };
        }
      } catch {}
    }

    return {
      ...ticket,
      customerDetails: customer
        ? {
            id: customer.id,
            customerCode: customer.customer_code,
            name: customer.name,
            companyName: customer.company_name || '',
            phone: customer.phone || '',
            email: customer.email || '',
            siteAddress: customer.site_address || '',
            city: customer.city || '',
            state: customer.state || '',
            pincode: customer.pincode || '',
            electricityConsumerNo: customer.electricity_consumer_no || '',
            sanctionedLoadKw: Number(customer.sanctioned_load_kw || 0)
          }
        : null,
      projectDetails: project
        ? {
            id: project.id,
            projectCode: project.project_code,
            title: project.title,
            capacityKw: Number(project.capacity_kw || 0),
            status: project.status,
            currentStageKey: project.current_stage_key || '',
            completionPercentage: Number(project.completion_percentage || 0),
            startDate: project.start_date || null,
            targetCompletionDate: project.target_completion_date || null,
            siteAddress: customer?.site_address || ''
          }
        : null,
      amcDetails: amcContract
        ? {
            id: amcContract.id,
            amcCode: amcContract.amc_code,
            planName: amcContract.plan_name,
            startDate: amcContract.start_date,
            endDate: amcContract.end_date,
            renewalDate: amcContract.renewal_date,
            annualAmount: Number(amcContract.annual_amount || 0),
            visitsCompleted: Number(amcContract.visits_completed || 0),
            totalVisits: Number(amcContract.total_visits || 4),
            status: amcContract.status
          }
        : null,
      assignedTechnicianDetails: assignedTechnician
    };
  }

  public async saveServiceTicket(item: any, actor?: any): Promise<any> {
    this.assertDbConnected();
    const existing = await this.getExistingRow('solar_service_tickets', item.id);
    const ticketId = item.ticketId ?? item.ticket_id ?? item.ticketNumber ?? item.ticket_number ?? existing?.ticket_id ?? item.id;
    const customerId = item.customerId ?? item.customer_id ?? existing?.customer_id ?? '';
    const customerName = item.customerName ?? item.customer_name ?? existing?.customer_name ?? 'Solar Customer';
    const projectId = item.projectId ?? item.project_id ?? existing?.project_id ?? '';
    const projectTitle = item.projectTitle ?? item.project_title ?? item.projectCode ?? existing?.project_title ?? 'Solar Project Installation';
    const issue = item.issue ?? item.title ?? item.description ?? existing?.issue ?? 'Service Ticket Alert';
    const category = item.category ?? existing?.category ?? 'Inverter Warning';
    const priority = item.priority ?? existing?.priority ?? 'MEDIUM';
    const rawTechId = item.assignedTechnicianId ?? item.assignedEngineerId ?? existing?.assigned_technician_id ?? '';
    const rawTechName = item.assignedTechnicianName ?? item.assignedEngineerName ?? existing?.assigned_technician_name ?? '';
    const normTech = this.normalizeTicketTechnician(rawTechId, rawTechName);
    const status = item.status ?? existing?.status ?? 'OPEN';
    const rawSched = item.scheduledDate ?? item.visitScheduledDate ?? item.createdDate ?? existing?.scheduled_date;
    const scheduledDate = this.toSqlDate(rawSched);
    const rawResolved = item.resolvedDate ?? existing?.resolved_date;
    const resolvedDate = this.toSqlDate(rawResolved);
    const notes = item.notes ?? existing?.notes ?? '';
    const technicianRemarks = item.technicianRemarks ?? item.technician_remarks ?? existing?.technician_remarks ?? '';
    const resolutionDetails = item.resolutionDetails ?? item.resolution_details ?? existing?.resolution_details ?? '';
    const rawPhotos = item.photos ?? (existing?.photos_json ? JSON.parse(existing.photos_json) : []);
    const photosJson = typeof rawPhotos === 'string' ? rawPhotos : JSON.stringify(rawPhotos);

    const sql = `
      INSERT INTO \`solar_service_tickets\` (
        \`id\`, \`ticket_id\`, \`customer_id\`, \`customer_name\`, \`project_id\`,
        \`project_title\`, \`issue\`, \`category\`, \`priority\`,
        \`assigned_technician_id\`, \`assigned_technician_name\`, \`status\`,
        \`scheduled_date\`, \`resolved_date\`, \`notes\`, \`technician_remarks\`, \`resolution_details\`, \`photos_json\`
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        \`customer_id\` = VALUES(\`customer_id\`),
        \`customer_name\` = VALUES(\`customer_name\`),
        \`project_id\` = VALUES(\`project_id\`),
        \`project_title\` = VALUES(\`project_title\`),
        \`issue\` = VALUES(\`issue\`),
        \`category\` = VALUES(\`category\`),
        \`priority\` = VALUES(\`priority\`),
        \`status\` = VALUES(\`status\`),
        \`assigned_technician_id\` = VALUES(\`assigned_technician_id\`),
        \`assigned_technician_name\` = VALUES(\`assigned_technician_name\`),
        \`scheduled_date\` = VALUES(\`scheduled_date\`),
        \`resolved_date\` = VALUES(\`resolved_date\`),
        \`notes\` = VALUES(\`notes\`),
        \`technician_remarks\` = VALUES(\`technician_remarks\`),
        \`resolution_details\` = VALUES(\`resolution_details\`),
        \`photos_json\` = VALUES(\`photos_json\`)
    `;
    await this.pool!.query(sql, [
      item.id,
      ticketId,
      customerId,
      customerName,
      projectId,
      projectTitle,
      issue,
      category,
      priority,
      normTech.assignedTechnicianId,
      normTech.assignedTechnicianName,
      status,
      scheduledDate,
      resolvedDate,
      notes,
      technicianRemarks,
      resolutionDetails,
      photosJson
    ]);

    if (!existing) {
      await this.recordServiceTicketHistory({
        ticketRecordId: item.id,
        ticketCode: ticketId,
        actionType: 'CREATED',
        previousValue: null,
        newValue: `Status: ${status} | Priority: ${priority}`,
        remarks: issue,
        actor
      }).catch(() => {});
    }

    const updated = await this.getServiceTicketRowByIdOrCode(item.id);
    const history = updated ? await this.getServiceTicketHistory(updated.id) : [];
    const mapped = updated ? this.mapServiceTicketRow(updated, history) : item;

    const items = this.getFallbackItems('service_tickets');
    const idx = items.findIndex(t => t.id === mapped.id);
    if (idx >= 0) items[idx] = mapped;
    else items.unshift(mapped);
    this.setFallbackItems('service_tickets', items);
    return mapped;
  }

  public async assignServiceTicketTechnician(
    ticketIdOrRecordId: string,
    payload: { technicianId?: string | null; scheduledDate?: string | null; remarks?: string | null },
    actor: any
  ): Promise<any> {
    this.assertDbConnected();
    const existing = await this.getServiceTicketRowByIdOrCode(ticketIdOrRecordId);
    if (!existing) {
      const err: any = new Error('Service ticket not found in MySQL.');
      err.statusCode = 404;
      throw err;
    }

    const requestedTechId = String(payload.technicianId ?? '').trim();
    const prevTech = this.normalizeTicketTechnician(existing.assigned_technician_id, existing.assigned_technician_name);
    let nextTechId = '';
    let nextTechName = '';

    if (requestedTechId) {
      const eligible = await this.getEligibleServiceTechnicians();
      const matched = eligible.find(
        t =>
          t.id.toLowerCase() === requestedTechId.toLowerCase() ||
          t.employeeCode.toLowerCase() === requestedTechId.toLowerCase()
      );
      if (!matched) {
        const err: any = new Error('Selected technician is not an active eligible Field Worker / Technician in MySQL.');
        err.statusCode = 400;
        throw err;
      }
      nextTechId = matched.id;
      nextTechName = matched.name;
    }

    const prevStatus = String(existing.status || 'OPEN');
    let nextStatus = prevStatus;
    if (nextTechId && prevStatus === 'OPEN') {
      nextStatus = 'ASSIGNED';
    } else if (!nextTechId && prevStatus === 'ASSIGNED') {
      nextStatus = 'OPEN';
    }

    const nextScheduledDate =
      payload.scheduledDate !== undefined
        ? this.toSqlDate(payload.scheduledDate)
        : this.toSqlDate(existing.scheduled_date);

    const hasRemarks = payload.remarks !== undefined && payload.remarks !== null && String(payload.remarks).trim() !== '';
    const nextRemarks = hasRemarks ? String(payload.remarks).trim() : (existing.technician_remarks || '');
    const actorId = String(actor?.id || actor?.userId || '');
    const actorName = String(actor?.name || actor?.email || 'Admin');

    await this.pool!.query(
      `UPDATE \`solar_service_tickets\`
       SET \`assigned_technician_id\` = ?,
           \`assigned_technician_name\` = ?,
           \`status\` = ?,
           \`scheduled_date\` = ?,
           \`technician_remarks\` = ?,
           \`assigned_at\` = ?,
           \`assigned_by_user_id\` = ?,
           \`assigned_by_name\` = ?
       WHERE \`id\` = ?`,
      [
        nextTechId,
        nextTechName,
        nextStatus,
        nextScheduledDate,
        nextRemarks,
        nextTechId ? new Date() : null,
        nextTechId ? actorId : null,
        nextTechId ? actorName : null,
        existing.id
      ]
    );

    if (!nextTechId && (prevTech.assignedTechnicianId || prevTech.assignedTechnicianName)) {
      await this.recordServiceTicketHistory({
        ticketRecordId: existing.id,
        ticketCode: existing.ticket_id,
        actionType: 'TECHNICIAN_UNASSIGNED',
        previousValue: prevTech.assignedTechnicianName || prevTech.assignedTechnicianId,
        newValue: 'Unassigned',
        remarks: hasRemarks ? nextRemarks : null,
        actor
      });
    } else if (nextTechId && nextTechId !== prevTech.assignedTechnicianId) {
      await this.recordServiceTicketHistory({
        ticketRecordId: existing.id,
        ticketCode: existing.ticket_id,
        actionType: prevTech.assignedTechnicianId ? 'TECHNICIAN_REASSIGNED' : 'TECHNICIAN_ASSIGNED',
        previousValue: prevTech.assignedTechnicianName || 'Unassigned',
        newValue: nextTechName,
        remarks: hasRemarks ? nextRemarks : null,
        actor
      });
    } else if (hasRemarks && nextRemarks !== String(existing.technician_remarks || '')) {
      await this.recordServiceTicketHistory({
        ticketRecordId: existing.id,
        ticketCode: existing.ticket_id,
        actionType: 'REMARKS_UPDATED',
        previousValue: existing.technician_remarks || '',
        newValue: nextRemarks,
        remarks: null,
        actor
      });
    }

    if (nextStatus !== prevStatus) {
      await this.recordServiceTicketHistory({
        ticketRecordId: existing.id,
        ticketCode: existing.ticket_id,
        actionType: 'STATUS_UPDATED',
        previousValue: prevStatus,
        newValue: nextStatus,
        remarks: nextTechId ? `Technician: ${nextTechName}` : 'Technician unassigned',
        actor
      });
    }

    return await this.getServiceTicketDetails(existing.id);
  }

  public async adminUpdateServiceTicket(
    ticketIdOrRecordId: string,
    payload: any,
    actor: any
  ): Promise<any> {
    this.assertDbConnected();
    const existing = await this.getServiceTicketRowByIdOrCode(ticketIdOrRecordId);
    if (!existing) {
      const err: any = new Error('Service ticket not found in MySQL.');
      err.statusCode = 404;
      throw err;
    }

    const allowedStatuses = ['OPEN', 'ASSIGNED', 'VISIT SCHEDULED', 'IN PROGRESS', 'RESOLVED', 'CLOSED'];
    const allowedPriorities = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

    const prevStatus = String(existing.status || 'OPEN');
    const prevPriority = String(existing.priority || 'MEDIUM');
    const prevTech = this.normalizeTicketTechnician(existing.assigned_technician_id, existing.assigned_technician_name);
    const prevRemarks = String(existing.technician_remarks || '');
    const prevResolution = String(existing.resolution_details || '');
    const prevNotes = String(existing.notes || '');

    let nextTechId = prevTech.assignedTechnicianId;
    let nextTechName = prevTech.assignedTechnicianName;
    let techChanged = false;

    const hasTechField =
      payload.assignedTechnicianId !== undefined ||
      payload.technicianId !== undefined;
    if (hasTechField) {
      const reqTechId = String(payload.assignedTechnicianId ?? payload.technicianId ?? '').trim();
      if (reqTechId === '') {
        if (prevTech.assignedTechnicianId !== '' || prevTech.assignedTechnicianName !== '') {
          techChanged = true;
        }
        nextTechId = '';
        nextTechName = '';
      } else {
        const eligible = await this.getEligibleServiceTechnicians();
        const matched = eligible.find(
          t =>
            t.id.toLowerCase() === reqTechId.toLowerCase() ||
            t.employeeCode.toLowerCase() === reqTechId.toLowerCase()
        );
        if (!matched) {
          const err: any = new Error('Selected technician is not an active eligible Field Worker / Technician in MySQL.');
          err.statusCode = 400;
          throw err;
        }
        if (matched.id !== prevTech.assignedTechnicianId) {
          techChanged = true;
        }
        nextTechId = matched.id;
        nextTechName = matched.name;
      }
    }

    let nextStatus = prevStatus;
    if (payload.status !== undefined && payload.status !== null && String(payload.status).trim() !== '') {
      const candidateStatus = String(payload.status).trim().toUpperCase();
      if (!allowedStatuses.includes(candidateStatus)) {
        const err: any = new Error(`Invalid status "${payload.status}".`);
        err.statusCode = 400;
        throw err;
      }
      nextStatus = candidateStatus;
    } else if (techChanged) {
      if (nextTechId && prevStatus === 'OPEN') nextStatus = 'ASSIGNED';
      else if (!nextTechId && prevStatus === 'ASSIGNED') nextStatus = 'OPEN';
    }

    let nextPriority = prevPriority;
    if (payload.priority !== undefined && payload.priority !== null && String(payload.priority).trim() !== '') {
      const candidatePrio = String(payload.priority).trim().toUpperCase();
      if (!allowedPriorities.includes(candidatePrio)) {
        const err: any = new Error(`Invalid priority "${payload.priority}".`);
        err.statusCode = 400;
        throw err;
      }
      nextPriority = candidatePrio;
    }

    const nextScheduledDate =
      payload.scheduledDate !== undefined || payload.visitScheduledDate !== undefined
        ? this.toSqlDate(payload.scheduledDate ?? payload.visitScheduledDate)
        : this.toSqlDate(existing.scheduled_date);

    let nextResolvedDate =
      payload.resolvedDate !== undefined
        ? this.toSqlDate(payload.resolvedDate)
        : this.toSqlDate(existing.resolved_date);
    if ((nextStatus === 'RESOLVED' || nextStatus === 'CLOSED') && !nextResolvedDate) {
      nextResolvedDate = new Date().toISOString().slice(0, 10);
    } else if (nextStatus !== 'RESOLVED' && nextStatus !== 'CLOSED' && payload.status !== undefined) {
      nextResolvedDate = null;
    }

    const nextRemarks =
      payload.technicianRemarks !== undefined
        ? String(payload.technicianRemarks ?? '')
        : prevRemarks;
    const nextResolution =
      payload.resolutionDetails !== undefined
        ? String(payload.resolutionDetails ?? '')
        : prevResolution;
    const nextNotes =
      payload.notes !== undefined
        ? String(payload.notes ?? '')
        : prevNotes;

    const actorId = String(actor?.id || actor?.userId || '');
    const actorName = String(actor?.name || actor?.email || 'Admin');

    await this.pool!.query(
      `UPDATE \`solar_service_tickets\`
       SET \`assigned_technician_id\` = ?,
           \`assigned_technician_name\` = ?,
           \`status\` = ?,
           \`priority\` = ?,
           \`scheduled_date\` = ?,
           \`resolved_date\` = ?,
           \`notes\` = ?,
           \`technician_remarks\` = ?,
           \`resolution_details\` = ?,
           \`assigned_at\` = ?,
           \`assigned_by_user_id\` = ?,
           \`assigned_by_name\` = ?
       WHERE \`id\` = ?`,
      [
        nextTechId,
        nextTechName,
        nextStatus,
        nextPriority,
        nextScheduledDate,
        nextResolvedDate,
        nextNotes,
        nextRemarks,
        nextResolution,
        techChanged ? (nextTechId ? new Date() : null) : existing.assigned_at,
        techChanged ? (nextTechId ? actorId : null) : existing.assigned_by_user_id,
        techChanged ? (nextTechId ? actorName : null) : existing.assigned_by_name,
        existing.id
      ]
    );

    if (techChanged) {
      await this.recordServiceTicketHistory({
        ticketRecordId: existing.id,
        ticketCode: existing.ticket_id,
        actionType: !nextTechId
          ? 'TECHNICIAN_UNASSIGNED'
          : prevTech.assignedTechnicianId
          ? 'TECHNICIAN_REASSIGNED'
          : 'TECHNICIAN_ASSIGNED',
        previousValue: prevTech.assignedTechnicianName || 'Unassigned',
        newValue: nextTechName || 'Unassigned',
        remarks: null,
        actor
      });
    }
    if (nextStatus !== prevStatus) {
      await this.recordServiceTicketHistory({
        ticketRecordId: existing.id,
        ticketCode: existing.ticket_id,
        actionType: nextStatus === 'RESOLVED' ? 'RESOLVED' : 'STATUS_UPDATED',
        previousValue: prevStatus,
        newValue: nextStatus,
        remarks: nextResolution || nextRemarks || null,
        actor
      });
    }
    if (nextPriority !== prevPriority) {
      await this.recordServiceTicketHistory({
        ticketRecordId: existing.id,
        ticketCode: existing.ticket_id,
        actionType: 'PRIORITY_UPDATED',
        previousValue: prevPriority,
        newValue: nextPriority,
        remarks: null,
        actor
      });
    }
    if (nextRemarks !== prevRemarks || nextResolution !== prevResolution || nextNotes !== prevNotes) {
      await this.recordServiceTicketHistory({
        ticketRecordId: existing.id,
        ticketCode: existing.ticket_id,
        actionType: 'REMARKS_UPDATED',
        previousValue: prevRemarks || prevResolution || null,
        newValue: [nextRemarks, nextResolution].filter(Boolean).join(' | ') || nextNotes,
        remarks: null,
        actor
      });
    }

    return await this.getServiceTicketDetails(existing.id);
  }

  public async deleteServiceTicket(id: string): Promise<boolean> {
    this.assertDbConnected();
    await this.pool!.query('DELETE FROM `solar_service_ticket_history` WHERE `ticket_record_id` = ?', [id]).catch(() => {});
    await this.pool!.query('DELETE FROM `solar_service_tickets` WHERE `id` = ?', [id]);
    const items = this.getFallbackItems('service_tickets').filter(t => t.id !== id);
    this.setFallbackItems('service_tickets', items);
    return true;
  }

  // ==========================================================
  // CRUD: AMC CONTRACTS
  // ==========================================================
  public async getAMCContracts(): Promise<any[]> {
    if (!this.isConnected) return this.getFallbackItems('amc_contracts');
    this.assertDbConnected();
    const [rows] = await this.pool!.query('SELECT * FROM `solar_amc_contracts` ORDER BY `created_at` DESC');
    const mapped = (rows as any[]).map(r => ({
      id: r.id,
      amcCode: r.amc_code,
      contractNumber: r.amc_code,
      customerId: r.customer_id,
      customerName: r.customer_name,
      projectId: r.project_id,
      projectTitle: r.project_title,
      planName: r.plan_name,
      startDate: r.start_date,
      endDate: r.end_date,
      renewalDate: r.renewal_date,
      annualAmount: Number(r.annual_amount) || 0,
      contractValue: Number(r.annual_amount) || 0,
      visitsCompleted: Number(r.visits_completed) || 0,
      totalVisits: Number(r.total_visits) || 4,
      visitsPerYear: Number(r.total_visits) || 4,
      status: r.status,
      createdAt: r.created_at
    }));
    this.setFallbackItems('amc_contracts', mapped);
    return mapped;
  }

  public async saveAMCContract(item: any): Promise<any> {
    this.assertDbConnected();
    const existing = await this.getExistingRow('solar_amc_contracts', item.id);
    const amcCode = item.amcCode ?? item.amc_code ?? item.contractNumber ?? item.contract_number ?? existing?.amc_code ?? item.id;
    const contractNumber = item.contractNumber ?? item.contract_number ?? amcCode;
    const customerId = item.customerId ?? item.customer_id ?? existing?.customer_id ?? '';
    const customerName = item.customerName ?? item.customer_name ?? existing?.customer_name ?? 'Solar Customer';
    const projectId = item.projectId ?? item.project_id ?? existing?.project_id ?? '';
    const projectTitle = item.projectTitle ?? item.project_title ?? existing?.project_title ?? 'Solar Project Installation';
    const planName = item.planName ?? item.plan_name ?? existing?.plan_name ?? 'Comprehensive Solar AMC';
    const rawStart = item.startDate ?? item.start_date ?? existing?.start_date;
    const startDate = this.toSqlDate(rawStart) ?? new Date().toISOString().split('T')[0];
    const rawEnd = item.endDate ?? item.end_date ?? existing?.end_date;
    const endDate = this.toSqlDate(rawEnd) ?? new Date(Date.now() + 365 * 86400000).toISOString().split('T')[0];
    const rawRenewal = item.renewalDate ?? item.renewal_date ?? existing?.renewal_date;
    const renewalDate = this.toSqlDate(rawRenewal);
    const annualAmount = Number(item.annualAmount ?? item.contractValue ?? item.annual_amount ?? item.contract_value ?? existing?.annual_amount) || 0;
    const contractValue = Number(item.contractValue ?? item.annualAmount ?? item.contract_value ?? item.annual_amount ?? existing?.contract_value) || annualAmount;
    const visitsCompleted = Number(item.visitsCompleted ?? item.visits_completed ?? existing?.visits_completed) || 0;
    const totalVisits = Number(item.totalVisits ?? item.visitsPerYear ?? item.total_visits ?? item.visits_per_year ?? existing?.total_visits) || 4;
    const visitsPerYear = totalVisits;
    const status = item.status ?? existing?.status ?? 'ACTIVE';

    const sql = `
      INSERT INTO \`solar_amc_contracts\` (
        \`id\`, \`amc_code\`, \`customer_id\`, \`customer_name\`, \`project_id\`,
        \`project_title\`, \`plan_name\`, \`start_date\`, \`end_date\`,
        \`renewal_date\`, \`annual_amount\`, \`visits_completed\`, \`total_visits\`, \`status\`
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        \`customer_name\` = VALUES(\`customer_name\`), \`project_title\` = VALUES(\`project_title\`),
        \`plan_name\` = VALUES(\`plan_name\`), \`start_date\` = VALUES(\`start_date\`), \`end_date\` = VALUES(\`end_date\`),
        \`renewal_date\` = VALUES(\`renewal_date\`), \`annual_amount\` = VALUES(\`annual_amount\`),
        \`visits_completed\` = VALUES(\`visits_completed\`), \`total_visits\` = VALUES(\`total_visits\`),
        \`status\` = VALUES(\`status\`)
    `;
    await this.pool!.query(sql, [
      item.id,
      amcCode,
      customerId,
      customerName,
      projectId,
      projectTitle,
      planName,
      startDate,
      endDate,
      renewalDate,
      annualAmount,
      visitsCompleted,
      totalVisits,
      status
    ]);

    const items = this.getFallbackItems('amc_contracts');
    const idx = items.findIndex(c => c.id === item.id);
    if (idx >= 0) items[idx] = { ...items[idx], ...item };
    else items.unshift(item);
    this.setFallbackItems('amc_contracts', items);
    return item;
  }

  public async deleteAMCContract(id: string): Promise<boolean> {
    this.assertDbConnected();
    await this.pool!.query('DELETE FROM `solar_amc_contracts` WHERE `id` = ?', [id]);
    const items = this.getFallbackItems('amc_contracts').filter(c => c.id !== id);
    this.setFallbackItems('amc_contracts', items);
    return true;
  }

  // ==========================================================
  // CRUD: NOTIFICATIONS
  // ==========================================================
  public async getNotifications(): Promise<any[]> {
    if (!this.isConnected) return this.getFallbackItems('notifications');
    this.assertDbConnected();
    const [rows] = await this.pool!.query('SELECT * FROM `solar_notifications` ORDER BY `created_at` DESC LIMIT 100');
    const mapped = (rows as any[]).map(r => ({
      id: r.id,
      userId: r.user_id,
      recipientId: r.user_id,
      title: r.title,
      message: r.message,
      type: r.type,
      isRead: Boolean(r.is_read),
      linkType: r.link_type,
      linkId: r.link_id,
      customerId: r.customer_id,
      projectId: r.project_id,
      createdAt: r.created_at
    }));
    this.setFallbackItems('notifications', mapped);
    return mapped;
  }

  public async saveNotification(item: any): Promise<any> {
    this.assertDbConnected();
    const existing = await this.getExistingRow('solar_notifications', item.id);
    const userId = item.userId ?? item.user_id ?? item.recipientId ?? existing?.user_id ?? '';
    const title = item.title ?? existing?.title ?? 'Notification';
    const message = item.message ?? existing?.message ?? '';
    const type = item.type ?? existing?.type ?? 'INFO';
    const isRead = (item.isRead !== undefined ? item.isRead : (existing?.is_read !== undefined ? existing.is_read : false)) ? 1 : 0;
    const linkType = item.linkType ?? item.link_type ?? existing?.link_type ?? null;
    const linkId = item.linkId ?? item.link_id ?? existing?.link_id ?? null;
    const customerId = item.customerId ?? item.customer_id ?? existing?.customer_id ?? null;
    const projectId = item.projectId ?? item.project_id ?? existing?.project_id ?? null;

    const sql = `
      INSERT INTO \`solar_notifications\` (
        \`id\`, \`user_id\`, \`title\`, \`message\`,
        \`type\`, \`is_read\`, \`link_type\`, \`link_id\`, \`customer_id\`, \`project_id\`
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        \`is_read\` = VALUES(\`is_read\`), \`title\` = VALUES(\`title\`), \`message\` = VALUES(\`message\`)
    `;
    await this.pool!.query(sql, [
      item.id || `notif-${Date.now()}`,
      userId,
      title,
      message,
      type,
      isRead,
      linkType,
      linkId,
      customerId,
      projectId
    ]);

    const items = this.getFallbackItems('notifications');
    const idx = items.findIndex(n => n.id === item.id);
    if (idx >= 0) items[idx] = { ...items[idx], ...item };
    else items.unshift(item);
    this.setFallbackItems('notifications', items);
    return item;
  }

  public async deleteNotification(id: string): Promise<boolean> {
    this.assertDbConnected();
    await this.pool!.query('DELETE FROM `solar_notifications` WHERE `id` = ?', [id]);
    const items = this.getFallbackItems('notifications').filter(n => n.id !== id);
    this.setFallbackItems('notifications', items);
    return true;
  }

  // ==========================================================
  // CRUD: USERS
  // ==========================================================
  public async getUsers(): Promise<any[]> {
    if (!this.isConnected) {
      return (this.getFallbackItems('users') || []).map(u => {
        const { password, ...rest } = u;
        return rest;
      });
    }
    this.assertDbConnected();
    const [rows] = await this.pool!.query(
      'SELECT id, name, email, role, phone, department, designation, employee_id, is_field_worker, status, created_at, updated_at FROM `solar_users` ORDER BY `created_at` ASC'
    );
    const mapped = (rows as any[]).map(r => ({
      id: r.id,
      name: r.name,
      email: r.email,
      role: r.role,
      phone: r.phone || '',
      department: r.department || 'Operations',
      designation: r.designation || '',
      employeeId: r.employee_id || '',
      isFieldWorker: Boolean(r.is_field_worker),
      status: r.status || 'ACTIVE',
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }));
    this.setFallbackItems('users', mapped);
    return mapped;
  }

  public async saveUser(item: any, options?: { updateOnly?: boolean }): Promise<any> {
    this.assertDbConnected();
    const cleanEmail = (item.email || '').toLowerCase().trim();
    const isUpdateOnly = Boolean(options?.updateOnly);
    const reqEmpCode = String(item.employeeId ?? item.employee_id ?? item.employeeCode ?? '').trim();

    // Find existing user in solar_users OR linked employee record in solar_employee
    let existing: any = null;
    let existingEmployee: any = null;
    if (this.pool) {
      if (isUpdateOnly) {
        // 1. Direct match by solar_users.id
        const [rows]: any = await this.pool.query(
          'SELECT * FROM `solar_users` WHERE `id` = ? LIMIT 1',
          [item.id]
        );
        if (Array.isArray(rows) && rows.length > 0) existing = rows[0];

        // 2. Resolve via solar_employee if the caller passed an emp-* ID instead of usr-* ID
        const [empRows]: any = await this.pool.query(
          'SELECT * FROM `solar_employee` WHERE `id` = ? OR `auth_uid` = ? LIMIT 1',
          [item.id, item.id]
        );
        if (Array.isArray(empRows) && empRows.length > 0) {
          existingEmployee = empRows[0];
          if (!existing) {
            const matchCode = reqEmpCode || existingEmployee.employee_code || '';
            const matchEmail = cleanEmail || String(existingEmployee.email || '').toLowerCase().trim();
            const [linkedUserRows]: any = await this.pool.query(
              'SELECT * FROM `solar_users` WHERE `id` = ? OR (`employee_id` = ? AND `employee_id` != "") OR (LOWER(`email`) = ? AND `email` != "") LIMIT 1',
              [existingEmployee.auth_uid || existingEmployee.id, matchCode, matchEmail]
            );
            if (Array.isArray(linkedUserRows) && linkedUserRows.length > 0) {
              existing = linkedUserRows[0];
            }
          }
        }
      } else {
        const [rows]: any = await this.pool.query(
          'SELECT * FROM `solar_users` WHERE `id` = ? OR (LOWER(`email`) = ? AND `email` != "") LIMIT 1',
          [item.id, cleanEmail]
        );
        if (Array.isArray(rows) && rows.length > 0) existing = rows[0];
      }
    } else {
      existing = (this.getFallbackItems('users') || []).find(
        (u: any) => u.id === item.id || (!isUpdateOnly && u.email && cleanEmail && u.email.toLowerCase() === cleanEmail)
      );
    }

    if (isUpdateOnly && !existing && !existingEmployee) {
      const notFoundErr: any = new Error(`User record "${item.id}" not found in MySQL.`);
      notFoundErr.statusCode = 404;
      notFoundErr.code = 'USER_NOT_FOUND';
      throw notFoundErr;
    }

    const canonicalId = existing?.id || existingEmployee?.auth_uid || existingEmployee?.id || item.id;
    const name = item.name ?? existing?.name ?? existingEmployee?.name ?? 'Solar User';
    const email = cleanEmail || existing?.email || existingEmployee?.email || `${canonicalId}@solar.klyiatechnology.com`;

    // Strict Argon2id / bcrypt password handling: NEVER store plaintext or revert to plaintext
    let password = existing?.password;
    const rawPass = item.password || item.tempPassword;
    let hasNewPassword = false;
    if (rawPass && typeof rawPass === 'string' && rawPass.trim().length >= 6) {
      const cleanPass = rawPass.trim();
      if (!cleanPass.startsWith('$2a$') && !cleanPass.startsWith('$2b$') && !cleanPass.startsWith('$2y$') && !cleanPass.startsWith('$argon2id$')) {
        password = await bcrypt.hash(cleanPass, 10);
      } else {
        password = cleanPass;
      }
      hasNewPassword = true;
    } else if (!password) {
      password = await bcrypt.hash(`Usr@${Math.random().toString(36).slice(-8)}`, 10);
      hasNewPassword = true;
    }

    const role = item.role ?? item.systemRole ?? existing?.role ?? existingEmployee?.system_role ?? 'Super Admin';
    const phone = item.phone ?? existing?.phone ?? existingEmployee?.phone ?? '';
    const department = item.department ?? existing?.department ?? existingEmployee?.department ?? 'Operations';
    const designation = item.designation ?? existing?.designation ?? existingEmployee?.designation ?? '';
    const employeeId = reqEmpCode || existing?.employee_id || existingEmployee?.employee_code || null;
    const hasExplicitFieldWorker = item.isFieldWorker !== undefined || item.is_field_worker !== undefined;
    const existingFieldWorker = existing?.is_field_worker !== undefined
      ? Boolean(existing.is_field_worker)
      : (existingEmployee?.is_field_worker !== undefined ? Boolean(existingEmployee.is_field_worker) : false);
    const isFieldWorker = this.parseBoolFlag(
      hasExplicitFieldWorker ? (item.isFieldWorker !== undefined ? item.isFieldWorker : item.is_field_worker) : existingFieldWorker,
      existingFieldWorker
    ) ? 1 : 0;

    const loginDisabledExplicit = item.loginEnabled === false || item.login_enabled === 0 || item.login_enabled === false;
    const status = loginDisabledExplicit ? 'DISABLED' : (item.status ?? existing?.status ?? (existingEmployee?.login_enabled === 0 ? 'DISABLED' : 'ACTIVE'));

    if (this.pool) {
      if (existing) {
        await this.pool.query(`
          UPDATE \`solar_users\`
          SET \`name\` = ?, \`email\` = ?, \`role\` = ?, \`phone\` = ?,
              \`department\` = ?, \`designation\` = ?, \`employee_id\` = ?,
              \`is_field_worker\` = ?, \`status\` = ?, \`updated_at\` = CURRENT_TIMESTAMP
              ${hasNewPassword ? ', `password` = ?' : ''}
          WHERE \`id\` = ?
        `, [
          name, email, role, phone,
          department, designation, employeeId,
          isFieldWorker, status,
          ...(hasNewPassword ? [password] : []),
          canonicalId
        ]);
      } else if (!isUpdateOnly || (!loginDisabledExplicit && status === 'ACTIVE')) {
        await this.pool.query(`
          INSERT INTO \`solar_users\` (
            \`id\`, \`name\`, \`email\`, \`password\`, \`role\`, \`phone\`,
            \`department\`, \`designation\`, \`employee_id\`, \`is_field_worker\`, \`status\`
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          canonicalId, name, email, password, role, phone,
          department, designation, employeeId, isFieldWorker, status
        ]);
      }

      if (existing || !isUpdateOnly || (!loginDisabledExplicit && status === 'ACTIVE')) {
        console.log('[Audit][solar_users]', JSON.stringify({
          timestamp: new Date().toISOString(),
          operation: existing ? 'UPDATE' : 'INSERT',
          source: isUpdateOnly ? 'dbManager.saveUser(updateOnly)' : 'dbManager.saveUser',
          targetUserId: canonicalId,
          email,
          status
        }));
      }

      // Synchronize centralized credentials table & revoke sessions if disabled
      const credStatus = (status === 'DISABLED' || status === 'INACTIVE') ? 'DISABLED' : 'ACTIVE';
      if (existing || !isUpdateOnly || credStatus === 'ACTIVE') {
        await authService.setCredential(this.pool, {
          userId: canonicalId,
          email,
          password: hasNewPassword ? (rawPass ? String(rawPass).trim() : undefined) : undefined,
          role,
          accountType: role === 'Customer' ? 'CUSTOMER' : (role === 'Admin' || role === 'Super Admin') ? 'ADMIN' : 'EMPLOYEE',
          linkedEntityId: existingEmployee?.id || canonicalId,
          status: credStatus
        }).catch(() => {});
      }

      if (credStatus === 'DISABLED') {
        await this.pool.query(
          'DELETE FROM `solar_auth_sessions` WHERE `user_id` = ? OR `linked_entity_id` = ? OR LOWER(`email`) = ?',
          [canonicalId, existingEmployee?.id || canonicalId, email]
        ).catch(() => {});
      }

      // Synchronize employee directory in MySQL for non-Customer users without creating duplicate rows or overwriting photo_url/documents
      if (role !== 'Customer') {
        try {
          const empCode = employeeId || existingEmployee?.employee_code || `EMP-${canonicalId.replace(/[^0-9]/g, '').slice(-3) || '001'}`;
          const empStatus = (status === 'DISABLED' || status === 'INACTIVE') ? 'INACTIVE' : 'ACTIVE';
          const loginFlag = credStatus === 'DISABLED' ? 0 : 1;
          const acctStatus = credStatus === 'DISABLED' ? 'DISABLED' : 'ACTIVE';

          let targetEmpRowId: string | null = existingEmployee?.id || null;
          if (!targetEmpRowId) {
            const [matchedEmpRows]: any = await this.pool.query(
              'SELECT id FROM `solar_employee` WHERE `id` = ? OR `auth_uid` = ? OR (`employee_code` = ? AND `employee_code` != "") OR (LOWER(`email`) = ? AND `email` != "") LIMIT 1',
              [canonicalId, canonicalId, empCode, email]
            );
            if (Array.isArray(matchedEmpRows) && matchedEmpRows.length > 0) {
              targetEmpRowId = matchedEmpRows[0].id;
            }
          }

          if (targetEmpRowId) {
            await this.pool.query(`
              UPDATE \`solar_employee\`
              SET \`employee_code\` = ?, \`name\` = ?, \`department\` = ?, \`designation\` = ?,
                  \`phone\` = ?, \`email\` = ?, \`login_enabled\` = ?, \`auth_uid\` = ?,
                  \`system_role\` = ?, \`assigned_role\` = ?, \`is_field_worker\` = ?,
                  \`status\` = ?, \`account_status\` = ?, \`updated_at\` = CURRENT_TIMESTAMP
              WHERE \`id\` = ?
            `, [
              empCode, name, department, designation,
              phone, email, loginFlag, canonicalId,
              role, role, isFieldWorker,
              empStatus, acctStatus, targetEmpRowId
            ]);
          } else {
            await this.pool.query(`
              INSERT INTO \`solar_employee\` (
                \`id\`, \`employee_code\`, \`name\`, \`photo_url\`, \`department\`,
                \`designation\`, \`phone\`, \`email\`, \`joining_date\`, \`salary_monthly\`,
                \`status\`, \`current_site_location\`, \`login_enabled\`, \`auth_uid\`, \`system_role\`,
                \`assigned_role\`, \`is_field_worker\`, \`account_status\`
              ) VALUES (?, ?, ?, '', ?, ?, ?, ?, CURDATE(), 0.00, ?, '', ?, ?, ?, ?, ?, ?)
            `, [
              canonicalId, empCode, name, department, designation, phone, email,
              empStatus, loginFlag, canonicalId, role, role, isFieldWorker, acctStatus
            ]);
          }
        } catch (e: any) {
          console.warn('[DB Manager] Notice syncing employee from user:', e.message);
        }
      }
    }

    const sanitizedUser = {
      id: canonicalId,
      name,
      email,
      role,
      phone,
      department,
      designation,
      employeeId,
      isFieldWorker: Boolean(isFieldWorker),
      status
    };

    const items = this.getFallbackItems('users');
    const idx = items.findIndex(u => u.id === canonicalId);
    if (idx >= 0) items[idx] = { ...items[idx], ...sanitizedUser };
    else items.push(sanitizedUser);
    this.setFallbackItems('users', items);
    return sanitizedUser;
  }

  public async deleteUser(id: string): Promise<boolean> {
    return this.deleteEmployee(id);
  }

  public async updateUserPassword(id: string, newPass: string): Promise<boolean> {
    if (!newPass || typeof newPass !== 'string' || newPass.trim().length < 6) {
      throw new Error('Password must be at least 6 characters long.');
    }
    const cleanPass = newPass.trim();
    const cleanId = id.trim();
    const hashed = await bcrypt.hash(cleanPass, 10);
    this.assertDbConnected();
    if (this.pool) {
      let resolvedEmail: string | null = null;
      let resolvedAuthUid: string | null = null;
      try {
        const [empRows]: any = await this.pool.query(
          'SELECT `id`, `auth_uid`, `email`, `employee_code` FROM `solar_employee` WHERE `id` = ? OR `auth_uid` = ? OR LOWER(`email`) = ? LIMIT 1',
          [cleanId, cleanId, cleanId.toLowerCase()]
        );
        if (Array.isArray(empRows) && empRows.length > 0) {
          resolvedEmail = empRows[0].email ? String(empRows[0].email).trim().toLowerCase() : null;
          resolvedAuthUid = empRows[0].auth_uid ? String(empRows[0].auth_uid).trim() : null;
        }
      } catch {}

      await this.pool.query(
        'UPDATE `solar_users` SET `password` = ?, `updated_at` = CURRENT_TIMESTAMP WHERE `id` = ? OR `id` = ? OR LOWER(`email`) = ? OR LOWER(`email`) = ?',
        [hashed, cleanId, resolvedAuthUid || cleanId, cleanId.toLowerCase(), resolvedEmail || cleanId.toLowerCase()]
      );
      await authService.updatePassword(this.pool, cleanId, cleanPass);
      if (resolvedEmail && resolvedEmail !== cleanId.toLowerCase()) {
        await authService.updatePassword(this.pool, resolvedEmail, cleanPass);
      }
      return true;
    }
    const items = this.getFallbackItems('users');
    const user = items.find(u => u.id === cleanId || (u.email && u.email.toLowerCase() === cleanId.toLowerCase()));
    if (user) {
      user.password = hashed;
      this.setFallbackItems('users', items);
      return true;
    }
    return false;
  }

  public async changeUserPassword(userId: string, oldPass: string, newPass: string): Promise<{ success: boolean; message: string }> {
    if (!newPass || typeof newPass !== 'string' || newPass.trim().length < 6) {
      throw new Error('New password must be at least 6 characters long.');
    }
    this.assertDbConnected();
    let currentHash: string | null = null;
    if (this.pool) {
      const [rows]: any = await this.pool.query('SELECT id, password FROM `solar_users` WHERE `id` = ? LIMIT 1', [userId]);
      if (Array.isArray(rows) && rows.length > 0) {
        currentHash = rows[0].password;
      }
    } else {
      const u = this.getFallbackItems('users').find(x => x.id === userId);
      currentHash = u?.password || null;
    }

    if (!currentHash) {
      // Check solar_auth_credentials
      if (this.pool) {
        const [cRows]: any = await this.pool.query('SELECT id, password_hash FROM `solar_auth_credentials` WHERE `user_id` = ? LIMIT 1', [userId]);
        if (Array.isArray(cRows) && cRows.length > 0) {
          currentHash = cRows[0].password_hash;
        }
      }
    }

    if (!currentHash) {
      throw new Error('User account not found.');
    }

    let isOldValid = false;
    if (currentHash.startsWith('$2a$') || currentHash.startsWith('$2b$') || currentHash.startsWith('$2y$')) {
      isOldValid = await bcrypt.compare(oldPass.trim(), currentHash);
    } else {
      isOldValid = oldPass.trim() === currentHash;
    }

    if (!isOldValid) {
      throw new Error('Current password does not match.');
    }

    const newHashed = await bcrypt.hash(newPass.trim(), 10);
    await this.pool!.query('UPDATE `solar_users` SET `password` = ?, `updated_at` = CURRENT_TIMESTAMP WHERE `id` = ?', [newHashed, userId]);
    await authService.updatePassword(this.pool!, userId, newPass.trim());
    return { success: true, message: 'Password changed successfully.' };
  }

  public async resetUserPassword(email: string, newPass: string): Promise<{ success: boolean; message: string }> {
    const cleanEmail = email.trim().toLowerCase();
    const cleanPass = (newPass || '').trim();
    if (cleanPass.length < 6) {
      throw new Error('Explicit new password (minimum 6 characters) is required.');
    }
    const hashed = await bcrypt.hash(cleanPass, 10);
    this.assertDbConnected();
    await this.pool!.query(
      'UPDATE `solar_users` SET `password` = ?, `updated_at` = CURRENT_TIMESTAMP WHERE LOWER(`email`) = ?',
      [hashed, cleanEmail]
    );
    await this.pool!.query(
      'UPDATE `solar_customers` SET `password` = ?, `updated_at` = CURRENT_TIMESTAMP WHERE LOWER(`email`) = ?',
      [hashed, cleanEmail]
    );
    await authService.updatePassword(this.pool!, cleanEmail, cleanPass);
    return { success: true, message: `Password for ${cleanEmail} reset successfully in MySQL.` };
  }

  // ==========================================================
  // CRUD: SYSTEM SETTINGS
  // ==========================================================
  public async getSettings(): Promise<Record<string, any>> {
    this.assertDbConnected();
    const [rows]: any = await this.pool!.query('SELECT `setting_value` FROM `solar_system_settings` WHERE `setting_key` = ?', ['global_settings']);
    if (Array.isArray(rows) && rows.length > 0 && rows[0].setting_value) {
      try {
        return JSON.parse(rows[0].setting_value);
      } catch {}
    }
    return {};
  }

  public async saveSettings(settings: any): Promise<any> {
    this.assertDbConnected();
    const val = JSON.stringify(settings);
    await this.pool!.query(
      'INSERT INTO `solar_system_settings` (`setting_key`, `setting_value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `setting_value` = VALUES(`setting_value`)',
      ['global_settings', val]
    );
    return settings;
  }

  // ==========================================================
  // CRUD: GMAIL EMAIL SMTP SETTINGS (ENCRYPTED AT REST)
  // ==========================================================
  public async getEmailSettingsInternal(): Promise<EmailSettingsRecord | null> {
    this.assertDbConnected();
    const [rows]: any = await this.pool!.query(
      'SELECT * FROM `solar_email_settings` WHERE `id` = ? LIMIT 1',
      ['default_gmail_smtp']
    );
    if (Array.isArray(rows) && rows.length > 0) {
      return rows[0] as EmailSettingsRecord;
    }
    return null;
  }

  public async getSanitizedEmailSettings(): Promise<SanitizedEmailSettings> {
    const row = await this.getEmailSettingsInternal();
    return sanitizeEmailConfig(row);
  }

  public async saveEmailSettings(input: {
    gmailAddress: string;
    smtpHost: string;
    smtpPort: number;
    smtpSecurity: SmtpSecurity;
    senderName: string;
    encryptedAppPassword: string;
    iv: string;
    authTag: string;
    enabled: boolean;
    updatedBy: string;
  }): Promise<SanitizedEmailSettings> {
    this.assertDbConnected();
    await this.pool!.query(
      `INSERT INTO \`solar_email_settings\` (
        \`id\`, \`gmail_address\`, \`smtp_host\`, \`smtp_port\`, \`smtp_security\`,
        \`sender_name\`, \`encrypted_app_password\`, \`iv\`, \`auth_tag\`,
        \`enabled\`, \`updated_by\`
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        \`gmail_address\` = VALUES(\`gmail_address\`),
        \`smtp_host\` = VALUES(\`smtp_host\`),
        \`smtp_port\` = VALUES(\`smtp_port\`),
        \`smtp_security\` = VALUES(\`smtp_security\`),
        \`sender_name\` = VALUES(\`sender_name\`),
        \`encrypted_app_password\` = VALUES(\`encrypted_app_password\`),
        \`iv\` = VALUES(\`iv\`),
        \`auth_tag\` = VALUES(\`auth_tag\`),
        \`enabled\` = VALUES(\`enabled\`),
        \`updated_by\` = VALUES(\`updated_by\`),
        \`updated_at\` = CURRENT_TIMESTAMP`,
      [
        'default_gmail_smtp',
        input.gmailAddress,
        input.smtpHost,
        input.smtpPort,
        input.smtpSecurity,
        input.senderName,
        input.encryptedAppPassword,
        input.iv,
        input.authTag,
        input.enabled ? 1 : 0,
        input.updatedBy
      ]
    );
    return await this.getSanitizedEmailSettings();
  }

  public async updateEmailTestStatus(
    status: 'SUCCESS' | 'FAILED',
    message: string,
    testedAt?: string
  ): Promise<SanitizedEmailSettings> {
    this.assertDbConnected();
    const ts = testedAt || new Date().toISOString();
    await this.pool!.query(
      'UPDATE `solar_email_settings` SET `last_tested_at` = ?, `last_test_status` = ?, `last_test_message` = ? WHERE `id` = ?',
      [ts, status, message.slice(0, 1000), 'default_gmail_smtp']
    );
    return await this.getSanitizedEmailSettings();
  }

  public async deleteEmailSettings(): Promise<void> {
    this.assertDbConnected();
    await this.pool!.query('DELETE FROM `solar_email_settings` WHERE `id` = ?', ['default_gmail_smtp']);
  }

  // ==========================================================
  // CRUD: ACL CONFIG & AUDIT LOGS
  // ==========================================================
  public async getAclConfig(): Promise<any> {
    this.assertDbConnected();
    const [rows]: any = await this.pool!.query('SELECT `config_json` FROM `solar_acl_config` WHERE `id` = ?', ['master_acl_config']);
    if (Array.isArray(rows) && rows.length > 0 && rows[0].config_json) {
      try {
        return JSON.parse(rows[0].config_json);
      } catch {}
    }
    return {};
  }

  public async saveAclConfig(config: any): Promise<any> {
    this.assertDbConnected();
    const jsonStr = typeof config === 'string' ? config : JSON.stringify(config);
    await this.pool!.query(
      'INSERT INTO `solar_acl_config` (`id`, `config_json`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `config_json` = VALUES(`config_json`)',
      ['master_acl_config', jsonStr]
    );
    return config;
  }

  public async getAclAuditLogs(): Promise<any[]> {
    this.assertDbConnected();
    const [rows]: any = await this.pool!.query('SELECT * FROM `solar_acl_audit_logs` ORDER BY `timestamp` DESC LIMIT 100');
    if (Array.isArray(rows)) {
      return rows.map((r: any) => ({
        id: r.id,
        actorId: r.actor_id,
        actorName: r.actor_name,
        actorRole: r.actor_role,
        action: r.action,
        targetRole: r.target_role,
        details: r.details,
        timestamp: r.timestamp
      }));
    }
    return [];
  }

  public async addAclAuditLog(log: any): Promise<any> {
    this.assertDbConnected();
    const id = log.id || `acl-log-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const ts = log.timestamp ? String(log.timestamp).replace('T', ' ').slice(0, 19) : new Date().toISOString().slice(0, 19).replace('T', ' ');
    const detailStr = typeof log.details === 'string' ? log.details : (log.detailsJson || JSON.stringify(log));

    await this.pool!.query(
      `INSERT INTO \`solar_acl_audit_logs\` (
        \`id\`, \`actor_id\`, \`actor_name\`, \`actor_role\`, \`action\`, \`target_role\`,
        \`details\`, \`timestamp\`
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        log.actorId || log.userId || 'usr-admin-1',
        log.actorName || log.userName || 'Admin',
        log.actorRole || log.userRole || 'Admin',
        log.action || 'UPDATE',
        log.targetRole || '',
        detailStr,
        ts
      ]
    );
    return log;
  }

  public async saveACLAuditLog(log: any): Promise<any> {
    return this.addAclAuditLog(log);
  }

  // ==========================================================
  // DISPATCHER: SAVE & DELETE BY COLLECTION KEY
  // ==========================================================
  public async saveItem(collection: string, item: any): Promise<any> {
    if (!item || (!item.id && collection !== 'settings' && collection !== 'acl_config')) {
      throw new Error(`Invalid item payload for collection ${collection}`);
    }

    this.assertDbConnected();

    switch (collection) {
      case 'customers': return this.saveCustomer(item);
      case 'leads': return this.saveLead(item);
      case 'projects': return this.saveProject(item);
      case 'employee':
      case 'employees': return this.saveEmployee(item);
      case 'payments': return this.savePayment(item);
      case 'expenses': return this.saveExpense(item);
      case 'products': return this.saveProduct(item);
      case 'vendors': return this.saveVendor(item);
      case 'purchase_orders': return this.savePurchaseOrder(item);
      case 'sales_invoices': return this.saveSalesInvoice(item);
      case 'vendor_sales_invoices': return this.saveVendorSalesInvoice(item);
      case 'attendance': return this.saveAttendance(item);
      case 'payslips': return this.savePayslip(item);
      case 'holidays': return this.saveHoliday(item);
      case 'quotations': return this.saveQuotation(item);
      case 'surveys': return this.saveSurvey(item);
      case 'boms': return this.saveBOM(item);
      case 'warehouses': return this.saveWarehouse(item);
      case 'stock_movements': return this.saveStockMovement(item);
      case 'stock_audits': return this.saveStockAudit(item);
      case 'service_tickets': return this.saveServiceTicket(item);
      case 'amc_contracts': return this.saveAMCContract(item);
      case 'notifications': return this.saveNotification(item);
      case 'users': return this.saveUser(item);
      case 'settings': return this.saveSettings(item);
      case 'acl_config': return this.saveAclConfig(item);
      case 'acl_audit_logs': return this.addAclAuditLog(item);
      default: {
        throw new Error(`Collection "${collection}" is not supported for MySQL persistence.`);
      }
    }
  }

  public async deleteItem(collection: string, id: string): Promise<boolean> {
    if (!id) return false;
    this.assertDbConnected();

    switch (collection.toLowerCase()) {
      case 'customers': return this.deleteCustomer(id);
      case 'leads': return this.deleteLead(id);
      case 'projects': return this.deleteProject(id);
      case 'employee':
      case 'employees':
      case 'solar_employee':
      case 'solar_employees': return this.deleteEmployee(id);
      case 'payments': return this.deletePayment(id);
      case 'expenses': return this.deleteExpense(id);
      case 'products': return this.deleteProduct(id);
      case 'vendors': return this.deleteVendor(id);
      case 'purchase_orders': return this.deletePurchaseOrder(id);
      case 'sales_invoices': return this.deleteSalesInvoice(id);
      case 'vendor_sales_invoices': return this.deleteVendorSalesInvoice(id);
      case 'attendance': return this.deleteAttendance(id);
      case 'payslips': return this.deletePayslip(id);
      case 'holidays': return this.deleteHoliday(id);
      case 'quotations': return this.deleteQuotation(id);
      case 'surveys': return this.deleteSurvey(id);
      case 'boms': return this.deleteBOM(id);
      case 'warehouses': return this.deleteWarehouse(id);
      case 'stock_movements': return this.deleteStockMovement(id);
      case 'stock_audits': return this.deleteStockAudit(id);
      case 'service_tickets': return this.deleteServiceTicket(id);
      case 'amc_contracts': return this.deleteAMCContract(id);
      case 'notifications': return this.deleteNotification(id);
      case 'user':
      case 'users':
      case 'solar_users': return this.deleteUser(id);
      default: {
        throw new Error(`Collection "${collection}" is not supported for MySQL deletion.`);
      }
    }
  }

  // ==========================================================
  // USERS & AUTH (MYSQL AUTHENTICATION & BCRYPT ENCRYPTION)
  // ==========================================================
  public async ensureHashedPasswords(): Promise<void> {
    if (!this.pool || !this.isConnected) return;
    try {
      const [users]: any = await this.pool.query('SELECT id, password FROM `solar_users`');
      if (Array.isArray(users)) {
        for (const u of users) {
          if (u.password && !u.password.startsWith('$2a$') && !u.password.startsWith('$2b$') && !u.password.startsWith('$2y$')) {
            const hashed = await bcrypt.hash(u.password, 10);
            await this.pool.query('UPDATE `solar_users` SET `password` = ? WHERE `id` = ?', [hashed, u.id]);
          }
        }
      }
      const [custs]: any = await this.pool.query('SELECT id, password FROM `solar_customers`');
      if (Array.isArray(custs)) {
        for (const c of custs) {
          if (c.password && !c.password.startsWith('$2a$') && !c.password.startsWith('$2b$') && !c.password.startsWith('$2y$')) {
            const hashed = await bcrypt.hash(c.password, 10);
            await this.pool.query('UPDATE `solar_customers` SET `password` = ? WHERE `id` = ?', [hashed, c.id]);
          }
        }
      }
    } catch (e: any) {
      console.warn('[MySQL] Password hash check notice:', e?.message || e);
    }
  }

  public async seedDefaultDemoUsersIfEmpty(): Promise<void> {
    if (!this.pool || !this.isConnected) return;
    try {
      const [countRows]: any = await this.pool.query('SELECT COUNT(*) AS cnt FROM `solar_users`');
      const userCount = Number(countRows?.[0]?.cnt || 0);
      if (userCount > 0) return;

      // Seed ONLY the 11 defined demo login accounts (zero dummy employees or customers)
      const demoAccounts = [
        { id: 'usr-admin-1', code: 'EMP-001', name: 'Administrator', email: 'admin@solar.klyiatechnology.com', pass: 'SolarAdmin@2026', role: 'Admin', dept: 'Administration', desig: 'System Administrator', fw: 0 },
        { id: 'usr-salesmgr-1', code: 'EMP-002', name: 'Sales Manager', email: 'salesmanager@solar.klyiatechnology.com', pass: 'SolarSales@2026', role: 'Sales Manager', dept: 'Sales', desig: 'Sales Manager', fw: 0 },
        { id: 'usr-pm-1', code: 'EMP-003', name: 'Project Manager', email: 'projectmanager@solar.klyiatechnology.com', pass: 'SolarProject@2026', role: 'Project Manager', dept: 'Operations', desig: 'Project Manager', fw: 0 },
        { id: 'usr-survey-1', code: 'EMP-004', name: 'Site Surveyor', email: 'surveyor@solar.klyiatechnology.com', pass: 'SolarSurvey@2026', role: 'Site Survey Engineer', dept: 'Engineering', desig: 'Site Surveyor', fw: 1 },
        { id: 'usr-insp-1', code: 'EMP-005', name: 'Site Inspector', email: 'inspector@solar.klyiatechnology.com', pass: 'SolarInspect@2026', role: 'Site Inspector', dept: 'Engineering', desig: 'Site Inspector', fw: 1 },
        { id: 'usr-civil-1', code: 'EMP-006', name: 'Civil Team', email: 'civil@solar.klyiatechnology.com', pass: 'SolarCivil@2026', role: 'Civil Team', dept: 'Civil', desig: 'Civil Team Lead', fw: 1 },
        { id: 'usr-elec-1', code: 'EMP-007', name: 'Electrical Team', email: 'electrical@solar.klyiatechnology.com', pass: 'SolarElec@2026', role: 'Electrical Team', dept: 'Electrical', desig: 'Electrical Team Lead', fw: 1 },
        { id: 'usr-inst-1', code: 'EMP-008', name: 'Installation Team', email: 'installation@solar.klyiatechnology.com', pass: 'SolarInstall@2026', role: 'Installation Team', dept: 'Installation', desig: 'Installation Team Lead', fw: 1 },
        { id: 'usr-hr-1', code: 'EMP-009', name: 'HR Manager', email: 'hr@solar.klyiatechnology.com', pass: 'SolarHr@2026', role: 'HR Manager', dept: 'HR', desig: 'HR Manager', fw: 0 },
        { id: 'usr-acc-1', code: 'EMP-010', name: 'Accounts Manager', email: 'accounts@solar.klyiatechnology.com', pass: 'SolarAccounts@2026', role: 'Accountant', dept: 'Finance', desig: 'Accounts Manager', fw: 0 }
      ];

      for (const s of demoAccounts) {
        const hashed = await bcrypt.hash(s.pass, 10);
        await this.pool.query(
          `INSERT IGNORE INTO \`solar_users\` (\`id\`, \`name\`, \`email\`, \`password\`, \`role\`, \`phone\`, \`department\`, \`designation\`, \`employee_id\`, \`is_field_worker\`, \`status\`)
           VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, 'ACTIVE')`,
          [s.id, s.name, s.email, hashed, s.role, s.dept, s.desig, s.code, s.fw]
        );
      }

      const custPassHash = await bcrypt.hash('SolarCustomer@2026', 10);
      await this.pool.query(
        `INSERT IGNORE INTO \`solar_users\` (\`id\`, \`name\`, \`email\`, \`password\`, \`role\`, \`phone\`, \`department\`, \`designation\`, \`customer_id\`, \`is_field_worker\`, \`status\`)
         VALUES ('usr-cust-demo-1', 'Customer Demo Account', 'customer@solar.klyiatechnology.com', ?, 'Customer', '', 'Customer', 'Customer Portal Demo', NULL, 0, 'ACTIVE')`,
        [custPassHash]
      );

      console.log('[MySQL] Seeded ONLY the 11 defined Solar Urja ERP demo login accounts (zero dummy business data).');
    } catch (e: any) {
      console.warn('[MySQL] Demo user auto-seed notice:', e?.message || e);
    }
  }

  public async getAdminRegistrationStatus(): Promise<{ allowPublicRegistration: boolean; adminCount: number }> {
    this.assertDbConnected();
    const [admins]: any = await this.pool!.query(
      "SELECT id, email FROM `solar_users` WHERE role IN ('Admin', 'Super Admin') AND status = 'ACTIVE'"
    );
    const adminList = Array.isArray(admins) ? admins : [];
    const nonDemoAdmins = adminList.filter(
      a =>
        !a.email.toLowerCase().includes('admin@solar.klyiatechnology.com') &&
        !a.email.toLowerCase().includes('admin@rejoysolar.com') &&
        !a.id.startsWith('demo-')
    );
    const allowPublicRegistration = nonDemoAdmins.length === 0;
    return {
      allowPublicRegistration,
      adminCount: adminList.length
    };
  }

  public async registerAdmin(
    data: {
      name: string;
      email: string;
      password: string;
      phone?: string;
      department?: string;
      designation?: string;
    },
    isAuthorizedByAdmin: boolean = false
  ): Promise<any> {
    const cleanEmail = String(data.email || '').trim().toLowerCase();
    const cleanName = String(data.name || '').trim();
    const cleanPass = String(data.password || '').trim();

    if (!cleanName) {
      throw new Error('Full name is required for administrator registration.');
    }
    if (!cleanEmail || !cleanEmail.includes('@')) {
      throw new Error('A valid email address is required.');
    }
    if (!cleanPass || cleanPass.length < 6) {
      throw new Error('Password must be at least 6 characters in length.');
    }

    this.assertDbConnected();

    const status = await this.getAdminRegistrationStatus();
    if (!status.allowPublicRegistration && !isAuthorizedByAdmin) {
      throw new Error(
        'Public administrator registration is closed. Additional administrators must be created by an existing authorized Administrator.'
      );
    }

    // Check duplicate email in users and customers
    const [existingUsers]: any = await this.pool!.query(
      'SELECT id, email FROM `solar_users` WHERE LOWER(email) = ?',
      [cleanEmail]
    );
    if (Array.isArray(existingUsers) && existingUsers.length > 0) {
      throw new Error('An account with this email address already exists in MySQL.');
    }

    const [existingCustomers]: any = await this.pool!.query(
      'SELECT id, email FROM `solar_customers` WHERE LOWER(email) = ?',
      [cleanEmail]
    );
    if (Array.isArray(existingCustomers) && existingCustomers.length > 0) {
      throw new Error('This email is already registered as an ERP customer.');
    }

    // Hash password with bcrypt before storing into MySQL
    const hashedPassword = await bcrypt.hash(cleanPass, 10);
    const userId = `usr-admin-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const empCode = `EMP-ADM-${Math.floor(100 + Math.random() * 900)}`;

    const userObj = {
      id: userId,
      name: cleanName,
      email: cleanEmail,
      password: hashedPassword,
      role: 'Admin',
      phone: (data.phone || '+91 98250 11223').trim(),
      department: (data.department || 'Administration').trim(),
      designation: (data.designation || 'Lead Administrator').trim(),
      employee_id: empCode,
      is_field_worker: 0,
      status: 'ACTIVE'
    };

    await this.pool!.query(
      'INSERT INTO `solar_users` (`id`, `name`, `email`, `password`, `role`, `phone`, `department`, `designation`, `employee_id`, `is_field_worker`, `status`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        userObj.id,
        userObj.name,
        userObj.email,
        userObj.password,
        userObj.role,
        userObj.phone,
        userObj.department,
        userObj.designation,
        userObj.employee_id,
        userObj.is_field_worker,
        userObj.status
      ]
    );

    try {
      await this.pool!.query(
        'INSERT INTO `solar_employee` (`id`, `employee_code`, `name`, `email`, `phone`, `department`, `designation`, `system_role`, `assigned_role`, `login_enabled`, `auth_uid`, `account_status`, `status`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)',
        [
          userObj.id,
          empCode,
          userObj.name,
          userObj.email,
          userObj.phone,
          userObj.department,
          userObj.designation,
          'Admin',
          'Admin',
          userObj.id,
          'ACTIVE',
          'ACTIVE'
        ]
      );
    } catch {}

    // Synchronize admin credential to solar_auth_credentials
    try {
      await authService.setCredential(this.pool!, {
        userId: userObj.id,
        email: userObj.email,
        password: cleanPass,
        role: 'Admin',
        accountType: 'ADMIN',
        linkedEntityId: userObj.id,
        status: 'ACTIVE'
      });
    } catch (err: any) {
      console.warn('[DB Manager] Notice syncing admin credential:', err.message);
    }

    return {
      id: userObj.id,
      name: userObj.name,
      email: userObj.email,
      role: userObj.role,
      phone: userObj.phone,
      department: userObj.department,
      designation: userObj.designation,
      employeeId: userObj.employee_id,
      isFieldWorker: false
    };
  }

  public async verifyCredentials(email: string, pass: string): Promise<any | null> {
    return this.authenticateUser(email, pass);
  }

  public async authenticateUser(email: string, pass: string): Promise<any | null> {
    const cleanEmail = email.trim().toLowerCase();
    const cleanPass = pass.trim();

    this.assertDbConnected();

    // 1. Authoritative check via centralized solar_auth_credentials
    if (this.pool) {
      try {
        const authResult = await authService.authenticate(this.pool, cleanEmail, cleanPass);
        if (authResult && authResult.user) {
          return authResult.user;
        }
      } catch (authErr: any) {
        if (String(authErr?.message || '').toLowerCase().includes('disabled')) throw authErr;
        console.warn('[DB Manager] Centralized auth check notice:', authErr?.message || authErr);
      }
    }

    const [users]: any = await this.pool!.query('SELECT * FROM `solar_users` WHERE LOWER(email) = ?', [cleanEmail]);
    if (Array.isArray(users) && users.length > 0) {
      const u = users[0];
      let isMatch = false;
      let effectiveHash = String(u.password || '');

      if (effectiveHash && (effectiveHash.startsWith('$2a$') || effectiveHash.startsWith('$2b$') || effectiveHash.startsWith('$2y$'))) {
        isMatch = await bcrypt.compare(cleanPass, effectiveHash);
      } else if (effectiveHash && effectiveHash === cleanPass) {
        isMatch = true;
        // Automatically upgrade legacy plaintext to bcrypt in MySQL
        try {
          effectiveHash = await bcrypt.hash(cleanPass, 10);
          await this.pool!.query('UPDATE `solar_users` SET `password` = ? WHERE `id` = ?', [effectiveHash, u.id]);
        } catch {}
      }

      if (isMatch) {
        const uStatus = String(u.status || 'ACTIVE').trim().toUpperCase();
        if (['DISABLED', 'INACTIVE', 'TERMINATED', 'SUSPENDED'].includes(uStatus)) {
          throw new Error('This account has been disabled. Please contact system administrator.');
        }
        const uRole = u.role || 'Admin';
        const uUpper = uRole.trim().toUpperCase();
        const acctType = uUpper === 'CUSTOMER' ? 'CUSTOMER' : (uUpper === 'ADMIN' || uUpper === 'SUPER ADMIN' ? 'ADMIN' : 'EMPLOYEE');
        await authService.setCredential(this.pool!, {
          userId: u.id,
          email: u.email,
          password: effectiveHash,
          role: uRole,
          accountType: acctType,
          linkedEntityId: u.employee_id || u.id,
          status: 'ACTIVE'
        }).catch(() => {});

        return {
          id: u.id,
          userId: u.id,
          name: u.name,
          email: u.email,
          role: uRole,
          phone: u.phone,
          department: u.department,
          designation: u.designation,
          employeeId: u.employee_id || u.id,
          isFieldWorker: Boolean(u.is_field_worker),
          accountType: acctType,
          status: u.status || 'ACTIVE'
        };
      }
    }

    // Check solar_employee fallback if employee row carries a password
    try {
      const [employees]: any = await this.pool!.query('SELECT * FROM `solar_employee` WHERE LOWER(email) = ? LIMIT 1', [cleanEmail]);
      if (Array.isArray(employees) && employees.length > 0) {
        const emp = employees[0];
        const ePass = String(emp.password || '');
        let eMatch = false;
        if (ePass && (ePass.startsWith('$2a$') || ePass.startsWith('$2b$') || ePass.startsWith('$2y$'))) {
          eMatch = await bcrypt.compare(cleanPass, ePass);
        } else if (ePass && ePass === cleanPass) {
          eMatch = true;
        }
        if (eMatch) {
          const eDisabled = emp.login_enabled === 0 || emp.login_enabled === false
            || ['DISABLED', 'INACTIVE', 'TERMINATED'].includes(String(emp.status || 'ACTIVE').toUpperCase())
            || String(emp.account_status || 'ACTIVE').toUpperCase() === 'DISABLED';
          if (eDisabled) {
            throw new Error('This account has been disabled. Please contact system administrator.');
          }
          const eRole = emp.system_role || emp.assigned_role || 'Technician';
          const acctType = ['ADMIN', 'SUPER ADMIN'].includes(eRole.trim().toUpperCase()) ? 'ADMIN' : 'EMPLOYEE';
          await authService.setCredential(this.pool!, {
            userId: emp.auth_uid || emp.id,
            email: emp.email,
            password: cleanPass,
            role: eRole,
            accountType: acctType,
            linkedEntityId: emp.id,
            status: 'ACTIVE'
          }).catch(() => {});
          return {
            id: emp.id,
            userId: emp.auth_uid || emp.id,
            employeeId: emp.employee_code || emp.id,
            name: emp.name,
            email: emp.email,
            role: eRole,
            phone: emp.phone || '',
            department: emp.department || 'Operations',
            designation: emp.designation || eRole,
            isFieldWorker: Boolean(emp.is_field_worker),
            accountType: acctType,
            status: emp.status || 'ACTIVE'
          };
        }
      }
    } catch (empErr: any) {
      if (String(empErr?.message || '').toLowerCase().includes('disabled')) throw empErr;
    }

    const [customers]: any = await this.pool!.query('SELECT * FROM `solar_customers` WHERE LOWER(email) = ?', [cleanEmail]);
    if (Array.isArray(customers) && customers.length > 0) {
      const c = customers[0];
      let isMatch = false;
      let effectiveHash = String(c.password || '');

      if (effectiveHash && (effectiveHash.startsWith('$2a$') || effectiveHash.startsWith('$2b$') || effectiveHash.startsWith('$2y$'))) {
        isMatch = await bcrypt.compare(cleanPass, effectiveHash);
      } else if (effectiveHash && effectiveHash === cleanPass) {
        isMatch = true;
        try {
          effectiveHash = await bcrypt.hash(cleanPass, 10);
          await this.pool!.query('UPDATE `solar_customers` SET `password` = ? WHERE `id` = ?', [effectiveHash, c.id]);
        } catch {}
      }

      if (isMatch) {
        const cStatus = String(c.status || 'ACTIVE').trim().toUpperCase();
        if (['DISABLED', 'INACTIVE'].includes(cStatus)) {
          throw new Error('This account has been disabled. Please contact system administrator.');
        }
        const rawCid = String(c.id).replace(/^usr-/, '');
        await authService.setCredential(this.pool!, {
          userId: `usr-${rawCid}`,
          email: c.email,
          password: effectiveHash,
          role: 'Customer',
          accountType: 'CUSTOMER',
          linkedEntityId: c.id,
          status: 'ACTIVE'
        }).catch(() => {});
        return {
          id: `usr-${rawCid}`,
          userId: `usr-${rawCid}`,
          customerId: c.id,
          employeeId: `CUST-${c.id}`,
          name: c.name,
          email: c.email,
          role: 'Customer',
          phone: c.phone,
          department: 'Customer Portal',
          designation: 'Customer',
          isFieldWorker: false,
          accountType: 'CUSTOMER',
          status: c.status || 'ACTIVE'
        };
      }
    }

    return null;
  }

  public async findUserByIdOrEmail(idOrEmail: string): Promise<any | null> {
    if (!idOrEmail) return null;
    const clean = idOrEmail.trim().toLowerCase();
    const cleanCustId = idOrEmail.startsWith('usr-') ? idOrEmail.slice(4) : idOrEmail;

    this.assertDbConnected();
    const [users]: any = await this.pool!.query(
      'SELECT id, name, email, role, phone, department, designation, employee_id, is_field_worker, status FROM `solar_users` WHERE id = ? OR LOWER(email) = ?',
      [idOrEmail, clean]
    );
    if (Array.isArray(users) && users.length > 0) {
      const u = users[0];
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        phone: u.phone,
        department: u.department,
        designation: u.designation,
        employeeId: u.employee_id,
        isFieldWorker: Boolean(u.is_field_worker),
        status: u.status || 'ACTIVE'
      };
    }

    const [customers]: any = await this.pool!.query(
      'SELECT id, customer_code, name, email, phone FROM `solar_customers` WHERE id = ? OR LOWER(email) = ?',
      [cleanCustId, clean]
    );
    if (Array.isArray(customers) && customers.length > 0) {
      const c = customers[0];
      return {
        id: `usr-${c.id}`,
        customerId: c.id,
        name: c.name,
        email: c.email,
        role: 'Customer',
        phone: c.phone,
        department: 'Customer',
        designation: 'Customer',
        isFieldWorker: false,
        status: 'ACTIVE'
      };
    }

    return null;
  }

  public async backupAndWipeData(confirmation: string): Promise<{
    success: boolean;
    backupFile: string;
    affectedTables: string[];
    affectedBrowserKeys: string[];
    preservedTables: string[];
    recordsWiped: number;
    message: string;
  }> {
    this.assertDbConnected();
    if (confirmation !== 'CONFIRM_WIPE_ERP_DATA') {
      throw new Error('Explicit confirmation code "CONFIRM_WIPE_ERP_DATA" is required to proceed.');
    }

    const businessTables = [
      'solar_quotations',
      'solar_site_surveys',
      'solar_project_stages',
      'solar_payments',
      'solar_expenses',
      'solar_acc_journal_lines',
      'solar_acc_journal_entries',
      'solar_acc_bank_transfers',
      'solar_acc_bank_reconciliations',
      'solar_acc_vendor_payments',
      'solar_acc_vendor_bills',
      'solar_acc_tds_entries',
      'solar_acc_budgets',
      'solar_acc_asset_depreciation',
      'solar_acc_fixed_assets',
      'solar_acc_audit_logs',
      'solar_acc_bank_accounts',
      'solar_acc_accounts',
      'solar_service_ticket_history',
      'solar_service_tickets',
      'solar_amc_contracts',
      'solar_projects',
      'solar_leads',
      'solar_customers',
      'solar_sales_return_items',
      'solar_sales_returns',
      'solar_purchase_return_items',
      'solar_purchase_returns',
      'solar_purchase_orders',
      'solar_boms',
      'solar_vendor_sales_payments',
      'solar_vendor_sales_invoice_items',
      'solar_vendor_sales_invoices',
      'solar_sales_invoices',
      'solar_stock_movements',
      'solar_stock_audits',
      'solar_products',
      'solar_vendors',
      'solar_warehouses',
      'solar_employee_documents',
      'solar_leave_requests',
      'solar_leave_balances',
      'solar_attendance',
      'solar_payslips',
      'solar_holidays',
      'solar_employee',
      'solar_workforce_locations',
      'solar_acl_audit_logs',
      'solar_notifications'
    ];

    const preservedTables = [
      'solar_users',
      'solar_system_settings',
      'solar_acl_config',
      'solar_schema_migrations',
      'solar_audit_logs'
    ];

    const affectedBrowserKeys = [
      'solar_erp_leads_v2', 'solar_erp_customers_v2', 'solar_erp_projects_v2', 'solar_erp_payments_v2',
      'solar_erp_expenses_v2', 'solar_erp_employees_v2', 'solar_erp_attendance_v2', 'solar_erp_payslips_v2',
      'solar_erp_holidays_v2', 'solar_erp_service_tickets_v2', 'solar_erp_amc_contracts_v2', 'solar_erp_notifications_v2',
      'solar_erp_surveys_v2', 'solar_erp_quotations_v2', 'solar_erp_products_v2', 'solar_erp_vendors_v2',
      'solar_erp_purchase_orders_v2', 'solar_erp_boms_v2', 'solar_erp_sales_invoices_v2', 'solar_erp_stock_movements_v2',
      'solar_erp_warehouses_v2', 'solar_erp_stock_audits_v2', 'solar_erp_acl_audit_logs_v2'
    ];

    // 1. Create SQL Backup
    const backupDir = path.join(process.cwd(), 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFileName = `solar_urja_erp_backup_${timestamp}.sql`;
    const backupFilePath = path.join(backupDir, backupFileName);

    let backupSql = `-- Solar Urja ERP Database Backup (solar.klyiatechnology.com)\n-- Created: ${new Date().toISOString()}\n-- Database: ${this.config.database}\n\nSET FOREIGN_KEY_CHECKS = 0;\n\n`;

    const allTables = [...businessTables, ...preservedTables];
    for (const table of allTables) {
      try {
        const [rows]: any = await this.pool!.query(`SELECT * FROM \`${table}\``);
        if (Array.isArray(rows) && rows.length > 0) {
          backupSql += `-- Data for ${table} (${rows.length} rows)\n`;
          for (const row of rows) {
            const cols = Object.keys(row).map(c => `\`${c}\``).join(', ');
            const vals = Object.values(row).map(v => {
              if (v === null || v === undefined) return 'NULL';
              if (typeof v === 'number' || typeof v === 'boolean') return v;
              if (v instanceof Date) return `'${v.toISOString().slice(0, 19).replace('T', ' ')}'`;
              return `'${String(v).replace(/'/g, "\\'")}'`;
            }).join(', ');
            backupSql += `INSERT INTO \`${table}\` (${cols}) VALUES (${vals});\n`;
          }
          backupSql += '\n';
        }
      } catch (err: any) {
        backupSql += `-- Notice table ${table}: ${err.message}\n`;
      }
    }
    backupSql += `SET FOREIGN_KEY_CHECKS = 1;\n`;
    fs.writeFileSync(backupFilePath, backupSql, 'utf-8');

    // 2. Clear business data in MySQL
    let totalRowsWiped = 0;
    await this.pool!.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const tbl of businessTables) {
      try {
        const [cntRes]: any = await this.pool!.query(`SELECT COUNT(*) as cnt FROM \`${tbl}\``);
        const count = cntRes && cntRes[0] ? Number(cntRes[0].cnt) : 0;
        totalRowsWiped += count;
        await this.pool!.query(`DELETE FROM \`${tbl}\``);
      } catch (e: any) {
        console.warn(`[Wipe] Notice on table ${tbl}:`, e?.message);
      }
    }
    await this.pool!.query('SET FOREIGN_KEY_CHECKS = 1');

    // 3. Clear in-memory collections (except preserved ones)
    for (const [key] of this.collections.entries()) {
      if (key !== 'users' && key !== 'acl_config' && key !== 'settings') {
        this.collections.set(key, []);
      }
    }
    this.saveDiskSnapshot();

    // 4. Remove local JSON cache if exists
    const cacheFile = path.join(process.cwd(), '.erp_database_cache.json');
    if (fs.existsSync(cacheFile)) {
      try { fs.unlinkSync(cacheFile); } catch {}
    }

    return {
      success: true,
      backupFile: `/backups/${backupFileName}`,
      affectedTables: businessTables,
      affectedBrowserKeys,
      preservedTables,
      recordsWiped: totalRowsWiped,
      message: `Successfully created backup (${backupFileName}) and cleared ${totalRowsWiped} records across ${businessTables.length} tables. Schema and administrative accounts preserved.`
    };
  }

  // ==========================================================
  // WORKFORCE LIVE TRACKING & PRESENCE (PERSISTED IN MYSQL)
  // ==========================================================
  private isEligibleFieldWorkerRole(role?: string | null, isFieldFlag?: any, department?: string | null): boolean {
    if (Boolean(isFieldFlag) && String(isFieldFlag) !== '0' && String(isFieldFlag).toLowerCase() !== 'false') {
      return true;
    }
    const normRole = String(role || '').toLowerCase().trim();
    const normDept = String(department || '').toLowerCase().trim();
    if (!normRole) return false;
    if (
      normRole === 'customer' ||
      normRole === 'admin' ||
      normRole === 'super admin' ||
      normRole.includes('accountant') ||
      normRole.includes('finance') ||
      normRole === 'hr manager' ||
      normRole.includes('director') ||
      normRole.includes('executive assistant')
    ) {
      return false;
    }
    const eligibleRoles = [
      'site survey engineer',
      'site inspector',
      'civil team',
      'civil engineer',
      'structure team',
      'structure engineer',
      'installation team',
      'installation engineer',
      'electrical team',
      'electrical engineer',
      'project engineer',
      'technician',
      'service engineer',
      'service manager'
    ];
    return (
      eligibleRoles.some((r) => normRole.includes(r)) ||
      normDept.includes('engineering') ||
      normDept.includes('installation') ||
      normDept.includes('electrical') ||
      normDept.includes('civil') ||
      normDept.includes('structure') ||
      normDept.includes('service')
    );
  }

  private async loadVerifiedActiveFieldStaffMap(): Promise<{
    byId: Map<string, any>;
    byEmail: Map<string, any>;
    byCode: Map<string, any>;
    allKnownIds: Set<string>;
    allKnownEmails: Set<string>;
  }> {
    this.assertDbConnected();
    const byId = new Map<string, any>();
    const byEmail = new Map<string, any>();
    const byCode = new Map<string, any>();
    const allKnownIds = new Set<string>();
    const allKnownEmails = new Set<string>();

    const register = (rec: {
      id: string;
      employeeCode: string;
      name: string;
      email: string;
      role: string;
      department: string;
      phone: string;
      isFieldWorker: boolean;
      active: boolean;
    }) => {
      if (rec.id) allKnownIds.add(rec.id.trim().toLowerCase());
      if (rec.email) allKnownEmails.add(rec.email.trim().toLowerCase());
      if (!rec.active) return;
      if (!this.isEligibleFieldWorkerRole(rec.role, rec.isFieldWorker, rec.department)) return;

      const idKey = rec.id.trim().toLowerCase();
      const emailKey = rec.email.trim().toLowerCase();
      const codeKey = rec.employeeCode.trim().toLowerCase();
      if (idKey && !byId.has(idKey)) byId.set(idKey, rec);
      if (emailKey && !byEmail.has(emailKey)) byEmail.set(emailKey, rec);
      if (codeKey && !byCode.has(codeKey)) byCode.set(codeKey, rec);
    };

    for (const table of ['solar_employees', 'solar_employee']) {
      try {
        const [empRows]: any = await this.pool!.query(`SELECT * FROM \`${table}\``);
        if (Array.isArray(empRows)) {
          for (const e of empRows) {
            const status = String(e.status || 'ACTIVE').toUpperCase();
            const acctStatus = String(e.account_status || 'ACTIVE').toUpperCase();
            const role = String(e.system_role || e.assigned_role || e.designation || 'Staff');
            const active =
              status !== 'DISABLED' &&
              status !== 'INACTIVE' &&
              status !== 'TERMINATED' &&
              acctStatus !== 'DISABLED' &&
              role.toLowerCase() !== 'customer';
            register({
              id: String(e.id || ''),
              employeeCode: String(e.employee_code || e.id || ''),
              name: String(e.name || 'Employee'),
              email: String(e.email || '').trim().toLowerCase(),
              role,
              department: String(e.department || 'Operations'),
              phone: String(e.phone || ''),
              isFieldWorker: Boolean(e.is_field_worker),
              active
            });
          }
        }
      } catch {
        // Table may not exist in older schemas
      }
    }

    try {
      const [userRows]: any = await this.pool!.query('SELECT * FROM `solar_users`');
      if (Array.isArray(userRows)) {
        for (const u of userRows) {
          const status = String(u.status || 'ACTIVE').toUpperCase();
          const role = String(u.role || 'Staff');
          const active =
            status !== 'DISABLED' &&
            status !== 'INACTIVE' &&
            role.toLowerCase() !== 'customer';
          register({
            id: String(u.id || ''),
            employeeCode: String(u.employee_id || u.id || ''),
            name: String(u.name || 'Staff Member'),
            email: String(u.email || '').trim().toLowerCase(),
            role,
            department: String(u.department || 'Operations'),
            phone: String(u.phone || ''),
            isFieldWorker: Boolean(u.is_field_worker),
            active
          });
        }
      }
    } catch {
      // Ignore if unavailable
    }

    return { byId, byEmail, byCode, allKnownIds, allKnownEmails };
  }

  public async resolveVerifiedFieldStaff(userId?: string, email?: string, employeeCode?: string): Promise<{
    id: string;
    employeeCode: string;
    name: string;
    email: string;
    role: string;
    department: string;
    phone: string;
    isFieldWorker: boolean;
  } | null> {
    const { byId, byEmail, byCode } = await this.loadVerifiedActiveFieldStaffMap();
    const cleanId = String(userId || '').trim().toLowerCase();
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanCode = String(employeeCode || '').trim().toLowerCase();

    return (
      (cleanId && byId.get(cleanId)) ||
      (cleanEmail && byEmail.get(cleanEmail)) ||
      (cleanCode && byCode.get(cleanCode)) ||
      null
    );
  }

  public async getWorkforceLocations(): Promise<any[]> {
    this.assertDbConnected();

    const { byId, byEmail, byCode, allKnownIds, allKnownEmails } = await this.loadVerifiedActiveFieldStaffMap();

    const query = `
      SELECT
        w.user_id AS userId,
        w.employee_code AS employeeCode,
        w.name AS name,
        w.email AS email,
        w.role AS role,
        CAST(w.latitude AS DOUBLE) AS latitude,
        CAST(w.longitude AS DOUBLE) AS longitude,
        CAST(w.accuracy AS DOUBLE) AS accuracy,
        CAST(w.heading AS DOUBLE) AS heading,
        CAST(w.speed AS DOUBLE) AS speed,
        w.battery_level AS batteryLevel,
        w.activity AS activity,
        CASE
          WHEN w.last_seen_at IS NOT NULL AND w.last_seen_at >= DATE_SUB(NOW(), INTERVAL 120 SECOND) AND w.is_online = 1 THEN 1
          ELSE 0
        END AS isOnline,
        w.is_sharing_location AS isSharingLocation,
        w.status AS status,
        DATE_FORMAT(w.last_seen_at, '%Y-%m-%dT%H:%i:%s.000Z') AS lastSeenAt,
        DATE_FORMAT(w.updated_at, '%Y-%m-%dT%H:%i:%s.000Z') AS updatedAt
      FROM \`solar_workforce_locations\` w
      ORDER BY isOnline DESC, w.last_seen_at DESC
    `;

    const [rows]: any = await this.pool!.query(query);
    const seenCanonicalIds = new Set<string>();
    const orphanedUserIds: string[] = [];
    const verifiedRecords: any[] = [];

    for (const r of (Array.isArray(rows) ? rows : [])) {
      const rawId = String(r.userId || '').trim().toLowerCase();
      const rawEmail = String(r.email || '').trim().toLowerCase();
      const rawCode = String(r.employeeCode || '').trim().toLowerCase();

      const staff =
        (rawId && byId.get(rawId)) ||
        (rawEmail && byEmail.get(rawEmail)) ||
        (rawCode && byCode.get(rawCode)) ||
        null;

      if (!staff) {
        // Check if this user doesn't exist in solar_users or solar_employees at all (or is non-field/disabled)
        const existsAnywhere =
          (rawId && allKnownIds.has(rawId)) ||
          (rawEmail && allKnownEmails.has(rawEmail));
        if (!existsAnywhere && r.userId) {
          orphanedUserIds.push(String(r.userId));
        }
        continue;
      }

      if (seenCanonicalIds.has(staff.id)) {
        continue;
      }
      seenCanonicalIds.add(staff.id);

      const isOnline = Boolean(r.isOnline);
      const hasCoords =
        typeof r.latitude === 'number' &&
        typeof r.longitude === 'number' &&
        !isNaN(r.latitude) &&
        !isNaN(r.longitude);
      const speed = typeof r.speed === 'number' ? r.speed : 0;
      let effectiveStatus: string = 'offline';
      if (!isOnline) {
        effectiveStatus = 'offline';
      } else if (hasCoords) {
        effectiveStatus = speed > 3 ? 'moving' : 'idle';
      } else {
        effectiveStatus = 'online';
      }

      verifiedRecords.push({
        userId: staff.id,
        employeeCode: staff.employeeCode || staff.id,
        name: staff.name,
        email: staff.email || '',
        role: staff.role,
        department: staff.department || 'Operations',
        phone: staff.phone || '',
        latitude: hasCoords ? r.latitude : undefined,
        longitude: hasCoords ? r.longitude : undefined,
        accuracy: typeof r.accuracy === 'number' ? r.accuracy : undefined,
        heading: typeof r.heading === 'number' ? r.heading : undefined,
        speed: typeof r.speed === 'number' ? r.speed : undefined,
        batteryLevel: r.batteryLevel !== null && r.batteryLevel !== undefined ? Number(r.batteryLevel) : undefined,
        activity:
          r.activity ||
          (isOnline ? (hasCoords ? (speed > 3 ? 'In Transit / Moving' : 'On Site / Active') : 'Online • Standby') : 'Offline'),
        isOnline,
        isSharingLocation: Boolean(r.isSharingLocation),
        hasLocation: hasCoords,
        status: effectiveStatus,
        lastSeenAt: r.lastSeenAt || new Date().toISOString(),
        updatedAt: r.updatedAt || new Date().toISOString(),
        verified: true
      });
    }

    // Automatically prune orphaned rows from solar_workforce_locations that no longer exist in solar_users/solar_employees
    if (orphanedUserIds.length > 0) {
      for (const orphanId of orphanedUserIds) {
        await this.pool!.query('DELETE FROM `solar_workforce_locations` WHERE `user_id` = ?', [orphanId]).catch(() => {});
      }
    }

    return verifiedRecords;
  }

  public async saveWorkforceLocation(data: {
    userId: string;
    employeeCode?: string;
    name?: string;
    email?: string;
    role?: string;
    latitude: number;
    longitude: number;
    accuracy?: number;
    heading?: number;
    speed?: number;
    batteryLevel?: number;
    activity?: string;
  }): Promise<boolean> {
    const userId = String(data.userId || '').trim();
    if (!userId) return false;
    this.assertDbConnected();

    const verified = await this.resolveVerifiedFieldStaff(userId, data.email, data.employeeCode);
    if (!verified) {
      return false;
    }

    const lat = Number(data.latitude);
    const lng = Number(data.longitude);
    const speed = data.speed !== undefined ? Number(data.speed) : null;
    const isMoving = speed !== null && speed > 3;
    const status = isMoving ? 'moving' : 'idle';
    const activity = data.activity || (isMoving ? 'In Transit / Moving' : 'On Site / Active');

    const sql = `
      INSERT INTO \`solar_workforce_locations\` (
        \`user_id\`, \`employee_code\`, \`name\`, \`email\`, \`role\`,
        \`latitude\`, \`longitude\`, \`accuracy\`, \`heading\`, \`speed\`,
        \`battery_level\`, \`activity\`, \`is_online\`, \`is_sharing_location\`,
        \`status\`, \`last_seen_at\`
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, NOW())
      ON DUPLICATE KEY UPDATE
        \`employee_code\` = VALUES(\`employee_code\`),
        \`name\` = VALUES(\`name\`),
        \`email\` = VALUES(\`email\`),
        \`role\` = VALUES(\`role\`),
        \`latitude\` = VALUES(\`latitude\`),
        \`longitude\` = VALUES(\`longitude\`),
        \`accuracy\` = VALUES(\`accuracy\`),
        \`heading\` = VALUES(\`heading\`),
        \`speed\` = VALUES(\`speed\`),
        \`battery_level\` = COALESCE(VALUES(\`battery_level\`), \`battery_level\`),
        \`activity\` = VALUES(\`activity\`),
        \`is_online\` = 1,
        \`is_sharing_location\` = 1,
        \`status\` = VALUES(\`status\`),
        \`last_seen_at\` = NOW()
    `;

    await this.pool!.query(sql, [
      verified.id,
      verified.employeeCode || null,
      verified.name || null,
      verified.email || null,
      verified.role || null,
      lat,
      lng,
      data.accuracy !== undefined ? Number(data.accuracy) : null,
      data.heading !== undefined ? Number(data.heading) : null,
      speed,
      data.batteryLevel !== undefined ? Number(data.batteryLevel) : null,
      activity,
      status
    ]);
    return true;
  }

  public async saveWorkforceHeartbeat(data: {
    userId: string;
    employeeCode?: string;
    name?: string;
    email?: string;
    role?: string;
    isSharingLocation?: boolean;
  }): Promise<boolean> {
    const userId = String(data.userId || '').trim();
    if (!userId) return false;
    this.assertDbConnected();

    const verified = await this.resolveVerifiedFieldStaff(userId, data.email, data.employeeCode);
    if (!verified) {
      return false;
    }

    const isSharing = Boolean(data.isSharingLocation);
    const sql = `
      INSERT INTO \`solar_workforce_locations\` (
        \`user_id\`, \`employee_code\`, \`name\`, \`email\`, \`role\`,
        \`is_online\`, \`is_sharing_location\`, \`status\`, \`last_seen_at\`
      ) VALUES (?, ?, ?, ?, ?, 1, ?, 'online', NOW())
      ON DUPLICATE KEY UPDATE
        \`employee_code\` = VALUES(\`employee_code\`),
        \`name\` = VALUES(\`name\`),
        \`email\` = VALUES(\`email\`),
        \`role\` = VALUES(\`role\`),
        \`is_online\` = 1,
        \`is_sharing_location\` = VALUES(\`is_sharing_location\`),
        \`status\` = CASE
          WHEN \`latitude\` IS NOT NULL AND \`longitude\` IS NOT NULL THEN (
            CASE WHEN \`speed\` IS NOT NULL AND \`speed\` > 3 THEN 'moving' ELSE 'idle' END
          )
          ELSE 'online'
        END,
        \`last_seen_at\` = NOW()
    `;

    await this.pool!.query(sql, [
      verified.id,
      verified.employeeCode || null,
      verified.name || null,
      verified.email || null,
      verified.role || null,
      isSharing ? 1 : 0
    ]);
    return true;
  }

  public async setWorkforceOffline(userId: string, email?: string): Promise<boolean> {
    const cleanId = String(userId || '').trim();
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanId && !cleanEmail) return false;
    this.assertDbConnected();

    await this.pool!.query(
      'UPDATE `solar_workforce_locations` SET `is_online` = 0, `is_sharing_location` = 0, `status` = \'offline\' WHERE `user_id` = ?' +
        (cleanEmail ? ' OR LOWER(`email`) = ?' : ''),
      cleanEmail ? [cleanId, cleanEmail] : [cleanId]
    );
    return true;
  }

  // ==========================================================
  // BOOTSTRAP EXPORT: AUTHORITATIVE DATA FROM MYSQL
  // ==========================================================
  public async getSalesReturns(): Promise<any[]> {
    if (!this.isConnected || !this.pool) return [];
    return await accountingService.getSalesReturns(this.pool);
  }

  public async getPurchaseReturns(): Promise<any[]> {
    if (!this.isConnected || !this.pool) return [];
    return await accountingService.getPurchaseReturns(this.pool);
  }

  public async getAllData(): Promise<Record<string, any>> {
    this.assertDbConnected();
    const [
      customers,
      leads,
      projects,
      employees,
      payments,
      expenses,
      products,
      vendors,
      purchase_orders,
      sales_invoices,
      vendor_sales_invoices,
      sales_returns,
      purchase_returns,
      attendance,
      payslips,
      holidays,
      quotations,
      surveys,
      boms,
      warehouses,
      stock_movements,
      stock_audits,
      service_tickets,
      amc_contracts,
      notifications,
      users,
      settings,
      acl_config,
      acl_audit_logs
    ] = await Promise.all([
      this.getCustomers(),
      this.getLeads(),
      this.getProjects(),
      this.getEmployees(),
      this.getPayments(),
      this.getExpenses(),
      this.getProducts(),
      this.getVendors(),
      this.getPurchaseOrders(),
      this.getSalesInvoices(),
      this.getVendorSalesInvoices(),
      this.getSalesReturns().catch(() => []),
      this.getPurchaseReturns().catch(() => []),
      this.getAttendance(),
      this.getPayslips(),
      this.getHolidays(),
      this.getQuotations(),
      this.getSurveys(),
      this.getBOMs(),
      this.getWarehouses(),
      this.getStockMovements(),
      this.getStockAudits(),
      this.getServiceTickets(),
      this.getAMCContracts(),
      this.getNotifications(),
      this.getUsers(),
      this.getSettings(),
      this.getAclConfig(),
      this.getAclAuditLogs()
    ]);

    return {
      customers,
      leads,
      projects,
      employees,
      payments,
      expenses,
      products,
      vendors,
      purchase_orders,
      sales_invoices,
      vendor_sales_invoices,
      sales_returns,
      purchase_returns,
      attendance,
      payslips,
      holidays,
      quotations,
      surveys,
      boms,
      warehouses,
      stock_movements,
      stock_audits,
      service_tickets,
      amc_contracts,
      notifications,
      users,
      settings,
      acl_config,
      acl_audit_logs
    };
  }

  public async recordAuditLog(log: {
    actorId?: string;
    actorName?: string;
    actorRole?: string;
    module: string;
    action: string;
    entityType?: string;
    entityId?: string;
    summary: string;
    details?: any;
    ipAddress?: string;
    userAgent?: string;
    status?: string;
  }): Promise<any> {
    const entry = {
      id: `audit-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      actorId: String(log.actorId || 'system'),
      actorName: String(log.actorName || 'System'),
      actorRole: String(log.actorRole || 'System'),
      module: String(log.module || 'SYSTEM').toUpperCase(),
      action: String(log.action || 'EVENT').toUpperCase(),
      entityType: String(log.entityType || ''),
      entityId: String(log.entityId || ''),
      summary: String(log.summary || ''),
      details: log.details ?? null,
      ipAddress: String(log.ipAddress || ''),
      userAgent: String(log.userAgent || '').slice(0, 480),
      status: String(log.status || 'SUCCESS').toUpperCase(),
      createdAt: new Date().toISOString()
    };
    if (!this.isConnected || !this.pool) {
      return inMemoryDbStore.recordAuditLog(entry);
    }
    try {
      await this.pool.query(
        `INSERT INTO \`solar_audit_logs\`
         (\`id\`, \`actor_id\`, \`actor_name\`, \`actor_role\`, \`module\`, \`action\`, \`entity_type\`, \`entity_id\`, \`summary\`, \`details_json\`, \`ip_address\`, \`user_agent\`, \`status\`)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.id,
          entry.actorId,
          entry.actorName,
          entry.actorRole,
          entry.module,
          entry.action,
          entry.entityType,
          entry.entityId,
          entry.summary,
          entry.details !== null && entry.details !== undefined ? JSON.stringify(entry.details) : null,
          entry.ipAddress,
          entry.userAgent,
          entry.status
        ]
      );
    } catch (err: any) {
      console.warn('[AuditLog] Failed to persist MySQL audit entry:', err?.message || err);
    }
    return entry;
  }

  public async getAuditLogs(filters?: { module?: string; action?: string; actorId?: string; limit?: number }): Promise<any[]> {
    if (!this.isConnected || !this.pool) {
      return inMemoryDbStore.getAuditLogs(filters);
    }
    const conds: string[] = [];
    const params: any[] = [];
    if (filters?.module) {
      conds.push('UPPER(`module`) = ?');
      params.push(filters.module.trim().toUpperCase());
    }
    if (filters?.action) {
      conds.push('UPPER(`action`) = ?');
      params.push(filters.action.trim().toUpperCase());
    }
    if (filters?.actorId) {
      conds.push('`actor_id` = ?');
      params.push(filters.actorId.trim());
    }
    const max = Math.min(Math.max(Number(filters?.limit) || 200, 1), 1000);
    const whereClause = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const [rows]: any = await this.pool.query(
      `SELECT * FROM \`solar_audit_logs\` ${whereClause} ORDER BY \`created_at\` DESC LIMIT ?`,
      [...params, max]
    );
    return (rows || []).map((r: any) => {
      let details: any = null;
      try {
        if (r.details_json) details = JSON.parse(r.details_json);
      } catch {}
      return {
        id: r.id,
        actorId: r.actor_id,
        actorName: r.actor_name,
        actorRole: r.actor_role,
        module: r.module,
        action: r.action,
        entityType: r.entity_type || '',
        entityId: r.entity_id || '',
        summary: r.summary,
        details,
        ipAddress: r.ip_address || '',
        userAgent: r.user_agent || '',
        status: r.status || 'SUCCESS',
        createdAt: r.created_at
      };
    });
  }
}

const realDbManager = new MySqlDatabaseManager();

const DB_LIFECYCLE_METHODS = new Set([
  'init',
  'getStatus',
  'getPool',
  'isDbConnected',
  'testConnection',
  'runFullMigration'
]);

export const dbManager: MySqlDatabaseManager = new Proxy(realDbManager, {
  get(target, prop, receiver) {
    if (
      typeof prop === 'string' &&
      !DB_LIFECYCLE_METHODS.has(prop) &&
      !target.isDbConnected() &&
      prop in inMemoryDbStore
    ) {
      const fallbackVal = (inMemoryDbStore as any)[prop];
      if (typeof fallbackVal === 'function') {
        return fallbackVal.bind(inMemoryDbStore);
      }
      return fallbackVal;
    }
    const val = Reflect.get(target, prop, receiver);
    return typeof val === 'function' ? val.bind(target) : val;
  }
});
