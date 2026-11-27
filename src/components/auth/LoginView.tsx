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

      {/* Main Content Container (Full-Width Responsive Layout) */}
      <main className="flex-1 w-full px-4 sm:px-6 lg:px-8 xl:px-10 py-5 sm:py-6 flex flex-col justify-center">
        {/* Header Brand Strip */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 mb-5 border-b border-slate-200/90">
          <div className="flex items-center gap-3.5">
            <div className="bg-white border border-slate-200 rounded-2xl px-3 py-1.5 shadow-2xs shrink-0">
              <img
                src="/assets/aistudio/solar_urja_logo_07b84efe.jpeg"
                alt="Solar Urja ERP"
                className="h-10 sm:h-11 w-auto object-contain"
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

        {/* Full-Width Two-Column Responsive Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 lg:gap-6 items-stretch">
          {/* Left Column: Sign-In Form Card */}
          <section className="lg:col-span-4 xl:col-span-3 bg-white rounded-2xl p-5 sm:p-6 border border-slate-200 shadow-sm flex flex-col justify-between">
            <div>
              <div className="mb-4">
                <h2 className="text-lg font-extrabold text-[#0F2954] tracking-tight">
                  Sign in to Workspace
                </h2>
                <p className="text-xs text-slate-500 mt-1">
                  Select a user type below or pick a role card from the directory to sign in.
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

            </div>

            <div className="mt-5 pt-4 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-500">
              <span className="flex items-center gap-1.5 font-medium">
                <ShieldCheck className="w-3.5 h-3.5 text-[#16A34A]" />
                <span>Role-Based Access Control</span>
              </span>
              <span className="font-semibold text-[#0F2954]">MySQL + Session Auth</span>
            </div>
          </section>

          {/* Right Column: Seeded Role Credentials Directory (All 11 Roles Visible, No Scrollbars) */}
          <section className="lg:col-span-8 xl:col-span-9 bg-white rounded-2xl p-4 sm:p-5 border border-slate-200 shadow-sm flex flex-col">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 mb-3.5 border-b border-slate-100">
              <div>
                <h3 className="text-sm font-extrabold text-[#0F2954]">
                  Seeded Role Credentials Directory
                </h3>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Click any role card to load credentials into the sign-in form, or copy email and password individually.
                </p>
              </div>
              <div className="text-[11px] font-semibold text-[#16A34A] whitespace-nowrap shrink-0 tabular-nums">
                11 Portal Roles · Simultaneous View
              </div>
            </div>

            {/* Compact Multi-Column Grid — Zero Internal Vertical or Horizontal Scrolling */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5">
              {DEMO_ACCOUNTS.map((acc) => {
                const isSelected = selectedUserType === acc.userType;
                const emailCopied = copiedKey === `email-${acc.userType}`;
                const passCopied = copiedKey === `pass-${acc.userType}`;

                return (
                  <div
                    key={acc.userType}
                    onClick={() => handleSelectUserType(acc.userType)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleSelectUserType(acc.userType);
                      }
                    }}
                    className={`rounded-xl border px-3 py-2.5 transition-colors cursor-pointer flex flex-col justify-between gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F97316] ${
                      isSelected
                        ? 'border-[#F97316] bg-orange-50/45'
                        : 'border-slate-200 bg-slate-50/40 hover:border-slate-300 hover:bg-white'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-xs font-extrabold text-[#0F2954] leading-tight">
                          {acc.userType}
                        </div>
                        <div className="text-[11px] text-slate-500 leading-snug mt-0.5">
                          {acc.scope}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSelectUserType(acc.userType);
                        }}
                        className={`px-2 py-0.5 rounded-md text-[11px] font-bold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                          isSelected
                            ? 'bg-[#0F2954] text-white'
                            : 'bg-slate-200/70 text-[#0F2954] hover:bg-[#F97316] hover:text-white'
                        }`}
                      >
                        {isSelected ? 'Selected' : 'Use'}
                      </button>
                    </div>

                    <div className="space-y-1 pt-1.5 border-t border-slate-200/70">
                      <div className="flex items-center justify-between gap-1.5">
                        <code className="text-[11px] font-mono text-slate-800 select-all break-all leading-tight">
                          {acc.email}
                        </code>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleCopyText(acc.email, `email-${acc.userType}`);
                          }}
                          title={`Copy ${acc.userType} email`}
                          aria-label={`Copy ${acc.userType} email`}
                          className="p-1 rounded-md text-slate-500 hover:text-[#0F2954] hover:bg-slate-200/60 transition-colors cursor-pointer shrink-0"
                        >
                          {emailCopied ? (
                            <Check className="w-3.5 h-3.5 text-[#16A34A]" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>

                      <div className="flex items-center justify-between gap-1.5">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-[10px] font-semibold text-slate-400 shrink-0">
                            Pass:
                          </span>
                          <code className="text-[11px] font-mono font-semibold text-slate-800 select-all whitespace-nowrap leading-tight">
                            {acc.password}
                          </code>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleCopyText(acc.password, `pass-${acc.userType}`);
                          }}
                          title={`Copy ${acc.userType} password`}
                          aria-label={`Copy ${acc.userType} password`}
                          className="p-1 rounded-md text-slate-500 hover:text-[#0F2954] hover:bg-slate-200/60 transition-colors cursor-pointer shrink-0"
                        >
                          {passCopied ? (
                            <Check className="w-3.5 h-3.5 text-[#16A34A]" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
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
