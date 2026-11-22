import express from 'express';
import type { Request, Response } from 'express';
import { ImapFlow } from 'imapflow';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ImapConfigPayload {
  host: string;
  port: number;
  username: string;
  password: string;
  mailbox?: string;
  tls?: boolean;
}

interface ImapQueryPayload {
  preset?: 'fastag' | 'bank' | 'shopping' | 'all' | 'custom';
  custom_search?: string;
  limit?: number;
  days?: number;
}

interface ImapMessageResult {
  uid: number;
  uid_validity?: number;
  mailbox: string;
  subject: string;
  from: string;
  date: string;
  raw_base64: string;
}

const FASTAG_TERMS = [
  'fastag',
  'netc',
  'toll',
  'nhai',
  'ihmcl',
  'toll plaza',
  'plaza',
  'highway',
  'vehicle',
];

const BANK_TERMS = [
  'bank',
  'alert',
  'debited',
  'credited',
  'statement',
  'neft',
  'rtgs',
  'imps',
  'upi',
  'hdfc',
  'icici',
  'sbi',
  'axis',
  'kotak',
  'idfc',
  'pnb',
  'bob',
  'canara',
  'rbl',
  'federal',
  'paytm',
  'phonepe',
  'cred',
  'txn alert',
  'transaction alert',
  'a/c',
  'acct',
  'salary',
  'interest',
  'card',
];

const SHOPPING_TERMS = [
  'amazon',
  'flipkart',
  'swiggy',
  'zomato',
  'uber',
  'ola',
  'blinkit',
  'zepto',
  'invoice',
  'bill',
  'order',
  'receipt',
  'aws',
  'google',
  'microsoft',
  'payment',
  'razorpay',
  'cashfree',
  'subscription',
  'voucher',
  'gift card',
];

function matchesPreset(
  preset: string,
  subject: string,
  from: string,
  customSearch?: string,
): boolean {
  const s = subject.toLowerCase();
  const f = from.toLowerCase();

  if (customSearch && customSearch.trim()) {
    const terms = customSearch
      .toLowerCase()
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (terms.length > 0 && !terms.some((term) => s.includes(term) || f.includes(term))) {
      return false;
    }
  }

  switch (preset) {
    case 'fastag':
      return FASTAG_TERMS.some((term) => s.includes(term) || f.includes(term));
    case 'bank':
      return BANK_TERMS.some((term) => s.includes(term) || f.includes(term));
    case 'shopping':
      return SHOPPING_TERMS.some((term) => s.includes(term) || f.includes(term));
    case 'all':
    case 'custom':
    default:
      return true;
  }
}

function validateConfig(raw: unknown): ImapConfigPayload {
  if (!raw || typeof raw !== 'object') {
    throw new Error('IMAP configuration is required.');
  }
  const c = raw as Record<string, unknown>;
  const host = typeof c.host === 'string' ? c.host.trim() : '';
  const port = Number(c.port) || 993;
  const username = typeof c.username === 'string' ? c.username.trim() : '';
  const password = typeof c.password === 'string' ? c.password : '';
  const mailbox =
    typeof c.mailbox === 'string' && c.mailbox.trim() ? c.mailbox.trim() : 'INBOX';
  const tls = typeof c.tls === 'boolean' ? c.tls : port === 993;

  if (!host) throw new Error('IMAP host is required (e.g., imap.gmail.com).');
  if (port < 1 || port > 65535) throw new Error('IMAP port must be between 1 and 65535.');
  if (!username) throw new Error('Email address / username is required.');
  if (!password) throw new Error('Password or App Password is required.');

  return { host, port, username, password, mailbox, tls };
}

function createImapClient(config: ImapConfigPayload): ImapFlow {
  return new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.tls ?? config.port === 993,
    auth: {
      user: config.username,
      pass: config.password,
    },
    logger: false,
    connectionTimeout: 12_000,
    greetingTimeout: 10_000,
    socketTimeout: 25_000,
  });
}

function formatImapError(err: unknown, config: ImapConfigPayload): string {
  const raw = err instanceof Error ? err.message : String(err);
  const responseText =
    typeof err === 'object' && err !== null && 'responseText' in err
      ? String((err as { responseText?: unknown }).responseText ?? '')
      : '';
  const combined = `${raw} ${responseText}`.trim();
  const lower = combined.toLowerCase();

  if (
    lower.includes('authenticationfailed') ||
    lower.includes('invalid credentials') ||
    lower.includes('application-specific password') ||
    lower.includes('login failed') ||
    lower.includes('command failed')
  ) {
    if (config.host.toLowerCase().includes('gmail')) {
      return 'Authentication failed on Gmail. Make sure 2-Step Verification is enabled and you are using a 16-character Google App Password (not your regular login password).';
    }
    return `Authentication failed for ${config.username} on ${config.host}. Verify your email address and app password.`;
  }

  if (lower.includes('enotfound') || lower.includes('eai_again')) {
    return `Could not resolve IMAP server "${config.host}". Check the hostname and try again.`;
  }

  if (lower.includes('etimedout') || lower.includes('econnrefused') || lower.includes('timeout')) {
    return `Could not reach ${config.host}:${config.port}. Verify the host, port (${config.port}), and TLS setting.`;
  }

  return combined || 'IMAP connection failed.';
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.post('/api/imap/test', async (req: Request, res: Response) => {
    let config: ImapConfigPayload;
    try {
      config = validateConfig(req.body?.config ?? req.body);
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const client = createImapClient(config);
    try {
      await client.connect();
      const listed = await client.list();
      const folders = listed
        .map((item) => item.path)
        .filter((folder): folder is string => Boolean(folder))
        .slice(0, 60);

      const targetMailbox = config.mailbox || 'INBOX';
      const lock = await client.getMailboxLock(targetMailbox);
      let exists = 0;
      try {
        exists =
          client.mailbox && typeof client.mailbox === 'object' && 'exists' in client.mailbox
            ? Number(client.mailbox.exists ?? 0)
            : 0;
      } finally {
        lock.release();
      }

      await client.logout().catch(() => {});
      res.json({
        ok: true,
        mailbox: targetMailbox,
        exists,
        folders: folders.length > 0 ? folders : ['INBOX'],
      });
    } catch (err) {
      await client.logout().catch(() => {});
      client.close();
      res.status(400).json({ ok: false, error: formatImapError(err, config) });
    }
  });

  app.post('/api/imap/fetch', async (req: Request, res: Response) => {
    let config: ImapConfigPayload;
    try {
      config = validateConfig(req.body?.config);
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const query: ImapQueryPayload = req.body?.query ?? {};
    const preset = query.preset ?? 'bank';
    const days = Math.max(1, Math.min(365, Number(query.days) || 60));
    const limit = Math.max(1, Math.min(100, Number(query.limit) || 25));
    const customSearch = typeof query.custom_search === 'string' ? query.custom_search.trim() : '';

    const client = createImapClient(config);
    try {
      await client.connect();
      const targetMailbox = config.mailbox || 'INBOX';
      const lock = await client.getMailboxLock(targetMailbox);

      const messages: ImapMessageResult[] = [];
      let scanned = 0;
      let matched = 0;

      try {
        const uidValidity =
          client.mailbox &&
          typeof client.mailbox === 'object' &&
          'uidValidity' in client.mailbox
            ? Number(client.mailbox.uidValidity ?? 0)
            : 0;

        const since = new Date(Date.now() - days * 86_400_000);
        const searchCriteria: Record<string, unknown> = { since };
        if (customSearch && preset === 'custom') {
          searchCriteria.or = [
            { subject: customSearch },
            { from: customSearch },
            { body: customSearch },
          ];
        }

        const uidsResult = await client.search(searchCriteria, { uid: true });
        const allUids = Array.isArray(uidsResult) ? uidsResult : [];

        // Newest first, scan up to 250 recent envelopes to stay responsive
        const candidateUids = [...allUids].reverse().slice(0, 250);
        const matchedUids: number[] = [];

        if (candidateUids.length > 0) {
          for await (const header of client.fetch(
            candidateUids,
            { uid: true, envelope: true },
            { uid: true },
          )) {
            scanned += 1;
            const subject = header.envelope?.subject ?? '';
            const fromAddr = header.envelope?.from?.[0];
            const from = fromAddr
              ? [fromAddr.name, fromAddr.address].filter(Boolean).join(' ')
              : '';
            if (matchesPreset(preset, subject, from, preset === 'custom' ? customSearch : undefined)) {
              matchedUids.push(header.uid);
            }
          }
        }

        // Keep newest matched UIDs up to limit
        matchedUids.sort((a, b) => b - a);
        const toDownload = matchedUids.slice(0, limit);
        matched = matchedUids.length;

        if (toDownload.length > 0) {
          for await (const msg of client.fetch(
            toDownload,
            { uid: true, envelope: true, source: true },
            { uid: true },
          )) {
            const subject = msg.envelope?.subject ?? '(No subject)';
            const fromObj = msg.envelope?.from?.[0];
            const from = fromObj?.address || fromObj?.name || 'unknown';
            const dateStr = msg.envelope?.date
              ? new Date(msg.envelope.date).toISOString().slice(0, 10)
              : new Date().toISOString().slice(0, 10);
            const rawBase64 = msg.source ? msg.source.toString('base64') : '';
            if (!rawBase64) continue;

            messages.push({
              uid: msg.uid,
              ...(uidValidity ? { uid_validity: uidValidity } : {}),
              mailbox: targetMailbox,
              subject,
              from,
              date: dateStr,
              raw_base64: rawBase64,
            });
          }
        }
      } finally {
        lock.release();
      }

      await client.logout().catch(() => {});
      res.json({
        ok: true,
        messages,
        scanned,
        matched,
      });
    } catch (err) {
      await client.logout().catch(() => {});
      client.close();
      res.status(400).json({ ok: false, error: formatImapError(err, config) });
    }
  });

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(__dirname, 'dist-desktop');
    app.use(express.static(distDir));
    app.use((_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      configFile: path.resolve(__dirname, 'vite.config.desktop.ts'),
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`0ledger server running on http://0.0.0.0:${port}`);
  });
}

void startServer();
