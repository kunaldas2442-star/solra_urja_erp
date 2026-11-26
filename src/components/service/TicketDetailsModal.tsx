import React, { useEffect, useState } from 'react';
import {
  EligibleServiceTechnician,
  Priority,
  ServiceTicket,
  ServiceTicketHistoryEntry
} from '../../types/solar';
import { apiClient } from '../../services/apiClient';
import { storageService } from '../../services/storage';
import { useApp } from '../../context/AppContext';
import { StatusBadge, PriorityBadge } from '../common/StatusBadge';
import { AuthenticatedImage } from '../common/AuthenticatedImage';
import {
  X,
  User,
  Phone,
  Mail,
  MapPin,
  Building2,
  Calendar,
  Wrench,
  Shield,
  FileText,
  Image as ImageIcon,
  Clock,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ExternalLink,
  Save,
  History
} from 'lucide-react';

interface TicketDetailsModalProps {
  isOpen: boolean;
  onClose: () => void;
  ticket: ServiceTicket | null;
  isAdmin: boolean;
  technicians: EligibleServiceTechnician[];
  onTicketUpdated: (updated: ServiceTicket) => void;
}

const TICKET_STATUS_OPTIONS: ServiceTicket['status'][] = [
  'OPEN',
  'ASSIGNED',
  'VISIT SCHEDULED',
  'IN PROGRESS',
  'RESOLVED',
  'CLOSED'
];

const PRIORITY_OPTIONS: Priority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

const formatDateTime = (val?: string | null): string => {
  if (!val) return '—';
  const d = new Date(val);
  if (Number.isNaN(d.getTime())) return String(val);
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
};

const isImageAttachment = (att: any): boolean => {
  const url = String(att?.url || att?.fileUrl || att || '').toLowerCase();
  const mime = String(att?.mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) return true;
  if (url.startsWith('data:image/')) return true;
  return /\.(png|jpe?g|webp|gif|bmp|svg)(\?|#|$)/i.test(url);
};

export const TicketDetailsModal: React.FC<TicketDetailsModalProps> = ({
  isOpen,
  onClose,
  ticket,
  isAdmin,
  technicians,
  onTicketUpdated
}) => {
  const { showToast } = useApp();
  const [detailedTicket, setDetailedTicket] = useState<ServiceTicket | null>(null);
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [previewPhotoUrl, setPreviewPhotoUrl] = useState<string | null>(null);

  // Admin management form state
  const [status, setStatus] = useState<ServiceTicket['status']>('OPEN');
  const [priority, setPriority] = useState<Priority>('MEDIUM');
  const [assignedTechId, setAssignedTechId] = useState<string>('');
  const [scheduledDate, setScheduledDate] = useState<string>('');
  const [technicianRemarks, setTechnicianRemarks] = useState<string>('');
  const [resolutionDetails, setResolutionDetails] = useState<string>('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const syncFormFromTicket = (t: ServiceTicket) => {
    setStatus(t.status || 'OPEN');
    setPriority(t.priority || 'MEDIUM');
    setAssignedTechId(t.assignedTechnicianId || '');
    setScheduledDate(t.visitScheduledDate || t.scheduledDate || '');
    setTechnicianRemarks(t.technicianRemarks || t.notes || '');
    setResolutionDetails(t.resolutionDetails || '');
  };

  useEffect(() => {
    if (!isOpen || !ticket) return;
    setDetailedTicket(ticket);
    syncFormFromTicket(ticket);
    setLoadError(null);
    setSaveError(null);
    setPreviewPhotoUrl(null);

    let cancelled = false;
    const fetchDetails = async () => {
      setIsLoadingDetails(true);
      try {
        const fresh = await apiClient.getServiceTicketDetails(ticket.id);
        if (!cancelled && fresh) {
          setDetailedTicket(fresh);
          syncFormFromTicket(fresh);
        }
      } catch (err: any) {
        if (!cancelled) {
          setLoadError(err?.message || 'Unable to fetch full ticket details from MySQL.');
        }
      } finally {
        if (!cancelled) {
          setIsLoadingDetails(false);
        }
      }
    };
    fetchDetails();
    return () => {
      cancelled = true;
    };
  }, [isOpen, ticket?.id]);

  if (!isOpen || !ticket) return null;

  const active = detailedTicket || ticket;
  const fallbackCustomer =
    !active.customerDetails && (active.customerId || active.customerName)
      ? storageService.getCustomers().find(
          c =>
            (active.customerId && c.id === active.customerId) ||
            (active.customerName && c.name.toLowerCase() === active.customerName.toLowerCase())
        )
      : null;

  const customerInfo = active.customerDetails || (fallbackCustomer
    ? {
        id: fallbackCustomer.id,
        customerCode: fallbackCustomer.customerCode,
        name: fallbackCustomer.name,
        companyName: fallbackCustomer.companyName,
        phone: fallbackCustomer.phone,
        email: fallbackCustomer.email,
        siteAddress: fallbackCustomer.siteAddress,
        city: fallbackCustomer.city,
        state: fallbackCustomer.state,
        pincode: fallbackCustomer.pincode,
        electricityConsumerNo: fallbackCustomer.electricityConsumerNo,
        sanctionedLoadKw: fallbackCustomer.sanctionedLoadKw
      }
    : null);

  const projectInfo = active.projectDetails || null;
  const amcInfo = active.amcDetails || null;
  const techInfo = active.assignedTechnicianDetails || null;

  const assignedTechName =
    active.assignedTechnicianName ||
    (active.assignedToName && active.assignedToName !== 'To be assigned' && active.assignedToName !== 'Unassigned'
      ? active.assignedToName
      : '');
  const isAssigned = Boolean(active.assignedTechnicianId || assignedTechName);

  const attachments = Array.isArray(active.photos) ? active.photos : [];
  const history: ServiceTicketHistoryEntry[] = Array.isArray(active.activityHistory)
    ? active.activityHistory
    : [];

  const handleAdminSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin) return;
    setSaveError(null);
    setIsSaving(true);
    try {
      const updated = await storageService.adminUpdateServiceTicketAsync(active.id, {
        status,
        priority,
        assignedTechnicianId: assignedTechId ? assignedTechId : null,
        scheduledDate: scheduledDate ? scheduledDate : null,
        technicianRemarks,
        resolutionDetails
      });
      setDetailedTicket(updated);
      syncFormFromTicket(updated);
      onTicketUpdated(updated);
      showToast(`Ticket ${updated.ticketId} updated in MySQL`, 'success');
    } catch (err: any) {
      const msg = err?.message || 'Failed to save ticket updates to MySQL.';
      setSaveError(msg);
      showToast(msg, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-slate-900/60 backdrop-blur-xs animate-in fade-in">
      <div className="w-full max-w-5xl max-h-[92vh] bg-white rounded-2xl shadow-2xl border border-slate-200 flex flex-col overflow-hidden">
        {/* Modal Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4 border-b border-slate-200 bg-slate-50 shrink-0">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-black px-2.5 py-0.5 rounded-md bg-amber-100 text-amber-800 border border-amber-200">
                {active.ticketId}
              </span>
              <PriorityBadge priority={active.priority} />
              <StatusBadge status={active.status} size="sm" />
              <span
                className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                  isAssigned
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    : 'bg-amber-50 text-amber-700 border-amber-200'
                }`}
              >
                {isAssigned ? 'ASSIGNED' : 'UNASSIGNED'}
              </span>
            </div>
            <h2 className="text-base sm:text-lg font-black text-slate-900 mt-1">
              {active.customerName || 'Service Ticket Details'} — {active.category}
            </h2>
            <p className="text-[11px] text-slate-500">
              Created: {formatDateTime(active.createdAt || active.createdDate)}
              {active.updatedAt ? ` • Last Updated: ${formatDateTime(active.updatedAt)}` : ''}
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 rounded-xl transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 bg-slate-50/40">
          {isLoadingDetails && (
            <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3.5 py-2.5">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Syncing full ticket details, AMC status, and activity history from MySQL...</span>
            </div>
          )}

          {loadError && (
            <div className="flex items-center gap-2 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3.5 py-2.5">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{loadError}</span>
            </div>
          )}

          {/* Top Info Cards Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Customer & Contact Details */}
            <div className="bg-white rounded-2xl p-4 border border-slate-200/80 shadow-2xs space-y-2.5">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-900 uppercase tracking-wider border-b border-slate-100 pb-2">
                <User className="w-4 h-4 text-amber-600" />
                <span>Customer & Contact</span>
              </div>
              <div className="text-xs space-y-1.5 text-slate-700">
                <p className="font-bold text-sm text-slate-900">
                  {customerInfo?.name || active.customerName || '—'}
                </p>
                {customerInfo?.companyName && (
                  <p className="flex items-center gap-1.5 text-slate-600">
                    <Building2 className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    <span>{customerInfo.companyName}</span>
                  </p>
                )}
                <p className="flex items-center gap-1.5">
                  <Phone className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  <span>{customerInfo?.phone || 'Not provided'}</span>
                </p>
                <p className="flex items-center gap-1.5 break-all">
                  <Mail className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  <span>{customerInfo?.email || 'Not provided'}</span>
                </p>
                {customerInfo?.electricityConsumerNo && (
                  <p className="text-[11px] text-slate-500 pt-1">
                    Consumer No: <strong className="text-slate-700">{customerInfo.electricityConsumerNo}</strong>
                  </p>
                )}
              </div>
            </div>

            {/* Project & Site Address */}
            <div className="bg-white rounded-2xl p-4 border border-slate-200/80 shadow-2xs space-y-2.5">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-900 uppercase tracking-wider border-b border-slate-100 pb-2">
                <MapPin className="w-4 h-4 text-blue-600" />
                <span>Project & Site Address</span>
              </div>
              <div className="text-xs space-y-1.5 text-slate-700">
                <p className="font-bold text-slate-900">
                  {projectInfo?.title || active.projectTitle || active.projectId || 'Standard Service Site'}
                </p>
                {(projectInfo?.projectCode || projectInfo?.capacityKw) && (
                  <p className="text-[11px] text-slate-500">
                    {projectInfo.projectCode ? `${projectInfo.projectCode}` : ''}
                    {projectInfo.capacityKw ? ` • ${projectInfo.capacityKw} kW` : ''}
                    {projectInfo.status ? ` • ${projectInfo.status}` : ''}
                  </p>
                )}
                <p className="text-slate-600 leading-relaxed">
                  {projectInfo?.siteAddress || customerInfo?.siteAddress || 'Site address not recorded'}
                </p>
                {(customerInfo?.city || customerInfo?.state || customerInfo?.pincode) && (
                  <p className="text-[11px] text-slate-500">
                    {[customerInfo.city, customerInfo.state, customerInfo.pincode].filter(Boolean).join(', ')}
                  </p>
                )}
              </div>
            </div>

            {/* Assigned Technician & AMC/Warranty */}
            <div className="bg-white rounded-2xl p-4 border border-slate-200/80 shadow-2xs space-y-3">
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-xs font-bold text-slate-900 uppercase tracking-wider border-b border-slate-100 pb-2">
                  <Wrench className="w-4 h-4 text-emerald-600" />
                  <span>Assigned Technician</span>
                </div>
                {isAssigned ? (
                  <div className="text-xs space-y-1 text-slate-700">
                    <p className="font-bold text-slate-900">
                      {techInfo?.name || assignedTechName}
                    </p>
                    <p className="text-[11px] text-slate-500">
                      {[techInfo?.employeeCode, techInfo?.role || techInfo?.designation]
                        .filter(Boolean)
                        .join(' • ') || 'Field Technician'}
                    </p>
                    {techInfo?.phone && (
                      <p className="text-[11px] text-slate-600 flex items-center gap-1">
                        <Phone className="w-3 h-3 text-slate-400" />
                        {techInfo.phone}
                      </p>
                    )}
                    {active.assignedAt && (
                      <p className="text-[11px] text-slate-400">
                        Assigned: {formatDateTime(active.assignedAt)}
                        {active.assignedByName ? ` by ${active.assignedByName}` : ''}
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
                    Unassigned — awaiting Admin technician dispatch
                  </p>
                )}
              </div>

              <div className="pt-2 border-t border-slate-100 space-y-1">
                <div className="flex items-center gap-1.5 text-[11px] font-bold text-slate-800 uppercase tracking-wider">
                  <Shield className="w-3.5 h-3.5 text-indigo-600" />
                  <span>AMC / Warranty</span>
                </div>
                {amcInfo ? (
                  <div className="text-[11px] text-slate-600 space-y-0.5">
                    <p className="font-bold text-indigo-800">
                      {amcInfo.amcCode} • {amcInfo.planName}
                    </p>
                    <p>
                      Status: <strong>{amcInfo.status}</strong> • Visits: {amcInfo.visitsCompleted}/{amcInfo.totalVisits}
                    </p>
                    <p className="text-slate-500">
                      Valid: {amcInfo.startDate} → {amcInfo.endDate}
                    </p>
                  </div>
                ) : (
                  <p className="text-[11px] text-slate-500">No active AMC contract linked to this customer/project.</p>
                )}
              </div>
            </div>
          </div>

          {/* Issue Description, Schedule, Remarks & Resolution */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-white rounded-2xl p-4 border border-slate-200/80 shadow-2xs space-y-3">
              <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                <span className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                  <FileText className="w-4 h-4 text-amber-600" />
                  Issue & Schedule Details
                </span>
                <span className="text-[11px] font-semibold text-amber-700">{active.category}</span>
              </div>

              <div className="p-3 rounded-xl bg-slate-50 border border-slate-100 text-xs text-slate-700 leading-relaxed whitespace-pre-wrap">
                {active.issue || active.description || 'No issue description provided.'}
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs pt-1">
                <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-100">
                  <span className="text-[10px] font-bold uppercase text-slate-400 block">Scheduled Visit</span>
                  <span className="font-semibold text-slate-800 flex items-center gap-1 mt-0.5">
                    <Calendar className="w-3.5 h-3.5 text-slate-400" />
                    {active.visitScheduledDate || active.scheduledDate || 'Not scheduled'}
                  </span>
                </div>
                <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-100">
                  <span className="text-[10px] font-bold uppercase text-slate-400 block">Resolved Date</span>
                  <span className="font-semibold text-slate-800 flex items-center gap-1 mt-0.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                    {active.resolvedDate || 'Pending'}
                  </span>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-2xl p-4 border border-slate-200/80 shadow-2xs space-y-3">
              <div className="text-xs font-bold text-slate-900 uppercase tracking-wider border-b border-slate-100 pb-2 flex items-center gap-1.5">
                <Wrench className="w-4 h-4 text-emerald-600" />
                <span>Technician Remarks & Resolution</span>
              </div>

              <div className="space-y-2.5 text-xs">
                <div>
                  <span className="text-[11px] font-bold text-slate-500 block mb-1">
                    Technician Remarks / Work Updates
                  </span>
                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-100 text-slate-700 whitespace-pre-wrap">
                    {active.technicianRemarks || active.notes || 'No technician remarks logged yet.'}
                  </div>
                </div>
                <div>
                  <span className="text-[11px] font-bold text-slate-500 block mb-1">
                    Resolution Details
                  </span>
                  <div className="p-3 rounded-xl bg-emerald-50/50 border border-emerald-100 text-slate-700 whitespace-pre-wrap">
                    {active.resolutionDetails || 'Ticket has not been marked with final resolution details yet.'}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Customer-Uploaded Photos & Documents */}
          <div className="bg-white rounded-2xl p-4 border border-slate-200/80 shadow-2xs space-y-3">
            <div className="flex items-center justify-between border-b border-slate-100 pb-2">
              <span className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                <ImageIcon className="w-4 h-4 text-purple-600" />
                Customer Photos & Documents ({attachments.length})
              </span>
            </div>

            {attachments.length === 0 ? (
              <p className="text-xs text-slate-500 py-2">
                No customer photos or documents attached to this ticket.
              </p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {attachments.map((att: any, idx: number) => {
                  const url = typeof att === 'string' ? att : att?.url || att?.fileUrl || '';
                  const label =
                    typeof att === 'string'
                      ? `Attachment ${idx + 1}`
                      : att?.caption || att?.name || att?.fileName || `Attachment ${idx + 1}`;
                  const isImg = isImageAttachment(att);
                  return (
                    <div
                      key={att?.id || `${idx}-${label}`}
                      className="rounded-xl border border-slate-200 bg-slate-50 overflow-hidden flex flex-col"
                    >
                      {isImg && url ? (
                        <button
                          type="button"
                          onClick={() => setPreviewPhotoUrl(url)}
                          className="h-28 w-full bg-slate-100 overflow-hidden group relative"
                        >
                          <AuthenticatedImage
                            src={url}
                            alt={label}
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                          />
                        </button>
                      ) : (
                        <div className="h-28 w-full bg-slate-100 flex flex-col items-center justify-center p-2 text-slate-500">
                          <FileText className="w-7 h-7 mb-1 text-slate-400" />
                          <span className="text-[10px] font-semibold text-center line-clamp-2">{label}</span>
                        </div>
                      )}
                      <div className="p-2 flex items-center justify-between gap-1 bg-white border-t border-slate-100">
                        <span className="text-[11px] font-medium text-slate-700 truncate" title={label}>
                          {label}
                        </span>
                        {url && (
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:text-blue-800 shrink-0"
                            title="Open attachment"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Admin Management Controls */}
          {isAdmin && (
            <form
              onSubmit={handleAdminSave}
              className="bg-white rounded-2xl p-5 border-2 border-amber-200/80 shadow-2xs space-y-4"
            >
              <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
                <div>
                  <h3 className="text-xs font-black text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                    <Shield className="w-4 h-4 text-amber-600" />
                    Admin Ticket Management Controls
                  </h3>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    Update status, priority, field technician assignment, visit schedule, remarks, and resolution in MySQL.
                  </p>
                </div>
              </div>

              {saveError && (
                <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{saveError}</span>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">Ticket Status</label>
                  <select
                    value={status}
                    onChange={e => setStatus(e.target.value as ServiceTicket['status'])}
                    className="w-full text-xs border border-slate-200 rounded-xl p-2.5 bg-white font-semibold focus:outline-hidden focus:ring-2 focus:ring-amber-500"
                  >
                    {TICKET_STATUS_OPTIONS.map(s => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">Priority</label>
                  <select
                    value={priority}
                    onChange={e => setPriority(e.target.value as Priority)}
                    className="w-full text-xs border border-slate-200 rounded-xl p-2.5 bg-white font-semibold focus:outline-hidden focus:ring-2 focus:ring-amber-500"
                  >
                    {PRIORITY_OPTIONS.map(p => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">
                    Assigned Technician (Field Workers)
                  </label>
                  <select
                    value={assignedTechId}
                    onChange={e => setAssignedTechId(e.target.value)}
                    className="w-full text-xs border border-slate-200 rounded-xl p-2.5 bg-white font-medium focus:outline-hidden focus:ring-2 focus:ring-amber-500"
                  >
                    <option value="">— Unassigned —</option>
                    {technicians.map(tech => (
                      <option key={tech.id} value={tech.id}>
                        {tech.name} ({tech.role || tech.designation || 'Technician'})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">Scheduled Visit Date</label>
                  <input
                    type="date"
                    value={scheduledDate}
                    onChange={e => setScheduledDate(e.target.value)}
                    className="w-full text-xs border border-slate-200 rounded-xl p-2.5 bg-white focus:outline-hidden focus:ring-2 focus:ring-amber-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">
                    Technician Remarks / Work Updates
                  </label>
                  <textarea
                    rows={2}
                    value={technicianRemarks}
                    onChange={e => setTechnicianRemarks(e.target.value)}
                    placeholder="Site findings, diagnostics, spares required..."
                    className="w-full text-xs border border-slate-200 rounded-xl p-2.5 focus:outline-hidden focus:ring-2 focus:ring-amber-500"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">
                    Resolution Details
                  </label>
                  <textarea
                    rows={2}
                    value={resolutionDetails}
                    onChange={e => setResolutionDetails(e.target.value)}
                    placeholder="Root cause and final fix summary..."
                    className="w-full text-xs border border-slate-200 rounded-xl p-2.5 focus:outline-hidden focus:ring-2 focus:ring-amber-500"
                  />
                </div>
              </div>

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={isSaving}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-amber-500 hover:bg-amber-600 rounded-xl shadow-2xs transition-colors disabled:opacity-50"
                >
                  {isSaving ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Saving to MySQL...</span>
                    </>
                  ) : (
                    <>
                      <Save className="w-3.5 h-3.5" />
                      <span>Save Ticket Updates</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          )}

          {/* Complete Ticket Activity & History Timeline */}
          <div className="bg-white rounded-2xl p-4 border border-slate-200/80 shadow-2xs space-y-3">
            <div className="flex items-center justify-between border-b border-slate-100 pb-2">
              <span className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                <History className="w-4 h-4 text-slate-600" />
                Ticket Activity & History Timeline ({history.length})
              </span>
            </div>

            {history.length === 0 ? (
              <p className="text-xs text-slate-500 py-2">
                No activity timeline entries recorded yet. Updates to status, priority, assignment, or remarks will be logged here.
              </p>
            ) : (
              <div className="space-y-3">
                {history.map(entry => (
                  <div
                    key={entry.id}
                    className="flex items-start gap-3 p-3 rounded-xl bg-slate-50 border border-slate-100"
                  >
                    <div className="w-7 h-7 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center shrink-0 mt-0.5">
                      <Clock className="w-3.5 h-3.5" />
                    </div>
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded bg-slate-200 text-slate-800">
                            {entry.actionType.replace(/_/g, ' ')}
                          </span>
                          <span className="text-xs font-semibold text-slate-800">
                            {entry.actorName || 'System'}
                          </span>
                          {entry.actorRole && (
                            <span className="text-[10px] text-slate-500 font-medium">
                              ({entry.actorRole})
                            </span>
                          )}
                        </div>
                        <span className="text-[11px] text-slate-400">
                          {formatDateTime(entry.createdAt)}
                        </span>
                      </div>

                      {(entry.previousValue || entry.newValue) && (
                        <p className="text-xs text-slate-700">
                          {entry.previousValue ? (
                            <>
                              <span className="line-through text-slate-400">{entry.previousValue}</span>
                              <span className="mx-1.5 text-slate-400">→</span>
                            </>
                          ) : null}
                          <strong className="text-slate-900">{entry.newValue || '—'}</strong>
                        </p>
                      )}

                      {entry.remarks && (
                        <p className="text-xs text-slate-600 italic">{entry.remarks}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-slate-200 bg-white flex justify-end shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors"
          >
            Close Details
          </button>
        </div>
      </div>

      {/* Photo Lightbox */}
      {previewPhotoUrl && (
        <div
          onClick={() => setPreviewPhotoUrl(null)}
          className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-4"
        >
          <div className="relative max-w-4xl max-h-[90vh]" onClick={e => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => setPreviewPhotoUrl(null)}
              className="absolute -top-3 -right-3 w-8 h-8 rounded-full bg-white text-slate-900 shadow-lg flex items-center justify-center"
            >
              <X className="w-4 h-4" />
            </button>
            <AuthenticatedImage
              src={previewPhotoUrl}
              alt="Customer attachment preview"
              className="max-w-full max-h-[85vh] rounded-xl shadow-2xl object-contain bg-white"
            />
          </div>
        </div>
      )}
    </div>
  );
};
