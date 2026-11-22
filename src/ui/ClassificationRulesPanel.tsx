import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Plus, ShieldCheck, Trash2, X } from 'lucide-react';
import { getDb } from '@/core/db/db';
import {
  createClassificationRule,
  deleteClassificationRule,
  ensureSeedClassificationRules,
  getAutoPostSettings,
  setAutoPostSettings,
  updateClassificationRule,
  type AutoPostSettings,
} from '@/core/autopilot';
import { CLASSIFICATION_MATCH_TYPES, type ClassificationRule, type Ledger } from '@/core/model';

interface Props {
  workspaceId: string;
  onChanged?: ((message: string) => void) | undefined;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function formatMatchType(type: ClassificationRule['matchType']): string {
  switch (type) {
    case 'narration-keyword':
      return 'Narration keyword';
    case 'party':
      return 'Party name';
    case 'reference':
      return 'Reference / UTR';
    case 'amount-date-party':
      return 'Amount, date & party';
    case 'tax-hint':
      return 'Tax hint';
    default:
      return String(type);
  }
}

export function ClassificationRulesPanel({ workspaceId, onChanged }: Props) {
  const [rules, setRules] = useState<ClassificationRule[]>([]);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [settings, setSettings] = useState<AutoPostSettings>({ enabled: false, categories: {} });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const [showAdd, setShowAdd] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [matchType, setMatchType] = useState<ClassificationRule['matchType']>('narration-keyword');
  const [pattern, setPattern] = useState('');
  const [ledgerId, setLedgerId] = useState('');
  const [confidence, setConfidence] = useState('0.85');

  const ledgerOptions = useMemo(
    () => ledgers.filter((ledger) => !ledger.archived).sort((a, b) => a.name.localeCompare(b.name)),
    [ledgers],
  );
  const ledgerById = useMemo(() => new Map(ledgers.map((ledger) => [ledger.id, ledger])), [ledgers]);
  const categories = useMemo(() => {
    const ids = [...new Set(rules.map((rule) => rule.ledgerId))];
    return ids
      .map((id) => ledgerById.get(id))
      .filter((ledger): ledger is Ledger => Boolean(ledger))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [ledgerById, rules]);

  async function load() {
    setLoading(true);
    try {
      const db = getDb();
      const [nextRules, nextLedgers, nextSettings] = await Promise.all([
        ensureSeedClassificationRules(db, workspaceId),
        db.ledgers.where('workspaceId').equals(workspaceId).toArray(),
        getAutoPostSettings(db, workspaceId),
      ]);
      setRules(nextRules.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name)));
      setLedgers(nextLedgers);
      setSettings(nextSettings);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  async function addRule(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !pattern.trim() || !ledgerId) {
      setError('Rule name, pattern, and category ledger are required.');
      return;
    }
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await createClassificationRule(getDb(), workspaceId, {
        name: name.trim(),
        matchType,
        pattern: pattern.trim(),
        ledgerId,
        confidence: Math.max(0, Math.min(1, Number(confidence) || 0.85)),
      });
      setName('');
      setPattern('');
      setShowAdd(false);
      const message = 'Classification rule added.';
      setNotice(message);
      onChanged?.(message);
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function toggleRule(rule: ClassificationRule, enabled: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      await updateClassificationRule(getDb(), workspaceId, rule.id, { enabled });
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function changeRuleLedger(rule: ClassificationRule, nextLedgerId: string) {
    setBusy(true);
    setError(undefined);
    try {
      await updateClassificationRule(getDb(), workspaceId, rule.id, { ledgerId: nextLedgerId });
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function removeRule(rule: ClassificationRule) {
    setBusy(true);
    setError(undefined);
    try {
      await deleteClassificationRule(getDb(), workspaceId, rule.id);
      setConfirmDeleteId(null);
      const message = `Deleted rule “${rule.name}”.`;
      setNotice(message);
      onChanged?.(message);
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings(next: AutoPostSettings) {
    setBusy(true);
    setError(undefined);
    try {
      setSettings(await setAutoPostSettings(getDb(), workspaceId, next));
      const message = 'Auto-post preferences saved.';
      setNotice(message);
      onChanged?.(message);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function toggleCategory(categoryLedgerId: string, enabled: boolean) {
    await saveSettings({
      ...settings,
      categories: { ...settings.categories, [categoryLedgerId]: enabled },
    });
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-50">
            Classification rules
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Automatically suggest accounts for bank statements and email receipts in Money Inbox.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowAdd((open) => !open)}
          className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white transition hover:bg-indigo-700"
        >
          {showAdd ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          <span>{showAdd ? 'Close form' : 'Add rule'}</span>
        </button>
      </div>

      {error ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300">
          {notice}
        </div>
      ) : null}

      {loading ? (
        <div className="py-12 text-center text-sm text-slate-500 dark:text-slate-400">
          Loading classification rules...
        </div>
      ) : (
        <>
          {/* Auto-post safety block */}
          <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#111827]">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-indigo-600 dark:text-indigo-400" />
                <div>
                  <div className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                    Auto-post high-confidence matches
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                    Off by default. When enabled, only events above 95% confidence with no tax
                    implications and an attached source document post automatically.
                  </p>
                </div>
              </div>
              <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
                <input
                  type="checkbox"
                  checked={settings.enabled}
                  disabled={busy}
                  onChange={(event) =>
                    void saveSettings({ ...settings, enabled: event.target.checked })
                  }
                  className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-700 dark:bg-slate-900"
                />
                <span>{settings.enabled ? 'Enabled' : 'Disabled'}</span>
              </label>
            </div>

            {settings.enabled && categories.length > 0 ? (
              <div className="mt-4 border-t border-slate-100 pt-4 dark:border-slate-800">
                <div className="mb-2.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                  Eligible accounts for auto-post
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {categories.map((ledger) => (
                    <label
                      key={ledger.id}
                      className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800/40"
                    >
                      <input
                        type="checkbox"
                        checked={settings.categories[ledger.id] === true}
                        disabled={busy}
                        onChange={(event) => void toggleCategory(ledger.id, event.target.checked)}
                        className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                      />
                      <span className="truncate">{ledger.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          {/* Add rule form */}
          {showAdd ? (
            <form
              onSubmit={addRule}
              className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#111827]"
            >
              <h3 className="mb-4 font-display text-sm font-semibold text-slate-900 dark:text-slate-50">
                New classification rule
              </h3>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                    Rule name
                  </span>
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Fuel - HP"
                    required
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                    Match field
                  </span>
                  <select
                    value={matchType}
                    onChange={(event) =>
                      setMatchType(event.target.value as ClassificationRule['matchType'])
                    }
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  >
                    {CLASSIFICATION_MATCH_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {formatMatchType(type)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                    Pattern
                  </span>
                  <input
                    value={pattern}
                    onChange={(event) => setPattern(event.target.value)}
                    placeholder="hp petrol"
                    required
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                    Assign to account
                  </span>
                  <select
                    value={ledgerId}
                    onChange={(event) => setLedgerId(event.target.value)}
                    required
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  >
                    <option value="">Select account...</option>
                    {ledgerOptions.map((ledger) => (
                      <option key={ledger.id} value={ledger.id}>
                        {ledger.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                    Confidence (0–1)
                  </span>
                  <input
                    value={confidence}
                    inputMode="decimal"
                    onChange={(event) => setConfidence(event.target.value)}
                    className="num-tabular w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  />
                </label>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowAdd(false)}
                  className="rounded-lg border border-slate-200 px-3.5 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  {busy ? 'Saving...' : 'Save rule'}
                </button>
              </div>
            </form>
          ) : null}

          {/* Rules table */}
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-[#111827]">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/80 text-xs font-medium text-slate-500 dark:border-slate-800 dark:bg-slate-900/50 dark:text-slate-400">
                    <th className="w-12 px-4 py-3">On</th>
                    <th className="px-4 py-3">Rule</th>
                    <th className="px-4 py-3">Pattern</th>
                    <th className="px-4 py-3">Target account</th>
                    <th className="px-4 py-3 text-right">Confidence</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                  {rules.map((rule) => {
                    const isConfirming = confirmDeleteId === rule.id;
                    return (
                      <tr
                        key={rule.id}
                        className="transition hover:bg-slate-50/70 dark:hover:bg-slate-800/40"
                      >
                        <td className="px-4 py-3">
                          <input
                            type="checkbox"
                            checked={rule.enabled}
                            disabled={busy}
                            aria-label={`Enable ${rule.name}`}
                            onChange={(event) => void toggleRule(rule, event.target.checked)}
                            className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                          />
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium text-slate-900 dark:text-slate-100">
                            {rule.name}
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400">
                            {formatMatchType(rule.matchType)}
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-slate-700 dark:text-slate-300">
                          {rule.pattern}
                        </td>
                        <td className="px-4 py-3">
                          <select
                            value={rule.ledgerId}
                            disabled={busy}
                            aria-label={`Category for ${rule.name}`}
                            onChange={(event) => void changeRuleLedger(rule, event.target.value)}
                            className="max-w-[220px] rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                          >
                            {ledgerOptions.map((ledger) => (
                              <option key={ledger.id} value={ledger.id}>
                                {ledger.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="num-tabular px-4 py-3 text-right text-xs font-medium text-slate-700 dark:text-slate-300">
                          {Math.round(rule.confidence * 100)}%
                        </td>
                        <td className="px-4 py-3 text-right">
                          {isConfirming ? (
                            <div className="inline-flex items-center justify-end gap-2">
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void removeRule(rule)}
                                className="rounded-md bg-rose-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-50"
                              >
                                Delete
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(null)}
                                className="text-xs font-medium text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setConfirmDeleteId(rule.id)}
                              className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-rose-600 dark:text-slate-400 dark:hover:text-rose-400"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              <span>Delete</span>
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
