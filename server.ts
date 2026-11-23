import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { ImapFlow } from 'imapflow';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isLoopbackHost,
  resolveServerHost,
  resolveServerPort,
  resolveServerProtocol,
  resolveTlsOptions,
} from './server.config.ts';
import { log, requestLogger } from './server.logger.ts';
import {
  parseImapConfig,
  parseImapQuery,
  type ValidatedImapConfig,
} from './server.schemas.ts';
import { assertAllowedImapHost, rateLimit, securityHeaders } from './server.security.ts';
import {
  requireWorkspace,
  resolveAuthConfig,
  tenantAuth,
  type AuthConfig,
} from './server.tenancy.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

function createImapClient(config: ValidatedImapConfig): ImapFlow {
  return new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.tls,
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

function formatImapError(err: unknown, config: ValidatedImapConfig): string {
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

function badRequest(res: Response, cause: unknown): void {
  res.status(400).json({ ok: false, error: cause instanceof Error ? cause.message : String(cause) });
}

function envRateLimit(): number {
  const raw = Number(process.env.SERVER_RATE_LIMIT_PER_MINUTE);
  if (!Number.isInteger(raw) || raw < 1) return 60;
  return Math.min(raw, 1000);
}

export interface CreateAppOptions {
  serveFrontend?: boolean;
  auth?: AuthConfig;
  tls?: boolean;
  allowPrivateImap?: boolean;
  rateLimitMax?: number;
  createImapClient?: (config: ValidatedImapConfig) => ImapFlow;
  assertHost?: (host: string) => Promise<string>;
}

export async function createApp(options: CreateAppOptions = {}): Promise<Express> {
  const auth = options.auth ?? resolveAuthConfig();
  const tls = options.tls ?? resolveServerProtocol() === 'https';
  const production = process.env.NODE_ENV === 'production';
  const allowPrivateImap = options.allowPrivateImap ?? process.env.ALLOW_PRIVATE_IMAP === 'true';
  const createClient = options.createImapClient ?? createImapClient;
  const assertHost =
    options.assertHost ??
    ((host: string) => assertAllowedImapHost(host, { allowPrivate: allowPrivateImap }));

  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders({ tls, production }));
  app.use(requestLogger());
  app.use(express.json({ limit: '4mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      tenantIsolation: true,
      tls,
    });
  });

  app.use('/api', (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', tenantAuth(auth));
  app.use('/api', rateLimit({ max: options.rateLimitMax ?? envRateLimit() }));
  app.use('/api/imap', requireWorkspace);

  app.post('/api/imap/test', async (req: Request, res: Response) => {
    let config: ValidatedImapConfig;
    try {
      config = parseImapConfig(req.body?.config ?? req.body);
    } catch (err) {
      badRequest(res, err);
      return;
    }

    try {
      await assertHost(config.host);
    } catch (err) {
      log('warn', 'imap.host_rejected', { requestId: res.locals.requestId, host: config.host });
      badRequest(res, err);
      return;
    }

    const client = createClient(config);
    try {
      await client.connect();
      const listed = await client.list();
      const folders = listed
        .map((item) => item.path)
        .filter((folder): folder is string => Boolean(folder))
        .slice(0, 60);

      const targetMailbox = config.mailbox;
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
      log('warn', 'imap.test_failed', {
        requestId: res.locals.requestId,
        host: config.host,
        error: err instanceof Error ? err.name : 'unknown',
      });
      res.status(400).json({ ok: false, error: formatImapError(err, config) });
    }
  });

  app.post('/api/imap/fetch', async (req: Request, res: Response) => {
    let config: ValidatedImapConfig;
    let query: ReturnType<typeof parseImapQuery>;
    try {
      config = parseImapConfig(req.body?.config);
      query = parseImapQuery(req.body?.query ?? {});
    } catch (err) {
      badRequest(res, err);
      return;
    }

    try {
      await assertHost(config.host);
    } catch (err) {
      log('warn', 'imap.host_rejected', { requestId: res.locals.requestId, host: config.host });
      badRequest(res, err);
      return;
    }

    const client = createClient(config);
    try {
      await client.connect();
      const targetMailbox = config.mailbox;
      const lock = await client.getMailboxLock(targetMailbox);

      const messages: ImapMessageResult[] = [];
      let scanned = 0;
      let matched = 0;
      let nextCursor: number | undefined;

      try {
        const uidValidity =
          client.mailbox &&
          typeof client.mailbox === 'object' &&
          'uidValidity' in client.mailbox
            ? Number(client.mailbox.uidValidity ?? 0)
            : 0;

        const since = new Date(Date.now() - query.days * 86_400_000);
        const searchCriteria: Record<string, unknown> = { since };
        if (query.custom_search && query.preset === 'custom') {
          searchCriteria.or = [
            { subject: query.custom_search },
            { from: query.custom_search },
            { body: query.custom_search },
          ];
        }

        const uidsResult = await client.search(searchCriteria, { uid: true });
        const allUids = Array.isArray(uidsResult) ? uidsResult : [];
        const sortedUids = [...allUids].sort((a, b) => b - a);
        const candidateUids = sortedUids
          .filter((uid) => query.cursor === undefined || uid < query.cursor)
          .slice(0, 250);
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
            if (
              matchesPreset(
                query.preset,
                subject,
                from,
                query.preset === 'custom' ? query.custom_search : undefined,
              )
            ) {
              matchedUids.push(header.uid);
            }
          }
        }

        matchedUids.sort((a, b) => b - a);
        matched = matchedUids.length;
        const toDownload = matchedUids.slice(0, query.limit);

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

        if (matchedUids.length > query.limit) {
          nextCursor = toDownload[toDownload.length - 1];
        } else if (candidateUids.length === 250) {
          nextCursor = candidateUids[candidateUids.length - 1];
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
        ...(nextCursor ? { nextCursor, hasMore: true } : { hasMore: false }),
      });
    } catch (err) {
      await client.logout().catch(() => {});
      client.close();
      log('warn', 'imap.fetch_failed', {
        requestId: res.locals.requestId,
        host: config.host,
        error: err instanceof Error ? err.name : 'unknown',
      });
      res.status(400).json({ ok: false, error: formatImapError(err, config) });
    }
  });

  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ ok: false, error: 'API route not found.' });
  });

  if (options.serveFrontend !== false) {
    if (production) {
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
  }

  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const status =
      typeof err === 'object' && err !== null && 'status' in err
        ? Number((err as { status?: unknown }).status)
        : 500;
    const safeStatus = Number.isInteger(status) && status >= 400 && status < 600 ? status : 500;
    log('error', 'http.error', {
      requestId: res.locals.requestId,
      method: req.method,
      path: req.path,
      status: safeStatus,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(safeStatus).json({
      ok: false,
      error: safeStatus === 400 ? 'Invalid request body.' : 'Internal server error.',
    });
  });

  return app;
}

export async function startServer(): Promise<http.Server | https.Server> {
  const port = resolveServerPort();
  const host = resolveServerHost();
  const tls = resolveTlsOptions();
  const auth = resolveAuthConfig();
  const protocol = tls ? 'https' : 'http';

  if (!auth.required && !isLoopbackHost(host)) {
    throw new Error(
      'SERVER_AUTH_SECRET is required when binding the server to a non-loopback host.',
    );
  }

  const app = await createApp({ auth, tls: Boolean(tls) });
  const server = tls ? https.createServer(tls, app) : http.createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  log('info', 'server.start', {
    host,
    port,
    protocol,
    auth: auth.required ? 'token' : 'local',
    tls: Boolean(tls),
  });

  server.on('error', (error) => {
    log('error', 'server.error', { error: error.message });
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', 'server.shutdown', { signal });
    const force = setTimeout(() => {
      log('error', 'server.shutdown_timeout', {});
      process.exit(1);
    }, 10_000);
    force.unref();
    server.close((error) => {
      clearTimeout(force);
      if (error) {
        log('error', 'server.close_failed', { error: error.message });
        process.exit(1);
      }
      log('info', 'server.stopped', {});
      process.exit(0);
    });
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  return server;
}

const isMainModule = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === path.resolve(entry);
  } catch {
    return false;
  }
})();

if (isMainModule) {
  startServer().catch((error) => {
    log('error', 'server.start_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
}
