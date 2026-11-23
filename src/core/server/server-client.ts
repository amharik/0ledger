export const SERVER_TOKEN_KEY = '0ledger.server.token';
export const SERVER_TENANT_KEY = '0ledger.server.tenant';

const memory = new Map<string, string>();

function readValue(key: string): string | null {
  if (typeof localStorage !== 'undefined') {
    return localStorage.getItem(key);
  }
  return memory.get(key) ?? null;
}

function writeValue(key: string, value: string): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(key, value);
  } else {
    memory.set(key, value);
  }
}

function removeValue(key: string): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(key);
  }
  memory.delete(key);
}

export function getServerTenantId(): string {
  const stored = readValue(SERVER_TENANT_KEY)?.trim();
  if (stored) return stored;
  const configured = import.meta.env.VITE_SERVER_TENANT_ID?.trim();
  return configured || 'local';
}

export function setServerTenantId(tenantId: string): void {
  const value = tenantId.trim();
  if (value) writeValue(SERVER_TENANT_KEY, value);
  else removeValue(SERVER_TENANT_KEY);
}

export function getServerAuthToken(): string | undefined {
  const stored = readValue(SERVER_TOKEN_KEY)?.trim();
  if (stored) return stored;
  const configured = import.meta.env.VITE_SERVER_TOKEN?.trim();
  return configured || undefined;
}

export function setServerAuthToken(token: string): void {
  const value = token.trim();
  if (value) writeValue(SERVER_TOKEN_KEY, value);
  else removeValue(SERVER_TOKEN_KEY);
}

export function clearServerClientConfig(): void {
  removeValue(SERVER_TOKEN_KEY);
  removeValue(SERVER_TENANT_KEY);
}

export function serverHeaders(workspaceId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Tenant-Id': getServerTenantId(),
  };
  const token = getServerAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (workspaceId) headers['X-Workspace-Id'] = workspaceId;
  return headers;
}
