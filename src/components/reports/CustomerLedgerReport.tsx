import React, { useState, useMemo } from 'react';
import { Customer, SalesInvoice, PaymentRecord, SalesReturn } from '../../types/solar';
import { ReportFilterState, ReportCategoryMeta } from '../../types/reports';
import { exportToCSV } from '../../services/exportImport';
import { ReportFilterBar } from './ReportFilterBar';
import { Users, AlertCircle, CheckCircle2, ChevronRight, ChevronDown, ArrowUpRight, ArrowDownLeft } from 'lucide-react';
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Tooltip,
  Legend
} from 'recharts';

interface CustomerLedgerReportProps {
  customers: Customer[];
  invoices: SalesInvoice[];
  payments: PaymentRecord[];
  salesReturns?: SalesReturn[];
  filters: ReportFilterState;
  onFilterChange: (updated: Partial<ReportFilterState>) => void;
  onFilterReset: () => void;
  meta: ReportCategoryMeta;
  showToast: (msg: string, type?: 'success' | 'error' | 'info' | 'warning') => void;
}

interface CustomerLedgerEntry {
  customer: Customer;
  totalBilled: number;
  totalReturned: number;
  totalReceived: number;
  balance: number;
  invoiceCount: number;
  hasOverdue: boolean;
  transactions: {
    date: string;
    type: 'INVOICE' | 'PAYMENT' | 'CREDIT_NOTE' | 'BANK_REFUND';
    refNumber: string;
    description: string;
    debit: number;
    credit: number;
    runningBalance: number;
  }[];
}

const round2 = (n: number): number => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;

export const CustomerLedgerReport: React.FC<CustomerLedgerReportProps> = ({
  customers,
  invoices,
  payments,
  salesReturns = [],
  filters,
  onFilterChange,
  onFilterReset,
  meta,
  showToast
}) => {
  const [expandedCustomerId, setExpandedCustomerId] = useState<string | null>(null);

  // Build ledger per customer
  const ledgerData: CustomerLedgerEntry[] = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return (customers || []).filter(Boolean).map(cust => {
      const custNameLower = (cust.name || '').trim().toLowerCase();
      // Find invoices for this customer
      const custInvoices = (invoices || []).filter(
        inv =>
          inv &&
          (inv.customerId === cust.id ||
            (!inv.customerId && (inv.customerName || '').trim().toLowerCase() === custNameLower))
      );
      const custInvIds = new Set(custInvoices.map(i => i.id));
      // Find payments for this customer
      const custPayments = (payments || []).filter(
        p =>
          p &&
          (p.customerId === cust.id ||
            (p.invoiceId && custInvIds.has(p.invoiceId)) ||
            (cust.activeProjectId && p.projectId === cust.activeProjectId) ||
            (!p.customerId && (p.customerName || '').trim().toLowerCase() === custNameLower))
      );
      // Find active sales returns (Credit Notes) for this customer
      const custReturns = (salesReturns || []).filter(
        sr =>
          sr &&
          sr.status !== 'REVERSED' &&
          sr.status !== 'CANCELLED' &&
          sr.targetType === 'CUSTOMER_INVOICE' &&
          (sr.partyId === cust.id ||
            (sr.invoiceId && custInvIds.has(sr.invoiceId)) ||
            (!sr.partyId && (sr.partyName || '').trim().toLowerCase() === custNameLower))
      );

      const txns: CustomerLedgerEntry['transactions'] = [];

      let totalInvoices = 0;
      let totalReturned = 0;
      let grossReceipts = 0;
      let totalRefunded = 0;

      custInvoices.forEach(inv => {
        if (inv.status !== 'CANCELLED' && inv.status !== 'DRAFT') {
          const amt = round2(Number(inv.totalAmount || 0));
          totalInvoices = round2(totalInvoices + amt);
          txns.push({
            date: inv.invoiceDate,
            type: 'INVOICE',
            refNumber: inv.invoiceNumber,
            description: `${inv.invoiceType} - ${inv.projectTitle || 'Solar Installation'}`,
            debit: amt,
            credit: 0,
            runningBalance: 0
          });
        }
      });

      custPayments.forEach(pay => {
        if (pay.status === 'PAID') {
          const amt = round2(Number(pay.amount || 0));
          grossReceipts = round2(grossReceipts + amt);
          txns.push({
            date: pay.paidDate || pay.dueDate || today,
            type: 'PAYMENT',
            refNumber: pay.receiptNumber || `RCPT-${pay.id.slice(0, 6)}`,
            description: `Receipt: ${pay.milestone} (${pay.paymentMode || 'Bank Transfer'})`,
            debit: 0,
            credit: amt,
            runningBalance: 0
          });
        }
      });

      custReturns.forEach(sr => {
        const retAmt = round2(Number(sr.totalAmount || 0));
        totalReturned = round2(totalReturned + retAmt);
        txns.push({
          date: sr.returnDate,
          type: 'CREDIT_NOTE',
          refNumber: sr.returnNumber,
          description: `Sales Return (vs ${sr.invoiceNumber}) — ${sr.reason || 'Goods Returned'}`,
          debit: 0,
          credit: retAmt,
          runningBalance: 0
        });
        if (sr.settlementMode === 'BANK_REFUND' && Number(sr.refundAmount || 0) > 0) {
          const refAmt = round2(Number(sr.refundAmount || 0));
          totalRefunded = round2(totalRefunded + refAmt);
          txns.push({
            date: sr.returnDate,
            type: 'BANK_REFUND',
            refNumber: `${sr.returnNumber}-REF`,
            description: `Bank Refund Paid (${sr.bankAccountName || 'Bank/Cash'})`,
            debit: refAmt,
            credit: 0,
            runningBalance: 0
          });
        }
      });

      // Sort chronologically
      txns.sort((a, b) => a.date.localeCompare(b.date));

      // Compute running balance
      let currentRunning = 0;
      txns.forEach(t => {
        currentRunning = round2(currentRunning + t.debit - t.credit);
        t.runningBalance = currentRunning;
      });

      const totalBilled = round2(Math.max(0, totalInvoices - totalReturned));
      const totalReceived = round2(Math.max(0, grossReceipts - totalRefunded));
      const balance = round2(currentRunning);

      const hasOverdue =
        balance > 0.01 &&
        (custPayments.some(p => p.status === 'OVERDUE') ||
          custInvoices.some(
            inv =>
              inv.status !== 'CANCELLED' &&
              inv.status !== 'DRAFT' &&
              inv.status !== 'PAID' &&
              Number(inv.balanceAmount ?? inv.totalAmount) > 0.01 &&
              inv.dueDate &&
              inv.dueDate < today
          ));

      return {
        customer: cust,
        totalBilled,
        totalReturned,
        totalReceived,
        balance,
        invoiceCount: custInvoices.length,
        hasOverdue,
        transactions: txns
      };
    });
  }, [customers, invoices, payments, salesReturns]);

  // Filter the ledger
  const filteredLedger = useMemo(() => {
    return ledgerData.filter(item => {
      // Date filter on customer's last transaction or registration
      if (filters.fromDate || filters.toDate) {
        const hasMatchingTxn = item.transactions.some(t => {
          if (filters.fromDate && t.date < filters.fromDate) return false;
          if (filters.toDate && t.date > filters.toDate) return false;
          return true;
        });
        if (item.transactions.length > 0 && !hasMatchingTxn) return false;
      }

      // Name filter
      if (filters.name.trim()) {
        const query = filters.name.toLowerCase();
        const custName = item.customer?.name?.toLowerCase() || '';
        const custPhone = item.customer?.phone?.toLowerCase() || '';
        const custCity = item.customer?.city?.toLowerCase() || '';
        const matchesName = custName.includes(query);
        const matchesPhone = custPhone.includes(query);
        const matchesCity = custCity.includes(query);
        if (!matchesName && !matchesPhone && !matchesCity) return false;
      }

      // Status filter
      if (filters.status && filters.status !== 'ALL') {
        if (filters.status === 'OUTSTANDING' && item.balance <= 0) return false;
        if (filters.status === 'SETTLED' && item.balance > 0) return false;
        if (filters.status === 'OVERDUE' && !item.hasOverdue) return false;
      }

      return true;
    });
  }, [ledgerData, filters]);

  // Aggregate totals
  const totalReceivables = filteredLedger.reduce((sum, l) => sum + Math.max(0, l.balance), 0);
  const totalCollections = filteredLedger.reduce((sum, l) => sum + l.totalReceived, 0);
  const totalBilledVal = filteredLedger.reduce((sum, l) => sum + l.totalBilled, 0);
  const overdueCount = filteredLedger.filter(l => l.hasOverdue).length;

  const collectionShareData = useMemo(() => {
    return [
      { name: 'Collected Amount', value: totalCollections, color: '#10b981' },
      { name: 'Outstanding Amount', value: totalReceivables, color: '#f59e0b' }
    ].filter(d => d.value > 0);
  }, [totalCollections, totalReceivables]);

  const handleExportCSV = () => {
    const headers = [
      'Customer ID',
      'Customer Name',
      'Phone Number',
      'City / Region',
      'System Capacity (kW)',
      'Net Billed (Dr)',
      'Sales Returns (Cr Note)',
      'Net Collected (Cr)',
      'Net Outstanding Balance',
      'Account Status'
    ];
    const rows = filteredLedger.map(l => [
      l.customer?.id || '',
      l.customer?.name || '',
      l.customer?.phone || '',
      l.customer?.city || '',
      l.customer?.sanctionedLoadKw ? `${l.customer.sanctionedLoadKw} kW` : (l.customer?.customerType || 'Commercial'),
      l.totalBilled,
      l.totalReturned,
      l.totalReceived,
      l.balance,
      l.balance <= 0.01 ? 'Settled' : l.hasOverdue ? 'Overdue' : 'Outstanding'
    ]);
    exportToCSV(`SolarUrja_Customer_Ledger_${new Date().toISOString().slice(0, 10)}`, headers, rows);
    showToast('Customer ledger exported to CSV', 'success');
  };

  return (
    <div className="space-y-6">
      <ReportFilterBar
        filters={filters}
        onChange={onFilterChange}
        onReset={onFilterReset}
        onExportCSV={handleExportCSV}
        onPrint={() => window.print()}
        categoryMeta={meta}
        totalCount={ledgerData.length}
        filteredCount={filteredLedger.length}
      />

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-2xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500 uppercase">Total Receivables</span>
            <span className="p-2 bg-amber-50 rounded-xl text-amber-600">
              <ArrowDownLeft className="w-4 h-4" />
            </span>
          </div>
          <div className="text-2xl font-black text-amber-700 mt-2">
            ₹{totalReceivables.toLocaleString('en-IN')}
          </div>
          <p className="text-[11px] text-slate-500 mt-0.5">Net balance owed by clients</p>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-2xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500 uppercase">Realized Receipts</span>
            <span className="p-2 bg-emerald-50 rounded-xl text-emerald-600">
              <CheckCircle2 className="w-4 h-4" />
            </span>
          </div>
          <div className="text-2xl font-black text-emerald-700 mt-2">
            ₹{totalCollections.toLocaleString('en-IN')}
          </div>
          <p className="text-[11px] text-slate-500 mt-0.5">Cleared customer ledger payments</p>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-2xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500 uppercase">Total Invoiced / Debits</span>
            <span className="p-2 bg-blue-50 rounded-xl text-blue-600">
              <ArrowUpRight className="w-4 h-4" />
            </span>
          </div>
          <div className="text-2xl font-black text-slate-900 mt-2">
            ₹{totalBilledVal.toLocaleString('en-IN')}
          </div>
          <p className="text-[11px] text-slate-500 mt-0.5">Across {filteredLedger.length} active client accounts</p>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-2xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500 uppercase">Overdue Accounts</span>
            <span className="p-2 bg-rose-50 rounded-xl text-rose-600">
              <AlertCircle className="w-4 h-4" />
            </span>
          </div>
          <div className="text-2xl font-black text-rose-700 mt-2">
            {overdueCount} Accounts
          </div>
          <p className="text-[11px] text-slate-500 mt-0.5">Requiring payment followup</p>
        </div>
      </div>

      {/* Donut Chart: Collected vs Outstanding Amount */}
      {collectionShareData.length > 0 && (
        <div className="bg-white rounded-2xl p-5 border border-slate-200/80 shadow-2xs">
          <h3 className="text-sm font-bold text-slate-900 mb-1">Customer Ledger: Collected vs Outstanding Balance</h3>
          <p className="text-xs text-slate-500 mb-4">Proportion of realized revenue receipts vs pending customer receivables</p>
          <div className="h-64 sm:h-72 w-full flex items-center justify-center">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={collectionShareData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={95}
                  paddingAngle={3}
                  dataKey="value"
                >
                  {collectionShareData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(val: any) => [`₹${Number(val).toLocaleString('en-IN')}`, 'Amount']}
                  contentStyle={{ backgroundColor: '#ffffff', borderRadius: '12px', border: '1px solid #e2e8f0', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                />
                <Legend iconType="circle" wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Customer Ledger Table */}
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-2xs overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-slate-900">Party-Wise Customer Ledger Balances</h3>
            <p className="text-xs text-slate-500 mt-0.5">Click any customer row to view debit/credit transaction statement</p>
          </div>
          <span className="text-xs font-semibold px-2.5 py-1 bg-slate-100 text-slate-700 rounded-lg">
            {filteredLedger.length} Customers
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50/80 text-[11px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-200/60">
                <th className="py-3 px-4 w-8"></th>
                <th className="py-3 px-4">Customer Name</th>
                <th className="py-3 px-4">Contact / City</th>
                <th className="py-3 px-4 text-right">System Size</th>
                <th className="py-3 px-4 text-right">Total Billed (Dr)</th>
                <th className="py-3 px-4 text-right">Total Paid (Cr)</th>
                <th className="py-3 px-4 text-right">Net Balance (Owed)</th>
                <th className="py-3 px-4 text-center">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs text-slate-700">
              {filteredLedger.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-slate-400">
                    <Users className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                    <p className="font-semibold text-slate-600">No customer ledger records match your filter criteria</p>
                  </td>
                </tr>
              ) : (
                filteredLedger.map((item, idx) => {
                  const custId = item.customer?.id || `cust-${idx}`;
                  const isExpanded = expandedCustomerId === custId;

                  return (
                    <React.Fragment key={custId}>
                      <tr
                        onClick={() => setExpandedCustomerId(isExpanded ? null : custId)}
                        className={`hover:bg-slate-50/70 transition-colors cursor-pointer ${
                          isExpanded ? 'bg-amber-50/30' : ''
                        }`}
                      >
                        <td className="py-3.5 px-4 text-slate-400">
                          {isExpanded ? (
                            <ChevronDown className="w-4 h-4 text-amber-600" />
                          ) : (
                            <ChevronRight className="w-4 h-4" />
                          )}
                        </td>
                        <td className="py-3.5 px-4 font-bold text-slate-900">
                          {item.customer?.name || 'Unnamed Customer'}
                          <span className="block text-[10px] text-slate-400 font-normal">
                            ID: {custId}
                          </span>
                        </td>
                        <td className="py-3.5 px-4 text-slate-600">
                          {item.customer?.phone || 'N/A'}
                          <span className="block text-[10px] text-slate-400">{item.customer?.city || ''}</span>
                        </td>
                        <td className="py-3.5 px-4 text-right font-medium text-slate-800">
                          {item.customer?.sanctionedLoadKw ? `${item.customer.sanctionedLoadKw} kW` : (item.customer?.customerType || 'Commercial')}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono text-slate-700">
                          ₹{item.totalBilled.toLocaleString('en-IN')}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono text-emerald-700">
                          ₹{item.totalReceived.toLocaleString('en-IN')}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono font-bold whitespace-nowrap">
                          <span className={item.balance > 0 ? 'text-amber-700' : 'text-slate-700'}>
                            ₹{item.balance.toLocaleString('en-IN')}
                          </span>
                        </td>
                        <td className="py-3.5 px-4 text-center">
                          <span
                            className={`inline-block px-2.5 py-1 rounded-md text-[10px] font-bold border ${
                              item.balance <= 0
                                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                : item.hasOverdue
                                ? 'bg-rose-50 text-rose-700 border-rose-200'
                                : 'bg-amber-50 text-amber-700 border-amber-200'
                            }`}
                          >
                            {item.balance <= 0 ? 'Settled' : item.hasOverdue ? 'Overdue' : 'Outstanding'}
                          </span>
                        </td>
                      </tr>

                      {/* Expandable Transaction Statement */}
                      {isExpanded && (
                        <tr className="bg-slate-50/50">
                          <td colSpan={8} className="p-4 sm:p-6">
                            <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs">
                              <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider mb-3">
                                Transaction Statement: {item.customer.name}
                              </h4>

                              {item.transactions.length === 0 ? (
                                <p className="text-xs text-slate-400 py-3 text-center">
                                  No transaction entries recorded for this client.
                                </p>
                              ) : (
                                <table className="w-full text-left text-xs border-collapse">
                                  <thead>
                                    <tr className="border-b border-slate-200 text-slate-400 text-[10px] uppercase font-bold">
                                      <th className="py-2">Date</th>
                                      <th className="py-2">Reference #</th>
                                      <th className="py-2">Description</th>
                                      <th className="py-2 text-right">Debit (₹)</th>
                                      <th className="py-2 text-right">Credit (₹)</th>
                                      <th className="py-2 text-right">Running Balance (₹)</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-slate-100">
                                    {item.transactions.map((t, idx) => (
                                      <tr key={idx} className="hover:bg-slate-50">
                                        <td className="py-2 text-slate-600">{t.date}</td>
                                        <td className="py-2 font-mono font-bold text-slate-800">{t.refNumber}</td>
                                        <td className="py-2 text-slate-700">{t.description}</td>
                                        <td className="py-2 text-right font-mono text-slate-900">
                                          {t.debit > 0 ? `₹${t.debit.toLocaleString('en-IN')}` : '-'}
                                        </td>
                                        <td className="py-2 text-right font-mono text-emerald-700 font-medium">
                                          {t.credit > 0 ? `₹${t.credit.toLocaleString('en-IN')}` : '-'}
                                        </td>
                                        <td className="py-2 text-right font-mono font-bold text-slate-900">
                                          ₹{t.runningBalance.toLocaleString('en-IN')}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
