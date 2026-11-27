import React from 'react';
import { Globe, Phone, Mail } from 'lucide-react';

interface GlobalFooterProps {
  className?: string;
}

const WhatsAppIcon: React.FC<{ className?: string }> = ({ className = 'w-4 h-4' }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M3 21l1.65-3.8a9 9 0 1 1 3.4 2.9L3 21" />
    <path d="M9 10a.5.5 0 0 0 1 0V9a.5.5 0 0 0-1 0v1a5 5 0 0 0 5 5h1a.5.5 0 0 0 0-1h-1a.5.5 0 0 0 0 1" />
  </svg>
);

export const GlobalFooter: React.FC<GlobalFooterProps> = ({ className = '' }) => {
  const currentYear = new Date().getFullYear();

  return (
    <footer
      role="contentinfo"
      aria-label="Solar Urja ERP Global Footer"
      className={`w-full bg-white border-t border-slate-200/90 text-slate-700 print:hidden ${className}`.trim()}
    >
      <div className="h-0.5 w-full bg-gradient-to-r from-[#F97316] via-[#16A34A] to-[#0F2954]" />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 md:gap-6">
          {/* Solar Urja ERP Identity */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-600">
            <span className="font-bold text-[#0F2954]">Solar Urja ERP</span>
            <span aria-hidden="true" className="text-slate-300">
              ·
            </span>
            <span className="text-slate-500">© {currentYear}</span>
            <span aria-hidden="true" className="text-slate-300">
              ·
            </span>
            <span className="font-medium text-[#16A34A]">solar.klyiatechnology.com</span>
          </div>

          {/* Klyia Technology Contact Links (Footer Exclusive) */}
          <nav
            aria-label="Company Contact Links"
            className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs"
          >
            <a
              href="https://www.klyiatechnology.com"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Visit Klyia Technology website"
              className="inline-flex items-center gap-1.5 min-h-[36px] px-2 py-1 rounded-lg font-semibold text-[#0F2954] hover:text-[#EA580C] hover:bg-orange-50/70 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F97316] whitespace-nowrap shrink-0"
            >
              <Globe className="w-4 h-4 text-[#F97316] shrink-0" aria-hidden="true" />
              <span>www.klyiatechnology.com</span>
            </a>

            <a
              href="tel:+918296887643"
              aria-label="Call +91-8296887643"
              className="inline-flex items-center gap-1.5 min-h-[36px] px-2 py-1 rounded-lg font-semibold text-[#0F2954] hover:text-[#EA580C] hover:bg-orange-50/70 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F97316] whitespace-nowrap shrink-0 tabular-nums"
            >
              <Phone className="w-4 h-4 text-[#0F2954] shrink-0" aria-hidden="true" />
              <span>+91-8296887643</span>
            </a>

            <a
              href="https://wa.me/918296887643"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Chat on WhatsApp at +91-8296887643"
              className="inline-flex items-center gap-1.5 min-h-[36px] px-2 py-1 rounded-lg font-semibold text-[#15803D] hover:text-[#16A34A] hover:bg-emerald-50/80 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#16A34A] whitespace-nowrap shrink-0 tabular-nums"
            >
              <WhatsAppIcon className="w-4 h-4 text-[#16A34A] shrink-0" />
              <span>WhatsApp: +91-8296887643</span>
            </a>

            <a
              href="mailto:klyiatechnology@gmail.com"
              aria-label="Email klyiatechnology@gmail.com"
              className="inline-flex items-center gap-1.5 min-h-[36px] px-2 py-1 rounded-lg font-semibold text-[#0F2954] hover:text-[#EA580C] hover:bg-orange-50/70 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F97316] whitespace-nowrap shrink-0"
            >
              <Mail className="w-4 h-4 text-[#F97316] shrink-0" aria-hidden="true" />
              <span>klyiatechnology@gmail.com</span>
            </a>
          </nav>
        </div>
      </div>
    </footer>
  );
};
