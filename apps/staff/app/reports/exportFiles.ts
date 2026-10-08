// Turns built content into .xlsx / .pdf files. The libraries are loaded only when a download is
// clicked, so the Reports page stays light on mobile data.
import { downloadBlob } from './download';
import type { PdfContent, Sheet } from './exportContent';

export function reportFileName(branchCode: string, from: string, to: string, ext: 'xlsx' | 'pdf') {
  return `pixel-barber-report-${branchCode}-${from}-${to}.${ext}`;
}

export async function downloadExcel(sheets: Sheet[], fileName: string): Promise<void> {
  const { default: writeXlsxFile } = await import('write-excel-file/browser');
  const blob = await writeXlsxFile(sheets.map((s) => ({ data: s.data, sheet: s.sheet }))).toBlob();
  downloadBlob(blob, fileName);
}

const MARGIN = 40;
const PAGE_BOTTOM = 780;

export async function downloadPdf(content: PdfContent, fileName: string): Promise<void> {
  const [{ jsPDF }, { autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  let y = MARGIN + 10;
  doc.setFontSize(16);
  doc.text(content.title, MARGIN, y);
  y += 20;
  doc.setFontSize(10);
  doc.text(content.period, MARGIN, y);
  y += 14;
  doc.text(content.generated, MARGIN, y);
  y += 24;
  for (const section of content.sections) {
    if (y > PAGE_BOTTOM - 40) {
      doc.addPage();
      y = MARGIN + 10;
    }
    doc.setFontSize(12);
    doc.text(section.heading, MARGIN, y);
    autoTable(doc, {
      head: [section.head],
      body: section.body,
      startY: y + 8,
      showHead: 'everyPage',
      margin: { left: MARGIN, right: MARGIN },
      styles: { fontSize: section.head.length > 10 ? 6 : 8 },
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 24;
  }
  downloadBlob(doc.output('blob'), fileName);
}
