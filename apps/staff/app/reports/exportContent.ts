// Pure Excel and PDF content for a loaded report
// (Docs/superpowers/specs/2026-10-08-reports-dashboard-design.md): Excel keeps raw numbers (a sheet
// per table); the PDF shows the values as formatted on the page.
import { buildReportTables, buildSummaryItems, type Cell, type Label } from './reportTables';
import type { BranchReport } from './reportTypes';

export interface ExportInput {
  report: BranchReport;
  label: Label;
  branchName: string;
  from: string;
  to: string;
  generatedAt: string;
}

export interface XCell {
  value: string | number;
  fontWeight?: 'bold';
}

export interface Sheet {
  sheet: string;
  data: (XCell | null)[][];
}

export interface PdfSection {
  heading: string;
  head: string[];
  body: string[][];
}

export interface PdfContent {
  title: string;
  period: string;
  generated: string;
  sections: PdfSection[];
}

const cell = (v: Cell): XCell | null => (v === null ? null : { value: v });
const bold = (value: string): XCell => ({ value, fontWeight: 'bold' });

export function buildWorkbookSheets(input: ExportInput): Sheet[] {
  const { report, label } = input;
  const summary: Sheet = {
    sheet: label('tables.summary'),
    data: [
      [bold(label('export.branch')), { value: input.branchName }],
      [bold(label('export.from')), { value: input.from }],
      [bold(label('export.to')), { value: input.to }],
      [bold(label('export.generated')), { value: input.generatedAt }],
      [null, null],
      ...buildSummaryItems(report.summary, label).map((i) => [{ value: i.label }, cell(i.raw)]),
    ],
  };
  const tables = buildReportTables(report, label).map((table): Sheet => ({
    sheet: table.title,
    data: [table.headers.map(bold), ...table.raw.map((row) => row.map(cell))],
  }));
  return [summary, ...tables];
}

export function buildPdfContent(input: ExportInput): PdfContent {
  const { report, label } = input;
  return {
    title: label('export.pdfTitle'),
    period: label('export.pdfPeriod', { branch: input.branchName, from: input.from, to: input.to }),
    generated: label('export.generatedAt', { time: input.generatedAt }),
    sections: [
      {
        heading: label('tables.summary'),
        head: [label('export.metric'), label('export.value')],
        body: buildSummaryItems(report.summary, label).map((i) => [i.label, i.display]),
      },
      ...buildReportTables(report, label).map((table) => ({
        heading: table.title,
        head: table.headers.map((h, i) =>
          i === table.takingsColumn ? label('columns.takingsPdf') : h,
        ),
        body: table.display,
      })),
    ],
  };
}
