import React, { useEffect, useMemo, useState } from 'react';
import { apiClient, AuditLogEntry } from '../../services/apiClient';
import {
  Activity,
  RefreshCw,
  Search,
  Filter,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  User,
  Clock,
  ChevronDown,
  ChevronRight,
  ShieldCheck
} from 'lucide-react';

const MODULE_OPTIONS = [
  'ALL',
  'AUTH',
  'USERS',
  'CUSTOMERS',
  'LEADS',
  'PROJECTS',
  'HRMS',
  'PAYROLL',
  'DOCUMENTS',
  'INVENTORY',
  'PROCUREMENT',
  'CRM',
  'FINANCE',
  'SERVICE',
  'SETTINGS',
  'ACL',
  'DATABASE'
];

export const AuditLogsPanel: React.FC = () => {
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [moduleFilter, setModuleFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [limit, setLimit] = useState<number>(200);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const loadLogs = async (selectedModule = moduleFilter, selectedLimit = limit) => {
    setLoading(true);
    setError(null);
    try {
      const items = await apiClient.getAuditLogs({
        module: selectedModule !== 'ALL' ? selectedModule : undefined,
        limit: selectedLimit
      });
      setLogs(items);
    } catch (err: any) {
      setError(err?.message || 'Unable to load system audit logs.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLogs(moduleFilter, limit);
  }, [moduleFilter, limit]);

  const filteredLogs = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return logs.filter(entry => {
      if (statusFilter !== 'ALL' && String(entry.status).toUpperCase() !== statusFilter) {
        return false;
      }
      if (!q) return true;
      const haystack = [
        entry.actorName,
        entry.actorRole,
        entry.actorId,
        entry.module,
        entry.action,
        entry.entityType,
        entry.entityId,
        entry.summary,
        entry.ipAddress
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [logs, statusFilter, searchTerm]);

  const formatTimestamp = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  const renderStatusBadge = (status: string) => {
    const norm = String(status || 'SUCCESS').toUpperCase();
    if (norm === 'SUCCESS') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
          <CheckCircle2 className="w-3 h-3" />
          <span>SUCCESS</span>
        </span>
      );
    }
    if (norm === 'FAILED' || norm === 'ERROR') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-50 text-rose-700 border border-rose-200">
          <XCircle className="w-3 h-3" />
          <span>{norm}</span>
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">
        <AlertTriangle className="w-3 h-3" />
        <span>{norm}</span>
      </span>
    );
  };

  return (
    <div className="space-y-4">
      {/* Header & Controls */}
      <div className="bg-white rounded-2xl p-5 border border-slate-200/80 shadow-2xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-100">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-indigo-50 border border-indigo-200 flex items-center justify-center text-indigo-700">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">Production Security & Activity Audit Trail</h3>
              <p className="text-xs text-slate-500">
                Server-recorded trail of authentication events, uploads, role changes, and business mutations
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => loadLogs(moduleFilter, limit)}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-200 rounded-xl transition-colors cursor-pointer self-start sm:self-auto disabled:opacity-60"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh Logs</span>
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder="Search actor, summary, entity ID..."
              className="w-full pl-8 pr-3 py-2 text-xs border border-slate-200 rounded-xl bg-slate-50 focus:bg-white focus:outline-hidden focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <div className="flex items-center gap-2">
            <Filter className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <select
              value={moduleFilter}
              onChange={e => setModuleFilter(e.target.value)}
              aria-label="Filter by module"
              className="w-full text-xs border border-slate-200 rounded-xl p-2 bg-white font-medium"
            >
              {MODULE_OPTIONS.map(mod => (
                <option key={mod} value={mod}>
                  {mod === 'ALL' ? 'All Modules' : mod}
                </option>
              ))}
            </select>
          </div>

          <div>
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
              aria-label="Filter by status"
              className="w-full text-xs border border-slate-200 rounded-xl p-2 bg-white font-medium"
            >
              <option value="ALL">All Statuses</option>
              <option value="SUCCESS">Success Only</option>
              <option value="FAILED">Failed Only</option>
            </select>
          </div>

          <div>
            <select
              value={limit}
              onChange={e => setLimit(Number(e.target.value))}
              aria-label="Log row limit"
              className="w-full text-xs border border-slate-200 rounded-xl p-2 bg-white font-medium"
            >
              <option value={50}>Latest 50 entries</option>
              <option value={200}>Latest 200 entries</option>
              <option value={500}>Latest 500 entries</option>
            </select>
          </div>
        </div>
      </div>

      {/* Results Table */}
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-2xs overflow-hidden">
        {loading && logs.length === 0 ? (
          <div className="p-10 flex flex-col items-center justify-center text-slate-500 gap-2">
            <Loader2 className="w-6 h-6 animate-spin text-indigo-600" />
            <span className="text-xs font-medium">Loading audit trail...</span>
          </div>
        ) : error ? (
          <div className="p-6 text-center text-xs text-rose-700 bg-rose-50/50">
            <AlertTriangle className="w-5 h-5 mx-auto mb-1 text-rose-600" />
            <p className="font-bold">{error}</p>
          </div>
        ) : filteredLogs.length === 0 ? (
          <div className="p-10 text-center text-slate-500">
            <Activity className="w-7 h-7 mx-auto mb-2 text-slate-300" />
            <p className="text-xs font-bold text-slate-700">No audit entries match your current filter</p>
            <p className="text-[11px] text-slate-400 mt-0.5">
              Audit entries are recorded automatically when users authenticate, upload files, or modify records.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-[11px] font-bold text-slate-600 uppercase tracking-wider">
                  <th className="py-3 px-4 w-8"></th>
                  <th className="py-3 px-3">Timestamp</th>
                  <th className="py-3 px-3">Actor</th>
                  <th className="py-3 px-3">Module / Action</th>
                  <th className="py-3 px-3">Summary</th>
                  <th className="py-3 px-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {filteredLogs.map(entry => {
                  const isExpanded = expandedId === entry.id;
                  return (
                    <React.Fragment key={entry.id}>
                      <tr
                        onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                        className="hover:bg-slate-50/80 transition-colors cursor-pointer"
                      >
                        <td className="py-3 px-4 text-slate-400">
                          {isExpanded ? (
                            <ChevronDown className="w-3.5 h-3.5" />
                          ) : (
                            <ChevronRight className="w-3.5 h-3.5" />
                          )}
                        </td>
                        <td className="py-3 px-3 whitespace-nowrap text-[11px] text-slate-500 font-mono">
                          <div className="flex items-center gap-1.5">
                            <Clock className="w-3 h-3 text-slate-400 shrink-0" />
                            <span>{formatTimestamp(entry.createdAt)}</span>
                          </div>
                        </td>
                        <td className="py-3 px-3">
                          <div className="flex items-center gap-1.5 font-bold text-slate-900">
                            <User className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                            <span>{entry.actorName || 'System'}</span>
                          </div>
                          <span className="text-[10px] text-slate-500 block pl-5">
                            {entry.actorRole}
                          </span>
                        </td>
                        <td className="py-3 px-3">
                          <span className="inline-block text-[10px] font-bold px-2 py-0.5 rounded-md bg-slate-100 text-slate-800 border border-slate-200 mr-1.5">
                            {entry.module}
                          </span>
                          <span className="font-mono text-[11px] font-semibold text-indigo-700">
                            {entry.action}
                          </span>
                        </td>
                        <td className="py-3 px-3 text-slate-700 max-w-md">
                          <p className="line-clamp-2 font-medium">{entry.summary}</p>
                          {(entry.entityType || entry.entityId) && (
                            <span className="text-[10px] font-mono text-slate-400">
                              {[entry.entityType, entry.entityId].filter(Boolean).join(': ')}
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-3 whitespace-nowrap">
                          {renderStatusBadge(entry.status)}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="bg-slate-50/70">
                          <td colSpan={6} className="px-6 py-3 text-[11px] text-slate-600">
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-2">
                              <div>
                                <span className="font-bold text-slate-500">Audit ID:</span>{' '}
                                <span className="font-mono">{entry.id}</span>
                              </div>
                              <div>
                                <span className="font-bold text-slate-500">Actor ID:</span>{' '}
                                <span className="font-mono">{entry.actorId}</span>
                              </div>
                              <div>
                                <span className="font-bold text-slate-500">IP Address:</span>{' '}
                                <span className="font-mono">{entry.ipAddress || '—'}</span>
                              </div>
                            </div>
                            {entry.details && (
                              <pre className="p-2.5 rounded-xl bg-slate-900 text-slate-100 font-mono text-[10px] overflow-x-auto">
                                {JSON.stringify(entry.details, null, 2)}
                              </pre>
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
