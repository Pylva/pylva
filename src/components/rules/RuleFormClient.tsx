// B2a T3 — client-side rule form. Renders per-type config fields + common
// meta (name, customer_id, enabled). On submit, POSTs /api/v1/rules and
// redirects to /rules on success.

'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation.js';
import { apiFetch } from '@/lib/dashboard/api-client';
import { Button } from '@/components/ui/button';

type RuleType = 'cost_threshold' | 'budget_limit' | 'margin_protection';
type TargetMode = 'all' | 'one';
type BudgetPool = 'per_customer' | 'pooled';

interface CustomerOption {
  id: string;
  external_id: string;
  name: string | null;
  email: string | null;
}

const TITLES: Record<RuleType, string> = {
  cost_threshold: 'Alert on a cost spike',
  budget_limit: "Cap an end-user's daily spend",
  margin_protection: 'Protect my margin',
};

export function RuleFormClient({ type }: { type: RuleType }) {
  const router = useRouter();
  const [name, setName] = useState(TITLES[type]);
  const [targetMode, setTargetMode] = useState<TargetMode>('all');
  const [customerQuery, setCustomerQuery] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerOption | null>(null);
  const [cfg, setCfg] = useState<Record<string, unknown>>(defaultConfig(type));
  const [allUserScope, setAllUserScope] = useState<BudgetPool>('per_customer');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function onTargetModeChange(next: TargetMode) {
    setError(null);
    setTargetMode(next);
    if (next === 'all') {
      setCustomerQuery('');
      setSelectedCustomer(null);
      setCfg((current) => ({ ...current, scope: allUserScope }));
      return;
    }
    setCfg((current) => ({ ...current, scope: 'per_customer' }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (targetMode === 'one' && !selectedCustomer) {
      setError('Choose an end-user from the list.');
      return;
    }
    setSubmitting(true);
    try {
      const config = targetMode === 'one' ? { ...cfg, scope: 'per_customer' } : cfg;
      const body = {
        type,
        name,
        enabled: true,
        customer_id: targetMode === 'one' ? selectedCustomer!.external_id : null,
        config,
      };
      const res = await apiFetch('/api/v1/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? 'Could not create rule');
        return;
      }
      router.push('../');
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mx-auto max-w-xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">{TITLES[type]}</h1>

      <Field label="Rule name" htmlFor="rule-name">
        <input
          id="rule-name"
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-md border border-[color:var(--input)] bg-[color:var(--background)] px-3 py-1.5 text-sm"
        />
      </Field>

      <Field
        label="Applies to"
        htmlFor="rule-target-mode"
        hint={
          targetMode === 'all'
            ? 'This rule will apply to every end-user.'
            : 'Search by end-user name, ID, or email, then choose a listed end-user.'
        }
      >
        <select
          id="rule-target-mode"
          value={targetMode}
          onChange={(e) => onTargetModeChange(e.target.value as TargetMode)}
          className="w-full rounded-md border border-[color:var(--input)] bg-[color:var(--background)] px-3 py-1.5 text-sm"
        >
          <option value="all">All end-users</option>
          <option value="one">One end-user</option>
        </select>
      </Field>

      <Field
        label="End-user"
        htmlFor="rule-customer-id"
        hint={
          targetMode === 'all'
            ? 'Disabled because this rule applies to every end-user.'
            : 'Only listed end-users can be selected.'
        }
      >
        {targetMode === 'all' ? (
          <input
            id="rule-customer-id"
            type="text"
            value=""
            placeholder="All end-users"
            disabled
            className="w-full rounded-md border border-[color:var(--input)] bg-[color:var(--background)] px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:bg-[color:var(--muted)] disabled:text-[color:var(--muted-foreground)]"
          />
        ) : (
          <EndUserSelector
            query={customerQuery}
            selectedCustomer={selectedCustomer}
            onQueryChange={(next) => {
              setError(null);
              setCustomerQuery(next);
              setSelectedCustomer(null);
            }}
            onSelect={(customer) => {
              setError(null);
              setSelectedCustomer(customer);
              setCustomerQuery(customerInputLabel(customer));
            }}
          />
        )}
      </Field>

      {targetMode === 'all' ? (
        <BudgetPoolField
          cfg={cfg}
          onScopeChange={(scope) => {
            setAllUserScope(scope);
            setCfg({ ...cfg, scope });
          }}
        />
      ) : null}

      <ConfigFields type={type} cfg={cfg} setCfg={setCfg} />

      {error ? <p className="text-sm text-[color:var(--destructive)]">{error}</p> : null}

      <div className="flex gap-2">
        <Button type="submit" disabled={submitting || (targetMode === 'one' && !selectedCustomer)}>
          {submitting ? 'Creating…' : 'Create rule'}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()}>
          Cancel
        </Button>
      </div>

      <div className="rounded-md border border-[color:var(--border)] bg-[color:var(--muted)] p-3 text-xs text-[color:var(--muted-foreground)]">
        Alert channels (webhook / email / Slack) can be added to this rule after creation on the
        rule detail page.
      </div>
    </form>
  );
}

function EndUserSelector({
  query,
  selectedCustomer,
  onQueryChange,
  onSelect,
}: {
  query: string;
  selectedCustomer: CustomerOption | null;
  onQueryChange: (query: string) => void;
  onSelect: (customer: CustomerOption) => void;
}) {
  const [options, setOptions] = useState<CustomerOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [open, setOpen] = useState(true);
  const latestRequest = useRef(0);

  useEffect(() => {
    let alive = true;
    const requestId = latestRequest.current + 1;
    latestRequest.current = requestId;
    setLoading(true);
    setLoadError(null);

    const params = new URLSearchParams({ search: query, limit: '500' });
    apiFetch(`/api/v1/customers/search?${params.toString()}`)
      .then(async (res) => {
        if (!res.ok) throw new Error('Could not load end-users');
        return (await res.json()) as {
          customers?: CustomerOption[];
          has_more?: boolean;
        };
      })
      .then((body) => {
        if (!alive || requestId !== latestRequest.current) return;
        setOptions(Array.isArray(body.customers) ? body.customers : []);
        setHasMore(body.has_more === true);
      })
      .catch(() => {
        if (!alive || requestId !== latestRequest.current) return;
        setOptions([]);
        setHasMore(false);
        setLoadError('Could not load end-users.');
      })
      .finally(() => {
        if (!alive || requestId !== latestRequest.current) return;
        setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [query]);

  return (
    <div className="relative">
      <input
        id="rule-customer-id"
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls="rule-customer-options"
        aria-describedby="rule-customer-selected"
        value={query}
        onChange={(e) => {
          onQueryChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          window.setTimeout(() => setOpen(false), 120);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
        placeholder="Search end-users"
        required
        className="w-full rounded-md border border-[color:var(--input)] bg-[color:var(--background)] px-3 py-1.5 text-sm"
      />
      <p id="rule-customer-selected" className="sr-only">
        {selectedCustomer
          ? `Selected ${customerInputLabel(selectedCustomer)}`
          : 'No end-user selected'}
      </p>
      {open ? (
        <div
          id="rule-customer-options"
          role="listbox"
          className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-[color:var(--border)] bg-[color:var(--background)] p-1 shadow-lg"
        >
          {loading ? (
            <div role="status" className="px-3 py-2 text-sm text-[color:var(--muted-foreground)]">
              Loading end-users…
            </div>
          ) : null}
          {!loading && loadError ? (
            <div role="alert" className="px-3 py-2 text-sm text-[color:var(--destructive)]">
              {loadError}
            </div>
          ) : null}
          {!loading && !loadError && options.length === 0 ? (
            <div className="px-3 py-2 text-sm text-[color:var(--muted-foreground)]">
              No matching end-users
            </div>
          ) : null}
          {!loading && !loadError
            ? options.map((customer) => {
                const selected = selectedCustomer?.external_id === customer.external_id;
                return (
                  <button
                    key={customer.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      onSelect(customer);
                      setOpen(false);
                    }}
                    className={`flex w-full flex-col rounded-sm px-3 py-2 text-left text-sm hover:bg-[color:var(--accent)] ${
                      selected ? 'bg-[color:var(--accent)]' : ''
                    }`}
                  >
                    <span className="font-medium">{customerPrimaryLabel(customer)}</span>
                    <span className="text-xs text-[color:var(--muted-foreground)]">
                      {customerSecondaryLabel(customer)}
                    </span>
                  </button>
                );
              })
            : null}
          {!loading && !loadError && hasMore ? (
            <div className="border-t border-[color:var(--border)] px-3 py-2 text-xs text-[color:var(--muted-foreground)]">
              Keep typing to narrow the list.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function customerPrimaryLabel(customer: CustomerOption): string {
  return customer.name?.trim() || customer.external_id;
}

function customerSecondaryLabel(customer: CustomerOption): string {
  const parts = customer.name?.trim()
    ? [customer.external_id, customer.email].filter(Boolean)
    : [customer.email].filter(Boolean);
  return parts.join(' · ') || customer.external_id;
}

function customerInputLabel(customer: CustomerOption): string {
  const name = customer.name?.trim();
  return name ? `${name} (${customer.external_id})` : customer.external_id;
}

function defaultConfig(type: RuleType): Record<string, unknown> {
  switch (type) {
    case 'budget_limit':
      return { limit_usd: 50, period: 'day', hard_stop: true, scope: 'per_customer' };
    case 'cost_threshold':
      return { threshold_usd: 25, period: 'day', scope: 'per_customer' };
    case 'margin_protection':
      return { margin_threshold_pct: 15, period: 'day', scope: 'per_customer' };
  }
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="text-xs uppercase tracking-wider text-[color:var(--muted-foreground)]"
      >
        {label}
      </label>
      <div className="mt-1">{children}</div>
      {hint ? <p className="mt-1 text-xs text-[color:var(--muted-foreground)]">{hint}</p> : null}
    </div>
  );
}

function ConfigFields({
  type,
  cfg,
  setCfg,
}: {
  type: RuleType;
  cfg: Record<string, unknown>;
  setCfg: (cfg: Record<string, unknown>) => void;
}) {
  const set = (key: string, value: unknown) => setCfg({ ...cfg, [key]: value });

  if (type === 'budget_limit') {
    return (
      <>
        <Field label="Limit (USD)">
          <input
            type="number"
            step="0.01"
            min="0"
            required
            value={String(cfg.limit_usd ?? 50)}
            onChange={(e) => set('limit_usd', Number(e.target.value))}
            className="w-full rounded-md border border-[color:var(--input)] bg-[color:var(--background)] px-3 py-1.5 text-sm"
          />
        </Field>
        <PeriodField cfg={cfg} set={set} />
        <Field label="Enforcement">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={cfg.hard_stop !== false}
              onChange={(e) => set('hard_stop', e.target.checked)}
            />
            Hard stop — SDK throws PylvaBudgetExceeded pre-call
          </label>
        </Field>
      </>
    );
  }
  if (type === 'cost_threshold') {
    return (
      <>
        <Field label="Threshold (USD)">
          <input
            type="number"
            step="0.01"
            min="0"
            required
            value={String(cfg.threshold_usd ?? 25)}
            onChange={(e) => set('threshold_usd', Number(e.target.value))}
            className="w-full rounded-md border border-[color:var(--input)] bg-[color:var(--background)] px-3 py-1.5 text-sm"
          />
        </Field>
        <PeriodField cfg={cfg} set={set} />
      </>
    );
  }
  // margin_protection
  return (
    <>
      <Field label="Margin threshold (%)">
        <input
          type="number"
          step="1"
          min="0"
          max="100"
          required
          value={String(cfg.margin_threshold_pct ?? 15)}
          onChange={(e) => set('margin_threshold_pct', Number(e.target.value))}
          className="w-full rounded-md border border-[color:var(--input)] bg-[color:var(--background)] px-3 py-1.5 text-sm"
        />
      </Field>
      <PeriodField cfg={cfg} set={set} />
    </>
  );
}

function PeriodField({
  cfg,
  set,
}: {
  cfg: Record<string, unknown>;
  set: (k: string, v: unknown) => void;
}) {
  return (
    <Field label="Period" htmlFor="rule-period">
      <select
        id="rule-period"
        value={String(cfg.period ?? 'day')}
        onChange={(e) => set('period', e.target.value)}
        className="w-full rounded-md border border-[color:var(--input)] bg-[color:var(--background)] px-3 py-1.5 text-sm"
      >
        <option value="hour">Hour</option>
        <option value="day">Day</option>
        <option value="week">Week</option>
        <option value="month">Month</option>
      </select>
    </Field>
  );
}

function BudgetPoolField({
  cfg,
  onScopeChange,
}: {
  cfg: Record<string, unknown>;
  onScopeChange: (scope: BudgetPool) => void;
}) {
  return (
    <Field
      label="Budget pool"
      htmlFor="rule-budget-pool"
      hint="Choose whether each end-user gets their own threshold or everyone shares one pool."
    >
      <select
        id="rule-budget-pool"
        value={String(cfg.scope ?? 'per_customer')}
        onChange={(e) => onScopeChange(e.target.value as BudgetPool)}
        className="w-full rounded-md border border-[color:var(--input)] bg-[color:var(--background)] px-3 py-1.5 text-sm"
      >
        <option value="per_customer">Separate for each end-user</option>
        <option value="pooled">Shared across all end-users</option>
      </select>
    </Field>
  );
}
