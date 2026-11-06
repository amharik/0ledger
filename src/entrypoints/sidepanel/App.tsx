export default function App() {
  return (
    <main className="shell">
      <header>
        <div>
          <h1>0ledger</h1>
          <p className="muted small">Local-first ledger · Phase 1A</p>
        </div>
        <button className="ghost" onClick={() => chrome.runtime.openOptionsPage()}>
          Settings
        </button>
      </header>

      <section className="card">
        <h2>Getting started</h2>
        <ol>
          <li>Create a workspace (one company per workspace).</li>
          <li>Add ledgers or start from the default chart of accounts.</li>
          <li>Post a manual voucher or import a statement.</li>
          <li>Reconcile, then mirror to Google Sheets.</li>
        </ol>
        <p className="muted small">
          The ledger engine is being wired up. Core money, numbering and validation modules are
          unit-tested first.
        </p>
      </section>
    </main>
  );
}
