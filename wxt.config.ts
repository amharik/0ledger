import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: 'src',
  manifest: {
    name: '0ledger',
    short_name: '0ledger',
    description:
      'Local-first double-entry ledger for Indian businesses. Parse email, bank statements and FASTag, then reconcile.',
    permissions: ['storage', 'unlimitedStorage', 'alarms', 'sidePanel', 'identity', 'scripting', 'activeTab'],
    optional_host_permissions: [
      'https://www.googleapis.com/*',
      'https://sheets.googleapis.com/*',
      'https://oauth2.googleapis.com/*',
      'https://openidconnect.googleapis.com/*',
      'https://mail.google.com/*',
      'https://*.googleusercontent.com/*',
    ],
    action: {
      default_title: '0ledger',
    },
    side_panel: {
      default_path: 'sidepanel.html',
    },
  },
});
