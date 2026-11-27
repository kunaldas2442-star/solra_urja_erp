import React, { useState, useEffect } from 'react';
import {
  Database,
  Server,
  Download,
  UploadCloud,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Layers,
  HardDrive
} from 'lucide-react';
import { apiClient, DbStatusResponse } from '../../services/apiClient';
import { useApp } from '../../context/AppContext';

export const DatabaseSettingsPanel: React.FC = () => {
  const { showToast } = useApp();
  const [status, setStatus] = useState<DbStatusResponse | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isMigrating, setIsMigrating] = useState<boolean>(false);
  const [migrationResult, setMigrationResult] = useState<string | null>(null);

  const loadStatus = async () => {
    setIsLoading(true);
    try {
      const res = await apiClient.getDbStatus();
      setStatus(res);
    } catch {
      // Ignored
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadStatus();
  }, []);

  const handleRunMigration = async () => {
    if (!window.confirm('Verify MySQL schema and ensure all relational tables and system records are synchronized?')) {
      return;
    }
    setIsMigrating(true);
    setMigrationResult(null);
    try {
      const res = await apiClient.runMigration();
      if (res.success) {
        setMigrationResult(res.message);
        showToast(res.message, 'success');
        await loadStatus();
      } else {
        setMigrationResult(`Error: ${res.message}`);
        showToast(res.message, 'error');
      }
    } catch (e: any) {
      const msg = e.message || 'Migration failed';
      setMigrationResult(`Error: ${msg}`);
      showToast(msg, 'error');
    } finally {
      setIsMigrating(false);
    }
  };

  const handleDownloadDump = () => {
    window.location.href = apiClient.getSqlDumpDownloadUrl();
    showToast('Downloading complete Solar Urja ERP MySQL database dump (.sql)...', 'info');
  };

  const apiEndpoints = [
    { method: 'POST', path: '/api/auth/login', module: 'Authentication', desc: 'Secure portal authentication verified against MySQL bcrypt credentials' },
    { method: 'GET', path: '/api/auth/me', module: 'Session Verification', desc: 'Authoritative HttpOnly cookie session check in solar_auth_sessions' },
    { method: 'POST', path: '/api/auth/change-password', module: 'Password Security', desc: 'Self-service password update & default-account activation in MySQL' },
    { method: 'GET / POST', path: '/api/customers', module: 'Customer Directory', desc: 'Query all accounts, create new commercial customer' },
    { method: 'PUT', path: '/api/customers/:id/password', module: 'Customer Security', desc: 'Update portal password for customer account' },
    { method: 'GET / POST', path: '/api/leads', module: 'CRM Pipeline', desc: 'Commercial lead intake, estimations & salesperson routing' },
    { method: 'GET / POST', path: '/api/projects', module: 'EPC Projects', desc: 'Project lifecycle, 14 workflow stages & completion %' },
    { method: 'GET / POST', path: '/api/products', module: 'Inventory ERP', desc: 'PV modules, inverters, structures, stock levels & HSN' },
    { method: 'GET / POST', path: '/api/vendors', module: 'Procurement', desc: 'Tier-1 vendors, payment terms & supplier ratings' },
    { method: 'GET / POST', path: '/api/purchase-orders', module: 'Purchase ERP', desc: 'Purchase orders, GST calculation & delivery receipts' },
    { method: 'GET / POST', path: '/api/boms', module: 'Engineering BOM', desc: 'Bill of Materials allocation & system capacity sizing' },
    { method: 'GET / POST', path: '/api/sales-invoices', module: 'Sales & Invoicing', desc: 'GST invoices, e-Way bill details & warehouse address' },
    { method: 'GET / POST', path: '/api/warehouses', module: 'Logistics Depot', desc: 'Regional warehouse inventory and dispatch control' },
    { method: 'GET', path: '/api/stock-movements', module: 'Inventory Ledger', desc: 'BOM allocation & purchase receipt tracking' },
    { method: 'GET / POST', path: '/api/employees', module: 'HRMS Operations', desc: 'Technicians, engineers, wage brackets & login toggle' },
    { method: 'GET / POST', path: '/api/attendance', module: 'Field Attendance', desc: 'GPS-verified check-in stamps & project site tags' },
    { method: 'GET / POST', path: '/api/payments', module: 'Financials', desc: 'Milestone billing receipts & Tally Prime sync status' },
    { method: 'GET / POST', path: '/api/service-tickets', module: 'O&M Service', desc: 'Preventive maintenance tickets & technician dispatch' },
    { method: 'GET', path: '/api/db/status', module: 'System Database', desc: 'MySQL connection pool status and health' },
    { method: 'POST', path: '/api/db/migrate', module: 'Data Migration', desc: 'Apply idempotent MySQL schema & account verification' },
    { method: 'GET', path: '/api/db/dump.sql', module: 'Export Database', desc: 'Direct download of production MySQL SQL dump file' }
  ];

  const tablesCount = status?.tablesCount ?? status?.tables?.length ?? 28;

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="bg-gradient-to-r from-[#0F2954] to-[#1E3A8A] rounded-2xl p-6 text-white shadow-md border border-slate-200 relative overflow-hidden">
        <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-5">
          <div className="space-y-1.5 max-w-2xl">
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-md bg-white/10 border border-white/20 text-orange-200 text-xs font-semibold">
              <Database className="w-3.5 h-3.5" />
              <span>Production MySQL Database & REST APIs</span>
            </div>
            <h2 className="text-xl sm:text-2xl font-black tracking-tight text-white">
              MySQL Schema Maintenance & Server APIs
            </h2>
            <p className="text-xs sm:text-sm text-slate-200 leading-relaxed">
              Authoritative MySQL / MariaDB persistence configured exclusively via server-side environment variables.
              No database credentials are ever stored or exposed in browser code.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={handleDownloadDump}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-[#F97316] hover:bg-[#EA580C] text-white font-bold text-xs rounded-xl shadow-sm transition-all cursor-pointer"
            >
              <Download className="w-4 h-4" />
              <span>Download SQL Dump</span>
            </button>
            <button
              onClick={handleRunMigration}
              disabled={isMigrating}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-white/10 hover:bg-white/20 text-white font-bold text-xs rounded-xl border border-white/20 transition-all disabled:opacity-50 cursor-pointer"
            >
              <UploadCloud className={`w-4 h-4 ${isMigrating ? 'animate-bounce' : ''}`} />
              <span>{isMigrating ? 'Synchronizing...' : 'Run Schema Sync'}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Migration Notice / Success Banner */}
      {migrationResult && (
        <div className={`p-4 rounded-xl border flex items-start gap-3 ${
          migrationResult.startsWith('Error')
            ? 'bg-rose-50 border-rose-200 text-rose-800'
            : 'bg-emerald-50 border-emerald-200 text-emerald-800'
        }`}>
          {migrationResult.startsWith('Error') ? (
            <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
          ) : (
            <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5" />
          )}
          <div className="text-xs space-y-1">
            <p className="font-bold">{migrationResult.startsWith('Error') ? 'Migration Alert' : 'Migration Completed'}</p>
            <p>{migrationResult}</p>
          </div>
        </div>
      )}

      {/* Database Connection & Status Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {/* Connection Status Card */}
        <div className="bg-white rounded-2xl p-5 border border-slate-200/80 shadow-2xs space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Server className="w-4 h-4 text-amber-600" />
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">Database Engine</h3>
            </div>
            <button
              onClick={loadStatus}
              disabled={isLoading}
              className="text-slate-400 hover:text-slate-700 p-1 cursor-pointer"
              title="Refresh status"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          <div className="space-y-3 pt-1">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100 text-xs">
              <span className="text-slate-500 font-medium">Engine</span>
              <span className="font-mono font-bold text-slate-800">MySQL 8.0+ / MariaDB</span>
            </div>
            <div className="flex items-center justify-between pb-2 border-b border-slate-100 text-xs">
              <span className="text-slate-500 font-medium">Connection State</span>
              <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-bold ${
                status?.connected
                  ? 'bg-emerald-100 text-emerald-800'
                  : 'bg-rose-100 text-rose-800'
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${status?.connected ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                {status?.connected ? 'LIVE POOL ACTIVE' : 'DISCONNECTED / OFFLINE'}
              </span>
            </div>
            <div className="flex items-center justify-between pb-2 border-b border-slate-100 text-xs">
              <span className="text-slate-500 font-medium">Pool Mode</span>
              <span className="font-mono font-bold text-slate-800">{status?.mode || 'DISCONNECTED'}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-500 font-medium">Configuration Source</span>
              <span className="font-mono font-semibold text-emerald-700">Server .env (Protected)</span>
            </div>
            {!status?.connected && status?.message && (
              <div className="mt-2 p-2.5 rounded-xl bg-rose-50 border border-rose-200 text-[11px] text-rose-800 font-medium">
                {status.message}
              </div>
            )}
          </div>
        </div>

        {/* Database Tables & Dump Info */}
        <div className="bg-white rounded-2xl p-5 border border-slate-200/80 shadow-2xs space-y-4">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-blue-600" />
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">Schema & Tables</h3>
          </div>

          <div className="space-y-3 pt-1">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100 text-xs">
              <span className="text-slate-500 font-medium">Active Tables</span>
              <span className="font-bold text-slate-900">{tablesCount} Relational Tables</span>
            </div>
            <div className="flex items-center justify-between pb-2 border-b border-slate-100 text-xs">
              <span className="text-slate-500 font-medium">Encoding</span>
              <span className="font-mono text-slate-800">utf8mb4_unicode_ci</span>
            </div>
            <div className="flex items-center justify-between pb-2 border-b border-slate-100 text-xs">
              <span className="text-slate-500 font-medium">Schema File</span>
              <span className="font-mono text-emerald-700 font-bold">database.sql</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-500 font-medium">Session Store</span>
              <span className="text-emerald-700 font-bold">MySQL HttpOnly Cookies</span>
            </div>
          </div>

          <button
            onClick={handleDownloadDump}
            className="w-full mt-2 py-2 text-xs font-bold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-xl transition-colors inline-flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Download SQL File</span>
          </button>
        </div>

        {/* Deployment Steps Summary */}
        <div className="bg-white rounded-2xl p-5 border border-slate-200/80 shadow-2xs space-y-3">
          <div className="flex items-center gap-2">
            <HardDrive className="w-4 h-4 text-emerald-600" />
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">Production Deployment</h3>
          </div>

          <ol className="text-xs text-slate-600 space-y-2.5 pt-1 list-decimal list-inside">
            <li>
              <span className="font-semibold text-slate-800">Configure Environment:</span> Set <code className="bg-slate-100 px-1 py-0.5 rounded text-[11px]">DB_HOST, DB_PORT, DB_USER, DB_PASS, DB_NAME</code> in your server <code className="bg-slate-100 px-1 py-0.5 rounded text-[11px]">.env</code>.
            </li>
            <li>
              <span className="font-semibold text-slate-800">Import Schema:</span> Import <code className="bg-slate-100 px-1 py-0.5 rounded text-[11px]">database.sql</code> or run <code className="bg-slate-100 px-1 py-0.5 rounded text-[11px]">npx tsx scripts/migrate-auth-accounts.ts</code>.
            </li>
            <li>
              <span className="font-semibold text-slate-800">Rotate Default Passwords:</span> Sign in and change all seeded account passwords before production rollout.
            </li>
            <li>
              <span className="font-semibold text-slate-800">Build & Serve:</span> Run <code className="bg-slate-100 px-1 py-0.5 rounded text-[11px]">npm run build</code> and start the Node.js server.
            </li>
          </ol>
        </div>
      </div>

      {/* REST API Endpoints Directory */}
      <div className="bg-white rounded-2xl p-6 border border-slate-200/80 shadow-2xs space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-slate-100">
          <div>
            <h3 className="text-sm font-bold text-slate-900">Module REST APIs Directory</h3>
            <p className="text-xs text-slate-500">
              Live server routes providing direct JSON operations for every ERP module
            </p>
          </div>
          <span className="text-xs font-bold text-amber-700 bg-amber-50 px-2.5 py-1 rounded-md border border-amber-200">
            20+ REST Endpoints Active
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200/80 bg-slate-50/80 text-slate-500 font-bold uppercase tracking-wider">
                <th className="py-2.5 px-3">Method</th>
                <th className="py-2.5 px-3">Endpoint Route</th>
                <th className="py-2.5 px-3">Module</th>
                <th className="py-2.5 px-3">Operation Description</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-mono">
              {apiEndpoints.map((ep, idx) => (
                <tr key={idx} className="hover:bg-slate-50/60 transition-colors">
                  <td className="py-2.5 px-3 font-bold text-amber-700">
                    <span className="px-2 py-0.5 rounded bg-amber-100/70 border border-amber-200">
                      {ep.method}
                    </span>
                  </td>
                  <td className="py-2.5 px-3 font-bold text-slate-900">
                    {ep.path}
                  </td>
                  <td className="py-2.5 px-3 font-sans font-semibold text-slate-700">
                    {ep.module}
                  </td>
                  <td className="py-2.5 px-3 font-sans text-slate-500">
                    {ep.desc}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
