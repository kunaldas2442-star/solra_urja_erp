import React, { useState, Suspense, useEffect } from 'react';
import { AuthProvider, useAuth, getRoleDefaultPath } from './context/AuthContext';
import { AppProvider, useApp } from './context/AppContext';
import { Header } from './components/layout/Header';
import { Sidebar } from './components/layout/Sidebar';
import { MobileBottomNav } from './components/layout/MobileBottomNav';
import { Toast } from './components/common/Toast';
import { GlobalSearchModal } from './components/common/GlobalSearchModal';
import { WhatsAppModal } from './components/common/WhatsAppModal';
import { EmailDispatchModal } from './components/common/EmailDispatchModal';
import { ImportExportModal } from './components/common/ImportExportModal';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { LoginView } from './components/auth/LoginView';
import { ForcePasswordChangeView } from './components/auth/ForcePasswordChangeView';
import { useWorkforcePresence } from './hooks/useWorkforcePresence';
import { Sun, AlertTriangle, RefreshCw, X } from 'lucide-react';

// Code-splitting via dynamic imports for optimized Hostinger bundle performance
const DashboardView = React.lazy(() => import('./components/views/DashboardView').then(m => ({ default: m.DashboardView })));
const CustomerControlCenterView = React.lazy(() => import('./components/views/CustomerControlCenterView').then(m => ({ default: m.CustomerControlCenterView })));
const CrmView = React.lazy(() => import('./components/views/CrmView').then(m => ({ default: m.CrmView })));
const ProjectsView = React.lazy(() => import('./components/views/ProjectsView').then(m => ({ default: m.ProjectsView })));
const FinanceView = React.lazy(() => import('./components/views/FinanceView').then(m => ({ default: m.FinanceView })));
const HrmsView = React.lazy(() => import('./components/views/HrmsView').then(m => ({ default: m.HrmsView })));
const ServiceView = React.lazy(() => import('./components/views/ServiceView').then(m => ({ default: m.ServiceView })));
const ReportsView = React.lazy(() => import('./components/views/ReportsView').then(m => ({ default: m.ReportsView })));
const SettingsView = React.lazy(() => import('./components/views/SettingsView').then(m => ({ default: m.SettingsView })));
const CustomerPortalView = React.lazy(() => import('./components/views/CustomerPortalView').then(m => ({ default: m.CustomerPortalView })));
const SalesPurchaseView = React.lazy(() => import('./components/views/SalesPurchaseView').then(m => ({ default: m.SalesPurchaseView })));
const LiveFieldTrackingView = React.lazy(() => import('./components/views/LiveFieldTrackingView').then(m => ({ default: m.LiveFieldTrackingView })));
const UserManagementView = React.lazy(() => import('./components/users/UserManagementView').then(m => ({ default: m.UserManagementView })));

const ViewLoader: React.FC = () => (
  <div className="flex flex-col items-center justify-center min-h-[400px] text-slate-400 gap-3">
    <div className="w-8 h-8 border-3 border-amber-500 border-t-transparent rounded-full animate-spin" />
    <span className="text-xs font-medium text-slate-500">Loading module...</span>
  </div>
);

const MainLayout: React.FC = () => {
  const { activeView, bootstrapStatus, bootstrapError, syncError, clearSyncError, retrySync } = useApp();
  const { isCustomer, isAdmin, canAccessModule } = useAuth();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isRetryingSync, setIsRetryingSync] = useState(false);

  const handleRetrySync = async () => {
    setIsRetryingSync(true);
    try {
      await retrySync();
    } finally {
      setIsRetryingSync(false);
    }
  };

  const renderActiveView = () => {
    // If the active role is Customer and they are on dashboard or customer portal, show customer view
    if (isCustomer && (activeView === 'dashboard' || activeView === 'customer_portal')) {
      return <CustomerPortalView />;
    }

    const renderFallbackView = () => {
      if (isCustomer) return <CustomerPortalView />;
      if (canAccessModule('dashboard')) return <DashboardView />;
      if (canAccessModule('projects')) return <ProjectsView />;
      if (canAccessModule('service')) return <ServiceView />;
      return <DashboardView />;
    };

    switch (activeView) {
      case 'dashboard':
        if (!canAccessModule('dashboard')) return renderFallbackView();
        return <DashboardView />;
      case 'live_tracking':
        if (!canAccessModule('live_tracking')) return renderFallbackView();
        return <LiveFieldTrackingView />;
      case 'customer_control_center':
        if (!canAccessModule('customer_control_center') && !canAccessModule('projects')) {
          return renderFallbackView();
        }
        return <CustomerControlCenterView />;
      case 'crm_leads':
        if (!canAccessModule('crm_leads')) return renderFallbackView();
        return <CrmView key="crm_leads" defaultTab="LEADS" />;
      case 'crm_customers':
        if (!canAccessModule('crm_customers')) return renderFallbackView();
        return <CrmView key="crm_customers" defaultTab="CUSTOMERS" />;
      case 'crm_quotations':
        if (!canAccessModule('crm_quotations')) return renderFallbackView();
        return <CrmView key="crm_quotations" defaultTab="QUOTATIONS" />;
      case 'projects_all':
        if (!canAccessModule('projects_all')) return renderFallbackView();
        return <ProjectsView />;
      case 'projects_stage_filtered':
        if (!canAccessModule('projects_stage_filtered')) return renderFallbackView();
        return <ProjectsView />;
      case 'finance':
        if (!canAccessModule('finance')) return renderFallbackView();
        return <FinanceView />;
      case 'hrms':
        if (!canAccessModule('hrms')) return renderFallbackView();
        return <HrmsView />;
      case 'service':
        if (!canAccessModule('service')) return renderFallbackView();
        return <ServiceView />;
      case 'reports':
        if (!canAccessModule('reports')) return renderFallbackView();
        return <ReportsView />;
      case 'settings':
        if (!canAccessModule('settings')) return renderFallbackView();
        return <SettingsView />;
      case 'customer_portal':
        if (!canAccessModule('customer_portal') && !isCustomer) return renderFallbackView();
        return <CustomerPortalView />;
      case 'users':
        if (!canAccessModule('users')) return renderFallbackView();
        return <UserManagementView />;
      case 'sales_purchase':
      case 'sales_bom':
      case 'sales_invoices':
      case 'vendor_sales_invoices':
      case 'sales_returns':
      case 'purchase_vendors':
      case 'purchase_orders':
      case 'purchase_returns':
      case 'inventory_products':
      case 'inventory_stock':
      case 'warehouse_management':
        if (!canAccessModule(activeView)) return renderFallbackView();
        return <SalesPurchaseView />;
      default:
        return renderFallbackView();
    }
  };

  return (
    <div className="min-h-screen bg-slate-50/60 text-slate-900 flex flex-col font-sans antialiased selection:bg-amber-100 selection:text-amber-900">
      {/* Top Universal App Header */}
      <Header onToggleMobileMenu={() => setIsMobileMenuOpen(prev => !prev)} />

      <div className="flex flex-1 overflow-hidden">
        {/* Desktop Collapsible Navigation Sidebar */}
        <Sidebar isOpen={isMobileMenuOpen} onCloseMobile={() => setIsMobileMenuOpen(false)} />

        {/* Primary Operational Stage Canvas */}
        <main className="flex-1 overflow-y-auto px-4 sm:px-6 lg:px-8 py-6 pb-24 md:pb-8 lg:ml-64">
          {(bootstrapStatus === 'error' || syncError) && (
            <div className="mb-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-rose-900 shadow-2xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-start gap-2.5 text-xs">
                <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <div>
                  <p className="font-bold text-rose-950">MySQL Database Synchronization Alert</p>
                  <p className="text-rose-800 mt-0.5">{syncError || bootstrapError || 'Unable to synchronize with the production MySQL database.'}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={handleRetrySync}
                  disabled={isRetryingSync}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold transition-colors disabled:opacity-50 cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isRetryingSync ? 'animate-spin' : ''}`} />
                  <span>{isRetryingSync ? 'Retrying...' : 'Retry MySQL Sync'}</span>
                </button>
                {syncError && bootstrapStatus !== 'error' && (
                  <button
                    type="button"
                    onClick={clearSyncError}
                    className="p-1.5 text-rose-500 hover:text-rose-800 rounded-lg cursor-pointer"
                    title="Dismiss alert"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          )}
          <div className="w-full">
            <Suspense fallback={<ViewLoader />}>
              {renderActiveView()}
            </Suspense>
          </div>
        </main>
      </div>

      {/* Mobile Responsive Bottom Navigation */}
      <MobileBottomNav />

      {/* Global Application Modals & Notification Toasters */}
      <GlobalSearchModal />
      <WhatsAppModal />
      <EmailDispatchModal />
      <ImportExportModal />
      <Toast />
    </div>
  );
};

const ProtectedApp: React.FC = () => {
  const { currentUser, isAuthenticated, loading } = useAuth();

  // Automatic employee presence lifecycle
  useWorkforcePresence(currentUser, isAuthenticated);

  // Route URL Synchronization & Protection
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // CRITICAL: Never alter routes while authentication session is actively being verified!
    if (loading) return;

    const path = window.location.pathname.toLowerCase();

    if (isAuthenticated && currentUser) {
      if (path === '/login' || path.endsWith('/login')) {
        const targetPath = getRoleDefaultPath(currentUser.role);
        window.history.replaceState(null, '', targetPath);
      }
    } else if (!isAuthenticated) {
      if (path !== '/login' && !path.endsWith('/login')) {
        window.history.replaceState(null, '', '/login');
      }
    }
  }, [isAuthenticated, currentUser, loading]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center text-slate-900 px-4">
        <div className="bg-white border border-slate-200 rounded-2xl px-8 py-6 shadow-sm flex flex-col items-center gap-3 text-center">
          <img
            src="/assets/aistudio/solar_urja_logo_07b84efe.jpeg"
            alt="Solar Urja ERP"
            className="h-12 w-auto object-contain"
          />
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 border-2 border-[#F97316] border-t-transparent rounded-full animate-spin" />
            <p className="text-xs text-slate-600 font-semibold tracking-wide">
              Verifying Solar Urja ERP session...
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!isAuthenticated || !currentUser) {
    return <LoginView />;
  }

  if (currentUser.mustChangePassword) {
    return <ForcePasswordChangeView />;
  }

  return (
    <AppProvider>
      <MainLayout />
    </AppProvider>
  );
};

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <ProtectedApp />
      </AuthProvider>
    </ErrorBoundary>
  );
}
