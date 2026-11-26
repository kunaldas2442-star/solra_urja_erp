import React, { useState, useEffect } from 'react';
import { useApp, AppView, FinanceTab } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import {
  LayoutDashboard,
  Users,
  Building2,
  FileSpreadsheet,
  SunMedium,
  Layers,
  CreditCard,
  UserSquare2,
  Wrench,
  BarChart3,
  Settings,
  ChevronDown,
  ChevronRight,
  Sparkles,
  ExternalLink,
  ShieldAlert,
  ArrowRight,
  ShoppingCart,
  ShieldCheck,
  Navigation,
  LogOut
} from 'lucide-react';

interface SidebarProps {
  isOpen: boolean;
  onCloseMobile: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ isOpen, onCloseMobile }) => {
  const {
    activeView,
    setActiveView,
    setStageFilterKey,
    activeReportCategory,
    openReport,
    activeSettingsTab,
    openSettingsTab,
    activeFinanceTab,
    openFinanceTab
  } = useApp();
  const { currentUser, isCustomer, isAdmin, isFieldStaff, canAccessModule, hasPermission, currentRole, logout } = useAuth();

  const [crmOpen, setCrmOpen] = useState(true);
  const [salesPurchaseOpen, setSalesPurchaseOpen] = useState(true);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [financeOpen, setFinanceOpen] = useState(true);
  const [reportsOpen, setReportsOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(true);

  const isCrmActive = ['crm_leads', 'crm_customers', 'crm_quotations'].includes(activeView);

  // Keep CRM menu open if any of its children is active
  useEffect(() => {
    if (isCrmActive) {
      setCrmOpen(true);
    }
  }, [isCrmActive, activeView]);

  const navigateTo = (view: AppView, stageKey?: string) => {
    if (stageKey) {
      setStageFilterKey(stageKey);
      setActiveView('projects_stage_filtered');
    } else {
      setActiveView(view);
    }
    onCloseMobile();
  };

  const navItemClass = (isActive: boolean) =>
    `w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-semibold transition-colors select-none ${
      isActive
        ? 'bg-[#0F2954] text-white shadow-xs'
        : 'text-slate-600 hover:text-[#0F2954] hover:bg-slate-100/80'
    }`;

  const subNavItemClass = (isActive: boolean) =>
    `w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-semibold transition-colors select-none ${
      isActive
        ? 'bg-[#0F2954] text-white shadow-xs'
        : 'text-slate-600 hover:text-[#0F2954] hover:bg-slate-100/80'
    }`;

  const parentNavItemClass = (isExactActive: boolean, _isChildActive: boolean) =>
    `w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer select-none ${
      isExactActive
        ? 'bg-[#0F2954] text-white shadow-xs'
        : 'text-slate-600 hover:text-[#0F2954] hover:bg-slate-100/80'
    }`;

  return (
    <>
      {/* Backdrop for mobile */}
      {isOpen && (
        <div
          onClick={onCloseMobile}
          className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-xs lg:hidden"
        />
      )}

      {/* Main Sidebar */}
      <aside
        className={`fixed top-16 bottom-0 left-0 z-40 w-64 bg-white border-r border-slate-200/80 overflow-y-auto transition-transform duration-200 ease-in-out lg:translate-x-0 ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="p-3.5 space-y-5">
          {/* If customer role, only show Customer Portal options */}
          {isCustomer ? (
            <div className="space-y-1">
              <div className="px-3 py-1.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                Client Portal Access
              </div>
              {canAccessModule('customer_portal') && (
                <button
                  onClick={() => navigateTo('customer_portal')}
                  className={navItemClass(activeView === 'customer_portal')}
                >
                  <SunMedium className="w-4 h-4" />
                  <span>My Solar Project</span>
                </button>
              )}
              {canAccessModule('customer_control_center') && (
                <button
                  onClick={() => navigateTo('customer_control_center')}
                  className={navItemClass(activeView === 'customer_control_center')}
                >
                  <Layers className="w-4 h-4" />
                  <span>Project Timeline & Docs</span>
                </button>
              )}
              {canAccessModule('service') && (
                <button
                  onClick={() => navigateTo('service')}
                  className={navItemClass(activeView === 'service')}
                >
                  <Wrench className="w-4 h-4" />
                  <span>Service & Support</span>
                </button>
              )}
            </div>
          ) : (
            <>
              {/* Primary Section */}
              {(canAccessModule('dashboard') || canAccessModule('customer_control_center')) && (
                <div className="space-y-1">
                  {canAccessModule('dashboard') && (
                    <button
                      onClick={() => navigateTo('dashboard')}
                      className={navItemClass(activeView === 'dashboard')}
                    >
                      <LayoutDashboard className="w-4 h-4" />
                      <span>Dashboard</span>
                    </button>
                  )}

                  {/* Heart of the System: Customer Control Center */}
                  {canAccessModule('customer_control_center') && (
                    <button
                      onClick={() => navigateTo('customer_control_center')}
                      className={navItemClass(activeView === 'customer_control_center')}
                    >
                      <Layers className="w-4 h-4" />
                      <span>Control Center</span>
                    </button>
                  )}
                </div>
              )}

              {/* CRM Section */}
              {canAccessModule('crm') && (
                <div className="space-y-1">
                  <div
                    onClick={() => {
                      const firstCrmView: AppView = canAccessModule('crm_leads')
                        ? 'crm_leads'
                        : canAccessModule('crm_customers')
                        ? 'crm_customers'
                        : 'crm_quotations';
                      navigateTo(firstCrmView);
                      setCrmOpen(true);
                    }}
                    className="flex items-center justify-between px-3 py-1.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wider cursor-pointer hover:text-slate-600 transition-colors select-none"
                  >
                    <span className={isCrmActive ? 'text-[#EA580C] font-bold' : ''}>CRM & Leads</span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setCrmOpen(prev => !prev);
                      }}
                      className="p-0.5 rounded text-current opacity-70 hover:opacity-100 transition-opacity cursor-pointer"
                      aria-label="Toggle CRM menu"
                    >
                      {crmOpen ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-400" />}
                    </button>
                  </div>

                  {crmOpen && (
                    <div className="space-y-0.5">
                      {canAccessModule('crm_leads') && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            navigateTo('crm_leads');
                          }}
                          className={`${subNavItemClass(activeView === 'crm_leads')} cursor-pointer`}
                        >
                          <span>Leads Pipeline</span>
                        </button>
                      )}
                      {canAccessModule('crm_customers') && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            navigateTo('crm_customers');
                          }}
                          className={`${subNavItemClass(activeView === 'crm_customers')} cursor-pointer`}
                        >
                          <span>Customer Directory</span>
                        </button>
                      )}
                      {canAccessModule('crm_quotations') && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            navigateTo('crm_quotations');
                          }}
                          className={`${subNavItemClass(activeView === 'crm_quotations')} cursor-pointer`}
                        >
                          <span>Quotations & Proposals</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Sales & Purchase Section */}
              {canAccessModule('sales_purchase') && (
                <div className="space-y-1">
                  <div
                    onClick={() => {
                      const firstSalesView: AppView =
                        (canAccessModule('sales_purchase_hub') && 'sales_purchase') ||
                        (canAccessModule('sales_bom') && 'sales_bom') ||
                        (canAccessModule('sales_invoices') && 'sales_invoices') ||
                        (canAccessModule('vendor_sales_invoices') && 'vendor_sales_invoices') ||
                        (canAccessModule('sales_returns') && 'sales_returns') ||
                        (canAccessModule('purchase_vendors') && 'purchase_vendors') ||
                        (canAccessModule('purchase_orders') && 'purchase_orders') ||
                        (canAccessModule('purchase_returns') && 'purchase_returns') ||
                        (canAccessModule('inventory_products') && 'inventory_products') ||
                        (canAccessModule('inventory_stock') && 'inventory_stock') ||
                        'warehouse_management';
                      navigateTo(firstSalesView);
                      setSalesPurchaseOpen(true);
                    }}
                    className={parentNavItemClass(
                      activeView === 'sales_purchase',
                      [
                        'sales_bom',
                        'sales_invoices',
                        'vendor_sales_invoices',
                        'sales_returns',
                        'purchase_vendors',
                        'purchase_orders',
                        'purchase_returns',
                        'inventory_products',
                        'inventory_stock',
                        'warehouse_management'
                      ].includes(activeView)
                    )}
                  >
           
                      <div className="flex items-center justify-between py-1.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wider cursor-pointer hover:text-slate-600 transition-colors select-none">
                        <span>Sales & Purchase</span>
                     
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSalesPurchaseOpen(!salesPurchaseOpen);
                      }}
                      className="p-0.5 rounded text-current opacity-70 hover:opacity-100 transition-opacity"
                      aria-label="Toggle Sales & Purchase menu"
                    >
                      {salesPurchaseOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                    </button>
                  </div>

                  {salesPurchaseOpen && (
                    <div className="space-y-0.5">
                      {canAccessModule('sales_purchase_hub') && (
                        <button
                          onClick={() => navigateTo('sales_purchase')}
                          className={subNavItemClass(activeView === 'sales_purchase')}
                        >
                          <span>Hub & Synchronization</span>
                        </button>
                      )}
                      {canAccessModule('sales_bom') && (
                        <button
                          onClick={() => navigateTo('sales_bom')}
                          className={subNavItemClass(activeView === 'sales_bom')}
                        >
                          <span>Bill of Materials (BOM)</span>
                        </button>
                      )}
                      {canAccessModule('sales_invoices') && (
                        <button
                          onClick={() => navigateTo('sales_invoices')}
                          className={subNavItemClass(activeView === 'sales_invoices')}
                        >
                          <span>Invoice Creation</span>
                        </button>
                      )}
                      {canAccessModule('vendor_sales_invoices') && (
                        <button
                          onClick={() => navigateTo('vendor_sales_invoices')}
                          className={subNavItemClass(activeView === 'vendor_sales_invoices')}
                        >
                          <span>Vendor Sales Invoices</span>
                        </button>
                      )}
                      {canAccessModule('sales_returns') && (
                        <button
                          onClick={() => navigateTo('sales_returns')}
                          className={subNavItemClass(activeView === 'sales_returns')}
                        >
                          <span>Sales Returns</span>
                        </button>
                      )}
                      {canAccessModule('purchase_vendors') && (
                        <button
                          onClick={() => navigateTo('purchase_vendors')}
                          className={subNavItemClass(activeView === 'purchase_vendors')}
                        >
                          <span>Vendor Management</span>
                        </button>
                      )}
                      {canAccessModule('purchase_orders') && (
                        <button
                          onClick={() => navigateTo('purchase_orders')}
                          className={subNavItemClass(activeView === 'purchase_orders')}
                        >
                          <span>Purchase Entry</span>
                        </button>
                      )}
                      {canAccessModule('purchase_returns') && (
                        <button
                          onClick={() => navigateTo('purchase_returns')}
                          className={subNavItemClass(activeView === 'purchase_returns')}
                        >
                          <span>Purchase Returns</span>
                        </button>
                      )}
                      {canAccessModule('inventory_products') && (
                        <button
                          onClick={() => navigateTo('inventory_products')}
                          className={subNavItemClass(activeView === 'inventory_products')}
                        >
                          <span>Purchased Products</span>
                        </button>
                      )}
                      {canAccessModule('inventory_stock') && (
                        <button
                          onClick={() => navigateTo('inventory_stock')}
                          className={subNavItemClass(activeView === 'inventory_stock')}
                        >
                          <span>Inventory & Stock</span>
                        </button>
                      )}
                      {canAccessModule('warehouse_management') && (
                        <button
                          onClick={() => navigateTo('warehouse_management')}
                          className={subNavItemClass(activeView === 'warehouse_management')}
                        >
                          <span>Warehouse Management</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Projects & Workflows Section */}
              {canAccessModule('projects') && (
                <div className="space-y-1">
                  <div
                    onClick={() => setProjectsOpen(!projectsOpen)}
                    className="flex items-center justify-between px-3 py-1.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wider cursor-pointer hover:text-slate-600 transition-colors select-none"
                  >
                    <span>{isFieldStaff ? 'My Field Tasks' : 'Project Operations'}</span>
                    {projectsOpen ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-400" />}
                  </div>

                  {projectsOpen && (
                    <div className="space-y-0.5">
                      {canAccessModule('projects_all') && (
                        <button
                          onClick={() => navigateTo('projects_all')}
                          className={subNavItemClass(activeView === 'projects_all')}
                        >
                          <span>{isFieldStaff ? 'Assigned Projects' : 'All Projects'}</span>
                        </button>
                      )}
                      {canAccessModule('projects_stage_filtered') && (
                        <button
                          onClick={() => navigateTo('projects_stage_filtered', 'site_survey')}
                          className={subNavItemClass(activeView === 'projects_stage_filtered')}
                        >
                          <span>{isFieldStaff ? 'Site Checklists & Workflows' : 'Stage Workflows'}</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Field Workforce Live Tracking */}
              {canAccessModule('live_tracking') && (
                <div className="space-y-1">
                  <div className="px-3 py-1.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wider flex items-center justify-between">
                    <span>Field Dispatch</span>
                  </div>
                  <button
                    onClick={() => navigateTo('live_tracking')}
                    className={navItemClass(activeView === 'live_tracking')}
                  >
                    <Navigation className="w-4 h-4 text-[#16A34A]" />
                    <span className="flex-1 text-left">Live Field Tracking</span>
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800">
                      LIVE
                    </span>
                  </button>
                </div>
              )}

              {/* Accounting & Finance */}
              {canAccessModule('finance') && (
                <div className="space-y-1">
                  <div
                    onClick={() => {
                      if (!financeOpen) setFinanceOpen(true);
                      openFinanceTab(activeFinanceTab || 'dashboard');
                      onCloseMobile();
                    }}
                    className={parentNavItemClass(activeView === 'finance', false)}
                  >
                    <div className="flex items-center justify-between py-1.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wider cursor-pointer hover:text-slate-600 transition-colors select-none">
                      <span className={activeView === 'finance' ? 'text-white font-bold' : ''}>Accounting & Finance</span>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setFinanceOpen(!financeOpen);
                      }}
                      className="p-0.5 rounded text-current opacity-70 hover:opacity-100 transition-opacity"
                      aria-label="Toggle Accounting & Finance menu"
                    >
                      {financeOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                    </button>
                  </div>

                  {financeOpen && (
                    <div className="space-y-0.5">
                      {(
                        [
                          { id: 'dashboard', label: 'Finance Dashboard', show: true },
                          { id: 'ledger', label: 'Accounts & Ledger', show: isAdmin || currentRole === 'Accountant' || hasPermission('finance.ledger') || hasPermission('finance.audit') },
                          { id: 'receivables', label: 'Customer Payments', show: isAdmin || currentRole === 'Accountant' || hasPermission('finance.receipts') || hasPermission('finance.view') },
                          { id: 'payables', label: 'Vendor Payments', show: isAdmin || currentRole === 'Accountant' || hasPermission('finance.vendors') || hasPermission('finance.expenses') },
                          { id: 'banking', label: 'Cash & Bank', show: isAdmin || currentRole === 'Accountant' || hasPermission('finance.banking') || hasPermission('finance.audit') },
                          { id: 'expenses', label: 'Expenses & Reimbursements', show: isAdmin || currentRole === 'Accountant' || hasPermission('finance.expenses') },
                          { id: 'gst', label: 'GST, TDS & E-Invoicing', show: isAdmin || currentRole === 'Accountant' || hasPermission('finance.tax') || hasPermission('finance.invoices') },
                          { id: 'budgets', label: 'Budgets & Forecasting', show: isAdmin || currentRole === 'Accountant' || hasPermission('finance.budgets') },
                          { id: 'assets', label: 'Fixed Assets Register', show: isAdmin || currentRole === 'Accountant' || hasPermission('finance.assets') },
                          { id: 'project_costing', label: 'Project Costing', show: isAdmin || currentRole === 'Accountant' || hasPermission('finance.project_costing') || hasPermission('finance.view') },
                          { id: 'reports', label: 'Financial Reports', show: isAdmin || currentRole === 'Accountant' || hasPermission('finance.reports') || hasPermission('finance.audit') },
                          { id: 'settings', label: 'Accounting Settings', show: isAdmin || currentRole === 'Accountant' || hasPermission('finance.settings') }
                        ] as { id: FinanceTab; label: string; show: boolean }[]
                      )
                        .filter(item => item.show)
                        .map(item => (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => {
                              openFinanceTab(item.id);
                              onCloseMobile();
                            }}
                            className={subNavItemClass(activeView === 'finance' && activeFinanceTab === item.id)}
                          >
                            <span>{item.label}</span>
                          </button>
                        ))}
                    </div>
                  )}
                </div>
              )}

              {/* HRMS */}
              {canAccessModule('hrms') && (
                <div className="space-y-1">
                  <div className="px-3 py-1.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                    Human Resources
                  </div>
                  <button
                    onClick={() => navigateTo('hrms')}
                    className={navItemClass(activeView === 'hrms')}
                  >
                    <UserSquare2 className="w-4 h-4" />
                    <span>Team, Attendance & GPS</span>
                  </button>
                </div>
              )}

              {/* Service & AMC */}
              {canAccessModule('service') && (
                <div className="space-y-1">
                  <div className="px-3 py-1.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                    Post-Commissioning
                  </div>
                  <button
                    onClick={() => navigateTo('service')}
                    className={navItemClass(activeView === 'service')}
                  >
                    <Wrench className="w-4 h-4" />
                    <span>Service & AMC Tickets</span>
                  </button>
                </div>
              )}

              {/* Reports */}
              {canAccessModule('reports') && (
                <div className="space-y-1">
                  <div
                    onClick={() => {
                      if (!reportsOpen) setReportsOpen(true);
                      const reportOrder = [
                        'sales',
                        'purchase',
                        'product_stock',
                        'customer_ledger',
                        'vendor_ledger',
                        'income_summary',
                        'expense_summary',
                        'payroll',
                        'monthly_attendance',
                        'leads',
                        'projects'
                      ] as const;
                      const preferred =
                        activeReportCategory && canAccessModule(`reports_${activeReportCategory}`)
                          ? activeReportCategory
                          : reportOrder.find(cat => canAccessModule(`reports_${cat}`)) || 'sales';
                      openReport(preferred);
                    }}
                    className={parentNavItemClass(
                      activeView === 'reports',
                      false
                    )}
                  >
                    
                      <div className="flex items-center justify-between py-1.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wider cursor-pointer hover:text-slate-600 transition-colors select-none">
                      <span>Reports</span>
                      </div>
                    
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setReportsOpen(!reportsOpen);
                      }}
                      className="p-0.5 rounded text-current opacity-70 hover:opacity-100 transition-opacity"
                      aria-label="Toggle Reports menu"
                    >
                      {reportsOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                    </button>
                  </div>

                  {reportsOpen && (
                    <div className="space-y-0.5">
                      {canAccessModule('reports_sales') && (
                        <button
                          onClick={() => {
                            openReport('sales');
                            onCloseMobile();
                          }}
                          className={subNavItemClass(activeView === 'reports' && activeReportCategory === 'sales')}
                        >
                          <span>Sales Report</span>
                        </button>
                      )}
                      {canAccessModule('reports_purchase') && (
                        <button
                          onClick={() => {
                            openReport('purchase');
                            onCloseMobile();
                          }}
                          className={subNavItemClass(activeView === 'reports' && activeReportCategory === 'purchase')}
                        >
                          <span>Purchase Report</span>
                        </button>
                      )}
                      {canAccessModule('reports_product_stock') && (
                        <button
                          onClick={() => {
                            openReport('product_stock');
                            onCloseMobile();
                          }}
                          className={subNavItemClass(activeView === 'reports' && activeReportCategory === 'product_stock')}
                        >
                          <span>Product Stock Report</span>
                        </button>
                      )}
                      {canAccessModule('reports_customer_ledger') && (
                        <button
                          onClick={() => {
                            openReport('customer_ledger');
                            onCloseMobile();
                          }}
                          className={subNavItemClass(activeView === 'reports' && activeReportCategory === 'customer_ledger')}
                        >
                          <span>Customer Ledger</span>
                        </button>
                      )}
                      {canAccessModule('reports_vendor_ledger') && (
                        <button
                          onClick={() => {
                            openReport('vendor_ledger');
                            onCloseMobile();
                          }}
                          className={subNavItemClass(activeView === 'reports' && activeReportCategory === 'vendor_ledger')}
                        >
                          <span>Vendor Ledger</span>
                        </button>
                      )}
                      {canAccessModule('reports_income_summary') && (
                        <button
                          onClick={() => {
                            openReport('income_summary');
                            onCloseMobile();
                          }}
                          className={subNavItemClass(activeView === 'reports' && activeReportCategory === 'income_summary')}
                        >
                          <span>Income Summary</span>
                        </button>
                      )}
                      {canAccessModule('reports_expense_summary') && (
                        <button
                          onClick={() => {
                            openReport('expense_summary');
                            onCloseMobile();
                          }}
                          className={subNavItemClass(activeView === 'reports' && activeReportCategory === 'expense_summary')}
                        >
                          <span>Expense Summary</span>
                        </button>
                      )}
                      {canAccessModule('reports_payroll') && (
                        <button
                          onClick={() => {
                            openReport('payroll');
                            onCloseMobile();
                          }}
                          className={subNavItemClass(activeView === 'reports' && activeReportCategory === 'payroll')}
                        >
                          <span>Payroll Report</span>
                        </button>
                      )}
                      {canAccessModule('reports_monthly_attendance') && (
                        <button
                          onClick={() => {
                            openReport('monthly_attendance');
                            onCloseMobile();
                          }}
                          className={subNavItemClass(activeView === 'reports' && activeReportCategory === 'monthly_attendance')}
                        >
                          <span>Monthly Attendance</span>
                        </button>
                      )}
                      {canAccessModule('reports_leads') && (
                        <button
                          onClick={() => {
                            openReport('leads');
                            onCloseMobile();
                          }}
                          className={subNavItemClass(activeView === 'reports' && activeReportCategory === 'leads')}
                        >
                          <span>Leads Report</span>
                        </button>
                      )}
                      {canAccessModule('reports_projects') && (
                        <button
                          onClick={() => {
                            openReport('projects');
                            onCloseMobile();
                          }}
                          className={subNavItemClass(activeView === 'reports' && activeReportCategory === 'projects')}
                        >
                          <span>Project Report</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* System Settings & Tally */}
              {canAccessModule('settings') && (
                <div className="space-y-1">
                  <div
                    onClick={() => {
                      const firstAllowedSettingsTab =
                        (hasPermission('settings.manage') && 'general') ||
                        (hasPermission('settings.tally') && 'tally') ||
                        (hasPermission('settings.whatsapp') && 'whatsapp') ||
                        (hasPermission('settings.acl_manage') && 'acl') ||
                        (isAdmin && 'email') ||
                        'general';
                      const isCurrentAllowed =
                        (activeSettingsTab === 'general' && hasPermission('settings.manage')) ||
                        (activeSettingsTab === 'tally' && hasPermission('settings.tally')) ||
                        (activeSettingsTab === 'whatsapp' && hasPermission('settings.whatsapp')) ||
                        (activeSettingsTab === 'acl' && hasPermission('settings.acl_manage')) ||
                        (activeSettingsTab === 'email' && isAdmin);
                      openSettingsTab(isCurrentAllowed ? activeSettingsTab : firstAllowedSettingsTab);
                      onCloseMobile();
                    }}
                    className={`cursor-pointer flex items-center justify-between ${navItemClass(activeView === 'settings')}`}
                  >
                    
                      <div className="flex items-center justify-between py-1.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wider cursor-pointer hover:text-slate-600 transition-colors select-none">
                      <span>System Settings & Tally</span>
                   
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSettingsOpen(!settingsOpen);
                      }}
                      className="p-0.5 rounded text-current opacity-70 hover:opacity-100 transition-opacity"
                      aria-label="Toggle Settings menu"
                    >
                      {settingsOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                    </button>
                  </div>

                  {settingsOpen && (
                    <div className="space-y-0.5">
                      {hasPermission('settings.manage') && (
                        <button
                          onClick={() => {
                            openSettingsTab('general');
                            onCloseMobile();
                          }}
                          className={subNavItemClass(activeView === 'settings' && activeSettingsTab === 'general')}
                        >
                          <span>General & EPC Profile</span>
                        </button>
                      )}
                      {hasPermission('settings.tally') && (
                        <button
                          onClick={() => {
                            openSettingsTab('tally');
                            onCloseMobile();
                          }}
                          className={subNavItemClass(activeView === 'settings' && activeSettingsTab === 'tally')}
                        >
                          <span>Tally Prime Integration</span>
                        </button>
                      )}
                      {hasPermission('settings.whatsapp') && (
                        <button
                          onClick={() => {
                            openSettingsTab('whatsapp');
                            onCloseMobile();
                          }}
                          className={subNavItemClass(activeView === 'settings' && activeSettingsTab === 'whatsapp')}
                        >
                          <span>WhatsApp Cloud API</span>
                        </button>
                      )}
                      {hasPermission('settings.acl_manage') && (
                        <button
                          onClick={() => {
                            openSettingsTab('acl');
                            onCloseMobile();
                          }}
                          className={subNavItemClass(activeView === 'settings' && activeSettingsTab === 'acl')}
                        >
                          <span>Role-Based Access Control</span>
                        </button>
                      )}
                      {isAdmin && (
                        <button
                          onClick={() => {
                            openSettingsTab('email');
                            onCloseMobile();
                          }}
                          className={subNavItemClass(activeView === 'settings' && activeSettingsTab === 'email')}
                        >
                          <span>Gmail Email Configuration</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* User Management */}
              {canAccessModule('users') && (
                <div className="space-y-1">
                  <div className="px-3 py-1.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                    Administration
                  </div>
                  <button
                    onClick={() => navigateTo('users')}
                    className={navItemClass(activeView === 'users')}
                  >
                    <Users className="w-4 h-4" />
                    <span>User Management</span>
                  </button>
                </div>
              )}
            </>
          )}

          {/* Security & Session Info Card */}
          <div className="p-3 bg-slate-50 border border-slate-200/80 rounded-xl space-y-1">
            <div className="flex items-center justify-between text-[11px] font-semibold text-slate-700">
              <span className="flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                <span>Session Active</span>
              </span>
              <span className="text-[10px] text-emerald-800 bg-emerald-100/80 px-1.5 py-0.5 rounded font-bold">Secure</span>
            </div>
            <p className="text-[11px] text-slate-500 leading-tight">
              Authenticated as <span className="font-semibold text-slate-700">{currentUser?.name || 'Authorized User'}</span> ({currentRole}).
            </p>
          </div>

          {/* Quick Sign Out Action Button */}
          <button
            type="button"
            onClick={async () => {
              onCloseMobile();
              await logout();
            }}
            className="w-full flex items-center justify-center gap-2 px-3 py-2.5 text-xs font-bold text-rose-600 hover:text-rose-700 bg-rose-50/50 hover:bg-rose-50 border border-rose-200/80 hover:border-rose-300 rounded-xl transition-all cursor-pointer shadow-2xs select-none"
          >
            <LogOut className="w-4 h-4 text-rose-500" />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>
    </>
  );
};
