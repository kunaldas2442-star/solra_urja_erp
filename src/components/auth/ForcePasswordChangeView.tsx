import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { GlobalFooter } from '../layout/GlobalFooter';
import {
  ShieldAlert,
  Lock,
  Eye,
  EyeOff,
  CheckCircle2,
  AlertCircle,
  LogOut,
  ArrowRight
} from 'lucide-react';

export const ForcePasswordChangeView: React.FC = () => {
  const { currentUser, completePasswordChange, logout } = useAuth();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showOld, setShowOld] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);

    const trimmedOld = oldPassword.trim();
    const trimmedNew = newPassword.trim();
    const trimmedConfirm = confirmPassword.trim();

    if (!trimmedOld || !trimmedNew || !trimmedConfirm) {
      setErrorMsg('Please complete all password fields.');
      return;
    }
    if (trimmedNew.length < 8) {
      setErrorMsg('New password must be at least 8 characters long.');
      return;
    }
    if (trimmedNew === trimmedOld) {
      setErrorMsg('Your new password must be different from the seeded default password.');
      return;
    }
    if (trimmedNew !== trimmedConfirm) {
      setErrorMsg('New password and confirmation do not match.');
      return;
    }

    setSubmitting(true);
    try {
      await completePasswordChange(trimmedOld, trimmedNew);
      setSuccessMsg('Password updated securely in MySQL. Loading your workspace...');
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to update password. Please verify your current password.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-between text-slate-900">
      <div className="flex-1 flex flex-col justify-center items-center px-4 py-8 w-full">
        <div className="w-full max-w-md bg-white border border-slate-200 rounded-2xl shadow-lg overflow-hidden">
        <div className="bg-[#0F2954] px-6 py-5 flex items-center justify-between border-b border-slate-200">
          <div className="flex items-center gap-3">
            <img
              src="/assets/aistudio/solar_urja_logo_07b84efe.jpeg"
              alt="Solar Urja ERP"
              className="h-9 w-auto rounded bg-white p-0.5 object-contain"
            />
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-orange-300">
                Security Activation Required
              </p>
              <h1 className="text-base font-extrabold text-white">
                Solar Urja ERP
              </h1>
            </div>
          </div>
          <button
            type="button"
            onClick={() => logout()}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-200 hover:text-white px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 transition-colors cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign Out</span>
          </button>
        </div>

        <div className="p-6 space-y-5">
          <div className="rounded-xl bg-amber-50 border border-amber-200 p-3.5 flex items-start gap-3">
            <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="text-xs text-amber-900 space-y-1">
              <p className="font-bold">Default Seeded Account Password Change Required</p>
              <p className="text-amber-800 leading-relaxed">
                Signed in as <span className="font-semibold">{currentUser?.name}</span> ({currentUser?.role} — <span className="font-mono">{currentUser?.email}</span>).
                Before accessing production ERP modules, please replace the default seeded password with a private password (minimum 8 characters).
              </p>
            </div>
          </div>

          {errorMsg && (
            <div className="rounded-xl bg-rose-50 border border-rose-200 p-3 flex items-start gap-2 text-xs text-rose-800 font-medium">
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          {successMsg && (
            <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-3 flex items-start gap-2 text-xs text-emerald-800 font-medium">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
              <span>{successMsg}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">
                Current / Default Password
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type={showOld ? 'text' : 'password'}
                  value={oldPassword}
                  onChange={e => setOldPassword(e.target.value)}
                  className="w-full pl-9 pr-10 py-2.5 text-sm border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-[#F97316]/30 focus:border-[#F97316]"
                  placeholder="Enter current password"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowOld(p => !p)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer"
                  aria-label="Toggle current password visibility"
                >
                  {showOld ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">
                New Production Password (min 8 characters)
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type={showNew ? 'text' : 'password'}
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  className="w-full pl-9 pr-10 py-2.5 text-sm border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-[#F97316]/30 focus:border-[#F97316]"
                  placeholder="Enter new strong password"
                  minLength={8}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowNew(p => !p)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer"
                  aria-label="Toggle new password visibility"
                >
                  {showNew ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">
                Confirm New Password
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type={showNew ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  className="w-full pl-9 pr-3 py-2.5 text-sm border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-[#F97316]/30 focus:border-[#F97316]"
                  placeholder="Re-enter new password"
                  minLength={8}
                  required
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2.5 px-4 bg-[#F97316] hover:bg-[#EA580C] text-white font-bold text-sm rounded-xl shadow-sm transition-colors flex items-center justify-center gap-2 disabled:opacity-50 cursor-pointer"
            >
              <span>{submitting ? 'Updating Password in MySQL...' : 'Update Password & Enter ERP'}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </form>
        </div>
      </div>
      </div>
      <GlobalFooter />
    </div>
  );
};
