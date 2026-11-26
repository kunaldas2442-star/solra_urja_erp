import React, { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useApp } from '../../context/AppContext';
import { apiClient, EmailSettingsInfo } from '../../services/apiClient';
import {
  Mail,
  Lock,
  Eye,
  EyeOff,
  Server,
  ShieldCheck,
  Send,
  Save,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Trash2,
  KeyRound,
  Info
} from 'lucide-react';

export const GmailSettingsPanel: React.FC = () => {
  const { currentUser, isAdmin } = useAuth();
  const { showToast } = useApp();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const [savedMeta, setSavedMeta] = useState<EmailSettingsInfo | null>(null);

  // Form fields
  const [gmailAddress, setGmailAddress] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const [smtpHost, setSmtpHost] = useState('smtp.gmail.com');
  const [smtpPort, setSmtpPort] = useState<number>(587);
  const [smtpSecurity, setSmtpSecurity] = useState<'TLS' | 'SSL'>('TLS');
  const [senderName, setSenderName] = useState('Solar Urja ERP');
  const [enabled, setEnabled] = useState(true);

  // Test email state
  const [testRecipient, setTestRecipient] = useState('');

  // Clear inline feedback banners
  const [statusBanner, setStatusBanner] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);
  const [testBanner, setTestBanner] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const applyServerSettings = (info: EmailSettingsInfo) => {
    setSavedMeta(info);
    setGmailAddress(info.gmailAddress || '');
    setSmtpHost(info.smtpHost || 'smtp.gmail.com');
    setSmtpPort(info.smtpPort || (info.smtpSecurity === 'SSL' ? 465 : 587));
    setSmtpSecurity(info.smtpSecurity === 'SSL' ? 'SSL' : 'TLS');
    setSenderName(info.senderName || 'Solar Urja ERP');
    setEnabled(info.enabled !== false);
    setAppPassword('');
    setTestRecipient(prev => prev || info.gmailAddress || currentUser?.email || '');
  };

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    let mounted = true;
    const loadConfig = async () => {
      setLoading(true);
      try {
        const info = await apiClient.getEmailSettings();
        if (mounted) {
          applyServerSettings(info);
        }
      } catch (err: any) {
        if (mounted) {
          setStatusBanner({
            type: 'error',
            text: err?.message || 'Unable to load Gmail email configuration from server.'
          });
        }
      } finally {
        if (mounted) setLoading(false);
      }
    };
    loadConfig();
    return () => {
      mounted = false;
    };
  }, [isAdmin]);

  if (!isAdmin) {
    return (
      <div className="bg-white rounded-2xl p-8 border border-rose-200 shadow-2xs text-center space-y-3">
        <div className="w-12 h-12 rounded-2xl bg-rose-50 text-rose-600 flex items-center justify-center mx-auto">
          <Lock className="w-6 h-6" />
        </div>
        <h3 className="text-base font-bold text-slate-900">Administrator Access Required</h3>
        <p className="text-xs text-slate-500 max-w-md mx-auto">
          Only authorized Administrators can view, configure, or test Gmail SMTP email credentials.
        </p>
      </div>
    );
  }

  const handleSecurityChange = (nextSec: 'TLS' | 'SSL') => {
    setSmtpSecurity(nextSec);
    if (nextSec === 'TLS' && smtpPort === 465) {
      setSmtpPort(587);
    } else if (nextSec === 'SSL' && smtpPort === 587) {
      setSmtpPort(465);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatusBanner(null);

    if (!gmailAddress.trim()) {
      setStatusBanner({ type: 'error', text: 'Please enter a valid Gmail email address.' });
      return;
    }
    if (!appPassword.trim() && !savedMeta?.hasAppPassword) {
      setStatusBanner({
        type: 'error',
        text: 'Please enter a 16-character Google App Password before saving.'
      });
      return;
    }

    setSaving(true);
    try {
      const res = await apiClient.saveEmailSettings({
        gmailAddress: gmailAddress.trim(),
        ...(appPassword.trim() ? { appPassword: appPassword.trim() } : {}),
        smtpHost: smtpHost.trim() || 'smtp.gmail.com',
        smtpPort: Number(smtpPort) || (smtpSecurity === 'SSL' ? 465 : 587),
        smtpSecurity,
        senderName: senderName.trim() || 'Solar Urja ERP',
        enabled
      });
      applyServerSettings(res.data);
      setStatusBanner({ type: 'success', text: res.message });
      showToast(res.message, 'success');
    } catch (err: any) {
      const msg = err?.message || 'Failed to save Gmail email configuration.';
      setStatusBanner({ type: 'error', text: msg });
      showToast(msg, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleSendTestEmail = async () => {
    setTestBanner(null);
    const recipient = testRecipient.trim() || gmailAddress.trim();
    if (!recipient) {
      setTestBanner({ type: 'error', text: 'Enter a test recipient email address.' });
      return;
    }
    if (!gmailAddress.trim()) {
      setTestBanner({ type: 'error', text: 'Enter your Gmail email address first.' });
      return;
    }
    if (!appPassword.trim() && !savedMeta?.hasAppPassword) {
      setTestBanner({
        type: 'error',
        text: 'Enter a Gmail App Password (or save configuration first) to run the test.'
      });
      return;
    }

    setTesting(true);
    try {
      const res = await apiClient.testEmailSettings({
        testRecipient: recipient,
        gmailAddress: gmailAddress.trim(),
        ...(appPassword.trim() ? { appPassword: appPassword.trim() } : {}),
        smtpHost: smtpHost.trim() || 'smtp.gmail.com',
        smtpPort: Number(smtpPort) || (smtpSecurity === 'SSL' ? 465 : 587),
        smtpSecurity,
        senderName: senderName.trim() || 'Solar Urja ERP'
      });
      if (res.data?.settings) {
        setSavedMeta(res.data.settings);
      }
      setTestBanner({ type: 'success', text: res.message });
      showToast(res.message, 'success');
    } catch (err: any) {
      const msg = err?.message || 'SMTP test failed. Verify your Gmail App Password and settings.';
      setTestBanner({ type: 'error', text: msg });
      showToast(msg, 'error');
      // Refresh metadata if backend stored FAILED test status
      apiClient
        .getEmailSettings()
        .then(info => setSavedMeta(info))
        .catch(() => {});
    } finally {
      setTesting(false);
    }
  };

  const handleDeleteCredentials = async () => {
    setDeleting(true);
    setStatusBanner(null);
    setTestBanner(null);
    try {
      const res = await apiClient.deleteEmailSettings();
      applyServerSettings(res.data);
      setConfirmDelete(false);
      setStatusBanner({ type: 'success', text: res.message });
      showToast(res.message, 'info');
    } catch (err: any) {
      const msg = err?.message || 'Failed to remove Gmail configuration.';
      setStatusBanner({ type: 'error', text: msg });
      showToast(msg, 'error');
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-white rounded-2xl p-10 border border-slate-200/80 shadow-2xs flex items-center justify-center gap-3 text-slate-500">
        <Loader2 className="w-5 h-5 animate-spin text-amber-500" />
        <span className="text-xs font-semibold">Loading encrypted Gmail SMTP settings...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Status & Security Overview */}
      <div className="bg-white rounded-2xl p-6 border border-slate-200/80 shadow-2xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-rose-50 border border-rose-200 text-rose-600 flex items-center justify-center shrink-0">
              <Mail className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-slate-900">Gmail Email Configuration (SMTP)</h3>
                <span
                  className={`text-[10px] font-bold px-2 py-0.5 rounded-md border ${
                    savedMeta?.configured && enabled
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                      : savedMeta?.configured
                      ? 'bg-amber-50 text-amber-700 border-amber-200'
                      : 'bg-slate-100 text-slate-600 border-slate-200'
                  }`}
                >
                  {savedMeta?.configured ? (enabled ? 'Configured & Active' : 'Paused') : 'Not Configured'}
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                Configure your organization Gmail SMTP gateway for sending quotations, invoices, payslips, and CRM updates
              </p>
            </div>
          </div>

          {savedMeta?.updatedAt && (
            <div className="text-right text-[11px] text-slate-500 shrink-0">
              <p className="font-semibold text-slate-700">
                Last updated: {new Date(savedMeta.updatedAt).toLocaleString('en-IN')}
              </p>
              {savedMeta.updatedBy && <p>By {savedMeta.updatedBy}</p>}
            </div>
          )}
        </div>

        {/* Google App Password Security Notice */}
        <div className="mt-4 p-3.5 rounded-xl bg-amber-50/80 border border-amber-200/80 flex items-start gap-2.5 text-xs text-amber-900">
          <KeyRound className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-bold">Use a Google App Password (Not Your Regular Gmail Password)</p>
            <p className="text-[11px] text-amber-800 leading-relaxed">
              Google blocks standard account passwords on SMTP. Enable 2-Step Verification on your Gmail account, create a 16-character{' '}
              <strong>App Password</strong> under Google Account → Security → App Passwords, and enter it below. Passwords are encrypted at rest on the server using AES-256-GCM and are never returned to the browser.
            </p>
          </div>
        </div>

        {statusBanner && (
          <div
            className={`mt-4 p-3.5 rounded-xl border flex items-start gap-2.5 text-xs ${
              statusBanner.type === 'success'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : 'bg-rose-50 border-rose-200 text-rose-900'
            }`}
          >
            {statusBanner.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
            )}
            <span className="font-semibold">{statusBanner.text}</span>
          </div>
        )}

        {/* Configuration Form */}
        <form onSubmit={handleSave} className="mt-5 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Gmail Email Address *
              </label>
              <input
                type="email"
                required
                autoComplete="off"
                value={gmailAddress}
                onChange={e => setGmailAddress(e.target.value)}
                placeholder="e.g. billing@yourcompany.com or company@gmail.com"
                className="w-full text-xs border border-slate-200 rounded-xl p-2.5 focus:ring-2 focus:ring-amber-500 focus:outline-hidden"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Sender Display Name *
              </label>
              <input
                type="text"
                required
                value={senderName}
                onChange={e => setSenderName(e.target.value)}
                placeholder="e.g. Solar Urja ERP"
                className="w-full text-xs border border-slate-200 rounded-xl p-2.5 focus:ring-2 focus:ring-amber-500 focus:outline-hidden"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs font-bold text-slate-700">
                  Gmail App Password {savedMeta?.hasAppPassword ? '(Optional to update)' : '*'}
                </label>
                {savedMeta?.hasAppPassword && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">
                    <ShieldCheck className="w-3 h-3" /> Encrypted credential stored
                  </span>
                )}
              </div>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={appPassword}
                  onChange={e => setAppPassword(e.target.value)}
                  placeholder={
                    savedMeta?.hasAppPassword
                      ? '•••••••••••• (Leave blank to keep stored password)'
                      : 'Enter 16-character Google App Password'
                  }
                  className="w-full text-xs border border-slate-200 rounded-xl p-2.5 pr-9 font-mono focus:ring-2 focus:ring-amber-500 focus:outline-hidden"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(prev => !prev)}
                  className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-600 cursor-pointer"
                  title={showPassword ? 'Hide App Password' : 'Show App Password'}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Gateway Status
              </label>
              <label className="flex items-center justify-between p-2.5 border border-slate-200 rounded-xl bg-slate-50/70 cursor-pointer">
                <span className="text-xs font-semibold text-slate-700">
                  Enable Outbound Application Emails
                </span>
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={e => setEnabled(e.target.checked)}
                  className="w-4 h-4 accent-amber-500 cursor-pointer"
                />
              </label>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2 border-t border-slate-100">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">SMTP Host *</label>
              <div className="relative">
                <Server className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-3" />
                <input
                  type="text"
                  required
                  value={smtpHost}
                  onChange={e => setSmtpHost(e.target.value)}
                  placeholder="smtp.gmail.com"
                  className="w-full text-xs border border-slate-200 rounded-xl p-2.5 pl-8 font-mono focus:ring-2 focus:ring-amber-500 focus:outline-hidden"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">SMTP Security *</label>
              <select
                value={smtpSecurity}
                onChange={e => handleSecurityChange(e.target.value as 'TLS' | 'SSL')}
                className="w-full text-xs border border-slate-200 rounded-xl p-2.5 bg-white font-semibold focus:ring-2 focus:ring-amber-500 focus:outline-hidden"
              >
                <option value="TLS">TLS / STARTTLS (Port 587 — Recommended)</option>
                <option value="SSL">SSL (Port 465)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">SMTP Port *</label>
              <input
                type="number"
                required
                min={1}
                max={65535}
                value={smtpPort}
                onChange={e => setSmtpPort(Number(e.target.value) || 587)}
                className="w-full text-xs border border-slate-200 rounded-xl p-2.5 font-mono focus:ring-2 focus:ring-amber-500 focus:outline-hidden"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <div>
              {savedMeta?.configured && !confirmDelete && (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-rose-600 hover:bg-rose-50 border border-rose-200 rounded-xl transition-colors cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Remove Saved Credentials</span>
                </button>
              )}

              {confirmDelete && (
                <div className="inline-flex items-center gap-2 bg-rose-50 border border-rose-200 px-3 py-1.5 rounded-xl">
                  <span className="text-xs font-semibold text-rose-800">Remove Gmail SMTP config?</span>
                  <button
                    type="button"
                    disabled={deleting}
                    onClick={handleDeleteCredentials}
                    className="px-2.5 py-1 text-[11px] font-bold bg-rose-600 hover:bg-rose-700 text-white rounded-lg cursor-pointer disabled:opacity-50"
                  >
                    {deleting ? 'Removing...' : 'Confirm'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    className="px-2 py-1 text-[11px] font-semibold text-slate-600 hover:text-slate-900 cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>

            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold shadow-sm transition-colors disabled:opacity-50 cursor-pointer"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4 text-amber-400" />}
              <span>{saving ? 'Encrypting & Saving...' : 'Save Gmail Configuration'}</span>
            </button>
          </div>
        </form>
      </div>

      {/* Send Test Email Card */}
      <div className="bg-white rounded-2xl p-6 border border-slate-200/80 shadow-2xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-100">
          <div className="flex items-center gap-2.5">
            <Send className="w-4 h-4 text-blue-600" />
            <div>
              <h3 className="text-sm font-bold text-slate-900">Send Test Email</h3>
              <p className="text-xs text-slate-500">
                Verify Gmail SMTP handshake, App Password authentication, and email delivery
              </p>
            </div>
          </div>

          {savedMeta?.lastTestedAt && (
            <span
              className={`inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-lg border ${
                savedMeta.lastTestStatus === 'SUCCESS'
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                  : 'bg-rose-50 text-rose-700 border-rose-200'
              }`}
            >
              {savedMeta.lastTestStatus === 'SUCCESS' ? (
                <CheckCircle2 className="w-3.5 h-3.5" />
              ) : (
                <AlertTriangle className="w-3.5 h-3.5" />
              )}
              <span>
                Last test: {savedMeta.lastTestStatus} ({new Date(savedMeta.lastTestedAt).toLocaleString('en-IN')})
              </span>
            </span>
          )}
        </div>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-end gap-3">
          <div className="flex-1">
            <label className="block text-xs font-bold text-slate-700 mb-1">
              Test Recipient Email Address
            </label>
            <input
              type="email"
              value={testRecipient}
              onChange={e => setTestRecipient(e.target.value)}
              placeholder="recipient@example.com"
              className="w-full text-xs border border-slate-200 rounded-xl p-2.5 focus:ring-2 focus:ring-blue-500 focus:outline-hidden"
            />
          </div>

          <button
            type="button"
            disabled={testing}
            onClick={handleSendTestEmail}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold shadow-xs transition-colors disabled:opacity-50 cursor-pointer shrink-0"
          >
            {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            <span>{testing ? 'Sending Test Email...' : 'Send Test Email'}</span>
          </button>
        </div>

        {testBanner && (
          <div
            className={`p-3.5 rounded-xl border flex items-start gap-2.5 text-xs ${
              testBanner.type === 'success'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : 'bg-rose-50 border-rose-200 text-rose-900'
            }`}
          >
            {testBanner.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
            )}
            <span className="font-semibold leading-relaxed">{testBanner.text}</span>
          </div>
        )}

        <div className="flex items-start gap-2 text-[11px] text-slate-500 bg-slate-50 p-3 rounded-xl border border-slate-100">
          <Info className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
          <span>
            Once configured and verified, staff members can send official quotations, tax invoices, vendor inquiries, payslips, and CRM updates directly through this Gmail gateway from inside the ERP.
          </span>
        </div>
      </div>
    </div>
  );
};
