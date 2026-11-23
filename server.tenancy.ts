import crypto from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

const TOKEN_VERSION = 1;
const TENANT_RE = /^[A-Za-z0-9._-]{1,64}$/;
const WORKSPACE_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export interface TenantContext {
  tenantId: string;
  workspaceIds: string[];
  subject?: string;
}

export interface TenantTokenInput {
  tenantId: string;
  workspaceIds: string[];
  subject?: string;
  ttlSeconds?: number;
}

export interface AuthConfig {
  secret: string | undefined;
  required: boolean;
  localTenant: string;
}

export function resolveAuthConfig(env = process.env): AuthConfig {
  const secret = env.SERVER_AUTH_SECRET?.trim();
  const production = env.NODE_ENV === 'production';

  if (production && !secret) {
    throw new Error('SERVER_AUTH_SECRET is required in production.');
  }
  if (production && secret && secret.length < 32) {
    throw new Error('SERVER_AUTH_SECRET must be at least 32 characters in production.');
  }

  return {
    secret,
    required: Boolean(secret),
    localTenant: env.SERVER_LOCAL_TENANT?.trim() || 'local',
  };
}

function assertTenantId(value: string): string {
  if (!TENANT_RE.test(value)) {
    throw new Error('Tenant id must contain only letters, numbers, dots, underscores, or hyphens.');
  }
  return value;
}

function assertWorkspaceIds(values: string[]): string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > 100) {
    throw new Error('A token must include between 1 and 100 workspace ids.');
  }
  for (const value of values) {
    if (typeof value !== 'string' || (value !== '*' && !WORKSPACE_RE.test(value))) {
      throw new Error(`Invalid workspace id "${String(value)}".`);
    }
  }
  return [...new Set(values)];
}

export function createTenantToken(
  input: TenantTokenInput,
  secret: string,
  nowMs = Date.now(),
): string {
  if (!secret) throw new Error('A token secret is required.');
  const tenantId = assertTenantId(input.tenantId);
  const workspaceIds = assertWorkspaceIds(input.workspaceIds);
  const ttlSeconds = Math.max(60, Math.min(86_400, Math.floor(input.ttlSeconds ?? 3600)));
  const issuedAt = Math.floor(nowMs / 1000);
  const payload: Record<string, unknown> = {
    v: TOKEN_VERSION,
    tid: tenantId,
    wid: workspaceIds,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
  };
  if (input.subject) payload.sub = input.subject;

  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifyTenantToken(
  token: string,
  secret: string,
  nowMs = Date.now(),
): TenantContext {
  if (!secret) throw new Error('Server authentication is not configured.');
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('Invalid or expired server token.');
  const [encoded, signature] = parts;
  if (!encoded || !signature) throw new Error('Invalid or expired server token.');

  const expected = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  const providedBuffer = Buffer.from(signature, 'base64url');
  const expectedBuffer = Buffer.from(expected, 'base64url');
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(new Uint8Array(providedBuffer), new Uint8Array(expectedBuffer))
  ) {
    throw new Error('Invalid or expired server token.');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid or expired server token.');
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid or expired server token.');
  }

  const record = payload as Record<string, unknown>;
  const now = Math.floor(nowMs / 1000);
  if (record.v !== TOKEN_VERSION) throw new Error('Invalid or expired server token.');
  if (typeof record.tid !== 'string') throw new Error('Invalid or expired server token.');
  if (!Array.isArray(record.wid)) throw new Error('Invalid or expired server token.');
  if (
    typeof record.iat !== 'number' ||
    typeof record.exp !== 'number' ||
    !Number.isFinite(record.iat) ||
    !Number.isFinite(record.exp)
  ) {
    throw new Error('Invalid or expired server token.');
  }
  if (record.exp <= now || record.iat > now + 60) {
    throw new Error('Invalid or expired server token.');
  }

  const tenantId = assertTenantId(record.tid);
  const workspaceIds = assertWorkspaceIds(record.wid as string[]);
  const context: TenantContext = { tenantId, workspaceIds };
  if (typeof record.sub === 'string' && record.sub.trim()) {
    context.subject = record.sub.trim().slice(0, 256);
  }
  return context;
}

export function getTenant(res: Response): TenantContext {
  const tenant = res.locals.tenant as TenantContext | undefined;
  if (!tenant) throw new Error('Tenant context is missing.');
  return tenant;
}

export function tenantAuth(config: AuthConfig): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const authorization = req.get('authorization');
    if (!authorization) {
      if (!config.required) {
        res.locals.tenant = {
          tenantId: config.localTenant,
          workspaceIds: ['*'],
          subject: 'local',
        } satisfies TenantContext;
        next();
        return;
      }
      res.status(401).json({ ok: false, error: 'Authentication required.' });
      return;
    }

    if (!config.secret) {
      res.status(401).json({ ok: false, error: 'Authentication is not configured.' });
      return;
    }

    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    if (!match?.[1]) {
      res.status(401).json({ ok: false, error: 'Invalid authorization header.' });
      return;
    }

    try {
      const tenant = verifyTenantToken(match[1], config.secret);
      const headerTenant = req.get('x-tenant-id')?.trim();
      if (headerTenant && headerTenant !== tenant.tenantId) {
        res.status(403).json({ ok: false, error: 'Tenant does not match the authenticated token.' });
        return;
      }
      res.locals.tenant = tenant;
      next();
    } catch {
      res.status(401).json({ ok: false, error: 'Invalid or expired server token.' });
    }
  };
}

export function requireWorkspace(req: Request, res: Response, next: NextFunction): void {
  const workspaceId = req.get('x-workspace-id')?.trim();
  if (!workspaceId) {
    res.status(400).json({ ok: false, error: 'X-Workspace-Id header is required.' });
    return;
  }
  if (!WORKSPACE_RE.test(workspaceId)) {
    res.status(400).json({ ok: false, error: 'Invalid X-Workspace-Id header.' });
    return;
  }

  const tenant = getTenant(res);
  if (!tenant.workspaceIds.includes('*') && !tenant.workspaceIds.includes(workspaceId)) {
    res.status(403).json({ ok: false, error: 'Workspace is not available to this tenant.' });
    return;
  }

  res.locals.workspaceId = workspaceId;
  next();
}
