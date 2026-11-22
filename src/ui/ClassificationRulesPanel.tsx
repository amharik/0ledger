import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { getDb } from '@/core/db/db';
import {
  createClassificationRule,
  deleteClassificationRule,
  ensureSeedClassificationRules,
  getAutoPostSettings,
  listClassificationRules,
  setAutoPostSettings,
  updateClassificationRule,
  type AutoPostSettings,
} from '@/core/autopilot';
import { CLASSIFICATION_MATCH_TYPES, type ClassificationRule, type Ledger } from '@/core/model';

interface Props {
  workspaceId: string;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function ClassificationRulesPanel({ workspaceId }: Props) {
  const [rules, setRules] = useState<ClassificationRule[]>([]);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [settings, setSettings] = useState<AutoPostSettings>({ enabled: false, categories: {} });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const [name, setName] = useState('');
  const [matchType, setMatchType] = useState<ClassificationRule['matchType']>('narration-keyword');
  const [pattern, setPattern] = useState('');
  const [ledgerId, setLedgerId] = useState('');
  const [confidence, setConfidence] = useState('0.8');

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
      setError('Rule name, pattern and category ledger are required.');
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
        confidence: Math.max(0, Math.min(1, Number(confidence) || 0.8)),
      });
      setName('');
      setPattern('');
      setNotice('Rule added');
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
    if (!window.confirm(`Delete rule “${rule.name}”?`)) return;
    setBusy(true);
    setError(undefined);
    try {
      await deleteClassificationRule(getDb(), workspaceId, rule.id);
      setNotice('Rule deleted');
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
      setNotice('Auto-post settings saved');
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
    <div className="stack">
      <p className="muted">
        Rules suggest a category for bank and email events. Auto-post is off by default; enabling
        it only posts events above 95% confidence with no tax hint and a document attached.
      </p>

      {notice ? <div className="alert success">{notice}</div> : null}
      {error ? <div className="alert danger">{error}</div> : null}
      {loading ? <p className="muted">Loading rules…</p> : null}

      {!loading ? (
        <>
          <div className="rule-settings">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={settings.enabled}
                disabled={busy}
                onChange={(event) => void saveSettings({ ...settings, enabled: event.target.checked })}
              />
              <span>
                <strong>Enable auto-post</strong>
                <span className="muted small"> Only categories ticked below qualify.</span>
              </span>
            </label>
            {settings.enabled && categories.length > 0 ? (
              <div className="category-grid">
                {categories.map((ledger) => (
                  <label key={ledger.id} className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={settings.categories[ledger.id] === true}
                      disabled={busy}
                      onChange={(event) => void toggleCategory(ledger.id, event.target.checked)}
                    />
                    <span>{ledger.name}</span>
                  </label>
                ))}
              </div>
            ) : null}
          </div>

          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>On</th>
                  <th>Rule</th>
                  <th>Match</th>
                  <th>Pattern</th>
                  <th>Category</th>
                  <th className="num">Conf.</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        disabled={busy}
                        aria-label={`Enable ${rule.name}`}
                        onChange={(event) => void toggleRule(rule, event.target.checked)}
                      />
                    </td>
                    <td>{rule.name}</td>
                    <td className="muted small">{rule.matchType}</td>
                    <td>{rule.pattern}</td>
                    <td>
                      <select
                        value={rule.ledgerId}
                        disabled={busy}
                        aria-label={`Category for ${rule.name}`}
                        onChange={(event) => void changeRuleLedger(rule, event.target.value)}
                      >
                        {ledgerOptions.map((ledger) => (
                          <option key={ledger.id} value={ledger.id}>
                            {ledger.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="num">{Math.round(rule.confidence * 100)}%</td>
                    <td>
                      <button
                        type="button"
                        className="ghost small-button"
                        disabled={busy}
                        onClick={() => void removeRule(rule)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <form className="create-form" onSubmit={addRule}>
            <h3>Add rule</h3>
            <div className="form-grid">
              <label>
                <span>Name</span>
                <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Fuel - HP" />
              </label>
              <label>
                <span>Match type</span>
                <select
                  value={matchType}
                  onChange={(event) => setMatchType(event.target.value as ClassificationRule['matchType'])}
                >
                  {CLASSIFICATION_MATCH_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Pattern</span>
                <input
                  value={pattern}
                  onChange={(event) => setPattern(event.target.value)}
                  placeholder="hp petrol"
                />
              </label>
              <label>
                <span>Category ledger</span>
                <select value={ledgerId} onChange={(event) => setLedgerId(event.target.value)}>
                  <option value="">Select ledger…</option>
                  {ledgerOptions.map((ledger) => (
                    <option key={ledger.id} value={ledger.id}>
                      {ledger.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Confidence</span>
                <input
                  value={confidence}
                  inputMode="decimal"
                  onChange={(event) => setConfidence(event.target.value)}
                />
              </label>
            </div>
            <button type="submit" disabled={busy}>
              Add rule
            </button>
          </form>
        </>
      ) : null}
    </div>
  );
}
