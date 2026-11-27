import {
  SolarProject,
  ProjectAssignmentRole,
  ProjectUserAssignment,
  Customer,
  Lead,
  ProjectStage,
  PaymentRecord,
  ExpenseRecord,
  Employee,
  AttendanceRecord,
  Payslip,
  HolidayRecord,
  HolidayType,
  ServiceTicket,
  AMCContract,
  AppNotification,
  SystemSettings,
  SiteSurveyData,
  Quotation,
  WorkflowStageKey,
  StageStatus,
  LeadStatus,
  ProductItem,
  Vendor,
  PurchaseOrder,
  PurchaseItem,
  PurchaseLineItem,
  PurchaseDeliveryReceipt,
  DeliveryReceiptItem,
  BillOfMaterials,
  BOMItem,
  SalesInvoice,
  InvoiceLineItem,
  VendorSalesInvoice,
  SalesReturn,
  PurchaseReturn,
  StockMovement,
  Warehouse,
  StockAuditRecord,
  UserRole,
  PhotoAttachment,
  VendorBillAttachment
} from '../types/solar';
import { SystemAclConfig, AclAuditLogEntry } from '../types/acl';
import { DEFAULT_SYSTEM_ACL_CONFIG } from './aclDefaults';
import { safeStorage, safeSessionStorage } from './safeStorage';
import { apiClient } from './apiClient';
import { buildStandardWorkflowStages, WorkflowProgressLevel } from './workflowStages';
import { getCurrentSalaryMonth } from '../utils/payrollPeriods';
import {
  validateCustomer,
  validateProduct,
  validateVendor,
  validateEmployee,
  validateBOM,
  validatePurchaseOrder,
  validatePOLineItems,
  validatePOLineItem,
  assertValid,
  DuplicateRecordError
} from './validation';

export {
  DuplicateRecordError,
  validateCustomer,
  validateProduct,
  validateVendor,
  validateEmployee,
  validateBOM,
  validatePurchaseOrder,
  validatePOLineItems,
  validatePOLineItem
};

const STORAGE_KEYS = {
  LEADS: 'solar_erp_leads_v3',
  CUSTOMERS: 'solar_erp_customers_v3',
  PROJECTS: 'solar_erp_projects_v3',
  PAYMENTS: 'solar_erp_payments_v3',
  EXPENSES: 'solar_erp_expenses_v3',
  EMPLOYEES: 'solar_erp_employees_v3',
  ATTENDANCE: 'solar_erp_attendance_v3',
  PAYSLIPS: 'solar_erp_payslips_v3',
  HOLIDAYS: 'solar_erp_holidays_v3',
  SERVICE_TICKETS: 'solar_erp_service_tickets_v3',
  AMC_CONTRACTS: 'solar_erp_amc_contracts_v3',
  NOTIFICATIONS: 'solar_erp_notifications_v3',
  SETTINGS: 'solar_erp_settings_v3',
  SURVEYS: 'solar_erp_surveys_v3',
  QUOTATIONS: 'solar_erp_quotations_v3',
  PRODUCTS: 'solar_erp_products_v3',
  VENDORS: 'solar_erp_vendors_v3',
  PURCHASE_ORDERS: 'solar_erp_purchase_orders_v3',
  BOMS: 'solar_erp_boms_v3',
  SALES_INVOICES: 'solar_erp_sales_invoices_v3',
  VENDOR_SALES_INVOICES: 'solar_erp_vendor_sales_invoices_v3',
  SALES_RETURNS: 'solar_erp_sales_returns_v3',
  PURCHASE_RETURNS: 'solar_erp_purchase_returns_v3',
  STOCK_MOVEMENTS: 'solar_erp_stock_movements_v3',
  ACL_CONFIG: 'solar_erp_acl_config_v3',
  ACL_AUDIT_LOGS: 'solar_erp_acl_audit_logs_v3',
  WAREHOUSES: 'solar_erp_warehouses_v3',
  STOCK_AUDITS: 'solar_erp_stock_audits_v3',
  USERS: 'solar_erp_users_v3',
};

const initialWarehouses: Warehouse[] = [];
const initialStockAudits: StockAuditRecord[] = [];
const initialAclAuditLogs: AclAuditLogEntry[] = [];
const initialEmployees: Employee[] = [];
const initialCustomers: Customer[] = [];
const initialLeads: Lead[] = [];
const initialProjects: SolarProject[] = [];
const initialPayments: PaymentRecord[] = [];
const initialExpenses: ExpenseRecord[] = [];
const initialAttendance: AttendanceRecord[] = [];
const initialPayslips: Payslip[] = [];
const initialHolidays: HolidayRecord[] = [];
const initialServiceTickets: ServiceTicket[] = [];
const initialAMCContracts: AMCContract[] = [];
const initialNotifications: AppNotification[] = [];
const initialSurveys: SiteSurveyData[] = [];
const initialQuotations: Quotation[] = [];
const initialProducts: ProductItem[] = [];
const initialVendors: Vendor[] = [];
const initialPurchaseOrders: PurchaseOrder[] = [];
const initialBOMs: BillOfMaterials[] = [];
const initialSalesInvoices: SalesInvoice[] = [];
const initialVendorSalesInvoices: VendorSalesInvoice[] = [];
const initialSalesReturns: SalesReturn[] = [];
const initialPurchaseReturns: PurchaseReturn[] = [];
const initialStockMovements: StockMovement[] = [];

const initialSettings: SystemSettings = {
  companyName: 'Solar Urja ERP',
  companyAddress: '',
  companyPhone: '',
  companyEmail: '',
  companyGst: '',
  logoUrl: '/assets/aistudio/solar_urja_logo_07b84efe.jpeg',
  currencySymbol: '₹',
  taxRatePercent: 18,
  tallyServerUrl: (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_TALLY_SERVER_URL) ? import.meta.env.VITE_TALLY_SERVER_URL : '',
  tallyCompany: 'Solar Urja 2026-27',
  tallyStatus: 'NOT CONFIGURED',
  whatsAppStatus: 'SANDBOX_READY'
};


const KEY_TO_COLLECTION: Record<string, string> = {
  [STORAGE_KEYS.LEADS]: 'leads',
  [STORAGE_KEYS.CUSTOMERS]: 'customers',
  [STORAGE_KEYS.PROJECTS]: 'projects',
  [STORAGE_KEYS.PAYMENTS]: 'payments',
  [STORAGE_KEYS.EXPENSES]: 'expenses',
  [STORAGE_KEYS.EMPLOYEES]: 'employees',
  [STORAGE_KEYS.ATTENDANCE]: 'attendance',
  [STORAGE_KEYS.PAYSLIPS]: 'payslips',
  [STORAGE_KEYS.HOLIDAYS]: 'holidays',
  [STORAGE_KEYS.SERVICE_TICKETS]: 'service_tickets',
  [STORAGE_KEYS.AMC_CONTRACTS]: 'amc_contracts',
  [STORAGE_KEYS.NOTIFICATIONS]: 'notifications',
  [STORAGE_KEYS.SETTINGS]: 'settings',
  [STORAGE_KEYS.SURVEYS]: 'surveys',
  [STORAGE_KEYS.QUOTATIONS]: 'quotations',
  [STORAGE_KEYS.PRODUCTS]: 'products',
  [STORAGE_KEYS.VENDORS]: 'vendors',
  [STORAGE_KEYS.PURCHASE_ORDERS]: 'purchase_orders',
  [STORAGE_KEYS.BOMS]: 'boms',
  [STORAGE_KEYS.SALES_INVOICES]: 'sales_invoices',
  [STORAGE_KEYS.VENDOR_SALES_INVOICES]: 'vendor_sales_invoices',
  [STORAGE_KEYS.SALES_RETURNS]: 'sales_returns',
  [STORAGE_KEYS.PURCHASE_RETURNS]: 'purchase_returns',
  [STORAGE_KEYS.STOCK_MOVEMENTS]: 'stock_movements',
  [STORAGE_KEYS.ACL_CONFIG]: 'acl_config',
  [STORAGE_KEYS.ACL_AUDIT_LOGS]: 'acl_audit_logs',
  [STORAGE_KEYS.WAREHOUSES]: 'warehouses',
  [STORAGE_KEYS.STOCK_AUDITS]: 'stock_audits',
  [STORAGE_KEYS.USERS]: 'users'
};

const COLLECTION_TO_KEY: Record<string, string> = Object.fromEntries(
  Object.entries(KEY_TO_COLLECTION).map(([k, v]) => [v, k])
);

class StorageService {
  private memStore = new Map<string, any>();
  public isHydrated: boolean = false;
  public bootstrapStatus: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  public bootstrapError: string | null = null;
  public lastSyncError: string | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      try {
        // Purge all legacy v1/v2/v3 browser storage keys so MySQL is the sole source of truth
        const legacyKeys = [
          'solar_erp_leads', 'solar_erp_customers', 'solar_erp_projects', 'solar_erp_payments',
          'solar_erp_expenses', 'solar_erp_employees', 'solar_erp_attendance', 'solar_erp_payslips',
          'solar_erp_holidays', 'solar_erp_service_tickets', 'solar_erp_amc_contracts', 'solar_erp_notifications',
          'solar_erp_surveys', 'solar_erp_quotations', 'solar_erp_products', 'solar_erp_vendors',
          'solar_erp_purchase_orders', 'solar_erp_boms', 'solar_erp_sales_invoices', 'solar_erp_stock_movements',
          'solar_erp_warehouses', 'solar_erp_stock_audits', 'solar_erp_acl_audit_logs', 'solar_erp_settings', 'solar_erp_users',
          'solar_erp_leads_v2', 'solar_erp_customers_v2', 'solar_erp_projects_v2', 'solar_erp_payments_v2',
          'solar_erp_expenses_v2', 'solar_erp_employees_v2', 'solar_erp_attendance_v2', 'solar_erp_payslips_v2',
          'solar_erp_holidays_v2', 'solar_erp_service_tickets_v2', 'solar_erp_amc_contracts_v2', 'solar_erp_notifications_v2',
          'solar_erp_surveys_v2', 'solar_erp_quotations_v2', 'solar_erp_products_v2', 'solar_erp_vendors_v2',
          'solar_erp_purchase_orders_v2', 'solar_erp_boms_v2', 'solar_erp_sales_invoices_v2', 'solar_erp_stock_movements_v2',
          'solar_erp_warehouses_v2', 'solar_erp_stock_audits_v2', 'solar_erp_acl_audit_logs_v2', 'solar_erp_settings_v2', 'solar_erp_users_v2',
          ...Object.values(STORAGE_KEYS)
        ];
        legacyKeys.forEach(k => {
          safeStorage.removeItem(k);
          safeSessionStorage.removeItem(k);
        });
      } catch {}
    }
  }

  public clearInMemoryData(): void {
    this.memStore.clear();
    this.isHydrated = false;
    this.bootstrapStatus = 'idle';
    this.bootstrapError = null;
    this.lastSyncError = null;
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('solarpulse_storage_updated'));
    }
  }

  public async hydrateFromBackend(): Promise<void> {
    if (typeof window === 'undefined') return;
    this.bootstrapStatus = 'loading';
    this.bootstrapError = null;
    try {
      const data = await apiClient.getBootstrapData();
      Object.entries(KEY_TO_COLLECTION).forEach(([storageKey, collectionKey]) => {
        const backendItems = data[collectionKey];
        if (backendItems !== undefined && backendItems !== null) {
          if (Array.isArray(backendItems)) {
            let cleaned = backendItems.filter(Boolean);
            if (collectionKey === 'attendance') {
              cleaned = cleaned.map((a: any) => ({
                ...a,
                date: a.date || a.attendanceDate || (a.createdAt ? String(a.createdAt).slice(0, 10) : ''),
                attendanceDate: a.attendanceDate || a.date,
                checkInGPS: a.checkInGPS || a.checkInGps,
                checkInGps: a.checkInGps || a.checkInGPS,
                checkOutGPS: a.checkOutGPS || a.checkOutGps,
                checkOutGps: a.checkOutGps || a.checkOutGPS
              }));
            } else if (collectionKey === 'holidays') {
              cleaned = cleaned.map((h: any) => ({
                ...h,
                date: h.date || h.holidayDate || '',
                holidayDate: h.holidayDate || h.date || ''
              }));
            } else if (collectionKey === 'expenses') {
              cleaned = cleaned.map((e: any) => ({
                ...e,
                date: e.date || e.expenseDate || (e.createdAt ? String(e.createdAt).slice(0, 10) : ''),
                expenseDate: e.expenseDate || e.date || (e.createdAt ? String(e.createdAt).slice(0, 10) : '')
              }));
            } else if (collectionKey === 'quotations') {
              cleaned = cleaned.map((q: any) => ({
                ...q,
                quotationDate: q.quotationDate || (q.createdAt ? String(q.createdAt).slice(0, 10) : '')
              }));
            }
            this.memStore.set(storageKey, cleaned);
          } else {
            this.memStore.set(storageKey, backendItems);
          }
        }
      });
      this.isHydrated = true;
      this.bootstrapStatus = 'ready';
      this.bootstrapError = null;
      this.lastSyncError = null;
      window.dispatchEvent(new Event('solarpulse_storage_updated'));
      this.notifyEmployeesUpdated({ action: 'hydrate' });
    } catch (e: any) {
      const errMsg = e?.message || 'Failed to load data from MySQL backend';
      console.error('[Storage] Backend MySQL bootstrap failed:', errMsg);
      this.memStore.clear();
      this.isHydrated = false;
      this.bootstrapStatus = 'error';
      this.bootstrapError = errMsg;
      window.dispatchEvent(new CustomEvent('solarpulse_storage_error', { detail: { collection: 'bootstrap', error: errMsg } }));
      window.dispatchEvent(new Event('solarpulse_storage_updated'));
    }
  }

  private get<T>(key: string, defaultValue: T): T {
    if (this.memStore.has(key)) {
      const val = this.memStore.get(key);
      if (val !== undefined && val !== null) {
        if (Array.isArray(defaultValue)) {
          return (Array.isArray(val) ? val : defaultValue) as T;
        }
        return val as T;
      }
    }
    return defaultValue;
  }

  private set<T>(key: string, data: T, singleItem?: any): void {
    const hadPrevious = this.memStore.has(key);
    const previousSnapshot = this.memStore.get(key);
    this.memStore.set(key, data);
    if (typeof window !== 'undefined') {
      const collection = KEY_TO_COLLECTION[key];
      if (collection) {
        apiClient
          .syncPush(collection, singleItem ? { item: singleItem } : { items: data as any })
          .then(() => {
            this.lastSyncError = null;
            window.dispatchEvent(new Event('solarpulse_storage_updated'));
          })
          .catch((e: any) => {
            const errMsg = e?.message || `Failed to save ${collection} to MySQL`;
            console.error(`[MySQL Storage Error] Failed to persist ${collection}:`, errMsg);
            // Roll back unpersisted optimistic change immediately before rehydrating from MySQL
            if (hadPrevious) {
              this.memStore.set(key, previousSnapshot);
            } else {
              this.memStore.delete(key);
            }
            this.lastSyncError = errMsg;
            window.dispatchEvent(new CustomEvent('solarpulse_storage_error', { detail: { collection, error: errMsg } }));
            this.hydrateFromBackend();
          });
        window.dispatchEvent(new Event('solarpulse_storage_updated'));
      }
    }
  }

  private deleteSync(collection: string, id: string, rollbackSnapshot?: any[]): void {
    const key = COLLECTION_TO_KEY[collection];
    if (typeof window !== 'undefined') {
      apiClient
        .syncPush(collection, { item: { id }, action: 'delete' })
        .then(() => {
          this.lastSyncError = null;
          window.dispatchEvent(new Event('solarpulse_storage_updated'));
        })
        .catch((e: any) => {
          const errMsg = e?.message || `Failed to delete ${collection} record from MySQL`;
          console.error(`[MySQL Storage Error] Failed to delete ${collection}/${id}:`, errMsg);
          if (key && rollbackSnapshot !== undefined) {
            this.memStore.set(key, rollbackSnapshot);
          }
          this.lastSyncError = errMsg;
          window.dispatchEvent(new CustomEvent('solarpulse_storage_error', { detail: { collection, error: errMsg } }));
          this.hydrateFromBackend();
        });
      window.dispatchEvent(new Event('solarpulse_storage_updated'));
    }
  }

  private notifyStorageUpdated(): void {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('solarpulse_storage_updated'));
    }
  }

  private notifyEmployeesUpdated(detail?: Record<string, any>): void {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('solarpulse_employees_updated', { detail: detail || {} }));
    }
  }

  private removePersonnelFromMemStore(
    id: string,
    extraIdentifiers?: { authUid?: string; employeeCode?: string; email?: string }
  ): { removedIds: string[] } {
    const rawEmployees = this.get<Employee[]>(STORAGE_KEYS.EMPLOYEES, initialEmployees);
    const mergedEmployees = this.getEmployees();
    const rawUsers = this.getUsers();

    const idSet = new Set<string>();
    const emailSet = new Set<string>();

    const collectId = (val?: any) => {
      if (val !== undefined && val !== null && String(val).trim() !== '') {
        idSet.add(String(val).trim());
      }
    };
    const collectEmail = (val?: any) => {
      if (val !== undefined && val !== null && String(val).trim() !== '') {
        emailSet.add(String(val).trim().toLowerCase());
      }
    };

    collectId(id);
    if (extraIdentifiers?.authUid) collectId(extraIdentifiers.authUid);
    if (extraIdentifiers?.employeeCode) collectId(extraIdentifiers.employeeCode);
    if (extraIdentifiers?.email) collectEmail(extraIdentifiers.email);

    // First pass: find matching records across rawEmployees, mergedEmployees, and rawUsers
    const matchesAny = (rec: any): boolean => {
      if (!rec) return false;
      const recEmail = (rec.email || '').trim().toLowerCase();
      return (
        (rec.id && idSet.has(String(rec.id).trim())) ||
        (rec.authUid && idSet.has(String(rec.authUid).trim())) ||
        (rec.employeeCode && idSet.has(String(rec.employeeCode).trim())) ||
        (rec.employeeId && idSet.has(String(rec.employeeId).trim())) ||
        (recEmail !== '' && emailSet.has(recEmail))
      );
    };

    [...rawEmployees, ...mergedEmployees, ...rawUsers].forEach(rec => {
      if (matchesAny(rec)) {
        collectId(rec.id);
        collectId(rec.authUid);
        collectId(rec.employeeCode);
        collectId(rec.employeeId);
        collectEmail(rec.email);
      }
    });

    // Second pass in case linked user/employee had a different email/authUid discovered in first pass
    [...rawEmployees, ...mergedEmployees, ...rawUsers].forEach(rec => {
      if (matchesAny(rec)) {
        collectId(rec.id);
        collectId(rec.authUid);
        collectId(rec.employeeCode);
        collectId(rec.employeeId);
        collectEmail(rec.email);
      }
    });

    this.memStore.set(
      STORAGE_KEYS.EMPLOYEES,
      rawEmployees.filter(e => !matchesAny(e))
    );

    this.memStore.set(
      STORAGE_KEYS.USERS,
      rawUsers.filter(u => !matchesAny(u))
    );

    // Unassign active open/in-progress service tickets tied to deleted personnel
    const rawTickets = this.get<ServiceTicket[]>(STORAGE_KEYS.SERVICE_TICKETS, initialServiceTickets);
    if (Array.isArray(rawTickets) && rawTickets.length > 0) {
      let ticketsChanged = false;
      const updatedTickets = rawTickets.map(ticket => {
        if (!ticket) return ticket;
        const ticketStatus = String(ticket.status || '').toUpperCase();
        if (ticketStatus === 'RESOLVED' || ticketStatus === 'CLOSED' || ticketStatus === 'CANCELLED') {
          return ticket;
        }
        const techId = ticket.assignedTechnicianId ? String(ticket.assignedTechnicianId).trim() : '';
        const altId = (ticket as any).assignedToId ? String((ticket as any).assignedToId).trim() : '';
        if ((techId && idSet.has(techId)) || (altId && idSet.has(altId))) {
          ticketsChanged = true;
          return {
            ...ticket,
            assignedTechnicianId: undefined,
            assignedTechnicianName: undefined,
            assignedToId: undefined,
            assignedToName: 'Unassigned',
            status: ticketStatus === 'ASSIGNED' ? 'OPEN' : ticket.status
          } as ServiceTicket;
        }
        return ticket;
      });
      if (ticketsChanged) {
        this.memStore.set(STORAGE_KEYS.SERVICE_TICKETS, updatedTickets);
      }
    }

    return { removedIds: Array.from(idSet) };
  }

  private async confirmSyncPush<T = any>(collection: string, item: T): Promise<T> {
    const saved = await apiClient.syncPush(collection, { item });
    this.lastSyncError = null;
    if (saved && typeof saved === 'object') {
      return saved as T;
    }
    return item;
  }

  private async confirmSyncDelete(collection: string, id: string): Promise<void> {
    await apiClient.syncPush(collection, { item: { id }, action: 'delete' });
    this.lastSyncError = null;
  }

  // --- Leads ---
  getLeads(): Lead[] {
    return this.get<Lead[]>(STORAGE_KEYS.LEADS, initialLeads);
  }

  saveLead(lead: Lead): void {
    const leads = this.getLeads();
    const index = leads.findIndex(l => l.id === lead.id);
    if (index >= 0) {
      leads[index] = { ...lead, updatedAt: new Date().toISOString() };
    } else {
      leads.unshift({ ...lead, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    this.set(STORAGE_KEYS.LEADS, leads, lead);
  }

  deleteLead(id: string): void {
    const leads = this.getLeads().filter(l => l.id !== id);
    this.memStore.set(STORAGE_KEYS.LEADS, leads);
    this.deleteSync('leads', id);
  }

  async importLeads(leads: any[]): Promise<{
    success: boolean;
    total: number;
    imported: number;
    skipped: number;
    failed: number;
    importedRecords?: Lead[];
    skippedRecords?: { row: number; name: string; reason: string }[];
    failedRecords?: { row: number; reason: string }[];
    errors?: string[];
  }> {
    const result = await apiClient.importLeads(leads);
    if (result.importedRecords && result.importedRecords.length > 0) {
      await this.hydrateFromBackend();
    }
    return result;
  }

  async addLeadAsync(leadData: Partial<Lead> & { customerName: string; phone: string; [key: string]: any }): Promise<Lead> {
    const newLead: Lead = {
      id: `lead-${Date.now()}`,
      customerName: leadData.customerName,
      companyName: leadData.companyName || '',
      phone: leadData.phone,
      email: leadData.email || '',
      address: leadData.address || '',
      city: leadData.city || '',
      solarCapacityKw: Number(leadData.solarCapacityKw) || 0,
      estimatedValue: Number(leadData.estimatedValue) || 0,
      source: leadData.source || 'Direct Referral',
      assignedSalespersonId: leadData.assignedSalespersonId || leadData.assignedToId || undefined,
      assignedSalespersonName: leadData.assignedSalespersonName || leadData.assignedToName || '',
      status: (leadData.status as LeadStatus) || 'NEW',
      notes: leadData.notes || '',
      nextFollowUpDate: leadData.nextFollowUpDate ?? new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const saved = await apiClient.saveLead(newLead);
    const committed = saved && typeof saved === 'object' && saved.id ? saved : newLead;
    const leads = this.getLeads().filter(l => l.id !== committed.id);
    leads.unshift(committed);
    this.memStore.set(STORAGE_KEYS.LEADS, leads);
    this.lastSyncError = null;
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('solarpulse_storage_updated'));
    }
    return committed;
  }

  async updateLeadAsync(leadData: Lead): Promise<Lead> {
    const payload: Lead = {
      ...leadData,
      customerName: String(leadData.customerName || '').trim(),
      companyName: String(leadData.companyName || '').trim(),
      phone: String(leadData.phone || '').trim(),
      email: String(leadData.email || '').trim(),
      address: String(leadData.address || '').trim(),
      city: String(leadData.city || '').trim(),
      solarCapacityKw: Number(leadData.solarCapacityKw) || 0,
      estimatedValue: Number(leadData.estimatedValue) || 0,
      source: String(leadData.source || 'Direct Referral').trim() || 'Direct Referral',
      assignedSalespersonId: leadData.assignedSalespersonId || '',
      assignedSalespersonName: leadData.assignedSalespersonName || '',
      status: (leadData.status as LeadStatus) || 'NEW',
      notes: leadData.notes || '',
      nextFollowUpDate: leadData.nextFollowUpDate ? String(leadData.nextFollowUpDate).slice(0, 10) : '',
      updatedAt: new Date().toISOString()
    };
    const saved = await apiClient.updateLead(payload.id, payload);
    const committed: Lead = saved && typeof saved === 'object' && saved.id ? saved : payload;
    const currentLeads = this.getLeads();
    const exists = currentLeads.some(l => l.id === committed.id);
    const nextLeads = exists
      ? currentLeads.map(l => (l.id === committed.id ? committed : l))
      : [committed, ...currentLeads];
    this.memStore.set(STORAGE_KEYS.LEADS, nextLeads);
    this.lastSyncError = null;
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('solarpulse_storage_updated'));
    }
    return committed;
  }

  async deleteLeadAsync(id: string): Promise<void> {
    await apiClient.deleteLead(id);
    const leads = this.getLeads().filter(l => l.id !== id);
    this.memStore.set(STORAGE_KEYS.LEADS, leads);
    this.lastSyncError = null;
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('solarpulse_storage_updated'));
    }
  }

  addLead(leadData: Partial<Lead> & { customerName: string; phone: string; [key: string]: any }): Lead {
    const newLead: Lead = {
      id: `lead-${Date.now()}`,
      customerName: leadData.customerName,
      companyName: leadData.companyName || '',
      phone: leadData.phone,
      email: leadData.email || '',
      address: leadData.address || '',
      city: leadData.city || '',
      solarCapacityKw: Number(leadData.solarCapacityKw) || 0,
      estimatedValue: Number(leadData.estimatedValue) || 0,
      source: leadData.source || 'Direct Referral',
      assignedSalespersonId: leadData.assignedSalespersonId || leadData.assignedToId || undefined,
      assignedSalespersonName: leadData.assignedSalespersonName || leadData.assignedToName || '',
      status: (leadData.status as LeadStatus) || 'NEW',
      notes: leadData.notes || '',
      nextFollowUpDate: leadData.nextFollowUpDate || new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.saveLead(newLead);
    return newLead;
  }

  // Convert Lead to Customer & Project
  convertLeadToCustomerAndProject(
    leadId: string,
    convertedByName?: string,
    role?: string
  ): { customer: Customer; project: SolarProject } {
    const lead = this.getLeads().find(l => l.id === leadId);
    if (!lead) {
      throw new Error('Selected lead record was not found in MySQL.');
    }

    // Pre-validate customer uniqueness before modifying lead or creating project
    const customerValidation = validateCustomer(
      {
        name: lead.customerName,
        companyName: lead.companyName,
        phone: lead.phone,
        email: lead.email,
        city: lead.city
      },
      this.getCustomers()
    );
    assertValid(customerValidation);

    const customerId = `cust-${Date.now()}`;
    const projectId = `proj-${Date.now()}`;

    const newCustomer: Customer = {
      id: customerId,
      name: lead.customerName,
      companyName: lead.companyName || lead.customerName,
      customerType: 'Commercial',
      phone: lead.phone,
      email: lead.email,
      siteAddress: lead.address,
      city: lead.city,
      state: 'Gujarat',
      pincode: '380001',
      status: 'ACTIVE',
      activeProjectId: projectId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const newProject: SolarProject = {
      id: projectId,
      projectCode: `SOL-${new Date().getFullYear()}-${Math.floor(100 + Math.random() * 900)}`,
      customerId: customerId,
      customerName: newCustomer.name,
      title: `${lead.solarCapacityKw} kW Rooftop Solar Project`,
      capacityKw: lead.solarCapacityKw,
      totalValue: lead.estimatedValue || lead.solarCapacityKw * 50000,
      status: 'SURVEY',
      currentStageKey: 'site_survey',
      completionPercentage: 0,
      progressPercentage: 0,
      location: lead.city,
      assignedUsers: [
        {
          id: `asgn-${Date.now()}-lead`,
          projectId: projectId,
          userId: 'usr-admin',
          userName: convertedByName || 'System Admin',
          employeeCode: 'ADM-001',
          role: 'Sales Executive',
          department: 'Sales',
          assignedAt: new Date().toISOString(),
          assignedBy: convertedByName || 'System Admin',
          notes: 'Lead conversion and client account coordination',
          isActive: true
        }
      ],
      siteAddress: lead.address,
      city: lead.city,
      startDate: new Date().toISOString().split('T')[0],
      expectedCompletionDate: new Date(Date.now() + 45 * 86400000).toISOString().split('T')[0],
      stages: buildStandardWorkflowStages(projectId, lead.solarCapacityKw, 'NEW'),
      notes: `Converted from Lead ID: ${lead.id}${convertedByName ? ` by ${convertedByName} (${role || 'Sales'})` : ''}. ${lead.notes}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Update lead status to WON
    this.saveLead({ ...lead, status: 'WON' });
    this.saveCustomer(newCustomer);
    this.saveProject(newProject);

    this.addNotification({
      title: 'Lead Converted to Active Project',
      message: `${lead.customerName} converted into Customer & Project ${newProject.projectCode} (${lead.solarCapacityKw} kW). Stage 1 (Site Survey) is active.`,
      type: 'SUCCESS',
      linkType: 'PROJECT',
      linkId: projectId,
      customerId: customerId,
      projectId: projectId,
      projectName: newProject.title
    });

    return { customer: newCustomer, project: newProject };
  }

  // Create new Customer and Solar Project with strictly initialized Stage 1
  createCustomerAndProject(customerData: {
    name: string;
    companyName?: string;
    customerType?: 'Residential' | 'Commercial' | 'Industrial';
    phone: string;
    email?: string;
    password?: string;
    siteAddress?: string;
    city?: string;
    capacityKw?: number;
    estimatedValue?: number;
  }, createdByName: string = 'System Admin', role: string = 'Admin'): { customer: Customer; project: SolarProject } {
    // Pre-validate customer uniqueness
    const customerValidation = validateCustomer(
      {
        name: customerData.name,
        companyName: customerData.companyName,
        phone: customerData.phone,
        email: customerData.email,
        city: customerData.city
      },
      this.getCustomers()
    );
    assertValid(customerValidation);

    const customerId = `cust-${Date.now()}`;
    const projectId = `proj-${Date.now()}`;
    const capacityKw = Number(customerData.capacityKw) || 10;
    const estimatedValue = Number(customerData.estimatedValue) || capacityKw * 50000;

    const newCustomer: Customer = {
      id: customerId,
      name: customerData.name,
      companyName: customerData.companyName || customerData.name,
      customerType: customerData.customerType || 'Commercial',
      phone: customerData.phone,
      email: customerData.email || '',
      password: customerData.password || `Cust@${Date.now().toString().slice(-6)}`,
      siteAddress: customerData.siteAddress || '',
      city: customerData.city || 'Ahmedabad',
      state: 'Gujarat',
      pincode: '380001',
      status: 'ACTIVE',
      activeProjectId: projectId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const newProject: SolarProject = {
      id: projectId,
      projectCode: `SOL-${new Date().getFullYear()}-${Math.floor(100 + Math.random() * 900)}`,
      customerId: customerId,
      customerName: newCustomer.name,
      title: `${capacityKw} kW Rooftop Solar Project`,
      capacityKw: capacityKw,
      totalValue: estimatedValue,
      status: 'SURVEY',
      currentStageKey: 'site_survey',
      completionPercentage: 0,
      progressPercentage: 0,
      location: customerData.city || 'Ahmedabad',
      assignedUsers: [],
      siteAddress: customerData.siteAddress || '',
      city: customerData.city || 'Ahmedabad',
      startDate: new Date().toISOString().split('T')[0],
      expectedCompletionDate: new Date(Date.now() + 45 * 86400000).toISOString().split('T')[0],
      stages: buildStandardWorkflowStages(projectId, capacityKw, 'NEW'),
      notes: `Created by ${createdByName} (${role}). Initialized at Stage 1: Site Survey.`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.saveCustomer(newCustomer);
    this.saveProject(newProject);

    this.addNotification({
      title: 'New Solar Project Initialized',
      message: `Project ${newProject.projectCode} (${capacityKw} kW) created for ${newCustomer.name}. Stage 1 (Site Survey) is active.`,
      type: 'SUCCESS',
      linkType: 'PROJECT',
      linkId: projectId,
      customerId: customerId,
      projectId: projectId,
      projectName: newProject.title
    });

    return { customer: newCustomer, project: newProject };
  }

  // --- Customers ---
  getCustomers(): Customer[] {
    return this.get<Customer[]>(STORAGE_KEYS.CUSTOMERS, initialCustomers);
  }

  saveCustomer(customer: Customer): void {
    const customers = this.getCustomers();
    const validation = validateCustomer(customer, customers, customer.id);
    assertValid(validation);

    const index = customers.findIndex(c => c.id === customer.id);
    if (index >= 0) {
      customers[index] = { ...customer, updatedAt: new Date().toISOString() };
    } else {
      customers.unshift({ ...customer, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    this.set(STORAGE_KEYS.CUSTOMERS, customers, customer);
  }

  deleteCustomer(id: string): void {
    const customers = this.getCustomers().filter(c => c.id !== id);
    this.memStore.set(STORAGE_KEYS.CUSTOMERS, customers);
    this.deleteSync('customers', id);
  }

  async importCustomers(customers: any[]): Promise<{
    success: boolean;
    total: number;
    imported: number;
    skipped: number;
    failed: number;
    importedRecords?: Customer[];
    skippedRecords?: { row: number; name: string; reason: string }[];
    failedRecords?: { row: number; reason: string }[];
    errors?: string[];
  }> {
    const res = await fetch(`${apiClient.getBaseUrl()}/customers/import`, {
      method: 'POST',
      headers: apiClient.getAuthHeaders({ 'Content-Type': 'application/json' }),
      credentials: 'include',
      body: JSON.stringify({ customers })
    });
    let result: any = {};
    try {
      result = await res.json();
    } catch {
      throw new Error(`Server returned HTTP ${res.status} (${res.statusText}).`);
    }
    if (!res.ok || result.success === false) {
      throw new Error(result.error || result.message || `Customer import failed with status ${res.status}`);
    }

    if (result.importedRecords && result.importedRecords.length > 0) {
      const current = this.getCustomers();
      const existingIds = new Set(current.map(c => c.id));
      const newlyAdded: Customer[] = result.importedRecords.filter((r: any) => !existingIds.has(r.id));
      const updatedList = [...newlyAdded, ...current];
      this.memStore.set(STORAGE_KEYS.CUSTOMERS, updatedList);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('solarpulse_storage_updated'));
      }
    }

    return result;
  }

  async updateCustomerPassword(customerId: string, newPassword: string): Promise<boolean> {
    await apiClient.updateCustomerPassword(customerId, newPassword);
    await this.hydrateFromBackend();
    return true;
  }

  // --- Projects & Workflow Automation ---
  getProjects(): SolarProject[] {
    const rawProjects = this.get<SolarProject[]>(STORAGE_KEYS.PROJECTS, initialProjects);
    let mutated = false;

    const list = Array.isArray(rawProjects) ? rawProjects : initialProjects;

    // Self-healing integrity check:
    // A stage N cannot be COMPLETED/APPROVED unless all previous stages 0..N-1 are COMPLETED/APPROVED.
    // Ensure newly initialized projects never have stages 2..16 completed.
    const sanitized = list.map(project => {
      if (!project || typeof project !== 'object') return null;

      let hasIncompletePriorStage = false;
      let stagesChanged = false;

      // Ensure stages array exists and is hydrated
      if (!project.stages || !Array.isArray(project.stages) || project.stages.length === 0) {
        if ((project as any).stages_json) {
          try {
            const rawJson = (project as any).stages_json;
            const parsed = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
            if (Array.isArray(parsed) && parsed.length > 0) {
              project.stages = parsed;
            }
          } catch {}
        }
        if (!project.stages || !Array.isArray(project.stages) || project.stages.length === 0) {
          const progressLevel: WorkflowProgressLevel = project.status === 'COMPLETED' ? 'COMPLETED' : 'NEW';
          project.stages = buildStandardWorkflowStages(project.id, project.capacityKw || 10, progressLevel);
          mutated = true;
        }
      }

      // Self-healing migration for multi-user project assignments:
      if (!project.assignedUsers || !Array.isArray(project.assignedUsers) || project.assignedUsers.length === 0) {
        const defaultMatch = undefined;
        if (defaultMatch?.assignedUsers && defaultMatch.assignedUsers.length > 0) {
          project.assignedUsers = JSON.parse(JSON.stringify(defaultMatch.assignedUsers));
          mutated = true;
        } else if (!project.assignedUsers) {
          project.assignedUsers = [];
          mutated = true;
        }
      }

      // Ensure administrative/finance assignments are cleaned up from project specialist lists
      if (project.assignedUsers && Array.isArray(project.assignedUsers)) {
        const beforeLen = project.assignedUsers.length;
        project.assignedUsers = project.assignedUsers.filter(
          a => a && a.role !== 'Accountant' && a.department !== 'Finance'
        );
        if (project.assignedUsers.length !== beforeLen) {
          mutated = true;
        }
      }

      const stagesList = Array.isArray(project.stages) ? project.stages : [];
      const cleanedStages = stagesList.map((stage, idx) => {
        if (!stage) return stage;
        stage.checklist = Array.isArray(stage.checklist) ? stage.checklist : [];
        stage.photos = Array.isArray(stage.photos) ? stage.photos : [];
        stage.documents = Array.isArray(stage.documents) ? stage.documents : [];
        stage.activities = Array.isArray(stage.activities) ? stage.activities : [];

        if (idx === 0) {
          if (stage.status !== 'COMPLETED' && stage.status !== 'APPROVED') {
            hasIncompletePriorStage = true;
          }
          return stage;
        }

        if (hasIncompletePriorStage) {
          if (stage.status === 'COMPLETED' || stage.status === 'APPROVED') {
            stagesChanged = true;
            return {
              ...stage,
              status: 'NOT STARTED' as StageStatus,
              actualEndDate: undefined,
              completedDate: undefined,
              approvedBy: undefined,
              approvalDate: undefined,
              checklist: stage.checklist.map(c => ({
                ...c,
                completed: false,
                completedAt: undefined,
                completedBy: undefined
              }))
            };
          }
        }

        if (stage.status !== 'COMPLETED' && stage.status !== 'APPROVED') {
          hasIncompletePriorStage = true;
        }

        return stage;
      });

      if (stagesChanged) {
        mutated = true;
        const completedCount = cleanedStages.filter(s => s && (s.status === 'COMPLETED' || s.status === 'APPROVED')).length;
        const completionPercentage = cleanedStages.length > 0 ? Math.round((completedCount / cleanedStages.length) * 100) : 0;
        return {
          ...project,
          stages: cleanedStages,
          completionPercentage,
          progressPercentage: completionPercentage
        };
      }

      return {
        ...project,
        stages: cleanedStages
      };
    }).filter(Boolean) as SolarProject[];

    if (mutated) {
      this.memStore.set(STORAGE_KEYS.PROJECTS, sanitized);
    }

    return sanitized;
  }

  getProjectById(id: string): SolarProject | undefined {
    return this.getProjects().find(p => p.id === id);
  }

  saveProject(project: SolarProject): void {
    const projects = this.getProjects();
    const index = projects.findIndex(p => p.id === project.id);
    if (index >= 0) {
      projects[index] = { ...project, updatedAt: new Date().toISOString() };
    } else {
      projects.unshift({ ...project, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    this.set(STORAGE_KEYS.PROJECTS, projects, project);
  }

  setProjectsFromBackend(projects: SolarProject[]): void {
    if (!Array.isArray(projects)) return;
    this.memStore.set(STORAGE_KEYS.PROJECTS, projects);
    window.dispatchEvent(new Event('solarpulse_storage_updated'));
  }

  applyControlCenterSyncResult(result: {
    project?: SolarProject | null;
    customer?: Customer | null;
    payments?: PaymentRecord[];
  }): void {
    if (result?.project) {
      const projects = this.getProjects();
      const idx = projects.findIndex(p => p.id === result.project!.id);
      if (idx >= 0) {
        projects[idx] = result.project;
      } else {
        projects.unshift(result.project);
      }
      this.memStore.set(STORAGE_KEYS.PROJECTS, projects);
    }
    if (result?.customer) {
      const customers = this.getCustomers();
      const idx = customers.findIndex(c => c.id === result.customer!.id);
      if (idx >= 0) {
        customers[idx] = result.customer;
      } else {
        customers.unshift(result.customer);
      }
      this.memStore.set(STORAGE_KEYS.CUSTOMERS, customers);
    }
    if (Array.isArray(result?.payments)) {
      this.memStore.set(STORAGE_KEYS.PAYMENTS, result.payments);
    }
    this.lastSyncError = null;
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('solarpulse_storage_updated'));
    }
  }

  async updateProjectSpecsAsync(
    projectId: string,
    payload: { capacityKw: number; totalValue: number }
  ): Promise<{ project: SolarProject | null; customer: Customer | null; payments: PaymentRecord[] }> {
    const result = await apiClient.updateProjectControlCenter(projectId, payload);
    this.applyControlCenterSyncResult(result);
    return result;
  }

  async updateControlCenterDetailsAsync(
    projectId: string,
    payload: {
      totalValue?: number;
      receivedInflow?: number;
      city?: string;
      siteAddress?: string;
      location?: string;
      capacityKw?: number;
    }
  ): Promise<{ project: SolarProject | null; customer: Customer | null; payments: PaymentRecord[] }> {
    const result = await apiClient.updateProjectControlCenter(projectId, payload);
    this.applyControlCenterSyncResult(result);
    return result;
  }

  deleteProject(id: string): void {
    const projects = this.getProjects().filter(p => p.id !== id);
    this.memStore.set(STORAGE_KEYS.PROJECTS, projects);
    this.deleteSync('projects', id);
  }

  async importProjects(projects: any[]): Promise<{
    success: boolean;
    total: number;
    imported: number;
    skipped: number;
    failed: number;
    importedRecords?: SolarProject[];
    skippedRecords?: { row: number; name: string; reason: string }[];
    failedRecords?: { row: number; reason: string }[];
    errors?: string[];
  }> {
    const res = await fetch(`${apiClient.getBaseUrl()}/projects/import`, {
      method: 'POST',
      headers: apiClient.getAuthHeaders({ 'Content-Type': 'application/json' }),
      credentials: 'include',
      body: JSON.stringify({ projects })
    });
    let result: any = {};
    try {
      result = await res.json();
    } catch {
      throw new Error(`Server returned HTTP ${res.status} (${res.statusText}).`);
    }
    if (!res.ok || result.success === false) {
      throw new Error(result.error || result.message || `Project import failed with status ${res.status}`);
    }

    if (result.importedRecords && result.importedRecords.length > 0) {
      const current = this.getProjects();
      const existingIds = new Set(current.map(p => p.id));
      const newlyAdded: SolarProject[] = result.importedRecords.filter((r: any) => !existingIds.has(r.id));
      const updatedList = [...newlyAdded, ...current];
      this.memStore.set(STORAGE_KEYS.PROJECTS, updatedList);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('solarpulse_storage_updated'));
      }
    }

    return result;
  }

  // --- Multi-User Project Assignments ---
  getProjectAssignments(projectId: string): ProjectUserAssignment[] {
    const project = this.getProjectById(projectId);
    return project?.assignedUsers || [];
  }

  assignUserToProject(
    projectId: string,
    assignmentData: {
      userId: string;
      userName: string;
      userEmail?: string;
      employeeCode?: string;
      role: ProjectAssignmentRole;
      department: string;
      notes?: string;
      autoSyncStages?: boolean;
    },
    assignedByName: string = 'Admin'
  ): ProjectUserAssignment {
    const projects = this.getProjects();
    const projectIndex = projects.findIndex(p => p.id === projectId);
    if (projectIndex === -1) {
      throw new Error(`Project with ID ${projectId} not found.`);
    }

    // Explicitly validate role is an eligible project specialist role
    if (
      assignmentData.role === 'Accountant' ||
      (assignmentData.role as string) === 'Admin' ||
      (assignmentData.role as string) === 'HR Manager' ||
      (assignmentData.role as string) === 'Customer'
    ) {
      throw new Error(`Role "${assignmentData.role}" is not eligible for project specialist assignment. Only field, technical, service, or sales coordination specialists may be assigned.`);
    }

    // Explicitly validate that employee is not an excluded user (Admin, Accountant, HR Manager, Customer)
    const emp = this.getEmployees().find(e => e.id === assignmentData.userId);
    if (emp) {
      const desig = (emp.designation || '').toLowerCase().trim();
      const dept = (emp.department || '').toLowerCase().trim();
      if (
        desig.includes('director') ||
        desig === 'admin' ||
        desig.includes('admin ') ||
        desig.includes(' admin') ||
        desig.includes('administrator') ||
        desig.includes('accountant') ||
        desig.includes('finance') ||
        desig.includes('tally') ||
        desig.includes('hr manager') ||
        desig.includes('human resource') ||
        desig.includes('hr & admin') ||
        desig.includes('customer') ||
        desig.includes('client') ||
        dept === 'management' ||
        dept === 'finance' ||
        dept === 'hr' ||
        dept === 'customer' ||
        dept === 'administration' ||
        (dept === 'operations' && desig.includes('manager'))
      ) {
        throw new Error(`Cannot assign administrative or finance staff (${emp.name} - ${emp.designation}) as a project specialist.`);
      }
    }

    const project = projects[projectIndex];
    project.assignedUsers = project.assignedUsers || [];

    const newAssignment: ProjectUserAssignment = {
      id: `asgn-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      projectId,
      userId: assignmentData.userId,
      userName: assignmentData.userName,
      userEmail: assignmentData.userEmail || '',
      employeeCode: assignmentData.employeeCode || '',
      role: assignmentData.role,
      department: assignmentData.department || 'Operations',
      assignedAt: new Date().toISOString(),
      assignedBy: assignedByName,
      notes: assignmentData.notes || '',
      isActive: true
    };

    project.assignedUsers.push(newAssignment);

    // Sync matching stages if autoSync is true (default true)
    if (assignmentData.autoSyncStages !== false) {
      project.stages = project.stages.map(stg => {
        const matchesRole =
          stg.assignedRole === assignmentData.role ||
          (assignmentData.role === 'Site Survey Engineer' && (stg.stageKey === 'site_survey' || stg.assignedRole === 'Site Survey Engineer')) ||
          (assignmentData.role === 'Civil Team' && (stg.stageKey === 'civil_work' || stg.assignedRole === 'Civil Team')) ||
          (assignmentData.role === 'Structure Team' && (stg.stageKey === 'structure_fabrication' || stg.assignedRole === 'Structure Team')) ||
          (assignmentData.role === 'Installation Team' && (stg.stageKey === 'solar_installation' || stg.assignedRole === 'Installation Team')) ||
          (assignmentData.role === 'Electrical Team' && (stg.stageKey === 'ac_side_electrical' || stg.assignedRole === 'Electrical Team')) ||
          (assignmentData.role === 'Technician' && (stg.stageKey === 'final_verification' || stg.assignedRole === 'Technician')) ||
          (assignmentData.role === 'Service Manager' && (stg.stageKey === 'service_amc' || stg.assignedRole === 'Service Manager'));

        if (matchesRole) {
          return {
            ...stg,
            assignedEmployeeId: assignmentData.userId,
            assignedEmployeeName: assignmentData.userName,
            assignedToName: assignmentData.userName,
            assignedToId: assignmentData.userId
          };
        }
        return stg;
      });
    }

    project.updatedAt = new Date().toISOString();
    projects[projectIndex] = project;
    this.set(STORAGE_KEYS.PROJECTS, projects, project);

    this.addNotification({
      title: 'Project Specialist Assigned',
      message: `${assignmentData.userName} assigned as ${assignmentData.role} to ${project.title} (${project.projectCode}).`,
      type: 'INFO',
      linkType: 'PROJECT',
      linkId: projectId,
      projectId: projectId,
      projectName: project.title
    });

    return newAssignment;
  }

  async assignUserToProjectAsync(
    projectId: string,
    assignmentData: {
      userId: string;
      userName: string;
      userEmail?: string;
      employeeCode?: string;
      role: ProjectAssignmentRole;
      department: string;
      notes?: string;
      autoSyncStages?: boolean;
    },
    assignedByName: string = 'Admin'
  ): Promise<ProjectUserAssignment> {
    const projects = this.getProjects();
    const projectIndex = projects.findIndex(p => p.id === projectId);
    if (projectIndex === -1) {
      throw new Error(`Project with ID ${projectId} not found.`);
    }

    if (
      assignmentData.role === 'Accountant' ||
      (assignmentData.role as string) === 'Admin' ||
      (assignmentData.role as string) === 'HR Manager' ||
      (assignmentData.role as string) === 'Customer'
    ) {
      throw new Error(`Role "${assignmentData.role}" is not eligible for project specialist assignment. Only field, technical, service, or sales coordination specialists may be assigned.`);
    }

    const emp = this.getEmployees().find(e => e.id === assignmentData.userId);
    if (emp) {
      const desig = (emp.designation || '').toLowerCase().trim();
      const dept = (emp.department || '').toLowerCase().trim();
      if (
        desig.includes('director') ||
        desig === 'admin' ||
        desig.includes('admin ') ||
        desig.includes(' admin') ||
        desig.includes('administrator') ||
        desig.includes('accountant') ||
        desig.includes('finance') ||
        desig.includes('tally') ||
        desig.includes('hr manager') ||
        desig.includes('human resource') ||
        desig.includes('hr & admin') ||
        desig.includes('customer') ||
        desig.includes('client') ||
        dept === 'management' ||
        dept === 'finance' ||
        dept === 'hr' ||
        dept === 'customer' ||
        dept === 'administration' ||
        (dept === 'operations' && desig.includes('manager'))
      ) {
        throw new Error(`Cannot assign administrative or finance staff (${emp.name} - ${emp.designation}) as a project specialist.`);
      }
    }

    const baseProject = projects[projectIndex];
    const newAssignment: ProjectUserAssignment = {
      id: `asgn-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      projectId,
      userId: assignmentData.userId,
      userName: assignmentData.userName,
      userEmail: assignmentData.userEmail || '',
      employeeCode: assignmentData.employeeCode || '',
      role: assignmentData.role,
      department: assignmentData.department || 'Operations',
      assignedAt: new Date().toISOString(),
      assignedBy: assignedByName,
      notes: assignmentData.notes || '',
      isActive: true
    };

    const nextAssignedUsers = [...(baseProject.assignedUsers || []), newAssignment];
    const nextStages =
      assignmentData.autoSyncStages !== false
        ? baseProject.stages.map(stg => {
            const matchesRole =
              stg.assignedRole === assignmentData.role ||
              (assignmentData.role === 'Site Survey Engineer' && (stg.stageKey === 'site_survey' || stg.assignedRole === 'Site Survey Engineer')) ||
              (assignmentData.role === 'Civil Team' && (stg.stageKey === 'civil_work' || stg.assignedRole === 'Civil Team')) ||
              (assignmentData.role === 'Structure Team' && (stg.stageKey === 'structure_fabrication' || stg.assignedRole === 'Structure Team')) ||
              (assignmentData.role === 'Installation Team' && (stg.stageKey === 'solar_installation' || stg.assignedRole === 'Installation Team')) ||
              (assignmentData.role === 'Electrical Team' && (stg.stageKey === 'ac_side_electrical' || stg.assignedRole === 'Electrical Team')) ||
              (assignmentData.role === 'Technician' && (stg.stageKey === 'final_verification' || stg.assignedRole === 'Technician')) ||
              (assignmentData.role === 'Service Manager' && (stg.stageKey === 'service_amc' || stg.assignedRole === 'Service Manager'));

            if (matchesRole) {
              return {
                ...stg,
                assignedEmployeeId: assignmentData.userId,
                assignedEmployeeName: assignmentData.userName,
                assignedToName: assignmentData.userName,
                assignedToId: assignmentData.userId
              };
            }
            return stg;
          })
        : baseProject.stages;

    const updatedProject: SolarProject = {
      ...baseProject,
      assignedUsers: nextAssignedUsers,
      stages: nextStages,
      updatedAt: new Date().toISOString()
    };

    const committed = await this.confirmSyncPush('projects', updatedProject);
    const nextProjects = [...this.getProjects()];
    const idx = nextProjects.findIndex(p => p.id === updatedProject.id);
    if (idx >= 0) nextProjects[idx] = committed?.id ? committed : updatedProject;
    this.memStore.set(STORAGE_KEYS.PROJECTS, nextProjects);
    this.notifyStorageUpdated();

    this.addNotification({
      title: 'Project Specialist Assigned',
      message: `${assignmentData.userName} assigned as ${assignmentData.role} to ${baseProject.title} (${baseProject.projectCode}).`,
      type: 'INFO',
      linkType: 'PROJECT',
      linkId: projectId,
      projectId: projectId,
      projectName: baseProject.title
    });

    return newAssignment;
  }

  updateProjectUserAssignment(
    projectId: string,
    assignmentId: string,
    updates: Partial<ProjectUserAssignment>,
    autoSyncStages: boolean = true
  ): boolean {
    const projects = this.getProjects();
    const projectIndex = projects.findIndex(p => p.id === projectId);
    if (projectIndex === -1) return false;

    const project = projects[projectIndex];
    if (!project.assignedUsers) return false;

    const asgnIndex = project.assignedUsers.findIndex(a => a.id === assignmentId);
    if (asgnIndex === -1) return false;

    if (updates.role === 'Accountant' || (updates.role as string) === 'Admin' || (updates.role as string) === 'HR Manager' || (updates.role as string) === 'Customer') {
      throw new Error(`Role "${updates.role}" is not an eligible project specialist role.`);
    }

    const existing = project.assignedUsers[asgnIndex];
    const updated: ProjectUserAssignment = {
      ...existing,
      ...updates
    };

    project.assignedUsers[asgnIndex] = updated;

    if (autoSyncStages && updated.isActive) {
      project.stages = project.stages.map(stg => {
        if (stg.assignedRole === updated.role) {
          return {
            ...stg,
            assignedEmployeeId: updated.userId,
            assignedEmployeeName: updated.userName,
            assignedToName: updated.userName,
            assignedToId: updated.userId
          };
        }
        return stg;
      });
    }

    project.updatedAt = new Date().toISOString();
    projects[projectIndex] = project;
    this.set(STORAGE_KEYS.PROJECTS, projects, project);
    return true;
  }

  async updateProjectUserAssignmentAsync(
    projectId: string,
    assignmentId: string,
    updates: Partial<ProjectUserAssignment>,
    autoSyncStages: boolean = true
  ): Promise<boolean> {
    const projects = this.getProjects();
    const projectIndex = projects.findIndex(p => p.id === projectId);
    if (projectIndex === -1) return false;

    const baseProject = projects[projectIndex];
    if (!baseProject.assignedUsers) return false;

    const asgnIndex = baseProject.assignedUsers.findIndex(a => a.id === assignmentId);
    if (asgnIndex === -1) return false;

    if (updates.role === 'Accountant' || (updates.role as string) === 'Admin' || (updates.role as string) === 'HR Manager' || (updates.role as string) === 'Customer') {
      throw new Error(`Role "${updates.role}" is not an eligible project specialist role.`);
    }

    const existing = baseProject.assignedUsers[asgnIndex];
    const updatedAsgn: ProjectUserAssignment = { ...existing, ...updates };
    const nextAssignedUsers = baseProject.assignedUsers.map((a, i) => (i === asgnIndex ? updatedAsgn : a));
    const nextStages =
      autoSyncStages && updatedAsgn.isActive
        ? baseProject.stages.map(stg => {
            if (stg.assignedRole === updatedAsgn.role) {
              return {
                ...stg,
                assignedEmployeeId: updatedAsgn.userId,
                assignedEmployeeName: updatedAsgn.userName,
                assignedToName: updatedAsgn.userName,
                assignedToId: updatedAsgn.userId
              };
            }
            return stg;
          })
        : baseProject.stages;

    const updatedProject: SolarProject = {
      ...baseProject,
      assignedUsers: nextAssignedUsers,
      stages: nextStages,
      updatedAt: new Date().toISOString()
    };

    const committed = await this.confirmSyncPush('projects', updatedProject);
    const nextProjects = [...this.getProjects()];
    const idx = nextProjects.findIndex(p => p.id === updatedProject.id);
    if (idx >= 0) nextProjects[idx] = committed?.id ? committed : updatedProject;
    this.memStore.set(STORAGE_KEYS.PROJECTS, nextProjects);
    this.notifyStorageUpdated();
    return true;
  }

  removeUserFromProject(projectId: string, assignmentId: string): boolean {
    const projects = this.getProjects();
    const projectIndex = projects.findIndex(p => p.id === projectId);
    if (projectIndex === -1) return false;

    const project = projects[projectIndex];
    if (!project.assignedUsers) return false;

    const removed = project.assignedUsers.find(a => a.id === assignmentId);
    project.assignedUsers = project.assignedUsers.filter(a => a.id !== assignmentId);
    project.updatedAt = new Date().toISOString();

    projects[projectIndex] = project;
    this.set(STORAGE_KEYS.PROJECTS, projects);

    if (removed) {
      this.addNotification({
        title: 'Project Specialist Removed',
        message: `${removed.userName} removed from ${removed.role} role in ${project.title}.`,
        type: 'WARNING',
        linkType: 'PROJECT',
        linkId: projectId,
        projectId: projectId,
        projectName: project.title
      });
    }

    return true;
  }

  // Update a single stage within a project with automatic advancement logic
  updateProjectStage(
    projectId: string,
    stageIdOrKey: string,
    updates: Partial<ProjectStage>,
    actorName: string,
    actorRole: string
  ): SolarProject | null {
    const project = this.getProjectById(projectId);
    if (!project) return null;

    // Role-based protection: Customers have read-only access to project stages
    const normalizedRole = (actorRole || '').toUpperCase();
    if (normalizedRole === 'CUSTOMER' || normalizedRole === 'CLIENT') {
      console.warn(`[Access Denied] Customer "${actorName}" attempted to modify stage "${stageIdOrKey}".`);
      return project;
    }

    const stageIndex = project.stages.findIndex(s => s.id === stageIdOrKey || s.stageKey === stageIdOrKey);
    if (stageIndex === -1) return null;

    const currentStage = project.stages[stageIndex];

    // STRICT SEQUENTIAL ENFORCEMENT:
    // A stage cannot be marked COMPLETED or APPROVED if any prior stage is incomplete
    if (updates.status === 'COMPLETED' || updates.status === 'APPROVED') {
      for (let i = 0; i < stageIndex; i++) {
        const priorStage = project.stages[i];
        if (priorStage.status !== 'COMPLETED' && priorStage.status !== 'APPROVED') {
          console.warn(`Cannot complete stage "${currentStage.title}": Prior stage "${priorStage.title}" is not finished.`);
          return project;
        }
      }
    }

    const updatedStage: ProjectStage = {
      ...currentStage,
      ...updates
    };

    // If an action took place, log activity
    if (updates.status && updates.status !== currentStage.status) {
      updatedStage.activities = [
        ...(updatedStage.activities || []),
        {
          id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          timestamp: new Date().toLocaleString(),
          user: actorName,
          role: actorRole,
          action: `Stage status changed from ${currentStage.status} to ${updates.status}`,
          details: updates.comments
        }
      ];
    }

    project.stages[stageIndex] = updatedStage;

    // BUSINESS LOGIC: AUTOMATIC SEQUENTIAL ADVANCEMENT
    // If a stage is marked COMPLETED or APPROVED, unlock ONLY the immediate next stage!
    if (
      (updates.status === 'COMPLETED' || updates.status === 'APPROVED') &&
      stageIndex + 1 < project.stages.length
    ) {
      const nextStage = project.stages[stageIndex + 1];
      if (nextStage.status === 'NOT STARTED') {
        nextStage.status = 'IN PROGRESS';
        nextStage.startDate = new Date().toISOString().split('T')[0];
        nextStage.dueDate = new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0];
        nextStage.activities = [
          ...(nextStage.activities || []),
          {
            id: `act-${Date.now()}-auto-${Math.random().toString(36).slice(2, 7)}`,
            timestamp: new Date().toLocaleString(),
            user: 'System Workflow Engine',
            role: 'Automation',
            action: `Automatically unlocked next stage: "${nextStage.title}" because previous stage "${updatedStage.title}" was completed.`
          }
        ];
        project.currentStageKey = nextStage.stageKey;

        // Notification
        this.addNotification({
          title: `Next Stage Unlocked: ${nextStage.title}`,
          message: `Stage "${updatedStage.title}" completed. "${nextStage.title}" is now active for ${project.customerName}.`,
          type: 'SUCCESS',
          linkType: 'PROJECT',
          linkId: project.id
        });
      }
    }

    // IF A STAGE IS REOPENED TO 'IN PROGRESS':
    // Subsequent stages (stageIndex + 1 onwards) must be reset back to NOT STARTED
    if (updates.status === 'IN PROGRESS') {
      project.currentStageKey = currentStage.stageKey;
      for (let j = stageIndex + 1; j < project.stages.length; j++) {
        if (project.stages[j].status === 'IN PROGRESS' || project.stages[j].status === 'COMPLETED' || project.stages[j].status === 'APPROVED') {
          project.stages[j].status = 'NOT STARTED';
          project.stages[j].actualEndDate = undefined;
          project.stages[j].completedDate = undefined;
          project.stages[j].approvedBy = undefined;
          project.stages[j].approvalDate = undefined;
        }
      }
    }

    // Recalculate Project Completion Percentage dynamically based on completed stages
    const totalStages = project.stages.length;
    const completedStages = project.stages.filter(s => s.status === 'COMPLETED' || s.status === 'APPROVED').length;
    project.completionPercentage = Math.round((completedStages / totalStages) * 100);
    project.progressPercentage = project.completionPercentage;

    // Project high-level status progression
    if (completedStages === totalStages) {
      project.status = 'COMPLETED';
      project.actualCompletionDate = new Date().toISOString().split('T')[0];
    } else if (project.stages.some(s => s.status === 'OVERDUE' || s.status === 'BLOCKED')) {
      project.status = 'DELAYED';
    } else if (completedStages === 0) {
      project.status = 'SURVEY';
    } else if (completedStages < 4) {
      project.status = 'DESIGN & APPROVALS';
    } else if (completedStages < 10) {
      project.status = 'CIVIL & STRUCTURE';
    } else {
      project.status = 'INSTALLATION';
    }

    this.saveProject(project);

    if (typeof window !== 'undefined') {
      apiClient.request(`${apiClient.getBaseUrl()}/projects/${encodeURIComponent(projectId)}/stages/${encodeURIComponent(stageIdOrKey)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      }).then(async res => {
        if (!res.ok) {
          let errMsg = `Stage update failed (HTTP ${res.status})`;
          try {
            const errJson = await res.json();
            errMsg = errJson?.error || errJson?.message || errMsg;
          } catch {}
          console.warn('[Backend Stage Sync Error]:', errMsg);
          window.dispatchEvent(new CustomEvent('solarpulse_storage_error', { detail: { message: errMsg } }));
        }
      }).catch(err => console.warn('[Backend Stage Sync]:', err));
    }

    return project;
  }

  applyStagePhotosUpdate(
    projectId: string,
    stageIdOrKey: string,
    photos: PhotoAttachment[]
  ): SolarProject | null {
    const projects = this.getProjects();
    const projIdx = projects.findIndex(p => p.id === projectId);
    if (projIdx === -1) return null;

    const project = { ...projects[projIdx] };
    const stages = [...(project.stages || [])];
    const stageIdx = stages.findIndex(s => s.id === stageIdOrKey || s.stageKey === stageIdOrKey);
    if (stageIdx === -1) return null;

    stages[stageIdx] = {
      ...stages[stageIdx],
      photos: Array.isArray(photos) ? photos : []
    };
    project.stages = stages;

    const nextProjects = [...projects];
    nextProjects[projIdx] = project;
    this.memStore.set(STORAGE_KEYS.PROJECTS, nextProjects);
    this.notifyStorageUpdated();
    return project;
  }

  // Toggle checklist item within a stage
  toggleChecklistItem(
    projectId: string,
    stageIdOrKey: string,
    checkItemId: string,
    actorName: string,
    actorRole: string
  ): SolarProject | null {
    const project = this.getProjectById(projectId);
    if (!project) return null;

    // Role-based protection: Customers have read-only access to checklists
    const normalizedRole = (actorRole || '').toUpperCase();
    if (normalizedRole === 'CUSTOMER' || normalizedRole === 'CLIENT') {
      console.warn(`[Access Denied] Customer "${actorName}" attempted to toggle checklist "${checkItemId}".`);
      return project;
    }

    const stage = project.stages.find(s => s.id === stageIdOrKey || s.stageKey === stageIdOrKey);
    if (!stage) return null;

    const item = stage.checklist.find(c => c.id === checkItemId);
    if (!item) return null;

    item.completed = !item.completed;
    item.completedAt = item.completed ? new Date().toISOString() : undefined;
    item.completedBy = item.completed ? actorName : undefined;

    stage.activities = stage.activities || [];
    stage.activities.push({
      id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toLocaleString(),
      user: actorName,
      role: actorRole,
      action: `${item.completed ? 'Checked' : 'Unchecked'} task: "${item.title}"`
    });

    // Note: Stage completion is NOT triggered automatically by checklist toggles.
    // It requires explicit user approval / completion with validation.
    this.saveProject(project);
    return project;
  }

  // --- Payments & Invoices ---
  getPayments(): PaymentRecord[] {
    return this.get<PaymentRecord[]>(STORAGE_KEYS.PAYMENTS, initialPayments);
  }

  savePayment(payment: PaymentRecord): void {
    const payments = this.getPayments();
    const index = payments.findIndex(p => p.id === payment.id);
    if (index >= 0) {
      payments[index] = payment;
    } else {
      payments.unshift(payment);
    }
    this.set(STORAGE_KEYS.PAYMENTS, payments, payment);
  }

  async savePaymentAsync(payment: PaymentRecord): Promise<PaymentRecord> {
    const committed = await this.confirmSyncPush('payments', payment);
    const saved = committed?.id ? committed : payment;
    const payments = [...this.getPayments()];
    const index = payments.findIndex(p => p.id === saved.id);
    if (index >= 0) {
      payments[index] = saved;
    } else {
      payments.unshift(saved);
    }
    this.memStore.set(STORAGE_KEYS.PAYMENTS, payments);
    this.notifyStorageUpdated();
    return saved;
  }

  deletePayment(id: string): void {
    const snapshot = [...this.getPayments()];
    const payments = snapshot.filter(p => p.id !== id);
    this.memStore.set(STORAGE_KEYS.PAYMENTS, payments);
    this.deleteSync('payments', id, snapshot);
  }

  async deletePaymentAsync(id: string): Promise<void> {
    await this.confirmSyncDelete('payments', id);
    const payments = this.getPayments().filter(p => p.id !== id);
    this.memStore.set(STORAGE_KEYS.PAYMENTS, payments);
    this.notifyStorageUpdated();
  }

  async importPayments(payments: any[]): Promise<{
    success: boolean;
    total: number;
    imported: number;
    skipped: number;
    failed: number;
    importedRecords?: PaymentRecord[];
    skippedRecords?: { row: number; name: string; reason: string }[];
    failedRecords?: { row: number; reason: string }[];
    errors?: string[];
  }> {
    const result = await apiClient.importPayments(payments);
    if (result.importedRecords && result.importedRecords.length > 0) {
      await this.hydrateFromBackend();
    }
    return result;
  }

  // --- Expenses ---
  getExpenses(): ExpenseRecord[] {
    const list = this.get<ExpenseRecord[]>(STORAGE_KEYS.EXPENSES, initialExpenses);
    const safeList = Array.isArray(list) ? list : initialExpenses;
    return safeList.filter(Boolean).map((e: any) => {
      const normalizedDate = e.date || e.expenseDate || (e.createdAt ? String(e.createdAt).slice(0, 10) : new Date().toISOString().slice(0, 10));
      return {
        ...e,
        date: normalizedDate,
        expenseDate: e.expenseDate || normalizedDate
      };
    });
  }

  saveExpense(expense: ExpenseRecord): void {
    const normalized: ExpenseRecord = {
      ...expense,
      date: expense.date || (expense as any).expenseDate || new Date().toISOString().slice(0, 10),
      ...( { expenseDate: (expense as any).expenseDate || expense.date || new Date().toISOString().slice(0, 10) } as any )
    };
    const expenses = this.getExpenses();
    const index = expenses.findIndex(e => e.id === normalized.id);
    if (index >= 0) {
      expenses[index] = normalized;
    } else {
      expenses.unshift(normalized);
    }
    this.set(STORAGE_KEYS.EXPENSES, expenses, normalized);
  }

  async saveExpenseAsync(expense: ExpenseRecord): Promise<ExpenseRecord> {
    const normalized: ExpenseRecord = {
      ...expense,
      date: expense.date || (expense as any).expenseDate || new Date().toISOString().slice(0, 10),
      ...( { expenseDate: (expense as any).expenseDate || expense.date || new Date().toISOString().slice(0, 10) } as any )
    };
    const committed = await this.confirmSyncPush('expenses', normalized);
    const saved = committed?.id
      ? {
          ...committed,
          date: committed.date || (committed as any).expenseDate || normalized.date,
          expenseDate: (committed as any).expenseDate || committed.date || normalized.date
        }
      : normalized;
    const expenses = [...this.getExpenses()];
    const index = expenses.findIndex(e => e.id === saved.id);
    if (index >= 0) {
      expenses[index] = saved;
    } else {
      expenses.unshift(saved);
    }
    this.memStore.set(STORAGE_KEYS.EXPENSES, expenses);
    this.notifyStorageUpdated();
    return saved;
  }

  deleteExpense(id: string): void {
    const snapshot = [...this.getExpenses()];
    const expenses = snapshot.filter(e => e.id !== id);
    this.memStore.set(STORAGE_KEYS.EXPENSES, expenses);
    this.deleteSync('expenses', id, snapshot);
  }

  async deleteExpenseAsync(id: string): Promise<void> {
    await this.confirmSyncDelete('expenses', id);
    const expenses = this.getExpenses().filter(e => e.id !== id);
    this.memStore.set(STORAGE_KEYS.EXPENSES, expenses);
    this.notifyStorageUpdated();
  }

  async importExpenses(expenses: any[]): Promise<{
    success: boolean;
    total: number;
    imported: number;
    skipped: number;
    failed: number;
    importedRecords?: ExpenseRecord[];
    skippedRecords?: { row: number; name: string; reason: string }[];
    failedRecords?: { row: number; reason: string }[];
    errors?: string[];
  }> {
    const result = await apiClient.importExpenses(expenses);
    if (result.importedRecords && result.importedRecords.length > 0) {
      await this.hydrateFromBackend();
    }
    return result;
  }

  // --- Employees & HRMS ---
  getEmployees(): Employee[] {
    const list = this.get<Employee[]>(STORAGE_KEYS.EMPLOYEES, initialEmployees);
    const safeList = Array.isArray(list) ? list : initialEmployees;

    const employeeMap = new Map<string, Employee>();

    safeList.filter(Boolean).forEach(emp => {
      const authUid = emp.authUid || emp.id;
      const salaryMonthly = Number(emp.salaryMonthly ?? (emp as any).salary_monthly ?? (emp as any).salary) || 0;
      const safeEmp: Employee = {
        ...emp,
        name: emp.name || 'Employee',
        employeeCode: emp.employeeCode || emp.id || 'EMP-001',
        department: emp.department || 'Operations',
        designation: emp.designation || 'Staff',
        salaryMonthly,
        esicNumber: emp.esicNumber ?? (emp as any).esic_number ?? '',
        bankAccountNumber: emp.bankAccountNumber ?? (emp as any).bank_account_number ?? '',
        bankName: emp.bankName ?? (emp as any).bank_name ?? '',
        ifscCode: emp.ifscCode ?? (emp as any).ifsc_code ?? '',
        emergencyContactPerson: emp.emergencyContactPerson ?? (emp as any).emergency_contact_person ?? '',
        emergencyContactNumber: emp.emergencyContactNumber ?? (emp as any).emergency_contact_number ?? '',
        authUid,
        loginEnabled: typeof emp.loginEnabled === 'boolean' ? emp.loginEnabled : true,
        systemRole: emp.systemRole || emp.assignedRole || 'Project Manager',
        accountStatus: (emp.status === 'TERMINATED' ? 'DISABLED' : (emp.accountStatus || 'ACTIVE')) as Employee['accountStatus']
      };
      employeeMap.set(safeEmp.id, safeEmp);
      if (safeEmp.email) employeeMap.set(safeEmp.email.toLowerCase(), safeEmp);
    });

    // Merge in users from STORAGE_KEYS.USERS who are staff members (not Customer)
    const users = this.get<any[]>(STORAGE_KEYS.USERS, []);
    (users || []).filter(Boolean).forEach(u => {
      if (u.role === 'Customer') return;
      const uEmail = (u.email || '').toLowerCase().trim();
      const existingByEmail = uEmail ? employeeMap.get(uEmail) : null;
      const existingById = employeeMap.get(u.id);
      if (!existingByEmail && !existingById) {
        const isFw = Boolean(u.isFieldWorker || [
          'Site Survey Engineer', 'Site Inspector', 'Civil Team',
          'Structure Team', 'Installation Team', 'Electrical Team', 'Technician'
        ].includes(u.role));
        const syntheticEmp: Employee = {
          id: u.id,
          employeeCode: u.employeeId || u.employeeCode || `EMP-${u.id.slice(-4).toUpperCase()}`,
          name: u.name || 'Staff Member',
          email: u.email,
          phone: u.phone || '+91 98250 11223',
          department: u.department || 'Operations',
          designation: u.designation || u.role || 'Solar Specialist',
          systemRole: u.role || 'Project Manager',
          salaryMonthly: 0,
          esicNumber: '',
          bankAccountNumber: '',
          bankName: '',
          ifscCode: '',
          emergencyContactPerson: '',
          emergencyContactNumber: '',
          status: (u.status === 'INACTIVE' || u.status === 'DISABLED') ? 'INACTIVE' : 'ACTIVE',
          accountStatus: (u.status === 'INACTIVE' || u.status === 'DISABLED') ? 'DISABLED' : 'ACTIVE',
          loginEnabled: u.status !== 'DISABLED',
          isFieldWorker: isFw,
          currentSiteLocation: '',
          joiningDate: u.createdAt ? String(u.createdAt).slice(0, 10) : new Date().toISOString().slice(0, 10)
        };
        employeeMap.set(u.id, syntheticEmp);
        if (uEmail) employeeMap.set(uEmail, syntheticEmp);
      }
    });

    const result: Employee[] = [];
    const seenIds = new Set<string>();
    employeeMap.forEach(emp => {
      if (!seenIds.has(emp.id)) {
        seenIds.add(emp.id);
        result.push(emp);
      }
    });
    return result;
  }

  saveEmployee(emp: Employee): void {
    const employees = this.getEmployees();
    const validation = validateEmployee(emp, employees, emp.id);
    assertValid(validation);

    const index = employees.findIndex(e => e.id === emp.id);
    if (index >= 0) {
      employees[index] = emp;
    } else {
      employees.unshift(emp);
    }
    this.set(STORAGE_KEYS.EMPLOYEES, employees, emp);
  }

  async saveEmployeeAsync(emp: Employee): Promise<Employee> {
    const employees = this.getEmployees();
    const validation = validateEmployee(emp, employees, emp.id);
    assertValid(validation);

    const committed = await this.confirmSyncPush('employees', emp);
    const saved = committed?.id ? committed : emp;
    const rawEmployees = [...this.get<Employee[]>(STORAGE_KEYS.EMPLOYEES, initialEmployees)];
    const index = rawEmployees.findIndex(e => e.id === saved.id);
    if (index >= 0) {
      rawEmployees[index] = { ...rawEmployees[index], ...saved };
    } else {
      rawEmployees.unshift(saved);
    }
    this.memStore.set(STORAGE_KEYS.EMPLOYEES, rawEmployees);

    // Keep linked user record in memory synchronized for User Management, RBAC & Field Operations
    const users = [...this.getUsers()];
    const empEmail = (saved.email || '').trim().toLowerCase();
    const uIdx = users.findIndex(
      u => u && (u.id === saved.id || (empEmail && (u.email || '').trim().toLowerCase() === empEmail))
    );
    if (uIdx >= 0) {
      users[uIdx] = {
        ...users[uIdx],
        name: saved.name,
        email: saved.email || users[uIdx].email,
        phone: saved.phone || users[uIdx].phone,
        department: saved.department || users[uIdx].department,
        designation: saved.designation || users[uIdx].designation,
        role: saved.systemRole || saved.assignedRole || users[uIdx].role,
        isFieldWorker: saved.isFieldWorker,
        status: saved.accountStatus === 'DISABLED' || saved.status === 'TERMINATED' ? 'DISABLED' : saved.status || users[uIdx].status,
        active: saved.loginEnabled !== false && saved.accountStatus !== 'DISABLED' && saved.status !== 'TERMINATED'
      };
      this.memStore.set(STORAGE_KEYS.USERS, users);
    }

    this.notifyStorageUpdated();
    this.notifyEmployeesUpdated({ action: 'upsert', employeeId: saved.id });
    return saved;
  }

  saveEmployees(employees: Employee[]): void {
    this.set(STORAGE_KEYS.EMPLOYEES, employees);
  }

  deleteEmployee(id: string): void {
    const snapshot = [...this.get<Employee[]>(STORAGE_KEYS.EMPLOYEES, initialEmployees)];
    const employees = snapshot.filter(e => e.id !== id);
    this.memStore.set(STORAGE_KEYS.EMPLOYEES, employees);
    this.deleteSync('employees', id, snapshot);
  }

  async deleteEmployeeAsync(id: string): Promise<void> {
    const targetEmp = this.getEmployees().find(
      e => e.id === id || e.authUid === id || e.employeeCode === id
    );
    const targetUser = this.getUsers().find(
      u => u && (u.id === id || u.authUid === id || u.employeeId === id)
    );

    try {
      await apiClient.deleteEmployee(id);
      this.lastSyncError = null;
    } catch (err: any) {
      const msg = String(err?.message || '');
      const isRouteMissing =
        msg.includes('API endpoint not found') ||
        msg.includes('Cannot DELETE') ||
        msg.includes('HTTP 405');
      if (isRouteMissing) {
        await this.confirmSyncDelete('employees', id);
      } else {
        throw err;
      }
    }

    const { removedIds } = this.removePersonnelFromMemStore(id, {
      authUid: targetEmp?.authUid,
      employeeCode: targetEmp?.employeeCode,
      email: targetEmp?.email || targetUser?.email
    });

    this.notifyStorageUpdated();
    this.notifyEmployeesUpdated({ action: 'delete', deletedId: id, removedIds });
  }

  async importEmployees(employees: any[]): Promise<{
    success: boolean;
    total: number;
    imported: number;
    skipped: number;
    failed: number;
    importedRecords?: Employee[];
    skippedRecords?: { row: number; name: string; reason: string }[];
    failedRecords?: { row: number; reason: string }[];
    errors?: string[];
  }> {
    const result = await apiClient.importEmployees(employees);
    if (result.importedRecords && result.importedRecords.length > 0) {
      await this.hydrateFromBackend();
    }
    return result;
  }

  // --- Users & Credentials ---
  getUsers(): any[] {
    return this.get<any[]>(STORAGE_KEYS.USERS, []);
  }

  saveUser(user: any): void {
    const users = this.getUsers();
    const index = users.findIndex(u => u.id === user.id || (user.email && u.email?.toLowerCase() === user.email?.toLowerCase()));
    if (index >= 0) {
      users[index] = { ...users[index], ...user, updatedAt: new Date().toISOString() };
    } else {
      users.unshift({ ...user, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    this.set(STORAGE_KEYS.USERS, users, user);
  }

  deleteUser(id: string): void {
    const snapshot = [...this.getUsers()];
    const users = snapshot.filter(u => u.id !== id);
    this.memStore.set(STORAGE_KEYS.USERS, users);
    this.deleteSync('users', id, snapshot);
  }

  async deleteUserAsync(id: string): Promise<void> {
    const targetUser = this.getUsers().find(
      u => u && (u.id === id || u.authUid === id || u.employeeId === id)
    );
    const targetEmp = this.getEmployees().find(
      e => e.id === id || e.authUid === id || e.employeeCode === id
    );

    await apiClient.deleteUser(id);
    this.lastSyncError = null;

    const { removedIds } = this.removePersonnelFromMemStore(id, {
      authUid: targetEmp?.authUid,
      employeeCode: targetEmp?.employeeCode,
      email: targetUser?.email || targetEmp?.email
    });

    this.notifyStorageUpdated();
    this.notifyEmployeesUpdated({ action: 'delete', deletedId: id, removedIds });
  }

  // --- Attendance ---
  getAttendance(): AttendanceRecord[] {
    const list = this.get<AttendanceRecord[]>(STORAGE_KEYS.ATTENDANCE, initialAttendance);
    const safeList = Array.isArray(list) ? list : initialAttendance;
    return safeList.filter(Boolean).map((a: any) => ({
      ...a,
      date: a.date || a.attendanceDate || (a.createdAt ? String(a.createdAt).slice(0, 10) : new Date().toISOString().slice(0, 10)),
      attendanceDate: a.attendanceDate || a.date,
      checkInGPS: a.checkInGPS || a.checkInGps,
      checkInGps: a.checkInGps || a.checkInGPS,
      checkOutGPS: a.checkOutGPS || a.checkOutGps,
      checkOutGps: a.checkOutGps || a.checkOutGPS
    }));
  }

  saveAttendanceRecord(record: AttendanceRecord): void {
    const attendance = this.getAttendance();
    const index = attendance.findIndex(a => a.id === record.id);
    if (index >= 0) {
      attendance[index] = record;
    } else {
      attendance.unshift(record);
    }
    this.set(STORAGE_KEYS.ATTENDANCE, attendance, record);
  }

  async saveAttendanceRecordAsync(record: AttendanceRecord): Promise<AttendanceRecord> {
    const payload: any = {
      ...record,
      attendanceDate: (record as any).attendanceDate || record.date,
      date: record.date || (record as any).attendanceDate,
      checkInGPS: (record as any).checkInGPS || (record as any).checkInGps,
      checkInGps: (record as any).checkInGps || (record as any).checkInGPS,
      checkOutGPS: (record as any).checkOutGPS || (record as any).checkOutGps,
      checkOutGps: (record as any).checkOutGps || (record as any).checkOutGPS
    };
    const committed = await this.confirmSyncPush('attendance', payload);
    const savedRaw: any = committed?.id ? committed : payload;
    const saved: AttendanceRecord = {
      ...savedRaw,
      date: savedRaw.date || savedRaw.attendanceDate || payload.date,
      attendanceDate: savedRaw.attendanceDate || savedRaw.date || payload.attendanceDate,
      checkInGPS: savedRaw.checkInGPS || savedRaw.checkInGps || payload.checkInGPS,
      checkInGps: savedRaw.checkInGps || savedRaw.checkInGPS || payload.checkInGps,
      checkOutGPS: savedRaw.checkOutGPS || savedRaw.checkOutGps || payload.checkOutGPS,
      checkOutGps: savedRaw.checkOutGps || savedRaw.checkOutGPS || payload.checkOutGps
    };
    const attendance = [...this.getAttendance()];
    const index = attendance.findIndex(a => a.id === saved.id);
    if (index >= 0) {
      attendance[index] = saved;
    } else {
      attendance.unshift(saved);
    }
    this.memStore.set(STORAGE_KEYS.ATTENDANCE, attendance);
    this.notifyStorageUpdated();
    return saved;
  }

  async updateFuelApprovalAsync(
    attendanceId: string,
    approvalStatus: 'APPROVED' | 'REJECTED' | 'PENDING',
    reviewedBy: string,
    notes?: string
  ): Promise<AttendanceRecord> {
    const updated = await apiClient.updateFuelApproval(attendanceId, approvalStatus, reviewedBy, notes);
    const existingList = [...this.getAttendance()];
    const idx = existingList.findIndex(a => a.id === attendanceId);
    const fallbackUpdated = idx >= 0
      ? {
          ...existingList[idx],
          fuelExpense: existingList[idx].fuelExpense
            ? {
                ...existingList[idx].fuelExpense!,
                approvalStatus,
                approvedBy: reviewedBy,
                approvedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                approvalNotes: notes ?? existingList[idx].fuelExpense!.approvalNotes
              }
            : undefined
        }
      : undefined;

    const committedRaw: any = updated && updated.id ? updated : fallbackUpdated;
    if (committedRaw && committedRaw.id) {
      const committed: AttendanceRecord = {
        ...committedRaw,
        date: committedRaw.date || committedRaw.attendanceDate,
        attendanceDate: committedRaw.attendanceDate || committedRaw.date
      };
      if (idx >= 0) existingList[idx] = committed;
      else existingList.unshift(committed);
      this.memStore.set(STORAGE_KEYS.ATTENDANCE, existingList);
      this.lastSyncError = null;
      this.notifyStorageUpdated();
      return committed;
    }
    throw new Error('Attendance record not found after fuel approval update.');
  }

  recordAttendance(record: AttendanceRecord): void {
    this.saveAttendanceRecord(record);
  }

  deleteAttendanceRecord(id: string): void {
    const snapshot = [...this.getAttendance()];
    const attendance = snapshot.filter(a => a.id !== id);
    this.memStore.set(STORAGE_KEYS.ATTENDANCE, attendance);
    this.deleteSync('attendance', id, snapshot);
  }

  async deleteAttendanceRecordAsync(id: string): Promise<void> {
    await this.confirmSyncDelete('attendance', id);
    const attendance = this.getAttendance().filter(a => a.id !== id);
    this.memStore.set(STORAGE_KEYS.ATTENDANCE, attendance);
    this.notifyStorageUpdated();
  }

  async importAttendance(attendance: any[]): Promise<{
    success: boolean;
    total: number;
    imported: number;
    skipped: number;
    failed: number;
    importedRecords?: AttendanceRecord[];
    skippedRecords?: { row: number; name: string; reason: string }[];
    failedRecords?: { row: number; reason: string }[];
    errors?: string[];
  }> {
    const result = await apiClient.importAttendance(attendance);
    if (result.importedRecords && result.importedRecords.length > 0) {
      await this.hydrateFromBackend();
    }
    return result;
  }

  // --- Payroll / Payslips ---
  getPayslips(): Payslip[] {
    const list = this.get<Payslip[]>(STORAGE_KEYS.PAYSLIPS, initialPayslips);
    const safeList = Array.isArray(list) ? list : initialPayslips;
    return safeList.filter(Boolean).map(p => {
      const baseSalary = Number((p as any).baseSalary ?? (p as any).basicSalary ?? (p as any).basic_salary) || 0;
      const overtimeAmount = Number((p as any).overtimeAmount ?? (p as any).allowances) || 0;
      const totalAdditionalExpenses = Number((p as any).totalAdditionalExpenses) || 0;
      const deductionsArr = Array.isArray(p.deductions) ? p.deductions : [];
      const totalDeductions = Number((p as any).totalDeductions ?? (typeof (p as any).deductions === 'number' ? (p as any).deductions : 0)) || 0;
      const grossEarnings = Number((p as any).grossEarnings ?? (baseSalary + overtimeAmount + totalAdditionalExpenses)) || 0;
      const netPay = Number((p as any).netPay ?? (p as any).netSalary ?? (p as any).net_salary ?? (grossEarnings - totalDeductions)) || 0;

      return {
        ...p,
        payslipNumber: p.payslipNumber || p.id || 'PS-001',
        employeeId: p.employeeId || '',
        employeeCode: p.employeeCode || '',
        employeeName: p.employeeName || 'Employee',
        department: p.department || 'Operations',
        designation: p.designation || 'Specialist',
        month: p.month || getCurrentSalaryMonth(),
        generatedDate: p.generatedDate || new Date().toISOString().slice(0, 10),
        baseSalary,
        overtimeType: p.overtimeType || 'DIRECT',
        overtimeHours: p.overtimeHours ?? 0,
        overtimeRatePerHour: p.overtimeRatePerHour ?? 0,
        overtimeAmount,
        additionalExpenses: Array.isArray(p.additionalExpenses) ? p.additionalExpenses : [],
        totalAdditionalExpenses,
        deductions: deductionsArr,
        totalDeductions,
        grossEarnings,
        netPay,
        status: (p.status as any) || ((p as any).paymentStatus === 'PAID' ? 'PAID' : 'GENERATED')
      };
    });
  }

  savePayslip(payslip: Payslip): void {
    const payslips = this.getPayslips();
    const index = payslips.findIndex(p => p.id === payslip.id);
    if (index >= 0) {
      payslips[index] = payslip;
    } else {
      payslips.unshift(payslip);
    }
    this.set(STORAGE_KEYS.PAYSLIPS, payslips, payslip);
  }

  async savePayslipAsync(payslip: Payslip): Promise<Payslip> {
    const committed = await this.confirmSyncPush('payslips', payslip);
    const saved = committed?.id ? committed : payslip;
    const payslips = [...this.getPayslips()];
    const index = payslips.findIndex(p => p.id === saved.id);
    if (index >= 0) {
      payslips[index] = saved;
    } else {
      payslips.unshift(saved);
    }
    this.memStore.set(STORAGE_KEYS.PAYSLIPS, payslips);
    this.notifyStorageUpdated();
    return saved;
  }

  deletePayslip(id: string): void {
    const snapshot = [...this.getPayslips()];
    const payslips = snapshot.filter(p => p.id !== id);
    this.memStore.set(STORAGE_KEYS.PAYSLIPS, payslips);
    this.deleteSync('payslips', id, snapshot);
  }

  async deletePayslipAsync(id: string): Promise<void> {
    await this.confirmSyncDelete('payslips', id);
    const payslips = this.getPayslips().filter(p => p.id !== id);
    this.memStore.set(STORAGE_KEYS.PAYSLIPS, payslips);
    this.notifyStorageUpdated();
  }

  // --- Holidays ---
  getHolidays(): HolidayRecord[] {
    const list = this.get<HolidayRecord[]>(STORAGE_KEYS.HOLIDAYS, initialHolidays);
    const safeList = Array.isArray(list) ? list : initialHolidays;
    return safeList.filter(Boolean).map((h: any) => {
      const hDate = h.date || h.holidayDate || '';
      return {
        ...h,
        date: hDate,
        holidayDate: h.holidayDate || hDate
      };
    });
  }

  saveHoliday(holiday: HolidayRecord): void {
    const normalized: any = {
      ...holiday,
      date: holiday.date || (holiday as any).holidayDate || '',
      holidayDate: (holiday as any).holidayDate || holiday.date || ''
    };
    const holidays = this.getHolidays();
    const index = holidays.findIndex(h => h.id === normalized.id);
    if (index >= 0) {
      holidays[index] = normalized;
    } else {
      holidays.push(normalized);
    }
    // Sort by date ascending
    holidays.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    this.set(STORAGE_KEYS.HOLIDAYS, holidays, normalized);
  }

  async saveHolidayAsync(holiday: HolidayRecord): Promise<HolidayRecord> {
    const payload: any = {
      ...holiday,
      date: holiday.date || (holiday as any).holidayDate || '',
      holidayDate: (holiday as any).holidayDate || holiday.date || ''
    };
    const committed = await this.confirmSyncPush('holidays', payload);
    const savedRaw: any = committed?.id ? committed : payload;
    const saved: HolidayRecord = {
      ...savedRaw,
      date: savedRaw.date || savedRaw.holidayDate || payload.date,
      holidayDate: savedRaw.holidayDate || savedRaw.date || payload.holidayDate
    } as HolidayRecord;
    const holidays = [...this.getHolidays()];
    const index = holidays.findIndex(h => h.id === saved.id);
    if (index >= 0) {
      holidays[index] = saved;
    } else {
      holidays.push(saved);
    }
    holidays.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    this.memStore.set(STORAGE_KEYS.HOLIDAYS, holidays);
    this.notifyStorageUpdated();
    return saved;
  }

  deleteHoliday(id: string): void {
    const snapshot = [...this.getHolidays()];
    const holidays = snapshot.filter(h => h.id !== id);
    this.memStore.set(STORAGE_KEYS.HOLIDAYS, holidays);
    this.deleteSync('holidays', id, snapshot);
  }

  async deleteHolidayAsync(id: string): Promise<void> {
    await this.confirmSyncDelete('holidays', id);
    const holidays = this.getHolidays().filter(h => h.id !== id);
    this.memStore.set(STORAGE_KEYS.HOLIDAYS, holidays);
    this.notifyStorageUpdated();
  }

  resetStandardHolidays(): void {
    this.set(STORAGE_KEYS.HOLIDAYS, initialHolidays);
  }

  async resetStandardHolidaysAsync(): Promise<void> {
    await apiClient.syncPush('holidays', { items: initialHolidays });
    this.lastSyncError = null;
    this.memStore.set(STORAGE_KEYS.HOLIDAYS, [...initialHolidays]);
    this.notifyStorageUpdated();
  }

  // --- Service & AMC ---
  getServiceTickets(): ServiceTicket[] {
    return this.get<ServiceTicket[]>(STORAGE_KEYS.SERVICE_TICKETS, initialServiceTickets);
  }

  setServiceTicketsFromBackend(tickets: ServiceTicket[], notify: boolean = true): void {
    const cleaned = Array.isArray(tickets) ? tickets.filter(Boolean) : [];
    this.memStore.set(STORAGE_KEYS.SERVICE_TICKETS, cleaned);
    this.lastSyncError = null;
    if (notify) {
      this.notifyStorageUpdated();
    }
  }

  upsertServiceTicketInMemory(ticket: ServiceTicket): void {
    if (!ticket || !ticket.id) return;
    const existing = this.getServiceTickets();
    const idx = existing.findIndex(t => t.id === ticket.id);
    const updatedList = [...existing];
    if (idx >= 0) {
      updatedList[idx] = { ...updatedList[idx], ...ticket };
    } else {
      updatedList.unshift(ticket);
    }
    this.memStore.set(STORAGE_KEYS.SERVICE_TICKETS, updatedList);
    this.lastSyncError = null;
    this.notifyStorageUpdated();
  }

  async createServiceTicketAsync(ticket: Partial<ServiceTicket>): Promise<ServiceTicket> {
    const saved = await apiClient.saveServiceTicket(ticket);
    if (saved && saved.id) {
      this.upsertServiceTicketInMemory(saved);
      return saved;
    }
    const tickets = await apiClient.getServiceTickets();
    this.setServiceTicketsFromBackend(tickets);
    return saved;
  }

  async assignServiceTicketAsync(
    ticketId: string,
    payload: { technicianId: string | null; scheduledDate?: string | null; remarks?: string | null }
  ): Promise<ServiceTicket> {
    const updated = await apiClient.assignServiceTicketTechnician(ticketId, payload);
    if (updated && updated.id) {
      this.upsertServiceTicketInMemory(updated);
    }
    return updated;
  }

  async adminUpdateServiceTicketAsync(
    ticketId: string,
    payload: {
      status?: string;
      priority?: string;
      assignedTechnicianId?: string | null;
      scheduledDate?: string | null;
      technicianRemarks?: string;
      resolutionDetails?: string;
      notes?: string;
      resolvedDate?: string | null;
    }
  ): Promise<ServiceTicket> {
    const updated = await apiClient.adminUpdateServiceTicket(ticketId, payload);
    if (updated && updated.id) {
      this.upsertServiceTicketInMemory(updated);
    }
    return updated;
  }

  saveServiceTicket(ticket: ServiceTicket): void {
    const tickets = this.getServiceTickets();
    const index = tickets.findIndex(t => t.id === ticket.id);
    if (index >= 0) {
      tickets[index] = ticket;
    } else {
      tickets.unshift(ticket);
    }
    this.set(STORAGE_KEYS.SERVICE_TICKETS, tickets, ticket);
  }

  deleteServiceTicket(id: string): void {
    const tickets = this.getServiceTickets().filter(t => t.id !== id);
    this.memStore.set(STORAGE_KEYS.SERVICE_TICKETS, tickets);
    this.deleteSync('service_tickets', id);
  }

  async importServiceTickets(tickets: any[]): Promise<{
    success: boolean;
    total: number;
    imported: number;
    skipped: number;
    failed: number;
    importedRecords?: ServiceTicket[];
    skippedRecords?: { row: number; name: string; reason: string }[];
    failedRecords?: { row: number; reason: string }[];
    errors?: string[];
  }> {
    const result = await apiClient.importServiceTickets(tickets);
    if (result.importedRecords && result.importedRecords.length > 0) {
      await this.hydrateFromBackend();
    }
    return result;
  }

  resolveServiceTicket(ticketId: string, resolutionNotes?: string): void {
    const tickets = this.getServiceTickets();
    const index = tickets.findIndex(t => t.id === ticketId || t.ticketId === ticketId);
    if (index >= 0) {
      tickets[index] = {
        ...tickets[index],
        status: 'RESOLVED',
        resolvedDate: new Date().toISOString().slice(0, 10),
        notes: resolutionNotes ? `${tickets[index].notes ? tickets[index].notes + ' | ' : ''}Resolved: ${resolutionNotes}` : tickets[index].notes
      };
      this.set(STORAGE_KEYS.SERVICE_TICKETS, tickets, tickets[index]);
    }
  }

  getRecentActivities(limit: number = 8): Array<{ id: string; action: string; details: string; userName: string; timestamp: string }> {
    const activities: Array<{ id: string; action: string; details: string; userName: string; timestamp: string }> = [];
    const projects = this.getProjects();
    (projects || []).forEach(p => {
      if (!p || !p.stages) return;
      (p.stages || []).forEach(s => {
        if (!s) return;
        (s.activities || []).forEach((a, aIdx) => {
          if (!a) return;
          // Guarantee unique key across any project, stage, or activity
          const uniqueId = a.id && a.id.startsWith(p.id) ? a.id : `${p.id}-${s.stageKey}-${a.id || aIdx}`;
          activities.push({
            id: uniqueId,
            action: `${p.projectCode || p.id} • ${s.title || ''}: ${a.action || ''}`,
            details: a.details || `${s.title || 'Stage'} updated`,
            userName: a.user || 'Team Member',
            timestamp: a.timestamp || new Date().toISOString()
          });
        });
      });
    });

    return activities.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).slice(0, limit);
  }

  getAMCContracts(): AMCContract[] {
    return this.get<AMCContract[]>(STORAGE_KEYS.AMC_CONTRACTS, initialAMCContracts);
  }

  saveAMCContract(contract: AMCContract): void {
    const contracts = this.getAMCContracts();
    const index = contracts.findIndex(c => c.id === contract.id);
    if (index >= 0) {
      contracts[index] = contract;
    } else {
      contracts.unshift(contract);
    }
    this.set(STORAGE_KEYS.AMC_CONTRACTS, contracts, contract);
  }

  deleteAMCContract(id: string): void {
    const contracts = this.getAMCContracts().filter(c => c.id !== id);
    this.memStore.set(STORAGE_KEYS.AMC_CONTRACTS, contracts);
    this.deleteSync('amc_contracts', id);
  }

  // --- Site Surveys ---
  getSurveys(): SiteSurveyData[] {
    return this.get<SiteSurveyData[]>(STORAGE_KEYS.SURVEYS, initialSurveys);
  }

  saveSurvey(survey: SiteSurveyData): void {
    const surveys = this.getSurveys();
    const index = surveys.findIndex(s => s.id === survey.id);
    if (index >= 0) {
      surveys[index] = survey;
    } else {
      surveys.unshift(survey);
    }
    this.set(STORAGE_KEYS.SURVEYS, surveys, survey);
  }

  deleteSurvey(id: string): void {
    const surveys = this.getSurveys().filter(s => s.id !== id);
    this.memStore.set(STORAGE_KEYS.SURVEYS, surveys);
    this.deleteSync('surveys', id);
  }

  // --- Quotations ---
  getQuotations(): Quotation[] {
    const list = this.get<Quotation[]>(STORAGE_KEYS.QUOTATIONS, initialQuotations);
    const safeList = Array.isArray(list) ? list : initialQuotations;
    return safeList.filter(Boolean).map(q => ({
      ...q,
      quotationDate: q.quotationDate || (q as any).quotation_date || (q.createdAt ? String(q.createdAt).slice(0, 10) : new Date().toISOString().slice(0, 10))
    }));
  }

  getQuotationById(id: string): Quotation | undefined {
    return this.getQuotations().find(q => q.id === id || q.quotationNumber === id);
  }

  saveQuotation(quote: Quotation): void {
    const quotes = this.getQuotations();
    const index = quotes.findIndex(q => q.id === quote.id);
    if (index >= 0) {
      quotes[index] = quote;
    } else {
      quotes.unshift(quote);
    }
    this.set(STORAGE_KEYS.QUOTATIONS, quotes, quote);
  }

  deleteQuotation(id: string): void {
    const quotes = this.getQuotations().filter(q => q.id !== id);
    this.memStore.set(STORAGE_KEYS.QUOTATIONS, quotes);
    this.deleteSync('quotations', id);
  }

  getNextQuotationNumber(): string {
    const quotes = this.getQuotations();
    const year = new Date().getFullYear();
    const fySuffix = (year + 1).toString().slice(-2);
    const prefix = `RSP/QTN/${year}-${fySuffix}/`;
    let maxNum = 0;
    quotes.forEach(q => {
      if (q.quotationNumber) {
        // Match numbers at the end of RSP/QTN/2026-27/0010 or QTN-2026-0010
        const match = q.quotationNumber.match(/(\d+)$/);
        if (match) {
          const n = parseInt(match[1], 10);
          if (!isNaN(n) && n > maxNum) {
            maxNum = n;
          }
        }
      }
    });
    const nextVal = (maxNum > 0 ? maxNum + 1 : 10).toString().padStart(4, '0');
    return `${prefix}${nextVal}`;
  }

  // --- Notifications ---
  getNotifications(): AppNotification[] {
    return this.get<AppNotification[]>(STORAGE_KEYS.NOTIFICATIONS, initialNotifications);
  }

  addNotification(notif: Omit<AppNotification, 'id' | 'timestamp' | 'read'>): void {
    const notifications = this.getNotifications();
    const newNotif = {
      ...notif,
      id: `notif-${Date.now()}`,
      timestamp: new Date().toLocaleString(),
      read: false
    };
    notifications.unshift(newNotif);
    this.set(STORAGE_KEYS.NOTIFICATIONS, notifications, newNotif);
  }

  markNotificationAsRead(id: string): void {
    const notifications = this.getNotifications().map(n => n.id === id ? { ...n, read: true } : n);
    this.set(STORAGE_KEYS.NOTIFICATIONS, notifications);
  }

  markAllNotificationsAsRead(): void {
    const notifications = this.getNotifications().map(n => ({ ...n, read: true }));
    this.set(STORAGE_KEYS.NOTIFICATIONS, notifications);
  }

  // --- Settings ---
  getSettings(): SystemSettings {
    const raw = this.get<Partial<SystemSettings>>(STORAGE_KEYS.SETTINGS, initialSettings);
    const merged: SystemSettings = {
      ...initialSettings,
      ...(raw && typeof raw === 'object' ? raw : {})
    };
    if (!merged.logoUrl || merged.logoUrl === '/logo-dark.png') {
      merged.logoUrl = initialSettings.logoUrl || '/assets/aistudio/solar_urja_logo_07b84efe.jpeg';
    }
    return merged;
  }

  setSettingsInMemory(settings: Partial<SystemSettings>): SystemSettings {
    const normalized: SystemSettings = {
      ...initialSettings,
      ...(settings && typeof settings === 'object' ? settings : {})
    };
    if (!normalized.logoUrl || normalized.logoUrl === '/logo-dark.png') {
      normalized.logoUrl = initialSettings.logoUrl || '/assets/aistudio/solar_urja_logo_07b84efe.jpeg';
    }
    this.memStore.set(STORAGE_KEYS.SETTINGS, normalized);
    return normalized;
  }

  async fetchSettingsFromBackend(): Promise<SystemSettings> {
    const remote = await apiClient.getSettings();
    return this.setSettingsInMemory(remote || {});
  }

  async saveSettingsAsync(settings: SystemSettings): Promise<SystemSettings> {
    const saved = await apiClient.saveSettings(settings);
    const normalized = this.setSettingsInMemory(saved || settings);
    this.lastSyncError = null;
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('solarpulse_storage_updated'));
    }
    return normalized;
  }

  saveSettings(settings: SystemSettings): void {
    this.set(STORAGE_KEYS.SETTINGS, settings, settings);
  }

  // ==========================================
  // Products & Inventory Management
  // ==========================================
  getProducts(): ProductItem[] {
    return this.get<ProductItem[]>(STORAGE_KEYS.PRODUCTS, initialProducts);
  }

  async saveProductAsync(product: ProductItem): Promise<ProductItem> {
    const products = this.getProducts();
    const validation = validateProduct(product, products, product.id);
    assertValid(validation);

    const now = new Date().toISOString();
    const existingIdx = products.findIndex(p => p.id === product.id);
    const existingProd = existingIdx >= 0 ? products[existingIdx] : undefined;
    const whId = product.warehouseId || existingProd?.warehouseId || this.getDefaultWarehouse()?.id;
    const whStocks = { ...(existingProd?.warehouseStocks || {}), ...(product.warehouseStocks || {}) };
    if (whId && (existingIdx < 0 || Object.keys(whStocks).length === 0)) {
      whStocks[whId] = Math.max(0, Number(product.currentStock) || 0);
    }

    const candidate: ProductItem = {
      ...product,
      id: product.id || `prod-${Date.now()}`,
      warehouseId: whId || product.warehouseId,
      warehouseStocks: Object.keys(whStocks).length > 0 ? whStocks : undefined,
      createdAt: product.createdAt || existingProd?.createdAt || now,
      updatedAt: now
    };

    const committed = await this.confirmSyncPush('products', candidate);
    const nextList = [...products];
    const idx = nextList.findIndex(p => p.id === committed.id);
    if (idx >= 0) {
      nextList[idx] = committed;
    } else {
      nextList.unshift(committed);
    }
    this.memStore.set(STORAGE_KEYS.PRODUCTS, nextList);
    this.notifyStorageUpdated();
    return committed;
  }

  async deleteProductAsync(id: string): Promise<void> {
    await this.confirmSyncDelete('products', id);
    const nextList = this.getProducts().filter(p => p.id !== id);
    this.memStore.set(STORAGE_KEYS.PRODUCTS, nextList);
    this.notifyStorageUpdated();
  }

  saveProduct(product: ProductItem): void {
    const products = this.getProducts();
    const validation = validateProduct(product, products, product.id);
    assertValid(validation);

    const idx = products.findIndex(p => p.id === product.id);
    const nextList = [...products];
    if (idx >= 0) {
      nextList[idx] = { ...product, updatedAt: new Date().toISOString() };
    } else {
      nextList.unshift({
        ...product,
        id: product.id || `prod-${Date.now()}`,
        createdAt: product.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }
    this.set(STORAGE_KEYS.PRODUCTS, nextList, product);
  }

  deleteProduct(id: string): void {
    const products = this.getProducts().filter(p => p.id !== id);
    this.memStore.set(STORAGE_KEYS.PRODUCTS, products);
    this.deleteSync('products', id);
  }

  async importProducts(products: any[]): Promise<{
    success: boolean;
    total: number;
    imported: number;
    skipped: number;
    failed: number;
    importedRecords?: ProductItem[];
    skippedRecords?: { row: number; name: string; reason: string }[];
    failedRecords?: { row: number; reason: string }[];
    errors?: string[];
  }> {
    const result = await apiClient.importProducts(products);
    if (result.importedRecords && result.importedRecords.length > 0) {
      await this.hydrateFromBackend();
      this.notifyStorageUpdated();
    }
    return result;
  }

  async adjustStockAsync(
    productId: string,
    newQty: number,
    reason: string,
    performedBy: string = 'Operations Team',
    warehouseId?: string,
    warehouseName?: string
  ): Promise<{ product: ProductItem; movement: StockMovement }> {
    const products = this.getProducts();
    const prodIdx = products.findIndex(p => p.id === productId);
    if (prodIdx < 0) {
      throw new Error('Selected product record was not found in MySQL.');
    }
    const existingProd = products[prodIdx];

    const warehouses = this.getWarehouses();
    const wh = warehouseId ? warehouses.find(w => w.id === warehouseId) : this.getDefaultWarehouse();
    const targetWhId = warehouseId || wh?.id || 'wh-1';
    const targetWhName = warehouseName || wh?.name || 'Central Solar Logistics Hub';

    const nextWhStocks = { ...(existingProd.warehouseStocks || {}) };
    const previousWhQty = nextWhStocks[targetWhId] ?? (wh?.isDefault || !existingProd.warehouseStocks ? existingProd.currentStock : 0);
    const clampedNewQty = Math.max(0, Number(newQty) || 0);
    const diff = clampedNewQty - previousWhQty;
    nextWhStocks[targetWhId] = clampedNewQty;

    const nextTotalStock = Math.max(0, (existingProd.currentStock || 0) + diff);
    const updatedProd: ProductItem = {
      ...existingProd,
      warehouseStocks: nextWhStocks,
      currentStock: nextTotalStock,
      updatedAt: new Date().toISOString()
    };

    const isAudit = reason.toLowerCase().includes('audit') || reason.toLowerCase().includes('physical');
    const movement: StockMovement = {
      id: `sm-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      productId: updatedProd.id,
      productName: updatedProd.name,
      sku: updatedProd.sku,
      movementType: isAudit ? 'AUDIT_RECONCILIATION' : 'ADJUSTMENT',
      quantity: diff,
      balanceAfter: updatedProd.currentStock,
      warehouseId: targetWhId,
      warehouseName: targetWhName,
      notes: reason || `Inventory count adjustment at ${targetWhName} from ${previousWhQty} to ${clampedNewQty}`,
      performedBy,
      timestamp: new Date().toISOString()
    };

    const committedProd = await this.confirmSyncPush('products', updatedProd);
    const committedMovement = await this.confirmSyncPush('stock_movements', movement);

    const nextProducts = [...this.getProducts()];
    const refreshIdx = nextProducts.findIndex(p => p.id === committedProd.id);
    if (refreshIdx >= 0) {
      nextProducts[refreshIdx] = committedProd;
    } else {
      nextProducts.unshift(committedProd);
    }
    this.memStore.set(STORAGE_KEYS.PRODUCTS, nextProducts);
    this.memStore.set(STORAGE_KEYS.STOCK_MOVEMENTS, [
      committedMovement,
      ...this.getStockMovements().filter(m => m.id !== committedMovement.id)
    ]);
    this.notifyStorageUpdated();

    return { product: committedProd, movement: committedMovement };
  }

  adjustStock(
    productId: string,
    newQty: number,
    reason: string,
    performedBy: string = 'Operations Team',
    warehouseId?: string,
    warehouseName?: string
  ): void {
    const products = this.getProducts();
    const prod = products.find(p => p.id === productId);
    if (!prod) return;

    const warehouses = this.getWarehouses();
    const wh = warehouseId ? warehouses.find(w => w.id === warehouseId) : this.getDefaultWarehouse();
    const targetWhId = warehouseId || wh?.id || 'wh-1';
    const targetWhName = warehouseName || wh?.name || 'Central Solar Logistics Hub - Pune';

    prod.warehouseStocks = prod.warehouseStocks || {};
    const previousWhQty = prod.warehouseStocks[targetWhId] ?? prod.currentStock;
    const diff = newQty - previousWhQty;

    prod.warehouseStocks[targetWhId] = Math.max(0, newQty);

    const previousTotal = prod.currentStock;
    prod.currentStock = Math.max(0, previousTotal + diff);
    prod.updatedAt = new Date().toISOString();
    this.set(STORAGE_KEYS.PRODUCTS, products, prod);

    const isAudit = reason.toLowerCase().includes('audit') || reason.toLowerCase().includes('physical');

    this.addStockMovement({
      productId: prod.id,
      productName: prod.name,
      sku: prod.sku,
      movementType: isAudit ? 'AUDIT_RECONCILIATION' : 'ADJUSTMENT',
      quantity: diff,
      balanceAfter: prod.currentStock,
      warehouseId: targetWhId,
      warehouseName: targetWhName,
      notes: reason || `Inventory count adjustment at ${targetWhName} from ${previousWhQty} to ${newQty}`,
      performedBy
    });
  }

  // ==========================================
  // Vendor Management
  // ==========================================
  getVendors(): Vendor[] {
    return this.get<Vendor[]>(STORAGE_KEYS.VENDORS, initialVendors);
  }

  async saveVendorAsync(vendor: Vendor): Promise<Vendor> {
    const vendors = this.getVendors();
    const validation = validateVendor(vendor, vendors, vendor.id);
    assertValid(validation);

    const now = new Date().toISOString();
    const existing = vendors.find(v => v.id === vendor.id);
    const candidate: Vendor = {
      ...vendor,
      id: vendor.id || `vnd-${Date.now()}`,
      createdAt: vendor.createdAt || existing?.createdAt || now,
      updatedAt: now
    };

    const committed = await this.confirmSyncPush('vendors', candidate);
    const nextList = [...vendors];
    const idx = nextList.findIndex(v => v.id === committed.id);
    if (idx >= 0) {
      nextList[idx] = committed;
    } else {
      nextList.unshift(committed);
    }
    this.memStore.set(STORAGE_KEYS.VENDORS, nextList);
    this.notifyStorageUpdated();
    return committed;
  }

  async deleteVendorAsync(id: string): Promise<void> {
    await this.confirmSyncDelete('vendors', id);
    const nextList = this.getVendors().filter(v => v.id !== id);
    this.memStore.set(STORAGE_KEYS.VENDORS, nextList);
    this.notifyStorageUpdated();
  }

  saveVendor(vendor: Vendor): void {
    const vendors = this.getVendors();
    const validation = validateVendor(vendor, vendors, vendor.id);
    assertValid(validation);

    const idx = vendors.findIndex(v => v.id === vendor.id);
    const nextList = [...vendors];
    if (idx >= 0) {
      nextList[idx] = { ...vendor, updatedAt: new Date().toISOString() };
    } else {
      nextList.unshift({
        ...vendor,
        id: vendor.id || `vnd-${Date.now()}`,
        createdAt: vendor.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }
    this.set(STORAGE_KEYS.VENDORS, nextList, vendor);
  }

  deleteVendor(id: string): void {
    const vendors = this.getVendors().filter(v => v.id !== id);
    this.memStore.set(STORAGE_KEYS.VENDORS, vendors);
    this.deleteSync('vendors', id);
  }

  async importVendors(vendors: any[]): Promise<{
    success: boolean;
    total: number;
    imported: number;
    skipped: number;
    failed: number;
    importedRecords?: Vendor[];
    skippedRecords?: { row: number; name: string; reason: string }[];
    failedRecords?: { row: number; reason: string }[];
    errors?: string[];
  }> {
    const result = await apiClient.importVendors(vendors);
    if (result.importedRecords && result.importedRecords.length > 0) {
      await this.hydrateFromBackend();
      this.notifyStorageUpdated();
    }
    return result;
  }

  // ==========================================
  // Purchase Entry & Purchase Orders
  // ==========================================
  getPurchaseOrders(): PurchaseOrder[] {
    const orders = this.get<PurchaseOrder[]>(STORAGE_KEYS.PURCHASE_ORDERS, initialPurchaseOrders);
    return orders.map(order => {
      const items: PurchaseLineItem[] = (order.items || []).map((item, idx) => {
        const orderedQty = Math.max(0, Number(item.orderedQuantity ?? item.quantity ?? 0));
        let receivedQty = Math.max(0, Number(item.receivedQuantity ?? 0));
        if (item.receivedQuantity === undefined && (order.status === 'RECEIVED' || order.stockUpdated)) {
          receivedQty = orderedQty;
        }
        const pendingQty = Math.max(0, Number(item.pendingQuantity ?? Math.max(0, orderedQty - receivedQty)));
        const rejectedQty = Math.max(0, Number(item.rejectedQuantity ?? 0));
        const unitPrice = Math.max(0, Number(item.unitPrice || 0));
        const taxPercent = Math.max(0, Number(item.taxPercent ?? item.taxRatePercent ?? 12));
        const taxAmount = Math.round((orderedQty * unitPrice * taxPercent) / 100);
        const totalAmount = (orderedQty * unitPrice) + taxAmount;

        return {
          ...item,
          id: item.id || `poi-${order.id}-${idx}`,
          orderedQuantity: orderedQty,
          receivedQuantity: receivedQty,
          pendingQuantity: pendingQty,
          rejectedQuantity: rejectedQty,
          unitPrice,
          taxPercent,
          taxAmount,
          totalAmount,
          quantity: orderedQty,
          taxRatePercent: taxPercent,
          totalPrice: totalAmount
        };
      });

      const vendorBills: VendorBillAttachment[] = Array.isArray(order.vendorBills)
        ? order.vendorBills
        : order.vendorBillUrl
        ? [
            {
              id: `bill-${order.id}-primary`,
              fileName: order.vendorBillName || 'Vendor Bill',
              fileUrl: order.vendorBillUrl,
              mimeType: order.vendorBillMimeType || 'application/pdf',
              fileSize: Number(order.vendorBillSize || 0),
              uploadedAt: order.vendorBillUploadedAt || order.updatedAt || order.createdAt || ''
            }
          ]
        : [];
      const primaryBill = vendorBills[0];

      return {
        ...order,
        items,
        deliveryReceipts: order.deliveryReceipts || [],
        vendorBills,
        vendorBillUrl: primaryBill?.fileUrl ?? order.vendorBillUrl,
        vendorBillName: primaryBill?.fileName ?? order.vendorBillName,
        vendorBillMimeType: primaryBill?.mimeType ?? order.vendorBillMimeType,
        vendorBillSize: primaryBill?.fileSize ?? order.vendorBillSize,
        vendorBillUploadedAt: primaryBill?.uploadedAt ?? order.vendorBillUploadedAt
      };
    });
  }

  applyPurchaseOrderBillsUpdate(
    poId: string,
    vendorBills: VendorBillAttachment[]
  ): PurchaseOrder | null {
    const orders = this.get<PurchaseOrder[]>(STORAGE_KEYS.PURCHASE_ORDERS, initialPurchaseOrders);
    const idx = orders.findIndex(o => o.id === poId);
    if (idx === -1) return null;

    const normalizedBills = Array.isArray(vendorBills) ? vendorBills : [];
    const primary = normalizedBills[0];
    const updatedOrder: PurchaseOrder = {
      ...orders[idx],
      vendorBills: normalizedBills,
      vendorBillUrl: primary?.fileUrl || '',
      vendorBillName: primary?.fileName || '',
      vendorBillMimeType: primary?.mimeType || '',
      vendorBillSize: primary?.fileSize || 0,
      vendorBillUploadedAt: primary?.uploadedAt || ''
    };
    const nextOrders = [...orders];
    nextOrders[idx] = updatedOrder;
    this.memStore.set(STORAGE_KEYS.PURCHASE_ORDERS, nextOrders);
    this.notifyStorageUpdated();
    return updatedOrder;
  }

  private normalizePurchaseOrderForSave(order: PurchaseOrder): PurchaseOrder {
    const items: PurchaseLineItem[] = (order.items || []).map((item, i) => {
      const orderedQty = Math.max(0, Number(item.orderedQuantity ?? item.quantity ?? 0));
      const receivedQty = Math.max(0, Number(item.receivedQuantity ?? 0));
      const pendingQty = Math.max(0, orderedQty - receivedQty);
      const rejectedQty = Math.max(0, Number(item.rejectedQuantity ?? 0));
      const unitPrice = Math.max(0, Number(item.unitPrice || 0));
      const taxPercent = Math.max(0, Number(item.taxPercent ?? item.taxRatePercent ?? 12));
      const taxAmount = Math.round((orderedQty * unitPrice * taxPercent) / 100);
      const totalAmount = (orderedQty * unitPrice) + taxAmount;

      return {
        ...item,
        id: item.id || `poi-${Date.now()}-${i}`,
        orderedQuantity: orderedQty,
        receivedQuantity: receivedQty,
        pendingQuantity: pendingQty,
        rejectedQuantity: rejectedQty,
        unitPrice,
        taxPercent,
        taxAmount,
        totalAmount,
        quantity: orderedQty,
        taxRatePercent: taxPercent,
        totalPrice: totalAmount
      };
    });

    const subtotal = items.reduce((sum, it) => sum + (it.orderedQuantity * it.unitPrice), 0);
    const taxAmount = items.reduce((sum, it) => sum + it.taxAmount, 0);
    const totalAmount = subtotal + taxAmount;

    let status = order.status;
    if (status !== 'CANCELLED' && status !== 'DRAFT') {
      const allReceived = items.length > 0 && items.every(it => it.receivedQuantity >= it.orderedQuantity);
      const anyReceived = items.some(it => it.receivedQuantity > 0);
      if (allReceived) {
        status = 'RECEIVED';
      } else if (anyReceived) {
        status = 'PARTIALLY_RECEIVED';
      } else {
        status = 'ORDERED';
      }
    }

    const vendorBills = Array.isArray(order.vendorBills) ? order.vendorBills : [];
    const primaryBill = vendorBills[0];
    const now = new Date().toISOString();
    return {
      ...order,
      id: order.id || `po-${Date.now()}`,
      items,
      subtotal,
      taxAmount,
      totalAmount,
      status,
      deliveryReceipts: order.deliveryReceipts || [],
      vendorBills,
      vendorBillUrl: primaryBill?.fileUrl ?? order.vendorBillUrl,
      vendorBillName: primaryBill?.fileName ?? order.vendorBillName,
      vendorBillMimeType: primaryBill?.mimeType ?? order.vendorBillMimeType,
      vendorBillSize: primaryBill?.fileSize ?? order.vendorBillSize,
      vendorBillUploadedAt: primaryBill?.uploadedAt ?? order.vendorBillUploadedAt,
      createdAt: order.createdAt || now,
      updatedAt: now
    };
  }

  async savePurchaseOrderAsync(
    order: PurchaseOrder,
    _autoSyncStock: boolean = false,
    _performedBy: string = 'Purchase Manager'
  ): Promise<PurchaseOrder> {
    const orders = this.getPurchaseOrders();
    const validation = validatePurchaseOrder(order, orders, order.id);
    assertValid(validation);

    const updatedOrder = this.normalizePurchaseOrderForSave(order);
    const committed = await this.confirmSyncPush('purchase_orders', updatedOrder);

    const nextList = [...orders];
    const idx = nextList.findIndex(o => o.id === committed.id);
    if (idx >= 0) {
      nextList[idx] = committed;
    } else {
      nextList.unshift(committed);
    }
    this.memStore.set(STORAGE_KEYS.PURCHASE_ORDERS, nextList);

    const committedPaid = Number((committed as any).paidAmount || 0);
    if (committedPaid > 0.01) {
      const projects = await apiClient.getProjects().catch(() => null);
      if (Array.isArray(projects)) this.memStore.set(STORAGE_KEYS.PROJECTS, projects);
    }

    this.notifyStorageUpdated();
    return committed;
  }

  async recordPurchaseReceiptAsync(
    orderId: string,
    receiptInput: {
      receiptDate: string;
      deliveryChallanNo?: string;
      transporterName?: string;
      receivedBy: string;
      notes?: string;
      items: {
        lineItemId: string;
        receivedQuantity: number;
        rejectedQuantity?: number;
        rejectionReason?: string;
        isExcessApproved?: boolean;
        excessApprovalReason?: string;
      }[];
    },
    performedBy: string = 'Store Incharge'
  ): Promise<PurchaseOrder> {
    const orders = this.getPurchaseOrders();
    const existingOrder = orders.find(o => o.id === orderId);
    if (!existingOrder) {
      throw new Error('Purchase order not found in MySQL.');
    }

    const currentProducts = this.getProducts();
    const productClones = new Map<string, ProductItem>();
    const newMovements: StockMovement[] = [];
    const now = new Date().toISOString();

    const receiptId = `grn-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const receiptNumber = `GRN-${new Date().getFullYear()}-${String((existingOrder.deliveryReceipts?.length || 0) + 1).padStart(3, '0')}`;
    const receiptItems: DeliveryReceiptItem[] = [];

    const updatedLineItems: PurchaseLineItem[] = existingOrder.items.map(lineItem => {
      const inputItem = receiptInput.items.find(i => i.lineItemId === lineItem.id);
      if (!inputItem) return { ...lineItem };

      const arrivingQty = Math.max(0, Number(inputItem.receivedQuantity || 0));
      const rejectedQty = Math.max(0, Number(inputItem.rejectedQuantity || 0));

      if (arrivingQty > 0 || rejectedQty > 0) {
        receiptItems.push({
          lineItemId: lineItem.id,
          productId: lineItem.productId,
          productName: lineItem.productName,
          sku: lineItem.sku,
          unit: lineItem.unit,
          receivedQuantity: arrivingQty,
          rejectedQuantity: rejectedQty,
          rejectionReason: inputItem.rejectionReason,
          isExcessApproved: inputItem.isExcessApproved,
          excessApprovalReason: inputItem.excessApprovalReason
        });
      }

      if (arrivingQty > 0) {
        const baseProd = currentProducts.find(p => p.id === lineItem.productId || p.sku === lineItem.sku);
        if (baseProd) {
          const prod = productClones.get(baseProd.id) || {
            ...baseProd,
            warehouseStocks: { ...(baseProd.warehouseStocks || {}) }
          };
          prod.currentStock = (prod.currentStock || 0) + arrivingQty;
          if (existingOrder.warehouseId) {
            prod.warehouseStocks = prod.warehouseStocks || {};
            prod.warehouseStocks[existingOrder.warehouseId] = (prod.warehouseStocks[existingOrder.warehouseId] || 0) + arrivingQty;
          }
          prod.updatedAt = now;
          productClones.set(prod.id, prod);

          newMovements.push({
            id: `sm-${Date.now()}-${newMovements.length}-${Math.floor(Math.random() * 1000)}`,
            productId: prod.id,
            productName: prod.name,
            sku: prod.sku,
            movementType: 'PURCHASE_RECEIPT',
            quantity: arrivingQty,
            balanceAfter: prod.currentStock,
            warehouseId: existingOrder.warehouseId,
            warehouseName: existingOrder.warehouseName,
            referenceId: existingOrder.id,
            referenceNumber: existingOrder.purchaseNumber,
            notes: `Goods Receipt ${receiptNumber}${receiptInput.deliveryChallanNo ? ' (DC: ' + receiptInput.deliveryChallanNo + ')' : ''} from ${existingOrder.vendorName}${existingOrder.warehouseName ? ' into ' + existingOrder.warehouseName : ''}`,
            performedBy: performedBy || receiptInput.receivedBy,
            timestamp: now
          });
        }
      }

      const nextReceived = (lineItem.receivedQuantity || 0) + arrivingQty;
      const nextRejected = (lineItem.rejectedQuantity || 0) + rejectedQty;
      return {
        ...lineItem,
        receivedQuantity: nextReceived,
        rejectedQuantity: nextRejected,
        pendingQuantity: Math.max(0, lineItem.orderedQuantity - nextReceived),
        quantity: lineItem.orderedQuantity
      };
    });

    const newReceipt: PurchaseDeliveryReceipt = {
      id: receiptId,
      receiptNumber,
      receiptDate: receiptInput.receiptDate || new Date().toISOString().slice(0, 10),
      deliveryChallanNo: receiptInput.deliveryChallanNo,
      transporterName: receiptInput.transporterName,
      receivedBy: receiptInput.receivedBy || performedBy,
      notes: receiptInput.notes,
      items: receiptItems,
      createdAt: now
    };

    const allReceived = updatedLineItems.length > 0 && updatedLineItems.every(it => it.receivedQuantity >= it.orderedQuantity);
    const anyReceived = updatedLineItems.some(it => it.receivedQuantity > 0);

    const updatedOrder: PurchaseOrder = {
      ...existingOrder,
      items: updatedLineItems,
      deliveryReceipts: [newReceipt, ...(existingOrder.deliveryReceipts || [])],
      status: allReceived ? 'RECEIVED' : anyReceived ? 'PARTIALLY_RECEIVED' : existingOrder.status,
      receivedDate: allReceived ? (receiptInput.receiptDate || new Date().toISOString().slice(0, 10)) : existingOrder.receivedDate,
      stockUpdated: anyReceived || existingOrder.stockUpdated,
      updatedAt: now
    };

    // Persist to MySQL BEFORE mutating memStore
    const committedProducts = await Promise.all(
      Array.from(productClones.values()).map(p => this.confirmSyncPush('products', p))
    );
    const committedMovements = await Promise.all(
      newMovements.map(m => this.confirmSyncPush('stock_movements', m))
    );
    const committedOrder = await this.confirmSyncPush('purchase_orders', updatedOrder);

    if (committedProducts.length > 0) {
      const nextProducts = [...this.getProducts()];
      committedProducts.forEach(cp => {
        const idx = nextProducts.findIndex(p => p.id === cp.id);
        if (idx >= 0) nextProducts[idx] = cp;
      });
      this.memStore.set(STORAGE_KEYS.PRODUCTS, nextProducts);
    }

    if (committedMovements.length > 0) {
      const committedIds = new Set(committedMovements.map(m => m.id));
      this.memStore.set(STORAGE_KEYS.STOCK_MOVEMENTS, [
        ...committedMovements.reverse(),
        ...this.getStockMovements().filter(m => !committedIds.has(m.id))
      ]);
    }

    const nextOrders = [...this.getPurchaseOrders()];
    const orderIdx = nextOrders.findIndex(o => o.id === committedOrder.id);
    if (orderIdx >= 0) {
      nextOrders[orderIdx] = committedOrder;
    } else {
      nextOrders.unshift(committedOrder);
    }
    this.memStore.set(STORAGE_KEYS.PURCHASE_ORDERS, nextOrders);
    this.notifyStorageUpdated();
    return committedOrder;
  }

  async receivePurchaseOrderAsync(id: string, performedBy: string = 'Store Incharge'): Promise<PurchaseOrder | null> {
    const order = this.getPurchaseOrders().find(o => o.id === id);
    if (!order) return null;

    const pendingItemsToReceive = order.items.map(it => ({
      lineItemId: it.id,
      receivedQuantity: it.pendingQuantity > 0 ? it.pendingQuantity : (it.receivedQuantity === 0 ? it.orderedQuantity : 0),
      rejectedQuantity: 0
    })).filter(it => it.receivedQuantity > 0);

    if (pendingItemsToReceive.length > 0) {
      return this.recordPurchaseReceiptAsync(
        id,
        {
          receiptDate: new Date().toISOString().slice(0, 10),
          deliveryChallanNo: order.invoiceReference || 'Direct Delivery',
          receivedBy: performedBy,
          notes: 'Full goods delivery receipt recorded',
          items: pendingItemsToReceive
        },
        performedBy
      );
    }

    return this.savePurchaseOrderAsync({
      ...order,
      status: 'RECEIVED',
      stockUpdated: true,
      updatedAt: new Date().toISOString()
    });
  }

  async deletePurchaseOrderAsync(id: string): Promise<void> {
    await this.confirmSyncDelete('purchase_orders', id);
    const nextOrders = this.getPurchaseOrders().filter(o => o.id !== id);
    this.memStore.set(STORAGE_KEYS.PURCHASE_ORDERS, nextOrders);
    this.notifyStorageUpdated();
  }

  savePurchaseOrder(order: PurchaseOrder, _autoSyncStock: boolean = false, _performedBy: string = 'Purchase Manager'): void {
    const orders = this.getPurchaseOrders();
    const validation = validatePurchaseOrder(order, orders, order.id);
    assertValid(validation);

    const idx = orders.findIndex(o => o.id === order.id);
    const updatedOrder = this.normalizePurchaseOrderForSave(order);
    const nextList = [...orders];
    if (idx >= 0) {
      nextList[idx] = updatedOrder;
    } else {
      nextList.unshift(updatedOrder);
    }
    this.set(STORAGE_KEYS.PURCHASE_ORDERS, nextList, updatedOrder);
  }

  recordPurchaseReceipt(
    orderId: string,
    receiptInput: {
      receiptDate: string;
      deliveryChallanNo?: string;
      transporterName?: string;
      receivedBy: string;
      notes?: string;
      items: {
        lineItemId: string;
        receivedQuantity: number;
        rejectedQuantity?: number;
        rejectionReason?: string;
        isExcessApproved?: boolean;
        excessApprovalReason?: string;
      }[];
    },
    performedBy: string = 'Store Incharge'
  ): PurchaseOrder | null {
    const orders = this.getPurchaseOrders();
    const order = orders.find(o => o.id === orderId);
    if (!order) return null;

    const products = this.getProducts();
    const receiptId = `grn-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const receiptNumber = `GRN-${new Date().getFullYear()}-${String((order.deliveryReceipts?.length || 0) + 1).padStart(3, '0')}`;

    const receiptItems: DeliveryReceiptItem[] = [];

    receiptInput.items.forEach(inputItem => {
      const lineItem = order.items.find(it => it.id === inputItem.lineItemId);
      if (!lineItem) return;

      const arrivingQty = Math.max(0, Number(inputItem.receivedQuantity || 0));
      const rejectedQty = Math.max(0, Number(inputItem.rejectedQuantity || 0));

      if (arrivingQty > 0 || rejectedQty > 0) {
        receiptItems.push({
          lineItemId: lineItem.id,
          productId: lineItem.productId,
          productName: lineItem.productName,
          sku: lineItem.sku,
          unit: lineItem.unit,
          receivedQuantity: arrivingQty,
          rejectedQuantity: rejectedQty,
          rejectionReason: inputItem.rejectionReason,
          isExcessApproved: inputItem.isExcessApproved,
          excessApprovalReason: inputItem.excessApprovalReason
        });
      }

      if (arrivingQty > 0) {
        const prod = products.find(p => p.id === lineItem.productId || p.sku === lineItem.sku);
        if (prod) {
          prod.currentStock += arrivingQty;
          if (order.warehouseId) {
            prod.warehouseStocks = prod.warehouseStocks || {};
            prod.warehouseStocks[order.warehouseId] = (prod.warehouseStocks[order.warehouseId] || 0) + arrivingQty;
          }
          prod.updatedAt = new Date().toISOString();
          this.addStockMovement({
            productId: prod.id,
            productName: prod.name,
            sku: prod.sku,
            movementType: 'PURCHASE_RECEIPT',
            quantity: arrivingQty,
            balanceAfter: prod.currentStock,
            warehouseId: order.warehouseId,
            warehouseName: order.warehouseName,
            referenceId: order.id,
            referenceNumber: order.purchaseNumber,
            notes: `Goods Receipt ${receiptNumber}${receiptInput.deliveryChallanNo ? ' (DC: ' + receiptInput.deliveryChallanNo + ')' : ''} from ${order.vendorName}${order.warehouseName ? ' into ' + order.warehouseName : ''}`,
            performedBy: performedBy || receiptInput.receivedBy
          });
        }
      }

      lineItem.receivedQuantity = (lineItem.receivedQuantity || 0) + arrivingQty;
      lineItem.rejectedQuantity = (lineItem.rejectedQuantity || 0) + rejectedQty;
      lineItem.pendingQuantity = Math.max(0, lineItem.orderedQuantity - lineItem.receivedQuantity);
      lineItem.quantity = lineItem.orderedQuantity;
    });

    this.set(STORAGE_KEYS.PRODUCTS, products);

    const newReceipt: PurchaseDeliveryReceipt = {
      id: receiptId,
      receiptNumber,
      receiptDate: receiptInput.receiptDate || new Date().toISOString().slice(0, 10),
      deliveryChallanNo: receiptInput.deliveryChallanNo,
      transporterName: receiptInput.transporterName,
      receivedBy: receiptInput.receivedBy || performedBy,
      notes: receiptInput.notes,
      items: receiptItems,
      createdAt: new Date().toISOString()
    };

    if (!order.deliveryReceipts) {
      order.deliveryReceipts = [];
    }
    order.deliveryReceipts.unshift(newReceipt);

    const allReceived = order.items.length > 0 && order.items.every(it => it.receivedQuantity >= it.orderedQuantity);
    const anyReceived = order.items.some(it => it.receivedQuantity > 0);

    if (allReceived) {
      order.status = 'RECEIVED';
      order.receivedDate = receiptInput.receiptDate || new Date().toISOString().slice(0, 10);
    } else if (anyReceived) {
      order.status = 'PARTIALLY_RECEIVED';
    }

    order.stockUpdated = anyReceived;
    order.updatedAt = new Date().toISOString();

    this.set(STORAGE_KEYS.PURCHASE_ORDERS, orders);
    return order;
  }

  receivePurchaseOrder(id: string, performedBy: string = 'Store Incharge'): void {
    const orders = this.getPurchaseOrders();
    const order = orders.find(o => o.id === id);
    if (!order) return;

    const pendingItemsToReceive = order.items.map(it => ({
      lineItemId: it.id,
      receivedQuantity: it.pendingQuantity > 0 ? it.pendingQuantity : (it.receivedQuantity === 0 ? it.orderedQuantity : 0),
      rejectedQuantity: 0
    })).filter(it => it.receivedQuantity > 0);

    if (pendingItemsToReceive.length > 0) {
      this.recordPurchaseReceipt(
        id,
        {
          receiptDate: new Date().toISOString().slice(0, 10),
          deliveryChallanNo: order.invoiceReference || 'Direct Delivery',
          receivedBy: performedBy,
          notes: 'Full goods delivery receipt recorded',
          items: pendingItemsToReceive
        },
        performedBy
      );
    } else {
      order.status = 'RECEIVED';
      order.stockUpdated = true;
      order.updatedAt = new Date().toISOString();
      this.set(STORAGE_KEYS.PURCHASE_ORDERS, orders);
    }
  }

  deletePurchaseOrder(id: string): void {
    const orders = this.getPurchaseOrders().filter(o => o.id !== id);
    this.memStore.set(STORAGE_KEYS.PURCHASE_ORDERS, orders);
    this.deleteSync('purchase_orders', id);
  }

  // ==========================================
  // Bill of Materials (BOM)
  // ==========================================
  getBOMs(): BillOfMaterials[] {
    return this.get<BillOfMaterials[]>(STORAGE_KEYS.BOMS, initialBOMs);
  }

  async saveBOMAsync(bom: BillOfMaterials): Promise<BillOfMaterials> {
    const boms = this.getBOMs();
    const validation = validateBOM(bom, boms, bom.id);
    assertValid(validation);

    const now = new Date().toISOString();
    const existing = boms.find(b => b.id === bom.id);
    const candidate: BillOfMaterials = {
      ...bom,
      id: bom.id || `bom-${Date.now()}`,
      createdAt: bom.createdAt || existing?.createdAt || now,
      updatedAt: now
    };

    const committed = await this.confirmSyncPush('boms', candidate);
    const nextList = [...boms];
    const idx = nextList.findIndex(b => b.id === committed.id);
    if (idx >= 0) {
      nextList[idx] = committed;
    } else {
      nextList.unshift(committed);
    }
    this.memStore.set(STORAGE_KEYS.BOMS, nextList);
    this.notifyStorageUpdated();
    return committed;
  }

  async allocateBOMStockAsync(bomId: string, performedBy: string = 'Project Engineer'): Promise<BillOfMaterials> {
    const boms = this.getBOMs();
    const existingBom = boms.find(b => b.id === bomId);
    if (!existingBom) {
      throw new Error('Bill of Materials not found in MySQL.');
    }

    const currentProducts = this.getProducts();
    const productClones = new Map<string, ProductItem>();
    const newMovements: StockMovement[] = [];
    const now = new Date().toISOString();
    let hasUpdatedStock = false;

    const updatedItems = existingBom.items.map(item => {
      const baseProd = currentProducts.find(p => p.id === item.productId || p.sku === item.sku);
      if (baseProd && item.requiredQty > 0) {
        const prod = productClones.get(baseProd.id) || {
          ...baseProd,
          warehouseStocks: { ...(baseProd.warehouseStocks || {}) }
        };
        prod.currentStock = Math.max(0, (prod.currentStock || 0) - item.requiredQty);
        if (existingBom.warehouseId) {
          prod.warehouseStocks = prod.warehouseStocks || {};
          prod.warehouseStocks[existingBom.warehouseId] = Math.max(
            0,
            (prod.warehouseStocks[existingBom.warehouseId] ?? prod.currentStock) - item.requiredQty
          );
        }
        prod.updatedAt = now;
        productClones.set(prod.id, prod);
        hasUpdatedStock = true;

        newMovements.push({
          id: `sm-${Date.now()}-${newMovements.length}-${Math.floor(Math.random() * 1000)}`,
          productId: prod.id,
          productName: prod.name,
          sku: prod.sku,
          movementType: 'BOM_ALLOCATION',
          quantity: -item.requiredQty,
          balanceAfter: prod.currentStock,
          warehouseId: existingBom.warehouseId,
          warehouseName: existingBom.warehouseName,
          referenceId: existingBom.id,
          referenceNumber: existingBom.bomNumber,
          notes: `BOM allocation for ${existingBom.projectTitle} (${existingBom.customerName})${existingBom.warehouseName ? ' from ' + existingBom.warehouseName : ''}`,
          performedBy,
          timestamp: now
        });

        return {
          ...item,
          allocatedQty: item.requiredQty,
          status: 'ALLOCATED' as const
        };
      }
      return { ...item };
    });

    if (!hasUpdatedStock) {
      throw new Error('Could not allocate stock. Ensure BOM items link to existing inventory catalog products.');
    }

    const updatedBom: BillOfMaterials = {
      ...existingBom,
      items: updatedItems,
      stockAllocated: true,
      status: existingBom.status === 'DRAFT' ? 'APPROVED' : existingBom.status,
      updatedAt: now
    };

    const committedProducts = await Promise.all(
      Array.from(productClones.values()).map(p => this.confirmSyncPush('products', p))
    );
    const committedMovements = await Promise.all(
      newMovements.map(m => this.confirmSyncPush('stock_movements', m))
    );
    const committedBom = await this.confirmSyncPush('boms', updatedBom);

    if (committedProducts.length > 0) {
      const nextProducts = [...this.getProducts()];
      committedProducts.forEach(cp => {
        const idx = nextProducts.findIndex(p => p.id === cp.id);
        if (idx >= 0) nextProducts[idx] = cp;
      });
      this.memStore.set(STORAGE_KEYS.PRODUCTS, nextProducts);
    }

    if (committedMovements.length > 0) {
      const committedIds = new Set(committedMovements.map(m => m.id));
      this.memStore.set(STORAGE_KEYS.STOCK_MOVEMENTS, [
        ...committedMovements.reverse(),
        ...this.getStockMovements().filter(m => !committedIds.has(m.id))
      ]);
    }

    const nextBoms = [...this.getBOMs()];
    const bomIdx = nextBoms.findIndex(b => b.id === committedBom.id);
    if (bomIdx >= 0) {
      nextBoms[bomIdx] = committedBom;
    } else {
      nextBoms.unshift(committedBom);
    }
    this.memStore.set(STORAGE_KEYS.BOMS, nextBoms);
    this.notifyStorageUpdated();
    return committedBom;
  }

  async deleteBOMAsync(id: string): Promise<void> {
    await this.confirmSyncDelete('boms', id);
    const nextBoms = this.getBOMs().filter(b => b.id !== id);
    this.memStore.set(STORAGE_KEYS.BOMS, nextBoms);
    this.notifyStorageUpdated();
  }

  saveBOM(bom: BillOfMaterials): void {
    const boms = this.getBOMs();
    const validation = validateBOM(bom, boms, bom.id);
    assertValid(validation);

    const idx = boms.findIndex(b => b.id === bom.id);
    const nextList = [...boms];
    if (idx >= 0) {
      nextList[idx] = { ...bom, updatedAt: new Date().toISOString() };
    } else {
      nextList.unshift({
        ...bom,
        id: bom.id || `bom-${Date.now()}`,
        createdAt: bom.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }
    this.set(STORAGE_KEYS.BOMS, nextList, bom);
  }

  allocateBOMStock(bomId: string, performedBy: string = 'Project Engineer'): boolean {
    const boms = this.getBOMs();
    const bom = boms.find(b => b.id === bomId);
    if (!bom) return false;

    const products = this.getProducts();
    let hasUpdatedStock = false;

    bom.items.forEach(item => {
      const prod = products.find(p => p.id === item.productId || p.sku === item.sku);
      if (prod && item.requiredQty > 0) {
        prod.currentStock = Math.max(0, prod.currentStock - item.requiredQty);
        if (bom.warehouseId) {
          prod.warehouseStocks = prod.warehouseStocks || {};
          prod.warehouseStocks[bom.warehouseId] = Math.max(0, (prod.warehouseStocks[bom.warehouseId] || prod.currentStock) - item.requiredQty);
        }
        item.allocatedQty = item.requiredQty;
        item.status = 'ALLOCATED';
        hasUpdatedStock = true;

        this.addStockMovement({
          productId: prod.id,
          productName: prod.name,
          sku: prod.sku,
          movementType: 'BOM_ALLOCATION',
          quantity: -item.requiredQty,
          balanceAfter: prod.currentStock,
          warehouseId: bom.warehouseId,
          warehouseName: bom.warehouseName,
          referenceId: bom.id,
          referenceNumber: bom.bomNumber,
          notes: `BOM allocation for ${bom.projectTitle} (${bom.customerName})${bom.warehouseName ? ' from ' + bom.warehouseName : ''}`,
          performedBy
        });
      }
    });

    if (hasUpdatedStock) {
      this.set(STORAGE_KEYS.PRODUCTS, products);
      bom.stockAllocated = true;
      if (bom.status === 'DRAFT') {
        bom.status = 'APPROVED';
      }
      bom.updatedAt = new Date().toISOString();
      this.set(STORAGE_KEYS.BOMS, boms);
      return true;
    }

    return false;
  }

  deleteBOM(id: string): void {
    const boms = this.getBOMs().filter(b => b.id !== id);
    this.memStore.set(STORAGE_KEYS.BOMS, boms);
    this.deleteSync('boms', id);
  }

  // ==========================================
  // Sales Invoices
  // ==========================================
  getSalesInvoices(): SalesInvoice[] {
    return this.get<SalesInvoice[]>(STORAGE_KEYS.SALES_INVOICES, initialSalesInvoices);
  }

  async saveSalesInvoiceAsync(
    invoice: SalesInvoice,
    deductStockNow: boolean = false,
    performedBy: string = 'Accounts Officer'
  ): Promise<SalesInvoice> {
    const invoices = this.getSalesInvoices();
    if (!invoice.customerId && !invoice.customerName?.trim()) {
      throw new Error('Customer selection is required before saving an invoice.');
    }
    if (!Array.isArray(invoice.items) || invoice.items.length === 0) {
      throw new Error('Please include at least one billable line item on the invoice.');
    }
    const normInvNum = (invoice.invoiceNumber || '').trim().toUpperCase();
    if (normInvNum) {
      const dupInv = invoices.find(
        i => i.id !== invoice.id && (i.invoiceNumber || '').trim().toUpperCase() === normInvNum
      );
      if (dupInv) {
        throw new Error(`Sales invoice number "${invoice.invoiceNumber}" already exists.`);
      }
    }

    const now = new Date().toISOString();
    const existingInv = invoices.find(i => i.id === invoice.id);

    const updated: SalesInvoice = {
      ...invoice,
      id: invoice.id || `inv-${Date.now()}`,
      stockDeducted: Boolean(invoice.stockDeducted ?? existingInv?.stockDeducted ?? false),
      createdAt: invoice.createdAt || existingInv?.createdAt || now,
      updatedAt: now
    };

    const productClones = new Map<string, ProductItem>();
    const newMovements: StockMovement[] = [];
    const isFinalStatus = updated.status !== 'DRAFT' && updated.status !== 'CANCELLED';
    const shouldDeduct = isFinalStatus && (deductStockNow || updated.deductStock) && !updated.stockDeducted;

    if (shouldDeduct) {
      const currentProducts = this.getProducts();
      const defaultWh = this.getDefaultWarehouse();

      updated.items.forEach(item => {
        if (item.productId && item.quantity > 0) {
          const baseProd = currentProducts.find(p => p.id === item.productId);
          if (baseProd) {
            const prod = productClones.get(baseProd.id) || {
              ...baseProd,
              warehouseStocks: { ...(baseProd.warehouseStocks || {}) }
            };
            prod.currentStock = Math.max(0, (prod.currentStock || 0) - item.quantity);
            const targetWhId = prod.warehouseId || defaultWh?.id;
            const targetWhName = prod.warehouseName || defaultWh?.name;
            if (targetWhId && prod.warehouseStocks && prod.warehouseStocks[targetWhId] !== undefined) {
              prod.warehouseStocks[targetWhId] = Math.max(0, prod.warehouseStocks[targetWhId] - item.quantity);
            }
            prod.updatedAt = now;
            productClones.set(prod.id, prod);

            newMovements.push({
              id: `sm-${Date.now()}-${newMovements.length}-${Math.floor(Math.random() * 1000)}`,
              productId: prod.id,
              productName: prod.name,
              sku: prod.sku,
              movementType: 'INVOICE_SALE',
              quantity: -item.quantity,
              balanceAfter: prod.currentStock,
              warehouseId: targetWhId,
              warehouseName: targetWhName,
              referenceId: updated.id,
              referenceNumber: updated.invoiceNumber,
              notes: `Dispatched to ${updated.customerName} via Invoice ${updated.invoiceNumber}`,
              performedBy,
              timestamp: now
            });
          }
        }
      });

      if (productClones.size > 0) {
        updated.stockDeducted = true;
      }
    }

    const committedProducts = await Promise.all(
      Array.from(productClones.values()).map(p => this.confirmSyncPush('products', p))
    );
    const committedMovements = await Promise.all(
      newMovements.map(m => this.confirmSyncPush('stock_movements', m))
    );
    const committedInvoice = await this.confirmSyncPush('sales_invoices', updated);

    if (committedProducts.length > 0) {
      const nextProducts = [...this.getProducts()];
      committedProducts.forEach(cp => {
        const idx = nextProducts.findIndex(p => p.id === cp.id);
        if (idx >= 0) nextProducts[idx] = cp;
      });
      this.memStore.set(STORAGE_KEYS.PRODUCTS, nextProducts);
    }

    if (committedMovements.length > 0) {
      const committedIds = new Set(committedMovements.map(m => m.id));
      this.memStore.set(STORAGE_KEYS.STOCK_MOVEMENTS, [
        ...committedMovements.reverse(),
        ...this.getStockMovements().filter(m => !committedIds.has(m.id))
      ]);
    }

    const nextInvoices = [...this.getSalesInvoices()];
    const idx = nextInvoices.findIndex(i => i.id === committedInvoice.id);
    if (idx >= 0) {
      nextInvoices[idx] = committedInvoice;
    } else {
      nextInvoices.unshift(committedInvoice);
    }
    this.memStore.set(STORAGE_KEYS.SALES_INVOICES, nextInvoices);

    const requestedPaid = Number((invoice as any).paidAmount || (invoice as any).amountPaid || 0);
    const prevPaid = Number(existingInv?.paidAmount || 0);
    if (
      committedInvoice.status !== 'DRAFT' &&
      committedInvoice.status !== 'CANCELLED' &&
      (requestedPaid > prevPaid + 0.01 || committedInvoice.status === 'PAID' || committedInvoice.status === 'PARTIAL')
    ) {
      const [payments, projects] = await Promise.all([
        apiClient.getPayments().catch(() => null),
        apiClient.getProjects().catch(() => null)
      ]);
      if (Array.isArray(payments)) this.memStore.set(STORAGE_KEYS.PAYMENTS, payments);
      if (Array.isArray(projects)) this.memStore.set(STORAGE_KEYS.PROJECTS, projects);
    }

    this.notifyStorageUpdated();
    return committedInvoice;
  }

  async deleteSalesInvoiceAsync(id: string): Promise<void> {
    await this.confirmSyncDelete('sales_invoices', id);
    const nextInvoices = this.getSalesInvoices().filter(i => i.id !== id);
    this.memStore.set(STORAGE_KEYS.SALES_INVOICES, nextInvoices);
    this.notifyStorageUpdated();
  }

  saveSalesInvoice(invoice: SalesInvoice, deductStockNow: boolean = false, performedBy: string = 'Accounts Officer'): void {
    const invoices = this.getSalesInvoices();
    const idx = invoices.findIndex(i => i.id === invoice.id);

    let updated = { ...invoice, updatedAt: new Date().toISOString() };
    if (!updated.id) {
      updated.id = `inv-${Date.now()}`;
      updated.createdAt = new Date().toISOString();
    }

    const shouldDeduct = (deductStockNow || updated.deductStock) && !updated.stockDeducted;

    if (shouldDeduct) {
      const products = this.getProducts();
      let deductedAny = false;

      updated.items.forEach(item => {
        if (item.productId && item.quantity > 0) {
          const prod = products.find(p => p.id === item.productId);
          if (prod) {
            prod.currentStock = Math.max(0, prod.currentStock - item.quantity);
            prod.updatedAt = new Date().toISOString();
            deductedAny = true;

            this.addStockMovement({
              productId: prod.id,
              productName: prod.name,
              sku: prod.sku,
              movementType: 'INVOICE_SALE',
              quantity: -item.quantity,
              balanceAfter: prod.currentStock,
              referenceId: updated.id,
              referenceNumber: updated.invoiceNumber,
              notes: `Dispatched to ${updated.customerName} via Invoice ${updated.invoiceNumber}`,
              performedBy
            });
          }
        }
      });

      if (deductedAny) {
        this.set(STORAGE_KEYS.PRODUCTS, products);
        updated.stockDeducted = true;
      }
    }

    if (idx >= 0) {
      invoices[idx] = updated;
    } else {
      invoices.unshift(updated);
    }
    this.set(STORAGE_KEYS.SALES_INVOICES, invoices, updated);
  }

  deleteSalesInvoice(id: string): void {
    const invoices = this.getSalesInvoices().filter(i => i.id !== id);
    this.memStore.set(STORAGE_KEYS.SALES_INVOICES, invoices);
    this.deleteSync('sales_invoices', id);
  }

  // ==========================================
  // Vendor Sales Invoices (Admin-Only MySQL)
  // ==========================================
  getVendorSalesInvoices(): VendorSalesInvoice[] {
    return this.get<VendorSalesInvoice[]>(STORAGE_KEYS.VENDOR_SALES_INVOICES, initialVendorSalesInvoices);
  }

  async fetchVendorSalesInvoicesAsync(): Promise<VendorSalesInvoice[]> {
    const list = await apiClient.getVendorSalesInvoices();
    const cleaned = Array.isArray(list) ? list : [];
    this.memStore.set(STORAGE_KEYS.VENDOR_SALES_INVOICES, cleaned);
    this.notifyStorageUpdated();
    return cleaned;
  }

  async getNextVendorSalesInvoiceNumberAsync(): Promise<string> {
    return await apiClient.getNextVendorSalesInvoiceNumber();
  }

  async saveVendorSalesInvoiceAsync(
    invoice: Partial<VendorSalesInvoice>,
    isEdit: boolean = false
  ): Promise<VendorSalesInvoice> {
    const saved = await apiClient.saveVendorSalesInvoice(invoice, isEdit);
    const nextList = [...this.getVendorSalesInvoices()];
    const idx = nextList.findIndex(i => i.id === saved.id);
    if (idx >= 0) {
      nextList[idx] = saved;
    } else {
      nextList.unshift(saved);
    }
    this.memStore.set(STORAGE_KEYS.VENDOR_SALES_INVOICES, nextList);
    this.notifyStorageUpdated();
    return saved;
  }

  async recordVendorSalesPaymentAsync(
    invoiceId: string,
    payment: { amount: number; paymentDate?: string; paymentMode?: string; bankAccountId?: string; referenceNo?: string; notes?: string }
  ): Promise<VendorSalesInvoice> {
    const updated = await apiClient.recordVendorSalesPayment(invoiceId, payment);
    const nextList = [...this.getVendorSalesInvoices()];
    const idx = nextList.findIndex(i => i.id === updated.id);
    if (idx >= 0) {
      nextList[idx] = updated;
    } else {
      nextList.unshift(updated);
    }
    this.memStore.set(STORAGE_KEYS.VENDOR_SALES_INVOICES, nextList);
    this.notifyStorageUpdated();
    return updated;
  }

  async deleteVendorSalesInvoiceAsync(id: string): Promise<void> {
    await apiClient.deleteVendorSalesInvoice(id);
    const nextList = this.getVendorSalesInvoices().filter(i => i.id !== id);
    this.memStore.set(STORAGE_KEYS.VENDOR_SALES_INVOICES, nextList);
    this.notifyStorageUpdated();
  }

  // ==========================================
  // Bank Account Selection & Invoice/PO Payments + Returns
  // ==========================================
  async fetchAccountingBankAccountsAsync(): Promise<any[]> {
    return await apiClient.getAccountingBankAccounts();
  }

  async recordSalesInvoicePaymentAsync(
    invoiceId: string,
    payment: {
      amount: number;
      paymentDate?: string;
      paymentMode?: string;
      bankAccountId: string;
      referenceNo?: string;
      notes?: string;
    }
  ): Promise<any> {
    const res = await apiClient.recordSalesInvoicePayment(invoiceId, payment);
    const [invoices, payments, projects] = await Promise.all([
      apiClient.getSalesInvoices().catch(() => null),
      apiClient.getPayments().catch(() => null),
      apiClient.getProjects().catch(() => null)
    ]);
    if (Array.isArray(invoices)) this.memStore.set(STORAGE_KEYS.SALES_INVOICES, invoices);
    if (Array.isArray(payments)) this.memStore.set(STORAGE_KEYS.PAYMENTS, payments);
    if (Array.isArray(projects)) this.memStore.set(STORAGE_KEYS.PROJECTS, projects);
    this.notifyStorageUpdated();
    return res;
  }

  async recordPurchaseOrderPaymentAsync(
    poId: string,
    payment: {
      amount: number;
      tdsDeducted?: number;
      tdsSection?: string;
      paymentDate?: string;
      paymentMode?: string;
      bankAccountId: string;
      referenceNo?: string;
      notes?: string;
    }
  ): Promise<any> {
    const res = await apiClient.recordPurchaseOrderPayment(poId, payment);
    const [orders, projects] = await Promise.all([
      apiClient.getPurchaseOrders().catch(() => null),
      apiClient.getProjects().catch(() => null)
    ]);
    if (Array.isArray(orders)) this.memStore.set(STORAGE_KEYS.PURCHASE_ORDERS, orders);
    if (Array.isArray(projects)) this.memStore.set(STORAGE_KEYS.PROJECTS, projects);
    this.notifyStorageUpdated();
    return res;
  }

  getSalesReturns(): SalesReturn[] {
    return this.get<SalesReturn[]>(STORAGE_KEYS.SALES_RETURNS, initialSalesReturns);
  }

  async fetchSalesReturnsAsync(): Promise<SalesReturn[]> {
    const list = await apiClient.getSalesReturns();
    const cleaned = Array.isArray(list) ? list : [];
    this.memStore.set(STORAGE_KEYS.SALES_RETURNS, cleaned);
    this.notifyStorageUpdated();
    return cleaned;
  }

  async createSalesReturnAsync(payload: any): Promise<any> {
    const res = await apiClient.createSalesReturn(payload);
    const [returnsList, salesInvoices, vendorSalesInvoices, products, stockMovements, projects] = await Promise.all([
      apiClient.getSalesReturns().catch(() => null),
      apiClient.getSalesInvoices().catch(() => null),
      apiClient.getVendorSalesInvoices().catch(() => null),
      apiClient.getProducts().catch(() => null),
      apiClient.getStockMovements().catch(() => null),
      apiClient.getProjects().catch(() => null)
    ]);
    if (Array.isArray(returnsList)) this.memStore.set(STORAGE_KEYS.SALES_RETURNS, returnsList);
    if (Array.isArray(salesInvoices)) this.memStore.set(STORAGE_KEYS.SALES_INVOICES, salesInvoices);
    if (Array.isArray(vendorSalesInvoices)) this.memStore.set(STORAGE_KEYS.VENDOR_SALES_INVOICES, vendorSalesInvoices);
    if (Array.isArray(products)) this.memStore.set(STORAGE_KEYS.PRODUCTS, products);
    if (Array.isArray(stockMovements)) this.memStore.set(STORAGE_KEYS.STOCK_MOVEMENTS, stockMovements);
    if (Array.isArray(projects)) this.memStore.set(STORAGE_KEYS.PROJECTS, projects);
    this.notifyStorageUpdated();
    return res;
  }

  async deleteSalesReturnAsync(id: string): Promise<void> {
    await apiClient.deleteSalesReturn(id);
    const [returnsList, salesInvoices, vendorSalesInvoices, products, stockMovements, projects] = await Promise.all([
      apiClient.getSalesReturns().catch(() => null),
      apiClient.getSalesInvoices().catch(() => null),
      apiClient.getVendorSalesInvoices().catch(() => null),
      apiClient.getProducts().catch(() => null),
      apiClient.getStockMovements().catch(() => null),
      apiClient.getProjects().catch(() => null)
    ]);
    if (Array.isArray(returnsList)) {
      this.memStore.set(STORAGE_KEYS.SALES_RETURNS, returnsList);
    } else {
      this.memStore.set(STORAGE_KEYS.SALES_RETURNS, this.getSalesReturns().filter(r => r.id !== id));
    }
    if (Array.isArray(salesInvoices)) this.memStore.set(STORAGE_KEYS.SALES_INVOICES, salesInvoices);
    if (Array.isArray(vendorSalesInvoices)) this.memStore.set(STORAGE_KEYS.VENDOR_SALES_INVOICES, vendorSalesInvoices);
    if (Array.isArray(products)) this.memStore.set(STORAGE_KEYS.PRODUCTS, products);
    if (Array.isArray(stockMovements)) this.memStore.set(STORAGE_KEYS.STOCK_MOVEMENTS, stockMovements);
    if (Array.isArray(projects)) this.memStore.set(STORAGE_KEYS.PROJECTS, projects);
    this.notifyStorageUpdated();
  }

  getPurchaseReturns(): PurchaseReturn[] {
    return this.get<PurchaseReturn[]>(STORAGE_KEYS.PURCHASE_RETURNS, initialPurchaseReturns);
  }

  async fetchPurchaseReturnsAsync(): Promise<PurchaseReturn[]> {
    const list = await apiClient.getPurchaseReturns();
    const cleaned = Array.isArray(list) ? list : [];
    this.memStore.set(STORAGE_KEYS.PURCHASE_RETURNS, cleaned);
    this.notifyStorageUpdated();
    return cleaned;
  }

  async createPurchaseReturnAsync(payload: any): Promise<any> {
    const res = await apiClient.createPurchaseReturn(payload);
    const [returnsList, purchaseOrders, products, stockMovements] = await Promise.all([
      apiClient.getPurchaseReturns().catch(() => null),
      apiClient.getPurchaseOrders().catch(() => null),
      apiClient.getProducts().catch(() => null),
      apiClient.getStockMovements().catch(() => null)
    ]);
    if (Array.isArray(returnsList)) this.memStore.set(STORAGE_KEYS.PURCHASE_RETURNS, returnsList);
    if (Array.isArray(purchaseOrders)) this.memStore.set(STORAGE_KEYS.PURCHASE_ORDERS, purchaseOrders);
    if (Array.isArray(products)) this.memStore.set(STORAGE_KEYS.PRODUCTS, products);
    if (Array.isArray(stockMovements)) this.memStore.set(STORAGE_KEYS.STOCK_MOVEMENTS, stockMovements);
    this.notifyStorageUpdated();
    return res;
  }

  async deletePurchaseReturnAsync(id: string): Promise<void> {
    await apiClient.deletePurchaseReturn(id);
    const [returnsList, purchaseOrders, products, stockMovements] = await Promise.all([
      apiClient.getPurchaseReturns().catch(() => null),
      apiClient.getPurchaseOrders().catch(() => null),
      apiClient.getProducts().catch(() => null),
      apiClient.getStockMovements().catch(() => null)
    ]);
    if (Array.isArray(returnsList)) {
      this.memStore.set(STORAGE_KEYS.PURCHASE_RETURNS, returnsList);
    } else {
      this.memStore.set(STORAGE_KEYS.PURCHASE_RETURNS, this.getPurchaseReturns().filter(r => r.id !== id));
    }
    if (Array.isArray(purchaseOrders)) this.memStore.set(STORAGE_KEYS.PURCHASE_ORDERS, purchaseOrders);
    if (Array.isArray(products)) this.memStore.set(STORAGE_KEYS.PRODUCTS, products);
    if (Array.isArray(stockMovements)) this.memStore.set(STORAGE_KEYS.STOCK_MOVEMENTS, stockMovements);
    this.notifyStorageUpdated();
  }

  // ==========================================
  // Stock Movements
  // ==========================================
  getStockMovements(): StockMovement[] {
    return this.get<StockMovement[]>(STORAGE_KEYS.STOCK_MOVEMENTS, initialStockMovements);
  }

  async addStockMovementAsync(movement: Omit<StockMovement, 'id' | 'timestamp'>): Promise<StockMovement> {
    const newMovement: StockMovement = {
      ...movement,
      id: `sm-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      timestamp: new Date().toISOString()
    };
    const committed = await this.confirmSyncPush('stock_movements', newMovement);
    this.memStore.set(STORAGE_KEYS.STOCK_MOVEMENTS, [
      committed,
      ...this.getStockMovements().filter(m => m.id !== committed.id)
    ]);
    this.notifyStorageUpdated();
    return committed;
  }

  addStockMovement(movement: Omit<StockMovement, 'id' | 'timestamp'>): void {
    const movements = this.getStockMovements();
    movements.unshift({
      ...movement,
      id: `sm-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      timestamp: new Date().toISOString()
    });
    this.set(STORAGE_KEYS.STOCK_MOVEMENTS, movements);
  }

  // ==========================================
  // Role-Based Access Control (ACL)
  // ==========================================
  getAclConfig(): SystemAclConfig {
    const raw = this.get<any>(STORAGE_KEYS.ACL_CONFIG, DEFAULT_SYSTEM_ACL_CONFIG);
    let source: Record<string, any> | null = null;

    if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'object' && !Array.isArray(raw[0])) {
      source = raw[0];
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      source = raw;
    }

    if (!source) {
      return DEFAULT_SYSTEM_ACL_CONFIG;
    }

    const merged: Record<string, Record<string, boolean>> = {};
    (Object.keys(DEFAULT_SYSTEM_ACL_CONFIG) as UserRole[]).forEach((role) => {
      merged[role] = {
        ...(DEFAULT_SYSTEM_ACL_CONFIG[role] || {}),
        ...(source![role] && typeof source![role] === 'object' ? source![role] : {})
      };
    });

    return merged as SystemAclConfig;
  }

  saveAclConfig(config: SystemAclConfig): void {
    this.set(STORAGE_KEYS.ACL_CONFIG, config, config);
  }

  updateRolePermissions(
    role: UserRole,
    permissions: Record<string, boolean>,
    changedBy = 'System Admin',
    summary?: string
  ): void {
    const config = this.getAclConfig();
    config[role] = {
      ...(config[role] || {}),
      ...permissions
    };

    // If Admin, ensure core root permissions cannot be accidentally ungranted
    if (role === 'Admin') {
      config['Admin']['settings.acl_manage'] = true;
      config['Admin']['settings.manage'] = true;
      config['Admin']['settings.view'] = true;
    }

    this.saveAclConfig(config);

    const defaultSummary = summary || `Updated ${Object.keys(permissions).length} operational permissions for ${role}`;
    this.addAclAuditLog({
      changedBy,
      targetRole: role,
      action: 'UPDATE_PERMISSIONS',
      summary: defaultSummary
    });
  }

  resetRoleAclToDefault(role: UserRole, changedBy = 'System Admin'): SystemAclConfig {
    const config = this.getAclConfig();
    config[role] = { ...(DEFAULT_SYSTEM_ACL_CONFIG[role] || {}) };
    this.saveAclConfig(config);

    this.addAclAuditLog({
      changedBy,
      targetRole: role,
      action: 'RESET_ROLE',
      summary: `Restored standard Solar EPC default permissions for ${role}`
    });

    return config;
  }

  resetAllAclToDefault(changedBy = 'System Admin'): SystemAclConfig {
    const deepClone = JSON.parse(JSON.stringify(DEFAULT_SYSTEM_ACL_CONFIG));
    this.saveAclConfig(deepClone);

    this.addAclAuditLog({
      changedBy,
      targetRole: 'Admin',
      action: 'RESET_ROLE',
      summary: 'Restored baseline Solar EPC permissions for all 15 operational roles'
    });

    return deepClone;
  }

  private isAdminRole(role?: UserRole | string): boolean {
    const norm = String(role || '').trim().toLowerCase();
    return norm === 'admin' || norm === 'super admin';
  }

  hasAclPermission(role: UserRole, permissionId: string): boolean {
    if (this.isAdminRole(role)) return true;
    const config = this.getAclConfig();
    const rolePerms = config[role];
    if (!rolePerms) return false;
    return Boolean(rolePerms[permissionId]);
  }

  assertPermission(role: UserRole, permissionId: string, actionDescription?: string): void {
    if (this.isAdminRole(role)) return;
    if (!this.hasAclPermission(role, permissionId)) {
      throw new Error(`Security Exception: Access Denied. Role "${role}" is not authorized to ${actionDescription || permissionId}.`);
    }
  }

  assertAdmin(role: UserRole, actionDescription?: string): void {
    if (!this.isAdminRole(role)) {
      throw new Error(`Security Exception: Access Denied. Role "${role}" is not authorized for administrative operation: ${actionDescription || 'Admin access required'}.`);
    }
  }

  getAclAuditLogs(): AclAuditLogEntry[] {
    return this.get<AclAuditLogEntry[]>(STORAGE_KEYS.ACL_AUDIT_LOGS, initialAclAuditLogs);
  }

  addAclAuditLog(log: Omit<AclAuditLogEntry, 'id' | 'timestamp'>): void {
    const logs = this.getAclAuditLogs();
    logs.unshift({
      ...log,
      id: `acl-log-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      timestamp: new Date().toISOString()
    });
    // Keep max 50 recent audit records
    this.set(STORAGE_KEYS.ACL_AUDIT_LOGS, logs.slice(0, 50));
  }

  // ==========================================
  // Multi-Warehouse Management
  // ==========================================
  getWarehouses(): Warehouse[] {
    return this.get<Warehouse[]>(STORAGE_KEYS.WAREHOUSES, initialWarehouses);
  }

  async saveWarehouseAsync(warehouse: Warehouse): Promise<Warehouse> {
    const list = this.getWarehouses();
    const now = new Date().toISOString();
    const existing = list.find(w => w.id === warehouse.id);
    const candidate: Warehouse = {
      ...warehouse,
      id: warehouse.id || `wh-${Date.now()}`,
      createdAt: warehouse.createdAt || existing?.createdAt || now,
      updatedAt: now
    };

    const committed = await this.confirmSyncPush('warehouses', candidate);
    let nextList = list.map(w =>
      committed.isDefault && w.id !== committed.id ? { ...w, isDefault: false } : w
    );
    const idx = nextList.findIndex(w => w.id === committed.id);
    if (idx >= 0) {
      nextList[idx] = committed;
    } else {
      nextList = [committed, ...nextList];
    }
    this.memStore.set(STORAGE_KEYS.WAREHOUSES, nextList);
    this.notifyStorageUpdated();
    return committed;
  }

  async deleteWarehouseAsync(id: string): Promise<void> {
    const list = this.getWarehouses();
    const target = list.find(w => w.id === id);
    if (!target) {
      throw new Error('Warehouse not found in MySQL.');
    }
    if (target.isDefault) {
      throw new Error('Cannot delete the default warehouse. Please mark another warehouse as default first.');
    }
    await this.confirmSyncDelete('warehouses', id);
    const nextList = list.filter(w => w.id !== id);
    this.memStore.set(STORAGE_KEYS.WAREHOUSES, nextList);
    this.notifyStorageUpdated();
  }

  saveWarehouse(warehouse: Warehouse): void {
    const list = this.getWarehouses();
    const idx = list.findIndex(w => w.id === warehouse.id);
    const nextList = list.map(w =>
      warehouse.isDefault && w.id !== warehouse.id ? { ...w, isDefault: false } : w
    );
    if (idx >= 0) {
      nextList[idx] = { ...warehouse, updatedAt: new Date().toISOString() };
    } else {
      nextList.push({ ...warehouse, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    this.set(STORAGE_KEYS.WAREHOUSES, nextList, warehouse);
  }

  deleteWarehouse(id: string): { success: boolean; message?: string } {
    const list = this.getWarehouses();
    const target = list.find(w => w.id === id);
    if (!target) return { success: false, message: 'Warehouse not found' };
    if (target.isDefault) {
      return { success: false, message: 'Cannot delete the default warehouse. Please mark another warehouse as default first.' };
    }
    const updated = list.filter(w => w.id !== id);
    this.memStore.set(STORAGE_KEYS.WAREHOUSES, updated);
    this.deleteSync('warehouses', id);
    return { success: true };
  }

  getDefaultWarehouse(): Warehouse {
    const list = this.getWarehouses();
    return list.find(w => w.isDefault && w.status === 'ACTIVE') || list[0] || ({} as any);
  }

  getStockAudits(): StockAuditRecord[] {
    return this.get<StockAuditRecord[]>(STORAGE_KEYS.STOCK_AUDITS, initialStockAudits);
  }

  async saveStockAuditAsync(audit: StockAuditRecord): Promise<StockAuditRecord> {
    const list = this.getStockAudits();
    const candidate: StockAuditRecord = {
      ...audit,
      id: audit.id || `audit-${Date.now()}`,
      createdAt: audit.createdAt || new Date().toISOString()
    };
    const committed = await this.confirmSyncPush('stock_audits', candidate);
    const nextList = [...list];
    const idx = nextList.findIndex(a => a.id === committed.id);
    if (idx >= 0) {
      nextList[idx] = committed;
    } else {
      nextList.unshift(committed);
    }
    this.memStore.set(STORAGE_KEYS.STOCK_AUDITS, nextList);
    this.notifyStorageUpdated();
    return committed;
  }

  saveStockAudit(audit: StockAuditRecord): void {
    const list = this.getStockAudits();
    const idx = list.findIndex(a => a.id === audit.id);
    const nextList = [...list];
    if (idx >= 0) {
      nextList[idx] = audit;
    } else {
      nextList.unshift(audit);
    }
    this.set(STORAGE_KEYS.STOCK_AUDITS, nextList, audit);
  }

  async transferStockAsync(
    productId: string,
    fromWarehouseId: string,
    toWarehouseId: string,
    quantity: number,
    notes: string,
    performedBy: string = 'Inventory Manager'
  ): Promise<{ product: ProductItem; movements: StockMovement[] }> {
    const products = this.getProducts();
    const prod = products.find(p => p.id === productId);
    if (!prod) {
      throw new Error('Product not found in MySQL.');
    }
    if (quantity <= 0) {
      throw new Error('Transfer quantity must be greater than 0.');
    }
    if (fromWarehouseId === toWarehouseId) {
      throw new Error('Source and destination warehouses must be different.');
    }

    const warehouses = this.getWarehouses();
    const fromWh = warehouses.find(w => w.id === fromWarehouseId);
    const toWh = warehouses.find(w => w.id === toWarehouseId);
    if (!fromWh || !toWh) {
      throw new Error('Source or destination warehouse is invalid.');
    }

    const nextWhStocks = { ...(prod.warehouseStocks || {}) };
    const currentFromStock = nextWhStocks[fromWarehouseId] ?? (fromWh.isDefault || !prod.warehouseStocks ? prod.currentStock : 0);
    if (currentFromStock < quantity) {
      throw new Error(`Insufficient stock at ${fromWh.name}. Available: ${currentFromStock} ${prod.unit}`);
    }

    nextWhStocks[fromWarehouseId] = currentFromStock - quantity;
    nextWhStocks[toWarehouseId] = (nextWhStocks[toWarehouseId] ?? 0) + quantity;
    const now = new Date().toISOString();

    const updatedProd: ProductItem = {
      ...prod,
      warehouseStocks: nextWhStocks,
      updatedAt: now
    };

    const outMovement: StockMovement = {
      id: `sm-${Date.now()}-out-${Math.floor(Math.random() * 1000)}`,
      productId: updatedProd.id,
      productName: updatedProd.name,
      sku: updatedProd.sku,
      movementType: 'WAREHOUSE_TRANSFER',
      quantity: -quantity,
      balanceAfter: nextWhStocks[fromWarehouseId],
      warehouseId: fromWarehouseId,
      warehouseName: fromWh.name,
      targetWarehouseId: toWarehouseId,
      targetWarehouseName: toWh.name,
      notes: notes || `Transferred ${quantity} ${updatedProd.unit} from ${fromWh.name} to ${toWh.name}`,
      performedBy,
      timestamp: now
    };

    const inMovement: StockMovement = {
      id: `sm-${Date.now()}-in-${Math.floor(Math.random() * 1000)}`,
      productId: updatedProd.id,
      productName: updatedProd.name,
      sku: updatedProd.sku,
      movementType: 'WAREHOUSE_TRANSFER',
      quantity: quantity,
      balanceAfter: nextWhStocks[toWarehouseId],
      warehouseId: toWarehouseId,
      warehouseName: toWh.name,
      targetWarehouseId: fromWarehouseId,
      targetWarehouseName: fromWh.name,
      notes: notes || `Received transfer of ${quantity} ${updatedProd.unit} from ${fromWh.name}`,
      performedBy,
      timestamp: now
    };

    const committedProd = await this.confirmSyncPush('products', updatedProd);
    const committedOut = await this.confirmSyncPush('stock_movements', outMovement);
    const committedIn = await this.confirmSyncPush('stock_movements', inMovement);

    const nextProducts = [...this.getProducts()];
    const idx = nextProducts.findIndex(p => p.id === committedProd.id);
    if (idx >= 0) nextProducts[idx] = committedProd;
    this.memStore.set(STORAGE_KEYS.PRODUCTS, nextProducts);

    const committedIds = new Set([committedOut.id, committedIn.id]);
    this.memStore.set(STORAGE_KEYS.STOCK_MOVEMENTS, [
      committedIn,
      committedOut,
      ...this.getStockMovements().filter(m => !committedIds.has(m.id))
    ]);
    this.notifyStorageUpdated();

    return { product: committedProd, movements: [committedOut, committedIn] };
  }

  transferStock(
    productId: string,
    fromWarehouseId: string,
    toWarehouseId: string,
    quantity: number,
    notes: string,
    performedBy: string = 'Inventory Manager'
  ): { success: boolean; message?: string } {
    const products = this.getProducts();
    const prod = products.find(p => p.id === productId);
    if (!prod) return { success: false, message: 'Product not found' };
    if (quantity <= 0) return { success: false, message: 'Transfer quantity must be greater than 0' };

    const warehouses = this.getWarehouses();
    const fromWh = warehouses.find(w => w.id === fromWarehouseId);
    const toWh = warehouses.find(w => w.id === toWarehouseId);
    if (!fromWh || !toWh) return { success: false, message: 'Source or destination warehouse invalid' };

    prod.warehouseStocks = prod.warehouseStocks || {};
    const currentFromStock = prod.warehouseStocks[fromWarehouseId] ?? prod.currentStock;
    if (currentFromStock < quantity) {
      return { success: false, message: `Insufficient stock at ${fromWh.name}. Available: ${currentFromStock} ${prod.unit}` };
    }

    prod.warehouseStocks[fromWarehouseId] = currentFromStock - quantity;
    prod.warehouseStocks[toWarehouseId] = (prod.warehouseStocks[toWarehouseId] ?? 0) + quantity;
    prod.updatedAt = new Date().toISOString();
    this.set(STORAGE_KEYS.PRODUCTS, products);

    this.addStockMovement({
      productId: prod.id,
      productName: prod.name,
      sku: prod.sku,
      movementType: 'WAREHOUSE_TRANSFER',
      quantity: -quantity,
      balanceAfter: prod.warehouseStocks[fromWarehouseId],
      warehouseId: fromWarehouseId,
      warehouseName: fromWh.name,
      targetWarehouseId: toWarehouseId,
      targetWarehouseName: toWh.name,
      notes: notes || `Transferred ${quantity} ${prod.unit} from ${fromWh.name} to ${toWh.name}`,
      performedBy
    });

    this.addStockMovement({
      productId: prod.id,
      productName: prod.name,
      sku: prod.sku,
      movementType: 'WAREHOUSE_TRANSFER',
      quantity: quantity,
      balanceAfter: prod.warehouseStocks[toWarehouseId],
      warehouseId: toWarehouseId,
      warehouseName: toWh.name,
      targetWarehouseId: fromWarehouseId,
      targetWarehouseName: fromWh.name,
      notes: notes || `Received transfer of ${quantity} ${prod.unit} from ${fromWh.name}`,
      performedBy
    });

    return { success: true };
  }

  // Clear local browser cache and refresh state from production MySQL
  clearLocalCacheAndRefresh(): void {
    this.memStore.clear();
    if (typeof window !== 'undefined') {
      try {
        Object.values(STORAGE_KEYS).forEach(k => {
          safeStorage.removeItem(k);
          safeSessionStorage.removeItem(k);
        });
      } catch {}
      window.location.reload();
    }
  }

  resetAllData(): void {
    this.clearLocalCacheAndRefresh();
  }
}

export const storageService = new StorageService();
