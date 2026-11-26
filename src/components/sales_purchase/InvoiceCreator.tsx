import React, { useState, useMemo, useEffect } from 'react';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { storageService } from '../../services/storage';
import { SalesInvoice, InvoiceLineItem, BankAccount } from '../../types/solar';
import { PrintPortal, triggerSafeWindowPrint } from '../common/PrintPortal';
import { numberToIndianWords } from '../../utils/indianNumberWords';
import {
  FileText,
  Plus,
  Search,
  CheckCircle,
  Clock,
  Trash2,
  Eye,
  AlertCircle,
  X,
  Printer,
  DollarSign,
  PackageCheck,
  Loader2,
  Mail,
  Pencil,
  CreditCard,
  Landmark
} from 'lucide-react';

type DraftInvoiceLineItem = Omit<InvoiceLineItem, 'id'> & { id?: string };

const PRESET_PAYMENT_TERMS = [
  'Immediate',
  '15 Days Net',
  '30 Days Net',
  'Advance Milestone'
];

export const InvoiceCreator: React.FC = () => {
  const { refreshTrigger, triggerRefresh, showToast, openEmailModal } = useApp();
  const { currentUser, isAdmin, isCustomer, hasPermission } = useAuth();
  const canManageInvoices = !isCustomer && (isAdmin || hasPermission('finance.invoices'));

  const [localUpdateCounter, setLocalUpdateCounter] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [isFormModalOpen, setIsFormModalOpen] = useState(false);
  const [editingInvoice, setEditingInvoice] = useState<SalesInvoice | null>(null);
  const [viewingInvoiceId, setViewingInvoiceId] = useState<string | null>(null);
  const [confirmDeleteInvoice, setConfirmDeleteInvoice] = useState<SalesInvoice | null>(null);
  const [paymentInvoice, setPaymentInvoice] = useState<SalesInvoice | null>(null);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [payAmount, setPayAmount] = useState<number>(0);
  const [payDate, setPayDate] = useState(new Date().toISOString().slice(0, 10));
  const [payMode, setPayMode] = useState('Bank NEFT/RTGS');
  const [payBankAccountId, setPayBankAccountId] = useState('');
  const [payReference, setPayReference] = useState('');
  const [payNotes, setPayNotes] = useState('');
  const [payError, setPayError] = useState<string | null>(null);
  const [isRecordingPayment, setIsRecordingPayment] = useState(false);

  const [isSaving, setIsSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  // Form states
  const [formCustomerId, setFormCustomerId] = useState('');
  const [formProjectId, setFormProjectId] = useState('');
  const [formInvoiceType, setFormInvoiceType] =
    useState<SalesInvoice['invoiceType']>('TAX_INVOICE');
  const [formStatus, setFormStatus] = useState<SalesInvoice['status'] | string>('ISSUED');
  const [formInvoiceDate, setFormInvoiceDate] = useState(new Date().toISOString().slice(0, 10));
  const [formDueDate, setFormDueDate] = useState(
    new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10)
  );
  const [formPaymentTerms, setFormPaymentTerms] = useState('15 Days Net');
  const [formNotes, setFormNotes] = useState('');
  const [formDeductStock, setFormDeductStock] = useState(true);
  const [formBankAccountId, setFormBankAccountId] = useState('');
  const [formInitialPaidAmount, setFormInitialPaidAmount] = useState<number>(0);
  const [formPaymentMode, setFormPaymentMode] = useState('Bank NEFT/RTGS');
  const [formPaymentReference, setFormPaymentReference] = useState('');

  // Dynamic items in modal
  const [lineItems, setLineItems] = useState<DraftInvoiceLineItem[]>([]);
  const [selectedProductId, setSelectedProductId] = useState('');
  const [customItemDesc, setCustomItemDesc] = useState('');
  const [itemHsn, setItemHsn] = useState('85414011');
  const [itemQty, setItemQty] = useState<number>(1);
  const [itemUnitPrice, setItemUnitPrice] = useState<number>(0);
  const [itemTaxRate, setItemTaxRate] = useState<number>(12);

  useEffect(() => {
    const handleStorageUpdate = () => setLocalUpdateCounter(c => c + 1);
    window.addEventListener('solarpulse_storage_updated', handleStorageUpdate);
    return () => window.removeEventListener('solarpulse_storage_updated', handleStorageUpdate);
  }, []);

  useEffect(() => {
    let mounted = true;
    storageService
      .fetchAccountingBankAccountsAsync()
      .then(list => {
        if (!mounted || !Array.isArray(list)) return;
        const active = list.filter((b: any) => b && b.isActive !== false);
        setBankAccounts(active);
        const primary = active.find((b: any) => b.isPrimary) || active[0];
        if (primary) {
          setPayBankAccountId(prev => (prev && active.some((b: any) => b.id === prev) ? prev : primary.id));
          setFormBankAccountId(prev => (prev && active.some((b: any) => b.id === prev) ? prev : primary.id));
        }
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [refreshTrigger, localUpdateCounter]);

  // Storage data
  const invoices = useMemo(
    () => storageService.getSalesInvoices(),
    [refreshTrigger, localUpdateCounter]
  );
  const customers = useMemo(
    () => storageService.getCustomers(),
    [refreshTrigger, localUpdateCounter]
  );
  const projects = useMemo(
    () => storageService.getProjects(),
    [refreshTrigger, localUpdateCounter]
  );
  const products = useMemo(
    () => storageService.getProducts(),
    [refreshTrigger, localUpdateCounter]
  );
  const settings = useMemo(
    () => storageService.getSettings(),
    [refreshTrigger, localUpdateCounter, viewingInvoiceId]
  );
  const viewingInvoice = useMemo(
    () => (viewingInvoiceId ? invoices.find(inv => inv.id === viewingInvoiceId) || null : null),
    [viewingInvoiceId, invoices]
  );

  // Calculations for summary metrics
  const metrics = useMemo(() => {
    const active = invoices.filter(inv => inv.status !== 'CANCELLED');
    const totalInvoiced = active.reduce((sum, inv) => sum + (Number(inv.totalAmount) || 0), 0);
    const totalPaid = active.reduce((sum, inv) => {
      const paid = inv.paidAmount != null ? Number(inv.paidAmount) : inv.status === 'PAID' ? Number(inv.totalAmount || 0) : 0;
      const refunded = Number(inv.refundedAmount || 0);
      return sum + Math.max(0, paid - refunded);
    }, 0);
    const totalPending = active
      .filter(inv => inv.status !== 'DRAFT')
      .reduce((sum, inv) => {
        const total = Number(inv.totalAmount) || 0;
        const returned = Number(inv.returnedAmount) || 0;
        const netPaid = Math.max(
          0,
          (inv.paidAmount != null ? Number(inv.paidAmount) : inv.status === 'PAID' ? total : 0) -
            (Number(inv.refundedAmount) || 0)
        );
        const bal = inv.balanceAmount != null ? Number(inv.balanceAmount) : Math.max(0, total - returned - netPaid);
        return sum + Math.max(0, bal);
      }, 0);
    const totalTax = active.reduce((sum, inv) => sum + (Number(inv.taxAmount) || 0), 0);

    return { totalInvoiced, totalPaid, totalPending, totalTax };
  }, [invoices]);

  const filteredInvoices = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return invoices.filter(inv => {
      const matchesSearch =
        (inv.invoiceNumber || '').toLowerCase().includes(q) ||
        (inv.customerName || '').toLowerCase().includes(q) ||
        (inv.projectTitle && inv.projectTitle.toLowerCase().includes(q));
      const matchesStatus = statusFilter === 'ALL' || inv.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [invoices, searchQuery, statusFilter]);

  const resetInvoiceForm = () => {
    const todayStr = new Date().toISOString().slice(0, 10);
    const dueStr = new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10);
    setEditingInvoice(null);
    setFormCustomerId('');
    setFormProjectId('');
    setFormInvoiceType('TAX_INVOICE');
    setFormStatus('ISSUED');
    setFormInvoiceDate(todayStr);
    setFormDueDate(dueStr);
    setFormPaymentTerms('15 Days Net');
    setFormNotes('');
    setFormDeductStock(true);
    setFormInitialPaidAmount(0);
    setFormPaymentMode('Bank NEFT/RTGS');
    setFormPaymentReference('');
    const primaryBank = bankAccounts.find(b => b.isPrimary) || bankAccounts[0];
    setFormBankAccountId(primaryBank?.id || '');
    setLineItems([]);
    setSelectedProductId('');
    setCustomItemDesc('');
    setItemHsn('85414011');
    setItemQty(1);
    setItemUnitPrice(0);
    setItemTaxRate(12);
    setFormError(null);
  };

  const openCreateModal = () => {
    resetInvoiceForm();
    setIsFormModalOpen(true);
  };

  const openEditModal = (inv: SalesInvoice) => {
    const fallbackToday = new Date().toISOString().slice(0, 10);
    setViewingInvoiceId(null);
    setEditingInvoice(inv);
    setFormCustomerId(inv.customerId || '');
    setFormProjectId(inv.projectId || '');
    setFormInvoiceType(inv.invoiceType || 'TAX_INVOICE');
    setFormStatus(inv.status || 'ISSUED');
    setFormInvoiceDate((inv.invoiceDate || '').slice(0, 10) || fallbackToday);
    setFormDueDate((inv.dueDate || '').slice(0, 10) || fallbackToday);
    setFormPaymentTerms(inv.paymentTerms || '15 Days Net');
    setFormNotes(inv.notes || '');
    setFormDeductStock(Boolean(inv.deductStock));
    setFormBankAccountId(inv.bankAccountId || bankAccounts.find(b => b.isPrimary)?.id || bankAccounts[0]?.id || '');
    setFormInitialPaidAmount(Number(inv.paidAmount || 0));
    setFormPaymentMode('Bank NEFT/RTGS');
    setFormPaymentReference('');
    setLineItems((inv.items || []).map(it => ({ ...it })));
    setSelectedProductId('');
    setCustomItemDesc('');
    setItemHsn('85414011');
    setItemQty(1);
    setItemUnitPrice(0);
    setItemTaxRate(12);
    setFormError(null);
    setIsFormModalOpen(true);
  };

  const closeFormModal = () => {
    if (isSaving) return;
    setIsFormModalOpen(false);
    resetInvoiceForm();
  };

  // When a product is selected in line item builder
  const handleProductSelect = (prodId: string) => {
    setSelectedProductId(prodId);
    if (!prodId) return;
    const prod = products.find(p => p.id === prodId);
    if (prod) {
      setCustomItemDesc(prod.name);
      setItemHsn(prod.hsnCode || '85414011');
      setItemUnitPrice(prod.sellingPrice || prod.unitPrice || 0);
      const prodGst =
        prod.gstRate !== undefined && prod.gstRate !== null && Number.isFinite(Number(prod.gstRate))
          ? Number(prod.gstRate)
          : 12;
      setItemTaxRate(prodGst);
    }
  };

  const handleAddLineItem = () => {
    if (!customItemDesc.trim()) {
      showToast('Please enter an item description', 'warning');
      return;
    }
    if (!Number.isFinite(itemQty) || itemQty <= 0 || !Number.isFinite(itemUnitPrice) || itemUnitPrice < 0) {
      showToast('Quantity must be greater than 0 and Unit Price cannot be negative', 'warning');
      return;
    }

    const baseAmount = itemQty * itemUnitPrice;
    const taxAmt = Number(((baseAmount * itemTaxRate) / 100).toFixed(2));
    const totalAmt = Number((baseAmount + taxAmt).toFixed(2));

    const prod = products.find(p => p.id === selectedProductId);

    const newItem: DraftInvoiceLineItem = {
      productId: prod?.id,
      description: customItemDesc.trim(),
      hsnCode: itemHsn.trim(),
      quantity: itemQty,
      unit: prod?.unit || 'NOS',
      unitPrice: itemUnitPrice,
      taxRatePercent: itemTaxRate,
      taxAmount: taxAmt,
      totalAmount: totalAmt
    };

    setLineItems(prev => [...prev, newItem]);
    setSelectedProductId('');
    setCustomItemDesc('');
    setItemQty(1);
    setItemUnitPrice(0);
    setItemTaxRate(12);
  };

  const handleUpdateLineItem = (index: number, patch: Partial<DraftInvoiceLineItem>) => {
    setLineItems(prev =>
      prev.map((it, i) => {
        if (i !== index) return it;
        const nextQty = patch.quantity !== undefined ? patch.quantity : it.quantity;
        const nextPrice = patch.unitPrice !== undefined ? patch.unitPrice : it.unitPrice;
        const nextTaxRate =
          patch.taxRatePercent !== undefined ? patch.taxRatePercent : it.taxRatePercent;
        const safeQty = Number.isFinite(Number(nextQty)) ? Number(nextQty) : 0;
        const safePrice = Number.isFinite(Number(nextPrice)) ? Number(nextPrice) : 0;
        const safeTaxRate = Number.isFinite(Number(nextTaxRate)) ? Number(nextTaxRate) : 0;
        const baseAmount = safeQty * safePrice;
        const taxAmt = Number(((baseAmount * safeTaxRate) / 100).toFixed(2));
        const totalAmt = Number((baseAmount + taxAmt).toFixed(2));
        return {
          ...it,
          ...patch,
          quantity: safeQty,
          unitPrice: safePrice,
          taxRatePercent: safeTaxRate,
          taxAmount: taxAmt,
          totalAmount: totalAmt
        };
      })
    );
  };

  const handleRemoveLineItem = (index: number) => {
    setLineItems(prev => prev.filter((_, i) => i !== index));
  };

  const formSubtotal = useMemo(() => {
    return Number(
      lineItems
        .reduce((acc, it) => acc + (Number(it.quantity) || 0) * (Number(it.unitPrice) || 0), 0)
        .toFixed(2)
    );
  }, [lineItems]);

  const formTaxTotal = useMemo(() => {
    return Number(
      lineItems.reduce((acc, it) => acc + (Number(it.taxAmount) || 0), 0).toFixed(2)
    );
  }, [lineItems]);

  const formGrandTotal = Number((formSubtotal + formTaxTotal).toFixed(2));

  const handleSaveInvoice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaving || !canManageInvoices) return;
    setFormError(null);

    if (!formCustomerId && !editingInvoice?.customerName) {
      const msg = 'Please select a customer';
      setFormError(msg);
      showToast(msg, 'warning');
      return;
    }

    if (lineItems.length === 0) {
      const msg = 'Please add at least one line item to the invoice';
      setFormError(msg);
      showToast(msg, 'warning');
      return;
    }

    for (let i = 0; i < lineItems.length; i++) {
      const it = lineItems[i];
      if (!String(it.description || '').trim()) {
        const msg = `Line item #${i + 1} must have a description`;
        setFormError(msg);
        showToast(msg, 'warning');
        return;
      }
      if (!Number.isFinite(it.quantity) || it.quantity <= 0) {
        const msg = `Quantity for "${it.description}" must be greater than zero`;
        setFormError(msg);
        showToast(msg, 'warning');
        return;
      }
      if (!Number.isFinite(it.unitPrice) || it.unitPrice < 0) {
        const msg = `Unit price for "${it.description}" cannot be negative`;
        setFormError(msg);
        showToast(msg, 'warning');
        return;
      }
    }

    const customer = customers.find(c => c.id === formCustomerId);
    const project = projects.find(p => p.id === formProjectId);
    const now = new Date().toISOString();
    const isEditing = Boolean(editingInvoice);

    const existingPaid = Number(editingInvoice?.paidAmount ?? 0);
    const existingReturned = Number(editingInvoice?.returnedAmount ?? 0);
    const existingRefunded = Number(editingInvoice?.refundedAmount ?? 0);
    const maxPayable = Math.max(0, Number((formGrandTotal - existingReturned + existingRefunded).toFixed(2)));
    let requestedPaid = existingPaid;
    if (formStatus === 'PAID') {
      requestedPaid = Math.max(existingPaid, maxPayable);
    } else if (formStatus === 'PARTIAL') {
      if (!Number.isFinite(formInitialPaidAmount) || formInitialPaidAmount <= 0) {
        const msg = 'Enter the partial payment amount received (> ₹0).';
        setFormError(msg);
        showToast(msg, 'warning');
        return;
      }
      if (formInitialPaidAmount > maxPayable + 0.01) {
        const msg = `Partial paid amount cannot exceed ₹${maxPayable.toLocaleString('en-IN')}.`;
        setFormError(msg);
        showToast(msg, 'warning');
        return;
      }
      requestedPaid = Math.max(existingPaid, Number(formInitialPaidAmount.toFixed(2)));
    }
    const isRecordingSettlement =
      (formStatus === 'PAID' || formStatus === 'PARTIAL') && requestedPaid > existingPaid + 0.01;
    const selectedBank = bankAccounts.find(b => b.id === formBankAccountId);
    if (isRecordingSettlement && bankAccounts.length > 0 && !formBankAccountId) {
      const msg = 'Please select a Cash / Bank account to deposit the received payment into.';
      setFormError(msg);
      showToast(msg, 'warning');
      return;
    }

    const netPaid = Math.max(0, requestedPaid - existingRefunded);
    const nextBalanceAmount =
      formStatus === 'PAID'
        ? 0
        : Math.max(0, Number((formGrandTotal - existingReturned - netPaid).toFixed(2)));

    const isInterState =
      Boolean(editingInvoice?.igstAmount && editingInvoice.igstAmount > 0) &&
      !(editingInvoice?.cgstAmount && editingInvoice.cgstAmount > 0);
    const nextIgst = isInterState ? formTaxTotal : 0;
    const nextCgst = isInterState ? 0 : Number((formTaxTotal / 2).toFixed(2));
    const nextSgst = isInterState ? 0 : Number((formTaxTotal - nextCgst).toFixed(2));

    const alreadyDeducted = Boolean(editingInvoice?.stockDeducted);
    const canDeductNow =
      !alreadyDeducted &&
      formDeductStock &&
      formStatus !== 'DRAFT' &&
      formStatus !== 'CANCELLED';

    const payloadInvoice: SalesInvoice & { paymentMode?: string; transactionReference?: string } = {
      id: editingInvoice ? editingInvoice.id : `inv-${Date.now()}`,
      invoiceNumber: editingInvoice
        ? editingInvoice.invoiceNumber
        : `INV-${new Date().getFullYear()}-${String(invoices.length + 1).padStart(3, '0')}`,
      invoiceType: formInvoiceType,
      customerId: formCustomerId || editingInvoice?.customerId || '',
      customerName: customer?.name || editingInvoice?.customerName || 'Valued Customer',
      customerGst: customer?.gstNumber || editingInvoice?.customerGst || 'Unregistered',
      customerAddress: customer?.siteAddress || editingInvoice?.customerAddress || '',
      projectId: formProjectId || '',
      projectTitle: formProjectId
        ? project?.title || editingInvoice?.projectTitle || ''
        : '',
      invoiceDate: formInvoiceDate,
      dueDate: formDueDate,
      status: formStatus as SalesInvoice['status'],
      paymentStatus: formStatus,
      paymentTerms: formPaymentTerms,
      notes: formNotes,
      paidAmount: requestedPaid,
      returnedAmount: existingReturned,
      refundedAmount: existingRefunded,
      balanceAmount: nextBalanceAmount,
      bankAccountId: selectedBank?.id || editingInvoice?.bankAccountId,
      bankAccountName: selectedBank?.accountName || editingInvoice?.bankAccountName,
      paymentMode: formPaymentMode,
      transactionReference: formPaymentReference.trim() || undefined,
      cgstAmount: nextCgst,
      sgstAmount: nextSgst,
      igstAmount: nextIgst,
      ewayBillNumber: editingInvoice?.ewayBillNumber,
      ewayBillDetails: editingInvoice?.ewayBillDetails,
      einvoiceIrn: editingInvoice?.einvoiceIrn,
      einvoiceAckNo: editingInvoice?.einvoiceAckNo,
      einvoiceAckDate: editingInvoice?.einvoiceAckDate,
      einvoiceStatus: editingInvoice?.einvoiceStatus,
      deductStock: alreadyDeducted ? true : formDeductStock,
      stockDeducted: alreadyDeducted,
      items: lineItems.map((it, idx) => ({
        ...it,
        id: it.id || `ili-${Date.now()}-${idx}`
      })),
      subtotal: formSubtotal,
      taxAmount: formTaxTotal,
      totalAmount: formGrandTotal,
      createdAt: editingInvoice?.createdAt || now,
      updatedAt: now
    };

    setIsSaving(true);
    try {
      const saved = await storageService.saveSalesInvoiceAsync(
        payloadInvoice,
        canDeductNow,
        currentUser?.name || 'Accounts Officer'
      );
      const latestBanks = await storageService.fetchAccountingBankAccountsAsync().catch(() => []);
      if (Array.isArray(latestBanks) && latestBanks.length > 0) {
        setBankAccounts(latestBanks.filter((b: any) => b && b.isActive !== false));
      }
      triggerRefresh();
      showToast(
        isEditing
          ? `Invoice ${saved.invoiceNumber} updated successfully`
          : `Invoice ${saved.invoiceNumber} created and issued successfully`,
        'success'
      );
      setIsFormModalOpen(false);
      resetInvoiceForm();
    } catch (err: any) {
      const msg = err?.message || 'Failed to save sales invoice to MySQL.';
      setFormError(msg);
      showToast(msg, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const getInvoiceBalance = (inv: SalesInvoice) => {
    const total = Number(inv.totalAmount || 0);
    const returned = Number(inv.returnedAmount || 0);
    const paid = Number(inv.paidAmount || 0);
    const refunded = Number(inv.refundedAmount || 0);
    const netPaid = Math.max(0, paid - refunded);
    return Number((inv.balanceAmount != null ? Number(inv.balanceAmount) : Math.max(0, total - returned - netPaid)).toFixed(2));
  };

  const openPaymentModal = (invoice: SalesInvoice) => {
    const balance = getInvoiceBalance(invoice);
    setPayError(null);
    setPaymentInvoice(invoice);
    setPayDate(new Date().toISOString().slice(0, 10));
    setPayAmount(balance > 0 ? balance : 0);
    setPayMode('Bank NEFT/RTGS');
    const primaryBank = bankAccounts.find(b => b.id === invoice.bankAccountId) || bankAccounts.find(b => b.isPrimary) || bankAccounts[0];
    setPayBankAccountId(primaryBank?.id || '');
    setPayReference('');
    setPayNotes('');
  };

  const handleRecordPaymentSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManageInvoices || !paymentInvoice || isRecordingPayment) return;
    setPayError(null);
    const remaining = getInvoiceBalance(paymentInvoice);

    if (!Number.isFinite(payAmount) || payAmount <= 0) {
      setPayError('Payment amount must be greater than zero.');
      return;
    }
    if (payAmount > remaining + 0.01) {
      setPayError(`Payment exceeds remaining invoice balance due (₹${remaining.toLocaleString('en-IN')}).`);
      return;
    }
    if (!payBankAccountId) {
      setPayError('Please select a Cash / Bank account to deposit this payment into.');
      return;
    }

    setIsRecordingPayment(true);
    try {
      const res = await storageService.recordSalesInvoicePaymentAsync(paymentInvoice.id, {
        amount: Number(payAmount.toFixed(2)),
        paymentDate: payDate,
        paymentMode: payMode,
        bankAccountId: payBankAccountId,
        referenceNo: payReference.trim() || undefined,
        notes: payNotes.trim() || undefined
      });
      const latestBanks = await storageService.fetchAccountingBankAccountsAsync().catch(() => []);
      if (Array.isArray(latestBanks) && latestBanks.length > 0) {
        setBankAccounts(latestBanks.filter((b: any) => b && b.isActive !== false));
      }
      triggerRefresh();
      showToast(
        `Recorded ₹${Number(payAmount).toLocaleString('en-IN')} against ${paymentInvoice.invoiceNumber} (${res?.bankAccountName || 'Bank'})`,
        'success'
      );
      setPaymentInvoice(null);
    } catch (err: any) {
      const msg = err?.message || 'Failed to record invoice payment.';
      setPayError(msg);
      showToast(msg, 'error');
    } finally {
      setIsRecordingPayment(false);
    }
  };

  const handleConfirmDeleteInvoice = async () => {
    if (!confirmDeleteInvoice || deletingId || !canManageInvoices) return;
    const target = confirmDeleteInvoice;
    setDeletingId(target.id);
    try {
      await storageService.deleteSalesInvoiceAsync(target.id);
      if (viewingInvoiceId === target.id) {
        setViewingInvoiceId(null);
      }
      if (editingInvoice?.id === target.id) {
        setIsFormModalOpen(false);
        resetInvoiceForm();
      }
      setConfirmDeleteInvoice(null);
      triggerRefresh();
      showToast(`Invoice ${target.invoiceNumber} deleted`, 'info');
    } catch (err: any) {
      showToast(err?.message || `Failed to delete invoice ${target.invoiceNumber}`, 'error');
    } finally {
      setDeletingId(null);
    }
  };

  const hasLegacyCustomerOption =
    Boolean(editingInvoice && formCustomerId) && !customers.some(c => c.id === formCustomerId);
  const hasLegacyProjectOption =
    Boolean(editingInvoice && formProjectId) && !projects.some(p => p.id === formProjectId);
  const hasCustomPaymentTerm =
    Boolean(formPaymentTerms) && !PRESET_PAYMENT_TERMS.includes(formPaymentTerms);

  return (
    <div className="space-y-6">
      {/* Top Metrics Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white p-4 rounded-2xl border border-slate-200/80 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
              Total Invoiced
            </span>
            <div className="p-2 rounded-xl bg-blue-50 text-blue-600">
              <DollarSign className="w-4 h-4" />
            </div>
          </div>
          <div className="text-xl font-bold text-slate-900 mt-2 font-mono">
            ₹{metrics.totalInvoiced.toLocaleString('en-IN')}
          </div>
          <span className="text-[11px] text-slate-400 mt-1 block">
            Across {invoices.length} tax invoices
          </span>
        </div>

        <div className="bg-white p-4 rounded-2xl border border-slate-200/80 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
              Collections Paid
            </span>
            <div className="p-2 rounded-xl bg-emerald-50 text-emerald-600">
              <CheckCircle className="w-4 h-4" />
            </div>
          </div>
          <div className="text-xl font-bold text-emerald-700 mt-2 font-mono">
            ₹{metrics.totalPaid.toLocaleString('en-IN')}
          </div>
          <span className="text-[11px] text-emerald-600 font-semibold mt-1 block">
            Realized in bank accounts
          </span>
        </div>

        <div className="bg-white p-4 rounded-2xl border border-slate-200/80 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
              Receivables Due
            </span>
            <div className="p-2 rounded-xl bg-amber-50 text-amber-600">
              <Clock className="w-4 h-4" />
            </div>
          </div>
          <div className="text-xl font-bold text-amber-700 mt-2 font-mono">
            ₹{metrics.totalPending.toLocaleString('en-IN')}
          </div>
          <span className="text-[11px] text-slate-400 mt-1 block">
            Pending customer clearance
          </span>
        </div>

        <div className="bg-white p-4 rounded-2xl border border-slate-200/80 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
              GST / Tax Collected
            </span>
            <div className="p-2 rounded-xl bg-purple-50 text-purple-600">
              <FileText className="w-4 h-4" />
            </div>
          </div>
          <div className="text-xl font-bold text-purple-700 mt-2 font-mono">
            ₹{metrics.totalTax.toLocaleString('en-IN')}
          </div>
          <span className="text-[11px] text-slate-400 mt-1 block">
            CGST + SGST / IGST breakdown
          </span>
        </div>
      </div>

      {/* Action Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-white p-5 rounded-2xl border border-slate-200/80 shadow-xs">
        <div>
          <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
            <FileText className="w-5 h-5 text-amber-500" />
            Sales Invoices &amp; Billing
          </h3>
          <p className="text-xs text-slate-500 mt-1">
            Create milestone &amp; supply tax invoices with automatic stock deduction and GST compliance.
          </p>
        </div>

        {canManageInvoices && (
          <button
            id="btn-create-invoice"
            type="button"
            onClick={openCreateModal}
            className="flex items-center gap-2 px-4 py-2.5 bg-amber-500 hover:bg-amber-600 text-white rounded-xl text-sm font-semibold shadow-xs transition-colors cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            Create Sales Invoice
          </button>
        )}
      </div>

      {/* Search & Status Filter */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="relative w-full sm:w-80">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search by invoice #, client, project..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-4 py-2 text-sm bg-white border border-slate-200 rounded-xl focus:outline-hidden focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
          />
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto overflow-x-auto pb-1">
          {['ALL', 'ISSUED', 'PARTIAL', 'PAID', 'DRAFT', 'CANCELLED'].map(st => (
            <button
              key={st}
              type="button"
              onClick={() => setStatusFilter(st)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer ${
                statusFilter === st
                  ? 'bg-slate-800 text-white'
                  : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
              }`}
            >
              {st}
            </button>
          ))}
        </div>
      </div>

      {/* Invoices Table View */}
      <div className="bg-white rounded-2xl border border-slate-200/90 shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-600 font-semibold border-b border-slate-200">
              <tr>
                <th className="p-3.5">Invoice #</th>
                <th className="p-3.5">Customer &amp; Project</th>
                <th className="p-3.5">Invoice Date</th>
                <th className="p-3.5">Due Date</th>
                <th className="p-3.5 text-right">Tax (GST)</th>
                <th className="p-3.5 text-right">Total Amount</th>
                <th className="p-3.5 text-center">Status</th>
                <th className="p-3.5 text-center">Inventory Sync</th>
                <th className="p-3.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredInvoices.map(inv => (
                <tr key={inv.id} className="hover:bg-slate-50/70 transition-colors">
                  <td className="p-3.5 font-mono font-bold text-amber-600 whitespace-nowrap">
                    {inv.invoiceNumber}
                  </td>
                  <td className="p-3.5">
                    <div className="font-bold text-slate-800">{inv.customerName}</div>
                    {inv.projectTitle && (
                      <span className="text-[11px] text-slate-500 block truncate max-w-xs">
                        {inv.projectTitle}
                      </span>
                    )}
                  </td>
                  <td className="p-3.5 text-slate-600 whitespace-nowrap">{inv.invoiceDate}</td>
                  <td className="p-3.5 text-slate-600 whitespace-nowrap">{inv.dueDate}</td>
                  <td className="p-3.5 text-right text-slate-600 font-mono">
                    ₹{inv.taxAmount.toLocaleString('en-IN')}
                  </td>
                  <td className="p-3.5 text-right font-mono">
                    <div className="font-bold text-slate-900 text-sm">
                      ₹{inv.totalAmount.toLocaleString('en-IN')}
                    </div>
                    {Number(inv.paidAmount || 0) > 0 && (
                      <div className="text-[10px] text-emerald-700">
                        Paid: ₹{Number(inv.paidAmount || 0).toLocaleString('en-IN')}
                      </div>
                    )}
                    {Number(inv.returnedAmount || 0) > 0 && (
                      <div className="text-[10px] text-amber-700">
                        Ret: -₹{Number(inv.returnedAmount || 0).toLocaleString('en-IN')}
                      </div>
                    )}
                    {getInvoiceBalance(inv) > 0.01 && inv.status !== 'CANCELLED' && (
                      <div className="text-[10px] font-bold text-rose-700">
                        Bal: ₹{getInvoiceBalance(inv).toLocaleString('en-IN')}
                      </div>
                    )}
                    {inv.bankAccountName && (
                      <div className="text-[10px] text-slate-400 truncate max-w-[140px] ml-auto">
                        {inv.bankAccountName}
                      </div>
                    )}
                  </td>
                  <td className="p-3.5 text-center whitespace-nowrap">
                    <span
                      className={`px-2.5 py-1 rounded-full text-[10px] font-bold border ${
                        inv.status === 'PAID'
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                          : inv.status === 'ISSUED'
                          ? 'bg-blue-50 text-blue-700 border-blue-200'
                          : inv.status === 'PARTIAL'
                          ? 'bg-amber-50 text-amber-700 border-amber-200'
                          : inv.status === 'CANCELLED'
                          ? 'bg-rose-50 text-rose-700 border-rose-200'
                          : 'bg-slate-100 text-slate-700 border-slate-200'
                      }`}
                    >
                      {inv.status}
                    </span>
                  </td>
                  <td className="p-3.5 text-center whitespace-nowrap">
                    {inv.stockDeducted ? (
                      <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                        <PackageCheck className="w-3 h-3" />
                        Stock Deducted
                      </span>
                    ) : (
                      <span className="text-[10px] text-slate-400 italic">No deduction</span>
                    )}
                  </td>
                  <td className="p-3.5 text-right whitespace-nowrap">
                    <div className="flex items-center justify-end gap-1.5">
                      {canManageInvoices &&
                        inv.status !== 'PAID' &&
                        inv.status !== 'DRAFT' &&
                        inv.status !== 'CANCELLED' &&
                        getInvoiceBalance(inv) > 0.01 && (
                          <button
                            type="button"
                            onClick={() => openPaymentModal(inv)}
                            className="px-2.5 py-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 rounded-md text-[11px] font-bold border border-emerald-200 transition-colors inline-flex items-center gap-1 cursor-pointer"
                          >
                            <CreditCard className="w-3 h-3" />
                            Pay / Receive
                          </button>
                        )}
                      {canManageInvoices && (
                        <button
                          type="button"
                          onClick={() => openEditModal(inv)}
                          className="p-1.5 text-amber-600 hover:text-amber-700 hover:bg-amber-50 rounded-lg transition-colors cursor-pointer"
                          title="Edit Invoice"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setViewingInvoiceId(inv.id)}
                        className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
                        title="View Tax Invoice"
                      >
                        <Eye className="w-4 h-4" />
                      </button>
                      {canManageInvoices && (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteInvoice(inv)}
                          disabled={deletingId === inv.id}
                          className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 disabled:opacity-50 rounded-lg transition-colors cursor-pointer"
                          title="Delete Invoice"
                        >
                          {deletingId === inv.id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Trash2 className="w-4 h-4" />
                          )}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {filteredInvoices.length === 0 && (
                <tr>
                  <td colSpan={9} className="p-8 text-center text-slate-400 italic">
                    No sales invoices found matching your filter criteria.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal: Create / Edit Sales Invoice */}
      {isFormModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-4xl w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden animate-in fade-in">
            {/* Header */}
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-xl bg-amber-500 text-white">
                  {editingInvoice ? <Pencil className="w-5 h-5" /> : <FileText className="w-5 h-5" />}
                </div>
                <div>
                  <h3 className="font-bold text-slate-800 text-base">
                    {editingInvoice
                      ? `Edit Sales Invoice (${editingInvoice.invoiceNumber})`
                      : 'Create Tax Invoice'}
                  </h3>
                  <p className="text-xs text-slate-500">
                    {editingInvoice
                      ? 'Update customer, dates, status, line items, GST rates, and invoice terms.'
                      : 'Draft a customer invoice with GST calculations and optional inventory deduction.'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={closeFormModal}
                className="p-2 text-slate-400 hover:text-slate-600 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Form */}
            <form onSubmit={handleSaveInvoice} className="flex-1 overflow-y-auto p-6 space-y-6">
              {formError && (
                <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl flex items-start gap-2.5 text-rose-700 text-xs">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{formError}</span>
                </div>
              )}

              {/* Customer & Project */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Customer *
                  </label>
                  <select
                    required
                    value={formCustomerId}
                    onChange={e => setFormCustomerId(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-xl"
                  >
                    <option value="">-- Choose Customer --</option>
                    {hasLegacyCustomerOption && editingInvoice && (
                      <option value={formCustomerId}>
                        {editingInvoice.customerName} ({editingInvoice.customerGst || 'Legacy'})
                      </option>
                    )}
                    {customers.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.gstNumber ? `GST: ${c.gstNumber}` : 'Individual'})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Linked Solar Project (Optional)
                  </label>
                  <select
                    value={formProjectId}
                    onChange={e => setFormProjectId(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-xl"
                  >
                    <option value="">-- None / General Supply --</option>
                    {hasLegacyProjectOption && editingInvoice && (
                      <option value={formProjectId}>
                        {editingInvoice.projectTitle || formProjectId}
                      </option>
                    )}
                    {projects.map(p => (
                      <option key={p.id} value={p.id}>
                        {p.title} ({p.customerName})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Type, Status, Dates & Terms */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Invoice Type
                  </label>
                  <select
                    value={formInvoiceType}
                    onChange={e =>
                      setFormInvoiceType(e.target.value as SalesInvoice['invoiceType'])
                    }
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-xl"
                  >
                    <option value="TAX_INVOICE">Tax Invoice</option>
                    <option value="PROFORMA">Proforma Invoice</option>
                    <option value="MILESTONE_INVOICE">Milestone Invoice</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">Status</label>
                  <select
                    value={formStatus}
                    onChange={e => {
                      const next = e.target.value;
                      setFormStatus(next);
                      if (next === 'PARTIAL' && formInitialPaidAmount <= 0 && formGrandTotal > 0) {
                        setFormInitialPaidAmount(Math.round(formGrandTotal * 0.5));
                      }
                    }}
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-xl"
                  >
                    <option value="DRAFT">DRAFT</option>
                    <option value="ISSUED">ISSUED</option>
                    <option value="PARTIAL">PARTIAL (Upfront Payment)</option>
                    <option value="PAID">PAID</option>
                    <option value="CANCELLED">CANCELLED</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">Invoice Date</label>
                  <input
                    type="date"
                    required
                    value={formInvoiceDate}
                    onChange={e => setFormInvoiceDate(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-xl"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Payment Due Date
                  </label>
                  <input
                    type="date"
                    required
                    value={formDueDate}
                    onChange={e => setFormDueDate(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-xl"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Payment Terms
                  </label>
                  <select
                    value={formPaymentTerms}
                    onChange={e => setFormPaymentTerms(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-xl"
                  >
                    {hasCustomPaymentTerm && (
                      <option value={formPaymentTerms}>{formPaymentTerms}</option>
                    )}
                    <option value="Immediate">Immediate / Due on Receipt</option>
                    <option value="15 Days Net">15 Days Net</option>
                    <option value="30 Days Net">30 Days Net</option>
                    <option value="Advance Milestone">Advance Milestone</option>
                  </select>
                </div>
              </div>

              {/* Line Items Section */}
              <div className="border border-slate-200 rounded-xl p-4 bg-slate-50/70 space-y-4">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                    Billable Line Items ({lineItems.length})
                  </h4>
                  <span className="text-[11px] text-slate-500">
                    Add items below or edit rows inline in the table
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-end">
                  <div className="sm:col-span-4">
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                      Choose Product (Optional)
                    </label>
                    <select
                      value={selectedProductId}
                      onChange={e => handleProductSelect(e.target.value)}
                      className="w-full px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg"
                    >
                      <option value="">-- Or type manual description below --</option>
                      {products.map(p => (
                        <option key={p.id} value={p.id}>
                          {p.sku} - {p.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="sm:col-span-4">
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                      Description *
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. 540W Modules Supply or Milestone 1"
                      value={customItemDesc}
                      onChange={e => setCustomItemDesc(e.target.value)}
                      className="w-full px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg"
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                      HSN / SAC
                    </label>
                    <input
                      type="text"
                      value={itemHsn}
                      onChange={e => setItemHsn(e.target.value)}
                      className="w-full px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg"
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                      GST Rate %
                    </label>
                    <select
                      value={itemTaxRate}
                      onChange={e => setItemTaxRate(Number(e.target.value))}
                      className="w-full px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg"
                    >
                      {Array.from(new Set([0, 5, 12, 18, 28, itemTaxRate]))
                        .filter(r => Number.isFinite(r) && r >= 0 && r <= 100)
                        .sort((a, b) => a - b)
                        .map(rate => (
                          <option key={rate} value={rate}>
                            {rate === 12
                              ? '12% (Solar Modules)'
                              : rate === 18
                              ? '18% (Inverters / Services)'
                              : `${rate}%`}
                          </option>
                        ))}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-end">
                  <div className="sm:col-span-4">
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                      Quantity
                    </label>
                    <input
                      type="number"
                      step="any"
                      min="0.01"
                      value={itemQty}
                      onChange={e => setItemQty(Number(e.target.value))}
                      className="w-full px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg"
                    />
                  </div>

                  <div className="sm:col-span-5">
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                      Unit Price (₹ excl. tax)
                    </label>
                    <input
                      type="number"
                      step="any"
                      min="0"
                      value={itemUnitPrice}
                      onChange={e => setItemUnitPrice(Number(e.target.value))}
                      className="w-full px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg"
                    />
                  </div>

                  <div className="sm:col-span-3">
                    <button
                      type="button"
                      onClick={handleAddLineItem}
                      className="w-full py-2 bg-slate-800 hover:bg-slate-900 text-white rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1 cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Add Line Item
                    </button>
                  </div>
                </div>

                {/* Inline-Editable Items List Table */}
                <div className="border border-slate-200 rounded-lg overflow-x-auto bg-white">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-100 text-slate-600 font-semibold border-b border-slate-200">
                      <tr>
                        <th className="p-2.5 min-w-[180px]">Item Description</th>
                        <th className="p-2.5 text-center w-24">HSN</th>
                        <th className="p-2.5 text-center w-24">Qty</th>
                        <th className="p-2.5 text-right w-28">Unit Price (₹)</th>
                        <th className="p-2.5 text-center w-20">GST %</th>
                        <th className="p-2.5 text-right w-24">Tax (₹)</th>
                        <th className="p-2.5 text-right w-28">Total (₹)</th>
                        <th className="p-2.5 text-center w-12">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {lineItems.map((it, idx) => (
                        <tr key={it.id || idx}>
                          <td className="p-2">
                            <input
                              type="text"
                              value={it.description}
                              onChange={e =>
                                handleUpdateLineItem(idx, { description: e.target.value })
                              }
                              className="w-full px-2 py-1 text-xs border border-slate-200 rounded font-medium text-slate-800"
                            />
                          </td>
                          <td className="p-2">
                            <input
                              type="text"
                              value={it.hsnCode}
                              onChange={e =>
                                handleUpdateLineItem(idx, { hsnCode: e.target.value })
                              }
                              className="w-full px-2 py-1 text-center font-mono text-[11px] text-slate-600 border border-slate-200 rounded"
                            />
                          </td>
                          <td className="p-2">
                            <div className="flex items-center justify-center gap-1">
                              <input
                                type="number"
                                step="any"
                                min="0.01"
                                value={it.quantity}
                                onChange={e =>
                                  handleUpdateLineItem(idx, {
                                    quantity: Number(e.target.value)
                                  })
                                }
                                className="w-14 px-1.5 py-1 text-center font-bold text-slate-700 border border-slate-200 rounded"
                              />
                              <span className="text-[10px] text-slate-500">{it.unit}</span>
                            </div>
                          </td>
                          <td className="p-2 text-right">
                            <input
                              type="number"
                              step="any"
                              min="0"
                              value={it.unitPrice}
                              onChange={e =>
                                handleUpdateLineItem(idx, {
                                  unitPrice: Number(e.target.value)
                                })
                              }
                              className="w-24 px-2 py-1 text-right font-mono text-slate-700 border border-slate-200 rounded"
                            />
                          </td>
                          <td className="p-2 text-center">
                            <select
                              value={it.taxRatePercent}
                              onChange={e =>
                                handleUpdateLineItem(idx, {
                                  taxRatePercent: Number(e.target.value)
                                })
                              }
                              className="w-full px-1.5 py-1 text-xs bg-white border border-slate-200 rounded font-mono text-purple-700"
                            >
                              {Array.from(new Set([0, 5, 12, 18, 28, Number(it.taxRatePercent) || 0]))
                                .filter(r => Number.isFinite(r) && r >= 0 && r <= 100)
                                .sort((a, b) => a - b)
                                .map(rate => (
                                  <option key={rate} value={rate}>
                                    {rate}%
                                  </option>
                                ))}
                            </select>
                          </td>
                          <td className="p-2 text-right font-mono text-purple-700">
                            ₹{(Number(it.taxAmount) || 0).toLocaleString('en-IN')}
                          </td>
                          <td className="p-2 text-right font-mono font-bold text-slate-800">
                            ₹{(Number(it.totalAmount) || 0).toLocaleString('en-IN')}
                          </td>
                          <td className="p-2 text-center">
                            <button
                              type="button"
                              onClick={() => handleRemoveLineItem(idx)}
                              className="text-slate-400 hover:text-rose-600 cursor-pointer"
                              title="Remove line item"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                      {lineItems.length === 0 && (
                        <tr>
                          <td colSpan={8} className="p-4 text-center text-slate-400 italic">
                            No items added yet. Please add items using the form above.
                          </td>
                        </tr>
                      )}
                    </tbody>
                    {lineItems.length > 0 && (
                      <tfoot className="bg-slate-50 border-t border-slate-200 font-semibold text-xs">
                        <tr>
                          <td colSpan={6} className="p-2 text-right text-slate-600">
                            Subtotal (Excl. Tax):
                          </td>
                          <td className="p-2 text-right font-mono">
                            ₹{formSubtotal.toLocaleString('en-IN')}
                          </td>
                          <td></td>
                        </tr>
                        <tr>
                          <td colSpan={6} className="p-2 text-right text-purple-700">
                            Total GST:
                          </td>
                          <td className="p-2 text-right font-mono text-purple-700">
                            ₹{formTaxTotal.toLocaleString('en-IN')}
                          </td>
                          <td></td>
                        </tr>
                        <tr className="border-t border-slate-300 text-sm font-bold bg-amber-50">
                          <td colSpan={6} className="p-2.5 text-right text-amber-900">
                            Grand Invoice Total:
                          </td>
                          <td className="p-2.5 text-right font-mono text-amber-900">
                            ₹{formGrandTotal.toLocaleString('en-IN')}
                          </td>
                          <td></td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </div>

              {/* Stock Synchronization Option */}
              <div className="bg-emerald-50/70 border border-emerald-200/80 rounded-xl p-3 flex items-start gap-3">
                <input
                  type="checkbox"
                  id="chk-deduct-stock"
                  checked={editingInvoice?.stockDeducted ? true : formDeductStock}
                  disabled={Boolean(editingInvoice?.stockDeducted)}
                  onChange={e => setFormDeductStock(e.target.checked)}
                  className="mt-0.5 rounded text-emerald-600 focus:ring-emerald-500 w-4 h-4 disabled:opacity-60"
                />
                <label htmlFor="chk-deduct-stock" className="text-xs text-slate-700 select-none">
                  <span className="font-bold block text-emerald-900">
                    {editingInvoice?.stockDeducted
                      ? 'Inventory Stock Already Deducted'
                      : 'Deduct items from Inventory Stock upon Invoice Issuance'}
                  </span>
                  {editingInvoice?.stockDeducted
                    ? 'Stock movements were already recorded for this invoice. Editing fields will not deduct inventory a second time.'
                    : 'Automatically updates product on-hand quantities and records an INVOICE_SALE stock movement in the audit ledger.'}
                </label>
              </div>

              {/* Settlement Cash/Bank Account when saving as PAID or PARTIAL */}
              {(formStatus === 'PAID' || formStatus === 'PARTIAL') && (
                <div className="bg-amber-50/70 border border-amber-200 rounded-xl p-4 space-y-3">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-amber-950">
                    <Landmark className="w-4 h-4 text-amber-600" />
                    <span>
                      {formStatus === 'PAID'
                        ? 'Full Settlement Cash / Bank Deposit'
                        : 'Partial Payment Receipt & Bank Deposit'}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                    <div className={formStatus === 'PARTIAL' ? 'sm:col-span-2' : 'sm:col-span-2'}>
                      <label className="block text-[11px] font-bold text-slate-700 mb-1">
                        Deposit Cash / Bank Account *
                      </label>
                      <select
                        required={bankAccounts.length > 0}
                        value={formBankAccountId}
                        onChange={e => setFormBankAccountId(e.target.value)}
                        className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-xl"
                      >
                        {bankAccounts.length === 0 && (
                          <option value="">Default Primary Bank / Cash</option>
                        )}
                        {bankAccounts.map(b => (
                          <option key={b.id} value={b.id}>
                            {b.accountName} ({b.accountType}) — Bal: ₹{Number(b.currentBalance || 0).toLocaleString('en-IN')}
                          </option>
                        ))}
                      </select>
                    </div>

                    {formStatus === 'PARTIAL' && (
                      <div>
                        <label className="block text-[11px] font-bold text-slate-700 mb-1">
                          Total Paid Amount (₹) *
                        </label>
                        <input
                          type="number"
                          min={0.01}
                          max={Math.max(0.01, formGrandTotal - Number(editingInvoice?.returnedAmount || 0) + Number(editingInvoice?.refundedAmount || 0))}
                          step="0.01"
                          required
                          value={formInitialPaidAmount}
                          onChange={e => setFormInitialPaidAmount(Number(e.target.value))}
                          className="w-full px-3 py-2 text-xs font-mono font-bold bg-white border border-slate-300 rounded-xl"
                        />
                      </div>
                    )}

                    <div>
                      <label className="block text-[11px] font-bold text-slate-700 mb-1">
                        Payment Mode
                      </label>
                      <select
                        value={formPaymentMode}
                        onChange={e => setFormPaymentMode(e.target.value)}
                        className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-xl"
                      >
                        <option value="Bank NEFT/RTGS">Bank NEFT/RTGS</option>
                        <option value="UPI">UPI</option>
                        <option value="Cheque">Cheque</option>
                        <option value="Cash">Cash</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-[11px] font-bold text-slate-700 mb-1">
                        UTR / Ref No.
                      </label>
                      <input
                        type="text"
                        value={formPaymentReference}
                        onChange={e => setFormPaymentReference(e.target.value)}
                        placeholder="Optional UTR / Cheque #"
                        className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-300 rounded-xl"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Notes */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Invoice Notes &amp; Terms
                </label>
                <textarea
                  rows={2}
                  value={formNotes}
                  onChange={e => setFormNotes(e.target.value)}
                  placeholder="Terms of payment, bank RTGS details, milestone clause..."
                  className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-xl"
                />
              </div>

              {/* Submit Buttons */}
              <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-200">
                <button
                  type="button"
                  disabled={isSaving}
                  onClick={closeFormModal}
                  className="px-4 py-2 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 text-slate-700 rounded-xl text-xs font-semibold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="px-5 py-2.5 bg-amber-500 hover:bg-amber-600 disabled:opacity-60 text-white rounded-xl text-xs font-bold shadow-xs transition-colors inline-flex items-center gap-1.5 cursor-pointer"
                >
                  {isSaving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {isSaving
                    ? editingInvoice
                      ? 'Updating Invoice...'
                      : 'Issuing Invoice...'
                    : editingInvoice
                    ? 'Update Sales Invoice'
                    : 'Issue Tax Invoice'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: View Tax Invoice Preview */}
      {viewingInvoice && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-2xl w-full p-6 space-y-5 shadow-2xl animate-in fade-in">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div>
                <span className="text-xs font-bold text-amber-600 bg-amber-50 px-2 py-0.5 rounded font-mono">
                  {viewingInvoice.invoiceNumber}
                </span>
                <h3 className="text-lg font-bold text-slate-900 mt-1">Tax Invoice</h3>
              </div>
              <div className="flex items-center gap-2">
                {canManageInvoices && (
                  <button
                    type="button"
                    onClick={() => openEditModal(viewingInvoice)}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-white rounded-lg text-xs font-semibold cursor-pointer"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                    Edit
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    const matchedCust = customers.find(
                      c => c.id === viewingInvoice.customerId || c.name === viewingInvoice.customerName
                    );
                    openEmailModal({
                      recipientEmail: matchedCust?.email || '',
                      recipientName: viewingInvoice.customerName,
                      type: 'INVOICE_SHARE',
                      data: {
                        invoiceNumber: viewingInvoice.invoiceNumber,
                        invoiceDate: viewingInvoice.invoiceDate,
                        dueDate: viewingInvoice.dueDate,
                        totalAmount: viewingInvoice.totalAmount,
                        status: viewingInvoice.status
                      }
                    });
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold cursor-pointer"
                >
                  <Mail className="w-3.5 h-3.5" />
                  Email Invoice
                </button>
                <button
                  type="button"
                  onClick={() => triggerSafeWindowPrint(settings.logoUrl ? [settings.logoUrl] : [])}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-semibold cursor-pointer"
                >
                  <Printer className="w-3.5 h-3.5" />
                  Print
                </button>
                <button
                  type="button"
                  onClick={() => setViewingInvoiceId(null)}
                  className="p-1.5 text-slate-400 hover:text-slate-600 cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 text-xs">
              <div className="bg-slate-50 p-3 rounded-xl">
                <span className="text-slate-400 text-[10px] uppercase font-bold block">Billed To</span>
                <span className="font-bold text-slate-900 text-sm block mt-0.5">
                  {viewingInvoice.customerName}
                </span>
                <span className="text-slate-600 block mt-1">
                  GSTIN: {viewingInvoice.customerGst || 'Unregistered'}
                </span>
                {viewingInvoice.customerAddress && (
                  <span className="text-slate-500 block mt-0.5">
                    {viewingInvoice.customerAddress}
                  </span>
                )}
              </div>

              <div className="bg-slate-50 p-3 rounded-xl space-y-1">
                <div className="flex justify-between">
                  <span className="text-slate-400">Invoice Date:</span>
                  <span className="font-semibold text-slate-800">{viewingInvoice.invoiceDate}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Due Date:</span>
                  <span className="font-semibold text-slate-800">{viewingInvoice.dueDate}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Payment Status:</span>
                  <span className="font-bold text-emerald-700">{viewingInvoice.status}</span>
                </div>
              </div>
            </div>

            <div className="border border-slate-200 rounded-xl overflow-hidden">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-100 text-slate-700 font-semibold">
                  <tr>
                    <th className="p-2.5">Item</th>
                    <th className="p-2.5 text-center">HSN</th>
                    <th className="p-2.5 text-center">Qty</th>
                    <th className="p-2.5 text-right">Unit Price</th>
                    <th className="p-2.5 text-right">GST</th>
                    <th className="p-2.5 text-right">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {viewingInvoice.items.map(item => (
                    <tr key={item.id}>
                      <td className="p-2.5 font-medium text-slate-800">{item.description}</td>
                      <td className="p-2.5 text-center text-slate-500 font-mono text-[11px]">
                        {item.hsnCode}
                      </td>
                      <td className="p-2.5 text-center font-bold text-slate-700">
                        {item.quantity} {item.unit}
                      </td>
                      <td className="p-2.5 text-right font-mono text-slate-600">
                        ₹{item.unitPrice.toLocaleString('en-IN')}
                      </td>
                      <td className="p-2.5 text-right font-mono text-purple-700">
                        ₹{item.taxAmount.toLocaleString('en-IN')} ({item.taxRatePercent}%)
                      </td>
                      <td className="p-2.5 text-right font-mono font-bold text-slate-800">
                        ₹{item.totalAmount.toLocaleString('en-IN')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-col items-end gap-1 text-xs bg-slate-50 p-3 rounded-xl">
              <div className="flex justify-between w-64">
                <span className="text-slate-500">Subtotal:</span>
                <span className="font-mono text-slate-800">
                  ₹{viewingInvoice.subtotal.toLocaleString('en-IN')}
                </span>
              </div>
              <div className="flex justify-between w-64 text-purple-700">
                <span>Tax Total:</span>
                <span className="font-mono">₹{viewingInvoice.taxAmount.toLocaleString('en-IN')}</span>
              </div>
              <div className="flex justify-between w-64 text-sm font-bold text-slate-900 pt-1 border-t border-slate-200">
                <span>Total Amount:</span>
                <span className="font-mono text-amber-700">
                  ₹{viewingInvoice.totalAmount.toLocaleString('en-IN')}
                </span>
              </div>
              {Number(viewingInvoice.returnedAmount || 0) > 0 && (
                <div className="flex justify-between w-64 text-amber-700">
                  <span>Sales Returned (Credit Note):</span>
                  <span className="font-mono">-₹{Number(viewingInvoice.returnedAmount || 0).toLocaleString('en-IN')}</span>
                </div>
              )}
              {Number(viewingInvoice.paidAmount || 0) > 0 && (
                <div className="flex justify-between w-64 text-emerald-700">
                  <span>Paid Received:</span>
                  <span className="font-mono">₹{Number(viewingInvoice.paidAmount || 0).toLocaleString('en-IN')}</span>
                </div>
              )}
              {Number(viewingInvoice.refundedAmount || 0) > 0 && (
                <div className="flex justify-between w-64 text-rose-700">
                  <span>Refunded to Customer:</span>
                  <span className="font-mono">₹{Number(viewingInvoice.refundedAmount || 0).toLocaleString('en-IN')}</span>
                </div>
              )}
              <div className="flex justify-between w-64 font-bold text-slate-900 pt-1 border-t border-slate-200">
                <span>Balance Due:</span>
                <span className="font-mono text-rose-700">₹{getInvoiceBalance(viewingInvoice).toLocaleString('en-IN')}</span>
              </div>
              {viewingInvoice.bankAccountName && (
                <div className="flex justify-between w-64 text-[11px] text-slate-500">
                  <span>Settled Account:</span>
                  <span className="font-semibold">{viewingInvoice.bankAccountName}</span>
                </div>
              )}
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setViewingInvoiceId(null)}
                className="px-4 py-2 bg-slate-800 text-white rounded-xl text-xs font-bold hover:bg-slate-900 cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Confirm Delete Sales Invoice */}
      {confirmDeleteInvoice && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <h4 className="font-bold text-slate-900 text-base">Delete Sales Invoice</h4>
              <button
                type="button"
                disabled={Boolean(deletingId)}
                onClick={() => setConfirmDeleteInvoice(null)}
                className="p-1 text-slate-400 hover:text-slate-600 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              Are you sure you want to permanently delete invoice{' '}
              <strong className="font-mono text-slate-900">
                {confirmDeleteInvoice.invoiceNumber}
              </strong>{' '}
              for {confirmDeleteInvoice.customerName}?
            </p>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={Boolean(deletingId)}
                onClick={() => setConfirmDeleteInvoice(null)}
                className="px-3.5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-semibold cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={Boolean(deletingId)}
                onClick={handleConfirmDeleteInvoice}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-rose-600 hover:bg-rose-700 disabled:opacity-60 text-white rounded-xl text-xs font-bold cursor-pointer"
              >
                {deletingId === confirmDeleteInvoice.id && (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                )}
                Delete Invoice
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Record Customer Invoice Payment with Bank Selection */}
      {paymentInvoice && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full border border-slate-200 shadow-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Record Invoice Payment</h3>
                <p className="text-[11px] text-slate-500 font-mono mt-0.5">
                  {paymentInvoice.invoiceNumber} • {paymentInvoice.customerName}
                </p>
              </div>
              <button
                type="button"
                disabled={isRecordingPayment}
                onClick={() => setPaymentInvoice(null)}
                className="p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleRecordPaymentSubmit} className="p-5 space-y-4 text-xs">
              {payError && (
                <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                  <span>{payError}</span>
                </div>
              )}

              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 grid grid-cols-3 gap-2 text-center font-mono">
                <div>
                  <span className="text-[10px] font-sans text-slate-500 block">Invoice Total</span>
                  <span className="font-bold text-slate-900">₹{paymentInvoice.totalAmount.toLocaleString('en-IN')}</span>
                </div>
                <div>
                  <span className="text-[10px] font-sans text-slate-500 block">Net Paid / Ret</span>
                  <span className="font-bold text-emerald-700">
                    ₹{(Math.max(0, Number(paymentInvoice.paidAmount || 0) - Number(paymentInvoice.refundedAmount || 0)) + Number(paymentInvoice.returnedAmount || 0)).toLocaleString('en-IN')}
                  </span>
                </div>
                <div>
                  <span className="text-[10px] font-sans text-slate-500 block">Balance Due</span>
                  <span className="font-bold text-rose-700">₹{getInvoiceBalance(paymentInvoice).toLocaleString('en-IN')}</span>
                </div>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1 flex items-center gap-1">
                  <Landmark className="w-3.5 h-3.5 text-amber-600" />
                  Deposit To Cash / Bank Account *
                </label>
                <select
                  required
                  value={payBankAccountId}
                  onChange={e => setPayBankAccountId(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg"
                >
                  <option value="">-- Select Cash / Bank Account --</option>
                  {bankAccounts.map(b => (
                    <option key={b.id} value={b.id}>
                      {b.accountName} ({b.accountType}) — Bal: ₹{Number(b.currentBalance || 0).toLocaleString('en-IN')}
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
                      onClick={() => setPayAmount(getInvoiceBalance(paymentInvoice))}
                      className="text-[10px] font-bold text-amber-700 hover:underline cursor-pointer"
                    >
                      Pay Full
                    </button>
                  </div>
                  <input
                    type="number"
                    min={0.01}
                    max={getInvoiceBalance(paymentInvoice)}
                    step="0.01"
                    required
                    value={payAmount}
                    onChange={e => setPayAmount(Number(e.target.value))}
                    className="w-full px-3 py-2 font-mono font-bold bg-white border border-slate-300 rounded-lg"
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
                    <option value="Bank NEFT/RTGS">Bank NEFT/RTGS</option>
                    <option value="UPI">UPI</option>
                    <option value="Cheque">Cheque</option>
                    <option value="Cash">Cash</option>
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
                  placeholder="Optional receipt notes"
                  className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
                <button
                  type="button"
                  disabled={isRecordingPayment}
                  onClick={() => setPaymentInvoice(null)}
                  className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isRecordingPayment || !payBankAccountId}
                  className="inline-flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-xl font-bold"
                >
                  {isRecordingPayment && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  Record Receipt & Update Bank
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Dedicated Body-Level Print Portal for Tax Invoice */}
      <PrintPortal active={Boolean(viewingInvoice)}>
        {viewingInvoice && (
          <div className="bg-white p-4 border border-black w-full max-w-none mx-0 text-black text-[11px] leading-tight font-sans">
            <h2 className="text-center font-bold text-base uppercase tracking-wider mb-2">
              {viewingInvoice.invoiceType === 'PROFORMA'
                ? 'Proforma Invoice'
                : viewingInvoice.invoiceType === 'MILESTONE_INVOICE'
                ? 'Milestone Tax Invoice'
                : 'Tax Invoice'}
            </h2>

            <div className="border border-black grid grid-cols-2">
              <div className="p-2.5 border-r border-black space-y-0.5">
                <div className="font-bold text-sm">
                  {settings.companyName || 'SOLAR URJA ERP'}
                </div>
                <div>
                  {settings.companyAddress ||
                    'PLOT NO- 14, STREET NO- 14B, PRAGATI NAGAR, RISALI BHILAI, Chhattisgarh 490006'}
                </div>
                <div>
                  <strong>GSTIN/UIN:</strong> {settings.companyGst || '22AAOCR0748K1Z5'}
                </div>
                {settings.companyPhone && (
                  <div>
                    <strong>Phone:</strong> {settings.companyPhone}
                  </div>
                )}
                {settings.companyEmail && (
                  <div>
                    <strong>E-Mail:</strong> {settings.companyEmail}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 text-[11px] divide-y divide-black">
                <div className="p-1.5 border-r border-black">
                  <span className="text-[10px] text-slate-600 block">Invoice No.</span>
                  <span className="font-bold font-mono">{viewingInvoice.invoiceNumber}</span>
                </div>
                <div className="p-1.5">
                  <span className="text-[10px] text-slate-600 block">Invoice Date</span>
                  <span className="font-bold">{viewingInvoice.invoiceDate}</span>
                </div>
                <div className="p-1.5 border-r border-black">
                  <span className="text-[10px] text-slate-600 block">Due Date</span>
                  <span className="font-bold">{viewingInvoice.dueDate}</span>
                </div>
                <div className="p-1.5">
                  <span className="text-[10px] text-slate-600 block">Payment Terms</span>
                  <span>{viewingInvoice.paymentTerms || '15 Days Net'}</span>
                </div>
                <div className="p-1.5 border-r border-black">
                  <span className="text-[10px] text-slate-600 block">Status</span>
                  <span className="font-bold">{viewingInvoice.status}</span>
                </div>
                <div className="p-1.5">
                  <span className="text-[10px] text-slate-600 block">Project Reference</span>
                  <span>{viewingInvoice.projectTitle || 'Direct Supply'}</span>
                </div>
              </div>
            </div>

            <div className="border-x border-b border-black p-2.5 space-y-0.5">
              <span className="text-[10px] font-bold text-slate-600 uppercase block">
                Buyer (Bill To)
              </span>
              <div className="font-bold text-xs">{viewingInvoice.customerName}</div>
              <div>
                <strong>GSTIN/UIN:</strong> {viewingInvoice.customerGst || 'Unregistered'}
              </div>
              {viewingInvoice.customerAddress && <div>{viewingInvoice.customerAddress}</div>}
            </div>

            <div className="border-x border-b border-black">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-black bg-slate-50 font-bold text-[10px]">
                    <th className="p-1.5 border-r border-black text-center w-8">Sl No.</th>
                    <th className="p-1.5 border-r border-black">Description of Goods / Services</th>
                    <th className="p-1.5 border-r border-black text-center w-20">HSN/SAC</th>
                    <th className="p-1.5 border-r border-black text-center w-16">Qty</th>
                    <th className="p-1.5 border-r border-black text-right w-20">Rate (₹)</th>
                    <th className="p-1.5 border-r border-black text-right w-20">Taxable (₹)</th>
                    <th className="p-1.5 border-r border-black text-center w-14">GST %</th>
                    <th className="p-1.5 border-r border-black text-right w-20">CGST (₹)</th>
                    <th className="p-1.5 border-r border-black text-right w-20">SGST (₹)</th>
                    <th className="p-1.5 text-right w-24">Total (₹)</th>
                  </tr>
                </thead>
                <tbody>
                  {viewingInvoice.items.map((item, idx) => {
                    const taxable = Number(((item.quantity || 0) * (item.unitPrice || 0)).toFixed(2));
                    const halfTax = Number(((item.taxAmount || 0) / 2).toFixed(2));
                    return (
                      <tr key={item.id || idx} className="border-b border-slate-200 align-top">
                        <td className="p-1.5 border-r border-black text-center">{idx + 1}</td>
                        <td className="p-1.5 border-r border-black font-semibold">{item.description}</td>
                        <td className="p-1.5 border-r border-black text-center font-mono">
                          {item.hsnCode || '-'}
                        </td>
                        <td className="p-1.5 border-r border-black text-center font-bold">
                          {item.quantity} {item.unit}
                        </td>
                        <td className="p-1.5 border-r border-black text-right font-mono">
                          {Number(item.unitPrice || 0).toLocaleString('en-IN', {
                            minimumFractionDigits: 2
                          })}
                        </td>
                        <td className="p-1.5 border-r border-black text-right font-mono">
                          {taxable.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                        </td>
                        <td className="p-1.5 border-r border-black text-center font-mono">
                          {Number(item.taxRatePercent || 0)}%
                        </td>
                        <td className="p-1.5 border-r border-black text-right font-mono">
                          {halfTax.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                        </td>
                        <td className="p-1.5 border-r border-black text-right font-mono">
                          {halfTax.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                        </td>
                        <td className="p-1.5 text-right font-mono font-bold">
                          {Number(item.totalAmount || 0).toLocaleString('en-IN', {
                            minimumFractionDigits: 2
                          })}
                        </td>
                      </tr>
                    );
                  })}

                  <tr className="border-t border-black font-semibold">
                    <td colSpan={9} className="p-1.5 text-right border-r border-black">
                      Subtotal (Excl. Tax)
                    </td>
                    <td className="p-1.5 text-right font-mono">
                      ₹{' '}
                      {Number(viewingInvoice.subtotal || 0).toLocaleString('en-IN', {
                        minimumFractionDigits: 2
                      })}
                    </td>
                  </tr>
                  <tr>
                    <td colSpan={9} className="p-1 text-right border-r border-black">
                      CGST Total
                    </td>
                    <td className="p-1 text-right font-mono">
                      ₹{' '}
                      {Number((viewingInvoice.taxAmount || 0) / 2).toLocaleString('en-IN', {
                        minimumFractionDigits: 2
                      })}
                    </td>
                  </tr>
                  <tr>
                    <td colSpan={9} className="p-1 text-right border-r border-black">
                      SGST Total
                    </td>
                    <td className="p-1 text-right font-mono">
                      ₹{' '}
                      {Number((viewingInvoice.taxAmount || 0) / 2).toLocaleString('en-IN', {
                        minimumFractionDigits: 2
                      })}
                    </td>
                  </tr>
                  <tr>
                    <td colSpan={9} className="p-1 text-right border-r border-black font-semibold">
                      Total GST Tax
                    </td>
                    <td className="p-1 text-right font-mono font-semibold">
                      ₹{' '}
                      {Number(viewingInvoice.taxAmount || 0).toLocaleString('en-IN', {
                        minimumFractionDigits: 2
                      })}
                    </td>
                  </tr>
                  <tr className="border-t border-black font-bold bg-slate-50 text-xs">
                    <td colSpan={9} className="p-1.5 text-right border-r border-black">
                      Grand Invoice Total
                    </td>
                    <td className="p-1.5 text-right font-mono">
                      ₹{' '}
                      {Number(viewingInvoice.totalAmount || 0).toLocaleString('en-IN', {
                        minimumFractionDigits: 2
                      })}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="border-x border-b border-black p-2 flex items-center justify-between text-[11px]">
              <div>
                <span className="font-bold">Amount Chargeable (in words): </span>
                <span className="font-bold">
                  INR {numberToIndianWords(Math.round(viewingInvoice.totalAmount || 0))}
                </span>
              </div>
              <span className="font-bold italic">E. &amp; O.E</span>
            </div>

            <div className="border-x border-b border-black grid grid-cols-2 p-2.5 text-[11px]">
              <div className="pr-3 space-y-1">
                <strong>Declaration &amp; Notes</strong>
                <p className="text-[10px] text-slate-600 leading-normal">
                  {viewingInvoice.notes ||
                    'We declare that this invoice shows the actual price of the goods/services described and that all particulars are true and correct.'}
                </p>
              </div>
              <div className="pl-3 border-l border-black text-right flex flex-col justify-between">
                <div className="font-bold text-[10px]">
                  for {settings.companyName || 'SOLAR URJA ERP'}
                </div>
                <div className="pt-8 text-[10px] font-bold">Authorised Signatory</div>
              </div>
            </div>

            <div className="text-center text-[10px] text-slate-500 py-1">
              This is a Computer Generated Invoice
            </div>
          </div>
        )}
      </PrintPortal>
    </div>
  );
};
