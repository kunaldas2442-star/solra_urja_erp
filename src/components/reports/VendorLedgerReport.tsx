import React, { useState, useMemo } from 'react';
import { Vendor, PurchaseOrder, VendorBill, VendorPayment, PurchaseReturn, VendorSalesInvoice } from '../../types/solar';
import { ReportFilterState, ReportCategoryMeta } from '../../types/reports';
import { exportToCSV } from '../../services/exportImport';
import { ReportFilterBar } from './ReportFilterBar';
import { Building2, ChevronDown, ChevronRight, CheckCircle2, Clock, DollarSign } from 'lucide-react';
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Tooltip,
  Legend
} from 'recharts';

interface VendorLedgerReportProps {
  vendors: Vendor[];
  purchaseOrders: PurchaseOrder[];
  vendorBills?: VendorBill[];
  vendorPayments?: VendorPayment[];
  purchaseReturns?: PurchaseReturn[];
  vendorSalesInvoices?: VendorSalesInvoice[];
  filters: ReportFilterState;
  onFilterChange: (updated: Partial<ReportFilterState>) => void;
  onFilterReset: () => void;
  meta: ReportCategoryMeta;
  showToast: (msg: string, type?: 'success' | 'error' | 'info' | 'warning') => void;
}

interface VendorLedgerEntry {
  vendor: Vendor;
  totalBilled: number;
  totalReturned: number;
  totalPaid: number;
  balanceDue: number;
  poCount: number;
  orders: PurchaseOrder[];
  bills: VendorBill[];
  returns: PurchaseReturn[];
}

const round2 = (n: number): number => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;

export const VendorLedgerReport: React.FC<VendorLedgerReportProps> = ({
  vendors,
  purchaseOrders,
  vendorBills = [],
  vendorPayments = [],
  purchaseReturns = [],
  filters,
  onFilterChange,
  onFilterReset,
  meta,
  showToast
}) => {
  const [expandedVendorId, setExpandedVendorId] = useState<string | null>(null);

  const ledgerData: VendorLedgerEntry[] = useMemo(() => {
    return vendors.map(v => {
      const vNameLower = v.name.trim().toLowerCase();
      const orders = purchaseOrders.filter(
        po => po.vendorId === v.id || po.vendorName.trim().toLowerCase() === vNameLower
      );
      const bills = (vendorBills || []).filter(
        b => b.status !== 'DRAFT' && (b.vendorId === v.id || b.vendorName.trim().toLowerCase() === vNameLower)
      );
      const returns = (purchaseReturns || []).filter(
        pr =>
          pr.status !== 'REVERSED' &&
          pr.status !== 'CANCELLED' &&
          (pr.vendorId === v.id || pr.vendorName.trim().toLowerCase() === vNameLower)
      );
      const vPayments = (vendorPayments || []).filter(
        vp => vp.vendorId === v.id || vp.vendorName.trim().toLowerCase() === vNameLower
      );

      const billedPoIds = new Set(bills.map(b => b.poId).filter(Boolean) as string[]);

      let grossBilled = 0;
      let totalReturned = 0;
      let grossPaid = 0;
      let totalRefunded = 0;
      let balanceDue = 0;

      // 1. Vendor Bills (authoritative AP when PO converted or standalone bill exists)
      bills.forEach(bill => {
        const amt = round2(Number(bill.totalAmount || 0));
        const ret = round2(Number(bill.returnedAmount || 0));
        const paid = round2(Number(bill.paidAmount || 0));
        const refunded = round2(Number(bill.refundedAmount || 0));
        const bal =
          bill.balanceAmount != null
            ? round2(Number(bill.balanceAmount))
            : round2(Math.max(0, amt - ret - Math.max(0, paid - refunded)));

        grossBilled = round2(grossBilled + amt);
        totalReturned = round2(totalReturned + ret);
        grossPaid = round2(grossPaid + paid);
        totalRefunded = round2(totalRefunded + refunded);
        balanceDue = round2(balanceDue + bal);
      });

      // 2. Active Unbilled Purchase Orders using exact MySQL paidAmount, returnedAmount, refundedAmount, balanceAmount
      orders.forEach(po => {
        if (po.status === 'CANCELLED' || billedPoIds.has(po.id)) return;
        const amt = round2(Number(po.totalAmount || 0));
        const ret = round2(Number(po.returnedAmount || 0));
        const paid = round2(
          po.paidAmount != null
            ? Number(po.paidAmount)
            : po.paymentStatus === 'PAID'
            ? Math.max(0, amt - ret)
            : 0
        );
        const refunded = round2(Number(po.refundedAmount || 0));
        const netPaidOnPo = Math.max(0, round2(paid - refunded));
        const bal =
          po.balanceAmount != null
            ? round2(Number(po.balanceAmount))
            : po.paymentStatus === 'PAID'
            ? 0
            : round2(Math.max(0, amt - ret - netPaidOnPo));

        grossBilled = round2(grossBilled + amt);
        totalReturned = round2(totalReturned + ret);
        grossPaid = round2(grossPaid + paid);
        totalRefunded = round2(totalRefunded + refunded);
        balanceDue = round2(balanceDue + bal);
      });

      // Ensure totalReturned captures posted purchaseReturns even if bill/po cached column wasn't refreshed
      const sumReturnsDocs = round2(returns.reduce((s, r) => s + Number(r.totalAmount || 0), 0));
      if (sumReturnsDocs > totalReturned) {
        totalReturned = sumReturnsDocs;
      }
      const sumBillPayDocs = round2(vPayments.reduce((s, p) => s + Number(p.amount || 0), 0));
      if (bills.length > 0 && sumBillPayDocs > grossPaid) {
        grossPaid = sumBillPayDocs;
      }

      const totalBilled = round2(Math.max(0, grossBilled - totalReturned));
      const totalPaid = round2(Math.max(0, grossPaid - totalRefunded));

      return {
        vendor: v,
        totalBilled,
        totalReturned,
        totalPaid,
        balanceDue,
        poCount: orders.length + bills.filter(b => !b.poId).length,
        orders,
        bills,
        returns
      };
    });
  }, [vendors, purchaseOrders, vendorBills, vendorPayments, purchaseReturns]);

  const filteredLedger = useMemo(() => {
    return ledgerData.filter(item => {
      // Date filter on order or bill dates
      if (filters.fromDate || filters.toDate) {
        const hasMatchingOrder =
          item.orders.some(o => {
            if (filters.fromDate && o.purchaseDate < filters.fromDate) return false;
            if (filters.toDate && o.purchaseDate > filters.toDate) return false;
            return true;
          }) ||
          item.bills.some(b => {
            if (filters.fromDate && b.billDate < filters.fromDate) return false;
            if (filters.toDate && b.billDate > filters.toDate) return false;
            return true;
          });
        if ((item.orders.length > 0 || item.bills.length > 0) && !hasMatchingOrder) return false;
      }

      // Name filter
      if (filters.name.trim()) {
        const query = filters.name.toLowerCase();
        const matchesName = item.vendor.name.toLowerCase().includes(query);
        const matchesContact = (item.vendor.contactPerson || '').toLowerCase().includes(query);
        const matchesCategory = item.vendor.category.toLowerCase().includes(query);
        if (!matchesName && !matchesContact && !matchesCategory) return false;
      }

      // Status filter
      if (filters.status && filters.status !== 'ALL') {
        if (filters.status === 'PENDING' && item.balanceDue <= 0.01) return false;
        if (filters.status === 'PAID' && item.balanceDue > 0.01) return false;
        if (filters.status === 'PARTIALLY_PAID') {
          const hasPartial =
            item.orders.some(o => o.paymentStatus === 'PARTIALLY_PAID') ||
            item.bills.some(b => b.status === 'PARTIAL');
          if (!hasPartial) return false;
        }
      }

      return true;
    });
  }, [ledgerData, filters]);

  // Aggregate KPIs
  const totalPayablesDue = round2(filteredLedger.reduce((sum, l) => sum + l.balanceDue, 0));
  const totalDisbursed = round2(filteredLedger.reduce((sum, l) => sum + l.totalPaid, 0));
  const totalProcurement = round2(filteredLedger.reduce((sum, l) => sum + l.totalBilled, 0));
  const pendingVendorsCount = filteredLedger.filter(l => l.balanceDue > 0.01).length;

  const vendorSummaryChartData = useMemo(() => {
    return [
      { name: 'Disbursed / Paid Amount', value: totalDisbursed, color: '#10b981' },
      { name: 'Balance Due / Payables', value: totalPayablesDue, color: '#f59e0b' }
    ].filter(d => d.value > 0);
  }, [totalDisbursed, totalPayablesDue]);

  const handleExportCSV = () => {
    const headers = [
      'Vendor Name',
      'Category',
      'Contact Person',
      'Phone',
      'GSTIN',
      'Net Billed (INR)',
      'Purchase Returns (INR)',
      'Net Disbursed (INR)',
      'Net Balance Due (INR)',
      'Account Status'
    ];
    const rows = filteredLedger.map(l => [
      l.vendor.name,
      l.vendor.category,
      l.vendor.contactPerson || 'N/A',
      l.vendor.phone,
      l.vendor.gstNumber || 'N/A',
      l.totalBilled,
      l.totalReturned,
      l.totalPaid,
      l.balanceDue,
      l.balanceDue <= 0.01 ? 'Settled' : 'Pending Payment'
    ]);
    exportToCSV(`SolarUrja_Vendor_Ledger_${new Date().toISOString().slice(0, 10)}`, headers, rows);
    showToast('Vendor ledger exported to CSV', 'success');
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
            <span className="text-xs font-bold text-slate-500 uppercase">Total Payables Due</span>
            <span className="p-2 bg-rose-50 rounded-xl text-rose-600">
              <Clock className="w-4 h-4" />
            </span>
          </div>
          <div className="text-2xl font-black text-rose-700 mt-2">
            ₹{totalPayablesDue.toLocaleString('en-IN')}
          </div>
          <p className="text-[11px] text-slate-500 mt-0.5">Owed to suppliers across open bills</p>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-2xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500 uppercase">Paid / Disbursed</span>
            <span className="p-2 bg-emerald-50 rounded-xl text-emerald-600">
              <CheckCircle2 className="w-4 h-4" />
            </span>
          </div>
          <div className="text-2xl font-black text-emerald-700 mt-2">
            ₹{totalDisbursed.toLocaleString('en-IN')}
          </div>
          <p className="text-[11px] text-slate-500 mt-0.5">Settled vendor transactions</p>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-2xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500 uppercase">Total Procurement</span>
            <span className="p-2 bg-amber-50 rounded-xl text-amber-600">
              <DollarSign className="w-4 h-4" />
            </span>
          </div>
          <div className="text-2xl font-black text-slate-900 mt-2">
            ₹{totalProcurement.toLocaleString('en-IN')}
          </div>
          <p className="text-[11px] text-slate-500 mt-0.5">Cumulative purchase commitments</p>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-2xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500 uppercase">Vendors with Balance</span>
            <span className="p-2 bg-blue-50 rounded-xl text-blue-600">
              <Building2 className="w-4 h-4" />
            </span>
          </div>
          <div className="text-2xl font-black text-blue-700 mt-2">
            {pendingVendorsCount} Vendors
          </div>
          <p className="text-[11px] text-slate-500 mt-0.5">With pending invoices</p>
        </div>
      </div>

      {/* Donut Chart: Paid vs Balance-Due Amount */}
      {vendorSummaryChartData.length > 0 && (
        <div className="bg-white rounded-2xl p-5 border border-slate-200/80 shadow-2xs">
          <h3 className="text-sm font-bold text-slate-900 mb-1">Supplier Ledger: Disbursed vs Pending Payables</h3>
          <p className="text-xs text-slate-500 mb-4">Proportion of procurement invoices paid out vs current unsettled balance due</p>
          <div className="h-64 sm:h-72 w-full flex items-center justify-center">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={vendorSummaryChartData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={95}
                  paddingAngle={3}
                  dataKey="value"
                >
                  {vendorSummaryChartData.map((entry, index) => (
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

      {/* Vendor Ledger Table */}
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-2xs overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-slate-900">Supplier Payables Ledger</h3>
            <p className="text-xs text-slate-500 mt-0.5">Click any vendor to view purchase orders and dues breakdown</p>
          </div>
          <span className="text-xs font-semibold px-2.5 py-1 bg-slate-100 text-slate-700 rounded-lg">
            {filteredLedger.length} Vendors
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50/80 text-[11px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-200/60">
                <th className="py-3 px-4 w-8"></th>
                <th className="py-3 px-4">Vendor / Supplier</th>
                <th className="py-3 px-4">Category</th>
                <th className="py-3 px-4">Contact Person</th>
                <th className="py-3 px-4 text-center">Orders</th>
                <th className="py-3 px-4 text-right">Total Billed</th>
                <th className="py-3 px-4 text-right">Total Disbursed</th>
                <th className="py-3 px-4 text-right">Net Balance Due</th>
                <th className="py-3 px-4 text-center">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs text-slate-700">
              {filteredLedger.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-12 text-center text-slate-400">
                    <Building2 className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                    <p className="font-semibold text-slate-600">No vendor ledger accounts match your filters</p>
                  </td>
                </tr>
              ) : (
                filteredLedger.map(item => {
                  const isExpanded = expandedVendorId === item.vendor.id;

                  return (
                    <React.Fragment key={item.vendor.id}>
                      <tr
                        onClick={() => setExpandedVendorId(isExpanded ? null : item.vendor.id)}
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
                          {item.vendor.name}
                          {item.vendor.gstNumber && (
                            <span className="block text-[10px] text-slate-400 font-normal">
                              GSTIN: {item.vendor.gstNumber}
                            </span>
                          )}
                        </td>
                        <td className="py-3.5 px-4 text-slate-600 font-medium">
                          {item.vendor.category}
                        </td>
                        <td className="py-3.5 px-4 text-slate-600">
                          {item.vendor.contactPerson || '-'}
                          <span className="block text-[10px] text-slate-400">{item.vendor.phone}</span>
                        </td>
                        <td className="py-3.5 px-4 text-center font-semibold text-slate-700">
                          {item.poCount}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono text-slate-700">
                          ₹{item.totalBilled.toLocaleString('en-IN')}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono text-emerald-700">
                          ₹{item.totalPaid.toLocaleString('en-IN')}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono font-bold whitespace-nowrap">
                          <span className={item.balanceDue > 0.01 ? 'text-rose-700' : 'text-slate-700'}>
                            ₹{item.balanceDue.toLocaleString('en-IN')}
                          </span>
                        </td>
                        <td className="py-3.5 px-4 text-center">
                          <span
                            className={`inline-block px-2.5 py-1 rounded-md text-[10px] font-bold border ${
                              item.balanceDue <= 0.01
                                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                : 'bg-rose-50 text-rose-700 border-rose-200'
                            }`}
                          >
                            {item.balanceDue <= 0.01 ? 'Settled' : 'Pending Due'}
                          </span>
                        </td>
                      </tr>

                      {/* Expanded Orders, Bills & Returns List */}
                      {isExpanded && (
                        <tr className="bg-slate-50/50">
                          <td colSpan={9} className="p-4 sm:p-6">
                            <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs space-y-4">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider">
                                  Purchase Orders, Bills & Returns: {item.vendor.name}
                                </h4>
                                {item.totalReturned > 0 && (
                                  <span className="text-[11px] font-mono font-semibold text-amber-800 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded">
                                    Purchase Returns (Debit Notes): ₹{item.totalReturned.toLocaleString('en-IN')}
                                  </span>
                                )}
                              </div>

                              {item.orders.length === 0 && item.bills.length === 0 && item.returns.length === 0 ? (
                                <p className="text-xs text-slate-400 py-3 text-center">
                                  No purchase orders, vendor bills, or returns logged for this supplier yet.
                                </p>
                              ) : (
                                <div className="space-y-4">
                                  {item.orders.length > 0 && (
                                    <table className="w-full text-left text-xs border-collapse">
                                      <thead>
                                        <tr className="border-b border-slate-200 text-slate-400 text-[10px] uppercase font-bold">
                                          <th className="py-2">PO #</th>
                                          <th className="py-2">Date</th>
                                          <th className="py-2">Project / Purpose</th>
                                          <th className="py-2 text-right">Order Amount</th>
                                          <th className="py-2 text-right">Paid / Returned</th>
                                          <th className="py-2 text-center">Order Status</th>
                                          <th className="py-2 text-center">Payment Status</th>
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-slate-100">
                                        {item.orders.map(po => (
                                          <tr key={po.id} className="hover:bg-slate-50">
                                            <td className="py-2 font-mono font-bold text-slate-900">{po.purchaseNumber}</td>
                                            <td className="py-2 text-slate-600">{po.purchaseDate}</td>
                                            <td className="py-2 text-slate-700">{po.projectTitle || 'Central Storage'}</td>
                                            <td className="py-2 text-right font-mono font-bold text-slate-900">
                                              ₹{po.totalAmount.toLocaleString('en-IN')}
                                            </td>
                                            <td className="py-2 text-right font-mono text-slate-600">
                                              ₹{Number(po.paidAmount || 0).toLocaleString('en-IN')}
                                              {Number(po.returnedAmount || 0) > 0
                                                ? ` / Ret ₹${Number(po.returnedAmount || 0).toLocaleString('en-IN')}`
                                                : ''}
                                            </td>
                                            <td className="py-2 text-center">
                                              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-700">
                                                {po.status}
                                              </span>
                                            </td>
                                            <td className="py-2 text-center">
                                              <span
                                                className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                                  po.paymentStatus === 'PAID'
                                                    ? 'bg-emerald-100 text-emerald-800'
                                                    : po.paymentStatus === 'PARTIALLY_PAID'
                                                    ? 'bg-amber-100 text-amber-800'
                                                    : 'bg-rose-100 text-rose-800'
                                                }`}
                                              >
                                                {po.paymentStatus}
                                              </span>
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  )}

                                  {item.bills.length > 0 && (
                                    <table className="w-full text-left text-xs border-collapse">
                                      <thead>
                                        <tr className="border-b border-slate-200 text-slate-400 text-[10px] uppercase font-bold">
                                          <th className="py-2">Vendor Bill #</th>
                                          <th className="py-2">Date</th>
                                          <th className="py-2">PO Ref</th>
                                          <th className="py-2 text-right">Bill Total</th>
                                          <th className="py-2 text-right">Balance Due</th>
                                          <th className="py-2 text-center">Status</th>
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-slate-100">
                                        {item.bills.map(b => (
                                          <tr key={b.id} className="hover:bg-slate-50">
                                            <td className="py-2 font-mono font-bold text-slate-900">{b.billNumber}</td>
                                            <td className="py-2 text-slate-600">{b.billDate}</td>
                                            <td className="py-2 text-slate-700">{b.poNumber || 'Direct Bill'}</td>
                                            <td className="py-2 text-right font-mono font-bold text-slate-900">
                                              ₹{Number(b.totalAmount || 0).toLocaleString('en-IN')}
                                            </td>
                                            <td className="py-2 text-right font-mono font-semibold text-rose-700">
                                              ₹{Number(b.balanceAmount || 0).toLocaleString('en-IN')}
                                            </td>
                                            <td className="py-2 text-center">
                                              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-700">
                                                {b.status}
                                              </span>
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  )}

                                  {item.returns.length > 0 && (
                                    <table className="w-full text-left text-xs border-collapse">
                                      <thead>
                                        <tr className="border-b border-slate-200 text-slate-400 text-[10px] uppercase font-bold">
                                          <th className="py-2">Purchase Return #</th>
                                          <th className="py-2">Date</th>
                                          <th className="py-2">Against PO / Bill</th>
                                          <th className="py-2 text-right">Return Amount</th>
                                          <th className="py-2 text-center">Settlement Mode</th>
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-slate-100">
                                        {item.returns.map(pr => (
                                          <tr key={pr.id} className="bg-amber-50/30">
                                            <td className="py-2 font-mono font-bold text-amber-800">{pr.returnNumber}</td>
                                            <td className="py-2 text-slate-600">{pr.returnDate}</td>
                                            <td className="py-2 text-slate-700">
                                              {[pr.poNumber, pr.vendorBillNumber].filter(Boolean).join(' · ') || '—'}
                                            </td>
                                            <td className="py-2 text-right font-mono font-bold text-amber-800">
                                              ₹{Number(pr.totalAmount || 0).toLocaleString('en-IN')}
                                            </td>
                                            <td className="py-2 text-center">
                                              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800">
                                                {pr.settlementMode}
                                              </span>
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  )}
                                </div>
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
