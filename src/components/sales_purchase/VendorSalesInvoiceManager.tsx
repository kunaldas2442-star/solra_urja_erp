import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { storageService } from '../../services/storage';
import {
  BankAccount,
  ProductItem,
  Vendor,
  VendorSalesDiscountType,
  VendorSalesInvoice,
  VendorSalesInvoiceStatus,
  VendorSalesLineItem
} from '../../types/solar';
import {
  computeVendorSalesInvoiceTotals,
  computeVendorSalesLineItem,
  determineVendorSupplyType,
  resolveStateNameAndCode,
  roundCurrency
} from '../../utils/gstTaxUtils';
import { numberToIndianWords } from '../../utils/indianNumberWords';
import { downloadVendorSalesInvoicePdf } from '../../utils/vendorSalesInvoicePdf';
import { PrintPortal, triggerSafeWindowPrint } from '../common/PrintPortal';
import {
  AlertCircle,
  AlertTriangle,
  Building2,
  Calendar,
  CheckCircle2,
  Clock,
  CreditCard,
  Download,
  Edit3,
  Eye,
  FileText,
  IndianRupee,
  Landmark,
  Loader2,
  Package,
  Plus,
  Printer,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  X
} from 'lucide-react';

type StatusFilter = 'ALL' | VendorSalesInvoiceStatus;

interface DraftLineItem {
  id: string;
  productId?: string;
  description: string;
  hsnCode: string;
  quantity: number;
  unit: string;
  rate: number;
  discountType: VendorSalesDiscountType;
  discountValue: number;
  gstRate: number;
}

const STANDARD_GST_RATES = [0, 5, 12, 18, 28];

function fmtCurrency(value: number | undefined | null): string {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return '₹0.00';
  return (
    '₹' +
    num.toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })
  );
}

function computeVsiBalances(invoice: VendorSalesInvoice) {
  const total = roundCurrency(Number(invoice.totalAmount || 0));
  const paid = roundCurrency(Number(invoice.paidAmount || 0));
  const returned = roundCurrency(Number(invoice.returnedAmount || 0));
  const refunded = roundCurrency(Number(invoice.refundedAmount || 0));
  const netPaid = roundCurrency(Math.max(0, paid - refunded));
  const balance = roundCurrency(
    invoice.balanceAmount != null
      ? Math.max(0, Number(invoice.balanceAmount))
      : Math.max(0, total - returned - netPaid)
  );
  return { total, paid, returned, refunded, netPaid, balance };
}

function getEffectiveStatus(invoice: VendorSalesInvoice): VendorSalesInvoiceStatus {
  const { total, returned, netPaid, balance } = computeVsiBalances(invoice);
  if (invoice.status === 'DRAFT') {
    return 'DRAFT';
  }
  if (
    invoice.status === 'PAID' ||
    (balance <= 0.01 && (netPaid > 0 || (total > 0 && returned >= total - 0.01)))
  ) {
    return 'PAID';
  }
  const today = new Date().toISOString().slice(0, 10);
  if (invoice.dueDate && invoice.dueDate < today && balance > 0.01) {
    return 'OVERDUE';
  }
  if (netPaid > 0 && balance > 0.01) {
    return 'PARTIALLY_PAID';
  }
  return invoice.status || 'ISSUED';
}

function getStatusMeta(status: VendorSalesInvoiceStatus): {
  label: string;
  className: string;
  icon: React.ReactNode;
} {
  switch (status) {
    case 'PAID':
      return {
        label: 'Paid',
        className: 'bg-emerald-50 text-emerald-700 border-emerald-200',
        icon: <CheckCircle2 className="w-3.5 h-3.5" />
      };
    case 'PARTIALLY_PAID':
      return {
        label: 'Partially Paid',
        className: 'bg-sky-50 text-sky-700 border-sky-200',
        icon: <CreditCard className="w-3.5 h-3.5" />
      };
    case 'OVERDUE':
      return {
        label: 'Overdue',
        className: 'bg-rose-50 text-rose-700 border-rose-200',
        icon: <AlertTriangle className="w-3.5 h-3.5" />
      };
    case 'DRAFT':
      return {
        label: 'Draft',
        className: 'bg-slate-100 text-slate-700 border-slate-200',
        icon: <Clock className="w-3.5 h-3.5" />
      };
    case 'ISSUED':
    default:
      return {
        label: 'Issued',
        className: 'bg-amber-50 text-amber-800 border-amber-200',
        icon: <FileText className="w-3.5 h-3.5" />
      };
  }
}

export const VendorSalesInvoiceManager: React.FC = () => {
  const { refreshTrigger, triggerRefresh, showToast } = useApp();
  const { currentUser, isAdmin } = useAuth();
  const hasAdminRights =
    isAdmin || String(currentUser?.role || '').trim().toUpperCase() === 'SUPER ADMIN';

  // List & sync states
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [vendorFilterId, setVendorFilterId] = useState<string>('ALL');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');

  // Modal states
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editingInvoiceId, setEditingInvoiceId] = useState<string | null>(null);
  const [viewingInvoiceId, setViewingInvoiceId] = useState<string | null>(null);
  const [paymentInvoiceId, setPaymentInvoiceId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<VendorSalesInvoice | null>(null);

  // Save/action states
  const [isSaving, setIsSaving] = useState(false);
  const [isRecordingPayment, setIsRecordingPayment] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);

  // Create / Edit Form state
  const [formInvoiceNumber, setFormInvoiceNumber] = useState('');
  const [formVendorId, setFormVendorId] = useState('');
  const [formInvoiceDate, setFormInvoiceDate] = useState(new Date().toISOString().slice(0, 10));
  const [formDueDate, setFormDueDate] = useState(
    new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10)
  );
  const [formPaymentTerms, setFormPaymentTerms] = useState('Net 15 Days');
  const [formStatus, setFormStatus] = useState<VendorSalesInvoiceStatus>('ISSUED');
  const [formNotes, setFormNotes] = useState('');
  const [formItems, setFormItems] = useState<DraftLineItem[]>([]);
  const [formInitialSettlement, setFormInitialSettlement] = useState<'UNPAID' | 'PARTIAL' | 'PAID'>('UNPAID');
  const [formInitialPaidAmount, setFormInitialPaidAmount] = useState<number>(0);
  const [formPaymentMode, setFormPaymentMode] = useState('Bank NEFT / RTGS');
  const [formBankAccountId, setFormBankAccountId] = useState('');

  // Line Item Draft Builder controls
  const [draftProductId, setDraftProductId] = useState('');
  const [draftDesc, setDraftDesc] = useState('');
  const [draftHsn, setDraftHsn] = useState('85414011');
  const [draftQty, setDraftQty] = useState<number>(1);
  const [draftUnit, setDraftUnit] = useState('NOS');
  const [draftRate, setDraftRate] = useState<number>(0);
  const [draftDiscountType, setDraftDiscountType] = useState<VendorSalesDiscountType>('PERCENT');
  const [draftDiscountVal, setDraftDiscountVal] = useState<number>(0);
  const [draftGstRate, setDraftGstRate] = useState<number>(18);
  const [draftCustomGst, setDraftCustomGst] = useState<boolean>(false);

  // Payment Form state
  const [payDate, setPayDate] = useState(new Date().toISOString().slice(0, 10));
  const [payAmount, setPayAmount] = useState<number>(0);
  const [payMode, setPayMode] = useState('Bank NEFT / RTGS');
  const [payBankAccountId, setPayBankAccountId] = useState('');
  const [payReference, setPayReference] = useState('');
  const [payNotes, setPayNotes] = useState('');
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [syncTick, setSyncTick] = useState(0);

  // Store-backed collections
  const invoices = useMemo(() => storageService.getVendorSalesInvoices(), [refreshTrigger, syncTick]);
  const vendors = useMemo(() => storageService.getVendors(), [refreshTrigger, syncTick]);
  const products = useMemo(() => storageService.getProducts(), [refreshTrigger, syncTick]);
  const settings = useMemo(() => storageService.getSettings(), [refreshTrigger, syncTick]);

  const activeBankAccounts = useMemo(
    () => bankAccounts.filter(b => b.isActive),
    [bankAccounts]
  );

  // Fetch latest MySQL records & bank accounts on mount when Admin
  const syncFromMySql = async (silent = false) => {
    if (!hasAdminRights) return;
    if (!silent) setIsLoading(true);
    setLoadError(null);
    try {
      const [, banks] = await Promise.all([
        storageService.fetchVendorSalesInvoicesAsync(),
        storageService.fetchAccountingBankAccountsAsync().catch(() => [])
      ]);
      if (Array.isArray(banks)) setBankAccounts(banks);
      triggerRefresh();
    } catch (err: any) {
      const msg = err?.message || 'Unable to load Vendor Sales Invoices from MySQL.';
      setLoadError(msg);
      if (!silent) showToast(msg, 'error');
    } finally {
      if (!silent) setIsLoading(false);
    }
  };

  useEffect(() => {
    syncFromMySql(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAdminRights]);

  useEffect(() => {
    const onUpdated = () => setSyncTick(t => t + 1);
    window.addEventListener('solarpulse_storage_updated', onUpdated);
    return () => window.removeEventListener('solarpulse_storage_updated', onUpdated);
  }, []);

  const selectedVendor: Vendor | undefined = useMemo(
    () => vendors.find(v => v.id === formVendorId),
    [vendors, formVendorId]
  );

  const supplyInfo = useMemo(() => {
    return determineVendorSupplyType({
      companyGst: settings.companyGst,
      companyAddress: settings.companyAddress,
      vendorState: selectedVendor?.state,
      vendorGst: selectedVendor?.gstNumber,
      vendorAddress: selectedVendor?.address
    });
  }, [settings.companyGst, settings.companyAddress, selectedVendor]);

  const liveTotals = useMemo(() => {
    return computeVendorSalesInvoiceTotals(formItems, supplyInfo.supplyType);
  }, [formItems, supplyInfo.supplyType]);

  const draftPreview = useMemo(() => {
    return computeVendorSalesLineItem(
      {
        productId: draftProductId || undefined,
        description: draftDesc,
        hsnCode: draftHsn,
        quantity: draftQty,
        unit: draftUnit,
        rate: draftRate,
        discountType: draftDiscountType,
        discountValue: draftDiscountVal,
        gstRate: draftGstRate
      },
      supplyInfo.supplyType
    );
  }, [
    draftProductId,
    draftDesc,
    draftHsn,
    draftQty,
    draftUnit,
    draftRate,
    draftDiscountType,
    draftDiscountVal,
    draftGstRate,
    supplyInfo.supplyType
  ]);

  const viewingInvoice = useMemo(
    () => (viewingInvoiceId ? invoices.find(inv => inv.id === viewingInvoiceId) || null : null),
    [invoices, viewingInvoiceId]
  );

  const paymentInvoice = useMemo(
    () => (paymentInvoiceId ? invoices.find(inv => inv.id === paymentInvoiceId) || null : null),
    [invoices, paymentInvoiceId]
  );

  // Summary KPIs across all invoices
  const kpis = useMemo(() => {
    let totalBilled = 0;
    let totalCollected = 0;
    let totalOutstanding = 0;
    let totalOverdue = 0;
    let totalReturned = 0;
    let paidCount = 0;
    let overdueCount = 0;
    let draftCount = 0;

    invoices.forEach(inv => {
      const effective = getEffectiveStatus(inv);
      const { total, returned, netPaid, balance } = computeVsiBalances(inv);

      if (effective !== 'DRAFT') {
        totalBilled += Math.max(0, total - returned);
        totalCollected += netPaid;
        totalOutstanding += balance;
        totalReturned += returned;
      }
      if (effective === 'OVERDUE') {
        totalOverdue += balance;
        overdueCount += 1;
      } else if (effective === 'PAID') {
        paidCount += 1;
      } else if (effective === 'DRAFT') {
        draftCount += 1;
      }
    });

    return {
      totalCount: invoices.length,
      totalBilled: roundCurrency(totalBilled),
      totalCollected: roundCurrency(totalCollected),
      totalOutstanding: roundCurrency(totalOutstanding),
      totalOverdue: roundCurrency(totalOverdue),
      totalReturned: roundCurrency(totalReturned),
      paidCount,
      overdueCount,
      draftCount
    };
  }, [invoices]);

  // Filtered invoices
  const filteredInvoices = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return invoices.filter(inv => {
      const effective = getEffectiveStatus(inv);
      if (statusFilter !== 'ALL' && effective !== statusFilter) return false;
      if (vendorFilterId !== 'ALL' && inv.vendorId !== vendorFilterId) return false;
      if (dateFrom && inv.invoiceDate && inv.invoiceDate < dateFrom) return false;
      if (dateTo && inv.invoiceDate && inv.invoiceDate > dateTo) return false;

      if (!q) return true;
      const matchesMeta =
        (inv.invoiceNumber || '').toLowerCase().includes(q) ||
        (inv.vendorName || '').toLowerCase().includes(q) ||
        (inv.vendorCode || '').toLowerCase().includes(q) ||
        (inv.vendorGst || '').toLowerCase().includes(q) ||
        (inv.vendorState || '').toLowerCase().includes(q);
      const matchesItems = (inv.items || []).some(
        it =>
          (it.description || '').toLowerCase().includes(q) ||
          (it.hsnCode || '').toLowerCase().includes(q)
      );
      return matchesMeta || matchesItems;
    });
  }, [invoices, searchQuery, statusFilter, vendorFilterId, dateFrom, dateTo]);

  // Reset line item draft inputs
  const resetDraftLineBuilder = () => {
    setDraftProductId('');
    setDraftDesc('');
    setDraftHsn('85414011');
    setDraftQty(1);
    setDraftUnit('NOS');
    setDraftRate(0);
    setDraftDiscountType('PERCENT');
    setDraftDiscountVal(0);
    setDraftGstRate(18);
    setDraftCustomGst(false);
  };

  // Open Create Invoice modal
  const openCreateModal = async () => {
    setEditorError(null);
    setEditingInvoiceId(null);
    const today = new Date().toISOString().slice(0, 10);
    const defaultDue = new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10);
    setFormVendorId('');
    setFormInvoiceDate(today);
    setFormDueDate(defaultDue);
    setFormPaymentTerms('Net 15 Days');
    setFormStatus('ISSUED');
    setFormNotes('');
    setFormItems([]);
    setFormInitialSettlement('UNPAID');
    setFormInitialPaidAmount(0);
    setFormPaymentMode('Bank NEFT / RTGS');
    const primaryBank = activeBankAccounts.find(b => b.isPrimary) || activeBankAccounts[0];
    setFormBankAccountId(primaryBank?.id || '');
    resetDraftLineBuilder();

    const year = new Date().getFullYear();
    const fallbackNext = `VSI-${year}-${String(invoices.length + 1).padStart(3, '0')}`;
    setFormInvoiceNumber(fallbackNext);
    setIsEditorOpen(true);

    try {
      const serverNext = await storageService.getNextVendorSalesInvoiceNumberAsync();
      if (serverNext) {
        setFormInvoiceNumber(serverNext);
      }
    } catch {
      // Fallback already populated
    }
  };

  // Open Edit Invoice modal
  const openEditModal = (invoice: VendorSalesInvoice) => {
    setEditorError(null);
    setEditingInvoiceId(invoice.id);
    setFormInvoiceNumber(invoice.invoiceNumber);
    setFormVendorId(invoice.vendorId);
    setFormInvoiceDate(invoice.invoiceDate || new Date().toISOString().slice(0, 10));
    setFormDueDate(invoice.dueDate || new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10));
    setFormPaymentTerms(invoice.paymentTerms || 'Net 15 Days');
    setFormStatus(invoice.status === 'DRAFT' ? 'DRAFT' : 'ISSUED');
    setFormNotes(invoice.notes || '');
    const defaultBank =
      invoice.bankAccountId ||
      activeBankAccounts.find(b => b.isPrimary)?.id ||
      activeBankAccounts[0]?.id ||
      '';
    setFormBankAccountId(defaultBank);
    setFormItems(
      (invoice.items || []).map((it, idx) => ({
        id: it.id || `vsli-${Date.now()}-${idx}`,
        productId: it.productId,
        description: it.description,
        hsnCode: it.hsnCode || '',
        quantity: Number(it.quantity || 0),
        unit: it.unit || 'NOS',
        rate: Number(it.rate || 0),
        discountType: it.discountType === 'FLAT' ? 'FLAT' : 'PERCENT',
        discountValue: Number(it.discountValue || 0),
        gstRate: Number(it.gstRate || 0)
      }))
    );
    resetDraftLineBuilder();
    setIsEditorOpen(true);
  };

  // Vendor selection handler — auto-populates payment terms & due date if creating
  const handleSelectVendor = (vendorId: string) => {
    setFormVendorId(vendorId);
    const v = vendors.find(item => item.id === vendorId);
    if (v && v.paymentTerms && !editingInvoiceId) {
      setFormPaymentTerms(v.paymentTerms);
      const dayMatch = v.paymentTerms.match(/(\d+)\s*day/i);
      if (dayMatch) {
        const days = Math.min(365, Math.max(0, Number(dayMatch[1])));
        const baseTime = formInvoiceDate ? new Date(formInvoiceDate).getTime() : Date.now();
        if (!isNaN(baseTime)) {
          setFormDueDate(new Date(baseTime + days * 86400000).toISOString().slice(0, 10));
        }
      }
    }
  };

  // Product selection in line item draft builder
  const handleDraftProductChange = (prodId: string) => {
    setDraftProductId(prodId);
    if (!prodId) return;
    const prod: ProductItem | undefined = products.find(p => p.id === prodId);
    if (!prod) return;
    setDraftDesc(prod.name);
    setDraftHsn(prod.hsnCode || '85414011');
    setDraftUnit(prod.unit || 'NOS');
    setDraftRate(Number(prod.sellingPrice || prod.unitPrice || 0));
    const rate =
      prod.gstRate !== undefined && prod.gstRate !== null && Number.isFinite(Number(prod.gstRate))
        ? Number(prod.gstRate)
        : 18;
    setDraftGstRate(rate);
    setDraftCustomGst(!STANDARD_GST_RATES.includes(rate));
  };

  const handleAddDraftItem = () => {
    if (!draftDesc.trim()) {
      showToast('Enter a product or service description.', 'warning');
      return;
    }
    if (draftQty <= 0) {
      showToast('Quantity must be greater than 0.', 'warning');
      return;
    }
    if (draftRate <= 0) {
      showToast('Rate must be greater than 0.', 'warning');
      return;
    }
    if (draftGstRate < 0 || draftGstRate > 100) {
      showToast('GST rate must be between 0% and 100%.', 'warning');
      return;
    }

    const newItem: DraftLineItem = {
      id: `vsli-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      productId: draftProductId || undefined,
      description: draftDesc.trim(),
      hsnCode: draftHsn.trim(),
      quantity: Number(draftQty),
      unit: draftUnit.trim() || 'NOS',
      rate: Number(draftRate),
      discountType: draftDiscountType,
      discountValue: Math.max(0, Number(draftDiscountVal) || 0),
      gstRate: Number(draftGstRate)
    };
    setFormItems(prev => [...prev, newItem]);
    resetDraftLineBuilder();
  };

  const handleUpdateLineItem = (index: number, patch: Partial<DraftLineItem>) => {
    setFormItems(prev =>
      prev.map((item, idx) => (idx === index ? { ...item, ...patch } : item))
    );
  };

  const handleRemoveLineItem = (index: number) => {
    setFormItems(prev => prev.filter((_, idx) => idx !== index));
  };

  // Save Create / Edit invoice to MySQL
  const handleSaveInvoice = async (e: React.FormEvent) => {
    e.preventDefault();
    setEditorError(null);

    if (!formVendorId || !selectedVendor) {
      const msg = 'Please select an existing vendor from the MySQL vendor directory.';
      setEditorError(msg);
      showToast(msg, 'warning');
      return;
    }
    if (!formInvoiceNumber.trim()) {
      const msg = 'Invoice number is required.';
      setEditorError(msg);
      showToast(msg, 'warning');
      return;
    }
    if (formItems.length === 0) {
      const msg = 'Add at least one invoice line item before saving.';
      setEditorError(msg);
      showToast(msg, 'warning');
      return;
    }
    for (let i = 0; i < formItems.length; i++) {
      const it = formItems[i];
      if (!it.description.trim() || it.quantity <= 0 || it.rate < 0 || it.gstRate < 0 || it.gstRate > 100) {
        const msg = `Line item #${i + 1} has invalid description, quantity, rate, or GST rate.`;
        setEditorError(msg);
        showToast(msg, 'warning');
        return;
      }
    }

    const editingTarget = editingInvoiceId
      ? invoices.find(inv => inv.id === editingInvoiceId)
      : undefined;

    let initialPaidAmount = 0;
    if (!editingInvoiceId && formStatus !== 'DRAFT' && formInitialSettlement !== 'UNPAID') {
      if (formInitialSettlement === 'PAID') {
        initialPaidAmount = liveTotals.totalAmount;
      } else {
        if (!Number.isFinite(formInitialPaidAmount) || formInitialPaidAmount <= 0 || formInitialPaidAmount > liveTotals.totalAmount + 0.01) {
          const msg = `Upfront partial payment must be between ₹0.01 and ${fmtCurrency(liveTotals.totalAmount)}.`;
          setEditorError(msg);
          showToast(msg, 'warning');
          return;
        }
        initialPaidAmount = roundCurrency(formInitialPaidAmount);
      }
      if (activeBankAccounts.length > 0 && !formBankAccountId) {
        const msg = 'Please select an active Cash / Bank account for the upfront payment.';
        setEditorError(msg);
        showToast(msg, 'warning');
        return;
      }
    }

    const payload: Partial<VendorSalesInvoice> & { paymentMode?: string } = {
      id: editingInvoiceId || undefined,
      invoiceNumber: formInvoiceNumber.trim(),
      vendorId: selectedVendor.id,
      vendorCode: selectedVendor.vendorCode,
      vendorName: selectedVendor.name,
      vendorGst: selectedVendor.gstNumber,
      vendorAddress: selectedVendor.address,
      vendorCity: selectedVendor.city,
      vendorState: supplyInfo.vendorStateName || selectedVendor.state,
      vendorContactPerson: selectedVendor.contactPerson,
      vendorPhone: selectedVendor.phone,
      vendorEmail: selectedVendor.email,
      companyState: supplyInfo.companyStateName,
      supplyType: supplyInfo.supplyType,
      invoiceDate: formInvoiceDate,
      dueDate: formDueDate,
      paymentTerms: formPaymentTerms.trim() || 'Net 15 Days',
      notes: formNotes.trim(),
      status:
        editingTarget && editingTarget.paidAmount > 0 && formStatus !== 'DRAFT'
          ? editingTarget.status
          : formStatus,
      paidAmount: !editingInvoiceId && formStatus !== 'DRAFT' ? initialPaidAmount : undefined,
      bankAccountId: formBankAccountId || '',
      paymentMode: !editingInvoiceId && initialPaidAmount > 0 ? formPaymentMode : undefined,
      items: liveTotals.items
    };

    setIsSaving(true);
    try {
      const saved = await storageService.saveVendorSalesInvoiceAsync(payload, Boolean(editingInvoiceId));
      const latestBanks = await storageService.fetchAccountingBankAccountsAsync().catch(() => []);
      if (latestBanks.length > 0) setBankAccounts(latestBanks);
      triggerRefresh();
      showToast(
        editingInvoiceId
          ? `Vendor Sales Invoice ${saved.invoiceNumber} updated in MySQL.`
          : `Vendor Sales Invoice ${saved.invoiceNumber} created and saved to MySQL.`,
        'success'
      );
      setIsEditorOpen(false);
      setEditingInvoiceId(null);
    } catch (err: any) {
      const msg = err?.message || 'Failed to save vendor sales invoice.';
      setEditorError(msg);
      showToast(msg, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  // Record Payment modal open & submit
  const openPaymentModal = (invoice: VendorSalesInvoice) => {
    const { balance } = computeVsiBalances(invoice);
    const defaultBank =
      (invoice.bankAccountId && activeBankAccounts.some(b => b.id === invoice.bankAccountId)
        ? invoice.bankAccountId
        : activeBankAccounts.find(b => b.isPrimary)?.id || activeBankAccounts[0]?.id) || '';
    setPaymentInvoiceId(invoice.id);
    setPayDate(new Date().toISOString().slice(0, 10));
    setPayAmount(balance > 0 ? balance : 0);
    setPayMode('Bank NEFT / RTGS');
    setPayBankAccountId(defaultBank);
    setPayReference('');
    setPayNotes('');
    if (activeBankAccounts.length === 0) {
      storageService
        .fetchAccountingBankAccountsAsync()
        .then(banks => {
          setBankAccounts(banks);
          const def = banks.find(b => b.isActive && b.isPrimary)?.id || banks.find(b => b.isActive)?.id || '';
          if (def) setPayBankAccountId(prev => prev || def);
        })
        .catch(() => undefined);
    }
  };

  const handleSubmitPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!paymentInvoice) return;

    const { balance: remaining } = computeVsiBalances(paymentInvoice);

    if (!Number.isFinite(payAmount) || payAmount <= 0) {
      showToast('Enter a valid payment amount greater than 0.', 'warning');
      return;
    }
    if (payAmount > remaining + 0.01) {
      showToast(`Payment cannot exceed remaining balance (${fmtCurrency(remaining)}).`, 'warning');
      return;
    }
    if (activeBankAccounts.length > 0 && !payBankAccountId) {
      showToast('Select the Cash/Bank account receiving this payment.', 'warning');
      return;
    }

    setIsRecordingPayment(true);
    try {
      const updated = await storageService.recordVendorSalesPaymentAsync(paymentInvoice.id, {
        amount: roundCurrency(payAmount),
        paymentDate: payDate,
        paymentMode: payMode,
        bankAccountId: payBankAccountId || undefined,
        referenceNo: payReference.trim(),
        notes: payNotes.trim()
      });
      const latestBanks = await storageService.fetchAccountingBankAccountsAsync().catch(() => []);
      if (latestBanks.length > 0) setBankAccounts(latestBanks);
      triggerRefresh();
      showToast(
        `Recorded ${fmtCurrency(payAmount)} for ${updated.invoiceNumber}. Status: ${updated.status.replace(/_/g, ' ')}.`,
        'success'
      );
      setPaymentInvoiceId(null);
    } catch (err: any) {
      showToast(err?.message || 'Failed to record payment.', 'error');
    } finally {
      setIsRecordingPayment(false);
    }
  };

  // Delete invoice confirmation handler
  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await storageService.deleteVendorSalesInvoiceAsync(deleteTarget.id);
      if (viewingInvoiceId === deleteTarget.id) setViewingInvoiceId(null);
      triggerRefresh();
      showToast(`Vendor Sales Invoice ${deleteTarget.invoiceNumber} deleted.`, 'success');
      setDeleteTarget(null);
    } catch (err: any) {
      showToast(err?.message || 'Failed to delete invoice.', 'error');
    } finally {
      setIsDeleting(false);
    }
  };

  // Print from list row or view modal
  const handlePrintInvoice = async (invoice: VendorSalesInvoice) => {
    setViewingInvoiceId(invoice.id);
    await new Promise(resolve => setTimeout(resolve, 60));
    await triggerSafeWindowPrint(settings.logoUrl ? [settings.logoUrl] : []);
  };

  // Hard Admin Guard
  if (!hasAdminRights) {
    return (
      <div className="bg-white border border-rose-200 rounded-xl p-8 text-center max-w-lg mx-auto my-8">
        <div className="w-11 h-11 rounded-xl bg-rose-50 text-rose-600 flex items-center justify-center mx-auto mb-3 border border-rose-200">
          <ShieldCheck className="w-5 h-5" />
        </div>
        <h3 className="text-base font-bold text-slate-900">Administrator Access Required</h3>
        <p className="text-xs text-slate-600 mt-1.5 leading-relaxed">
          Vendor Sales Invoices contain outward vendor GST billing and settlement ledgers restricted exclusively to Admin users.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header & Action Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="p-2.5 rounded-xl bg-slate-900 text-amber-400 shrink-0">
            <FileText className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-bold text-slate-900 tracking-tight">
                Vendor Sales Invoices
              </h2>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100 border border-slate-200 text-[11px] font-semibold text-slate-700">
                <ShieldCheck className="w-3 h-3 text-amber-600" />
                Admin Only • Outward GST Sales
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              Issue GST-compliant outward sales invoices to registered MySQL vendors, track CGST/SGST or IGST tax splits, record payments, and export PDFs.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={() => syncFromMySql(false)}
            disabled={isLoading}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700 cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
          <button
            type="button"
            onClick={openCreateModal}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold shadow-2xs cursor-pointer transition-colors"
          >
            <Plus className="w-4 h-4" />
            <span>Create Vendor Invoice</span>
          </button>
        </div>
      </div>

      {loadError && (
        <div className="bg-rose-50 border border-rose-200 rounded-xl px-4 py-3 flex items-center justify-between gap-3 text-xs text-rose-800">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
            <span>{loadError}</span>
          </div>
          <button
            type="button"
            onClick={() => syncFromMySql(false)}
            className="px-2.5 py-1 rounded-md bg-rose-600 text-white font-semibold hover:bg-rose-700 cursor-pointer shrink-0"
          >
            Retry
          </button>
        </div>
      )}

      {/* KPI Summary Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500 font-medium">
            <span>Total Invoiced (Issued)</span>
            <IndianRupee className="w-4 h-4 text-slate-400" />
          </div>
          <div className="mt-2 text-xl font-bold text-slate-900 font-mono tabular-nums">
            {fmtCurrency(kpis.totalBilled)}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            {kpis.totalCount} total ({kpis.draftCount} draft)
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500 font-medium">
            <span>Payments Collected</span>
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
          </div>
          <div className="mt-2 text-xl font-bold text-emerald-700 font-mono tabular-nums">
            {fmtCurrency(kpis.totalCollected)}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">{kpis.paidCount} fully settled</div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500 font-medium">
            <span>Receivable Balance</span>
            <Clock className="w-4 h-4 text-amber-500" />
          </div>
          <div className="mt-2 text-xl font-bold text-amber-700 font-mono tabular-nums">
            {fmtCurrency(kpis.totalOutstanding)}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">Open vendor balances</div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500 font-medium">
            <span>Overdue Amount</span>
            <AlertTriangle className="w-4 h-4 text-rose-500" />
          </div>
          <div className="mt-2 text-xl font-bold text-rose-700 font-mono tabular-nums">
            {fmtCurrency(kpis.totalOverdue)}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">{kpis.overdueCount} past due date</div>
        </div>
      </div>

      {/* Filters & Search Controls */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
          <div className="md:col-span-4">
            <label className="block text-[11px] font-semibold text-slate-500 mb-1">
              Search Invoices / Vendor / Item
            </label>
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="VSI-2026-001, vendor name, GSTIN, item..."
                className="w-full pl-8 pr-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400"
              />
            </div>
          </div>

          <div className="md:col-span-3">
            <label className="block text-[11px] font-semibold text-slate-500 mb-1">
              Filter by Vendor
            </label>
            <select
              value={vendorFilterId}
              onChange={e => setVendorFilterId(e.target.value)}
              className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400"
            >
              <option value="ALL">All Vendors ({vendors.length})</option>
              {vendors.map(v => (
                <option key={v.id} value={v.id}>
                  {v.name} ({v.vendorCode})
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-2">
            <label className="block text-[11px] font-semibold text-slate-500 mb-1">
              From Date
            </label>
            <input
              type="date"
              value={dateFrom}
              onChange={e => setDateFrom(e.target.value)}
              className="w-full px-2.5 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400"
            />
          </div>

          <div className="md:col-span-2">
            <label className="block text-[11px] font-semibold text-slate-500 mb-1">
              To Date
            </label>
            <input
              type="date"
              value={dateTo}
              onChange={e => setDateTo(e.target.value)}
              className="w-full px-2.5 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400"
            />
          </div>

          <div className="md:col-span-1 flex justify-end">
            <button
              type="button"
              onClick={() => {
                setSearchQuery('');
                setStatusFilter('ALL');
                setVendorFilterId('ALL');
                setDateFrom('');
                setDateTo('');
              }}
              className="w-full px-2.5 py-2 text-xs font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
            >
              Reset
            </button>
          </div>
        </div>

        {/* Status Segmented Tabs */}
        <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-slate-100">
          {(['ALL', 'DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE'] as StatusFilter[]).map(
            st => (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter(st)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                  statusFilter === st
                    ? 'bg-slate-900 text-white'
                    : 'bg-slate-50 text-slate-600 hover:bg-slate-100 border border-slate-200'
                }`}
              >
                {st === 'ALL' ? 'All Invoices' : st.replace(/_/g, ' ')}
              </button>
            )
          )}
        </div>
      </div>

      {/* Invoices Listing Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {isLoading && invoices.length === 0 ? (
          <div className="py-16 flex flex-col items-center justify-center text-slate-400 gap-2">
            <Loader2 className="w-6 h-6 animate-spin text-amber-500" />
            <span className="text-xs font-medium">Loading vendor sales invoices from MySQL...</span>
          </div>
        ) : filteredInvoices.length === 0 ? (
          <div className="py-16 px-4 text-center space-y-3">
            <div className="w-11 h-11 rounded-xl bg-slate-100 text-slate-400 flex items-center justify-center mx-auto">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-800">No Vendor Sales Invoices Found</h3>
              <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
                {invoices.length === 0
                  ? 'Create your first GST-compliant outward sales invoice for a registered MySQL vendor.'
                  : 'Adjust search, vendor, status, or date range filters to view matching invoices.'}
              </p>
            </div>
            {invoices.length === 0 && (
              <button
                type="button"
                onClick={openCreateModal}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Create First Invoice</span>
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 font-semibold">
                <tr>
                  <th className="py-3 px-4">Invoice &amp; Dates</th>
                  <th className="py-3 px-4">Vendor Details</th>
                  <th className="py-3 px-4">Supply &amp; GST</th>
                  <th className="py-3 px-4 text-right">Taxable</th>
                  <th className="py-3 px-4 text-right">Total / Balance</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredInvoices.map(inv => {
                  const effective = getEffectiveStatus(inv);
                  const statusMeta = getStatusMeta(effective);
                  const { returned, refunded, netPaid, balance } = computeVsiBalances(inv);
                  return (
                    <tr key={inv.id} className="hover:bg-slate-50/70 transition-colors">
                      <td className="py-3 px-4 align-top">
                        <div className="font-mono font-bold text-slate-900">{inv.invoiceNumber}</div>
                        <div className="text-[11px] text-slate-500 mt-0.5 flex items-center gap-1">
                          <Calendar className="w-3 h-3" />
                          <span>Issued: {inv.invoiceDate}</span>
                        </div>
                        <div className="text-[11px] text-slate-500">Due: {inv.dueDate}</div>
                      </td>

                      <td className="py-3 px-4 align-top">
                        <div className="font-semibold text-slate-900">{inv.vendorName}</div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          {inv.vendorCode ? `${inv.vendorCode} • ` : ''}
                          {inv.vendorState || 'State N/A'}
                        </div>
                        <div className="text-[11px] font-mono text-slate-500">
                          GSTIN: {inv.vendorGst || 'Unregistered'}
                        </div>
                        {inv.bankAccountName && (
                          <div className="text-[11px] text-slate-500 flex items-center gap-1 mt-0.5">
                            <Landmark className="w-3 h-3 text-amber-600 shrink-0" />
                            <span className="truncate max-w-[180px]">{inv.bankAccountName}</span>
                          </div>
                        )}
                      </td>

                      <td className="py-3 px-4 align-top">
                        <div className="font-medium text-slate-800">
                          {inv.supplyType === 'INTER_STATE'
                            ? 'Inter-State (IGST)'
                            : 'Intra-State (CGST+SGST)'}
                        </div>
                        <div className="text-[11px] text-slate-500 font-mono mt-0.5 tabular-nums">
                          {inv.supplyType === 'INTER_STATE'
                            ? `IGST: ${fmtCurrency(inv.igstAmount)}`
                            : `CGST ${fmtCurrency(inv.cgstAmount)} + SGST ${fmtCurrency(inv.sgstAmount)}`}
                        </div>
                        <div className="text-[11px] text-slate-400">
                          {inv.items?.length || 0} line item(s)
                        </div>
                      </td>

                      <td className="py-3 px-4 text-right align-top font-mono tabular-nums text-slate-700">
                        <div>{fmtCurrency(inv.subtotal)}</div>
                        {Number(inv.discountAmount || 0) > 0 && (
                          <div className="text-[11px] text-emerald-700">
                            Disc: -{fmtCurrency(inv.discountAmount)}
                          </div>
                        )}
                      </td>

                      <td className="py-3 px-4 text-right align-top font-mono tabular-nums">
                        <div className="font-bold text-slate-900">{fmtCurrency(inv.totalAmount)}</div>
                        <div className="text-[11px] text-slate-500">
                          Net Paid: {fmtCurrency(netPaid)}
                        </div>
                        {returned > 0 && (
                          <div className="text-[11px] text-amber-700">
                            Returned: -{fmtCurrency(returned)}
                          </div>
                        )}
                        {refunded > 0 && (
                          <div className="text-[11px] text-sky-700">
                            Refunded: {fmtCurrency(refunded)}
                          </div>
                        )}
                        {balance > 0.01 && (
                          <div className="text-[11px] font-semibold text-rose-700">
                            Bal: {fmtCurrency(balance)}
                          </div>
                        )}
                      </td>

                      <td className="py-3 px-4 align-top">
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-semibold ${statusMeta.className}`}
                        >
                          {statusMeta.icon}
                          <span>{statusMeta.label}</span>
                        </span>
                      </td>

                      <td className="py-3 px-4 align-top text-right">
                        <div className="inline-flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => setViewingInvoiceId(inv.id)}
                            title="View Invoice"
                            className="p-1.5 rounded-md border border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-100 cursor-pointer"
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => openEditModal(inv)}
                            title="Edit Invoice"
                            className="p-1.5 rounded-md border border-slate-200 text-slate-600 hover:text-amber-700 hover:bg-amber-50 cursor-pointer"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                          {balance > 0.01 && effective !== 'DRAFT' && (
                            <button
                              type="button"
                              onClick={() => openPaymentModal(inv)}
                              title="Record Payment"
                              className="p-1.5 rounded-md border border-emerald-200 text-emerald-700 hover:bg-emerald-50 cursor-pointer"
                            >
                              <CreditCard className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => handlePrintInvoice(inv)}
                            title="Print Invoice"
                            className="p-1.5 rounded-md border border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-100 cursor-pointer"
                          >
                            <Printer className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => downloadVendorSalesInvoicePdf(inv, settings)}
                            title="Download PDF"
                            className="p-1.5 rounded-md border border-slate-200 text-slate-600 hover:text-blue-700 hover:bg-blue-50 cursor-pointer"
                          >
                            <Download className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(inv)}
                            title="Delete Invoice"
                            className="p-1.5 rounded-md border border-slate-200 text-slate-400 hover:text-rose-600 hover:bg-rose-50 cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal: Create / Edit Vendor Sales Invoice */}
      {isEditorOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-start justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-5xl w-full my-6 border border-slate-200 shadow-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  {editingInvoiceId ? 'Edit Vendor Sales Invoice' : 'Create Vendor Sales Invoice'}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Select a registered MySQL vendor, add goods/services, and auto-compute Intra/Inter-State GST.
                </p>
              </div>
              <button
                type="button"
                disabled={isSaving}
                onClick={() => setIsEditorOpen(false)}
                className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveInvoice} className="p-6 space-y-5">
              {editorError && (
                <div className="bg-rose-50 border border-rose-200 rounded-xl px-4 py-2.5 text-xs text-rose-800 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                  <span>{editorError}</span>
                </div>
              )}

              {/* Invoice Metadata Row */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Invoice Number *
                  </label>
                  <input
                    type="text"
                    required
                    value={formInvoiceNumber}
                    onChange={e => setFormInvoiceNumber(e.target.value)}
                    placeholder="VSI-2026-001"
                    className="w-full px-3 py-2 text-xs font-mono font-bold bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Invoice Date *
                  </label>
                  <input
                    type="date"
                    required
                    value={formInvoiceDate}
                    onChange={e => setFormInvoiceDate(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Due Date *
                  </label>
                  <input
                    type="date"
                    required
                    value={formDueDate}
                    onChange={e => setFormDueDate(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Payment Terms
                  </label>
                  <input
                    type="text"
                    value={formPaymentTerms}
                    onChange={e => setFormPaymentTerms(e.target.value)}
                    placeholder="Net 15 Days"
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Invoice Mode
                  </label>
                  <select
                    value={formStatus}
                    onChange={e => setFormStatus(e.target.value as VendorSalesInvoiceStatus)}
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400"
                  >
                    <option value="ISSUED">Issued (Final)</option>
                    <option value="DRAFT">Draft (Unbilled)</option>
                  </select>
                </div>
              </div>

              {/* Vendor Selector + Auto-Populated Vendor Card */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
                <div className="lg:col-span-5 space-y-2">
                  <label className="block text-xs font-bold text-slate-700">
                    Select Vendor (MySQL Vendor Master) *
                  </label>
                  <select
                    required
                    value={formVendorId}
                    onChange={e => handleSelectVendor(e.target.value)}
                    className="w-full px-3 py-2.5 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400"
                  >
                    <option value="">-- Choose Registered Vendor --</option>
                    {vendors.map(v => (
                      <option key={v.id} value={v.id}>
                        {v.name} ({v.vendorCode}) — {v.state || 'State N/A'}
                      </option>
                    ))}
                  </select>

                  <div className="bg-amber-50/70 border border-amber-200 rounded-lg p-3 text-xs space-y-1">
                    <div className="font-bold text-amber-900 flex items-center justify-between">
                      <span>GST Jurisdiction Determination</span>
                      <span className="font-mono text-[11px]">
                        {supplyInfo.supplyType === 'INTER_STATE' ? 'IGST' : 'CGST + SGST'}
                      </span>
                    </div>
                    <div className="text-[11px] text-amber-800">
                      Supplier ({supplyInfo.companyStateName}) &rarr; Vendor (
                      {selectedVendor
                        ? supplyInfo.vendorStateName || selectedVendor.state || 'Unspecified'
                        : 'Select Vendor'}
                      )
                    </div>
                  </div>
                </div>

                <div className="lg:col-span-7 bg-slate-50 border border-slate-200 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                      <Building2 className="w-3.5 h-3.5 text-slate-400" />
                      Auto-Populated Vendor Billing Profile
                    </span>
                    {selectedVendor && (
                      <span className="text-[11px] font-mono font-bold text-slate-700">
                        {selectedVendor.vendorCode}
                      </span>
                    )}
                  </div>
                  {selectedVendor ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                      <div>
                        <span className="text-slate-400">Name:</span>{' '}
                        <span className="font-bold text-slate-900">{selectedVendor.name}</span>
                      </div>
                      <div>
                        <span className="text-slate-400">GSTIN:</span>{' '}
                        <span className="font-mono font-semibold text-slate-800">
                          {selectedVendor.gstNumber || 'Unregistered'}
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-400">State:</span>{' '}
                        <span className="font-semibold text-slate-800">
                          {supplyInfo.vendorStateName || selectedVendor.state || 'N/A'}
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-400">Contact:</span>{' '}
                        <span className="text-slate-800">
                          {selectedVendor.contactPerson || '-'}{' '}
                          {selectedVendor.phone ? `(${selectedVendor.phone})` : ''}
                        </span>
                      </div>
                      <div className="sm:col-span-2">
                        <span className="text-slate-400">Billing Address:</span>{' '}
                        <span className="text-slate-700">
                          {[selectedVendor.address, selectedVendor.city, selectedVendor.state]
                            .filter(Boolean)
                            .join(', ') || 'No address on file'}
                        </span>
                      </div>
                      {selectedVendor.email && (
                        <div className="sm:col-span-2">
                          <span className="text-slate-400">Email:</span>{' '}
                          <span className="text-slate-700">{selectedVendor.email}</span>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-slate-500 py-3">
                      Choose a vendor from the dropdown to populate billing address, GSTIN, state code, and contact details automatically.
                    </p>
                  )}
                </div>
              </div>

              {/* Line Item Builder */}
              <div className="border border-slate-200 rounded-xl p-4 space-y-3 bg-slate-50/60">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <span className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                    <Package className="w-4 h-4 text-amber-600" />
                    Add Product / Service Line Item
                  </span>
                  <span className="text-[11px] text-slate-500">
                    Quick-fill from Master Product Catalog or enter custom service description
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-end">
                  <div className="sm:col-span-4">
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                      Catalog Product (Optional)
                    </label>
                    <select
                      value={draftProductId}
                      onChange={e => handleDraftProductChange(e.target.value)}
                      className="w-full px-2.5 py-2 text-xs bg-white border border-slate-300 rounded-lg"
                    >
                      <option value="">-- Custom Service / Manual Item --</option>
                      {products.map(p => (
                        <option key={p.id} value={p.id}>
                          {p.name} ({p.sku}) — ₹{(p.sellingPrice || p.unitPrice || 0).toLocaleString('en-IN')}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="sm:col-span-5">
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                      Description *
                    </label>
                    <input
                      type="text"
                      value={draftDesc}
                      onChange={e => setDraftDesc(e.target.value)}
                      placeholder="Goods or service description"
                      className="w-full px-2.5 py-2 text-xs bg-white border border-slate-300 rounded-lg"
                    />
                  </div>

                  <div className="sm:col-span-3">
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                      HSN / SAC Code
                    </label>
                    <input
                      type="text"
                      value={draftHsn}
                      onChange={e => setDraftHsn(e.target.value)}
                      placeholder="85414011"
                      className="w-full px-2.5 py-2 text-xs font-mono bg-white border border-slate-300 rounded-lg"
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                      Qty *
                    </label>
                    <input
                      type="number"
                      min={0.01}
                      step="any"
                      value={draftQty}
                      onChange={e => setDraftQty(Number(e.target.value))}
                      className="w-full px-2.5 py-2 text-xs font-mono bg-white border border-slate-300 rounded-lg"
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                      Unit
                    </label>
                    <input
                      type="text"
                      value={draftUnit}
                      onChange={e => setDraftUnit(e.target.value)}
                      placeholder="NOS"
                      className="w-full px-2.5 py-2 text-xs bg-white border border-slate-300 rounded-lg"
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                      Rate (₹) *
                    </label>
                    <input
                      type="number"
                      min={0}
                      step="any"
                      value={draftRate}
                      onChange={e => setDraftRate(Number(e.target.value))}
                      className="w-full px-2.5 py-2 text-xs font-mono bg-white border border-slate-300 rounded-lg"
                    />
                  </div>

                  <div className="sm:col-span-3">
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                      Discount
                    </label>
                    <div className="flex">
                      <select
                        value={draftDiscountType}
                        onChange={e =>
                          setDraftDiscountType(e.target.value as VendorSalesDiscountType)
                        }
                        className="px-2 py-2 text-xs bg-slate-100 border border-r-0 border-slate-300 rounded-l-lg"
                      >
                        <option value="PERCENT">%</option>
                        <option value="FLAT">₹</option>
                      </select>
                      <input
                        type="number"
                        min={0}
                        step="any"
                        value={draftDiscountVal}
                        onChange={e => setDraftDiscountVal(Number(e.target.value))}
                        className="w-full px-2.5 py-2 text-xs font-mono bg-white border border-slate-300 rounded-r-lg"
                      />
                    </div>
                  </div>

                  <div className="sm:col-span-3">
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                      GST Rate (%)
                    </label>
                    <div className="flex gap-1.5">
                      <select
                        value={draftCustomGst ? 'CUSTOM' : String(draftGstRate)}
                        onChange={e => {
                          if (e.target.value === 'CUSTOM') {
                            setDraftCustomGst(true);
                          } else {
                            setDraftCustomGst(false);
                            setDraftGstRate(Number(e.target.value));
                          }
                        }}
                        className="w-full px-2.5 py-2 text-xs bg-white border border-slate-300 rounded-lg"
                      >
                        {STANDARD_GST_RATES.map(r => (
                          <option key={r} value={String(r)}>
                            {r}%
                          </option>
                        ))}
                        <option value="CUSTOM">Custom %</option>
                      </select>
                      {draftCustomGst && (
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step="0.01"
                          value={draftGstRate}
                          onChange={e => setDraftGstRate(Number(e.target.value))}
                          className="w-20 px-2 py-2 text-xs font-mono bg-white border border-slate-300 rounded-lg"
                        />
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-200/80 text-[11px] text-slate-600">
                  <div className="font-mono tabular-nums">
                    Line Preview: Taxable {fmtCurrency(draftPreview.taxableAmount)} + Tax{' '}
                    {fmtCurrency(draftPreview.taxAmount)} ={' '}
                    <strong className="text-slate-900">{fmtCurrency(draftPreview.totalAmount)}</strong>
                  </div>
                  <button
                    type="button"
                    onClick={handleAddDraftItem}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Line Item</span>
                  </button>
                </div>
              </div>

              {/* Line Items Table */}
              <div className="border border-slate-200 rounded-xl overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-100 text-slate-700 font-semibold">
                    <tr>
                      <th className="p-2.5">#</th>
                      <th className="p-2.5 min-w-[200px]">Description</th>
                      <th className="p-2.5">HSN/SAC</th>
                      <th className="p-2.5 w-20">Qty</th>
                      <th className="p-2.5 w-20">Unit</th>
                      <th className="p-2.5 w-28 text-right">Rate (₹)</th>
                      <th className="p-2.5 w-28">Discount</th>
                      <th className="p-2.5 w-20 text-center">GST %</th>
                      <th className="p-2.5 text-right">Taxable</th>
                      <th className="p-2.5 text-right">
                        {supplyInfo.supplyType === 'INTER_STATE' ? 'IGST' : 'CGST + SGST'}
                      </th>
                      <th className="p-2.5 text-right">Total</th>
                      <th className="p-2.5 text-center">Del</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {formItems.length === 0 ? (
                      <tr>
                        <td colSpan={12} className="p-6 text-center text-slate-400">
                          No line items added yet. Use the form above to add goods or services.
                        </td>
                      </tr>
                    ) : (
                      formItems.map((draft, idx) => {
                        const computed: VendorSalesLineItem =
                          liveTotals.items[idx] ||
                          computeVendorSalesLineItem(draft, supplyInfo.supplyType);
                        return (
                          <tr key={draft.id} className="align-middle">
                            <td className="p-2 text-slate-500 font-mono">{idx + 1}</td>
                            <td className="p-2">
                              <input
                                type="text"
                                value={draft.description}
                                onChange={e =>
                                  handleUpdateLineItem(idx, { description: e.target.value })
                                }
                                className="w-full px-2 py-1 text-xs border border-slate-200 rounded"
                              />
                            </td>
                            <td className="p-2">
                              <input
                                type="text"
                                value={draft.hsnCode}
                                onChange={e =>
                                  handleUpdateLineItem(idx, { hsnCode: e.target.value })
                                }
                                className="w-20 px-2 py-1 text-xs font-mono border border-slate-200 rounded"
                              />
                            </td>
                            <td className="p-2">
                              <input
                                type="number"
                                min={0.01}
                                step="any"
                                value={draft.quantity}
                                onChange={e =>
                                  handleUpdateLineItem(idx, { quantity: Number(e.target.value) })
                                }
                                className="w-16 px-2 py-1 text-xs font-mono border border-slate-200 rounded text-right"
                              />
                            </td>
                            <td className="p-2">
                              <input
                                type="text"
                                value={draft.unit}
                                onChange={e => handleUpdateLineItem(idx, { unit: e.target.value })}
                                className="w-16 px-2 py-1 text-xs border border-slate-200 rounded"
                              />
                            </td>
                            <td className="p-2">
                              <input
                                type="number"
                                min={0}
                                step="any"
                                value={draft.rate}
                                onChange={e =>
                                  handleUpdateLineItem(idx, { rate: Number(e.target.value) })
                                }
                                className="w-24 px-2 py-1 text-xs font-mono border border-slate-200 rounded text-right"
                              />
                            </td>
                            <td className="p-2">
                              <div className="flex items-center gap-1">
                                <select
                                  value={draft.discountType}
                                  onChange={e =>
                                    handleUpdateLineItem(idx, {
                                      discountType: e.target.value as VendorSalesDiscountType
                                    })
                                  }
                                  className="px-1 py-1 text-[11px] border border-slate-200 rounded bg-slate-50"
                                >
                                  <option value="PERCENT">%</option>
                                  <option value="FLAT">₹</option>
                                </select>
                                <input
                                  type="number"
                                  min={0}
                                  step="any"
                                  value={draft.discountValue}
                                  onChange={e =>
                                    handleUpdateLineItem(idx, {
                                      discountValue: Number(e.target.value)
                                    })
                                  }
                                  className="w-14 px-1.5 py-1 text-xs font-mono border border-slate-200 rounded text-right"
                                />
                              </div>
                            </td>
                            <td className="p-2">
                              <input
                                type="number"
                                min={0}
                                max={100}
                                step="0.01"
                                value={draft.gstRate}
                                onChange={e =>
                                  handleUpdateLineItem(idx, { gstRate: Number(e.target.value) })
                                }
                                className="w-16 px-2 py-1 text-xs font-mono border border-slate-200 rounded text-center"
                              />
                            </td>
                            <td className="p-2 text-right font-mono tabular-nums text-slate-700">
                              {fmtCurrency(computed.taxableAmount)}
                            </td>
                            <td className="p-2 text-right font-mono tabular-nums text-slate-700">
                              {supplyInfo.supplyType === 'INTER_STATE'
                                ? fmtCurrency(computed.igstAmount)
                                : `${fmtCurrency(computed.cgstAmount)} + ${fmtCurrency(computed.sgstAmount)}`}
                            </td>
                            <td className="p-2 text-right font-mono tabular-nums font-bold text-slate-900">
                              {fmtCurrency(computed.totalAmount)}
                            </td>
                            <td className="p-2 text-center">
                              <button
                                type="button"
                                onClick={() => handleRemoveLineItem(idx)}
                                className="p-1 text-slate-400 hover:text-rose-600 cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {/* Bottom Notes + Calculated GST Summary */}
              <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-start">
                <div className="md:col-span-7 space-y-2">
                  <label className="block text-xs font-bold text-slate-700">
                    Invoice Notes &amp; Payment Instructions
                  </label>
                  <textarea
                    rows={4}
                    value={formNotes}
                    onChange={e => setFormNotes(e.target.value)}
                    placeholder="Bank NEFT details, delivery terms, PO/reference notes..."
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-amber-400"
                  />
                  {liveTotals.totalAmount > 0 && (
                    <div className="text-[11px] text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                      <strong>Amount in Words:</strong> INR{' '}
                      {numberToIndianWords(Math.round(liveTotals.totalAmount))}
                    </div>
                  )}
                </div>

                <div className="md:col-span-5 bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-1.5 text-xs font-mono tabular-nums">
                  <div className="flex justify-between text-slate-600 font-sans">
                    <span>Gross Amount:</span>
                    <span className="font-mono">{fmtCurrency(liveTotals.grossAmount)}</span>
                  </div>
                  <div className="flex justify-between text-emerald-700 font-sans">
                    <span>Discount Total:</span>
                    <span className="font-mono">- {fmtCurrency(liveTotals.discountAmount)}</span>
                  </div>
                  <div className="flex justify-between font-semibold text-slate-800 pt-1 border-t border-slate-200 font-sans">
                    <span>Taxable Value:</span>
                    <span className="font-mono">{fmtCurrency(liveTotals.subtotal)}</span>
                  </div>
                  {supplyInfo.supplyType === 'INTER_STATE' ? (
                    <div className="flex justify-between text-slate-700 font-sans">
                      <span>IGST Total:</span>
                      <span className="font-mono">{fmtCurrency(liveTotals.igstAmount)}</span>
                    </div>
                  ) : (
                    <>
                      <div className="flex justify-between text-slate-700 font-sans">
                        <span>CGST Total:</span>
                        <span className="font-mono">{fmtCurrency(liveTotals.cgstAmount)}</span>
                      </div>
                      <div className="flex justify-between text-slate-700 font-sans">
                        <span>SGST Total:</span>
                        <span className="font-mono">{fmtCurrency(liveTotals.sgstAmount)}</span>
                      </div>
                    </>
                  )}
                  <div className="flex justify-between text-slate-700 font-sans">
                    <span>Total GST:</span>
                    <span className="font-mono">{fmtCurrency(liveTotals.taxAmount)}</span>
                  </div>
                  <div className="flex justify-between text-sm font-bold text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-2 mt-2 font-sans">
                    <span>Grand Total:</span>
                    <span className="font-mono">{fmtCurrency(liveTotals.totalAmount)}</span>
                  </div>
                </div>
              </div>

              {/* Bank Account & Settlement Section (Create + Edit) */}
              <div className="bg-amber-50/70 border border-amber-200 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <span className="text-xs font-bold text-amber-950 flex items-center gap-1.5">
                    <Landmark className="w-4 h-4 text-amber-600" />
                    <span>
                      {editingInvoiceId || formStatus === 'DRAFT'
                        ? 'Settlement Cash / Bank Account'
                        : 'Bank Account & Upfront Settlement (Optional)'}
                    </span>
                  </span>
                  {!editingInvoiceId && formStatus !== 'DRAFT' && (
                    <div className="flex items-center gap-1.5">
                      {(['UNPAID', 'PARTIAL', 'PAID'] as const).map(opt => (
                        <button
                          key={opt}
                          type="button"
                          onClick={() => {
                            setFormInitialSettlement(opt);
                            if (opt === 'PAID') setFormInitialPaidAmount(liveTotals.totalAmount);
                            else if (opt === 'PARTIAL' && formInitialPaidAmount <= 0) setFormInitialPaidAmount(roundCurrency(liveTotals.totalAmount * 0.5));
                            else if (opt === 'UNPAID') setFormInitialPaidAmount(0);
                          }}
                          className={`px-2.5 py-1 rounded-lg text-[11px] font-bold cursor-pointer ${
                            formInitialSettlement === opt
                              ? 'bg-amber-600 text-white'
                              : 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-50'
                          }`}
                        >
                          {opt === 'UNPAID' ? 'Credit / Unpaid' : opt === 'PARTIAL' ? 'Partial Receipt' : 'Fully Paid'}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-[11px] font-bold text-slate-700 mb-1">
                      {!editingInvoiceId && formStatus !== 'DRAFT' && formInitialSettlement !== 'UNPAID'
                        ? 'Deposit Into Cash / Bank Account *'
                        : 'Transaction / Deposit Bank Account'}
                    </label>
                    <select
                      required={!editingInvoiceId && formStatus !== 'DRAFT' && formInitialSettlement !== 'UNPAID' && activeBankAccounts.length > 0}
                      value={formBankAccountId}
                      onChange={e => setFormBankAccountId(e.target.value)}
                      className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg"
                    >
                      <option value="">
                        {activeBankAccounts.length === 0 ? 'Default Cash / Bank Ledger' : '-- Select Cash / Bank Account --'}
                      </option>
                      {activeBankAccounts.map(acc => (
                        <option key={acc.id} value={acc.id}>
                          {acc.accountName} ({acc.accountType}) — Bal: {fmtCurrency(acc.currentBalance)}
                        </option>
                      ))}
                    </select>
                  </div>

                  {!editingInvoiceId && formStatus !== 'DRAFT' && formInitialSettlement !== 'UNPAID' && (
                    <>
                      <div>
                        <label className="block text-[11px] font-bold text-slate-700 mb-1">
                          {formInitialSettlement === 'PAID' ? 'Full Payment (₹)' : 'Partial Amount (₹) *'}
                        </label>
                        <input
                          type="number"
                          min={0.01}
                          max={Math.max(0.01, liveTotals.totalAmount)}
                          step="0.01"
                          disabled={formInitialSettlement === 'PAID'}
                          required
                          value={formInitialSettlement === 'PAID' ? liveTotals.totalAmount : formInitialPaidAmount}
                          onChange={e => setFormInitialPaidAmount(Number(e.target.value))}
                          className="w-full px-3 py-2 text-xs font-mono font-bold bg-white border border-slate-300 rounded-lg disabled:bg-slate-100"
                        />
                      </div>

                      <div>
                        <label className="block text-[11px] font-bold text-slate-700 mb-1">
                          Payment Mode
                        </label>
                        <select
                          value={formPaymentMode}
                          onChange={e => setFormPaymentMode(e.target.value)}
                          className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg"
                        >
                          <option value="Bank NEFT / RTGS">Bank NEFT / RTGS</option>
                          <option value="UPI">UPI</option>
                          <option value="Cheque">Cheque</option>
                          <option value="Cash">Cash</option>
                        </select>
                      </div>
                    </>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-200">
                <button
                  type="button"
                  disabled={isSaving}
                  onClick={() => setIsEditorOpen(false)}
                  className="px-4 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold cursor-pointer disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="inline-flex items-center gap-1.5 px-5 py-2 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold cursor-pointer disabled:opacity-60"
                >
                  {isSaving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  <span>
                    {isSaving
                      ? 'Saving to MySQL...'
                      : editingInvoiceId
                      ? 'Update Vendor Invoice'
                      : 'Save Vendor Invoice'}
                  </span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: View GST Tax Invoice + Payment History */}
      {viewingInvoice && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-start justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-4xl w-full my-6 border border-slate-200 shadow-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 bg-slate-50">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-mono font-bold text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-900">
                    {viewingInvoice.invoiceNumber}
                  </span>
                  {(() => {
                    const meta = getStatusMeta(getEffectiveStatus(viewingInvoice));
                    return (
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-semibold ${meta.className}`}
                      >
                        {meta.icon}
                        <span>{meta.label}</span>
                      </span>
                    );
                  })()}
                </div>
                <h3 className="text-base font-bold text-slate-900 mt-1">
                  Vendor Sales Tax Invoice
                </h3>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const inv = viewingInvoice;
                    setViewingInvoiceId(null);
                    openEditModal(inv);
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 text-xs font-semibold text-slate-700 cursor-pointer"
                >
                  <Edit3 className="w-3.5 h-3.5" />
                  <span>Edit</span>
                </button>
                {computeVsiBalances(viewingInvoice).balance > 0.01 &&
                  getEffectiveStatus(viewingInvoice) !== 'DRAFT' && (
                    <button
                      type="button"
                      onClick={() => openPaymentModal(viewingInvoice)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold cursor-pointer"
                    >
                      <CreditCard className="w-3.5 h-3.5" />
                      <span>Record Payment</span>
                    </button>
                  )}
                <button
                  type="button"
                  onClick={() => triggerSafeWindowPrint(settings.logoUrl ? [settings.logoUrl] : [])}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-900 text-white text-xs font-semibold cursor-pointer"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>Print</span>
                </button>
                <button
                  type="button"
                  onClick={() => downloadVendorSalesInvoicePdf(viewingInvoice, settings)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download PDF</span>
                </button>
                <button
                  type="button"
                  onClick={() => setViewingInvoiceId(null)}
                  className="p-1.5 text-slate-400 hover:text-slate-700 cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="p-6 space-y-5 text-xs">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-1">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    Vendor (Billed To)
                  </span>
                  <div className="text-sm font-bold text-slate-900">
                    {viewingInvoice.vendorName}{' '}
                    {viewingInvoice.vendorCode ? `(${viewingInvoice.vendorCode})` : ''}
                  </div>
                  <div className="font-mono text-slate-700">
                    GSTIN: {viewingInvoice.vendorGst || 'Unregistered'}
                  </div>
                  <div className="text-slate-600">
                    {[viewingInvoice.vendorAddress, viewingInvoice.vendorCity, viewingInvoice.vendorState]
                      .filter(Boolean)
                      .join(', ') || 'No address on file'}
                  </div>
                  {(viewingInvoice.vendorContactPerson || viewingInvoice.vendorPhone) && (
                    <div className="text-slate-600">
                      Contact: {viewingInvoice.vendorContactPerson || '-'}{' '}
                      {viewingInvoice.vendorPhone ? `• ${viewingInvoice.vendorPhone}` : ''}
                    </div>
                  )}
                </div>

                <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-1.5">
                  <div className="flex justify-between">
                    <span className="text-slate-500">Invoice Date:</span>
                    <span className="font-semibold text-slate-900">{viewingInvoice.invoiceDate}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Due Date:</span>
                    <span className="font-semibold text-slate-900">{viewingInvoice.dueDate}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Payment Terms:</span>
                    <span className="font-semibold text-slate-900">{viewingInvoice.paymentTerms}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Supply / GST Type:</span>
                    <span className="font-semibold text-slate-900">
                      {viewingInvoice.supplyType === 'INTER_STATE'
                        ? 'Inter-State (IGST)'
                        : 'Intra-State (CGST + SGST)'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Place of Supply:</span>
                    <span className="font-semibold text-slate-900">
                      {viewingInvoice.vendorState || 'N/A'}
                    </span>
                  </div>
                  {viewingInvoice.bankAccountName && (
                    <div className="flex justify-between">
                      <span className="text-slate-500">Bank Account:</span>
                      <span className="font-semibold text-slate-900">
                        {viewingInvoice.bankAccountName}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              <div className="border border-slate-200 rounded-xl overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-100 text-slate-700 font-semibold">
                    <tr>
                      <th className="p-2.5">#</th>
                      <th className="p-2.5">Description</th>
                      <th className="p-2.5 text-center">HSN/SAC</th>
                      <th className="p-2.5 text-center">Qty</th>
                      <th className="p-2.5 text-right">Rate</th>
                      <th className="p-2.5 text-right">Discount</th>
                      <th className="p-2.5 text-right">Taxable</th>
                      {viewingInvoice.supplyType === 'INTER_STATE' ? (
                        <th className="p-2.5 text-right">IGST</th>
                      ) : (
                        <>
                          <th className="p-2.5 text-right">CGST</th>
                          <th className="p-2.5 text-right">SGST</th>
                        </>
                      )}
                      <th className="p-2.5 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {(viewingInvoice.items || []).map((item, idx) => (
                      <tr key={item.id || idx}>
                        <td className="p-2.5 font-mono text-slate-500">{idx + 1}</td>
                        <td className="p-2.5 font-medium text-slate-900">{item.description}</td>
                        <td className="p-2.5 text-center font-mono text-slate-600">
                          {item.hsnCode || '-'}
                        </td>
                        <td className="p-2.5 text-center font-mono">
                          {item.quantity} {item.unit}
                        </td>
                        <td className="p-2.5 text-right font-mono tabular-nums">
                          {fmtCurrency(item.rate)}
                        </td>
                        <td className="p-2.5 text-right font-mono tabular-nums text-emerald-700">
                          {item.discountAmount > 0 ? `-${fmtCurrency(item.discountAmount)}` : '—'}
                        </td>
                        <td className="p-2.5 text-right font-mono tabular-nums">
                          {fmtCurrency(item.taxableAmount)}
                        </td>
                        {viewingInvoice.supplyType === 'INTER_STATE' ? (
                          <td className="p-2.5 text-right font-mono tabular-nums">
                            {fmtCurrency(item.igstAmount)} ({item.igstRate}%)
                          </td>
                        ) : (
                          <>
                            <td className="p-2.5 text-right font-mono tabular-nums">
                              {fmtCurrency(item.cgstAmount)} ({item.cgstRate}%)
                            </td>
                            <td className="p-2.5 text-right font-mono tabular-nums">
                              {fmtCurrency(item.sgstAmount)} ({item.sgstRate}%)
                            </td>
                          </>
                        )}
                        <td className="p-2.5 text-right font-mono tabular-nums font-bold text-slate-900">
                          {fmtCurrency(item.totalAmount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-start">
                <div className="md:col-span-7 space-y-3">
                  <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                    <div className="text-[10px] font-bold uppercase text-slate-400">
                      Amount Chargeable (in words)
                    </div>
                    <div className="font-bold text-slate-900 mt-1">
                      INR {numberToIndianWords(Math.round(viewingInvoice.totalAmount || 0))}
                    </div>
                    {viewingInvoice.notes && (
                      <div className="text-slate-600 mt-2 pt-2 border-t border-slate-200">
                        <strong>Notes:</strong> {viewingInvoice.notes}
                      </div>
                    )}
                  </div>

                  {/* Payment Ledger */}
                  <div className="border border-slate-200 rounded-xl overflow-hidden">
                    <div className="px-3 py-2 bg-slate-100 font-bold text-slate-700 flex items-center justify-between">
                      <span>Payment History</span>
                      <span>{viewingInvoice.payments?.length || 0} record(s)</span>
                    </div>
                    {!viewingInvoice.payments || viewingInvoice.payments.length === 0 ? (
                      <div className="p-3 text-slate-500">No payments recorded yet.</div>
                    ) : (
                      <table className="w-full text-left text-[11px]">
                        <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                          <tr>
                            <th className="p-2">Date</th>
                            <th className="p-2">Mode / Account</th>
                            <th className="p-2">Reference</th>
                            <th className="p-2 text-right">Amount</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {viewingInvoice.payments.map(p => (
                            <tr key={p.id}>
                              <td className="p-2">{p.paymentDate}</td>
                              <td className="p-2">
                                <div>{p.paymentMode}</div>
                                {p.bankAccountName && (
                                  <div className="text-[10px] text-slate-500">{p.bankAccountName}</div>
                                )}
                              </td>
                              <td className="p-2 font-mono">{p.referenceNo || '-'}</td>
                              <td className="p-2 text-right font-mono font-bold text-emerald-700">
                                {fmtCurrency(p.amount)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>

                <div className="md:col-span-5 bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-1.5">
                  <div className="flex justify-between">
                    <span className="text-slate-600">Gross Amount:</span>
                    <span className="font-mono tabular-nums">
                      {fmtCurrency(viewingInvoice.grossAmount)}
                    </span>
                  </div>
                  <div className="flex justify-between text-emerald-700">
                    <span>Discount Total:</span>
                    <span className="font-mono tabular-nums">
                      - {fmtCurrency(viewingInvoice.discountAmount)}
                    </span>
                  </div>
                  <div className="flex justify-between font-semibold text-slate-800 pt-1 border-t border-slate-200">
                    <span>Taxable Amount:</span>
                    <span className="font-mono tabular-nums">
                      {fmtCurrency(viewingInvoice.subtotal)}
                    </span>
                  </div>
                  {viewingInvoice.supplyType === 'INTER_STATE' ? (
                    <div className="flex justify-between">
                      <span className="text-slate-600">IGST:</span>
                      <span className="font-mono tabular-nums">
                        {fmtCurrency(viewingInvoice.igstAmount)}
                      </span>
                    </div>
                  ) : (
                    <>
                      <div className="flex justify-between">
                        <span className="text-slate-600">CGST:</span>
                        <span className="font-mono tabular-nums">
                          {fmtCurrency(viewingInvoice.cgstAmount)}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-600">SGST:</span>
                        <span className="font-mono tabular-nums">
                          {fmtCurrency(viewingInvoice.sgstAmount)}
                        </span>
                      </div>
                    </>
                  )}
                  <div className="flex justify-between text-sm font-bold text-slate-900 pt-1.5 border-t border-slate-300">
                    <span>Grand Total:</span>
                    <span className="font-mono tabular-nums text-amber-800">
                      {fmtCurrency(viewingInvoice.totalAmount)}
                    </span>
                  </div>
                  {computeVsiBalances(viewingInvoice).returned > 0 && (
                    <div className="flex justify-between text-amber-700">
                      <span>Sales Return (Credit Note):</span>
                      <span className="font-mono tabular-nums">
                        - {fmtCurrency(computeVsiBalances(viewingInvoice).returned)}
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between text-emerald-700 pt-1">
                    <span>Paid Amount:</span>
                    <span className="font-mono tabular-nums">
                      {fmtCurrency(viewingInvoice.paidAmount)}
                    </span>
                  </div>
                  {computeVsiBalances(viewingInvoice).refunded > 0 && (
                    <div className="flex justify-between text-sky-700">
                      <span>Refunded via Bank:</span>
                      <span className="font-mono tabular-nums">
                        - {fmtCurrency(computeVsiBalances(viewingInvoice).refunded)}
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between font-bold text-rose-700">
                    <span>Balance Due:</span>
                    <span className="font-mono tabular-nums">
                      {fmtCurrency(computeVsiBalances(viewingInvoice).balance)}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Record Vendor Payment */}
      {paymentInvoice && (() => {
        const payBal = computeVsiBalances(paymentInvoice);
        return (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full border border-slate-200 shadow-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Record Vendor Payment</h3>
                <p className="text-[11px] text-slate-500 font-mono mt-0.5">
                  {paymentInvoice.invoiceNumber} • {paymentInvoice.vendorName}
                </p>
              </div>
              <button
                type="button"
                disabled={isRecordingPayment}
                onClick={() => setPaymentInvoiceId(null)}
                className="p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSubmitPayment} className="p-5 space-y-4 text-xs">
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 grid grid-cols-3 gap-2 text-center font-mono tabular-nums">
                <div>
                  <span className="text-[10px] font-sans text-slate-500 block">Net Billed</span>
                  <span className="font-bold text-slate-900">
                    {fmtCurrency(Math.max(0, payBal.total - payBal.returned))}
                  </span>
                </div>
                <div>
                  <span className="text-[10px] font-sans text-slate-500 block">Net Paid</span>
                  <span className="font-bold text-emerald-700">
                    {fmtCurrency(payBal.netPaid)}
                  </span>
                </div>
                <div>
                  <span className="text-[10px] font-sans text-slate-500 block">Balance Due</span>
                  <span className="font-bold text-rose-700">
                    {fmtCurrency(payBal.balance)}
                  </span>
                </div>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1 flex items-center gap-1">
                  <Landmark className="w-3.5 h-3.5 text-amber-600" />
                  <span>Deposit Cash / Bank Account *</span>
                </label>
                <select
                  required={activeBankAccounts.length > 0}
                  value={payBankAccountId}
                  onChange={e => setPayBankAccountId(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg"
                >
                  {activeBankAccounts.length === 0 && (
                    <option value="">Default Cash / Bank Ledger</option>
                  )}
                  {activeBankAccounts.map(acc => (
                    <option key={acc.id} value={acc.id}>
                      {acc.accountName} ({acc.accountType}) — Bal: {fmtCurrency(acc.currentBalance)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Payment Date *</label>
                  <input
                    type="date"
                    required
                    value={payDate}
                    onChange={e => setPayDate(e.target.value)}
                    className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="font-bold text-slate-700">Amount (₹) *</label>
                    <button
                      type="button"
                      onClick={() => setPayAmount(payBal.balance)}
                      className="text-[10px] font-semibold text-amber-700 hover:underline cursor-pointer"
                    >
                      Pay Full
                    </button>
                  </div>
                  <input
                    type="number"
                    min={0.01}
                    max={payBal.balance}
                    step="0.01"
                    required
                    value={payAmount}
                    onChange={e => setPayAmount(Number(e.target.value))}
                    className="w-full px-3 py-2 font-mono bg-white border border-slate-300 rounded-lg"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Payment Mode *</label>
                  <select
                    value={payMode}
                    onChange={e => setPayMode(e.target.value)}
                    className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg"
                  >
                    <option value="Bank NEFT / RTGS">Bank NEFT / RTGS</option>
                    <option value="UPI">UPI</option>
                    <option value="Cheque">Cheque</option>
                    <option value="Cash">Cash</option>
                    <option value="Credit Adjustment">Credit Adjustment</option>
                  </select>
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">UTR / Reference No.</label>
                  <input
                    type="text"
                    value={payReference}
                    onChange={e => setPayReference(e.target.value)}
                    placeholder="UTR / Cheque #"
                    className="w-full px-3 py-2 font-mono bg-white border border-slate-300 rounded-lg"
                  />
                </div>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">Remarks</label>
                <input
                  type="text"
                  value={payNotes}
                  onChange={e => setPayNotes(e.target.value)}
                  placeholder="Optional settlement notes"
                  className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
                <button
                  type="button"
                  disabled={isRecordingPayment}
                  onClick={() => setPaymentInvoiceId(null)}
                  className="px-4 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isRecordingPayment}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold cursor-pointer disabled:opacity-60"
                >
                  {isRecordingPayment && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  <span>Save Payment</span>
                </button>
              </div>
            </form>
          </div>
        </div>
        );
      })()}

      {/* Modal: Delete Confirmation */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full p-5 border border-slate-200 shadow-2xl space-y-4">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-xl bg-rose-50 text-rose-600 border border-rose-200 shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-slate-900">Delete Vendor Sales Invoice?</h3>
                <p className="text-xs text-slate-600 mt-1">
                  This will permanently remove{' '}
                  <strong className="font-mono">{deleteTarget.invoiceNumber}</strong> (
                  {deleteTarget.vendorName}) and its line items/payment ledger from MySQL.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                disabled={isDeleting}
                onClick={() => setDeleteTarget(null)}
                className="px-3.5 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-xs font-semibold text-slate-700 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isDeleting}
                onClick={handleConfirmDelete}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 text-xs font-bold text-white cursor-pointer disabled:opacity-60"
              >
                {isDeleting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>Delete Permanently</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Body-Level A4 Print Portal */}
      <PrintPortal active={Boolean(viewingInvoice)}>
        {viewingInvoice && (() => {
          const isInter = viewingInvoice.supplyType === 'INTER_STATE';
          const compState = resolveStateNameAndCode(
            viewingInvoice.companyState,
            settings.companyGst,
            settings.companyAddress
          );
          const vendState = resolveStateNameAndCode(
            viewingInvoice.vendorState,
            viewingInvoice.vendorGst,
            viewingInvoice.vendorAddress
          );
          return (
            <div className="bg-white p-4 border border-black w-full max-w-none mx-0 text-black text-[11px] leading-tight font-sans">
              <div className="flex items-center justify-between border-b border-black pb-2 mb-2">
                <div className="flex items-center gap-3">
                  {settings.logoUrl && (
                    <img src={settings.logoUrl} alt="Company Logo" className="h-9 object-contain" />
                  )}
                  <div>
                    <div className="font-bold text-sm">
                      {settings.companyName || 'SOLAR URJA ERP'}
                    </div>
                    <div className="text-[10px]">
                      {settings.companyAddress ||
                        'Plot No- 14, Street No- 14B, Pragati Nagar, Risali, Bhilai, Chhattisgarh 490006'}
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-bold text-sm uppercase tracking-wide">
                    Tax Invoice (Vendor Sales)
                  </div>
                  <div className="text-[10px]">Original for Recipient</div>
                </div>
              </div>

              <div className="border border-black grid grid-cols-2">
                <div className="p-2.5 border-r border-black space-y-0.5">
                  <div>
                    <strong>Supplier GSTIN:</strong> {settings.companyGst || '22AAOCR0748K1Z5'}
                  </div>
                  <div>
                    <strong>Supplier State:</strong>{' '}
                    {compState.stateName || 'Chhattisgarh'}
                    {compState.stateCode ? ` (${compState.stateCode})` : ' (22)'}
                  </div>
                  {settings.companyPhone && (
                    <div>
                      <strong>Phone:</strong> {settings.companyPhone}
                    </div>
                  )}
                  {settings.companyEmail && (
                    <div>
                      <strong>Email:</strong> {settings.companyEmail}
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 text-[10px] divide-y divide-black">
                  <div className="p-1.5 border-r border-black">
                    <span className="text-slate-600 block">Invoice No.</span>
                    <span className="font-bold font-mono">{viewingInvoice.invoiceNumber}</span>
                  </div>
                  <div className="p-1.5">
                    <span className="text-slate-600 block">Invoice Date</span>
                    <span className="font-bold">{viewingInvoice.invoiceDate}</span>
                  </div>
                  <div className="p-1.5 border-r border-black">
                    <span className="text-slate-600 block">Due Date</span>
                    <span className="font-bold">{viewingInvoice.dueDate}</span>
                  </div>
                  <div className="p-1.5">
                    <span className="text-slate-600 block">Payment Terms</span>
                    <span>{viewingInvoice.paymentTerms || 'Net 15 Days'}</span>
                  </div>
                  <div className="p-1.5 border-r border-black">
                    <span className="text-slate-600 block">Supply Type</span>
                    <span className="font-bold">
                      {isInter ? 'Inter-State (IGST)' : 'Intra-State (CGST+SGST)'}
                    </span>
                  </div>
                  <div className="p-1.5">
                    <span className="text-slate-600 block">Status</span>
                    <span className="font-bold">
                      {getEffectiveStatus(viewingInvoice).replace(/_/g, ' ')}
                    </span>
                  </div>
                </div>
              </div>

              <div className="border-x border-b border-black p-2.5 space-y-0.5">
                <span className="text-[10px] font-bold uppercase text-slate-600 block">
                  Billed To (Vendor)
                </span>
                <div className="font-bold text-xs">
                  {viewingInvoice.vendorName}
                  {viewingInvoice.vendorCode ? ` (${viewingInvoice.vendorCode})` : ''}
                </div>
                <div>
                  <strong>GSTIN:</strong> {viewingInvoice.vendorGst || 'Unregistered'} |{' '}
                  <strong>Place of Supply:</strong>{' '}
                  {vendState.stateName || viewingInvoice.vendorState || 'N/A'}
                  {vendState.stateCode ? ` (${vendState.stateCode})` : ''}
                </div>
                <div>
                  {[viewingInvoice.vendorAddress, viewingInvoice.vendorCity, viewingInvoice.vendorState]
                    .filter(Boolean)
                    .join(', ')}
                </div>
                {(viewingInvoice.vendorContactPerson || viewingInvoice.vendorPhone) && (
                  <div>
                    <strong>Contact:</strong> {viewingInvoice.vendorContactPerson || '-'}{' '}
                    {viewingInvoice.vendorPhone ? `(${viewingInvoice.vendorPhone})` : ''}
                  </div>
                )}
              </div>

              <div className="border-x border-b border-black">
                <table className="w-full text-left border-collapse text-[10px]">
                  <thead>
                    <tr className="border-b border-black bg-slate-50 font-bold">
                      <th className="p-1.5 border-r border-black text-center w-7">Sl</th>
                      <th className="p-1.5 border-r border-black">Description of Goods / Services</th>
                      <th className="p-1.5 border-r border-black text-center w-16">HSN/SAC</th>
                      <th className="p-1.5 border-r border-black text-center w-14">Qty</th>
                      <th className="p-1.5 border-r border-black text-right w-16">Rate</th>
                      <th className="p-1.5 border-r border-black text-right w-14">Disc</th>
                      <th className="p-1.5 border-r border-black text-right w-20">Taxable</th>
                      {isInter ? (
                        <th className="p-1.5 border-r border-black text-right w-20">IGST</th>
                      ) : (
                        <>
                          <th className="p-1.5 border-r border-black text-right w-18">CGST</th>
                          <th className="p-1.5 border-r border-black text-right w-18">SGST</th>
                        </>
                      )}
                      <th className="p-1.5 text-right w-20">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(viewingInvoice.items || []).map((item, idx) => (
                      <tr key={item.id || idx} className="border-b border-slate-200 align-top">
                        <td className="p-1.5 border-r border-black text-center">{idx + 1}</td>
                        <td className="p-1.5 border-r border-black font-semibold">
                          {item.description}
                        </td>
                        <td className="p-1.5 border-r border-black text-center font-mono">
                          {item.hsnCode || '-'}
                        </td>
                        <td className="p-1.5 border-r border-black text-center">
                          {item.quantity} {item.unit}
                        </td>
                        <td className="p-1.5 border-r border-black text-right font-mono">
                          {Number(item.rate || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                        </td>
                        <td className="p-1.5 border-r border-black text-right font-mono">
                          {Number(item.discountAmount || 0).toLocaleString('en-IN', {
                            minimumFractionDigits: 2
                          })}
                        </td>
                        <td className="p-1.5 border-r border-black text-right font-mono">
                          {Number(item.taxableAmount || 0).toLocaleString('en-IN', {
                            minimumFractionDigits: 2
                          })}
                        </td>
                        {isInter ? (
                          <td className="p-1.5 border-r border-black text-right font-mono">
                            {Number(item.igstAmount || 0).toLocaleString('en-IN', {
                              minimumFractionDigits: 2
                            })}{' '}
                            ({item.igstRate}%)
                          </td>
                        ) : (
                          <>
                            <td className="p-1.5 border-r border-black text-right font-mono">
                              {Number(item.cgstAmount || 0).toLocaleString('en-IN', {
                                minimumFractionDigits: 2
                              })}{' '}
                              ({item.cgstRate}%)
                            </td>
                            <td className="p-1.5 border-r border-black text-right font-mono">
                              {Number(item.sgstAmount || 0).toLocaleString('en-IN', {
                                minimumFractionDigits: 2
                              })}{' '}
                              ({item.sgstRate}%)
                            </td>
                          </>
                        )}
                        <td className="p-1.5 text-right font-mono font-bold">
                          {Number(item.totalAmount || 0).toLocaleString('en-IN', {
                            minimumFractionDigits: 2
                          })}
                        </td>
                      </tr>
                    ))}

                    <tr className="border-t border-black font-semibold">
                      <td colSpan={isInter ? 8 : 9} className="p-1.5 text-right border-r border-black">
                        Gross Amount
                      </td>
                      <td className="p-1.5 text-right font-mono">
                        {fmtCurrency(viewingInvoice.grossAmount)}
                      </td>
                    </tr>
                    <tr>
                      <td colSpan={isInter ? 8 : 9} className="p-1 text-right border-r border-black">
                        Discount Total
                      </td>
                      <td className="p-1 text-right font-mono">
                        - {fmtCurrency(viewingInvoice.discountAmount)}
                      </td>
                    </tr>
                    <tr className="font-semibold">
                      <td colSpan={isInter ? 8 : 9} className="p-1 text-right border-r border-black">
                        Taxable Value
                      </td>
                      <td className="p-1 text-right font-mono">
                        {fmtCurrency(viewingInvoice.subtotal)}
                      </td>
                    </tr>
                    {isInter ? (
                      <tr>
                        <td colSpan={8} className="p-1 text-right border-r border-black">
                          IGST Total
                        </td>
                        <td className="p-1 text-right font-mono">
                          {fmtCurrency(viewingInvoice.igstAmount)}
                        </td>
                      </tr>
                    ) : (
                      <>
                        <tr>
                          <td colSpan={9} className="p-1 text-right border-r border-black">
                            CGST Total
                          </td>
                          <td className="p-1 text-right font-mono">
                            {fmtCurrency(viewingInvoice.cgstAmount)}
                          </td>
                        </tr>
                        <tr>
                          <td colSpan={9} className="p-1 text-right border-r border-black">
                            SGST Total
                          </td>
                          <td className="p-1 text-right font-mono">
                            {fmtCurrency(viewingInvoice.sgstAmount)}
                          </td>
                        </tr>
                      </>
                    )}
                    <tr className="border-t border-black font-bold bg-slate-50 text-xs">
                      <td colSpan={isInter ? 8 : 9} className="p-1.5 text-right border-r border-black">
                        Grand Invoice Total
                      </td>
                      <td className="p-1.5 text-right font-mono">
                        {fmtCurrency(viewingInvoice.totalAmount)}
                      </td>
                    </tr>
                    <tr>
                      <td colSpan={isInter ? 8 : 9} className="p-1 text-right border-r border-black">
                        Paid / Balance Due
                      </td>
                      <td className="p-1 text-right font-mono">
                        {fmtCurrency(viewingInvoice.paidAmount)} / {fmtCurrency(viewingInvoice.balanceAmount)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="border-x border-b border-black p-2 flex items-center justify-between text-[10px]">
                <div>
                  <span className="font-bold">Amount Chargeable (in words): </span>
                  <span className="font-bold">
                    INR {numberToIndianWords(Math.round(viewingInvoice.totalAmount || 0))}
                  </span>
                </div>
                <span className="font-bold italic">E. &amp; O.E</span>
              </div>

              <div className="border-x border-b border-black grid grid-cols-2 p-2.5 text-[10px]">
                <div className="pr-3 space-y-1">
                  <strong>Declaration &amp; Notes</strong>
                  <p className="text-slate-700 leading-normal">
                    {viewingInvoice.notes ||
                      'We declare that this invoice shows the actual price of the goods/services described and that all particulars are true and correct.'}
                  </p>
                </div>
                <div className="pl-3 border-l border-black text-right flex flex-col justify-between">
                  <div className="font-bold">
                    for {settings.companyName || 'SOLAR URJA ERP'}
                  </div>
                  <div className="pt-8 font-bold">Authorised Signatory</div>
                </div>
              </div>

              <div className="text-center text-[10px] text-slate-600 py-1">
                This is a Computer Generated GST Tax Invoice
              </div>
            </div>
          );
        })()}
      </PrintPortal>
    </div>
  );
};
