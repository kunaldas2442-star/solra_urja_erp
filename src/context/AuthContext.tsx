import React, { createContext, useContext, useState, useEffect } from 'react';
import { UserProfile, UserRole } from '../types/solar';
import { storageService } from '../services/storage';
import { liveLocationService } from '../services/liveLocationService';
import { apiClient } from '../services/apiClient';
import { safeStorage, safeSessionStorage } from '../services/safeStorage';

export interface RoleDefinition {
  role: UserRole;
  department: string;
  description: string;
  badgeColor: string;
  isFieldWorkerDefault?: boolean;
}

export const ROLE_DEFINITIONS: RoleDefinition[] = [
  {
    role: 'Admin',
    department: 'Administration',
    description: 'Master system authority, user management, financial approvals & administrative control',
    badgeColor: 'bg-indigo-100 text-indigo-800 border-indigo-300',
    isFieldWorkerDefault: false
  },
  {
    role: 'Sales Manager',
    department: 'Sales',
    description: 'Pipeline analytics, commercial quoting, revenue targets & lead assignments',
    badgeColor: 'bg-emerald-100 text-emerald-800 border-emerald-300',
    isFieldWorkerDefault: false
  },
  {
    role: 'Sales Executive',
    department: 'Sales',
    description: 'Lead generation, customer site visits, proposal follow-ups & CRM conversion',
    badgeColor: 'bg-teal-100 text-teal-800 border-teal-300',
    isFieldWorkerDefault: false
  },
  {
    role: 'Project Manager',
    department: 'Operations',
    description: '14-stage EPC milestones, stage approvals, resource scheduling & contractor oversight',
    badgeColor: 'bg-blue-100 text-blue-800 border-blue-300',
    isFieldWorkerDefault: false
  },
  {
    role: 'Site Survey Engineer',
    department: 'Engineering',
    description: 'Site feasibility audits, roof structure load, solar radiance, azimuth & shadow analysis',
    badgeColor: 'bg-amber-100 text-amber-800 border-amber-300',
    isFieldWorkerDefault: true
  },
  {
    role: 'Site Inspector',
    department: 'Engineering',
    description: 'Installation quality audits, safety compliance checks, punchlists & milestone sign-offs',
    badgeColor: 'bg-orange-100 text-orange-800 border-orange-300',
    isFieldWorkerDefault: true
  },
  {
    role: 'Civil Team',
    department: 'Civil',
    description: 'RCC pedestal casting, chemical anchoring, roof penetrations & civil structural safety',
    badgeColor: 'bg-stone-100 text-stone-800 border-stone-300',
    isFieldWorkerDefault: true
  },
  {
    role: 'Structure Team',
    department: 'Structure',
    description: 'Module mounting structures (MMS), column fabrication, tilt torque & wind shear alignment',
    badgeColor: 'bg-orange-100 text-orange-800 border-orange-300',
    isFieldWorkerDefault: true
  },
  {
    role: 'Installation Team',
    department: 'Installation',
    description: 'Solar PV module clamping, string cabling, inter-module jumpering & array leveling',
    badgeColor: 'bg-cyan-100 text-cyan-800 border-cyan-300',
    isFieldWorkerDefault: true
  },
  {
    role: 'Electrical Team',
    department: 'Electrical',
    description: 'On-grid inverters, HT/LT ACDB-DCDB panels, chemical earthing pits & lightning arresters',
    badgeColor: 'bg-indigo-100 text-indigo-800 border-indigo-300',
    isFieldWorkerDefault: true
  },
  {
    role: 'Accountant',
    department: 'Finance',
    description: 'Milestone billing, GST sales invoices, expense vouchers & Tally Prime ODBC integration',
    badgeColor: 'bg-purple-100 text-purple-800 border-purple-300',
    isFieldWorkerDefault: false
  },
  {
    role: 'Service Manager',
    department: 'Service',
    description: 'Preventive maintenance, AMC lifecycle renewals, fault SLA telemetry & ticket routing',
    badgeColor: 'bg-rose-100 text-rose-800 border-rose-300',
    isFieldWorkerDefault: false
  },
  {
    role: 'Technician',
    department: 'Service',
    description: 'Field ticket remediation, string inverter replacement, thermal hotspot drone scans',
    badgeColor: 'bg-yellow-100 text-yellow-800 border-yellow-300',
    isFieldWorkerDefault: true
  },
  {
    role: 'HR Manager',
    department: 'HR',
    description: 'Staff directory, field wage payroll, geofence attendance stamps & performance appraisals',
    badgeColor: 'bg-pink-100 text-pink-800 border-pink-300',
    isFieldWorkerDefault: false
  },
  {
    role: 'Customer',
    department: 'Customer',
    description: 'Real-time project milestone tracking, quotation downloads, net-metering status & warranty portal',
    badgeColor: 'bg-slate-100 text-slate-800 border-slate-300',
    isFieldWorkerDefault: false
  }
];

export interface AuthContextType {
  currentUser: UserProfile | null;
  currentRole: UserRole;
  loading: boolean;
  isAuthenticated: boolean;
  login: (email: string, pass: string) => Promise<void>;
  register: (
    email: string,
    pass: string,
    name: string,
    role?: UserRole,
    department?: string,
    designation?: string,
    phone?: string
  ) => Promise<void>;
  logout: () => Promise<void>;
  completePasswordChange: (oldPassword: string, newPassword: string) => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  updateRole: (newRole: UserRole) => void;
  switchPersona: (profile: UserProfile) => void;
  canAccessModule: (moduleName: string) => boolean;
  hasPermission: (permissionId: string) => boolean;
  canApproveStage: () => boolean;
  canEditFinancials: () => boolean;
  canAccessHR: () => boolean;
  canManageProjectAssignments: () => boolean;
  isAdmin: boolean;
  isCustomer: boolean;
  isFieldStaff: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const USER_PROFILE_STORAGE_KEY = 'rejoysolar_profile_';
const ACTIVE_SESSION_STORAGE_KEY = 'rejoysolar_active_session';
const AUTH_TOKEN_KEY = 'rejoysolar_auth_token';

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Production auth: Sole source of truth is MySQL via HttpOnly server session cookies
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  // In-memory user profile updater (no localStorage/sessionStorage credential storage)
  const saveUserProfile = (profile: UserProfile, token?: string) => {
    setCurrentUser(profile);
    if (token) {
      apiClient.setToken(token);
    }
  };

  // Initialize and verify session against MySQL backend on mount
  useEffect(() => {
    let isMounted = true;

    // Purge any legacy client-side storage keys to enforce MySQL as sole source of truth
    if (typeof window !== 'undefined') {
      try {
        safeStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
        safeStorage.removeItem(AUTH_TOKEN_KEY);
        safeSessionStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
        safeSessionStorage.removeItem(AUTH_TOKEN_KEY);
      } catch {}
    }

    const restoreAndVerifySession = async () => {
      try {
        // Authoritatively verify session with MySQL backend API (/api/auth/me) with credentials: 'include'
        let verifyRes = await apiClient.verifySession();

        // If first attempt fails and it is not an explicit credential refusal, retry with backoff
        let retries = 0;
        while (!verifyRes.success && retries < 2) {
          const isExplicitAuthFailure = 
            verifyRes.message?.includes('401') || 
            verifyRes.message?.includes('403') || 
            verifyRes.message?.includes('No session token') ||
            verifyRes.message?.includes('Authentication required');

          if (isExplicitAuthFailure) {
            break; // No cookie or explicitly terminated session
          }
          retries++;
          await new Promise(r => setTimeout(r, 250 * retries));
          verifyRes = await apiClient.verifySession();
        }

        if (verifyRes.success && verifyRes.user) {
          const u = verifyRes.user;
          const isFw = Boolean(
            u.isFieldWorker ??
            [
              'Site Survey Engineer',
              'Site Inspector',
              'Civil Team',
              'Structure Team',
              'Installation Team',
              'Electrical Team',
              'Technician'
            ].includes(u.role)
          );

          const verifiedProfile: UserProfile = {
            id: u.id,
            employeeId: u.employeeId || (u.customerId ? `CUST-${u.customerId}` : `EMP-${u.id}`),
            name: u.name || 'Solar Team Member',
            email: u.email,
            role: u.role as UserRole,
            phone: u.phone || '',
            department: u.department || (u.role === 'Customer' ? 'Client Portal' : 'Administration'),
            designation: u.designation || u.role,
            isFieldWorker: isFw,
            assignedProjects: [],
            mustChangePassword: Boolean(u.mustChangePassword)
          };

          if (isMounted) {
            saveUserProfile(verifiedProfile, verifyRes.token || undefined);
            if (!verifiedProfile.mustChangePassword) {
              await storageService.hydrateFromBackend().catch((syncErr) => {
                console.error('[Auth] Initial MySQL bootstrap sync failed:', syncErr);
              });
            }
          }
        } else {
          if (isMounted) {
            setCurrentUser(null);
          }
        }
      } catch (err) {
        console.warn('[Auth] Error verifying session with backend:', err);
        if (isMounted) {
          setCurrentUser(null);
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    restoreAndVerifySession();

    return () => {
      isMounted = false;
    };
  }, []);

  const login = async (email: string, pass: string): Promise<void> => {
    try {
      const cleanEmail = email.trim().toLowerCase();
      const cleanPass = pass.trim();

      // Authenticate directly with the authoritative MySQL backend via unified apiClient (with /auth/login fallback)
      const data = await apiClient.login(cleanEmail, cleanPass);

      if (!data.success || !data.user) {
        throw new Error(data.message || 'Invalid email or password. Please verify your credentials in MySQL.');
      }

      const u = data.user;
      const isFw = Boolean(
        u.isFieldWorker ??
        [
          'Site Survey Engineer',
          'Site Inspector',
          'Civil Team',
          'Structure Team',
          'Installation Team',
          'Electrical Team',
          'Technician'
        ].includes(u.role)
      );

      const authenticatedProfile: UserProfile = {
        id: u.id,
        employeeId: u.employeeId || (u.customerId ? `CUST-${u.customerId}` : `EMP-${u.id}`),
        name: u.name || 'Solar Team Member',
        email: u.email,
        role: u.role as UserRole,
        phone: u.phone || '',
        department: u.department || (u.role === 'Customer' ? 'Client Portal' : 'Administration'),
        designation: u.designation || u.role,
        isFieldWorker: isFw,
        assignedProjects: [],
        mustChangePassword: Boolean(u.mustChangePassword)
      };

      saveUserProfile(authenticatedProfile, data.token);
      if (!authenticatedProfile.mustChangePassword) {
        await storageService.hydrateFromBackend().catch((syncErr) => {
          console.error('[Auth] Post-login MySQL bootstrap sync failed:', syncErr);
        });
      }
    } catch (err: any) {
      throw new Error(err.message || 'Authentication failed. Please verify credentials.');
    }
  };

  const register = async (
    email: string,
    pass: string,
    name: string,
    role: UserRole = 'Admin',
    department?: string,
    designation?: string,
    phone: string = ''
  ): Promise<void> => {
    try {
      const cleanEmail = email.trim().toLowerCase();
      const cleanPass = pass.trim();
      const cleanName = name.trim();

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      // If an existing administrator is already authenticated, send credentials for privilege escalation authorization
      const existingToken = apiClient.getToken();
      if (existingToken) {
        headers['Authorization'] = existingToken.startsWith('Bearer ') ? existingToken : `Bearer ${existingToken}`;
        headers['x-admin-token'] = existingToken;
      }

      // Register directly via backend MySQL API
      const res = await fetch(`${apiClient.getBaseUrl()}/auth/register`, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({
          name: cleanName,
          email: cleanEmail,
          password: cleanPass,
          confirmPassword: cleanPass,
          phone,
          department,
          designation
        })
      });

      let data: any = {};
      try {
        data = await res.json();
      } catch {
        throw new Error(
          res.status === 404
            ? `Admin Registration API endpoint not found (HTTP 404). Please verify that the backend /api routes or reverse-proxy are active.`
            : `Registration server returned HTTP ${res.status} (${res.statusText || 'Non-JSON response'}).`
        );
      }

      if (!res.ok || !data.success || !data.user) {
        throw new Error(data.message || `Registration failed (HTTP ${res.status}).`);
      }

      const u = data.user;
      const newProfile: UserProfile = {
        id: u.id,
        employeeId: u.employeeId || `EMP-ADM-${Date.now().toString().slice(-4)}`,
        name: u.name,
        email: u.email,
        role: (u.role || role) as UserRole,
        phone: u.phone || phone,
        department: u.department || department || 'Administration',
        designation: u.designation || designation || 'Lead Administrator',
        isFieldWorker: false,
        assignedProjects: []
      };

      saveUserProfile(newProfile, data.token);
      await storageService.hydrateFromBackend().catch((syncErr) => {
        console.error('[Auth] Post-registration MySQL bootstrap sync failed:', syncErr);
      });
    } catch (err: any) {
      throw new Error(err?.message || 'Registration failed.');
    }
  };

  const logout = async (): Promise<void> => {
    setLoading(true);
    try {
      if (currentUser?.id) {
        liveLocationService.sendOffline(currentUser.id, currentUser.email, currentUser.employeeId).catch(() => {});
      }
      liveLocationService.setTrackingEnabled(false);
      storageService.clearInMemoryData();
      try {
        await apiClient.logout();
      } catch (e) {
        console.warn('[Auth] Server logout notification error:', e);
      }

      // Synchronously clear all persistent tokens and auth cache
      safeStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
      safeStorage.removeItem(AUTH_TOKEN_KEY);
      if (currentUser?.id) {
        safeStorage.removeItem(USER_PROFILE_STORAGE_KEY + currentUser.id);
      }
      safeSessionStorage.clear();
      apiClient.setToken(null);
      setCurrentUser(null);

      // Explicitly redirect to login route
      if (typeof window !== 'undefined') {
        window.history.replaceState(null, '', '/login');
      }
    } finally {
      setLoading(false);
    }
  };

  const completePasswordChange = async (oldPassword: string, newPassword: string): Promise<void> => {
    if (!currentUser) {
      throw new Error('No active user session found.');
    }
    const res = await apiClient.changePassword(currentUser.id, oldPassword, newPassword);
    if (!res.success) {
      throw new Error(res.message || 'Password update failed.');
    }
    const updatedProfile: UserProfile = {
      ...currentUser,
      mustChangePassword: false
    };
    setCurrentUser(updatedProfile);
    await storageService.hydrateFromBackend().catch((syncErr) => {
      console.error('[Auth] Post-password-change MySQL bootstrap sync failed:', syncErr);
    });
  };

  const resetPassword = async (email: string): Promise<void> => {
    const clean = email.trim().toLowerCase();
    if (!clean || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
      throw new Error('Please provide a valid email address.');
    }
    throw new Error('Self-service password reset requires an email token; please ask your System Administrator to reset your password in User Management.');
  };

  const updateRole = (newRole: UserRole) => {
    if (!currentUser) return;
    const def = ROLE_DEFINITIONS.find(r => r.role === newRole);
    const updated: UserProfile = {
      ...currentUser,
      role: newRole,
      department: def?.department || currentUser.department,
      designation: def?.role || currentUser.designation,
      isFieldWorker: Boolean(def?.isFieldWorkerDefault)
    };
    saveUserProfile(updated);
  };

  const switchPersona = (profile: UserProfile) => {
    if (!currentUser) return;
    const def = ROLE_DEFINITIONS.find(r => r.role === profile.role);
    const updated: UserProfile = {
      ...currentUser,
      role: profile.role,
      department: profile.department || def?.department || currentUser.department,
      designation: profile.designation || def?.role || currentUser.designation,
      isFieldWorker: Boolean(profile.isFieldWorker ?? def?.isFieldWorkerDefault)
    };
    saveUserProfile(updated);
  };

  const currentRole: UserRole = currentUser?.role || 'Admin';
  const normalizedRoleLower = String(currentRole || '').trim().toLowerCase();
  const isCustomer = normalizedRoleLower === 'customer' || normalizedRoleLower === 'client';
  const isAdmin = normalizedRoleLower === 'admin' || normalizedRoleLower === 'super admin';
  const isProjectManager = normalizedRoleLower === 'project manager';
  const isFieldStaff = Boolean(
    currentUser?.isFieldWorker ||
    [
      'Site Survey Engineer',
      'Site Inspector',
      'Civil Team',
      'Structure Team',
      'Installation Team',
      'Electrical Team',
      'Technician'
    ].includes(currentRole)
  );

  const hasPermission = (permissionId: string): boolean => {
    if (isAdmin) return true;
    return storageService.hasAclPermission(currentRole, permissionId);
  };

  const canApproveStage = (): boolean => {
    return isAdmin || isProjectManager || hasPermission('projects.stage_approve');
  };

  const canEditFinancials = (): boolean => {
    if (isCustomer) return false;
    return (
      isAdmin ||
      currentRole === 'Accountant' ||
      hasPermission('finance.invoices') ||
      hasPermission('finance.receipts') ||
      hasPermission('finance.ledger') ||
      hasPermission('finance.vendors') ||
      hasPermission('finance.banking')
    );
  };

  const canAccessHR = (): boolean => {
    return isAdmin || currentRole === 'HR Manager' || hasPermission('hrms.manage');
  };

  const canManageProjectAssignments = (): boolean => {
    return isAdmin || hasPermission('projects.assign_team');
  };

  const canAccessModule = (moduleName: string): boolean => {
    if (isAdmin) return true;

    if (isCustomer) {
      if (moduleName === 'customer_portal') return hasPermission('customer_portal.view');
      if (moduleName === 'service' || moduleName === 'service_request') {
        return hasPermission('service.tickets_view') || hasPermission('service.tickets_create');
      }
      if (moduleName === 'customer_control_center' || moduleName === 'my_project' || moduleName === 'my_documents') {
        return hasPermission('projects.view') || hasPermission('customer_portal.view');
      }
      if (moduleName === 'my_payments') {
        return hasPermission('finance.view') || hasPermission('customer_portal.view');
      }
      return false;
    }

    // Specific report submodule checks (e.g. 'reports_sales', 'reports_payroll', etc.)
    if (moduleName.startsWith('reports_')) {
      const reportCat = moduleName.slice('reports_'.length);
      return hasPermission(`reports.${reportCat}`);
    }

    // Role permission catalog mapping
    switch (moduleName) {
      case 'dashboard':
        return hasPermission('dashboard.view');
      case 'customer_control_center':
        return hasPermission('control_center.view');
      case 'customer_portal':
        return hasPermission('customer_portal.view');
      case 'live_tracking':
      case 'field_tracking':
        return hasPermission('live_tracking.view');
      case 'crm_leads':
      case 'leads':
        return hasPermission('crm.leads.view') || hasPermission('crm.leads.manage');
      case 'crm_customers':
      case 'customers':
        return hasPermission('crm.customers.view') || hasPermission('crm.customers.manage');
      case 'crm_quotations':
      case 'quotations':
        return (
          hasPermission('crm.quotations.view') ||
          hasPermission('crm.quotations.create') ||
          hasPermission('crm.quotations.approve')
        );
      case 'crm':
        return (
          hasPermission('crm.leads.view') ||
          hasPermission('crm.leads.manage') ||
          hasPermission('crm.customers.view') ||
          hasPermission('crm.customers.manage') ||
          hasPermission('crm.quotations.view') ||
          hasPermission('crm.quotations.create') ||
          hasPermission('crm.quotations.approve')
        );
      case 'sales_purchase_hub':
        return hasPermission('inventory.hub_view');
      case 'sales_bom':
      case 'bom':
        return hasPermission('inventory.bom_edit') || hasPermission('inventory.bom_manage');
      case 'sales_invoices':
        return hasPermission('finance.invoices') || hasPermission('finance.view');
      case 'vendor_sales_invoices':
        return isAdmin || String(currentUser?.role || '').trim().toUpperCase() === 'SUPER ADMIN';
      case 'sales_returns':
        return (
          hasPermission('inventory.sales_returns') ||
          hasPermission('finance.invoices') ||
          hasPermission('finance.view') ||
          isAdmin
        );
      case 'purchase_vendors':
      case 'vendors':
        return hasPermission('inventory.vendors_view') || hasPermission('inventory.vendors_manage');
      case 'purchase_orders':
      case 'purchase':
        return hasPermission('inventory.purchase_orders');
      case 'purchase_returns':
        return (
          hasPermission('inventory.purchase_returns') ||
          hasPermission('inventory.purchase_orders') ||
          hasPermission('finance.vendors') ||
          isAdmin
        );
      case 'inventory_products':
        return hasPermission('inventory.view') || hasPermission('inventory.products_manage');
      case 'inventory_stock':
      case 'inventory':
        return hasPermission('inventory.view') || hasPermission('inventory.manage');
      case 'warehouse_management':
        return hasPermission('inventory.warehouses_manage') || hasPermission('inventory.view');
      case 'sales_purchase':
      case 'sales':
        return (
          hasPermission('inventory.hub_view') ||
          hasPermission('inventory.bom_edit') ||
          hasPermission('inventory.bom_manage') ||
          hasPermission('inventory.vendors_view') ||
          hasPermission('inventory.vendors_manage') ||
          hasPermission('inventory.purchase_orders') ||
          hasPermission('inventory.sales_returns') ||
          hasPermission('inventory.purchase_returns') ||
          hasPermission('inventory.products_manage') ||
          hasPermission('inventory.view') ||
          hasPermission('inventory.manage') ||
          hasPermission('inventory.warehouses_manage') ||
          hasPermission('finance.invoices') ||
          isAdmin
        );
      case 'projects_all':
        return hasPermission('projects.view');
      case 'projects_stage_filtered':
      case 'workflow':
        return hasPermission('projects.workflows_view');
      case 'projects':
        return hasPermission('projects.view') || hasPermission('projects.workflows_view');
      case 'site_survey':
        return hasPermission('survey.view') || hasPermission('survey.submit') || hasPermission('survey.approve');
      case 'finance':
      case 'invoices':
      case 'accounting':
      case 'tally':
        return (
          hasPermission('finance.view') ||
          hasPermission('finance.invoices') ||
          hasPermission('finance.receipts') ||
          hasPermission('finance.tally_sync') ||
          hasPermission('finance.audit') ||
          hasPermission('finance.expenses') ||
          hasPermission('finance.ledger') ||
          hasPermission('finance.vendors') ||
          hasPermission('finance.banking') ||
          hasPermission('finance.tax') ||
          hasPermission('finance.budgets') ||
          hasPermission('finance.assets') ||
          hasPermission('finance.project_costing') ||
          hasPermission('finance.reports') ||
          hasPermission('finance.settings')
        );
      case 'hrms':
      case 'employees':
      case 'attendance':
      case 'payroll':
        return (
          hasPermission('hrms.view') ||
          hasPermission('hrms.manage') ||
          hasPermission('hrms.payroll') ||
          hasPermission('hrms.attendance_punch') ||
          hasPermission('hrms.leave_apply') ||
          hasPermission('hrms.leave_review')
        );
      case 'service':
      case 'amc':
        return (
          hasPermission('service.tickets_view') ||
          hasPermission('service.tickets_create') ||
          hasPermission('service.tickets_resolve') ||
          hasPermission('service.amc_manage')
        );
      case 'reports':
        return (
          hasPermission('reports.sales') ||
          hasPermission('reports.purchase') ||
          hasPermission('reports.product_stock') ||
          hasPermission('reports.customer_ledger') ||
          hasPermission('reports.vendor_ledger') ||
          hasPermission('reports.income_summary') ||
          hasPermission('reports.expense_summary') ||
          hasPermission('reports.payroll') ||
          hasPermission('reports.monthly_attendance') ||
          hasPermission('reports.leads') ||
          hasPermission('reports.projects') ||
          hasPermission('reports.view')
        );
      case 'users':
        return hasPermission('users.view') || hasPermission('users.manage');
      case 'settings':
      case 'roles':
        return (
          hasPermission('settings.manage') ||
          hasPermission('settings.acl_manage') ||
          hasPermission('settings.tally') ||
          hasPermission('settings.whatsapp') ||
          hasPermission('settings.database')
        );
      default:
        return true;
    }
  };

  return (
    <AuthContext.Provider
      value={{
        currentUser,
        currentRole,
        loading,
        isAuthenticated: Boolean(currentUser),
        login,
        register,
        logout,
        completePasswordChange,
        resetPassword,
        updateRole,
        switchPersona,
        canAccessModule,
        hasPermission,
        canApproveStage,
        canEditFinancials,
        canAccessHR,
        canManageProjectAssignments,
        isAdmin,
        isCustomer,
        isFieldStaff
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export function getRoleDefaultPath(role?: UserRole): string {
  const norm = String(role || '').trim().toLowerCase();
  if (norm === 'customer' || norm === 'client') return '/customer-portal';
  return '/dashboard';
}
