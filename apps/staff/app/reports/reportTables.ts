// One description of every report table (headers, raw values, display values) used by the Reports
// page, CSV, Excel and PDF, so all four always show the same columns
// (Docs/superpowers/specs/2026-10-08-reports-dashboard-design.md, Section 2).
import type { BranchReport, ReportSummary } from './reportTypes';
import {
  formatCount,
  formatDay,
  formatHour,
  formatMinutes,
  formatMoney,
  formatPercent,
  formatRating,
} from './format';

export type Cell = string | number | null;
export type Label = (key: string, values?: Record<string, string | number>) => string;

export interface SummaryItem {
  key: string;
  label: string;
  raw: Cell;
  display: string;
}

export interface ReportTable {
  key: 'daily' | 'hours' | 'barbers' | 'services' | 'reasons' | 'branches';
  /** Used in CSV file names: pixel-barber-{fileKey}-{from}-{to}.csv */
  fileKey: string;
  title: string;
  headers: string[];
  raw: Cell[][];
  display: string[][];
  /** Index of the Estimated takings column (the PDF adds "(GHS)" to its header). */
  takingsColumn: number | null;
  /** 0–1 per row for Busiest hours shading; null elsewhere. */
  shade: number[] | null;
}

interface Column<R> {
  label: string;
  raw: (r: R) => Cell;
  display: (r: R) => string;
  takings?: boolean;
}

function makeTable<R>(
  key: ReportTable['key'],
  fileKey: string,
  title: string,
  rows: R[],
  columns: Column<R>[],
  shade: number[] | null = null,
): ReportTable {
  const takings = columns.findIndex((c) => c.takings);
  return {
    key,
    fileKey,
    title,
    headers: columns.map((c) => c.label),
    raw: rows.map((r) => columns.map((c) => c.raw(r))),
    display: rows.map((r) => columns.map((c) => c.display(r))),
    takingsColumn: takings === -1 ? null : takings,
    shade,
  };
}

type Num = number | null;
const count = <R>(label: string, get: (r: R) => Num): Column<R> => ({
  label,
  raw: get,
  display: (r) => formatCount(get(r)),
});
const minutes = <R>(label: string, get: (r: R) => Num): Column<R> => ({
  label,
  raw: get,
  display: (r) => formatMinutes(get(r)),
});
const percent = <R>(label: string, get: (r: R) => Num): Column<R> => ({
  label,
  raw: get,
  display: (r) => formatPercent(get(r)),
});
const rating = <R>(label: string, get: (r: R) => Num): Column<R> => ({
  label,
  raw: get,
  display: (r) => formatRating(get(r)),
});
const money = <R>(label: string, get: (r: R) => Num): Column<R> => ({
  label,
  raw: get,
  display: (r) => formatMoney(get(r)),
  takings: true,
});
const text = <R>(label: string, get: (r: R) => string): Column<R> => ({
  label,
  raw: get,
  display: get,
});

function summaryColumns<R extends ReportSummary>(label: Label): Column<R>[] {
  return [
    count(label('columns.served'), (r) => r.served),
    count(label('columns.walkIns'), (r) => r.walk_ins),
    count(label('columns.appointments'), (r) => r.appointments),
    count(label('columns.noShows'), (r) => r.no_shows),
    percent(label('columns.noShowRate'), (r) => r.no_show_rate),
    count(label('columns.cancellations'), (r) => r.cancellations),
    percent(label('columns.cancellationRate'), (r) => r.cancellation_rate),
    minutes(label('columns.avgWait'), (r) => r.avg_wait_min),
    minutes(label('columns.medianWait'), (r) => r.median_wait_min),
    minutes(label('columns.avgService'), (r) => r.avg_service_min),
    count(label('columns.ratingCount'), (r) => r.rating_count),
    rating(label('columns.ratingAverage'), (r) => r.rating_average),
    money(label('columns.takings'), (r) => r.est_takings_ghs),
    percent(label('columns.returning'), (r) => r.returning_rate),
  ];
}

export function buildSummaryItems(s: ReportSummary, label: Label): SummaryItem[] {
  const item = (key: keyof ReportSummary, labelKey: string, display: string): SummaryItem => ({
    key,
    label: label(`summary.${labelKey}`),
    raw: s[key],
    display,
  });
  return [
    item('served', 'served', formatCount(s.served)),
    item('walk_ins', 'walkIns', formatCount(s.walk_ins)),
    item('appointments', 'appointments', formatCount(s.appointments)),
    item('no_shows', 'noShows', formatCount(s.no_shows)),
    item('no_show_rate', 'noShowRate', formatPercent(s.no_show_rate)),
    item('cancellations', 'cancellations', formatCount(s.cancellations)),
    item('cancellation_rate', 'cancellationRate', formatPercent(s.cancellation_rate)),
    item('avg_wait_min', 'avgWait', formatMinutes(s.avg_wait_min)),
    item('median_wait_min', 'medianWait', formatMinutes(s.median_wait_min)),
    item('avg_service_min', 'avgService', formatMinutes(s.avg_service_min)),
    item('rating_count', 'ratingCount', formatCount(s.rating_count)),
    item('rating_average', 'ratingAverage', formatRating(s.rating_average)),
    item(
      'est_takings_ghs',
      'takings',
      `${formatMoney(s.est_takings_ghs)} ${label('summary.estimatedSuffix')}`,
    ),
    item('returning_rate', 'returning', formatPercent(s.returning_rate)),
  ];
}

export function buildReportTables(report: BranchReport, label: Label): ReportTable[] {
  const maxJoined = Math.max(0, ...report.hours.map((h) => h.avg_joined_per_day));
  const tables: ReportTable[] = [
    makeTable('daily', 'daily', label('tables.daily'), report.daily, [
      { label: label('columns.date'), raw: (r) => r.date, display: (r) => formatDay(r.date) },
      count(label('columns.served'), (r) => r.served),
      count(label('columns.walkIns'), (r) => r.walk_ins),
      count(label('columns.appointments'), (r) => r.appointments),
      count(label('columns.noShows'), (r) => r.no_shows),
      count(label('columns.cancellations'), (r) => r.cancellations),
      minutes(label('columns.avgWait'), (r) => r.avg_wait_min),
      minutes(label('columns.avgService'), (r) => r.avg_service_min),
      rating(label('columns.ratingAverage'), (r) => r.rating_average),
      money(label('columns.takings'), (r) => r.est_takings_ghs),
    ]),
    makeTable(
      'hours',
      'hours',
      label('tables.hours'),
      report.hours,
      [
        { label: label('columns.hour'), raw: (r) => r.hour, display: (r) => formatHour(r.hour) },
        {
          label: label('columns.joinedPerDay'),
          raw: (r) => r.avg_joined_per_day,
          display: (r) => Number(r.avg_joined_per_day).toFixed(1),
        },
        minutes(label('columns.avgWait'), (r) => r.avg_wait_min),
      ],
      report.hours.map((h) => (maxJoined > 0 ? h.avg_joined_per_day / maxJoined : 0)),
    ),
    makeTable('barbers', 'barbers', label('tables.barbers'), report.barbers, [
      text(label('columns.barber'), (r) => r.name),
      count(label('columns.served'), (r) => r.served),
      minutes(label('columns.avgService'), (r) => r.avg_service_min),
      count(label('columns.noShows'), (r) => r.no_shows),
      rating(label('columns.ratingAverage'), (r) => r.rating_average),
      money(label('columns.takings'), (r) => r.est_takings_ghs),
    ]),
    makeTable('services', 'services', label('tables.services'), report.services, [
      text(label('columns.service'), (r) => r.name),
      count(label('columns.served'), (r) => r.served),
      percent(label('columns.share'), (r) => r.share),
      minutes(label('columns.avgService'), (r) => r.avg_service_min),
      minutes(label('columns.listedDuration'), (r) => r.listed_duration_min),
      money(label('columns.takings'), (r) => r.est_takings_ghs),
    ]),
    makeTable('reasons', 'cancellation-reasons', label('tables.reasons'), report.cancel_reasons, [
      text(label('columns.reason'), (r) => label(`reasons.${r.reason}`)),
      count(label('columns.count'), (r) => r.count),
    ]),
  ];
  if (report.branches) {
    tables.push(
      makeTable('branches', 'branches', label('tables.branches'), report.branches, [
        text(label('columns.branch'), (r) => r.name),
        ...summaryColumns(label),
      ]),
    );
  }
  return tables;
}
