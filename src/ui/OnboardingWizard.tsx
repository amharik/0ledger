import { useState, type FormEvent } from 'react';
import { ArrowRight, Building2, Check, Shield } from 'lucide-react';
import { getDb } from '@/core/db/db';
import { createWorkspace, type CreateWorkspaceInput } from '@/core/db/workspace-service';
import { createLedger, updateLedger } from '@/core/db/ledger-service';
import { createStockItem } from '@/core/db/master-service';
import { postVoucher } from '@/core/ledger';
import { stageImport } from '@/core/ingest';
import { parseTextStatement } from '@/core/ingest/parsers';
import { captureStatementLines } from '@/core/autopilot';
import { defaultBooksBegin } from '@/core/db/defaults';
import { setActiveWorkspaceId } from './workspace';

export const INDIAN_STATES = [
  { code: '29', name: 'Karnataka' },
  { code: '27', name: 'Maharashtra' },
  { code: '07', name: 'Delhi' },
  { code: '33', name: 'Tamil Nadu' },
  { code: '36', name: 'Telangana' },
  { code: '24', name: 'Gujarat' },
  { code: '19', name: 'West Bengal' },
  { code: '37', name: 'Andhra Pradesh' },
  { code: '09', name: 'Uttar Pradesh' },
  { code: '06', name: 'Haryana' },
  { code: '03', name: 'Punjab' },
  { code: '08', name: 'Rajasthan' },
  { code: '10', name: 'Bihar' },
  { code: '20', name: 'Jharkhand' },
  { code: '21', name: 'Odisha' },
  { code: '22', name: 'Chhattisgarh' },
  { code: '23', name: 'Madhya Pradesh' },
  { code: '30', name: 'Goa' },
  { code: '32', name: 'Kerala' },
  { code: '05', name: 'Uttarakhand' },
  { code: '02', name: 'Himachal Pradesh' },
  { code: '01', name: 'Jammu & Kashmir' },
  { code: '04', name: 'Chandigarh' },
  { code: '18', name: 'Assam' },
];

interface Props {
  onCompleted: (workspaceId: string) => void;
  onCancel?: (() => void) | undefined;
}

export function OnboardingWizard({ onCompleted, onCancel }: Props) {
  const [name, setName] = useState('');
  const [state, setState] = useState('Karnataka');
  const [gstin, setGstin] = useState('');
  const [booksBegin, setBooksBegin] = useState(() => defaultBooksBegin());
  const [enableTally, setEnableTally] = useState(false);
  const [enableCaPack, setEnableCaPack] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Enter your business or company name to continue.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const db = getDb();
      const input: CreateWorkspaceInput = {
        name: trimmed,
        state,
        booksBegin,
        enableTally,
        enableCaPack,
      };
      if (gstin.trim()) {
        input.gstin = gstin.trim().toUpperCase();
      }
      const bundle = await createWorkspace(db, input);
      await setActiveWorkspaceId(bundle.workspace.id);
      onCompleted(bundle.workspace.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  async function handleLoadDemo() {
    setBusy(true);
    setError(undefined);
    try {
      const db = getDb();
      const todayIso = new Date().toISOString().slice(0, 10);
      const monthPrefix = todayIso.slice(0, 7);
      const fyStart = defaultBooksBegin();

      const bundle = await createWorkspace(db, {
        name: 'Acme Traders',
        companyLegalName: 'Acme Traders Private Limited',
        state: 'Karnataka',
        gstin: '29AABCA1234F1Z5',
        booksBegin: fyStart,
      });
      const wsId = bundle.workspace.id;

      const bankLedger = bundle.ledgers.find((l) => l.isBank);
      const salesLedger = bundle.ledgers.find((l) => l.name === 'Sales');
      const purchasesLedger = bundle.ledgers.find((l) => l.name === 'Purchases');
      const rentLedger = bundle.ledgers.find((l) => l.name === 'Rent');
      const equityLedger = bundle.ledgers.find((l) => l.name === 'Opening Balance Equity');
      const debtorsGroup = bundle.groups.find((g) => g.primaryGroup === 'Sundry Debtors');
      const creditorsGroup = bundle.groups.find((g) => g.primaryGroup === 'Sundry Creditors');

      if (bankLedger && equityLedger) {
        await updateLedger(db, bankLedger.id, { openingBalanceMinor: 25000000 });
        await updateLedger(db, equityLedger.id, { openingBalanceMinor: -25000000 });
      }

      const client = debtorsGroup
        ? await createLedger(db, {
            workspaceId: wsId,
            name: 'Infosys Client Services',
            groupId: debtorsGroup.id,
          })
        : undefined;

      const vendor = creditorsGroup
        ? await createLedger(db, {
            workspaceId: wsId,
            name: 'Apex Cloud Hosting Vendor',
            groupId: creditorsGroup.id,
          })
        : undefined;

      const consultingItem = await createStockItem(db, {
        workspaceId: wsId,
        name: 'Managed Operations Retainer',
        uom: 'MON',
        hsnSac: '998314',
        rateMinor: 8500000,
        valuationMethod: 'weighted-average',
      });

      if (client && salesLedger) {
        await postVoucher(db, {
          workspaceId: wsId,
          voucherType: 'Sales',
          date: `${monthPrefix}-04`,
          invoiceNumber: 'INV-2026-104',
          invoiceDate: `${monthPrefix}-04`,
          dueDate: `${monthPrefix}-28`,
          partyLedgerId: client.ledger.id,
          narration: 'Monthly retainer billing for Infosys Client Services',
          placeOfSupply: 'Karnataka',
          status: 'regular',
          currency: 'INR',
          source: 'manual',
          groupIds: [],
          tags: [],
          lines: [
            {
              ledgerId: client.ledger.id,
              amountMinor: 8500000,
              currency: 'INR',
              billAllocations: [
                {
                  billRef: 'INV-2026-104',
                  billType: 'New Ref',
                  amountMinor: 8500000,
                  dueDate: `${monthPrefix}-28`,
                },
              ],
              costCenterAllocations: [],
              taxAllocations: [],
            },
            {
              ledgerId: salesLedger.id,
              amountMinor: -8500000,
              currency: 'INR',
              billAllocations: [],
              costCenterAllocations: [],
              taxAllocations: [],
            },
          ],
          items: [
            {
              stockItemId: consultingItem.id,
              description: consultingItem.name,
              hsnSac: '998314',
              quantity: '1',
              uom: 'MON',
              rateMinor: 8500000,
              amountMinor: 8500000,
              discountMinor: 0,
              direction: 'out',
            },
          ],
        });
      }

      if (vendor && purchasesLedger) {
        await postVoucher(db, {
          workspaceId: wsId,
          voucherType: 'Purchase',
          date: `${monthPrefix}-08`,
          invoiceNumber: 'APEX-889',
          invoiceDate: `${monthPrefix}-08`,
          dueDate: `${monthPrefix}-25`,
          partyLedgerId: vendor.ledger.id,
          narration: 'Cloud infrastructure hosting bill',
          placeOfSupply: 'Karnataka',
          status: 'regular',
          currency: 'INR',
          source: 'manual',
          groupIds: [],
          tags: [],
          lines: [
            {
              ledgerId: purchasesLedger.id,
              amountMinor: 3200000,
              currency: 'INR',
              billAllocations: [],
              costCenterAllocations: [],
              taxAllocations: [],
            },
            {
              ledgerId: vendor.ledger.id,
              amountMinor: -3200000,
              currency: 'INR',
              billAllocations: [
                {
                  billRef: 'APEX-889',
                  billType: 'New Ref',
                  amountMinor: 3200000,
                  dueDate: `${monthPrefix}-25`,
                },
              ],
              costCenterAllocations: [],
              taxAllocations: [],
            },
          ],
          items: [],
        });
      }

      if (bankLedger && rentLedger) {
        await postVoucher(db, {
          workspaceId: wsId,
          voucherType: 'Payment',
          date: `${monthPrefix}-05`,
          narration: 'Bengaluru office lease payment',
          status: 'regular',
          currency: 'INR',
          source: 'manual',
          groupIds: [],
          tags: [],
          lines: [
            {
              ledgerId: rentLedger.id,
              amountMinor: 2800000,
              currency: 'INR',
              billAllocations: [],
              costCenterAllocations: [],
              taxAllocations: [],
            },
            {
              ledgerId: bankLedger.id,
              amountMinor: -2800000,
              currency: 'INR',
              billAllocations: [],
              costCenterAllocations: [],
              taxAllocations: [],
            },
          ],
          items: [],
        });
      }

      const sampleText = `Date,Description,Debit,Credit,Balance
${monthPrefix}-20,NEFT Cr from Infosys Client Services Inv 104,,85000.00,307000.00
${monthPrefix}-19,UPI/P2M/Swiggy Bangalore Office Pantry,1450.00,,305550.00
${monthPrefix}-18,IMPS to Apex Cloud Hosting Vendor,32000.00,,273550.00
${monthPrefix}-17,NETBANKING AWS Cloud Hosting Services,8900.00,,264650.00
${monthPrefix}-16,Bank Quarterly Account Charges,500.00,,264150.00`;

      const statement = parseTextStatement(sampleText, { fileName: 'hdfc-november-statement.csv' });
      const staged = await stageImport(db, {
        workspaceId: wsId,
        source: 'email',
        statement,
        fileName: 'hdfc-november-statement.csv',
        ...(bankLedger ? { accountId: bankLedger.id } : {}),
      });
      await captureStatementLines(db, wsId, staged.batch, staged.lines);

      await setActiveWorkspaceId(wsId);
      onCompleted(wsId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-4xl items-center justify-center px-4 py-12">
      <div className="grid w-full grid-cols-1 gap-10 lg:grid-cols-12 lg:items-start">
        <div className="lg:col-span-5 lg:pt-2">
          <div className="text-sm font-semibold tracking-tight text-blue-700 dark:text-blue-400">
            0ledger
          </div>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
            Simple, accurate books on your device.
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
            Pull transactions from email or statements, approve suggested categories in one click,
            and keep clear financial reports. Everything stays private inside your browser.
          </p>

          <ul className="mt-8 space-y-3 text-sm text-slate-700 dark:text-slate-300">
            <li className="flex items-start gap-2.5">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <span>Automatic double-entry bookkeeping with ready-made account categories</span>
            </li>
            <li className="flex items-start gap-2.5">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <span>IMAP email import, statement parsing, and bank reconciliation</span>
            </li>
            <li className="flex items-start gap-2.5">
              <Shield className="mt-0.5 h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400" />
              <span>Zero cloud lock-in with Excel exports and encrypted local backups</span>
            </li>
          </ul>

          <div className="mt-8 border-t border-slate-200 pt-6 dark:border-slate-800">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Want to see live reports and the money inbox right away?
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleLoadDemo()}
              className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-800 transition-colors hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <Building2 className="h-4 w-4 text-slate-500" />
              <span>{busy ? 'Setting up sample books…' : 'Explore with sample company'}</span>
            </button>
          </div>
        </div>

        <div className="lg:col-span-7">
          <div className="rounded-xl border border-slate-200 bg-white p-6 sm:p-8 dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                  Set up your company
                </h2>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  You can add more companies or update GST details anytime.
                </p>
              </div>
              {onCancel ? (
                <button
                  type="button"
                  onClick={onCancel}
                  disabled={busy}
                  className="text-sm font-medium text-slate-500 transition-colors hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
                >
                  Cancel
                </button>
              ) : null}
            </div>

            {error ? (
              <div className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
                {error}
              </div>
            ) : null}

            <form onSubmit={handleCreate} className="mt-6 space-y-5">
              <div>
                <label
                  htmlFor="company-name"
                  className="block text-sm font-medium text-slate-700 dark:text-slate-300"
                >
                  Company or trade name
                </label>
                <input
                  id="company-name"
                  type="text"
                  required
                  autoFocus
                  placeholder="e.g. Sharma Trading Co."
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder:text-slate-500"
                />
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Shown on your financial reports, invoices, and exported files.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="company-state"
                    className="block text-sm font-medium text-slate-700 dark:text-slate-300"
                  >
                    State
                  </label>
                  <select
                    id="company-state"
                    value={state}
                    onChange={(e) => setState(e.target.value)}
                    className="mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                  >
                    {INDIAN_STATES.map((s) => (
                      <option key={s.code} value={s.name}>
                        {s.name} ({s.code})
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    Used to identify local vs. inter-state transactions.
                  </p>
                </div>

                <div>
                  <label
                    htmlFor="company-gstin"
                    className="block text-sm font-medium text-slate-700 dark:text-slate-300"
                  >
                    GSTIN <span className="font-normal text-slate-400">(optional)</span>
                  </label>
                  <input
                    id="company-gstin"
                    type="text"
                    maxLength={15}
                    placeholder="29AABCA1234F1Z5"
                    value={gstin}
                    onChange={(e) => setGstin(e.target.value.toUpperCase())}
                    className="num-tabular mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 uppercase placeholder:text-slate-400 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder:text-slate-500"
                  />
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    Leave blank if not GST-registered. GST reports and tax fields stay hidden until
                    added.
                  </p>
                </div>
              </div>

              <div>
                <label
                  htmlFor="books-begin"
                  className="block text-sm font-medium text-slate-700 dark:text-slate-300"
                >
                  Books beginning from
                </label>
                <input
                  id="books-begin"
                  type="date"
                  value={booksBegin}
                  onChange={(e) => setBooksBegin(e.target.value)}
                  className="num-tabular mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Start date of your accounting year (typically April 1). Earlier balances go into
                  each account&apos;s opening balance.
                </p>
              </div>

              <div className="space-y-3 border-t border-slate-200 pt-4 dark:border-slate-800">
                <div>
                  <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                    Optional workflows (off by default)
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                    Keep your workspace minimal, or enable these now — you can toggle them anytime
                    in Settings.
                  </p>
                </div>
                <label className="flex cursor-pointer items-start gap-2.5">
                  <input
                    type="checkbox"
                    checked={enableTally}
                    onChange={(e) => setEnableTally(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span className="text-xs">
                    <span className="block font-medium text-slate-800 dark:text-slate-200">
                      Enable Tally integration
                    </span>
                    <span className="text-slate-500 dark:text-slate-400">
                      Adds Tally Prime XML export/import, readiness checks, and live bridge tools.
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2.5">
                  <input
                    type="checkbox"
                    checked={enableCaPack}
                    onChange={(e) => setEnableCaPack(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span className="text-xs">
                    <span className="block font-medium text-slate-800 dark:text-slate-200">
                      Enable CA Pack &amp; month-end close
                    </span>
                    <span className="text-slate-500 dark:text-slate-400">
                      Adds a Chartered Accountant handover checklist, Ask CA queue, and monthly pack
                      bundler on your overview.
                    </span>
                  </span>
                </label>
              </div>

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={busy}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:opacity-50 dark:bg-blue-600 dark:hover:bg-blue-500"
                >
                  <span>{busy ? 'Creating workspace…' : 'Create company & open ledger'}</span>
                  <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
