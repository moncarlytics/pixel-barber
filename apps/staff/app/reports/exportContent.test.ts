import { describe, expect, it } from 'vitest';
import { buildPdfContent, buildWorkbookSheets, type ExportInput } from './exportContent';
import type { Label } from './reportTables';
import { sampleAllBranches, sampleReport } from './__fixtures__/sampleReport';

const label: Label = (key, values) => (values ? `${key} ${JSON.stringify(values)}` : key);
const input: ExportInput = {
  report: sampleReport,
  label,
  branchName: 'Osu',
  from: '2026-09-28',
  to: '2026-09-29',
  generatedAt: '8 Oct 2026, 10:42',
};

describe('buildWorkbookSheets', () => {
  it('starts with a Summary sheet, then one sheet per table', () => {
    const sheets = buildWorkbookSheets(input);
    expect(sheets.map((s) => s.sheet)).toEqual([
      'tables.summary',
      'tables.daily',
      'tables.hours',
      'tables.barbers',
      'tables.services',
      'tables.reasons',
    ]);
    expect(
      buildWorkbookSheets({ ...input, report: sampleAllBranches }).map((s) => s.sheet),
    ).toContain('tables.branches');
  });

  it('heads the Summary sheet with the branch and range, then the numbers', () => {
    const [summary] = buildWorkbookSheets(input);
    expect(summary!.data.slice(0, 4)).toEqual([
      [{ value: 'export.branch', fontWeight: 'bold' }, { value: 'Osu' }],
      [{ value: 'export.from', fontWeight: 'bold' }, { value: '2026-09-28' }],
      [{ value: 'export.to', fontWeight: 'bold' }, { value: '2026-09-29' }],
      [{ value: 'export.generated', fontWeight: 'bold' }, { value: '8 Oct 2026, 10:42' }],
    ]);
    expect(summary!.data[5]).toEqual([{ value: 'summary.served' }, { value: 3 }]);
  });

  it('gives each table sheet a bold header row and numeric cells', () => {
    const daily = buildWorkbookSheets(input)[1]!;
    expect(daily.data[0]![0]).toEqual({ value: 'columns.date', fontWeight: 'bold' });
    expect(daily.data[2]).toEqual([
      { value: '2026-09-29' },
      { value: 1 },
      { value: 0 },
      { value: 1 },
      { value: 0 },
      { value: 1 },
      null,
      null,
      null,
      { value: 350 },
    ]);
  });
});

describe('buildPdfContent', () => {
  it('has the title lines, a summary table and every report table with formatted values', () => {
    const pdf = buildPdfContent(input);
    expect(pdf.title).toBe('export.pdfTitle');
    expect(pdf.period).toBe(
      'export.pdfPeriod {"branch":"Osu","from":"2026-09-28","to":"2026-09-29"}',
    );
    expect(pdf.generated).toBe('export.generatedAt {"time":"8 Oct 2026, 10:42"}');
    expect(pdf.sections.map((s) => s.heading)).toEqual([
      'tables.summary',
      'tables.daily',
      'tables.hours',
      'tables.barbers',
      'tables.services',
      'tables.reasons',
    ]);
    expect(pdf.sections[0]!.head).toEqual(['export.metric', 'export.value']);
    expect(pdf.sections[0]!.body[0]).toEqual(['summary.served', '3']);
    const daily = pdf.sections[1]!;
    expect(daily.head[9]).toBe('columns.takingsPdf');
    expect(daily.body[1]).toEqual([
      'Tue 29 Sep',
      '1',
      '0',
      '1',
      '0',
      '1',
      '—',
      '—',
      '—',
      'GHS 350.00',
    ]);
    expect(pdf.sections[5]!.head).toEqual(['columns.reason', 'columns.count']);
  });
});
