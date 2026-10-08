import { describe, expect, it } from 'vitest';
import { buildReportTables, buildSummaryItems, type Label, type ReportTable } from './reportTables';
import { sampleAllBranches, sampleReport } from './__fixtures__/sampleReport';

// Labels come back as their keys so the tests can see which copy each cell uses.
const label: Label = (key) => key;

describe('buildSummaryItems', () => {
  it('lists every summary number with raw and display values', () => {
    const items = buildSummaryItems(sampleReport.summary, label);
    expect(items.map((i) => i.key)).toEqual([
      'served',
      'walk_ins',
      'appointments',
      'no_shows',
      'no_show_rate',
      'cancellations',
      'cancellation_rate',
      'avg_wait_min',
      'median_wait_min',
      'avg_service_min',
      'rating_count',
      'rating_average',
      'est_takings_ghs',
      'returning_rate',
    ]);
    expect(items[0]).toEqual({ key: 'served', label: 'summary.served', raw: 3, display: '3' });
    expect(items.find((i) => i.key === 'avg_wait_min')).toMatchObject({
      raw: 18,
      display: '18 min',
    });
    expect(items.find((i) => i.key === 'est_takings_ghs')).toMatchObject({
      raw: 1250,
      display: 'GHS 1,250.00 summary.estimatedSuffix',
    });
    expect(items.find((i) => i.key === 'no_show_rate')).toMatchObject({
      raw: 25,
      display: '25.0%',
    });
  });
});

describe('buildReportTables', () => {
  it('builds the five tables for one branch in page order', () => {
    const tables = buildReportTables(sampleReport, label);
    expect(tables.map((t) => [t.key, t.fileKey, t.title])).toEqual([
      ['daily', 'daily', 'tables.daily'],
      ['hours', 'hours', 'tables.hours'],
      ['barbers', 'barbers', 'tables.barbers'],
      ['services', 'services', 'tables.services'],
      ['reasons', 'cancellation-reasons', 'tables.reasons'],
    ]);
  });

  it('keeps raw values for exports and formatted values for the page', () => {
    const [daily, hours, barbers, services, reasons] = buildReportTables(sampleReport, label) as [
      ReportTable,
      ReportTable,
      ReportTable,
      ReportTable,
      ReportTable,
    ];
    expect(daily.headers).toEqual([
      'columns.date',
      'columns.served',
      'columns.walkIns',
      'columns.appointments',
      'columns.noShows',
      'columns.cancellations',
      'columns.avgWait',
      'columns.avgService',
      'columns.ratingAverage',
      'columns.takings',
    ]);
    expect(daily.raw[1]).toEqual(['2026-09-29', 1, 0, 1, 0, 1, null, null, null, 350]);
    expect(daily.display[1]).toEqual([
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
    expect(daily.takingsColumn).toBe(9);
    expect(hours.raw).toEqual([
      [10, 2, 25],
      [14, 1, null],
    ]);
    expect(hours.display[0]).toEqual(['10:00', '2.0', '25 min']);
    expect(hours.shade).toEqual([1, 0.5]);
    expect(barbers.raw[0]).toEqual(['Kofi', 3, 25, 1, 3.5, 1250]);
    expect(barbers.display[0]).toEqual(['Kofi', '3', '25 min', '1', '3.50', 'GHS 1,250.00']);
    expect(services.headers).toEqual([
      'columns.service',
      'columns.served',
      'columns.share',
      'columns.avgService',
      'columns.listedDuration',
      'columns.takings',
    ]);
    expect(services.display[0]).toEqual([
      'Haircut',
      '3',
      '100.0%',
      '25 min',
      '30 min',
      'GHS 1,250.00',
    ]);
    expect(reasons.raw[0]).toEqual(['reasons.cant_make_it', 1]);
    expect(reasons.takingsColumn).toBeNull();
  });

  it('adds the branch comparison when several branches are shown', () => {
    const tables = buildReportTables(sampleAllBranches, label);
    const branches = tables[tables.length - 1]!;
    expect(branches.key).toBe('branches');
    expect(branches.fileKey).toBe('branches');
    expect(branches.headers[0]).toBe('columns.branch');
    expect(branches.headers).toHaveLength(15);
    expect(branches.raw[1]![0]).toBe('Tema');
    expect(branches.display[1]![8]).toBe('—');
  });
});
