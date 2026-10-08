'use client';

// Customer list (Docs/superpowers/specs/2026-10-08-customer-list-design.md, Section 1): branch,
// search and group filters; 50 customers at a time with in-branch numbers and groups.
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import { loadManageableBranches, type ManageableBranch } from '../settings/barbers/scope';
import { formatDay, formatRating } from '../reports/format';
import type { CustomerGroup, CustomerList, CustomerRow } from './customerTypes';

const ALL = 'all';
const GROUPS: CustomerGroup[] = ['new', 'returning', 'frequent', 'lapsed', 'at_risk'];
const COLUMNS = ['name', 'phone', 'lastVisit', 'visits', 'noShows', 'avgRating', 'group'] as const;
const SEARCH_DELAY_MS = 400;

type Translate = (key: string, values?: Record<string, string | number>) => string;
type Loaded =
  | { key: string; kind: 'ok'; rows: CustomerRow[]; hasMore: boolean }
  | { key: string; kind: 'error' };

export default function CustomersPage() {
  const t = useTranslations('Customers') as unknown as Translate;
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [canView, setCanView] = useState<boolean | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [branches, setBranches] = useState<ManageableBranch[]>([]);
  const [branchesLoaded, setBranchesLoaded] = useState(false);
  const [branchesFailed, setBranchesFailed] = useState(false);
  const [selection, setSelection] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState('');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [moreFailed, setMoreFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    supabase.rpc('has_capability', { cap: 'view_customers' }).then(({ data }) => {
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
    supabase.rpc('auth_role').then(({ data }) => {
      if (!cancelled) setIsOwner(data === 'owner');
    });
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  // Search applies when typing pauses (or on Enter, below).
  useEffect(() => {
    const id = window.setTimeout(() => setSearch(searchText.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [searchText]);

  const ids = useMemo(
    () => (selection === ALL ? branches.map((b) => b.id) : selection ? [selection] : []),
    [selection, branches],
  );
  const requestKey = `${selection}:${search}:${group}`;

  useEffect(() => {
    if (ids.length === 0) return;
    let cancelled = false;
    const key = requestKey;
    supabase
      .rpc('list_customers', {
        p_branch_ids: ids,
        p_search: search || null,
        p_group: group || null,
        p_offset: 0,
      })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setLoaded({ key, kind: 'error' });
          return;
        }
        const list = data as unknown as CustomerList;
        setLoaded({ key, kind: 'ok', rows: list.rows, hasMore: list.has_more });
      });
    return () => {
      cancelled = true;
    };
  }, [supabase, ids, search, group, requestKey]);

  const current = loaded && loaded.key === requestKey ? loaded : null;

  async function showMore() {
    if (current?.kind !== 'ok') return;
    setMoreFailed(false);
    const key = requestKey;
    const { data, error } = await supabase.rpc('list_customers', {
      p_branch_ids: ids,
      p_search: search || null,
      p_group: group || null,
      p_offset: current.rows.length,
    });
    if (error) {
      setMoreFailed(true);
      return;
    }
    const list = data as unknown as CustomerList;
    setLoaded((prev) =>
      prev && prev.key === key && prev.kind === 'ok'
        ? { ...prev, rows: [...prev.rows, ...list.rows], hasMore: list.has_more }
        : prev,
    );
  }

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
          <label htmlFor="customers-branch">{t('branch')}</label>
          <select
            id="customers-branch"
            value={selection ?? ''}
            onChange={(e) => setSelection(e.target.value)}
          >
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
            {isOwner && branches.length > 1 && <option value={ALL}>{t('allBranches')}</option>}
          </select>
          <label htmlFor="customers-search">{t('search')}</label>
          <input
            id="customers-search"
            type="search"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setSearch(searchText.trim());
            }}
          />
          <label htmlFor="customers-group">{t('group')}</label>
          <select id="customers-group" value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="">{t('groups.all')}</option>
            {GROUPS.map((g) => (
              <option key={g} value={g}>
                {t(`groups.${g}`)}
              </option>
            ))}
          </select>
          <p>{t('legend')}</p>
        </div>
      )}
      {current?.kind === 'error' && <p role="alert">{t('loadFailed')}</p>}
      {current?.kind === 'ok' &&
        (current.rows.length === 0 ? (
          <p>{t('empty')}</p>
        ) : (
          <>
            <table>
              <thead>
                <tr>
                  {COLUMNS.map((c) => (
                    <th key={c} scope="col">
                      {t(`columns.${c}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {current.rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link href={`/customers/${r.id}?branch=${selection}`}>{r.name}</Link>
                    </td>
                    <td>{r.phone ?? '—'}</td>
                    <td>{r.last_visit_at ? formatDay(r.last_visit_at) : '—'}</td>
                    <td>{r.visits}</td>
                    <td>{r.no_shows}</td>
                    <td>{formatRating(r.avg_rating_given)}</td>
                    <td>{t(`groups.${r.group}`)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {current.hasMore && (
              <button type="button" onClick={showMore}>
                {t('showMore')}
              </button>
            )}
            {moreFailed && <p role="alert">{t('loadFailed')}</p>}
          </>
        ))}
    </main>
  );
}
