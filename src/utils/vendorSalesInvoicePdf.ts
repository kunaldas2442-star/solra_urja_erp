import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { SystemSettings, VendorSalesInvoice } from '../types/solar';
import { numberToIndianWords } from './indianNumberWords';
import { SOLAR_URJA_LOGO_BASE64 } from './logoData';
import { resolveStateNameAndCode } from './gstTaxUtils';

function fmtAmt(val: number | undefined | null): string {
  const num = Number(val || 0);
  if (!Number.isFinite(num)) return '0.00';
  return num.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function fmtRs(val: number | undefined | null): string {
  return `Rs. ${fmtAmt(val)}`;
}

export function generateVendorSalesInvoicePdf(
  invoice: VendorSalesInvoice,
  settings: Partial<SystemSettings>
): jsPDF {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4'
  });

  const pageWidth = 210;
  const pageHeight = 297;
  const margin = 12;
  const contentWidth = pageWidth - margin * 2;

  const companyName = settings.companyName || 'SOLAR URJA ERP';
  const companyAddress =
    settings.companyAddress ||
    'Plot No. 14, Street No. 14/B, Pragati Nagar, Risali, Bhilai, Durg, Chhattisgarh - 490006';
  const companyGst = settings.companyGst || '22AAOCR0748K1Z5';
  const companyPhone = settings.companyPhone || '+91 9770577527';
  const companyEmail = settings.companyEmail || 'support@solar.klyiatechnology.com';
  const companyStateInfo = resolveStateNameAndCode(
    invoice.companyState || '',
    companyGst,
    companyAddress
  );
  const companyStateDisplay = companyStateInfo.stateName
    ? `${companyStateInfo.stateName}${companyStateInfo.stateCode ? ` (${companyStateInfo.stateCode})` : ''}`
    : 'Chhattisgarh (22)';

  const vendorStateInfo = resolveStateNameAndCode(
    invoice.vendorState,
    invoice.vendorGst,
    invoice.vendorAddress
  );
  const vendorStateDisplay = vendorStateInfo.stateName
    ? `${vendorStateInfo.stateName}${vendorStateInfo.stateCode ? ` (${vendorStateInfo.stateCode})` : ''}`
    : invoice.vendorState || 'N/A';

  const isInterState = invoice.supplyType === 'INTER_STATE';

  // Top Solar Urja orange accent stripe
  doc.setFillColor(249, 115, 22);
  doc.rect(0, 0, pageWidth, 3, 'F');

  // Header Logo & Company Details
  try {
    doc.addImage(SOLAR_URJA_LOGO_BASE64, 'JPEG', margin, 6, 36, 9, 'solar_urja_logo', 'FAST');
  } catch {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(15, 41, 84);
    doc.text('SOLAR URJA ERP', margin, 13);
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(15, 23, 42);
  doc.text('TAX INVOICE (VENDOR SALES)', pageWidth - margin, 11, { align: 'right' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(71, 85, 105);
  doc.text('Original for Recipient / Duplicate for Supplier', pageWidth - margin, 15.5, {
    align: 'right'
  });

  // Top Info Grid Box (Company vs Invoice Metadata)
  const topBoxY = 19;
  const leftW = contentWidth * 0.54;
  const rightW = contentWidth - leftW;
  const topBoxH = 38;

  doc.setDrawColor(148, 163, 184);
  doc.setLineWidth(0.3);
  doc.rect(margin, topBoxY, contentWidth, topBoxH);
  doc.line(margin + leftW, topBoxY, margin + leftW, topBoxY + topBoxH);

  // Supplier / Company Block
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(15, 23, 42);
  doc.text(companyName, margin + 3, topBoxY + 5.5);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.2);
  doc.setTextColor(51, 65, 85);
  const addrLines = doc.splitTextToSize(companyAddress, leftW - 6);
  doc.text(addrLines.slice(0, 2), margin + 3, topBoxY + 10.5);

  doc.setFont('helvetica', 'bold');
  doc.text(`GSTIN/UIN: ${companyGst}`, margin + 3, topBoxY + 21);
  doc.setFont('helvetica', 'normal');
  doc.text(`State / Code: ${companyStateDisplay}`, margin + 3, topBoxY + 25.5);
  doc.text(`Phone: ${companyPhone}`, margin + 3, topBoxY + 30);
  doc.text(`Email: ${companyEmail}`, margin + 3, topBoxY + 34.5);

  // Invoice Metadata Grid (Right Side)
  const metaX = margin + leftW;
  const metaHalfW = rightW / 2;
  const rowH = topBoxH / 4;
  doc.line(metaX + metaHalfW, topBoxY, metaX + metaHalfW, topBoxY + topBoxH);
  for (let r = 1; r < 4; r++) {
    doc.line(metaX, topBoxY + r * rowH, margin + contentWidth, topBoxY + r * rowH);
  }

  const metaCells: Array<{ label: string; value: string; bold?: boolean }> = [
    { label: 'Invoice Number', value: invoice.invoiceNumber || '-', bold: true },
    { label: 'Invoice Date', value: invoice.invoiceDate || '-', bold: true },
    { label: 'Due Date', value: invoice.dueDate || '-', bold: true },
    { label: 'Payment Terms', value: invoice.paymentTerms || 'Net 15 Days' },
    {
      label: 'Supply Type',
      value: isInterState ? 'Inter-State (IGST)' : 'Intra-State (CGST+SGST)'
    },
    { label: 'Payment Status', value: (invoice.status || 'ISSUED').replace(/_/g, ' '), bold: true },
    { label: 'Place of Supply', value: vendorStateDisplay },
    { label: 'Balance Due', value: fmtRs(invoice.balanceAmount), bold: true }
  ];

  metaCells.forEach((cell, idx) => {
    const col = idx % 2;
    const row = Math.floor(idx / 2);
    const cx = metaX + col * metaHalfW + 2.5;
    const cy = topBoxY + row * rowH;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.2);
    doc.setTextColor(100, 116, 139);
    doc.text(cell.label, cx, cy + 3.4);

    doc.setFont('helvetica', cell.bold ? 'bold' : 'normal');
    doc.setFontSize(7.3);
    doc.setTextColor(15, 23, 42);
    const valLines = doc.splitTextToSize(cell.value, metaHalfW - 4.5);
    doc.text(valLines[0] || '-', cx, cy + 7.4);
  });

  // Bill To (Vendor Details Box)
  const billBoxY = topBoxY + topBoxH + 3;
  const billBoxH = 26;
  doc.setFillColor(248, 250, 252);
  doc.rect(margin, billBoxY, contentWidth, 6, 'F');
  doc.setDrawColor(148, 163, 184);
  doc.rect(margin, billBoxY, contentWidth, billBoxH);
  doc.line(margin, billBoxY + 6, margin + contentWidth, billBoxY + 6);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.2);
  doc.setTextColor(71, 85, 105);
  doc.text('BILLED TO (VENDOR DETAILS)', margin + 3, billBoxY + 4.2);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.8);
  doc.setTextColor(15, 23, 42);
  const vendorHeading = invoice.vendorCode
    ? `${invoice.vendorName} (${invoice.vendorCode})`
    : invoice.vendorName;
  doc.text(vendorHeading, margin + 3, billBoxY + 10.8);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.2);
  doc.setTextColor(51, 65, 85);
  const vendorFullAddress = [invoice.vendorAddress, invoice.vendorCity, invoice.vendorState]
    .filter(Boolean)
    .join(', ');
  const vAddrLines = doc.splitTextToSize(vendorFullAddress || 'Address on file', contentWidth * 0.56);
  doc.text(vAddrLines.slice(0, 2), margin + 3, billBoxY + 15.2);

  const vRightX = margin + contentWidth * 0.62;
  doc.setFont('helvetica', 'bold');
  doc.text(`GSTIN: ${invoice.vendorGst || 'Unregistered'}`, vRightX, billBoxY + 10.8);
  doc.setFont('helvetica', 'normal');
  doc.text(`State: ${vendorStateDisplay}`, vRightX, billBoxY + 15.2);
  doc.text(
    `Contact: ${invoice.vendorContactPerson || '-'}${invoice.vendorPhone ? ` (${invoice.vendorPhone})` : ''}`,
    vRightX,
    billBoxY + 19.6
  );
  if (invoice.vendorEmail) {
    doc.text(`Email: ${invoice.vendorEmail}`, vRightX, billBoxY + 23.8);
  }

  // Line Items Table
  const tableStartY = billBoxY + billBoxH + 3.5;

  const headRow = isInterState
    ? [['#', 'Description of Goods / Services', 'HSN/SAC', 'Qty', 'Rate', 'Disc.', 'Taxable', 'IGST %', 'IGST Amt', 'Total']]
    : [['#', 'Description of Goods / Services', 'HSN/SAC', 'Qty', 'Rate', 'Disc.', 'Taxable', 'CGST', 'SGST', 'Total']];

  const bodyRows = (invoice.items || []).map((item, idx) => {
    const qtyLabel = `${Number(item.quantity || 0)} ${item.unit || 'NOS'}`;
    const discLabel =
      Number(item.discountAmount || 0) > 0
        ? item.discountType === 'PERCENT'
          ? `${fmtAmt(item.discountAmount)} (${item.discountValue}%)`
          : fmtAmt(item.discountAmount)
        : '0.00';

    if (isInterState) {
      return [
        String(idx + 1),
        item.description,
        item.hsnCode || '-',
        qtyLabel,
        fmtAmt(item.rate),
        discLabel,
        fmtAmt(item.taxableAmount),
        `${item.igstRate || item.gstRate || 0}%`,
        fmtAmt(item.igstAmount),
        fmtAmt(item.totalAmount)
      ];
    }

    return [
      String(idx + 1),
      item.description,
      item.hsnCode || '-',
      qtyLabel,
      fmtAmt(item.rate),
      discLabel,
      fmtAmt(item.taxableAmount),
      `${fmtAmt(item.cgstAmount)}\n(${item.cgstRate}%)`,
      `${fmtAmt(item.sgstAmount)}\n(${item.sgstRate}%)`,
      fmtAmt(item.totalAmount)
    ];
  });

  autoTable(doc, {
    startY: tableStartY,
    margin: { left: margin, right: margin },
    theme: 'grid',
    head: headRow,
    body: bodyRows,
    styles: {
      fontSize: 6.8,
      cellPadding: 1.8,
      textColor: [15, 23, 42],
      lineColor: [148, 163, 184],
      lineWidth: 0.2,
      valign: 'middle'
    },
    headStyles: {
      fillColor: [30, 41, 59],
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 6.7
    },
    columnStyles: isInterState
      ? {
          0: { cellWidth: 7, halign: 'center' },
          1: { cellWidth: 48 },
          2: { cellWidth: 16, halign: 'center' },
          3: { cellWidth: 15, halign: 'center' },
          4: { cellWidth: 18, halign: 'right' },
          5: { cellWidth: 16, halign: 'right' },
          6: { cellWidth: 20, halign: 'right' },
          7: { cellWidth: 12, halign: 'center' },
          8: { cellWidth: 18, halign: 'right' },
          9: { cellWidth: 16, halign: 'right', fontStyle: 'bold' }
        }
      : {
          0: { cellWidth: 7, halign: 'center' },
          1: { cellWidth: 46 },
          2: { cellWidth: 15, halign: 'center' },
          3: { cellWidth: 15, halign: 'center' },
          4: { cellWidth: 17, halign: 'right' },
          5: { cellWidth: 15, halign: 'right' },
          6: { cellWidth: 19, halign: 'right' },
          7: { cellWidth: 17, halign: 'right' },
          8: { cellWidth: 17, halign: 'right' },
          9: { cellWidth: 18, halign: 'right', fontStyle: 'bold' }
        }
  });

  let curY = ((doc as any).lastAutoTable?.finalY || tableStartY + 25) + 4;
  if (curY > pageHeight - 75) {
    doc.addPage();
    curY = 16;
  }

  // Amount in Words (Left) & GST Summary Totals (Right)
  const wordsBoxW = contentWidth * 0.54;
  const totalsBoxW = contentWidth - wordsBoxW - 4;
  const totalsX = margin + wordsBoxW + 4;

  const summaryRows: Array<[string, string, boolean?]> = [
    ['Gross Amount', fmtRs(invoice.grossAmount)],
    ['Total Discount', `- ${fmtRs(invoice.discountAmount)}`],
    ['Taxable Value', fmtRs(invoice.subtotal), true]
  ];
  if (isInterState) {
    summaryRows.push(['IGST Total', fmtRs(invoice.igstAmount)]);
  } else {
    summaryRows.push(['CGST Total', fmtRs(invoice.cgstAmount)]);
    summaryRows.push(['SGST Total', fmtRs(invoice.sgstAmount)]);
  }
  summaryRows.push(['Total GST Tax', fmtRs(invoice.taxAmount)]);
  summaryRows.push(['Grand Invoice Total', fmtRs(invoice.totalAmount), true]);
  summaryRows.push(['Amount Paid', fmtRs(invoice.paidAmount)]);
  summaryRows.push(['Balance Due', fmtRs(invoice.balanceAmount), true]);

  const totalsH = summaryRows.length * 5.2 + 3;
  doc.setDrawColor(148, 163, 184);
  doc.rect(margin, curY, wordsBoxW, totalsH);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(71, 85, 105);
  doc.text('AMOUNT CHARGEABLE (IN WORDS)', margin + 3, curY + 5);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.8);
  doc.setTextColor(15, 23, 42);
  const words = `INR ${numberToIndianWords(Math.round(invoice.totalAmount || 0))}`;
  doc.text(doc.splitTextToSize(words, wordsBoxW - 6), margin + 3, curY + 10.5);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.8);
  doc.setTextColor(71, 85, 105);
  const noteText =
    invoice.notes ||
    'All disputes subject to local jurisdiction. Interest @ 18% p.a. applicable on overdue balances.';
  doc.text('Notes / Declaration:', margin + 3, curY + 23);
  doc.text(doc.splitTextToSize(noteText, wordsBoxW - 6).slice(0, 4), margin + 3, curY + 27);

  // Totals Box
  doc.rect(totalsX, curY, totalsBoxW, totalsH);
  summaryRows.forEach(([label, val, isBold], idx) => {
    const ry = curY + 4.8 + idx * 5.2;
    if (label === 'Grand Invoice Total') {
      doc.setFillColor(254, 243, 199);
      doc.rect(totalsX + 0.2, ry - 3.6, totalsBoxW - 0.4, 5.2, 'F');
    }
    doc.setFont('helvetica', isBold ? 'bold' : 'normal');
    doc.setFontSize(label === 'Grand Invoice Total' ? 7.6 : 7);
    doc.setTextColor(15, 23, 42);
    doc.text(label, totalsX + 2.5, ry);
    doc.text(val, totalsX + totalsBoxW - 2.5, ry, { align: 'right' });
  });

  curY += totalsH + 4;

  // Payment History Table (if payments exist)
  if (Array.isArray(invoice.payments) && invoice.payments.length > 0) {
    if (curY > pageHeight - 50) {
      doc.addPage();
      curY = 16;
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(15, 23, 42);
    doc.text('PAYMENT RECEIPT LEDGER', margin, curY + 2);

    autoTable(doc, {
      startY: curY + 4,
      margin: { left: margin, right: margin },
      theme: 'grid',
      head: [['Date', 'Mode', 'Reference No.', 'Amount', 'Notes']],
      body: invoice.payments.map(p => [
        p.paymentDate || '-',
        p.paymentMode || '-',
        p.referenceNo || '-',
        fmtRs(p.amount),
        p.notes || '-'
      ]),
      styles: {
        fontSize: 6.7,
        cellPadding: 1.5,
        textColor: [15, 23, 42],
        lineColor: [203, 213, 225],
        lineWidth: 0.2
      },
      headStyles: {
        fillColor: [241, 245, 249],
        textColor: [15, 23, 42],
        fontStyle: 'bold'
      }
    });

    curY = ((doc as any).lastAutoTable?.finalY || curY + 20) + 5;
  }

  // Signatory Footer
  if (curY > pageHeight - 28) {
    doc.addPage();
    curY = 20;
  }

  doc.setDrawColor(148, 163, 184);
  doc.rect(margin, curY, contentWidth, 20);
  doc.line(margin + contentWidth * 0.6, curY, margin + contentWidth * 0.6, curY + 20);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.6);
  doc.setTextColor(71, 85, 105);
  doc.text('Declaration:', margin + 3, curY + 4.5);
  doc.text(
    'We declare that this invoice shows the actual price of the goods/services described',
    margin + 3,
    curY + 8.5
  );
  doc.text('and that all particulars are true and correct. E. & O.E.', margin + 3, curY + 12.2);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.2);
  doc.setTextColor(15, 23, 42);
  doc.text(`For ${companyName}`, margin + contentWidth - 3, curY + 5, { align: 'right' });
  doc.setFontSize(7);
  doc.text('Authorised Signatory', margin + contentWidth - 3, curY + 17, { align: 'right' });

  // Page footer on all pages
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(100, 116, 139);
    doc.text(
      `Computer Generated GST Tax Invoice | ${invoice.invoiceNumber} | Page ${p} of ${totalPages}`,
      pageWidth / 2,
      pageHeight - 6,
      { align: 'center' }
    );
  }

  return doc;
}

export function downloadVendorSalesInvoicePdf(
  invoice: VendorSalesInvoice,
  settings: Partial<SystemSettings>
): void {
  const doc = generateVendorSalesInvoicePdf(invoice, settings);
  const safeNo = (invoice.invoiceNumber || 'vendor-sales-invoice').replace(/[^a-zA-Z0-9_-]+/g, '_');
  doc.save(`${safeNo}.pdf`);
}
