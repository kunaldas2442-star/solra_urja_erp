import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { GlobalFooter } from '../layout/GlobalFooter';
import {
  Lock,
  Mail,
  Eye,
  EyeOff,
  ArrowRight,
  AlertCircle,
  CheckCircle2,
  X,
  ShieldCheck,
  Copy,
  Check,
  UserCheck,
  AlertTriangle,
  Globe
} from 'lucide-react';

export interface DemoAccountPreset {
  userType:
    | 'Administrator'
    | 'Sales Manager'
    | 'Project Manager'
    | 'Site Surveyor'
    | 'Site Inspector'
    | 'Civil Team'
    | 'Electrical Team'
    | 'Installation Team'
    | 'HR Manager'
    | 'Accounts Manager'
    | 'Customer';
  email: string;
  password: string;
  scope: string;
}

export const DEMO_ACCOUNTS: DemoAccountPreset[] = [
  {
    userType: 'Administrator',
    email: 'admin@solar.klyiatechnology.com',
    password: 'SolarAdmin@2026',
    scope: 'Full ERP, RBAC, Users & Password Control'
  },
  {
    userType: 'Sales Manager',
    email: 'salesmanager@solar.klyiatechnology.com',
    password: 'SolarSales@2026',
    scope: 'CRM Leads, Quotations & Sales Pipeline'
  },
  {
    userType: 'Project Manager',
    email: 'projectmanager@solar.klyiatechnology.com',
    password: 'SolarProject@2026',
    scope: 'EPC Execution, BOM & Stage Milestones'
  },
  {
    userType: 'Site Surveyor',
    email: 'surveyor@solar.klyiatechnology.com',
    password: 'SolarSurvey@2026',
    scope: 'Technical Site Surveys, Shadow & Roof Audits'
  },
  {
    userType: 'Site Inspector',
    email: 'inspector@solar.klyiatechnology.com',
    password: 'SolarInspect@2026',
    scope: 'QA/QC Stage Inspections & Safety Audits'
  },
  {
    userType: 'Civil Team',
    email: 'civil@solar.klyiatechnology.com',
    password: 'SolarCivil@2026',
    scope: 'Foundation Casting & Civil Site Works'
  },
  {
    userType: 'Electrical Team',
    email: 'electrical@solar.klyiatechnology.com',
    password: 'SolarElec@2026',
    scope: 'AC/DC Panels, Earthing & Grid Sync'
  },
  {
    userType: 'Installation Team',
    email: 'installation@solar.klyiatechnology.com',
    password: 'SolarInstall@2026',
    scope: 'Module Mounting & Inverter Installation'
  },
  {
    userType: 'HR Manager',
    email: 'hr@solar.klyiatechnology.com',
    password: 'SolarHr@2026',
    scope: 'Attendance, GPS Workforce, Leaves & Payroll'
  },
  {
    userType: 'Accounts Manager',
    email: 'accounts@solar.klyiatechnology.com',
    password: 'SolarAccounts@2026',
    scope: 'GST Invoicing, Ledger, Tally & Cash/Bank'
  },
  {
    userType: 'Customer',
    email: 'customer@solar.klyiatechnology.com',
    password: 'SolarCustomer@2026',
    scope: 'Client Solar Project Portal & Support'
  }
];

export const LoginView: React.FC = () => {
  const { login, resetPassword, loading } = useAuth();

  // Default to Administrator demo preset while allowing full manual entry or dropdown selection
  const [selectedUserType, setSelectedUserType] = useState<string>('Administrator');
  const [email, setEmail] = useState<string>(DEMO_ACCOUNTS[0].email);
  const [password, setPassword] = useState<string>(DEMO_ACCOUNTS[0].password);
  const [showPassword, setShowPassword] = useState(false);

  // Copy feedback key: e.g. "email-Administrator" or "pass-Administrator"
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Auth states
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Forgot password modal
  const [showForgotModal, setShowForgotModal] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  const [resetLoading, setResetLoading] = useState(false);
  const [resetStatus, setResetStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const handleSelectUserType = (nextType: string) => {
    setSelectedUserType(nextType);
    setErrorMessage(null);
    const preset = DEMO_ACCOUNTS.find(acc => acc.userType === nextType);
    if (preset) {
      setEmail(preset.email);
      setPassword(preset.password);
    }
  };

  const handleCopyText = async (value: string, key: string) => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const el = document.createElement('textarea');
        el.value = value;
        el.style.position = 'fixed';
        el.style.opacity = '0';
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
      }
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey(prev => (prev === key ? null : prev));
      }, 1800);
    } catch {
      // Clipboard blocked in restricted context — silently ignore
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);

    const cleanEmail = email.trim();
    const cleanPassword = password.trim();

    if (!cleanEmail || !cleanPassword) {
      setErrorMessage('Please enter both your email address and password.');
      return;
    }

    setIsSubmitting(true);
    try {
      await login(cleanEmail, cleanPassword);
    } catch (err: any) {
      setErrorMessage(err.message || 'Authentication failed. Please verify your credentials.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetEmail.trim()) {
      setResetStatus({ type: 'error', message: 'Please enter your account email address.' });
      return;
    }

    setResetLoading(true);
    setResetStatus(null);
    try {
      await resetPassword(resetEmail);
      setResetStatus({
        type: 'success',
        message: 'Password reset instructions sent. Please check your inbox or contact your administrator.'
      });
    } catch (err: any) {
      setResetStatus({
        type: 'error',
        message: err.message || 'Failed to verify account email. Contact your system administrator.'
      });
    } finally {
      setResetLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col justify-between selection:bg-[#F97316] selection:text-white">
      {/* Subtle Top Brand Accent Bar */}
      <div className="h-1.5 w-full bg-gradient-to-r from-[#F97316] via-[#16A34A] to-[#0F2954]" />

      {/* Main Content Container */}
      <main className="flex-1 w-full max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-10 flex flex-col justify-center">
        {/* Header Brand Strip */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 mb-6 border-b border-slate-200/90">
          <div className="flex items-center gap-4">
            <div className="bg-white border border-slate-200 rounded-2xl px-3.5 py-2 shadow-2xs shrink-0">
              <img
                src="/assets/aistudio/solar_urja_logo_07b84efe.jpeg"
                alt="Solar Urja ERP"
                className="h-11 sm:h-12 w-auto object-contain"
              />
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl font-extrabold text-[#0F2954] tracking-tight">
                Solar Urja ERP
              </h1>
              <p className="text-xs sm:text-sm text-slate-600 font-medium">
                Solar EPC Operations, CRM, Inventory, HRMS & Accounting Platform
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 self-start sm:self-auto bg-white border border-slate-200 rounded-xl px-3.5 py-2 text-xs font-semibold text-[#0F2954] shadow-2xs">
            <Globe className="w-4 h-4 text-[#16A34A]" />
            <span>solar.klyiatechnology.com</span>
          </div>
        </div>

        {/* Two-Column Responsive Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 items-start">
          {/* Left Column: Sign-In Form Card */}
          <section className="lg:col-span-5 bg-white rounded-2xl p-6 sm:p-7 border border-slate-200 shadow-sm">
            <div className="mb-5">
              <h2 className="text-lg font-extrabold text-[#0F2954] tracking-tight">
                Sign in to Workspace
              </h2>
              <p className="text-xs text-slate-500 mt-1">
                Select a user type below to auto-fill demo credentials, or sign in with your assigned account.
              </p>
            </div>

            {errorMessage && (
              <div className="mb-4 p-3.5 bg-rose-50 border border-rose-200 rounded-xl flex items-start gap-2.5 text-xs text-rose-800">
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <p className="flex-1 font-semibold">{errorMessage}</p>
                <button
                  type="button"
                  onClick={() => setErrorMessage(null)}
                  className="text-rose-400 hover:text-rose-600 cursor-pointer"
                  aria-label="Dismiss error"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            {successMessage && (
              <div className="mb-4 p-3.5 bg-emerald-50 border border-emerald-200 rounded-xl flex items-start gap-2.5 text-xs text-emerald-800">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                <p className="font-semibold">{successMessage}</p>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              {/* User-Type Dropdown (Exact 11 Options) */}
              <div>
                <label
                  htmlFor="user-type-select"
                  className="block text-xs font-bold text-[#0F2954] mb-1.5"
                >
                  User Type
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-[#16A34A]">
                    <UserCheck className="w-4 h-4" />
                  </div>
                  <select
                    id="user-type-select"
                    value={selectedUserType}
                    onChange={(e) => handleSelectUserType(e.target.value)}
                    className="w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-[#0F2954] focus:outline-hidden focus:ring-2 focus:ring-[#F97316]/25 focus:border-[#F97316] transition-all cursor-pointer"
                  >
                    <option value="Administrator">Administrator</option>
                    <option value="Sales Manager">Sales Manager</option>
                    <option value="Project Manager">Project Manager</option>
                    <option value="Site Surveyor">Site Surveyor</option>
                    <option value="Site Inspector">Site Inspector</option>
                    <option value="Civil Team">Civil Team</option>
                    <option value="Electrical Team">Electrical Team</option>
                    <option value="Installation Team">Installation Team</option>
                    <option value="HR Manager">HR Manager</option>
                    <option value="Accounts Manager">Accounts Manager</option>
                    <option value="Customer">Customer</option>
                  </select>
                </div>
              </div>

              {/* Email Address */}
              <div>
                <label
                  htmlFor="login-email"
                  className="block text-xs font-bold text-slate-700 mb-1.5"
                >
                  Email Address
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                    <Mail className="w-4 h-4" />
                  </div>
                  <input
                    id="login-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@solar.klyiatechnology.com"
                    className="w-full pl-10 pr-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 placeholder:text-slate-400 focus:outline-hidden focus:ring-2 focus:ring-[#F97316]/25 focus:border-[#F97316] transition-all font-medium"
                  />
                </div>
              </div>

              {/* Password */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label
                    htmlFor="login-password"
                    className="block text-xs font-bold text-slate-700"
                  >
                    Password
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setResetEmail(email);
                      setShowForgotModal(true);
                    }}
                    className="text-[11px] font-semibold text-[#EA580C] hover:text-[#0F2954] transition-colors cursor-pointer"
                  >
                    Forgot password?
                  </button>
                </div>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                    <Lock className="w-4 h-4" />
                  </div>
                  <input
                    id="login-password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    className="w-full pl-10 pr-16 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 placeholder:text-slate-400 focus:outline-hidden focus:ring-2 focus:ring-[#F97316]/25 focus:border-[#F97316] transition-all font-medium"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute inset-y-0 right-0 pr-3 flex items-center gap-1 text-[11px] font-semibold text-slate-500 hover:text-[#0F2954] transition-colors cursor-pointer"
                  >
                    {showPassword ? (
                      <>
                        <EyeOff className="w-3.5 h-3.5" />
                        <span>Hide</span>
                      </>
                    ) : (
                      <>
                        <Eye className="w-3.5 h-3.5" />
                        <span>Show</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Primary Sign-In Button */}
              <button
                type="submit"
                disabled={isSubmitting || loading}
                className="w-full mt-2 flex items-center justify-center gap-2 py-3 px-4 bg-[#F97316] hover:bg-[#EA580C] text-white text-xs font-bold rounded-xl shadow-sm transition-all disabled:opacity-50 cursor-pointer"
              >
                {isSubmitting ? (
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  <>
                    <span>Sign In to Solar Urja ERP</span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </form>

            <div className="mt-5 pt-4 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-500">
              <span className="flex items-center gap-1.5 font-medium">
                <ShieldCheck className="w-3.5 h-3.5 text-[#16A34A]" />
                <span>Role-Based Access Control</span>
              </span>
              <span className="font-semibold text-[#0F2954]">MySQL + Session Auth</span>
            </div>
          </section>

          {/* Right Column: Demo Credentials Directory */}
          <section className="lg:col-span-7 bg-white rounded-2xl p-5 sm:p-6 border border-slate-200 shadow-sm space-y-4">
            {/* Production Security Warning Banner */}
            <div className="p-3.5 bg-orange-50/80 border border-orange-200 rounded-xl flex items-start gap-3">
              <AlertTriangle className="w-4 h-4 text-[#EA580C] shrink-0 mt-0.5" />
              <div className="text-xs leading-relaxed">
                <p className="font-bold text-[#0F2954]">
                  Demo Credentials Notice — Change Passwords Before Production Deployment
                </p>
                <p className="text-slate-600 mt-0.5">
                  The accounts below are pre-seeded <span className="font-semibold text-slate-800">demo credentials</span> for evaluation across all 11 portal roles. Administrators can update passwords and manage accounts inside <span className="font-semibold text-[#0F2954]">Administration → User Management</span>.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-extrabold text-[#0F2954]">
                  Seeded Role Credentials Directory
                </h3>
                <p className="text-[11px] text-slate-500">
                  Click any role row to load into the sign-in form, or copy email/password individually.
                </p>
              </div>
              <span className="text-[11px] font-bold text-[#16A34A] bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-lg tabular-nums">
                11 Roles Active
              </span>
            </div>

            {/* Responsive Table / Cards */}
            <div className="border border-slate-200 rounded-xl overflow-hidden">
              <div className="overflow-x-auto max-h-[430px] overflow-y-auto">
                <table className="w-full text-left border-collapse">
                  <thead className="bg-slate-50 border-b border-slate-200 sticky top-0 z-10">
                    <tr className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                      <th className="py-2.5 px-3">User Type</th>
                      <th className="py-2.5 px-3">Demo Email</th>
                      <th className="py-2.5 px-3">Password</th>
                      <th className="py-2.5 px-3 text-right">Fill</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-xs">
                    {DEMO_ACCOUNTS.map((acc) => {
                      const isSelected = selectedUserType === acc.userType;
                      const emailCopied = copiedKey === `email-${acc.userType}`;
                      const passCopied = copiedKey === `pass-${acc.userType}`;

                      return (
                        <tr
                          key={acc.userType}
                          onClick={() => handleSelectUserType(acc.userType)}
                          className={`transition-colors cursor-pointer ${
                            isSelected ? 'bg-orange-50/70' : 'hover:bg-slate-50'
                          }`}
                        >
                          <td className="py-2.5 px-3 align-top">
                            <div className="font-bold text-[#0F2954] whitespace-nowrap">
                              {acc.userType}
                            </div>
                            <div className="text-[10px] text-slate-500 leading-tight mt-0.5">
                              {acc.scope}
                            </div>
                          </td>
                          <td className="py-2.5 px-3 align-middle">
                            <div className="flex items-center gap-1.5">
                              <code className="text-[11px] font-mono text-slate-700 bg-slate-100 px-1.5 py-0.5 rounded">
                                {acc.email}
                              </code>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleCopyText(acc.email, `email-${acc.userType}`);
                                }}
                                title="Copy demo email"
                                className="p-1 rounded-md text-slate-400 hover:text-[#0F2954] hover:bg-slate-100 transition-colors cursor-pointer"
                              >
                                {emailCopied ? (
                                  <Check className="w-3.5 h-3.5 text-[#16A34A]" />
                                ) : (
                                  <Copy className="w-3.5 h-3.5" />
                                )}
                              </button>
                            </div>
                          </td>
                          <td className="py-2.5 px-3 align-middle">
                            <div className="flex items-center gap-1.5">
                              <code className="text-[11px] font-mono text-slate-700 bg-slate-100 px-1.5 py-0.5 rounded whitespace-nowrap">
                                {acc.password}
                              </code>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleCopyText(acc.password, `pass-${acc.userType}`);
                                }}
                                title="Copy demo password"
                                className="p-1 rounded-md text-slate-400 hover:text-[#0F2954] hover:bg-slate-100 transition-colors cursor-pointer"
                              >
                                {passCopied ? (
                                  <Check className="w-3.5 h-3.5 text-[#16A34A]" />
                                ) : (
                                  <Copy className="w-3.5 h-3.5" />
                                )}
                              </button>
                            </div>
                          </td>
                          <td className="py-2.5 px-3 text-right align-middle">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleSelectUserType(acc.userType);
                              }}
                              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-colors cursor-pointer whitespace-nowrap ${
                                isSelected
                                  ? 'bg-[#0F2954] text-white'
                                  : 'bg-slate-100 text-[#0F2954] hover:bg-[#F97316] hover:text-white'
                              }`}
                            >
                              {isSelected ? 'Selected' : 'Use'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </div>
      </main>

      {/* Global Footer */}
      <GlobalFooter />

      {/* Forgot Password Modal */}
      {showForgotModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-2xl border border-slate-200 text-slate-900 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-orange-50 text-[#EA580C] flex items-center justify-center">
                  <Lock className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-[#0F2954]">Reset Password</h3>
                  <p className="text-[11px] text-slate-500">Solar Urja ERP Account Recovery</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowForgotModal(false);
                  setResetStatus(null);
                }}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {resetStatus && (
              <div
                className={`mt-4 p-3 rounded-xl text-xs flex items-start gap-2 ${
                  resetStatus.type === 'success'
                    ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                    : 'bg-rose-50 text-rose-800 border border-rose-200'
                }`}
              >
                {resetStatus.type === 'success' ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                ) : (
                  <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                )}
                <p>{resetStatus.message}</p>
              </div>
            )}

            <form onSubmit={handleResetPassword} className="space-y-3 mt-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Registered Email Address
                </label>
                <input
                  type="email"
                  required
                  value={resetEmail}
                  onChange={(e) => setResetEmail(e.target.value)}
                  placeholder="name@solar.klyiatechnology.com"
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 focus:outline-hidden focus:ring-2 focus:ring-[#F97316]/25 focus:border-[#F97316]"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowForgotModal(false)}
                  className="px-3 py-1.5 text-xs font-bold text-slate-500 hover:text-slate-800 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={resetLoading}
                  className="px-4 py-2 bg-[#F97316] hover:bg-[#EA580C] text-white text-xs font-bold rounded-xl shadow-xs transition-all disabled:opacity-50 cursor-pointer"
                >
                  {resetLoading ? 'Sending...' : 'Send Reset Link'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
