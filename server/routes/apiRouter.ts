import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { dbManager, getDbConfigFromEnv } from '../mysqlDatabase';
import { generateToken, verifyToken } from '../services/tokenService';
import { authService } from '../services/authService';
import { accountingService } from '../services/accountingService';
import {
  decryptSecret,
  encryptSecret,
  formatSmtpError,
  isValidEmailAddress,
  normalizeAppPassword,
  sendConfiguredEmail,
  SmtpSecurity,
  validateEmailConfigInput,
  verifyAndSendTestEmail
} from '../services/emailService';

export const apiRouter = Router();

// Initialize DB Manager
dbManager.init().catch(err => {
  console.warn('[DB Manager] Startup notice connecting to MySQL:', err?.message || err);
});

// Role-based helper functions
export function isCustomerUser(user: any): boolean {
  if (!user) return false;
  const accountType = String(user.accountType || '').toUpperCase();
  const role = String(user.role || '').toUpperCase();
  return accountType === 'CUSTOMER' || role === 'CUSTOMER' || role === 'CLIENT';
}

export function isStaffOrAdminUser(user: any): boolean {
  if (!user) return false;
  const accountType = String(user.accountType || '').toUpperCase();
  const role = String(user.role || '').toUpperCase();
  if (accountType === 'ADMIN' || accountType === 'EMPLOYEE') return true;
  if (role === 'ADMIN' || role === 'SUPER ADMIN') return true;
  const allowed = [
    'PROJECT MANAGER', 'SITE ENGINEER', 'TECHNICIAN', 'QUALITY INSPECTOR',
    'FIELD EXECUTIVE', 'OPERATIONS', 'SOLAR TECHNICIAN', 'ENGINEER',
    'SALES EXECUTIVE', 'HR MANAGER', 'ACCOUNTANT', 'EMPLOYEE'
  ];
  return allowed.includes(role);
}

// Unified session token extractor from cookies (parsed or raw header), Bearer authorization, or custom header
export function extractSessionToken(req: Request): string | null {
  // 1. Direct cookie-parser
  if (req.cookies && req.cookies.rejoysolar_session) {
    const val = String(req.cookies.rejoysolar_session).trim();
    if (val && val !== 'null' && val !== 'undefined') return val;
  }
  if (req.cookies && req.cookies.rejoysolar_session_lax) {
    const val = String(req.cookies.rejoysolar_session_lax).trim();
    if (val && val !== 'null' && val !== 'undefined') return val;
  }
  // 2. Fallback to raw Cookie header regex for rejoysolar_session
  if (req.headers.cookie) {
    const match = req.headers.cookie.match(/(?:^|;\s*)rejoysolar_session=([^;]*)/);
    if (match && match[1]) {
      const decoded = decodeURIComponent(match[1].trim());
      if (decoded && decoded !== 'null' && decoded !== 'undefined') return decoded;
    }
    const laxMatch = req.headers.cookie.match(/(?:^|;\s*)rejoysolar_session_lax=([^;]*)/);
    if (laxMatch && laxMatch[1]) {
      const decoded = decodeURIComponent(laxMatch[1].trim());
      if (decoded && decoded !== 'null' && decoded !== 'undefined') return decoded;
    }
    const legacyMatch = req.headers.cookie.match(/(?:^|;\s*)rejoysolar_auth_token=([^;]*)/);
    if (legacyMatch && legacyMatch[1]) {
      const decoded = decodeURIComponent(legacyMatch[1].trim());
      if (decoded && decoded !== 'null' && decoded !== 'undefined') return decoded;
    }
  }
  // 3. Authorization Bearer header
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const h = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
    if (h && h !== 'null' && h !== 'undefined') return h;
  }
  // 4. Custom token headers
  const xAuth = (req.headers['x-auth-token'] as string) || (req.headers['x-session-token'] as string);
  if (xAuth && typeof xAuth === 'string') {
    const val = xAuth.trim();
    if (val && val !== 'null' && val !== 'undefined') return val;
  }
  return null;
}

// Role-based authorization middleware
export async function authenticateSessionMiddleware(req: Request, _res: Response, next: () => void) {
  try {
    const token = extractSessionToken(req);
    const pool = dbManager.getPool();

    if (token && pool) {
      const val = await authService.validateSession(pool, token);
      if (val.valid && val.user) {
        (req as any).user = val.user;
        return next();
      }
    }

    if (token) {
      const jwtVal = verifyToken(token);
      if (jwtVal.valid && jwtVal.payload) {
        const u = await dbManager.findUserByIdOrEmail(jwtVal.payload.sub || jwtVal.payload.email);
        if (u) {
          (req as any).user = u;
          return next();
        }
      }
    }
  } catch (err: any) {
    console.warn('[Auth Middleware] Verification notice:', err?.message || err);
  }
  next();
}

// Mount session authenticator globally on API router
apiRouter.use(authenticateSessionMiddleware);

export function requireRole(allowedRoles: string[]) {
  return (req: Request, res: Response, next: () => void) => {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ success: false, message: 'Authentication required. Please log in.' });
    }
    if (user.role === 'Admin' || user.role === 'Super Admin' || allowedRoles.includes(user.role)) {
      return next();
    }
    return res.status(403).json({ success: false, message: 'Access denied: Insufficient privileges.' });
  };
}

// Admin security check for sensitive database migration and dump endpoints
async function checkAdminAuth(req: Request, res: Response, next: () => void) {
  let user = (req as any).user;
  if (!user) {
    const adminKey = req.headers['x-admin-token'] || req.headers['x-admin-key'];
    const pool = dbManager.getPool();
    if (adminKey && typeof adminKey === 'string' && pool) {
      const val = await authService.validateSession(pool, adminKey.trim()).catch(() => ({ valid: false, user: null }));
      if (val.valid && val.user) {
        user = val.user;
        (req as any).user = user;
      }
    }
  }
  if (user && (user.role === 'Admin' || user.role === 'Super Admin')) {
    return next();
  }
  if (!user) {
    res.status(401).json({ success: false, error: 'Authentication required. Valid Administrator session required.' });
    return;
  }
  res.status(403).json({ success: false, error: 'Access Denied: Administrative authorization required for database operations.' });
}

function requireAuthenticatedUser(req: Request, res: Response, next: () => void) {
  const user = (req as any).user;
  if (!user) {
    return res.status(401).json({ success: false, message: 'Authentication required. Please log in.' });
  }
  next();
}

function requireStaffUser(req: Request, res: Response, next: () => void) {
  const user = (req as any).user;
  if (!user) {
    return res.status(401).json({ success: false, message: 'Authentication required. Please log in.' });
  }
  if (isCustomerUser(user)) {
    return res.status(403).json({ success: false, message: 'Access denied: Customer accounts cannot perform this action.' });
  }
  next();
}

function getCustomerMatchTokens(user: any): { custId: string; email: string; name: string } {
  return {
    custId: String(user?.customerId || user?.linkedEntityId || '').trim(),
    email: String(user?.email || '').trim().toLowerCase(),
    name: String(user?.name || '').trim().toLowerCase()
  };
}

function recordAuditFromReq(
  req: Request,
  entry: {
    actor?: any;
    module: string;
    action: string;
    entityType?: string;
    entityId?: string;
    summary: string;
    details?: any;
    status?: string;
  }
) {
  const actor = entry.actor || (req as any).user;
  dbManager
    .recordAuditLog({
      actorId: actor?.id || 'anonymous',
      actorName: actor?.name || actor?.email || 'Anonymous',
      actorRole: actor?.role || 'Unauthenticated',
      module: entry.module,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      summary: entry.summary,
      details: entry.details,
      ipAddress: req.ip || '',
      userAgent: String(req.headers['user-agent'] || ''),
      status: entry.status || 'SUCCESS'
    })
    .catch(() => {});
}

// Strict Admin-only middleware for sensitive Gmail SMTP credential endpoints (no localhost bypass)
function requireAdminOnly(req: Request, res: Response, next: () => void) {
  const user = (req as any).user;
  if (!user) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required. Please log in as an Administrator.'
    });
  }
  const role = String(user.role || '').trim().toUpperCase();
  if (role !== 'ADMIN' && role !== 'SUPER ADMIN') {
    return res.status(403).json({
      success: false,
      message: 'Access denied: Only authorized Administrators can view or modify Gmail email configuration.'
    });
  }
  next();
}

function requireVendorSalesInvoiceAdmin(req: Request, res: Response, next: () => void) {
  const user = (req as any).user;
  if (!user) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required. Please log in as an Administrator.'
    });
  }
  const role = String(user.role || '').trim().toUpperCase();
  if (role !== 'ADMIN' && role !== 'SUPER ADMIN') {
    return res.status(403).json({
      success: false,
      message: 'Access denied: Only Administrators can view, create, edit, or manage Vendor Sales Invoices.'
    });
  }
  next();
}

function sendApiError(res: Response, err: any, fallbackMessage: string, extra?: Record<string, any>) {
  const isUnavailable = err?.code === 'DB_UNAVAILABLE' || err?.statusCode === 503 || err?.name === 'DbConnectionError';
  const statusCode = isUnavailable ? 503 : (typeof err?.statusCode === 'number' ? err.statusCode : 500);
  res.status(statusCode).json({
    success: false,
    code: err?.code || (isUnavailable ? 'DB_UNAVAILABLE' : 'SERVER_ERROR'),
    error: err?.message || fallbackMessage,
    message: err?.message || fallbackMessage,
    ...(extra || {})
  });
}

// ==========================================================
// 1. DATABASE & PRODUCTION MIGRATION APIS
// ==========================================================

// DB Status & Diagnostics
apiRouter.get('/db/status', (_req: Request, res: Response) => {
  try {
    const status = dbManager.getStatus();
    res.json({
      success: true,
      ...status,
      message: status.connected
        ? `Connected to MySQL database "${status.database}" on ${status.host}:${status.port}`
        : `MySQL database connection failed or disconnected.`,
      tables: [
        'solar_users', 'solar_customers', 'solar_leads', 'solar_projects',
        'solar_project_stages', 'solar_site_surveys', 'solar_quotations',
        'solar_payments', 'solar_expenses', 'solar_employees', 'solar_attendance',
        'solar_payslips', 'solar_holidays', 'solar_leave_requests', 'solar_leave_balances', 'solar_service_tickets', 'solar_amc_contracts',
        'solar_notifications', 'solar_products', 'solar_vendors', 'solar_purchase_orders',
        'solar_boms', 'solar_sales_invoices', 'solar_vendor_sales_invoices', 'solar_vendor_sales_invoice_items', 'solar_vendor_sales_payments',
        'solar_sales_returns', 'solar_sales_return_items', 'solar_purchase_returns', 'solar_purchase_return_items',
        'solar_warehouses', 'solar_stock_movements',
        'solar_stock_audits', 'solar_acl_config', 'solar_acl_audit_logs', 'solar_audit_logs',
        'solar_system_settings', 'solar_workforce_locations'
      ]
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to get DB status' });
  }
});

// Test custom MySQL connection (Admin only)
apiRouter.post('/db/test-connection', requireAdminOnly, async (req: Request, res: Response) => {
  try {
    const { host, port, user, password, database } = req.body || {};
    const envConfig = getDbConfigFromEnv();
    const result = await dbManager.testConnection({
      host: host || envConfig.host,
      port: Number(port) || envConfig.port,
      user: user || envConfig.user,
      password: password !== undefined ? password : envConfig.password,
      database: database || envConfig.database
    });
    res.json(result);
  } catch (err: any) {
    sendApiError(res, err, 'Connection test error');
  }
});

// Push schema and migrate all existing data (Protected)
apiRouter.post('/db/migrate', checkAdminAuth, async (req: Request, res: Response) => {
  try {
    const customConfig = req.body || {};
    const result = await dbManager.runFullMigration(customConfig);
    recordAuditFromReq(req, {
      module: 'DATABASE',
      action: 'MIGRATE',
      entityType: 'schema',
      summary: 'Executed database schema migration'
    });
    res.json(result);
  } catch (err: any) {
    sendApiError(res, err, 'Migration error');
  }
});

// Secure ERP data wipe with automatic pre-wipe database backup (Protected)
apiRouter.post('/db/wipe', checkAdminAuth, async (req: Request, res: Response) => {
  try {
    const { confirmation } = req.body || {};
    if (confirmation !== 'CONFIRM_WIPE_ERP_DATA') {
      res.status(400).json({
        success: false,
        message: 'Explicit confirmation required. Send { confirmation: "CONFIRM_WIPE_ERP_DATA" }'
      });
      return;
    }
    const result = await dbManager.backupAndWipeData(confirmation);
    recordAuditFromReq(req, {
      module: 'DATABASE',
      action: 'WIPE',
      entityType: 'erp_data',
      summary: 'Wiped business ERP data with pre-wipe backup'
    });
    res.json(result);
  } catch (err: any) {
    sendApiError(res, err, 'Data wipe error');
  }
});

// Download standalone SQL database dump (Protected)
apiRouter.get(['/db/dump.sql', '/db/export-sql'], checkAdminAuth, (_req: Request, res: Response) => {
  const dumpPath = path.join(process.cwd(), 'database.sql');
  if (fs.existsSync(dumpPath)) {
    res.setHeader('Content-Type', 'application/sql');
    res.setHeader('Content-Disposition', 'attachment; filename="solar_urja_erp_production_mysql.sql"');
    fs.createReadStream(dumpPath).pipe(res);
  } else {
    res.status(404).json({ success: false, error: 'Database dump file not found.' });
  }
});

// ==========================================================
// 2. MASTER BOOTSTRAP API (ONE ROUND-TRIP HYDRATION FROM MYSQL)
// ==========================================================

apiRouter.get('/bootstrap', requireAuthenticatedUser, async (req: Request, res: Response) => {
  try {
    const data = await dbManager.getAllData();
    const user = (req as any).user;
    const role = String(user?.role || '').trim().toUpperCase();
    if (role !== 'ADMIN' && role !== 'SUPER ADMIN') {
      data.vendor_sales_invoices = [];
    }
    if (isCustomerUser(user)) {
      const { custId, email, name } = getCustomerMatchTokens(user);
      const ownedCustomerIds = new Set(
        (data.customers || [])
          .filter((c: any) =>
            (custId && c.id === custId) ||
            (email && String(c.email || '').trim().toLowerCase() === email)
          )
          .map((c: any) => c.id)
      );
      if (custId) ownedCustomerIds.add(custId);

      data.customers = (data.customers || []).filter((c: any) => ownedCustomerIds.has(c.id));
      data.projects = (data.projects || []).filter((p: any) =>
        ownedCustomerIds.has(p.customerId) ||
        (name && String(p.customerName || '').trim().toLowerCase() === name)
      );
      const ownedProjectIds = new Set((data.projects || []).map((p: any) => p.id));
      data.quotations = (data.quotations || []).filter((q: any) =>
        ownedCustomerIds.has(q.customerId) ||
        ownedProjectIds.has(q.projectId) ||
        (name && String(q.customerName || '').trim().toLowerCase() === name)
      );
      data.payments = (data.payments || []).filter((p: any) =>
        ownedCustomerIds.has(p.customerId) ||
        ownedProjectIds.has(p.projectId) ||
        (name && String(p.customerName || '').trim().toLowerCase() === name)
      );
      data.service_tickets = (data.service_tickets || []).filter((t: any) =>
        ownedCustomerIds.has(t.customerId) ||
        ownedProjectIds.has(t.projectId) ||
        (name && String(t.customerName || '').trim().toLowerCase() === name)
      );
      data.amc_contracts = (data.amc_contracts || []).filter((a: any) =>
        ownedCustomerIds.has(a.customerId) ||
        ownedProjectIds.has(a.projectId) ||
        (name && String(a.customerName || '').trim().toLowerCase() === name)
      );
      data.sales_invoices = (data.sales_invoices || []).filter((inv: any) =>
        ownedCustomerIds.has(inv.customerId) ||
        ownedProjectIds.has(inv.projectId) ||
        (name && String(inv.customerName || '').trim().toLowerCase() === name)
      );
      data.leads = [];
      data.employees = [];
      data.attendance = [];
      data.payslips = [];
      data.vendors = [];
      data.products = [];
      data.warehouses = [];
      data.expenses = [];
      data.surveys = [];
      data.boms = [];
      data.stock_movements = [];
      data.stock_audits = [];
      data.sales_returns = [];
      data.purchase_returns = [];
      data.purchase_orders = [];
      data.users = [];
      data.acl_audit_logs = [];
    }
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      data
    });
  } catch (err: any) {
    sendApiError(res, err, 'Bootstrap load error');
  }
});

// Bulk & Entity sync endpoint for data updates directly to MySQL
apiRouter.post('/sync/push', async (req: Request, res: Response) => {
  const { collection, item, items, action, payload } = req.body || {};
  let effectiveItem = item || payload;

  try {
    if (!collection) {
      res.status(400).json({ success: false, message: 'Collection name is required.' });
      return;
    }

    // Enforce authenticated MySQL session + collection-level RBAC
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required. Please log in with an active session.'
      });
    }

    const normalizedCollection = String(collection).toLowerCase();
    const adminOnlyCollections = [
      'users',
      'solar_users',
      'acl_config',
      'solar_acl_config',
      'settings',
      'solar_system_settings',
      'warehouses',
      'solar_warehouses',
      'vendor_sales_invoices',
      'solar_vendor_sales_invoices'
    ];
    const hrCollections = ['employees', 'employee', 'solar_employees', 'solar_employee'];

    if (isCustomerUser(user)) {
      const customerWritable = ['service_tickets', 'solar_service_tickets', 'notifications', 'solar_notifications'];
      if (!customerWritable.includes(normalizedCollection)) {
        return res.status(403).json({
          success: false,
          error: 'Forbidden: Customers have read-only access to project stages, progress, and system data.'
        });
      }
    } else if (adminOnlyCollections.includes(normalizedCollection)) {
      const roleUpper = String(user.role || '').trim().toUpperCase();
      if (roleUpper !== 'ADMIN' && roleUpper !== 'SUPER ADMIN') {
        return res.status(403).json({
          success: false,
          error: 'Forbidden: Only Administrators can modify users, permissions, settings, warehouses, or vendor sales invoices.'
        });
      }
    } else if (hrCollections.includes(normalizedCollection)) {
      if (!['Admin', 'Super Admin', 'HR Manager'].includes(user.role)) {
        return res.status(403).json({
          success: false,
          error: 'Forbidden: Only Administrators or HR Managers can modify employee directory records.'
        });
      }
    }

    // For singleton stores like settings and acl_config, allow passing either directly or via items
    if (!effectiveItem && (collection === 'settings' || collection === 'acl_config')) {
      effectiveItem = items || req.body.settings || req.body.config || req.body;
    }

    // Enforce Admin-only updates on existing service tickets or technician assignments via /sync/push
    if ((normalizedCollection === 'service_tickets' || normalizedCollection === 'solar_service_tickets') && effectiveItem) {
      const actorRoleUpper = String(user.role || '').trim().toUpperCase();
      const isActorAdmin = actorRoleUpper === 'ADMIN' || actorRoleUpper === 'SUPER ADMIN';
      if (!isActorAdmin) {
        if (action === 'delete' || req.body.isDelete) {
          return res.status(403).json({ success: false, error: 'Forbidden: Only Administrators can delete service tickets.' });
        }
        const existingRow = effectiveItem.id ? await dbManager.getServiceTicketRowByIdOrCode(effectiveItem.id) : null;
        if (existingRow) {
          return res.status(403).json({
            success: false,
            error: 'Forbidden: Only Administrators can modify service ticket status, priority, or technician assignment.'
          });
        }
        // New ticket by non-admin/customer must start OPEN and unassigned
        effectiveItem = {
          ...effectiveItem,
          status: 'OPEN',
          assignedTechnicianId: '',
          assignedTechnicianName: '',
          assignedToName: 'Unassigned'
        };
      }
    }

    // Handle delete action
    const deleteId = effectiveItem?.id || req.body?.id || (typeof effectiveItem === 'string' ? effectiveItem : null);
    if (deleteId && (action === 'delete' || req.body.isDelete)) {
      await dbManager.deleteItem(collection, deleteId);
      recordAuditFromReq(req, {
        module: normalizedCollection.toUpperCase(),
        action: 'SYNC_DELETE',
        entityType: normalizedCollection,
        entityId: String(deleteId),
        summary: `Deleted ${deleteId} from ${collection}`
      });
      res.json({ success: true, message: `Deleted from ${collection}` });
      return;
    }

    // Handle single item save
    if (effectiveItem) {
      const saved =
        normalizedCollection === 'service_tickets' || normalizedCollection === 'solar_service_tickets'
          ? await dbManager.saveServiceTicket(effectiveItem, user)
          : normalizedCollection === 'vendor_sales_invoices' || normalizedCollection === 'solar_vendor_sales_invoices'
          ? await dbManager.saveVendorSalesInvoice(effectiveItem, user)
          : await dbManager.saveItem(collection, effectiveItem);
      recordAuditFromReq(req, {
        module: normalizedCollection.toUpperCase(),
        action: 'SYNC_SAVE',
        entityType: normalizedCollection,
        entityId: String(effectiveItem.id || 'singleton'),
        summary: `Saved ${effectiveItem.id || 'singleton'} in ${collection}`
      });
      res.json({ success: true, data: saved, message: `Saved to ${collection}` });
      return;
    }

    // Handle array batch save
    if (items && Array.isArray(items)) {
      for (const it of items) {
        if (it && (it.id || collection === 'settings' || collection === 'acl_config')) {
          await dbManager.saveItem(collection, it);
        }
      }
      recordAuditFromReq(req, {
        module: normalizedCollection.toUpperCase(),
        action: 'SYNC_BATCH_SAVE',
        entityType: normalizedCollection,
        summary: `Batch synced ${items.length} records in ${collection}`
      });
      res.json({ success: true, count: items.length, message: `Synced ${collection} to MySQL` });
      return;
    }

    res.status(400).json({ success: false, message: 'Invalid sync payload. Expected "item" or "items" array.' });
  } catch (err: any) {
    // Safe diagnostics logging without sensitive user or auth credentials
    const safeDiagnostics = {
      collection: collection || 'unknown',
      action: action || 'save',
      recordId: effectiveItem?.id || (Array.isArray(items) ? `batch_${items.length}` : undefined),
      errorMessage: err?.message || String(err),
      sqlState: err?.sqlState,
      sqlCode: err?.code,
      timestamp: new Date().toISOString()
    };
    console.error(`[MySQL Write Error] Write failure in collection "${collection}":`, safeDiagnostics);
    const isUnavailable = err?.code === 'DB_UNAVAILABLE' || err?.statusCode === 503;
    const statusCode = err?.statusCode === 400 ? 400 : (isUnavailable ? 503 : 500);
    res.status(statusCode).json({
      success: false,
      code: err?.code || (statusCode === 400 ? 'VALIDATION_ERROR' : isUnavailable ? 'DB_UNAVAILABLE' : 'SERVER_ERROR'),
      error: err?.message || 'Sync error',
      diagnostics: safeDiagnostics
    });
  }
});

// ==========================================================
// 3. AUTHENTICATION & ADMIN REGISTRATION APIS (MYSQL BACKED)
// ==========================================================

apiRouter.get(['/auth/registration-status', '/auth/registration-status/'], async (_req: Request, res: Response) => {
  try {
    const status = await dbManager.getAdminRegistrationStatus();
    res.json({ success: true, ...status });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to check registration status');
  }
});


apiRouter.post(['/auth/register', '/auth/register/'], async (req: Request, res: Response) => {
  try {
    const { name, email, password, confirmPassword, phone, department, designation } = req.body || {};

    if (!name || !email || !password) {
      res.status(400).json({ success: false, message: 'Name, email, and password are required.' });
      return;
    }

    if (confirmPassword && password !== confirmPassword) {
      res.status(400).json({ success: false, message: 'Passwords do not match.' });
      return;
    }

    if (String(password).length < 6) {
      res.status(400).json({ success: false, message: 'Password must be at least 6 characters long.' });
      return;
    }

    // Check if caller has an active Admin session (never trust arbitrary non-empty tokens)
    const callerUser = (req as any).user;
    let isAuthorizedByAdmin = Boolean(
      callerUser && (callerUser.role === 'Admin' || callerUser.role === 'Super Admin')
    );
    if (!isAuthorizedByAdmin) {
      const adminKey = req.headers['x-admin-token'] || req.headers['x-admin-key'];
      const authPool = dbManager.getPool();
      if (adminKey && typeof adminKey === 'string' && authPool) {
        const keyCheck = await authService.validateSession(authPool, adminKey.trim()).catch(() => ({ valid: false, user: null }));
        if (keyCheck.valid && keyCheck.user && (keyCheck.user.role === 'Admin' || keyCheck.user.role === 'Super Admin')) {
          isAuthorizedByAdmin = true;
        }
      }
    }

    const user = await dbManager.registerAdmin(
      {
        name,
        email,
        password,
        phone,
        department,
        designation
      },
      isAuthorizedByAdmin
    );

    const pool = dbManager.getPool();
    let sessionToken = '';
    if (pool) {
      sessionToken = await authService.createSession(pool, {
        userId: user.id,
        email: user.email,
        role: user.role || 'Admin',
        accountType: 'ADMIN',
        linkedEntityId: user.id,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent']
      });
      authService.setSessionCookie(res, req, sessionToken);
    } else {
      sessionToken = generateToken(user);
    }

    recordAuditFromReq(req, {
      actor: user,
      module: 'AUTH',
      action: 'ADMIN_REGISTER',
      entityType: 'user',
      entityId: user.id,
      summary: `Registered administrator account ${user.email}`
    });

    res.status(201).json({
      success: true,
      message: 'Admin account created successfully in MySQL.',
      user,
      token: sessionToken
    });
  } catch (err: any) {
    const msg = err?.message || 'Registration failed';
    const isUnavailable = err?.code === 'DB_UNAVAILABLE' || err?.statusCode === 503;
    const isConflict = msg.includes('already exists') || msg.includes('already registered');
    const isForbidden = msg.includes('registration is closed');
    res.status(isUnavailable ? 503 : isConflict ? 409 : isForbidden ? 403 : 500).json({
      success: false,
      code: err?.code,
      message: msg
    });
  }
});

apiRouter.post(['/auth/login', '/auth/login/'], async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      res.status(400).json({ success: false, message: 'Email and password are required.' });
      return;
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const cleanPass = String(password).trim();
    const pool = dbManager.getPool();

    let authResult: { user: any; sessionToken: string } | null = null;

    if (pool) {
      try {
        authResult = await authService.authenticate(pool, cleanEmail, cleanPass, {
          ip: req.ip,
          userAgent: req.headers['user-agent']
        });
      } catch (authErr: any) {
        if (String(authErr?.message || '').toLowerCase().includes('disabled')) {
          recordAuditFromReq(req, {
            module: 'AUTH',
            action: 'LOGIN',
            entityType: 'user',
            summary: `Blocked disabled account login for ${cleanEmail}`,
            status: 'DISABLED'
          });
          res.status(403).json({ success: false, message: authErr.message });
          return;
        }
        console.warn('[Login] Centralized auth check notice:', authErr?.message || authErr);
      }
    }

    // Fallback authentication via dbManager if needed
    if (!authResult) {
      let legacyUser: any = null;
      try {
        legacyUser = await dbManager.authenticateUser(cleanEmail, cleanPass);
      } catch (legacyErr: any) {
        if (String(legacyErr?.message || '').toLowerCase().includes('disabled')) {
          recordAuditFromReq(req, {
            module: 'AUTH',
            action: 'LOGIN',
            entityType: 'user',
            summary: `Blocked disabled account login for ${cleanEmail}`,
            status: 'DISABLED'
          });
          res.status(403).json({ success: false, message: legacyErr.message });
          return;
        }
        throw legacyErr;
      }
      if (legacyUser) {
        const upperRole = String(legacyUser.role || '').trim().toUpperCase();
        const derivedAccountType =
          upperRole === 'CUSTOMER'
            ? 'CUSTOMER'
            : (upperRole === 'ADMIN' || upperRole === 'SUPER ADMIN' ? 'ADMIN' : 'EMPLOYEE');
        let sessToken = '';
        if (pool) {
          sessToken = await authService.createSession(pool, {
            userId: legacyUser.id,
            email: legacyUser.email,
            role: legacyUser.role || 'Admin',
            accountType: derivedAccountType,
            linkedEntityId: legacyUser.customerId || legacyUser.employeeId || legacyUser.id,
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
          });
        } else {
          sessToken = generateToken(legacyUser);
        }
        authResult = { user: legacyUser, sessionToken: sessToken };
      }
    }

    if (authResult) {
      // Set secure HttpOnly cookie on client response
      authService.setSessionCookie(res, req, authResult.sessionToken);
      recordAuditFromReq(req, {
        actor: authResult.user,
        module: 'AUTH',
        action: 'LOGIN',
        entityType: 'user',
        entityId: authResult.user.id,
        summary: `User ${authResult.user.email} (${authResult.user.role}) signed in`,
        status: 'SUCCESS'
      });

      // Return authenticated sanitized user (without sensitive credentials)
      res.json({
        success: true,
        user: authResult.user,
        token: authResult.sessionToken
      });
    } else {
      recordAuditFromReq(req, {
        module: 'AUTH',
        action: 'LOGIN',
        entityType: 'user',
        summary: `Failed login attempt for ${cleanEmail}`,
        status: 'FAILED'
      });
      res.status(401).json({
        success: false,
        message: 'Invalid credentials. Please verify your email and password in MySQL.'
      });
    }
  } catch (err: any) {
    const isUnavailable = err?.code === 'DB_UNAVAILABLE' || err?.statusCode === 503;
    res.status(isUnavailable ? 503 : 500).json({
      success: false,
      code: err?.code,
      message: err?.message || 'Authentication error',
      error: err?.message || 'Authentication error'
    });
  }
});

// Session Verification & Current User Profile Endpoint (/api/auth/me & /api/auth/verify)
apiRouter.get(['/auth/me', '/auth/me/', '/auth/verify', '/auth/verify/'], async (req: Request, res: Response) => {
  try {
    const token = extractSessionToken(req);

    if (!token) {
      res.status(401).json({ success: false, message: 'Authentication required. No session token provided.' });
      return;
    }

    const pool = dbManager.getPool();

    // 1. Authoritative check via solar_auth_sessions table in MySQL
    if (pool) {
      const sessVerification = await authService.validateSession(pool, token);
      if (sessVerification.valid && sessVerification.user) {
        // Touch cookie freshness and preserve session cookie in browser
        authService.setSessionCookie(res, req, token);
        res.json({
          success: true,
          user: sessVerification.user,
          token
        });
        return;
      }
    }

    // 2. Fallback verification via HMAC token
    const verification = verifyToken(token);
    if (!verification.valid || !verification.payload) {
      res.status(401).json({ success: false, message: verification.error || 'Session expired or invalid.' });
      return;
    }

    const user = await dbManager.findUserByIdOrEmail(verification.payload.sub || verification.payload.email);
    if (!user) {
      res.status(401).json({ success: false, message: 'User account not found or has been removed from database.' });
      return;
    }

    if (user.status && user.status === 'DISABLED') {
      res.status(403).json({ success: false, message: 'Account has been disabled. Please contact system administrator.' });
      return;
    }

    res.json({
      success: true,
      user,
      token
    });
  } catch (err: any) {
    const isUnavailable = err?.code === 'DB_UNAVAILABLE' || err?.statusCode === 503;
    res.status(isUnavailable ? 503 : 500).json({
      success: false,
      code: err?.code,
      message: err?.message || 'Session verification failed',
      error: err?.message || 'Session verification failed'
    });
  }
});

// Explicit Logout Endpoint (/api/auth/logout)
apiRouter.post(['/auth/logout', '/auth/logout/'], async (req: Request, res: Response) => {
  const token = extractSessionToken(req);
  const pool = dbManager.getPool();
  if (token && pool) {
    await authService.destroySession(pool, token).catch(() => {});
  }
  if ((req as any).user) {
    recordAuditFromReq(req, {
      module: 'AUTH',
      action: 'LOGOUT',
      entityType: 'user',
      entityId: (req as any).user.id,
      summary: `User ${(req as any).user.email} signed out`
    });
  }
  authService.clearSessionCookie(res, req);
  res.json({
    success: true,
    message: 'Session cleared and logged out successfully.'
  });
});

// Password Change Endpoint (/api/auth/change-password - Authenticated user self-service or Admin)
apiRouter.post(['/auth/change-password', '/auth/change-password/'], requireAuthenticatedUser, async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    const { userId, oldPassword, newPassword } = req.body || {};
    const targetId = String(userId || actor.id || '').trim();
    if (!targetId || !oldPassword || !newPassword) {
      res.status(400).json({ success: false, message: 'User ID, current password, and new password are required.' });
      return;
    }
    const actorRole = String(actor.role || '').trim().toUpperCase();
    const isAdminActor = actorRole === 'ADMIN' || actorRole === 'SUPER ADMIN';
    const isSelf = targetId === actor.id || targetId.toLowerCase() === String(actor.email || '').toLowerCase();
    if (!isAdminActor && !isSelf) {
      res.status(403).json({ success: false, message: 'Forbidden: You can only change your own password.' });
      return;
    }
    const result = await dbManager.changeUserPassword(targetId, oldPassword, newPassword);
    recordAuditFromReq(req, {
      module: 'AUTH',
      action: 'CHANGE_PASSWORD',
      entityType: 'user',
      entityId: targetId,
      summary: `Password changed for account ${targetId}`
    });
    res.json(result);
  } catch (err: any) {
    const isUnavailable = err?.code === 'DB_UNAVAILABLE' || err?.statusCode === 503 || err?.name === 'DbConnectionError';
    res.status(isUnavailable ? 503 : 400).json({ success: false, code: err?.code, message: err?.message || 'Password change failed.' });
  }
});

// Password Reset Endpoint (/api/auth/reset-password - Admin / Super Admin only)
apiRouter.post(['/auth/reset-password', '/auth/reset-password/'], requireRole(['Admin', 'Super Admin']), async (req: Request, res: Response) => {
  try {
    const { email, newPassword } = req.body || {};
    if (!email) {
      res.status(400).json({ success: false, message: 'Email address is required.' });
      return;
    }
    const result = await dbManager.resetUserPassword(email, newPassword);
    recordAuditFromReq(req, {
      module: 'AUTH',
      action: 'RESET_PASSWORD',
      entityType: 'user',
      entityId: String(email),
      summary: `Administrator reset password for ${email}`
    });
    res.json(result);
  } catch (err: any) {
    const isUnavailable = err?.code === 'DB_UNAVAILABLE' || err?.statusCode === 503 || err?.name === 'DbConnectionError';
    res.status(isUnavailable ? 503 : 400).json({ success: false, code: err?.code, message: err?.message || 'Password reset failed.' });
  }
});

// ==========================================================
// 3B. USERS MODULE API (MYSQL USER MANAGEMENT)
// ==========================================================

apiRouter.get('/users', requireRole(['Admin', 'Super Admin', 'HR Manager']), async (_req: Request, res: Response) => {
  try {
    const users = await dbManager.getUsers();
    res.json({ success: true, count: users.length, data: users });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch users');
  }
});

apiRouter.post('/users', requireRole(['Admin', 'Super Admin']), async (req: Request, res: Response) => {
  try {
    const payload = req.body || {};
    if (!payload.name || !payload.email) {
      res.status(400).json({ success: false, message: 'User name and email are required.' });
      return;
    }
    const id = payload.id || `usr-${Date.now()}`;
    const saved = await dbManager.saveUser({ ...payload, id });
    recordAuditFromReq(req, {
      module: 'USERS',
      action: 'CREATE_USER',
      entityType: 'user',
      entityId: id,
      summary: `Created user account ${payload.email} (${payload.role || 'Staff'})`
    });
    res.status(201).json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to create user');
  }
});

apiRouter.put('/users/:id', requireRole(['Admin', 'Super Admin']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const payload = req.body || {};
    const updated = await dbManager.saveUser({ ...payload, id }, { updateOnly: true });
    recordAuditFromReq(req, {
      module: 'USERS',
      action: 'UPDATE_USER',
      entityType: 'user',
      entityId: id,
      summary: `Updated user account ${id}`
    });
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to update user');
  }
});

apiRouter.put('/users/:id/password', requireRole(['Admin', 'Super Admin']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { password } = req.body || {};
    if (!password || String(password).trim().length < 6) {
      res.status(400).json({ success: false, message: 'Password must be at least 6 characters long.' });
      return;
    }
    const ok = await dbManager.updateUserPassword(id, String(password).trim());
    recordAuditFromReq(req, {
      module: 'USERS',
      action: 'UPDATE_USER_PASSWORD',
      entityType: 'user',
      entityId: id,
      summary: `Updated password for user ${id}`,
      status: ok ? 'SUCCESS' : 'NOT_FOUND'
    });
    res.json({ success: ok, message: ok ? 'User password securely updated in MySQL.' : 'User account not found.' });
  } catch (err: any) {
    sendApiError(res, err, 'Password update failed');
  }
});

apiRouter.delete('/users/:id', requireRole(['Admin', 'Super Admin']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await dbManager.deleteUser(id);
    recordAuditFromReq(req, {
      module: 'USERS',
      action: 'DELETE_USER',
      entityType: 'user',
      entityId: id,
      summary: `Deleted user account ${id}`
    });
    res.json({ success: true, message: 'User deleted from MySQL.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete user');
  }
});

// ==========================================================
// 4. CUSTOMERS MODULE API
// ==========================================================

apiRouter.put('/customers/:id/password', requireStaffUser, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { password } = req.body || {};
    if (!password || String(password).trim().length < 6) {
      res.status(400).json({ success: false, message: 'Password must be at least 6 characters long.' });
      return;
    }
    const success = await dbManager.updateCustomerPassword(id, String(password).trim());
    recordAuditFromReq(req, {
      module: 'CUSTOMERS',
      action: 'UPDATE_CUSTOMER_PASSWORD',
      entityType: 'customer',
      entityId: id,
      summary: `Updated portal password for customer ${id}`
    });
    res.json({ success, message: success ? 'Customer password updated in MySQL.' : 'Failed to update password.' });
  } catch (err: any) {
    sendApiError(res, err, 'Password update error');
  }
});

apiRouter.get('/customers', requireAuthenticatedUser, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    let customers = await dbManager.getCustomers();
    if (isCustomerUser(user)) {
      const { custId, email } = getCustomerMatchTokens(user);
      customers = customers.filter((c: any) =>
        (custId && c.id === custId) ||
        (email && String(c.email || '').trim().toLowerCase() === email)
      );
    }
    res.json({ success: true, count: customers.length, data: customers });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch customers');
  }
});

apiRouter.post('/customers', requireStaffUser, async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    if (!payload || !payload.name || !payload.phone) {
      res.status(400).json({ success: false, message: 'Customer name and phone are required.' });
      return;
    }
    const newCust = {
      ...payload,
      id: payload.id || `cust-${Date.now()}`,
      customerCode: payload.customerCode || `CUST-2026-${Math.floor(100 + Math.random() * 900)}`,
      password: payload.password || `Cust@${Date.now().toString().slice(-6)}`,
      createdAt: new Date().toISOString()
    };
    const saved = await dbManager.saveCustomer(newCust);
    recordAuditFromReq(req, {
      module: 'CUSTOMERS',
      action: 'CREATE_CUSTOMER',
      entityType: 'customer',
      entityId: saved.id,
      summary: `Created customer ${saved.name} (${saved.customerCode || saved.id})`
    });
    res.status(201).json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to save customer');
  }
});

// Batch Customer Import (Excel / CSV Hub)
apiRouter.post(['/customers/import', '/customers/import/'], requireStaffUser, async (req: Request, res: Response) => {
  try {
    const { customers, rows } = req.body || {};
    const list = Array.isArray(customers) ? customers : (Array.isArray(rows) ? rows : []);
    if (!list || list.length === 0) {
      res.status(400).json({ success: false, message: 'No customer records provided for import.' });
      return;
    }
    const result = await dbManager.importCustomers(list);
    recordAuditFromReq(req, {
      module: 'CUSTOMERS',
      action: 'IMPORT_CUSTOMERS',
      entityType: 'customer',
      summary: `Imported ${result.imported || list.length} customer records`
    });
    res.json(result);
  } catch (err: any) {
    console.error('[MySQL Customer Import Error]:', err);
    sendApiError(res, err, 'Database error during customer import.', { total: 0, imported: 0, skipped: 0, failed: 0 });
  }
});

apiRouter.put('/customers/:id', requireStaffUser, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const payload = req.body;
    const updated = await dbManager.saveCustomer({ ...payload, id });
    recordAuditFromReq(req, {
      module: 'CUSTOMERS',
      action: 'UPDATE_CUSTOMER',
      entityType: 'customer',
      entityId: id,
      summary: `Updated customer ${updated.name || id}`
    });
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to update customer');
  }
});

apiRouter.delete('/customers/:id', requireStaffUser, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await dbManager.deleteCustomer(id);
    recordAuditFromReq(req, {
      module: 'CUSTOMERS',
      action: 'DELETE_CUSTOMER',
      entityType: 'customer',
      entityId: id,
      summary: `Deleted customer ${id}`
    });
    res.json({ success: true, message: 'Customer deleted from MySQL.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete customer');
  }
});

// ==========================================================
// 5. LEADS MODULE API (CRM)
// ==========================================================
const ALLOWED_LEAD_STATUSES = new Set([
  'NEW', 'CONTACTED', 'QUALIFIED', 'SITE SURVEY', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST'
]);

apiRouter.get('/leads', async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    if (!actor) {
      res.status(401).json({ success: false, message: 'Authentication required.' });
      return;
    }
    if (isCustomerUser(actor)) {
      res.status(403).json({ success: false, message: 'Access denied: Insufficient privileges.' });
      return;
    }
    const leads = await dbManager.getLeads();
    res.json({ success: true, count: leads.length, data: leads });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch leads');
  }
});

apiRouter.post('/leads', async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    if (!actor) {
      res.status(401).json({ success: false, message: 'Authentication required.' });
      return;
    }
    if (isCustomerUser(actor)) {
      res.status(403).json({ success: false, message: 'Access denied: Insufficient privileges.' });
      return;
    }
    const payload = req.body || {};
    const customerName = String(payload.customerName ?? payload.customer_name ?? '').trim();
    const phone = String(payload.phone ?? '').trim();
    if (!customerName || !phone) {
      res.status(400).json({ success: false, message: 'Lead customerName and phone required.' });
      return;
    }
    if (payload.status !== undefined && !ALLOWED_LEAD_STATUSES.has(String(payload.status))) {
      res.status(400).json({ success: false, message: 'Invalid lead status.' });
      return;
    }
    const newLead = {
      ...payload,
      customerName,
      phone,
      id: payload.id || `lead-${Date.now()}`,
      createdAt: new Date().toISOString()
    };
    const saved = await dbManager.saveLead(newLead);
    recordAuditFromReq(req, {
      module: 'LEADS',
      action: 'CREATE_LEAD',
      entityType: 'lead',
      entityId: saved.id,
      summary: `Created lead for ${saved.customerName}`
    });
    res.status(201).json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to save lead');
  }
});

// Batch Lead Import (Excel / CSV Hub)
apiRouter.post(['/leads/import', '/leads/import/'], async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    if (!actor) {
      res.status(401).json({ success: false, message: 'Authentication required.' });
      return;
    }
    if (isCustomerUser(actor)) {
      res.status(403).json({ success: false, message: 'Access denied: Insufficient privileges.' });
      return;
    }
    const { leads, rows } = req.body || {};
    const list = Array.isArray(leads) ? leads : (Array.isArray(rows) ? rows : (Array.isArray(req.body) ? req.body : []));
    if (!list || list.length === 0) {
      res.status(400).json({ success: false, message: 'No lead records provided for import.' });
      return;
    }
    const result = await dbManager.importLeads(list);
    recordAuditFromReq(req, {
      module: 'LEADS',
      action: 'IMPORT_LEADS',
      entityType: 'lead',
      summary: `Imported ${result.imported || list.length} leads`
    });
    res.json(result);
  } catch (err: any) {
    console.error('[MySQL Lead Import Error]:', err);
    sendApiError(res, err, 'Database error during lead import.', { total: 0, imported: 0, skipped: 0, failed: 0 });
  }
});

apiRouter.put('/leads/:id', async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    if (!actor) {
      res.status(401).json({ success: false, message: 'Authentication required.' });
      return;
    }
    if (isCustomerUser(actor)) {
      res.status(403).json({ success: false, message: 'Access denied: Insufficient privileges.' });
      return;
    }
    const { id } = req.params;
    const existing = await dbManager.getLeadById(id);
    if (!existing) {
      res.status(404).json({ success: false, message: 'Lead not found.' });
      return;
    }
    const payload = req.body || {};
    const customerName = payload.customerName !== undefined
      ? String(payload.customerName).trim()
      : (payload.customer_name !== undefined ? String(payload.customer_name).trim() : String(existing.customerName || '').trim());
    const phone = payload.phone !== undefined
      ? String(payload.phone).trim()
      : String(existing.phone || '').trim();
    if (!customerName || !phone) {
      res.status(400).json({ success: false, message: 'Lead customerName and phone required.' });
      return;
    }
    if (payload.status !== undefined && !ALLOWED_LEAD_STATUSES.has(String(payload.status))) {
      res.status(400).json({ success: false, message: 'Invalid lead status.' });
      return;
    }
    const updated = await dbManager.saveLead({ ...payload, customerName, phone, id });
    recordAuditFromReq(req, {
      module: 'LEADS',
      action: 'UPDATE_LEAD',
      entityType: 'lead',
      entityId: id,
      summary: `Updated lead ${updated.customerName || id}`
    });
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to update lead');
  }
});

apiRouter.delete('/leads/:id', async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    if (!actor) {
      res.status(401).json({ success: false, message: 'Authentication required.' });
      return;
    }
    if (isCustomerUser(actor)) {
      res.status(403).json({ success: false, message: 'Access denied: Insufficient privileges.' });
      return;
    }
    const { id } = req.params;
    await dbManager.deleteLead(id);
    recordAuditFromReq(req, {
      module: 'LEADS',
      action: 'DELETE_LEAD',
      entityType: 'lead',
      entityId: id,
      summary: `Deleted lead ${id}`
    });
    res.json({ success: true, message: 'Lead deleted from MySQL.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete lead');
  }
});

// ==========================================================
// 6. PROJECTS MODULE API
// ==========================================================

apiRouter.get(['/projects', '/projects/'], requireAuthenticatedUser, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    let projects = await dbManager.getProjects();
    if (isCustomerUser(user)) {
      const { custId, name } = getCustomerMatchTokens(user);
      projects = projects.filter((p: any) =>
        (custId && p.customerId === custId) ||
        (name && String(p.customerName || '').trim().toLowerCase() === name)
      );
    }
    res.json({ success: true, count: projects.length, data: projects });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch projects');
  }
});

apiRouter.get(['/projects/:id', '/projects/:id/'], requireAuthenticatedUser, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { id } = req.params;
    const projects = await dbManager.getProjects();
    const proj = projects.find(p => p.id === id);
    if (!proj) {
      return res.status(404).json({ success: false, error: `Project "${id}" not found.` });
    }
    if (isCustomerUser(user)) {
      const { custId, name } = getCustomerMatchTokens(user);
      const owns =
        (custId && proj.customerId === custId) ||
        (name && String(proj.customerName || '').trim().toLowerCase() === name);
      if (!owns) {
        return res.status(403).json({ success: false, error: 'Forbidden: You can only view your own solar projects.' });
      }
    }
    res.json({ success: true, data: proj });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch project');
  }
});

apiRouter.post(['/projects', '/projects/'], requireStaffUser, async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    const newProj = {
      ...payload,
      id: payload.id || `proj-${Date.now()}`,
      projectCode: payload.projectCode || `SOL-2026-${Math.floor(100 + Math.random() * 900)}`,
      createdAt: new Date().toISOString()
    };
    const saved = await dbManager.saveProject(newProj);
    recordAuditFromReq(req, {
      module: 'PROJECTS',
      action: 'CREATE_PROJECT',
      entityType: 'project',
      entityId: saved.id,
      summary: `Created project ${saved.projectCode || saved.id}`
    });
    res.status(201).json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to save project');
  }
});

// Batch Project Import (Excel / CSV Hub)
apiRouter.post(['/projects/import', '/projects/import/'], requireStaffUser, async (req: Request, res: Response) => {
  try {
    const { projects, rows } = req.body || {};
    const list = Array.isArray(projects) ? projects : (Array.isArray(rows) ? rows : []);
    if (!list || list.length === 0) {
      res.status(400).json({ success: false, message: 'No project records provided for import.' });
      return;
    }
    const result = await dbManager.importProjects(list);
    recordAuditFromReq(req, {
      module: 'PROJECTS',
      action: 'IMPORT_PROJECTS',
      entityType: 'project',
      summary: `Imported ${result.imported || list.length} project records`
    });
    res.json(result);
  } catch (err: any) {
    console.error('[MySQL Project Import Error]:', err);
    sendApiError(res, err, 'Database error during project import.', { total: 0, imported: 0, skipped: 0, failed: 0 });
  }
});

apiRouter.put(['/projects/:id', '/projects/:id/'], async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ success: false, error: 'Authentication required. Please log in.' });
    }
    if (isCustomerUser(user)) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden: Customers have read-only access to project stages and progress.'
      });
    }

    const { id } = req.params;
    const payload = req.body || {};
    if (payload.capacityKw !== undefined && (!Number.isFinite(Number(payload.capacityKw)) || Number(payload.capacityKw) <= 0)) {
      return res.status(400).json({ success: false, error: 'Project capacity must be greater than 0 kW.' });
    }
    if (payload.totalValue !== undefined && (!Number.isFinite(Number(payload.totalValue)) || Number(payload.totalValue) < 0)) {
      return res.status(400).json({ success: false, error: 'Total project value cannot be negative.' });
    }
    const updated = await dbManager.saveProject({ ...payload, id });
    recordAuditFromReq(req, {
      module: 'PROJECTS',
      action: 'UPDATE_PROJECT',
      entityType: 'project',
      entityId: id,
      summary: `Updated project ${updated.projectCode || id}`
    });
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to update project');
  }
});

apiRouter.put(
  ['/projects/:id/control-center', '/projects/:id/control-center/', '/projects/:id/overview', '/projects/:id/overview/'],
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user) {
        return res.status(401).json({ success: false, error: 'Authentication required. Please log in.' });
      }
      if (isCustomerUser(user)) {
        return res.status(403).json({
          success: false,
          error: 'Forbidden: Customers have read-only access to project financials and site details.'
        });
      }
      const allowedRoles = ['ADMIN', 'SUPER ADMIN', 'PROJECT MANAGER', 'ACCOUNTANT', 'SALES MANAGER', 'SALES EXECUTIVE'];
      const roleUpper = String(user.role || '').trim().toUpperCase();
      if (!allowedRoles.includes(roleUpper)) {
        return res.status(403).json({
          success: false,
          error: 'Forbidden: Insufficient permissions to modify project capacity, contract value, inflow, or site location.'
        });
      }

      const { id } = req.params;
      const result = await dbManager.updateProjectControlCenter(id, req.body || {}, user);
      recordAuditFromReq(req, {
        module: 'PROJECTS',
        action: 'UPDATE_CONTROL_CENTER',
        entityType: 'project',
        entityId: id,
        summary: `Updated project control center overview for ${id}`
      });
      res.json({ success: true, data: result });
    } catch (err: any) {
      const status = Number(err?.statusCode) || 500;
      if (status < 500) {
        return res.status(status).json({ success: false, error: err.message, message: err.message });
      }
      sendApiError(res, err, 'Failed to update project overview in MySQL');
    }
  }
);

apiRouter.delete(['/projects/:id', '/projects/:id/'], requireStaffUser, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await dbManager.deleteProject(id);
    recordAuditFromReq(req, {
      module: 'PROJECTS',
      action: 'DELETE_PROJECT',
      entityType: 'project',
      entityId: id,
      summary: `Deleted project ${id}`
    });
    res.json({ success: true, message: 'Project deleted from MySQL.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete project');
  }
});

// Dedicated Project Stage Update API (Protected: Read-only for Customers; Editable by Admins & Staff)
apiRouter.put(['/projects/:id/stages/:stageKey', '/projects/:id/stages/:stageKey/'], requireStaffUser, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { id: projectId, stageKey } = req.params;
    const updates = req.body || {};
    const updated = await dbManager.updateStageInProject(
      projectId,
      stageKey,
      updates,
      user?.name || 'Administrator',
      user?.role || 'Admin'
    );
    if (!updated) {
      return res.status(404).json({ success: false, error: `Project "${projectId}" or stage "${stageKey}" not found.` });
    }
    recordAuditFromReq(req, {
      module: 'PROJECTS',
      action: 'UPDATE_STAGE',
      entityType: 'project_stage',
      entityId: `${projectId}:${stageKey}`,
      summary: `Updated stage ${stageKey} for project ${projectId}`
    });
    res.json({ success: true, data: updated, message: `Stage "${stageKey}" updated successfully in MySQL.` });
  } catch (err: any) {
    console.error('[Update Stage Error]:', err);
    sendApiError(res, err, 'Failed to update stage in MySQL');
  }
});

apiRouter.patch(['/projects/:id/stages/:stageKey', '/projects/:id/stages/:stageKey/'], requireStaffUser, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { id: projectId, stageKey } = req.params;
    const updates = req.body || {};
    const updated = await dbManager.updateStageInProject(
      projectId,
      stageKey,
      updates,
      user?.name || 'Administrator',
      user?.role || 'Admin'
    );
    if (!updated) {
      return res.status(404).json({ success: false, error: `Project "${projectId}" or stage "${stageKey}" not found.` });
    }
    recordAuditFromReq(req, {
      module: 'PROJECTS',
      action: 'PATCH_STAGE',
      entityType: 'project_stage',
      entityId: `${projectId}:${stageKey}`,
      summary: `Patched stage ${stageKey} for project ${projectId}`
    });
    res.json({ success: true, data: updated, message: `Stage "${stageKey}" updated successfully in MySQL.` });
  } catch (err: any) {
    console.error('[Patch Stage Error]:', err);
    sendApiError(res, err, 'Failed to update stage in MySQL');
  }
});

function validateAndDecodeUploadNode(
  rawFileName: string,
  fileData: string,
  mode: 'image' | 'bill' | 'document',
  maxBytes = 10 * 1024 * 1024
): { buffer: Buffer; ext: string; mimeType: string; safeFileName: string; fileSize: number } {
  if (!rawFileName || !fileData || typeof fileData !== 'string') {
    throw Object.assign(new Error('Valid file name and file payload are required.'), { statusCode: 400 });
  }
  const base64Data = fileData.includes(',') ? fileData.split(',')[1] : fileData;
  const buffer = Buffer.from(base64Data.replace(/\s+/g, ''), 'base64');
  if (buffer.length === 0) {
    throw Object.assign(new Error('Invalid or empty file payload.'), { statusCode: 400 });
  }
  if (buffer.length > maxBytes) {
    const mb = Math.round(maxBytes / (1024 * 1024));
    throw Object.assign(new Error(`Uploaded file exceeds the ${mb} MB size limit.`), { statusCode: 400 });
  }

  let safeFileName = path.basename(rawFileName).replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!safeFileName || safeFileName === '.' || safeFileName === '..') {
    safeFileName = 'attachment';
  }
  const ext = path.extname(safeFileName).toLowerCase().replace('.', '');

  let detectedExt: string | null = null;
  let detectedMime: string | null = null;
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    detectedExt = 'jpg';
    detectedMime = 'image/jpeg';
  } else if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    detectedExt = 'png';
    detectedMime = 'image/png';
  } else if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    detectedExt = 'webp';
    detectedMime = 'image/webp';
  } else if (/^\s*%PDF-/.test(buffer.subarray(0, 16).toString('latin1'))) {
    detectedExt = 'pdf';
    detectedMime = 'application/pdf';
  } else if (
    buffer.length >= 8 &&
    buffer[0] === 0xd0 &&
    buffer[1] === 0xcf &&
    buffer[2] === 0x11 &&
    buffer[3] === 0xe0 &&
    buffer[4] === 0xa1 &&
    buffer[5] === 0xb1 &&
    buffer[6] === 0x1a &&
    buffer[7] === 0xe1
  ) {
    detectedExt = 'doc';
    detectedMime = 'application/msword';
  } else if (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    ((buffer[2] === 0x03 && buffer[3] === 0x04) || (buffer[2] === 0x05 && buffer[3] === 0x06))
  ) {
    detectedExt = 'docx';
    detectedMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }

  const normalizedExt = ext === 'jpeg' ? 'jpg' : ext;
  if (mode === 'image') {
    const allowedExts = ['jpg', 'jpeg', 'png', 'webp'];
    if (!detectedExt || !['jpg', 'png', 'webp'].includes(detectedExt)) {
      throw Object.assign(new Error('Unsupported or invalid image file. Only JPG, JPEG, PNG, and WebP images are allowed.'), { statusCode: 400 });
    }
    if (ext && (!allowedExts.includes(ext) || normalizedExt !== detectedExt)) {
      throw Object.assign(new Error('File extension does not match verified image signature.'), { statusCode: 400 });
    }
  } else if (mode === 'bill') {
    const allowedExts = ['pdf', 'jpg', 'jpeg', 'png'];
    if (!detectedExt || !['pdf', 'jpg', 'png'].includes(detectedExt)) {
      throw Object.assign(new Error('Unsupported file format. Only valid PDF, JPG, JPEG, or PNG vendor bills are allowed.'), { statusCode: 400 });
    }
    if (ext && (!allowedExts.includes(ext) || normalizedExt !== detectedExt)) {
      throw Object.assign(new Error('File extension does not match verified document signature.'), { statusCode: 400 });
    }
  } else {
    const allowedExts = ['pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png', 'webp'];
    if (!detectedExt || !['pdf', 'doc', 'docx', 'jpg', 'png', 'webp'].includes(detectedExt)) {
      throw Object.assign(new Error('Unsupported or invalid document payload. Only valid PDF, DOC, DOCX, JPG, PNG, and WebP files are allowed.'), { statusCode: 400 });
    }
    if (ext && (!allowedExts.includes(ext) || normalizedExt !== detectedExt)) {
      throw Object.assign(new Error('File extension does not match verified file signature.'), { statusCode: 400 });
    }
  }

  if (!ext) safeFileName += `.${detectedExt}`;
  return {
    buffer,
    ext: detectedExt,
    mimeType: detectedMime!,
    safeFileName,
    fileSize: buffer.length
  };
}

// POST /api/projects/:id/stages/:stageKey/photos - Persistent Stage Workflow Image Upload
apiRouter.post(['/projects/:id/stages/:stageKey/photos', '/projects/:id/stages/:stageKey/photos/'], async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    if (!actor) return res.status(401).json({ success: false, error: 'Authentication required. Please log in.' });
    if (isCustomerUser(actor)) {
      return res.status(403).json({ success: false, error: 'Forbidden: Customers have read-only access to project stages and photos.' });
    }

    const { id: projectId, stageKey } = req.params;
    const { fileName, fileData, photoData, caption, gpsCoordinates } = req.body || {};
    const decoded = validateAndDecodeUploadNode(
      String(fileName || 'stage-photo.jpg'),
      String(fileData || photoData || ''),
      'image'
    );

    const safeProjId = path.basename(projectId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeStageKey = path.basename(stageKey).replace(/[^a-zA-Z0-9_-]/g, '_');
    const photoId = `photo-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const diskFileName = `${photoId}.${decoded.ext}`;

    const uploadsBase = path.resolve(process.cwd(), 'uploads');
    const stageDir = path.resolve(uploadsBase, 'projects', safeProjId, safeStageKey);
    if (!stageDir.startsWith(uploadsBase + path.sep)) {
      return res.status(400).json({ success: false, error: 'Invalid upload directory path.' });
    }
    fs.mkdirSync(stageDir, { recursive: true });
    const fullPath = path.resolve(stageDir, diskFileName);
    fs.writeFileSync(fullPath, decoded.buffer);

    const relativePath = `projects/${safeProjId}/${safeStageKey}/${diskFileName}`;
    const fileUrl = `/api/uploads/projects/${encodeURIComponent(safeProjId)}/${encodeURIComponent(safeStageKey)}/${encodeURIComponent(diskFileName)}`;

    const newPhoto = {
      id: photoId,
      url: fileUrl,
      fileName: decoded.safeFileName,
      filePath: relativePath,
      mimeType: decoded.mimeType,
      fileSize: decoded.fileSize,
      caption: String(caption || '').trim() || decoded.safeFileName.replace(/\.[^/.]+$/, '') || 'Site Photo',
      uploadedBy: actor?.name || 'Field Engineer',
      uploadedAt: new Date().toISOString(),
      gpsCoordinates: String(gpsCoordinates || '').trim()
    };

    const result = await dbManager.addStagePhotoToProject(projectId, stageKey, newPhoto);
    if (!result) {
      try { if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath); } catch {}
      return res.status(404).json({ success: false, error: 'Project not found in MySQL.' });
    }

    res.json({
      success: true,
      message: 'Stage workflow image uploaded and saved to MySQL.',
      photo: result.photo,
      photos: result.photos
    });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to upload stage photo');
  }
});

// DELETE /api/projects/:id/stages/:stageKey/photos/:photoId
apiRouter.delete(['/projects/:id/stages/:stageKey/photos/:photoId', '/projects/:id/stages/:stageKey/photos/:photoId/'], async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    if (!actor) return res.status(401).json({ success: false, error: 'Authentication required.' });
    if (isCustomerUser(actor)) {
      return res.status(403).json({ success: false, error: 'Forbidden: Customers have read-only access to project stages and photos.' });
    }
    const { id: projectId, stageKey, photoId } = req.params;
    const result = await dbManager.removeStagePhotoFromProject(projectId, stageKey, photoId);
    if (!result) {
      return res.status(404).json({ success: false, error: 'Stage not found.' });
    }
    if (result.removedPhoto?.filePath) {
      const uploadsBase = path.resolve(process.cwd(), 'uploads');
      const fp = path.resolve(uploadsBase, result.removedPhoto.filePath);
      if (fp.startsWith(uploadsBase + path.sep) && fs.existsSync(fp)) {
        try { fs.unlinkSync(fp); } catch {}
      }
    }
    res.json({ success: true, photos: result.photos, message: 'Stage photo removed from server and MySQL.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete stage photo');
  }
});

// Authenticated streaming endpoint for project stage workflow images
apiRouter.get('/uploads/projects/:projectId/:stageKey/:filename', async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    if (!actor) return res.status(401).json({ success: false, error: 'Authentication required.' });

    const { projectId, stageKey, filename } = req.params;
    if (projectId.includes('..') || stageKey.includes('..') || filename.includes('..')) {
      return res.status(400).json({ success: false, error: 'Invalid file path access request.' });
    }

    const safeProjId = path.basename(projectId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeStageKey = path.basename(stageKey).replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeName = path.basename(filename);

    if (isCustomerUser(actor)) {
      const projects = await dbManager.getProjects();
      const proj = projects.find((p: any) => p.id === projectId || p.id === safeProjId);
      const linkedCustId = String(actor.linkedEntityId || actor.customerId || '').trim();
      const actorEmail = String(actor.email || '').trim().toLowerCase();
      let owns = Boolean(proj && linkedCustId && proj.customerId === linkedCustId);
      if (!owns && proj && actorEmail) {
        const custs = await dbManager.getCustomers();
        const c = custs.find((x: any) => x.id === proj.customerId);
        if (c && String(c.email || '').trim().toLowerCase() === actorEmail) owns = true;
      }
      if (!owns) {
        return res.status(403).json({ success: false, error: 'Forbidden: You do not have permission to view this project photo.' });
      }
    }

    const uploadsBase = path.resolve(process.cwd(), 'uploads');
    const fullPath = path.resolve(uploadsBase, 'projects', safeProjId, safeStageKey, safeName);
    if (!fullPath.startsWith(uploadsBase + path.sep) || !fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      return res.status(404).json({ success: false, error: 'Stage photo not found on server.' });
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${safeName.replace(/"/g, '')}"`);
    res.sendFile(fullPath);
  } catch (err: any) {
    sendApiError(res, err, 'Failed to deliver stage photo');
  }
});

// Dedicated Project Progress Update API
apiRouter.put(['/projects/:id/progress', '/projects/:id/progress/'], requireStaffUser, async (req: Request, res: Response) => {
  try {
    const { id: projectId } = req.params;
    const { progressPercentage, status } = req.body || {};
    const updated = await dbManager.updateProjectProgress(
      projectId,
      Number(progressPercentage),
      status
    );
    if (!updated) {
      return res.status(404).json({ success: false, error: `Project "${projectId}" not found.` });
    }
    recordAuditFromReq(req, {
      module: 'PROJECTS',
      action: 'UPDATE_PROGRESS',
      entityType: 'project',
      entityId: projectId,
      summary: `Updated progress to ${progressPercentage}% (${status || 'unchanged'}) for project ${projectId}`
    });
    res.json({ success: true, data: updated, message: 'Project progress updated successfully in MySQL.' });
  } catch (err: any) {
    console.error('[Update Progress Error]:', err);
    sendApiError(res, err, 'Failed to update project progress in MySQL');
  }
});

// ==========================================================
// 7. HRMS & WORKFORCE APIS
// ==========================================================

apiRouter.get(['/employees', '/employee'], requireStaffUser, async (_req: Request, res: Response) => {
  try {
    const items = await dbManager.getEmployees();
    res.json({ success: true, count: items.length, data: items });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch employees');
  }
});

apiRouter.post(['/employees', '/employee'], requireRole(['Admin', 'Super Admin', 'HR Manager']), async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    const emp = {
      ...payload,
      id: payload.id || `emp-${Date.now()}`,
      employeeCode: payload.employeeCode || `EMP${Math.floor(100 + Math.random() * 900)}`,
      createdAt: payload.createdAt || new Date().toISOString()
    };
    const saved = await dbManager.saveEmployee(emp);
    recordAuditFromReq(req, {
      module: 'HRMS',
      action: 'CREATE_EMPLOYEE',
      entityType: 'employee',
      entityId: saved.id,
      summary: `Created employee ${saved.name} (${saved.employeeCode})`
    });
    res.status(201).json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to save employee');
  }
});

// Batch Employee Import (Excel / CSV Hub)
apiRouter.post(['/employees/import', '/employees/import/', '/employee/import', '/employee/import/'], requireRole(['Admin', 'Super Admin', 'HR Manager']), async (req: Request, res: Response) => {
  try {
    const { employees, rows } = req.body || {};
    const list = Array.isArray(employees) ? employees : (Array.isArray(rows) ? rows : (Array.isArray(req.body) ? req.body : []));
    if (!list || list.length === 0) {
      res.status(400).json({ success: false, message: 'No employee records provided for import.' });
      return;
    }
    const result = await dbManager.importEmployees(list);
    recordAuditFromReq(req, {
      module: 'HRMS',
      action: 'IMPORT_EMPLOYEES',
      entityType: 'employee',
      summary: `Imported ${result.imported || list.length} employees`
    });
    res.json(result);
  } catch (err: any) {
    console.error('[MySQL Employee Import Error]:', err);
    sendApiError(res, err, 'Database error during employee import.', {
      total: 0,
      imported: 0,
      skipped: 0,
      failed: 0
    });
  }
});

apiRouter.put(['/employees/:id', '/employee/:id'], requireRole(['Admin', 'Super Admin', 'HR Manager']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const payload = req.body;
    const updated = await dbManager.saveEmployee({ ...payload, id });
    recordAuditFromReq(req, {
      module: 'HRMS',
      action: 'UPDATE_EMPLOYEE',
      entityType: 'employee',
      entityId: id,
      summary: `Updated employee ${updated.name || id}`
    });
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to update employee');
  }
});

apiRouter.delete(['/employees/:id', '/employee/:id'], requireRole(['Admin', 'Super Admin', 'HR Manager']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await dbManager.deleteEmployee(id);
    recordAuditFromReq(req, {
      module: 'HRMS',
      action: 'DELETE_EMPLOYEE',
      entityType: 'employee',
      entityId: id,
      summary: `Deleted employee ${id}`
    });
    res.json({ success: true, message: 'Employee deleted from MySQL.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete employee');
  }
});

// Employee Documents: List documents for employee
apiRouter.get('/employees/:id/documents', requireStaffUser, async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    const { id } = req.params;
    const roleUpper = String(actor?.role || '').trim().toUpperCase();
    const isHrOrAdmin = roleUpper === 'ADMIN' || roleUpper === 'SUPER ADMIN' || roleUpper === 'HR MANAGER';
    const isSelf = actor?.id === id || actor?.employeeId === id;
    if (!isHrOrAdmin && !isSelf) {
      return res.status(403).json({ success: false, message: 'Access denied: Only HR/Admin or the employee can view employee documents.' });
    }
    const documents = await dbManager.getEmployeeDocuments(id);
    res.json({ success: true, count: documents.length, data: documents });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch employee documents');
  }
});

// Employee Documents: Upload single or multiple documents persistently
apiRouter.post('/employees/:id/documents/upload', requireRole(['Admin', 'Super Admin', 'HR Manager']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, category, fileName, fileData, notes, uploadedBy } = req.body || {};

    if (!fileName || !fileData || typeof fileData !== 'string') {
      return res.status(400).json({ success: false, error: 'File name and fileData (base64) are required.', message: 'File name and fileData (base64) are required.' });
    }

    const decoded = validateAndDecodeUploadNode(
      String(fileName),
      String(fileData),
      'document',
      20 * 1024 * 1024
    );

    const safeEmpId = path.basename(id).replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!safeEmpId || safeEmpId === '.' || safeEmpId === '..') {
      return res.status(400).json({ success: false, error: 'Invalid employee identifier.', message: 'Invalid employee identifier.' });
    }

    const docId = `doc-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const diskFileName = `${docId}_${decoded.safeFileName}`;

    const uploadsBase = path.resolve(process.cwd(), 'uploads');
    const empDocsDir = path.resolve(uploadsBase, 'employees', safeEmpId, 'documents');
    if (!empDocsDir.startsWith(uploadsBase + path.sep)) {
      return res.status(400).json({ success: false, error: 'Invalid upload directory path.', message: 'Invalid upload directory path.' });
    }
    fs.mkdirSync(empDocsDir, { recursive: true });

    const filePath = path.resolve(empDocsDir, diskFileName);
    if (!filePath.startsWith(empDocsDir + path.sep)) {
      return res.status(400).json({ success: false, error: 'Invalid upload file path.', message: 'Invalid upload file path.' });
    }
    fs.writeFileSync(filePath, decoded.buffer);

    const relativePath = `employees/${safeEmpId}/documents/${diskFileName}`;
    const fileUrl = `/api/uploads/employees/${encodeURIComponent(safeEmpId)}/documents/${encodeURIComponent(diskFileName)}`;

    const savedDoc = await dbManager.saveEmployeeDocument({
      id: docId,
      employeeId: id,
      category: category || 'Other',
      name: name || decoded.safeFileName.replace(/\.[^/.]+$/, ''),
      fileName: decoded.safeFileName,
      filePath: relativePath,
      fileUrl,
      mimeType: decoded.mimeType,
      fileSize: decoded.fileSize,
      uploadedBy: uploadedBy || (req as any).user?.name || 'HR Administrator',
      notes: notes || undefined
    });

    recordAuditFromReq(req, {
      module: 'DOCUMENTS',
      action: 'UPLOAD_EMPLOYEE_DOCUMENT',
      entityType: 'employee_document',
      entityId: docId,
      summary: `Uploaded employee document "${decoded.safeFileName}" for ${id}`
    });

    res.json({
      success: true,
      message: `Document "${decoded.safeFileName}" uploaded and stored securely on server.`,
      document: savedDoc
    });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to upload document');
  }
});

// Employee Documents: Delete document persistently
apiRouter.delete('/employees/:id/documents/:docId', requireRole(['Admin', 'Super Admin', 'HR Manager']), async (req: Request, res: Response) => {
  try {
    const { id, docId } = req.params;
    const docs = await dbManager.getEmployeeDocuments(id).catch(() => []);
    const targetDoc = (docs || []).find((d: any) => d.id === docId);
    await dbManager.deleteEmployeeDocument(id, docId);
    if (targetDoc?.filePath) {
      const uploadsBase = path.resolve(process.cwd(), 'uploads');
      const normalizedRel = String(targetDoc.filePath).replace(/^uploads[\\/]/, '');
      const fp = path.resolve(uploadsBase, normalizedRel);
      if (fp.startsWith(uploadsBase + path.sep) && fs.existsSync(fp)) {
        try { fs.unlinkSync(fp); } catch {}
      }
    }
    recordAuditFromReq(req, {
      module: 'DOCUMENTS',
      action: 'DELETE_EMPLOYEE_DOCUMENT',
      entityType: 'employee_document',
      entityId: docId,
      summary: `Deleted employee document ${docId} for ${id}`
    });
    res.json({ success: true, message: 'Document removed from server and database.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete document');
  }
});

// Employee Profile Photo Upload
apiRouter.post('/employees/:id/photo/upload', requireRole(['Admin', 'Super Admin', 'HR Manager']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { photoData, fileName } = req.body || {};

    if (!photoData || typeof photoData !== 'string') {
      return res.status(400).json({ success: false, error: 'Photo data (base64) is required.', message: 'Photo data (base64) is required.' });
    }

    const decoded = validateAndDecodeUploadNode(
      String(fileName || 'profile-photo.jpg'),
      String(photoData),
      'image',
      5 * 1024 * 1024
    );

    const safeEmpId = path.basename(id).replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!safeEmpId || safeEmpId === '.' || safeEmpId === '..') {
      return res.status(400).json({ success: false, error: 'Invalid employee identifier.', message: 'Invalid employee identifier.' });
    }
    const photoId = `photo-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const diskFileName = `${photoId}.${decoded.ext}`;

    const uploadsBase = path.resolve(process.cwd(), 'uploads');
    const empProfileDir = path.resolve(uploadsBase, 'employees', safeEmpId, 'profile');
    if (!empProfileDir.startsWith(uploadsBase + path.sep)) {
      return res.status(400).json({ success: false, error: 'Invalid upload directory path.', message: 'Invalid upload directory path.' });
    }
    fs.mkdirSync(empProfileDir, { recursive: true });

    const filePath = path.resolve(empProfileDir, diskFileName);
    if (!filePath.startsWith(empProfileDir + path.sep)) {
      return res.status(400).json({ success: false, error: 'Invalid upload file path.', message: 'Invalid upload file path.' });
    }
    fs.writeFileSync(filePath, decoded.buffer);

    const fileUrl = `/api/uploads/employees/${encodeURIComponent(safeEmpId)}/profile/${encodeURIComponent(diskFileName)}`;

    // Update photo_url in solar_employees and solar_users
    await dbManager.updateEmployeePhoto(id, fileUrl);

    recordAuditFromReq(req, {
      module: 'DOCUMENTS',
      action: 'UPLOAD_EMPLOYEE_PHOTO',
      entityType: 'employee_photo',
      entityId: id,
      summary: `Uploaded profile photo for employee ${id}`
    });

    res.json({
      success: true,
      message: 'Employee profile photo uploaded and saved securely.',
      photoUrl: fileUrl
    });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to upload photo');
  }
});

// Secure authenticated streaming endpoint for employee uploads with strict RBAC & path confinement
apiRouter.get('/uploads/employees/:employeeId/:category/:filename', requireStaffUser, (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    const { employeeId, category, filename } = req.params;
    if (employeeId.includes('..') || category.includes('..') || filename.includes('..')) {
      return res.status(400).json({ success: false, error: 'Invalid file path access request.' });
    }

    const safeCat = String(category || '').trim().toLowerCase();
    if (safeCat !== 'documents' && safeCat !== 'profile') {
      return res.status(400).json({ success: false, error: 'Invalid upload category.' });
    }

    if (safeCat === 'documents') {
      const roleUpper = String(actor?.role || '').trim().toUpperCase();
      const isHrOrAdmin = roleUpper === 'ADMIN' || roleUpper === 'SUPER ADMIN' || roleUpper === 'HR MANAGER';
      const isSelf = actor?.id === employeeId || actor?.employeeId === employeeId;
      if (!isHrOrAdmin && !isSelf) {
        return res.status(403).json({ success: false, error: 'Forbidden: Only HR, Admin, or the owning employee can download employee documents.' });
      }
    }

    const safeEmpId = path.basename(employeeId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeName = path.basename(filename);
    const uploadsBase = path.resolve(process.cwd(), 'uploads', 'employees');
    const fullPath = path.resolve(uploadsBase, safeEmpId, safeCat, safeName);

    if (!fullPath.startsWith(uploadsBase + path.sep) || !fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      return res.status(404).json({ success: false, error: 'File not found on server.' });
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${safeName.replace(/"/g, '')}"`);
    res.sendFile(fullPath);
  } catch (err: any) {
    sendApiError(res, err, 'Failed to deliver file');
  }
});

// Attendance
apiRouter.get('/attendance', requireStaffUser, async (_req: Request, res: Response) => {
  try {
    const items = await dbManager.getAttendance();
    res.json({ success: true, count: items.length, data: items });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch attendance');
  }
});

apiRouter.post('/attendance', requireStaffUser, async (req: Request, res: Response) => {
  try {
    const att = { ...req.body, id: req.body.id || `att-${Date.now()}` };
    const saved = await dbManager.saveAttendance(att);
    recordAuditFromReq(req, {
      module: 'HRMS',
      action: 'SAVE_ATTENDANCE',
      entityType: 'attendance',
      entityId: saved.id,
      summary: `Logged attendance ${saved.id}`
    });
    res.status(201).json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to save attendance');
  }
});

// Batch Attendance Import (Excel / CSV Hub)
apiRouter.post(['/attendance/import', '/attendance/import/'], requireRole(['Admin', 'Super Admin', 'HR Manager']), async (req: Request, res: Response) => {
  try {
    const { attendance, rows } = req.body || {};
    const list = Array.isArray(attendance) ? attendance : (Array.isArray(rows) ? rows : (Array.isArray(req.body) ? req.body : []));
    if (!list || list.length === 0) {
      res.status(400).json({ success: false, message: 'No attendance records provided for import.' });
      return;
    }
    const result = await dbManager.importAttendance(list);
    recordAuditFromReq(req, {
      module: 'HRMS',
      action: 'IMPORT_ATTENDANCE',
      entityType: 'attendance',
      summary: `Imported ${result.imported || list.length} attendance records`
    });
    res.json(result);
  } catch (err: any) {
    console.error('[MySQL Attendance Import Error]:', err);
    sendApiError(res, err, 'Database error during attendance import.', {
      total: 0,
      imported: 0,
      skipped: 0,
      failed: 0
    });
  }
});

apiRouter.put('/attendance/:id', requireStaffUser, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const saved = await dbManager.saveAttendance({ ...req.body, id });
    recordAuditFromReq(req, {
      module: 'HRMS',
      action: 'UPDATE_ATTENDANCE',
      entityType: 'attendance',
      entityId: id,
      summary: `Updated attendance record ${id}`
    });
    res.json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to update attendance');
  }
});

apiRouter.put('/attendance/:id/fuel-approval', requireRole(['Admin', 'Super Admin', 'HR Manager', 'Accountant', 'Project Manager']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { approvalStatus, approvedBy, status, reviewedBy, notes } = req.body || {};
    const resolvedStatus = approvalStatus || status || 'APPROVED';
    const resolvedReviewer = approvedBy || reviewedBy || (req as any).user?.name || 'Administrator';
    const attendanceRecords = await dbManager.getAttendance();
    const existing = attendanceRecords.find((a: any) => a.id === id);

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Attendance record not found.' });
    }

    const currentFuel = existing.fuelExpense || {};
    const updatedFuel = {
      ...currentFuel,
      approvalStatus: resolvedStatus,
      approvedBy: resolvedReviewer,
      approvedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      approvalNotes: notes ?? currentFuel.approvalNotes
    };

    const updatedRecord = {
      ...existing,
      fuelExpense: updatedFuel
    };

    const saved = await dbManager.saveAttendance(updatedRecord);
    recordAuditFromReq(req, {
      module: 'HRMS',
      action: 'FUEL_APPROVAL',
      entityType: 'attendance',
      entityId: id,
      summary: `Marked fuel expense ${id} as ${resolvedStatus}`
    });
    res.json({ success: true, data: saved, message: `Fuel log marked as ${resolvedStatus}.` });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to update fuel approval status');
  }
});

apiRouter.delete('/attendance/:id', requireRole(['Admin', 'Super Admin', 'HR Manager']), async (req: Request, res: Response) => {
  try {
    await dbManager.deleteAttendance(req.params.id);
    recordAuditFromReq(req, {
      module: 'HRMS',
      action: 'DELETE_ATTENDANCE',
      entityType: 'attendance',
      entityId: req.params.id,
      summary: `Deleted attendance record ${req.params.id}`
    });
    res.json({ success: true, message: 'Attendance record deleted from MySQL.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete attendance');
  }
});

// Payslips / Payroll
apiRouter.get('/payslips', requireStaffUser, async (_req: Request, res: Response) => {
  try {
    const items = await dbManager.getPayslips();
    res.json({ success: true, count: items.length, data: items });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch payslips');
  }
});

apiRouter.post('/payslips', requireRole(['Admin', 'Super Admin', 'HR Manager', 'Accountant']), async (req: Request, res: Response) => {
  try {
    const ps = { ...req.body, id: req.body.id || `pay-${Date.now()}` };
    const saved = await dbManager.savePayslip(ps);
    recordAuditFromReq(req, {
      module: 'PAYROLL',
      action: 'CREATE_PAYSLIP',
      entityType: 'payslip',
      entityId: saved.id,
      summary: `Generated payslip ${saved.id}`
    });
    res.status(201).json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to save payslip');
  }
});

apiRouter.put('/payslips/:id', requireRole(['Admin', 'Super Admin', 'HR Manager', 'Accountant']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const saved = await dbManager.savePayslip({ ...req.body, id });
    recordAuditFromReq(req, {
      module: 'PAYROLL',
      action: 'UPDATE_PAYSLIP',
      entityType: 'payslip',
      entityId: id,
      summary: `Updated payslip ${id}`
    });
    res.json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to update payslip');
  }
});

apiRouter.delete('/payslips/:id', requireRole(['Admin', 'Super Admin', 'HR Manager', 'Accountant']), async (req: Request, res: Response) => {
  try {
    await dbManager.deletePayslip(req.params.id);
    recordAuditFromReq(req, {
      module: 'PAYROLL',
      action: 'DELETE_PAYSLIP',
      entityType: 'payslip',
      entityId: req.params.id,
      summary: `Deleted payslip ${req.params.id}`
    });
    res.json({ success: true, message: 'Payslip deleted from MySQL.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete payslip');
  }
});

// Holidays
apiRouter.get('/holidays', requireAuthenticatedUser, async (_req: Request, res: Response) => {
  try {
    const items = await dbManager.getHolidays();
    res.json({ success: true, count: items.length, data: items });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch holidays');
  }
});

apiRouter.post('/holidays', requireRole(['Admin', 'Super Admin', 'HR Manager']), async (req: Request, res: Response) => {
  try {
    const h = { ...req.body, id: req.body.id || `hol-${Date.now()}` };
    const saved = await dbManager.saveHoliday(h);
    recordAuditFromReq(req, {
      module: 'HRMS',
      action: 'CREATE_HOLIDAY',
      entityType: 'holiday',
      entityId: saved.id,
      summary: `Created holiday ${saved.name || saved.id}`
    });
    res.status(201).json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to save holiday');
  }
});

apiRouter.put('/holidays/:id', requireRole(['Admin', 'Super Admin', 'HR Manager']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const saved = await dbManager.saveHoliday({ ...req.body, id });
    recordAuditFromReq(req, {
      module: 'HRMS',
      action: 'UPDATE_HOLIDAY',
      entityType: 'holiday',
      entityId: id,
      summary: `Updated holiday ${saved.name || id}`
    });
    res.json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to update holiday');
  }
});

apiRouter.delete('/holidays/:id', requireRole(['Admin', 'Super Admin', 'HR Manager']), async (req: Request, res: Response) => {
  try {
    await dbManager.deleteHoliday(req.params.id);
    recordAuditFromReq(req, {
      module: 'HRMS',
      action: 'DELETE_HOLIDAY',
      entityType: 'holiday',
      entityId: req.params.id,
      summary: `Deleted holiday ${req.params.id}`
    });
    res.json({ success: true, message: 'Holiday deleted from MySQL.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete holiday');
  }
});

// ==========================================================
// 7B. EMPLOYEE LEAVE MANAGEMENT APIS
// ==========================================================
apiRouter.get('/leaves', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ success: false, message: 'Authentication required. Please log in.' });
    }
    if (isCustomerUser(user)) {
      return res.status(403).json({ success: false, message: 'Access denied: Leave management is only available for staff members.' });
    }
    const yearParam = req.query.year ? Number(req.query.year) : undefined;
    const data = await dbManager.getLeaveData(user, yearParam);
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch leave records');
  }
});

apiRouter.post('/leaves', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ success: false, message: 'Authentication required. Please log in.' });
    }
    if (isCustomerUser(user)) {
      return res.status(403).json({ success: false, message: 'Access denied: Customers cannot apply for employee leave.' });
    }
    const saved = await dbManager.applyLeave(user, req.body || {});
    res.status(201).json({ success: true, data: saved, message: 'Leave application submitted successfully.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to submit leave application');
  }
});

apiRouter.put('/leaves/:id/review', requireRole(['Admin', 'Super Admin', 'HR Manager']), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const action = req.body?.action || req.body?.status;
    const remarks = req.body?.remarks ?? req.body?.adminRemarks ?? '';
    const updated = await dbManager.reviewLeave(user, req.params.id, action, remarks);
    res.json({
      success: true,
      data: updated,
      message: `Leave application ${updated.status === 'APPROVED' ? 'approved' : 'rejected'} successfully.`
    });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to review leave application');
  }
});

apiRouter.post('/leaves/:id/review', requireRole(['Admin', 'Super Admin', 'HR Manager']), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const action = req.body?.action || req.body?.status;
    const remarks = req.body?.remarks ?? req.body?.adminRemarks ?? '';
    const updated = await dbManager.reviewLeave(user, req.params.id, action, remarks);
    res.json({
      success: true,
      data: updated,
      message: `Leave application ${updated.status === 'APPROVED' ? 'approved' : 'rejected'} successfully.`
    });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to review leave application');
  }
});

apiRouter.post('/leaves/:id/cancel', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ success: false, message: 'Authentication required. Please log in.' });
    }
    if (isCustomerUser(user)) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }
    const updated = await dbManager.cancelLeave(user, req.params.id, req.body?.remarks ?? req.body?.adminRemarks);
    res.json({ success: true, data: updated, message: 'Leave application cancelled.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to cancel leave application');
  }
});

apiRouter.delete('/leaves/:id', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ success: false, message: 'Authentication required. Please log in.' });
    }
    if (isCustomerUser(user)) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }
    const updated = await dbManager.cancelLeave(user, req.params.id, req.body?.remarks ?? req.body?.adminRemarks);
    res.json({ success: true, data: updated, message: 'Leave application cancelled.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to cancel leave application');
  }
});

// ==========================================================
// 8. INVENTORY & PROCUREMENT APIS
// ==========================================================

// Products (Catalog)
apiRouter.get('/products', requireStaffUser, async (_req: Request, res: Response) => {
  try {
    const items = await dbManager.getProducts();
    res.json({ success: true, count: items.length, data: items });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch products');
  }
});

apiRouter.post('/products', requireStaffUser, async (req: Request, res: Response) => {
  try {
    const prod = { ...req.body, id: req.body.id || `prod-${Date.now()}` };
    const saved = await dbManager.saveProduct(prod);
    recordAuditFromReq(req, {
      module: 'INVENTORY',
      action: 'CREATE_PRODUCT',
      entityType: 'product',
      entityId: saved.id,
      summary: `Created product ${saved.name || saved.id}`
    });
    res.status(201).json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to save product');
  }
});

// Batch Product Import (Excel / CSV Hub)
apiRouter.post(['/products/import', '/products/import/'], requireStaffUser, async (req: Request, res: Response) => {
  try {
    const { products, rows } = req.body || {};
    const list = Array.isArray(products) ? products : (Array.isArray(rows) ? rows : (Array.isArray(req.body) ? req.body : []));
    if (!list || list.length === 0) {
      res.status(400).json({ success: false, message: 'No product records provided for import.' });
      return;
    }
    const result = await dbManager.importProducts(list);
    recordAuditFromReq(req, {
      module: 'INVENTORY',
      action: 'IMPORT_PRODUCTS',
      entityType: 'product',
      summary: `Imported ${result.imported || list.length} products`
    });
    res.json(result);
  } catch (err: any) {
    console.error('[MySQL Product Import Error]:', err);
    sendApiError(res, err, 'Database error during product import.', {
      total: 0,
      imported: 0,
      skipped: 0,
      failed: 0
    });
  }
});

apiRouter.put('/products/:id', requireStaffUser, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const saved = await dbManager.saveProduct({ ...req.body, id });
    recordAuditFromReq(req, {
      module: 'INVENTORY',
      action: 'UPDATE_PRODUCT',
      entityType: 'product',
      entityId: id,
      summary: `Updated product ${saved.name || id}`
    });
    res.json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to update product');
  }
});

apiRouter.delete('/products/:id', requireStaffUser, async (req: Request, res: Response) => {
  try {
    await dbManager.deleteProduct(req.params.id);
    recordAuditFromReq(req, {
      module: 'INVENTORY',
      action: 'DELETE_PRODUCT',
      entityType: 'product',
      entityId: req.params.id,
      summary: `Deleted product ${req.params.id}`
    });
    res.json({ success: true, message: 'Product deleted from MySQL.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete product');
  }
});

// Vendors
apiRouter.get('/vendors', requireStaffUser, async (_req: Request, res: Response) => {
  try {
    const items = await dbManager.getVendors();
    res.json({ success: true, count: items.length, data: items });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch vendors');
  }
});

apiRouter.post('/vendors', requireStaffUser, async (req: Request, res: Response) => {
  try {
    const v = { ...req.body, id: req.body.id || `ven-${Date.now()}` };
    const saved = await dbManager.saveVendor(v);
    recordAuditFromReq(req, {
      module: 'PROCUREMENT',
      action: 'CREATE_VENDOR',
      entityType: 'vendor',
      entityId: saved.id,
      summary: `Created vendor ${saved.name || saved.id}`
    });
    res.status(201).json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to save vendor');
  }
});

// Batch Vendor Import (Excel / CSV Hub)
apiRouter.post(['/vendors/import', '/vendors/import/'], requireStaffUser, async (req: Request, res: Response) => {
  try {
    const { vendors, rows } = req.body || {};
    const list = Array.isArray(vendors) ? vendors : (Array.isArray(rows) ? rows : (Array.isArray(req.body) ? req.body : []));
    if (!list || list.length === 0) {
      res.status(400).json({ success: false, message: 'No vendor records provided for import.' });
      return;
    }
    const result = await dbManager.importVendors(list);
    recordAuditFromReq(req, {
      module: 'PROCUREMENT',
      action: 'IMPORT_VENDORS',
      entityType: 'vendor',
      summary: `Imported ${result.imported || list.length} vendors`
    });
    res.json(result);
  } catch (err: any) {
    console.error('[MySQL Vendor Import Error]:', err);
    sendApiError(res, err, 'Database error during vendor import.', {
      total: 0,
      imported: 0,
      skipped: 0,
      failed: 0
    });
  }
});

apiRouter.put('/vendors/:id', requireStaffUser, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const saved = await dbManager.saveVendor({ ...req.body, id });
    recordAuditFromReq(req, {
      module: 'PROCUREMENT',
      action: 'UPDATE_VENDOR',
      entityType: 'vendor',
      entityId: id,
      summary: `Updated vendor ${saved.name || id}`
    });
    res.json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to update vendor');
  }
});

apiRouter.delete('/vendors/:id', requireStaffUser, async (req: Request, res: Response) => {
  try {
    await dbManager.deleteVendor(req.params.id);
    recordAuditFromReq(req, {
      module: 'PROCUREMENT',
      action: 'DELETE_VENDOR',
      entityType: 'vendor',
      entityId: req.params.id,
      summary: `Deleted vendor ${req.params.id}`
    });
    res.json({ success: true, message: 'Vendor deleted from MySQL.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete vendor');
  }
});

// Purchase Orders
apiRouter.get('/purchase-orders', requireStaffUser, async (_req: Request, res: Response) => {
  try {
    const items = await dbManager.getPurchaseOrders();
    res.json({ success: true, count: items.length, data: items });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch purchase orders');
  }
});

apiRouter.post('/purchase-orders', async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    if (!actor) return res.status(401).json({ success: false, error: 'Authentication required. Please log in.' });
    if (isCustomerUser(actor)) return res.status(403).json({ success: false, error: 'Forbidden: Customers cannot manage purchase orders.' });
    const po = { ...req.body, id: req.body.id || `po-${Date.now()}` };
    const saved = await dbManager.savePurchaseOrder(po, actor);
    recordAuditFromReq(req, {
      module: 'PROCUREMENT',
      action: 'CREATE_PURCHASE_ORDER',
      entityType: 'purchase_order',
      entityId: saved.id,
      summary: `Created purchase order ${saved.poNumber || saved.id}`
    });
    res.status(201).json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to save purchase order');
  }
});

apiRouter.put('/purchase-orders/:id', async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    if (!actor) return res.status(401).json({ success: false, error: 'Authentication required. Please log in.' });
    if (isCustomerUser(actor)) return res.status(403).json({ success: false, error: 'Forbidden: Customers cannot manage purchase orders.' });
    const { id } = req.params;
    const saved = await dbManager.savePurchaseOrder({ ...req.body, id }, actor);
    recordAuditFromReq(req, {
      module: 'PROCUREMENT',
      action: 'UPDATE_PURCHASE_ORDER',
      entityType: 'purchase_order',
      entityId: id,
      summary: `Updated purchase order ${saved.poNumber || id}`
    });
    res.json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to update purchase order');
  }
});

apiRouter.post('/purchase-orders/:id/bills', async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    if (!actor) return res.status(401).json({ success: false, error: 'Authentication required. Please log in.' });
    if (isCustomerUser(actor)) return res.status(403).json({ success: false, error: 'Forbidden: Customers cannot upload vendor bills.' });

    const { id: poId } = req.params;
    const { fileName, fileData } = req.body || {};
    const decoded = validateAndDecodeUploadNode(
      String(fileName || 'vendor-bill.pdf'),
      String(fileData || ''),
      'bill'
    );

    const safePoId = path.basename(poId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const billId = `bill-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const diskFileName = `${billId}_${decoded.safeFileName}`;

    const uploadsBase = path.resolve(process.cwd(), 'uploads');
    const billsDir = path.resolve(uploadsBase, 'purchase-bills', safePoId);
    if (!billsDir.startsWith(uploadsBase + path.sep)) {
      return res.status(400).json({ success: false, error: 'Invalid upload directory path.' });
    }
    fs.mkdirSync(billsDir, { recursive: true });
    const fullPath = path.resolve(billsDir, diskFileName);
    fs.writeFileSync(fullPath, decoded.buffer);

    const relativePath = `purchase-bills/${safePoId}/${diskFileName}`;
    const fileUrl = `/api/uploads/purchase-bills/${encodeURIComponent(safePoId)}/${encodeURIComponent(diskFileName)}`;

    const billRecord = {
      id: billId,
      fileName: decoded.safeFileName,
      fileUrl,
      filePath: relativePath,
      mimeType: decoded.mimeType,
      fileSize: decoded.fileSize,
      uploadedAt: new Date().toISOString(),
      uploadedBy: actor?.name || 'Purchase Manager'
    };

    const vendorBills = await dbManager.attachBillToPurchaseOrder(poId, billRecord);
    res.json({
      success: true,
      message: 'Vendor bill uploaded and attached successfully.',
      bill: billRecord,
      vendorBills
    });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to upload vendor bill');
  }
});

apiRouter.delete('/purchase-orders/:id/bills/:billId', async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    if (!actor) return res.status(401).json({ success: false, error: 'Authentication required. Please log in.' });
    if (isCustomerUser(actor)) return res.status(403).json({ success: false, error: 'Forbidden: Customers cannot delete vendor bills.' });

    const { id: poId, billId } = req.params;
    const { removedBill, vendorBills } = await dbManager.removeBillFromPurchaseOrder(poId, billId);
    const uploadsBase = path.resolve(process.cwd(), 'uploads');
    if (removedBill?.filePath) {
      const fp = path.resolve(uploadsBase, removedBill.filePath);
      if (fp.startsWith(uploadsBase + path.sep) && fs.existsSync(fp)) {
        try { fs.unlinkSync(fp); } catch {}
      }
    } else {
      const safePoId = path.basename(poId).replace(/[^a-zA-Z0-9_-]/g, '_');
      const dir = path.resolve(uploadsBase, 'purchase-bills', safePoId);
      const safePrefix = billId.replace(/[^a-zA-Z0-9_-]/g, '');
      if (dir.startsWith(uploadsBase + path.sep) && fs.existsSync(dir) && safePrefix) {
        for (const f of fs.readdirSync(dir)) {
          if (f.startsWith(`${safePrefix}_`)) {
            try { fs.unlinkSync(path.resolve(dir, f)); } catch {}
          }
        }
      }
    }
    res.json({ success: true, vendorBills, message: 'Vendor bill deleted.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete vendor bill');
  }
});

// Authenticated streaming endpoint for Purchase Order Vendor Bills
apiRouter.get('/uploads/purchase-bills/:poId/:filename', async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    if (!actor) return res.status(401).json({ success: false, error: 'Authentication required.' });
    if (isCustomerUser(actor)) {
      return res.status(403).json({ success: false, error: 'Forbidden: Customers cannot access vendor purchase bills.' });
    }

    const { poId, filename } = req.params;
    if (poId.includes('..') || filename.includes('..')) {
      return res.status(400).json({ success: false, error: 'Invalid file path access request.' });
    }

    const safePoId = path.basename(poId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeName = path.basename(filename);
    const uploadsBase = path.resolve(process.cwd(), 'uploads');
    const fullPath = path.resolve(uploadsBase, 'purchase-bills', safePoId, safeName);
    if (!fullPath.startsWith(uploadsBase + path.sep) || !fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      return res.status(404).json({ success: false, error: 'Vendor bill not found on server.' });
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${safeName.replace(/"/g, '')}"`);
    res.sendFile(fullPath);
  } catch (err: any) {
    sendApiError(res, err, 'Failed to deliver vendor bill');
  }
});

apiRouter.post('/purchase-orders/:id/payments', async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    if (!actor) return res.status(401).json({ success: false, error: 'Authentication required. Please log in.' });
    if (isCustomerUser(actor)) return res.status(403).json({ success: false, error: 'Forbidden: Customers cannot record vendor payments.' });
    const pool = getRequiredPool();
    const result = await accountingService.recordPurchaseOrderPayment(pool, req.params.id, req.body || {}, actor);
    recordAuditFromReq(req, {
      module: 'PROCUREMENT',
      action: 'RECORD_PO_PAYMENT',
      entityType: 'purchase_order',
      entityId: req.params.id,
      summary: `Recorded payment for purchase order ${req.params.id}`
    });
    res.status(201).json({ success: true, data: result });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to record purchase order payment');
  }
});

apiRouter.delete('/purchase-orders/:id', async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    if (!actor) return res.status(401).json({ success: false, error: 'Authentication required. Please log in.' });
    if (isCustomerUser(actor)) return res.status(403).json({ success: false, error: 'Forbidden: Customers cannot delete purchase orders.' });
    await dbManager.deletePurchaseOrder(req.params.id);
    recordAuditFromReq(req, {
      module: 'PROCUREMENT',
      action: 'DELETE_PURCHASE_ORDER',
      entityType: 'purchase_order',
      entityId: req.params.id,
      summary: `Deleted purchase order ${req.params.id}`
    });
    res.json({ success: true, message: 'Purchase order deleted from MySQL.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete purchase order');
  }
});

// Bill of Materials (BOM)
apiRouter.get('/boms', requireStaffUser, async (_req: Request, res: Response) => {
  try {
    const items = await dbManager.getBOMs();
    res.json({ success: true, count: items.length, data: items });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch BOMs');
  }
});

apiRouter.post('/boms', async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    if (!actor) {
      return res.status(401).json({ success: false, error: 'Authentication required. Please log in.' });
    }
    if (isCustomerUser(actor)) {
      return res.status(403).json({ success: false, error: 'Forbidden: Customers have read-only access to Bill of Materials.' });
    }
    const bom = { ...req.body, id: req.body?.id || `bom-${Date.now()}` };
    const saved = await dbManager.saveBOM(bom);
    recordAuditFromReq(req, {
      module: 'INVENTORY',
      action: 'CREATE_BOM',
      entityType: 'bom',
      entityId: saved.id,
      summary: `Created BOM ${saved.name || saved.id}`
    });
    res.status(201).json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to save BOM');
  }
});

apiRouter.put('/boms/:id', async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    if (!actor) {
      return res.status(401).json({ success: false, error: 'Authentication required. Please log in.' });
    }
    if (isCustomerUser(actor)) {
      return res.status(403).json({ success: false, error: 'Forbidden: Customers have read-only access to Bill of Materials.' });
    }
    const { id } = req.params;
    const saved = await dbManager.saveBOM({ ...req.body, id });
    recordAuditFromReq(req, {
      module: 'INVENTORY',
      action: 'UPDATE_BOM',
      entityType: 'bom',
      entityId: id,
      summary: `Updated BOM ${id}`
    });
    res.json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to update BOM');
  }
});

apiRouter.delete('/boms/:id', async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    if (!actor) {
      return res.status(401).json({ success: false, error: 'Authentication required. Please log in.' });
    }
    if (isCustomerUser(actor)) {
      return res.status(403).json({ success: false, error: 'Forbidden: Customers have read-only access to Bill of Materials.' });
    }
    await dbManager.deleteBOM(req.params.id);
    recordAuditFromReq(req, {
      module: 'INVENTORY',
      action: 'DELETE_BOM',
      entityType: 'bom',
      entityId: req.params.id,
      summary: `Deleted BOM ${req.params.id}`
    });
    res.json({ success: true, message: 'BOM deleted from MySQL.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete BOM');
  }
});

// Sales Invoices
apiRouter.get('/sales-invoices', requireAuthenticatedUser, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    let items = await dbManager.getSalesInvoices();
    if (isCustomerUser(user)) {
      const { custId, name } = getCustomerMatchTokens(user);
      items = items.filter((inv: any) =>
        (custId && inv.customerId === custId) ||
        (name && String(inv.customerName || '').trim().toLowerCase() === name)
      );
    }
    res.json({ success: true, count: items.length, data: items });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch sales invoices');
  }
});

apiRouter.post('/sales-invoices', async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    if (!actor) {
      return res.status(401).json({ success: false, error: 'Authentication required. Please log in.' });
    }
    if (isCustomerUser(actor)) {
      return res.status(403).json({ success: false, error: 'Forbidden: Customers have read-only access to sales invoices.' });
    }
    const inv = { ...req.body, id: req.body?.id || `inv-${Date.now()}` };
    const saved = await dbManager.saveSalesInvoice(inv, actor);
    res.status(201).json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to save sales invoice');
  }
});

apiRouter.put('/sales-invoices/:id', async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    if (!actor) {
      return res.status(401).json({ success: false, error: 'Authentication required. Please log in.' });
    }
    if (isCustomerUser(actor)) {
      return res.status(403).json({ success: false, error: 'Forbidden: Customers have read-only access to sales invoices.' });
    }
    const { id } = req.params;
    const saved = await dbManager.saveSalesInvoice({ ...req.body, id }, actor);
    res.json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to update sales invoice');
  }
});

apiRouter.post('/sales-invoices/:id/payments', async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    if (!actor) {
      return res.status(401).json({ success: false, error: 'Authentication required. Please log in.' });
    }
    if (isCustomerUser(actor)) {
      return res.status(403).json({ success: false, error: 'Forbidden: Customers cannot record payments.' });
    }
    const pool = getRequiredPool();
    const result = await accountingService.recordSalesInvoicePayment(pool, req.params.id, req.body || {}, actor);
    res.status(201).json({ success: true, data: result });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to record sales invoice payment');
  }
});

apiRouter.delete('/sales-invoices/:id', async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    if (!actor) {
      return res.status(401).json({ success: false, error: 'Authentication required. Please log in.' });
    }
    if (isCustomerUser(actor)) {
      return res.status(403).json({ success: false, error: 'Forbidden: Customers have read-only access to sales invoices.' });
    }
    await dbManager.deleteSalesInvoice(req.params.id);
    res.json({ success: true, message: 'Sales invoice deleted from MySQL.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete sales invoice');
  }
});

// Sales Returns (Credit Notes + Inventory Restock + Bank Refund + GL)
apiRouter.get(['/sales-returns', '/sales-returns/'], async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    if (!actor) return res.status(401).json({ success: false, error: 'Authentication required. Please log in.' });
    if (isCustomerUser(actor)) return res.status(403).json({ success: false, error: 'Forbidden: Customer accounts cannot access internal sales returns.' });
    const pool = getRequiredPool();
    const items = await accountingService.getSalesReturns(pool);
    res.json({ success: true, count: items.length, data: items });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch sales returns');
  }
});

apiRouter.post(['/sales-returns', '/sales-returns/'], async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    if (!actor) return res.status(401).json({ success: false, error: 'Authentication required. Please log in.' });
    if (isCustomerUser(actor)) return res.status(403).json({ success: false, error: 'Forbidden: Customers cannot create sales returns.' });
    const pool = getRequiredPool();
    const result = await accountingService.createSalesReturn(pool, req.body || {}, actor);
    res.status(201).json({ success: true, data: result });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to create sales return');
  }
});

apiRouter.delete(['/sales-returns/:id', '/sales-returns/:id/'], async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    if (!actor) return res.status(401).json({ success: false, error: 'Authentication required. Please log in.' });
    if (isCustomerUser(actor)) return res.status(403).json({ success: false, error: 'Forbidden: Customers cannot delete sales returns.' });
    const pool = getRequiredPool();
    await accountingService.deleteSalesReturn(pool, req.params.id, actor);
    res.json({ success: true, message: 'Sales return reversed and deleted from MySQL.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete sales return');
  }
});

// Purchase Returns (Debit Notes + Inventory Deduction + Vendor Refund + GL)
apiRouter.get(['/purchase-returns', '/purchase-returns/'], async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    if (!actor) return res.status(401).json({ success: false, error: 'Authentication required. Please log in.' });
    if (isCustomerUser(actor)) return res.status(403).json({ success: false, error: 'Forbidden: Customer accounts cannot access internal purchase returns.' });
    const pool = getRequiredPool();
    const items = await accountingService.getPurchaseReturns(pool);
    res.json({ success: true, count: items.length, data: items });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch purchase returns');
  }
});

apiRouter.post(['/purchase-returns', '/purchase-returns/'], async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    if (!actor) return res.status(401).json({ success: false, error: 'Authentication required. Please log in.' });
    if (isCustomerUser(actor)) return res.status(403).json({ success: false, error: 'Forbidden: Customers cannot create purchase returns.' });
    const pool = getRequiredPool();
    const result = await accountingService.createPurchaseReturn(pool, req.body || {}, actor);
    res.status(201).json({ success: true, data: result });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to create purchase return');
  }
});

apiRouter.delete(['/purchase-returns/:id', '/purchase-returns/:id/'], async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    if (!actor) return res.status(401).json({ success: false, error: 'Authentication required. Please log in.' });
    if (isCustomerUser(actor)) return res.status(403).json({ success: false, error: 'Forbidden: Customers cannot delete purchase returns.' });
    const pool = getRequiredPool();
    await accountingService.deletePurchaseReturn(pool, req.params.id, actor);
    res.json({ success: true, message: 'Purchase return reversed and deleted from MySQL.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete purchase return');
  }
});

// Vendor Sales Invoices (Strict Admin-Only APIs)
apiRouter.get(['/vendor-sales-invoices', '/vendor-sales-invoices/'], requireVendorSalesInvoiceAdmin, async (_req: Request, res: Response) => {
  try {
    const items = await dbManager.getVendorSalesInvoices();
    res.json({ success: true, count: items.length, data: items });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch vendor sales invoices');
  }
});

apiRouter.get(['/vendor-sales-invoices/next-number', '/vendor-sales-invoices/next-number/'], requireVendorSalesInvoiceAdmin, async (_req: Request, res: Response) => {
  try {
    const nextNumber = await dbManager.getNextVendorSalesInvoiceNumber();
    res.json({ success: true, data: { invoiceNumber: nextNumber } });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to generate next vendor sales invoice number');
  }
});

apiRouter.get(['/vendor-sales-invoices/:id', '/vendor-sales-invoices/:id/'], requireVendorSalesInvoiceAdmin, async (req: Request, res: Response) => {
  try {
    const invoice = await dbManager.getVendorSalesInvoiceById(req.params.id);
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Vendor sales invoice not found.' });
    }
    res.json({ success: true, data: invoice });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch vendor sales invoice details');
  }
});

apiRouter.post(['/vendor-sales-invoices', '/vendor-sales-invoices/'], requireVendorSalesInvoiceAdmin, async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    const payload = { ...(req.body || {}), id: req.body?.id || `vsi-${Date.now()}` };
    const saved = await dbManager.saveVendorSalesInvoice(payload, actor);
    res.status(201).json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to create vendor sales invoice');
  }
});

const handleVendorSalesInvoiceUpdate = async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    const saved = await dbManager.saveVendorSalesInvoice({ ...(req.body || {}), id: req.params.id }, actor);
    res.json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to update vendor sales invoice');
  }
};

apiRouter.put(['/vendor-sales-invoices/:id', '/vendor-sales-invoices/:id/'], requireVendorSalesInvoiceAdmin, handleVendorSalesInvoiceUpdate);
apiRouter.post(['/vendor-sales-invoices/:id', '/vendor-sales-invoices/:id/'], requireVendorSalesInvoiceAdmin, handleVendorSalesInvoiceUpdate);

apiRouter.post(['/vendor-sales-invoices/:id/payments', '/vendor-sales-invoices/:id/payments/'], requireVendorSalesInvoiceAdmin, async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    const updated = await dbManager.recordVendorSalesPayment(req.params.id, req.body || {}, actor);
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to record payment on vendor sales invoice');
  }
});

apiRouter.delete(['/vendor-sales-invoices/:id', '/vendor-sales-invoices/:id/'], requireVendorSalesInvoiceAdmin, async (req: Request, res: Response) => {
  try {
    await dbManager.deleteVendorSalesInvoice(req.params.id);
    res.json({ success: true, message: 'Vendor sales invoice deleted from MySQL.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete vendor sales invoice');
  }
});

// Warehouses
apiRouter.get('/warehouses', requireStaffUser, async (_req: Request, res: Response) => {
  try {
    const items = await dbManager.getWarehouses();
    res.json({ success: true, count: items.length, data: items });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch warehouses');
  }
});

apiRouter.post('/warehouses', requireRole(['Admin', 'Super Admin']), async (req: Request, res: Response) => {
  try {
    const wh = { ...req.body, id: req.body.id || `wh-${Date.now()}` };
    const saved = await dbManager.saveWarehouse(wh);
    recordAuditFromReq(req, {
      module: 'WAREHOUSE',
      action: 'CREATE_WAREHOUSE',
      entityType: 'warehouse',
      entityId: saved.id,
      summary: `Created warehouse ${saved.name || saved.id}`
    });
    res.status(201).json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to save warehouse');
  }
});

apiRouter.put('/warehouses/:id', requireRole(['Admin', 'Super Admin']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const saved = await dbManager.saveWarehouse({ ...req.body, id });
    recordAuditFromReq(req, {
      module: 'WAREHOUSE',
      action: 'UPDATE_WAREHOUSE',
      entityType: 'warehouse',
      entityId: id,
      summary: `Updated warehouse ${saved.name || id}`
    });
    res.json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to update warehouse');
  }
});

apiRouter.delete('/warehouses/:id', requireRole(['Admin', 'Super Admin']), async (req: Request, res: Response) => {
  try {
    await dbManager.deleteWarehouse(req.params.id);
    recordAuditFromReq(req, {
      module: 'WAREHOUSE',
      action: 'DELETE_WAREHOUSE',
      entityType: 'warehouse',
      entityId: req.params.id,
      summary: `Deleted warehouse ${req.params.id}`
    });
    res.json({ success: true, message: 'Warehouse deleted from MySQL.' });
  } catch (err: any) {
    if (String(err?.message || '').includes('Primary/Default warehouse')) {
      res.status(400).json({ success: false, error: err.message });
      return;
    }
    sendApiError(res, err, 'Failed to delete warehouse');
  }
});

// Stock Movements
apiRouter.get('/stock-movements', requireStaffUser, async (_req: Request, res: Response) => {
  try {
    const items = await dbManager.getStockMovements();
    res.json({ success: true, count: items.length, data: items });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch stock movements');
  }
});

apiRouter.post('/stock-movements', requireStaffUser, async (req: Request, res: Response) => {
  try {
    const sm = { ...req.body, id: req.body.id || `sm-${Date.now()}` };
    const saved = await dbManager.saveStockMovement(sm);
    recordAuditFromReq(req, {
      module: 'INVENTORY',
      action: 'STOCK_MOVEMENT',
      entityType: 'stock_movement',
      entityId: saved.id,
      summary: `Recorded stock movement ${saved.id}`
    });
    res.status(201).json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to save stock movement');
  }
});

// Stock Audits
apiRouter.get('/stock-audits', requireStaffUser, async (_req: Request, res: Response) => {
  try {
    const items = await dbManager.getStockAudits();
    res.json({ success: true, count: items.length, data: items });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch stock audits');
  }
});

apiRouter.post('/stock-audits', requireStaffUser, async (req: Request, res: Response) => {
  try {
    const sa = { ...req.body, id: req.body.id || `audit-${Date.now()}` };
    const saved = await dbManager.saveStockAudit(sa);
    recordAuditFromReq(req, {
      module: 'INVENTORY',
      action: 'CREATE_STOCK_AUDIT',
      entityType: 'stock_audit',
      entityId: saved.id,
      summary: `Recorded stock audit ${saved.id}`
    });
    res.status(201).json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to save stock audit');
  }
});

apiRouter.delete('/stock-audits/:id', requireRole(['Admin', 'Super Admin']), async (req: Request, res: Response) => {
  try {
    await dbManager.deleteStockAudit(req.params.id);
    recordAuditFromReq(req, {
      module: 'INVENTORY',
      action: 'DELETE_STOCK_AUDIT',
      entityType: 'stock_audit',
      entityId: req.params.id,
      summary: `Deleted stock audit ${req.params.id}`
    });
    res.json({ success: true, message: 'Stock audit deleted from MySQL.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete stock audit');
  }
});

// ==========================================================
// 9. QUOTATIONS & SITE SURVEYS APIS
// ==========================================================

apiRouter.get('/quotations', requireAuthenticatedUser, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    let items = await dbManager.getQuotations();
    if (isCustomerUser(user)) {
      const { custId, name } = getCustomerMatchTokens(user);
      items = items.filter((q: any) =>
        (custId && q.customerId === custId) ||
        (name && String(q.customerName || '').trim().toLowerCase() === name)
      );
    }
    res.json({ success: true, count: items.length, data: items });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch quotations');
  }
});

apiRouter.post('/quotations', requireStaffUser, async (req: Request, res: Response) => {
  try {
    const q = { ...req.body, id: req.body.id || `quote-${Date.now()}` };
    const saved = await dbManager.saveQuotation(q);
    recordAuditFromReq(req, {
      module: 'CRM',
      action: 'CREATE_QUOTATION',
      entityType: 'quotation',
      entityId: saved.id,
      summary: `Created quotation ${saved.quoteNumber || saved.id}`
    });
    res.status(201).json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to save quotation');
  }
});

apiRouter.put('/quotations/:id', requireStaffUser, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const saved = await dbManager.saveQuotation({ ...req.body, id });
    recordAuditFromReq(req, {
      module: 'CRM',
      action: 'UPDATE_QUOTATION',
      entityType: 'quotation',
      entityId: id,
      summary: `Updated quotation ${saved.quoteNumber || id}`
    });
    res.json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to update quotation');
  }
});

apiRouter.delete('/quotations/:id', requireStaffUser, async (req: Request, res: Response) => {
  try {
    await dbManager.deleteQuotation(req.params.id);
    recordAuditFromReq(req, {
      module: 'CRM',
      action: 'DELETE_QUOTATION',
      entityType: 'quotation',
      entityId: req.params.id,
      summary: `Deleted quotation ${req.params.id}`
    });
    res.json({ success: true, message: 'Quotation deleted from MySQL.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete quotation');
  }
});

// Site Surveys
apiRouter.get('/surveys', requireStaffUser, async (_req: Request, res: Response) => {
  try {
    const items = await dbManager.getSurveys();
    res.json({ success: true, count: items.length, data: items });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch surveys');
  }
});

apiRouter.post('/surveys', requireStaffUser, async (req: Request, res: Response) => {
  try {
    const s = { ...req.body, id: req.body.id || `surv-${Date.now()}` };
    const saved = await dbManager.saveSurvey(s);
    recordAuditFromReq(req, {
      module: 'SURVEYS',
      action: 'CREATE_SURVEY',
      entityType: 'survey',
      entityId: saved.id,
      summary: `Created site survey ${saved.id}`
    });
    res.status(201).json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to save survey');
  }
});

apiRouter.put('/surveys/:id', requireStaffUser, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const saved = await dbManager.saveSurvey({ ...req.body, id });
    recordAuditFromReq(req, {
      module: 'SURVEYS',
      action: 'UPDATE_SURVEY',
      entityType: 'survey',
      entityId: id,
      summary: `Updated site survey ${id}`
    });
    res.json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to update survey');
  }
});

apiRouter.delete('/surveys/:id', requireStaffUser, async (req: Request, res: Response) => {
  try {
    await dbManager.deleteSurvey(req.params.id);
    recordAuditFromReq(req, {
      module: 'SURVEYS',
      action: 'DELETE_SURVEY',
      entityType: 'survey',
      entityId: req.params.id,
      summary: `Deleted site survey ${req.params.id}`
    });
    res.json({ success: true, message: 'Survey deleted from MySQL.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete survey');
  }
});

// ==========================================================
// 10. FINANCE (PAYMENTS & EXPENSES)
// ==========================================================

apiRouter.get('/payments', requireAuthenticatedUser, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    let items = await dbManager.getPayments();
    if (isCustomerUser(user)) {
      const { custId, name } = getCustomerMatchTokens(user);
      items = items.filter((p: any) =>
        (custId && p.customerId === custId) ||
        (name && String(p.customerName || '').trim().toLowerCase() === name)
      );
    }
    res.json({ success: true, count: items.length, data: items });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch payments');
  }
});

apiRouter.post('/payments', requireStaffUser, async (req: Request, res: Response) => {
  try {
    const pay = { ...req.body, id: req.body.id || `pay-${Date.now()}` };
    const saved = await dbManager.savePayment(pay);
    recordAuditFromReq(req, {
      module: 'FINANCE',
      action: 'CREATE_PAYMENT',
      entityType: 'payment',
      entityId: saved.id,
      summary: `Recorded payment ${saved.id} (₹${saved.amount || 0})`
    });
    res.status(201).json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to save payment');
  }
});

// Batch Payment Import (Excel / CSV Hub)
apiRouter.post(['/payments/import', '/payments/import/'], requireStaffUser, async (req: Request, res: Response) => {
  try {
    const { payments, rows } = req.body || {};
    const list = Array.isArray(payments) ? payments : (Array.isArray(rows) ? rows : (Array.isArray(req.body) ? req.body : []));
    if (!list || list.length === 0) {
      res.status(400).json({ success: false, message: 'No payment records provided for import.' });
      return;
    }
    const result = await dbManager.importPayments(list);
    recordAuditFromReq(req, {
      module: 'FINANCE',
      action: 'IMPORT_PAYMENTS',
      entityType: 'payment',
      summary: `Imported ${result.imported || list.length} payments`
    });
    res.json(result);
  } catch (err: any) {
    console.error('[MySQL Payment Import Error]:', err);
    sendApiError(res, err, 'Database error during payment import.', {
      total: 0,
      imported: 0,
      skipped: 0,
      failed: 0
    });
  }
});

apiRouter.delete('/payments/:id', requireRole(['Admin', 'Super Admin', 'Accountant']), async (req: Request, res: Response) => {
  try {
    await dbManager.deletePayment(req.params.id);
    recordAuditFromReq(req, {
      module: 'FINANCE',
      action: 'DELETE_PAYMENT',
      entityType: 'payment',
      entityId: req.params.id,
      summary: `Deleted payment ${req.params.id}`
    });
    res.json({ success: true, message: 'Payment deleted from MySQL.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete payment');
  }
});

apiRouter.get('/expenses', requireStaffUser, async (_req: Request, res: Response) => {
  try {
    const items = await dbManager.getExpenses();
    res.json({ success: true, count: items.length, data: items });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch expenses');
  }
});

apiRouter.post('/expenses', requireStaffUser, async (req: Request, res: Response) => {
  try {
    const ex = { ...req.body, id: req.body.id || `exp-${Date.now()}` };
    const saved = await dbManager.saveExpense(ex);
    recordAuditFromReq(req, {
      module: 'FINANCE',
      action: 'CREATE_EXPENSE',
      entityType: 'expense',
      entityId: saved.id,
      summary: `Recorded expense ${saved.id} (₹${saved.amount || 0})`
    });
    res.status(201).json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to save expense');
  }
});

// Batch Expense Import (Excel / CSV Hub)
apiRouter.post(['/expenses/import', '/expenses/import/'], requireStaffUser, async (req: Request, res: Response) => {
  try {
    const { expenses, rows } = req.body || {};
    const list = Array.isArray(expenses) ? expenses : (Array.isArray(rows) ? rows : (Array.isArray(req.body) ? req.body : []));
    if (!list || list.length === 0) {
      res.status(400).json({ success: false, message: 'No expense records provided for import.' });
      return;
    }
    const result = await dbManager.importExpenses(list);
    recordAuditFromReq(req, {
      module: 'FINANCE',
      action: 'IMPORT_EXPENSES',
      entityType: 'expense',
      summary: `Imported ${result.imported || list.length} expenses`
    });
    res.json(result);
  } catch (err: any) {
    console.error('[MySQL Expense Import Error]:', err);
    sendApiError(res, err, 'Database error during expense import.', {
      total: 0,
      imported: 0,
      skipped: 0,
      failed: 0
    });
  }
});

apiRouter.delete('/expenses/:id', requireRole(['Admin', 'Super Admin', 'Accountant']), async (req: Request, res: Response) => {
  try {
    await dbManager.deleteExpense(req.params.id);
    recordAuditFromReq(req, {
      module: 'FINANCE',
      action: 'DELETE_EXPENSE',
      entityType: 'expense',
      entityId: req.params.id,
      summary: `Deleted expense ${req.params.id}`
    });
    res.json({ success: true, message: 'Expense deleted from MySQL.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete expense');
  }
});

// ==========================================================
// 11. SERVICE TICKETS & AMC CONTRACTS
// ==========================================================

// Eligible Active Field Workers / Technicians for Service Assignment (Admin Only)
apiRouter.get('/service-tickets/technicians', requireAdminOnly, async (_req: Request, res: Response) => {
  try {
    const technicians = await dbManager.getEligibleServiceTechnicians();
    res.json({ success: true, count: technicians.length, data: technicians });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch eligible service technicians');
  }
});

apiRouter.get('/service-tickets', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ success: false, message: 'Authentication required. Please log in.' });
    }
    let items = await dbManager.getServiceTickets();
    if (isCustomerUser(user)) {
      const custId = String(user.customerId || user.linkedEntityId || '').trim();
      const userName = String(user.name || '').trim().toLowerCase();
      items = items.filter((t: any) =>
        (custId && t.customerId === custId) ||
        (userName && String(t.customerName || '').trim().toLowerCase() === userName)
      );
    }
    res.json({ success: true, count: items.length, data: items });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch service tickets');
  }
});

apiRouter.get(['/service-tickets/:id/details', '/service-tickets/:id'], async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ success: false, message: 'Authentication required. Please log in.' });
    }
    const details = await dbManager.getServiceTicketDetails(req.params.id);
    if (!details) {
      return res.status(404).json({ success: false, message: 'Service ticket not found.' });
    }
    if (isCustomerUser(user)) {
      const custId = String(user.customerId || user.linkedEntityId || '').trim();
      const userName = String(user.name || '').trim().toLowerCase();
      const ownsTicket =
        (custId && details.customerId === custId) ||
        (userName && String(details.customerName || '').trim().toLowerCase() === userName);
      if (!ownsTicket) {
        return res.status(403).json({ success: false, message: 'Access denied: You can only view your own service tickets.' });
      }
    }
    res.json({ success: true, data: details });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch service ticket details');
  }
});

apiRouter.post('/service-tickets', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ success: false, message: 'Authentication required. Please log in.' });
    }
    const roleUpper = String(user.role || '').trim().toUpperCase();
    const isActorAdmin = roleUpper === 'ADMIN' || roleUpper === 'SUPER ADMIN';
    const body = req.body || {};

    let tk: any = {
      ...body,
      id: body.id || `srv-${Date.now()}`
    };

    if (!isActorAdmin) {
      tk = {
        ...tk,
        status: 'OPEN',
        assignedTechnicianId: '',
        assignedTechnicianName: '',
        assignedToName: 'Unassigned'
      };
      if (isCustomerUser(user) && (user.customerId || user.linkedEntityId)) {
        tk.customerId = user.customerId || user.linkedEntityId;
        tk.customerName = tk.customerName || user.name || 'Customer';
      }
    } else if (tk.assignedTechnicianId) {
      const eligible = await dbManager.getEligibleServiceTechnicians();
      const matched = eligible.find(t => t.id === tk.assignedTechnicianId);
      if (!matched) {
        return res.status(400).json({
          success: false,
          message: 'Selected technician is not an active eligible Field Worker / Technician.'
        });
      }
      tk.assignedTechnicianId = matched.id;
      tk.assignedTechnicianName = matched.name;
      if (!tk.status || tk.status === 'OPEN') {
        tk.status = 'ASSIGNED';
      }
    }

    const saved = await dbManager.saveServiceTicket(tk, user);
    recordAuditFromReq(req, {
      module: 'SERVICE',
      action: 'CREATE_TICKET',
      entityType: 'service_ticket',
      entityId: saved.id,
      summary: `Created service ticket ${saved.ticketNumber || saved.id}`
    });
    res.status(201).json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to save service ticket');
  }
});

// Batch Service Tickets Import (Excel / CSV Hub)
apiRouter.post(['/service-tickets/import', '/service/import', '/service-tickets/import/', '/service/import/'], requireAdminOnly, async (req: Request, res: Response) => {
  try {
    const { tickets, service, rows } = req.body || {};
    const list = Array.isArray(tickets) ? tickets : (Array.isArray(service) ? service : (Array.isArray(rows) ? rows : (Array.isArray(req.body) ? req.body : [])));
    if (!list || list.length === 0) {
      res.status(400).json({ success: false, message: 'No service ticket records provided for import.' });
      return;
    }
    const result = await dbManager.importServiceTickets(list);
    recordAuditFromReq(req, {
      module: 'SERVICE',
      action: 'IMPORT_TICKETS',
      entityType: 'service_ticket',
      summary: `Imported ${result.imported || list.length} service tickets`
    });
    res.json(result);
  } catch (err: any) {
    console.error('[MySQL Service Ticket Import Error]:', err);
    sendApiError(res, err, 'Database error during service tickets import.', {
      total: 0,
      imported: 0,
      skipped: 0,
      failed: 0
    });
  }
});

// Admin-only: Assign, Reassign, or Unassign Technician
apiRouter.put('/service-tickets/:id/assign', requireAdminOnly, async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    const updated = await dbManager.assignServiceTicketTechnician(req.params.id, req.body || {}, actor);
    recordAuditFromReq(req, {
      module: 'SERVICE',
      action: 'ASSIGN_TECHNICIAN',
      entityType: 'service_ticket',
      entityId: req.params.id,
      summary: `Updated technician assignment for ticket ${req.params.id}`
    });
    res.json({ success: true, data: updated, message: 'Technician assignment updated in MySQL.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to update technician assignment');
  }
});

apiRouter.post('/service-tickets/:id/assign', requireAdminOnly, async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    const updated = await dbManager.assignServiceTicketTechnician(req.params.id, req.body || {}, actor);
    recordAuditFromReq(req, {
      module: 'SERVICE',
      action: 'ASSIGN_TECHNICIAN',
      entityType: 'service_ticket',
      entityId: req.params.id,
      summary: `Updated technician assignment for ticket ${req.params.id}`
    });
    res.json({ success: true, data: updated, message: 'Technician assignment updated in MySQL.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to update technician assignment');
  }
});

// Admin-only: Update Status, Priority, Technician, Scheduled Date, Remarks & Resolution Details
apiRouter.put('/service-tickets/:id/admin-update', requireAdminOnly, async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    const updated = await dbManager.adminUpdateServiceTicket(req.params.id, req.body || {}, actor);
    recordAuditFromReq(req, {
      module: 'SERVICE',
      action: 'UPDATE_TICKET',
      entityType: 'service_ticket',
      entityId: req.params.id,
      summary: `Updated service ticket ${req.params.id}`
    });
    res.json({ success: true, data: updated, message: 'Service ticket updated in MySQL.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to update service ticket');
  }
});

apiRouter.patch('/service-tickets/:id/admin-update', requireAdminOnly, async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    const updated = await dbManager.adminUpdateServiceTicket(req.params.id, req.body || {}, actor);
    recordAuditFromReq(req, {
      module: 'SERVICE',
      action: 'UPDATE_TICKET',
      entityType: 'service_ticket',
      entityId: req.params.id,
      summary: `Patched service ticket ${req.params.id}`
    });
    res.json({ success: true, data: updated, message: 'Service ticket updated in MySQL.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to update service ticket');
  }
});

apiRouter.put('/service-tickets/:id', requireAdminOnly, async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    const updated = await dbManager.adminUpdateServiceTicket(req.params.id, req.body || {}, actor);
    recordAuditFromReq(req, {
      module: 'SERVICE',
      action: 'UPDATE_TICKET',
      entityType: 'service_ticket',
      entityId: req.params.id,
      summary: `Updated service ticket ${req.params.id}`
    });
    res.json({ success: true, data: updated, message: 'Service ticket updated in MySQL.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to update service ticket');
  }
});

apiRouter.delete('/service-tickets/:id', requireAdminOnly, async (req: Request, res: Response) => {
  try {
    await dbManager.deleteServiceTicket(req.params.id);
    recordAuditFromReq(req, {
      module: 'SERVICE',
      action: 'DELETE_TICKET',
      entityType: 'service_ticket',
      entityId: req.params.id,
      summary: `Deleted service ticket ${req.params.id}`
    });
    res.json({ success: true, message: 'Service ticket deleted from MySQL.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete service ticket');
  }
});

apiRouter.get('/amc-contracts', requireAuthenticatedUser, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    let items = await dbManager.getAMCContracts();
    if (isCustomerUser(user)) {
      const { custId, name } = getCustomerMatchTokens(user);
      items = items.filter((a: any) =>
        (custId && a.customerId === custId) ||
        (name && String(a.customerName || '').trim().toLowerCase() === name)
      );
    }
    res.json({ success: true, count: items.length, data: items });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch AMC contracts');
  }
});

apiRouter.post('/amc-contracts', requireStaffUser, async (req: Request, res: Response) => {
  try {
    const amc = { ...req.body, id: req.body.id || `amc-${Date.now()}` };
    const saved = await dbManager.saveAMCContract(amc);
    recordAuditFromReq(req, {
      module: 'SERVICE',
      action: 'CREATE_AMC',
      entityType: 'amc_contract',
      entityId: saved.id,
      summary: `Created AMC contract ${saved.id}`
    });
    res.status(201).json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to save AMC contract');
  }
});

apiRouter.put('/amc-contracts/:id', requireStaffUser, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const saved = await dbManager.saveAMCContract({ ...req.body, id });
    recordAuditFromReq(req, {
      module: 'SERVICE',
      action: 'UPDATE_AMC',
      entityType: 'amc_contract',
      entityId: id,
      summary: `Updated AMC contract ${id}`
    });
    res.json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to update AMC contract');
  }
});

apiRouter.delete('/amc-contracts/:id', requireRole(['Admin', 'Super Admin']), async (req: Request, res: Response) => {
  try {
    await dbManager.deleteAMCContract(req.params.id);
    recordAuditFromReq(req, {
      module: 'SERVICE',
      action: 'DELETE_AMC',
      entityType: 'amc_contract',
      entityId: req.params.id,
      summary: `Deleted AMC contract ${req.params.id}`
    });
    res.json({ success: true, message: 'AMC contract deleted from MySQL.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete AMC contract');
  }
});

// ==========================================================
// 12. NOTIFICATIONS & SYSTEM SETTINGS
// ==========================================================

apiRouter.get('/notifications', requireAuthenticatedUser, async (_req: Request, res: Response) => {
  try {
    const items = await dbManager.getNotifications();
    res.json({ success: true, count: items.length, data: items });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch notifications');
  }
});

apiRouter.post('/notifications', requireStaffUser, async (req: Request, res: Response) => {
  try {
    const n = { ...req.body, id: req.body.id || `notif-${Date.now()}` };
    const saved = await dbManager.saveNotification(n);
    res.status(201).json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to save notification');
  }
});

apiRouter.put('/notifications/:id/read', requireAuthenticatedUser, async (req: Request, res: Response) => {
  try {
    const items = await dbManager.getNotifications();
    const target = items.find((n: any) => n.id === req.params.id);
    if (target) {
      target.isRead = true;
      await dbManager.saveNotification(target);
    }
    res.json({ success: true, message: 'Notification marked read in MySQL.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to update notification');
  }
});

apiRouter.put('/notifications/mark-all-read', requireAuthenticatedUser, async (_req: Request, res: Response) => {
  try {
    const items = await dbManager.getNotifications();
    for (const n of items) {
      if (!n.isRead) {
        n.isRead = true;
        await dbManager.saveNotification(n);
      }
    }
    res.json({ success: true, message: 'All notifications marked read in MySQL.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to mark all read');
  }
});

// System Settings
apiRouter.get('/settings', requireAuthenticatedUser, async (_req: Request, res: Response) => {
  try {
    const s = await dbManager.getSettings();
    res.json({ success: true, data: s });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch settings');
  }
});

apiRouter.post('/settings', requireRole(['Admin', 'Super Admin']), async (req: Request, res: Response) => {
  try {
    const s = req.body || {};
    const saved = await dbManager.saveSettings(s);
    recordAuditFromReq(req, {
      module: 'SETTINGS',
      action: 'UPDATE_SETTINGS',
      entityType: 'system_settings',
      summary: 'Updated ERP system settings'
    });
    res.json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to save settings');
  }
});

// ==========================================================
// GMAIL SMTP CONFIGURATION (STRICT ADMIN ONLY) & APP EMAIL
// ==========================================================
apiRouter.get('/settings/email', requireAdminOnly, async (_req: Request, res: Response) => {
  try {
    const data = await dbManager.getSanitizedEmailSettings();
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to load Gmail email configuration');
  }
});

const handleSaveEmailSettings = async (req: Request, res: Response) => {
  try {
    const existing = await dbManager.getEmailSettingsInternal();
    const hasExistingPassword = Boolean(existing?.encrypted_app_password && existing?.iv && existing?.auth_tag);

    const validation = validateEmailConfigInput(req.body, hasExistingPassword);
    if (validation.valid === false) {
      return res.status(400).json({ success: false, message: validation.error });
    }

    let encryptedAppPassword = existing?.encrypted_app_password || '';
    let iv = existing?.iv || '';
    let authTag = existing?.auth_tag || '';

    if (validation.data.appPassword) {
      const enc = encryptSecret(validation.data.appPassword);
      encryptedAppPassword = enc.ciphertext;
      iv = enc.iv;
      authTag = enc.authTag;
    }

    const user = (req as any).user;
    const updatedBy = String(user?.email || user?.name || user?.id || 'Admin');

    const saved = await dbManager.saveEmailSettings({
      gmailAddress: validation.data.gmailAddress,
      smtpHost: validation.data.smtpHost,
      smtpPort: validation.data.smtpPort,
      smtpSecurity: validation.data.smtpSecurity,
      senderName: validation.data.senderName,
      encryptedAppPassword,
      iv,
      authTag,
      enabled: validation.data.enabled,
      updatedBy
    });

    res.json({
      success: true,
      message: 'Gmail SMTP configuration saved securely to MySQL.',
      data: saved
    });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to save Gmail email configuration');
  }
};

apiRouter.post('/settings/email', requireAdminOnly, handleSaveEmailSettings);
apiRouter.put('/settings/email', requireAdminOnly, handleSaveEmailSettings);

apiRouter.delete('/settings/email', requireAdminOnly, async (_req: Request, res: Response) => {
  try {
    await dbManager.deleteEmailSettings();
    const data = await dbManager.getSanitizedEmailSettings();
    res.json({
      success: true,
      message: 'Gmail SMTP credentials removed from MySQL.',
      data
    });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete Gmail email configuration');
  }
});

apiRouter.post('/settings/email/test', requireAdminOnly, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const stored = await dbManager.getEmailSettingsInternal();
    const body = req.body || {};

    const gmailAddress = String(body.gmailAddress || stored?.gmail_address || '').trim().toLowerCase();
    const smtpSecurity: SmtpSecurity =
      String(body.smtpSecurity || stored?.smtp_security || 'TLS').toUpperCase() === 'SSL' ? 'SSL' : 'TLS';
    const smtpHost = String(body.smtpHost || stored?.smtp_host || 'smtp.gmail.com').trim();
    const smtpPort = Number(body.smtpPort || stored?.smtp_port || (smtpSecurity === 'SSL' ? 465 : 587));
    const senderName = String(body.senderName || stored?.sender_name || 'Solar Urja ERP').trim();
    const recipientEmail = String(body.testRecipient || gmailAddress || user?.email || '').trim();

    if (!isValidEmailAddress(gmailAddress)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid Gmail email address before testing.' });
    }
    if (!isValidEmailAddress(recipientEmail)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid test recipient email address.' });
    }

    let decryptedPassword = body.appPassword ? normalizeAppPassword(body.appPassword) : '';
    if (!decryptedPassword && stored?.encrypted_app_password && stored?.iv && stored?.auth_tag) {
      decryptedPassword = decryptSecret(stored.encrypted_app_password, stored.iv, stored.auth_tag);
    }

    if (!decryptedPassword) {
      return res.status(400).json({
        success: false,
        message: 'Gmail App Password is required to send a test email.'
      });
    }

    try {
      const result = await verifyAndSendTestEmail({
        config: { gmailAddress, smtpHost, smtpPort, smtpSecurity, senderName },
        decryptedPassword,
        recipientEmail,
        requestedBy: String(user?.name || user?.email || 'Admin')
      });

      let latestSanitized = null;
      if (stored) {
        latestSanitized = await dbManager.updateEmailTestStatus(
          'SUCCESS',
          `Test email delivered to ${recipientEmail} (Message ID: ${result.messageId})`,
          result.sentAt
        );
      }

      return res.json({
        success: true,
        message: `Test email sent successfully to ${recipientEmail}.`,
        data: {
          messageId: result.messageId,
          sentAt: result.sentAt,
          recipientEmail,
          settings: latestSanitized
        }
      });
    } catch (smtpErr: any) {
      const cleanMessage = formatSmtpError(smtpErr);
      let latestSanitized = null;
      if (stored) {
        latestSanitized = await dbManager.updateEmailTestStatus('FAILED', cleanMessage).catch(() => null);
      }
      return res.status(400).json({
        success: false,
        message: cleanMessage,
        data: latestSanitized ? { settings: latestSanitized } : undefined
      });
    }
  } catch (err: any) {
    sendApiError(res, err, 'Failed to run Gmail SMTP test');
  }
});

// Safe status endpoint for authenticated ERP staff workflows (never exposes secrets)
apiRouter.get('/email/status', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }
    if (isCustomerUser(user)) {
      return res.status(403).json({ success: false, message: 'Access denied for customer accounts.' });
    }
    const sanitized = await dbManager.getSanitizedEmailSettings();
    res.json({
      success: true,
      data: {
        configured: sanitized.configured,
        enabled: sanitized.enabled,
        senderName: sanitized.senderName,
        gmailAddress: sanitized.configured ? sanitized.gmailAddress : ''
      }
    });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to check email configuration status');
  }
});

// Application email sending endpoint for authenticated ERP workflows
apiRouter.post('/email/send', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ success: false, message: 'Authentication required to send emails.' });
    }
    if (isCustomerUser(user)) {
      return res.status(403).json({ success: false, message: 'Access denied: Customer portal accounts cannot send ERP emails.' });
    }

    const row = await dbManager.getEmailSettingsInternal();
    try {
      const result = await sendConfiguredEmail(row, {
        to: req.body?.to,
        cc: req.body?.cc,
        bcc: req.body?.bcc,
        replyTo: req.body?.replyTo,
        subject: req.body?.subject,
        text: req.body?.text,
        html: req.body?.html,
        attachments: Array.isArray(req.body?.attachments) ? req.body.attachments : undefined
      });
      res.json({
        success: true,
        message: `Email sent successfully to ${result.accepted.join(', ')}.`,
        data: result
      });
    } catch (sendErr: any) {
      const status = typeof sendErr?.statusCode === 'number' ? sendErr.statusCode : 400;
      const msg = sendErr?.statusCode === 400 ? sendErr.message : formatSmtpError(sendErr);
      res.status(status).json({
        success: false,
        message: msg
      });
    }
  } catch (err: any) {
    sendApiError(res, err, 'Failed to send email');
  }
});

// ACL Config & Audit Logs
apiRouter.get('/acl/config', requireAuthenticatedUser, async (_req: Request, res: Response) => {
  try {
    const cfg = await dbManager.getAclConfig();
    res.json({ success: true, data: cfg });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch ACL config');
  }
});

apiRouter.post('/acl/config', requireRole(['Admin', 'Super Admin']), async (req: Request, res: Response) => {
  try {
    const cfg = req.body || {};
    const saved = await dbManager.saveAclConfig(cfg);
    recordAuditFromReq(req, {
      module: 'ACL',
      action: 'UPDATE_ACL_CONFIG',
      entityType: 'acl_config',
      summary: 'Updated Role-Based Access Control matrix'
    });
    res.json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to save ACL config');
  }
});

apiRouter.get('/acl/audit-logs', requireRole(['Admin', 'Super Admin']), async (_req: Request, res: Response) => {
  try {
    const logs = await dbManager.getAclAuditLogs();
    res.json({ success: true, data: logs });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch ACL audit logs');
  }
});

apiRouter.post('/acl/audit-logs', requireRole(['Admin', 'Super Admin']), async (req: Request, res: Response) => {
  try {
    const log = req.body || {};
    const saved = await dbManager.addAclAuditLog(log);
    res.status(201).json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to add ACL audit log');
  }
});

// Centralized Production System Audit Logs API
apiRouter.get('/audit-logs', requireRole(['Admin', 'Super Admin', 'HR Manager', 'Accountant']), async (req: Request, res: Response) => {
  try {
    const module = typeof req.query.module === 'string' ? req.query.module : undefined;
    const action = typeof req.query.action === 'string' ? req.query.action : undefined;
    const actorId = typeof req.query.actorId === 'string' ? req.query.actorId : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 200;
    const data = await dbManager.getAuditLogs({ module, action, actorId, limit });
    res.json({ success: true, count: data.length, data });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch system audit logs');
  }
});

// ==========================================================
// ACCOUNTING & FINANCE MODULE ROUTES (/api/accounting/*)
// ==========================================================

const requireFinanceViewer = (req: Request, res: Response, next: () => void) => {
  const user = (req as any).user;
  if (!user) {
    return res.status(401).json({ success: false, message: 'Authentication required. Please log in.' });
  }
  if (isCustomerUser(user)) {
    return res.status(403).json({ success: false, message: 'Access denied: Customer accounts cannot access internal accounting.' });
  }
  const role = String(user.role || '').trim();
  const allowed = ['Admin', 'Super Admin', 'Accountant', 'Project Manager', 'Sales Manager', 'HR Manager'];
  if (allowed.includes(role)) {
    return next();
  }
  // Allow other internal staff to submit/view if non-mutating or expense-related endpoints permit, else deny
  return res.status(403).json({ success: false, message: 'Access denied: Finance module privileges required.' });
};

const requireFinanceManager = (req: Request, res: Response, next: () => void) => {
  const user = (req as any).user;
  if (!user) {
    return res.status(401).json({ success: false, message: 'Authentication required. Please log in.' });
  }
  const role = String(user.role || '').trim();
  if (['Admin', 'Super Admin', 'Accountant'].includes(role)) {
    return next();
  }
  return res.status(403).json({ success: false, message: 'Access denied: Admin or Accountant authorization required.' });
};

const getRequiredPool = () => {
  return dbManager.getPool() as any;
};

apiRouter.get('/accounting/bank-accounts', async (req: Request, res: Response) => {
  try {
    const actor = (req as any).user;
    if (!actor) {
      return res.status(401).json({ success: false, message: 'Authentication required. Please log in.' });
    }
    if (isCustomerUser(actor)) {
      return res.status(403).json({ success: false, message: 'Access denied: Customer accounts cannot access internal cash/bank accounts.' });
    }
    const pool = getRequiredPool();
    const accounts = await accountingService.getBankAccounts(pool);
    res.json({ success: true, count: accounts.length, data: accounts });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to fetch cash/bank accounts');
  }
});

apiRouter.get('/accounting/workspace', requireFinanceViewer, async (_req: Request, res: Response) => {
  try {
    const pool = getRequiredPool();
    const data = await accountingService.getWorkspace(pool);
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to load Accounting & Finance workspace');
  }
});

// Chart of Accounts
apiRouter.post('/accounting/accounts', requireFinanceManager, async (req: Request, res: Response) => {
  try {
    const pool = getRequiredPool();
    const saved = await accountingService.saveAccount(pool, req.body || {}, (req as any).user);
    res.json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to save ledger account');
  }
});

apiRouter.delete('/accounting/accounts/:id', requireFinanceManager, async (req: Request, res: Response) => {
  try {
    const pool = getRequiredPool();
    await accountingService.deleteAccount(pool, req.params.id, (req as any).user);
    res.json({ success: true, message: 'Ledger account deleted.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete ledger account');
  }
});

// Journal Entries
apiRouter.post('/accounting/journals', requireFinanceManager, async (req: Request, res: Response) => {
  try {
    const pool = getRequiredPool();
    const result = await accountingService.saveJournalEntry(pool, req.body || {}, (req as any).user);
    res.json({ success: true, data: result });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to save journal entry');
  }
});

apiRouter.post('/accounting/journals/:id/post', requireFinanceManager, async (req: Request, res: Response) => {
  try {
    const pool = getRequiredPool();
    const result = await accountingService.postJournalEntry(pool, req.params.id, (req as any).user);
    res.json({ success: true, data: result });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to post journal entry');
  }
});

apiRouter.post('/accounting/journals/:id/reverse', requireFinanceManager, async (req: Request, res: Response) => {
  try {
    const pool = getRequiredPool();
    const result = await accountingService.reverseJournalEntry(pool, req.params.id, (req as any).user, req.body?.reason);
    res.json({ success: true, data: result });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to reverse journal entry');
  }
});

apiRouter.delete('/accounting/journals/:id', requireFinanceManager, async (req: Request, res: Response) => {
  try {
    const pool = getRequiredPool();
    await accountingService.deleteJournalEntry(pool, req.params.id, (req as any).user);
    res.json({ success: true, message: 'Draft journal entry deleted.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete draft journal entry');
  }
});

// Customer Receipts
apiRouter.post('/accounting/customer-receipts', requireFinanceManager, async (req: Request, res: Response) => {
  try {
    const pool = getRequiredPool();
    const result = await accountingService.recordCustomerReceipt(pool, req.body || {}, (req as any).user);
    res.status(201).json({ success: true, data: result });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to record customer receipt');
  }
});

apiRouter.put('/accounting/customer-receipts/:id', requireFinanceManager, async (req: Request, res: Response) => {
  try {
    const pool = getRequiredPool();
    const result = await accountingService.recordCustomerReceipt(pool, { ...(req.body || {}), id: req.params.id }, (req as any).user);
    res.json({ success: true, data: result });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to update customer receipt');
  }
});

apiRouter.delete('/accounting/customer-receipts/:id', requireFinanceManager, async (req: Request, res: Response) => {
  try {
    const pool = getRequiredPool();
    await accountingService.deleteCustomerReceipt(pool, req.params.id, (req as any).user);
    res.json({ success: true, message: 'Customer receipt deleted.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete customer receipt');
  }
});

// Vendor Bills & Payments
apiRouter.post('/accounting/vendor-bills', requireFinanceManager, async (req: Request, res: Response) => {
  try {
    const pool = getRequiredPool();
    const result = await accountingService.saveVendorBill(pool, req.body || {}, (req as any).user);
    res.json({ success: true, data: result });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to save vendor bill');
  }
});

apiRouter.delete('/accounting/vendor-bills/:id', requireFinanceManager, async (req: Request, res: Response) => {
  try {
    const pool = getRequiredPool();
    await accountingService.deleteVendorBill(pool, req.params.id, (req as any).user);
    res.json({ success: true, message: 'Unpaid vendor bill deleted.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete vendor bill');
  }
});

apiRouter.post('/accounting/vendor-payments', requireFinanceManager, async (req: Request, res: Response) => {
  try {
    const pool = getRequiredPool();
    const result = await accountingService.recordVendorPayment(pool, req.body || {}, (req as any).user);
    res.status(201).json({ success: true, data: result });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to record vendor payment');
  }
});

apiRouter.delete('/accounting/vendor-payments/:id', requireFinanceManager, async (req: Request, res: Response) => {
  try {
    const pool = getRequiredPool();
    await accountingService.deleteVendorPayment(pool, req.params.id, (req as any).user);
    res.json({ success: true, message: 'Vendor payment reversed and deleted.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete vendor payment');
  }
});

// Cash & Bank
apiRouter.post('/accounting/bank-accounts', requireFinanceManager, async (req: Request, res: Response) => {
  try {
    const pool = getRequiredPool();
    const result = await accountingService.saveBankAccount(pool, req.body || {}, (req as any).user);
    res.json({ success: true, data: result });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to save bank account');
  }
});

apiRouter.delete('/accounting/bank-accounts/:id', requireFinanceManager, async (req: Request, res: Response) => {
  try {
    const pool = getRequiredPool();
    await accountingService.deleteBankAccount(pool, req.params.id, (req as any).user);
    res.json({ success: true, message: 'Cash/Bank register deleted.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete cash/bank register');
  }
});

apiRouter.post('/accounting/bank-transfers', requireFinanceManager, async (req: Request, res: Response) => {
  try {
    const pool = getRequiredPool();
    const result = await accountingService.recordBankTransfer(pool, req.body || {}, (req as any).user);
    res.status(201).json({ success: true, data: result });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to record bank transfer');
  }
});

apiRouter.delete('/accounting/bank-transfers/:id', requireFinanceManager, async (req: Request, res: Response) => {
  try {
    const pool = getRequiredPool();
    await accountingService.deleteBankTransfer(pool, req.params.id, (req as any).user);
    res.json({ success: true, message: 'Contra transfer reversed and deleted.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete contra transfer');
  }
});

apiRouter.post('/accounting/bank-reconciliations', requireFinanceManager, async (req: Request, res: Response) => {
  try {
    const pool = getRequiredPool();
    const result = await accountingService.saveBankReconciliation(pool, req.body || {}, (req as any).user);
    res.json({ success: true, data: result });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to save bank reconciliation');
  }
});

apiRouter.delete('/accounting/bank-reconciliations/:id', requireFinanceManager, async (req: Request, res: Response) => {
  try {
    const pool = getRequiredPool();
    await accountingService.deleteBankReconciliation(pool, req.params.id, (req as any).user);
    res.json({ success: true, message: 'Draft bank reconciliation deleted.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete bank reconciliation');
  }
});

// Expenses & Reimbursements Workflow
apiRouter.post('/accounting/expenses', requireFinanceViewer, async (req: Request, res: Response) => {
  try {
    const pool = getRequiredPool();
    const result = await accountingService.saveExpenseWithWorkflow(pool, req.body || {}, (req as any).user);
    res.status(201).json({ success: true, data: result });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to submit expense');
  }
});

apiRouter.delete('/accounting/expenses/:id', requireFinanceManager, async (req: Request, res: Response) => {
  try {
    const pool = getRequiredPool();
    await accountingService.deleteExpense(pool, req.params.id, (req as any).user);
    res.json({ success: true, message: 'Expense deleted.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete expense');
  }
});

apiRouter.post('/accounting/expenses/:id/approve', requireFinanceManager, async (req: Request, res: Response) => {
  try {
    const pool = getRequiredPool();
    const decision = req.body?.decision === 'REJECTED' ? 'REJECTED' : 'APPROVED';
    const result = await accountingService.approveOrRejectExpense(pool, req.params.id, decision, req.body?.reason || '', (req as any).user);
    res.json({ success: true, data: result });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to update expense approval status');
  }
});

apiRouter.post('/accounting/expenses/:id/pay', requireFinanceManager, async (req: Request, res: Response) => {
  try {
    const pool = getRequiredPool();
    const result = await accountingService.payExpense(pool, req.params.id, req.body || {}, (req as any).user);
    res.json({ success: true, data: result });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to pay expense');
  }
});

// GST & TDS & E-Invoicing
apiRouter.post('/accounting/tds/:id/deposit', requireFinanceManager, async (req: Request, res: Response) => {
  try {
    const pool = getRequiredPool();
    const result = await accountingService.depositTdsEntry(pool, req.params.id, req.body || {}, (req as any).user);
    res.json({ success: true, data: result });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to record TDS deposit challan');
  }
});

apiRouter.post('/accounting/einvoice/:invoiceId/generate', requireFinanceManager, async (req: Request, res: Response) => {
  try {
    const pool = getRequiredPool();
    const result = await accountingService.generateEinvoiceIrn(pool, req.params.invoiceId, (req as any).user);
    res.json({ success: true, data: result });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to generate E-Invoice IRN');
  }
});

// Budgets
apiRouter.post('/accounting/budgets', requireFinanceManager, async (req: Request, res: Response) => {
  try {
    const pool = getRequiredPool();
    const result = await accountingService.saveBudget(pool, req.body || {}, (req as any).user);
    res.json({ success: true, data: result });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to save budget');
  }
});

apiRouter.delete('/accounting/budgets/:id', requireFinanceManager, async (req: Request, res: Response) => {
  try {
    const pool = getRequiredPool();
    await accountingService.deleteBudget(pool, req.params.id, (req as any).user);
    res.json({ success: true, message: 'Budget deleted.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete budget');
  }
});

// Fixed Assets
apiRouter.post('/accounting/assets', requireFinanceManager, async (req: Request, res: Response) => {
  try {
    const pool = getRequiredPool();
    const result = await accountingService.saveFixedAsset(pool, req.body || {}, (req as any).user);
    res.json({ success: true, data: result });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to save fixed asset');
  }
});

apiRouter.delete('/accounting/assets/:id', requireFinanceManager, async (req: Request, res: Response) => {
  try {
    const pool = getRequiredPool();
    await accountingService.deleteFixedAsset(pool, req.params.id, (req as any).user);
    res.json({ success: true, message: 'Fixed asset deleted.' });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to delete fixed asset');
  }
});

apiRouter.post('/accounting/assets/:id/depreciate', requireFinanceManager, async (req: Request, res: Response) => {
  try {
    const pool = getRequiredPool();
    const result = await accountingService.runAssetDepreciation(pool, req.params.id, req.body || {}, (req as any).user);
    res.json({ success: true, data: result });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to run asset depreciation');
  }
});

apiRouter.post('/accounting/assets/:id/dispose', requireFinanceManager, async (req: Request, res: Response) => {
  try {
    const pool = getRequiredPool();
    const result = await accountingService.disposeAsset(pool, req.params.id, req.body || {}, (req as any).user);
    res.json({ success: true, data: result });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to dispose fixed asset');
  }
});

// Settings & ERP Sync
const handleUpdateAccountingSettings = async (req: Request, res: Response) => {
  try {
    const pool = getRequiredPool();
    const result = await accountingService.updateSettings(pool, req.body || {}, (req as any).user);
    res.json({ success: true, data: result });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to update finance settings');
  }
};
apiRouter.put('/accounting/settings', requireFinanceManager, handleUpdateAccountingSettings);
apiRouter.post('/accounting/settings', requireFinanceManager, handleUpdateAccountingSettings);

apiRouter.post('/accounting/sync-erp-vouchers', requireFinanceManager, async (req: Request, res: Response) => {
  try {
    const pool = getRequiredPool();
    const result = await accountingService.syncErpVouchers(pool, (req as any).user);
    res.json({ success: true, data: result });
  } catch (err: any) {
    sendApiError(res, err, 'Failed to sync ERP vouchers into ledger');
  }
});


