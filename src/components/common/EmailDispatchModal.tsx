import React, { useEffect, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { apiClient } from '../../services/apiClient';
import { formatINR } from '../../utils/indianNumberWords';
import { Mail, X, Send, Loader2, CheckCircle2, AlertTriangle, Settings } from 'lucide-react';

export type EmailDispatchType =
  | 'LEAD_WELCOME'
  | 'CUSTOMER_MESSAGE'
  | 'QUOTATION_SHARE'
  | 'INVOICE_SHARE'
  | 'VENDOR_MESSAGE'
  | 'PAYSLIP_SHARE'
  | 'SERVICE_TICKET'
  | 'GENERAL';

function buildDefaultEmailTemplate(
  type: EmailDispatchType,
  recipientName: string,
  data: any,
  companyName: string
): { subject: string; body: string } {
  const brand = companyName || 'Solar Urja ERP';
  const name = recipientName || 'Customer';

  switch (type) {
    case 'LEAD_WELCOME':
      return {
        subject: `Solar EPC Consultation & Proposal Inquiry — ${brand}`,
        body: [
          `Dear ${name},`,
          '',
          `Thank you for connecting with ${brand} regarding your ${data?.capacityKw ? `${data.capacityKw} kW ` : ''}solar rooftop power inquiry.`,
          'Our solar engineering team has logged your requirement and will review your site feasibility, energy load profile, and subsidy eligibility.',
          '',
          'Please reply to this email with your latest electricity bill or preferred time for a site survey.',
          '',
          'Warm regards,',
          `${brand}`
        ].join('\n')
      };

    case 'QUOTATION_SHARE':
      return {
        subject: `Solar EPC Quotation ${data?.quotationNumber || ''} (${data?.capacityKw || ''} kW) — ${brand}`.trim(),
        body: [
          `Dear ${name},`,
          '',
          `Please find the summary of your solar EPC proposal${data?.quotationNumber ? ` (${data.quotationNumber})` : ''} from ${brand}:`,
          data?.capacityKw ? `• Proposed Solar Capacity: ${data.capacityKw} kW` : '',
          data?.amount ? `• Total Project Investment: ${formatINR(Number(data.amount))}` : '',
          data?.validUntil ? `• Proposal Valid Until: ${data.validUntil}` : '',
          '',
          'We are happy to walk you through the Tier-1 BOM specifications, ROI payback schedule, and MNRE/DISCOM net-metering timeline.',
          '',
          'Warm regards,',
          `${brand}`
        ]
          .filter(Boolean)
          .join('\n')
      };

    case 'INVOICE_SHARE':
      return {
        subject: `Tax Invoice ${data?.invoiceNumber || ''} — ${brand}`.trim(),
        body: [
          `Dear ${name},`,
          '',
          `Please find the billing details for Tax Invoice ${data?.invoiceNumber || ''} issued by ${brand}:`,
          data?.invoiceDate ? `• Invoice Date: ${data.invoiceDate}` : '',
          data?.dueDate ? `• Due Date: ${data.dueDate}` : '',
          data?.totalAmount ? `• Grand Total (incl. GST): ${formatINR(Number(data.totalAmount))}` : '',
          data?.status ? `• Payment Status: ${data.status}` : '',
          '',
          'Kindly reach out to our accounts desk for any GST or remittance clarifications.',
          '',
          'Regards,',
          `Accounts Team, ${brand}`
        ]
          .filter(Boolean)
          .join('\n')
      };

    case 'VENDOR_MESSAGE':
      return {
        subject: `Procurement & Supply Inquiry — ${brand}`,
        body: [
          `Dear ${name}${data?.contactPerson ? ` (${data.contactPerson})` : ''},`,
          '',
          `Greetings from the Procurement Team at ${brand}.`,
          'We are reaching out regarding material availability, GST billing terms, and dispatch schedules for our active solar EPC projects.',
          '',
          'Please reply with your updated price list and lead time.',
          '',
          'Best regards,',
          `Procurement Desk, ${brand}`
        ].join('\n')
      };

    case 'PAYSLIP_SHARE':
      return {
        subject: `Salary Payslip ${data?.payslipNumber || ''} (${data?.month || ''}) — ${brand}`.trim(),
        body: [
          `Dear ${name},`,
          '',
          `Your salary payslip summary for ${data?.month || 'the current pay period'} (${data?.payslipNumber || ''}) is ready:`,
          data?.netSalary !== undefined ? `• Net Payable Salary: ${formatINR(Number(data.netSalary))}` : '',
          data?.status ? `• Payout Status: ${data.status}` : '',
          '',
          'Please contact HR if you have any questions regarding attendance or deductions.',
          '',
          'Regards,',
          `HR & Payroll Desk, ${brand}`
        ]
          .filter(Boolean)
          .join('\n')
      };

    case 'SERVICE_TICKET':
      return {
        subject: `Service Ticket Update ${data?.ticketId || ''} — ${brand}`.trim(),
        body: [
          `Dear ${name},`,
          '',
          `We are providing an update regarding your solar O&M service request${data?.ticketId ? ` (${data.ticketId})` : ''}:`,
          data?.issue ? `• Reported Issue: ${data.issue}` : '',
          data?.technician ? `• Assigned Engineer: ${data.technician}` : '',
          data?.status ? `• Current Status: ${data.status}` : '',
          '',
          'Our engineering support team is committed to keeping your solar plant performing at peak output.',
          '',
          'Warm regards,',
          `Customer Support, ${brand}`
        ]
          .filter(Boolean)
          .join('\n')
      };

    case 'CUSTOMER_MESSAGE':
    case 'GENERAL':
    default:
      return {
        subject: `Communication from ${brand}`,
        body: [
          `Dear ${name},`,
          '',
          `Greetings from ${brand}.`,
          '',
          'Please let us know how we can assist you with your solar project.',
          '',
          'Warm regards,',
          `${brand}`
        ].join('\n')
      };
  }
}

export const EmailDispatchModal: React.FC = () => {
  const { isEmailOpen, closeEmailModal, emailData, settings, showToast, openSettingsTab } = useApp();
  const { isAdmin } = useAuth();

  const [toEmail, setToEmail] = useState('');
  const [ccEmail, setCcEmail] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [gatewayLoading, setGatewayLoading] = useState(false);
  const [gatewayStatus, setGatewayStatus] = useState<{
    configured: boolean;
    enabled: boolean;
    senderName: string;
    gmailAddress: string;
  } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!isEmailOpen || !emailData) return;
    setToEmail(emailData.recipientEmail || '');
    setCcEmail('');
    setErrorMsg(null);
    const defaults = buildDefaultEmailTemplate(
      emailData.type || 'GENERAL',
      emailData.recipientName,
      emailData.data,
      settings.companyName
    );
    setSubject(emailData.defaultSubject || defaults.subject);
    setBody(emailData.defaultBody || defaults.body);

    let mounted = true;
    setGatewayLoading(true);
    apiClient
      .getEmailStatus()
      .then(st => {
        if (mounted) setGatewayStatus(st);
      })
      .catch(() => {
        if (mounted) setGatewayStatus(null);
      })
      .finally(() => {
        if (mounted) setGatewayLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [isEmailOpen, emailData, settings.companyName]);

  if (!isEmailOpen || !emailData) return null;

  const isGatewayReady = Boolean(gatewayStatus?.configured && gatewayStatus?.enabled);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (!toEmail.trim()) {
      setErrorMsg('Recipient email address is required.');
      return;
    }
    if (!subject.trim()) {
      setErrorMsg('Email subject is required.');
      return;
    }
    if (!body.trim()) {
      setErrorMsg('Email message body cannot be empty.');
      return;
    }

    setSending(true);
    try {
      const res = await apiClient.sendEmail({
        to: toEmail.trim(),
        ...(ccEmail.trim() ? { cc: ccEmail.trim() } : {}),
        subject: subject.trim(),
        text: body.trim()
      });
      showToast(res.message || `Email sent to ${toEmail.trim()}`, 'success');
      closeEmailModal();
    } catch (err: any) {
      const msg = err?.message || 'Failed to send email via Gmail SMTP.';
      setErrorMsg(msg);
      showToast(msg, 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs animate-in fade-in">
      <div className="w-full max-w-xl bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 bg-slate-900 text-white shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-amber-500/20 text-amber-400 rounded-xl">
              <Mail className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-base leading-tight">Send Application Email</h3>
              <p className="text-xs text-slate-300">
                Dispatched securely via configured Gmail SMTP gateway
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={closeEmailModal}
            className="p-1 hover:bg-white/10 rounded-lg transition-colors text-slate-300 hover:text-white cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Gateway Status Banner */}
        <div
          className={`px-5 py-2.5 border-b flex items-center justify-between gap-2 text-xs shrink-0 ${
            gatewayLoading
              ? 'bg-slate-50 border-slate-200 text-slate-600'
              : isGatewayReady
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-amber-50 border-amber-200 text-amber-900'
          }`}
        >
          <div className="flex items-center gap-2 min-w-0">
            {gatewayLoading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
            ) : isGatewayReady ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            ) : (
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
            )}
            <span className="truncate font-medium">
              {gatewayLoading
                ? 'Checking Gmail SMTP gateway...'
                : isGatewayReady
                ? `From: ${gatewayStatus?.senderName} <${gatewayStatus?.gmailAddress}>`
                : gatewayStatus?.configured
                ? 'Gmail SMTP gateway is currently paused in System Settings.'
                : 'Gmail SMTP is not configured yet. Ask an Admin to configure it.'}
            </span>
          </div>

          {!gatewayLoading && !isGatewayReady && isAdmin && (
            <button
              type="button"
              onClick={() => {
                closeEmailModal();
                openSettingsTab('email');
              }}
              className="inline-flex items-center gap-1 px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-[11px] font-bold shrink-0 cursor-pointer"
            >
              <Settings className="w-3 h-3" />
              <span>Configure Gmail</span>
            </button>
          )}
        </div>

        {/* Email Compose Form */}
        <form onSubmit={handleSend} className="p-5 space-y-3.5 overflow-y-auto flex-1">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-bold text-slate-500 uppercase mb-1">
                Recipient Name
              </label>
              <input
                type="text"
                readOnly
                value={emailData.recipientName || ''}
                className="w-full text-xs border border-slate-200 rounded-xl p-2.5 bg-slate-50 text-slate-700 font-semibold"
              />
            </div>

            <div>
              <label className="block text-[11px] font-bold text-slate-500 uppercase mb-1">
                To Email Address *
              </label>
              <input
                type="email"
                required
                value={toEmail}
                onChange={e => setToEmail(e.target.value)}
                placeholder="recipient@example.com"
                className="w-full text-xs border border-slate-200 rounded-xl p-2.5 focus:ring-2 focus:ring-amber-500 focus:outline-hidden"
              />
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-bold text-slate-500 uppercase mb-1">
              CC (Optional, comma-separated)
            </label>
            <input
              type="text"
              value={ccEmail}
              onChange={e => setCcEmail(e.target.value)}
              placeholder="accounts@company.com"
              className="w-full text-xs border border-slate-200 rounded-xl p-2.5 focus:ring-2 focus:ring-amber-500 focus:outline-hidden"
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold text-slate-500 uppercase mb-1">
              Subject *
            </label>
            <input
              type="text"
              required
              value={subject}
              onChange={e => setSubject(e.target.value)}
              className="w-full text-xs border border-slate-200 rounded-xl p-2.5 font-semibold text-slate-900 focus:ring-2 focus:ring-amber-500 focus:outline-hidden"
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold text-slate-500 uppercase mb-1">
              Message *
            </label>
            <textarea
              rows={8}
              required
              value={body}
              onChange={e => setBody(e.target.value)}
              className="w-full text-xs border border-slate-200 rounded-xl p-3 font-sans leading-relaxed text-slate-800 focus:ring-2 focus:ring-amber-500 focus:outline-hidden"
            />
          </div>

          {errorMsg && (
            <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 flex items-start gap-2 text-xs text-rose-800">
              <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
              <span className="font-semibold">{errorMsg}</span>
            </div>
          )}

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100">
            <button
              type="button"
              onClick={closeEmailModal}
              className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-900 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={sending || !isGatewayReady}
              className="inline-flex items-center gap-1.5 px-5 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-xl shadow-sm transition-colors disabled:opacity-50 cursor-pointer"
            >
              {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              <span>{sending ? 'Sending...' : 'Send Email'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
