export default function App() {
  const openSidePanel = async () => {
    if (typeof chrome !== 'undefined' && chrome.windows && chrome.sidePanel) {
      const current = await chrome.windows.getCurrent();
      if (current.id != null) {
        await chrome.sidePanel.open({ windowId: current.id });
        window.close();
      }
    }
  };

  return (
    <main className="popup">
      <h1>0ledger</h1>
      <p className="muted">Local-first double-entry ledger.</p>
      <button onClick={openSidePanel}>Open ledger</button>
      <button
        className="ghost"
        onClick={() => {
          if (typeof chrome !== 'undefined' && chrome.runtime?.openOptionsPage) {
            chrome.runtime.openOptionsPage();
          }
        }}
      >
        Settings
      </button>
      <p className="muted small">Phase 1A · no data leaves this device.</p>
    </main>
  );
}
