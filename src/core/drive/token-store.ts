import {
  isTokenFresh,
  refreshAccessToken,
  type DriveTokens,
} from './auth';

const CLIENT_ID_KEY = 'drive.clientId';
const TOKENS_KEY = 'drive.tokens';

let memoryTokens: DriveTokens | undefined;

export interface StoredDriveAuth {
  clientId: string;
  tokens: DriveTokens;
}

interface UniversalStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

async function getStorage(): Promise<UniversalStorage> {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    return {
      get: (key: string) => chrome.storage.local.get(key),
      set: (items: Record<string, unknown>) => chrome.storage.local.set(items),
      remove: (key: string) => chrome.storage.local.remove(key),
    };
  }
  return {
    get: async (key: string) => {
      const raw = localStorage.getItem(key);
      try {
        return raw ? { [key]: JSON.parse(raw) } : {};
      } catch {
        return raw ? { [key]: raw } : {};
      }
    },
    set: async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) {
        localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
      }
    },
    remove: async (key: string) => {
      localStorage.removeItem(key);
    },
  };
}

export async function saveDriveClientId(clientId: string): Promise<void> {
  await (await getStorage()).set({ [CLIENT_ID_KEY]: clientId.trim() });
}

export async function getDriveClientId(): Promise<string | undefined> {
  const value = (await (await getStorage()).get(CLIENT_ID_KEY))[CLIENT_ID_KEY];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export async function saveDriveTokens(tokens: DriveTokens): Promise<void> {
  memoryTokens = tokens;
  const persisted = {
    accessToken: '',
    expiresAt: 0,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.scope ? { scope: tokens.scope } : {}),
    ...(tokens.tokenType ? { tokenType: tokens.tokenType } : {}),
    ...(tokens.email ? { email: tokens.email } : {}),
  };
  await (await getStorage()).set({ [TOKENS_KEY]: persisted });
}

export async function getDriveTokens(): Promise<DriveTokens | undefined> {
  if (memoryTokens) return memoryTokens;
  const value = (await (await getStorage()).get(TOKENS_KEY))[TOKENS_KEY];
  if (!value || typeof value !== 'object') return undefined;
  const tokens = value as DriveTokens;
  if (typeof tokens.accessToken !== 'string' || typeof tokens.expiresAt !== 'number') return undefined;
  return tokens;
}

export async function clearDriveTokens(): Promise<void> {
  memoryTokens = undefined;
  await (await getStorage()).remove(TOKENS_KEY);
}

export async function getStoredDriveAuth(): Promise<StoredDriveAuth | undefined> {
  const clientId = await getDriveClientId();
  const tokens = await getDriveTokens();
  if (!clientId || !tokens) return undefined;
  return { clientId, tokens };
}

export async function getDriveAccessToken(): Promise<string | undefined> {
  if (memoryTokens && isTokenFresh(memoryTokens)) return memoryTokens.accessToken;
  const auth = await getStoredDriveAuth();
  if (!auth?.tokens.refreshToken) return undefined;
  try {
    const refreshed = await refreshAccessToken({
      clientId: auth.clientId,
      refreshToken: auth.tokens.refreshToken,
    });
    const tokens = { ...refreshed, ...(auth.tokens.email ? { email: auth.tokens.email } : {}) };
    await saveDriveTokens(tokens);
    return tokens.accessToken;
  } catch {
    return undefined;
  }
}
