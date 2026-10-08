'use client';

// Reports (Docs/superpowers/specs/2026-10-08-reports-dashboard-design.md, Section 2): branch (or
// all branches) and period filters, summary cards and the report tables, each with a CSV download.
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import { loadManageableBranches, type ManageableBranch } from '../settings/barbers/scope';
import { Metric } from './Metric';
import { presetRange, type Preset } from './presets';
import { toCsv } from './csv';
import { downloadBlob } from './download';
import { buildPdfContent, buildWorkbookSheets } from './exportContent';
import { downloadExcel, downloadPdf, reportFileName } from './exportFiles';
import { buildReportTables, buildSummaryItems, type Label, type ReportTable } from './reportTables';
import type { BranchReport } from './reportTypes';

const ALL = 'all';
const PRESETS: Preset[] = ['last7', 'last30', 'thisMonth', 'lastMonth', 'custom'];
const ghanaToday = () => new Date().toISOString().slice(0, 10);

type Loaded =
  | { key: string; kind: 'ok'; report: BranchReport; from: string; to: string }
  | { key: string; kind: 'invalid' | 'error' };

export default function ReportsPage() {
  const t = useTranslations('Reports');
  const label = t as unknown as Label;
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [canView, setCanView] = useState<boolean | null>(null);
  const [canAll, setCanAll] = useState(false);
  const [branches, setBranches] = useState<ManageableBranch[]>([]);
  const [branchesLoaded, setBranchesLoaded] = useState(false);
  const [branchesFailed, setBranchesFailed] = useState(false);
  const [selection, setSelection] = useState<string | null>(null);
  const [preset, setPreset] = useState<Preset>('last7');
  const [range, setRange] = useState(() => presetRange('last7', ghanaToday()));
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    let cancelled = false;
    supabase.rpc('has_capability', { cap: 'view_branch_reports' }).then(({ data }) => {
      if (cancelled) return;
      setCanView(data === true);
      if (data !== true) return;
      loadManageableBranches(supabase)
        .then((list) => {
          if (cancelled) return;
          setBranches(list);
          setBranchesLoaded(true);
          setSelection((prev) => prev ?? list[0]?.id ?? null);
        })
        .catch(() => {
          if (!cancelled) setBranchesFailed(true);
        });
    });
    supabase.rpc('has_capability', { cap: 'view_business_reports' }).then(({ data }) => {
      if (!cancelled) setCanAll(data === true);
    });
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  const requestKey = `${selection}:${range.from}:${range.to}`;

  useEffect(() => {
    if (!selection) return;
    const ids = selection === ALL ? branches.map((b) => b.id) : [selection];
    if (ids.length === 0) return;
    let cancelled = false;
    const key = requestKey;
    const { from, to } = range;
    supabase
      .rpc('branch_report', { p_branch_ids: ids, p_from: from, p_to: to })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setLoaded({ key, kind: error.message === 'invalid_range' ? 'invalid' : 'error' });
          return;
        }
        setLoaded({ key, kind: 'ok', report: data as unknown as BranchReport, from, to });
      });
    return () => {
      cancelled = true;
    };
  }, [supabase, selection, branches, range, requestKey]);

  function choosePreset(next: Preset) {
    setPreset(next);
    if (next !== 'custom') setRange(presetRange(next, ghanaToday()));
  }

  const current = loaded && loaded.key === requestKey ? loaded : null;
  const selectedBranch = branches.find((b) => b.id === selection);
  const branchName = selection === ALL ? t('allBranches') : (selectedBranch?.name ?? '');
  const branchCode = selection === ALL ? 'all' : (selectedBranch?.branch_code ?? 'branch');

  return (
    <main>
      <h1>{t('title')}</h1>
      {canView === false && <p>{t('noAccess')}</p>}
      {canView === true && branchesFailed && <p role="alert">{t('loadFailed')}</p>}
      {canView === true && !branchesFailed && branchesLoaded && branches.length === 0 && (
        <p>{t('noBranches')}</p>
      )}
      {branches.length > 0 && (
        <div>
          <label htmlFor="report-branch">{t('branch')}</label>
          <select
            id="report-branch"
            value={selection ?? ''}
            onChange={(e) => setSelection(e.target.value)}
          >
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
            {canAll && branches.length > 1 && <option value={ALL}>{t('allBranches')}</option>}
          </select>
          <label htmlFor="report-period">{t('period')}</label>
          <select
            id="report-period"
            value={preset}
            onChange={(e) => choosePreset(e.target.value as Preset)}
          >
            {PRESETS.map((p) => (
              <option key={p} value={p}>
                {label(`presets.${p}`)}
              </option>
            ))}
          </select>
          {preset === 'custom' && (
            <>
              <label htmlFor="report-from">{t('from')}</label>
              <input
                id="report-from"
                type="date"
                value={range.from}
                onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
              />
              <label htmlFor="report-to">{t('to')}</label>
              <input
                id="report-to"
                type="date"
                value={range.to}
                onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
              />
            </>
          )}
        </div>
      )}
      {current?.kind === 'invalid' && <p role="alert">{t('invalidRange')}</p>}
      {current?.kind === 'error' && <p role="alert">{t('loadFailed')}</p>}
      {current?.kind === 'ok' &&
        (current.report.hours.length === 0 ? (
          <p>{t('empty')}</p>
        ) : (
          <ReportView
            report={current.report}
            from={current.from}
            to={current.to}
            label={label}
            branchName={branchName}
            branchCode={branchCode}
          />
        ))}
    </main>
  );
}

function ReportView({
  report,
  from,
  to,
  label,
  branchName,
  branchCode,
}: {
  report: BranchReport;
  from: string;
  to: string;
  label: Label;
  branchName: string;
  branchCode: string;
}) {
  const [exportFailed, setExportFailed] = useState(false);
  async function exportFile(kind: 'xlsx' | 'pdf') {
    setExportFailed(false);
    const generatedAt = new Date().toLocaleString('en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    });
    const input = { report, label, branchName, from, to, generatedAt };
    const fileName = reportFileName(branchCode, from, to, kind);
    try {
      if (kind === 'xlsx') await downloadExcel(buildWorkbookSheets(input), fileName);
      else await downloadPdf(buildPdfContent(input), fileName);
    } catch {
      setExportFailed(true);
    }
  }
  const items = buildSummaryItems(report.summary, label);
  const tables = buildReportTables(report, label);
  return (
    <>
      <div>
        <button type="button" onClick={() => exportFile('xlsx')}>
          {label('downloadExcel')}
        </button>
        <button type="button" onClick={() => exportFile('pdf')}>
          {label('downloadPdf')}
        </button>
        {exportFailed && <p role="alert">{label('exportFailed')}</p>}
      </div>
      <section aria-labelledby="report-summary">
        <h2 id="report-summary">{label('summary.title')}</h2>
        {items.map((i) => (
          <Metric key={i.key} label={i.label} value={i.display} />
        ))}
      </section>
      {tables.map((table) => (
        <TableSection key={table.key} table={table} from={from} to={to} label={label} />
      ))}
    </>
  );
}

function TableSection({
  table,
  from,
  to,
  label,
}: {
  table: ReportTable;
  from: string;
  to: string;
  label: Label;
}) {
  const headingId = `report-${table.key}`;
  function downloadCsv() {
    const csv = '\uFEFF' + toCsv(table.headers, table.raw);
    downloadBlob(
      new Blob([csv], { type: 'text/csv;charset=utf-8' }),
      `pixel-barber-${table.fileKey}-${from}-${to}.csv`,
    );
  }
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId}>{table.title}</h2>
      <table>
        <thead>
          <tr>
            {table.headers.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.display.map((row, i) => (
            <tr
              key={i}
              style={
                table.shade
                  ? {
                      background: `rgba(29, 78, 216, ${(0.08 + 0.32 * (table.shade[i] ?? 0)).toFixed(2)})`,
                    }
                  : undefined
              }
            >
              {row.map((v, j) => (
                <td key={j}>{v}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" onClick={downloadCsv}>
        {label('downloadCsv')}
      </button>
    </section>
  );
}
