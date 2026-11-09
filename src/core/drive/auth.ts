const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'openid',
  'email',
  'profile',
] as const;

export const GMAIL_SCOPES = [
  ...DRIVE_SCOPES,
  'https://www.googleapis.com/auth/gmail.readonly',
] as const;

export interface DriveTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope?: string;
  tokenType?: string;
  email?: string;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomUrlSafe(bytes = 32): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return base64Url(data);
}

export async function createPkcePair(): Promise<PkcePair> {
  const verifier = randomUrlSafe(48);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

export interface AuthUrlOptions {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  scopes?: readonly string[];
  loginHint?: string;
}

export function buildAuthUrl(options: AuthUrlOptions): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', (options.scopes ?? DRIVE_SCOPES).join(' '));
  url.searchParams.set('state', options.state);
  url.searchParams.set('code_challenge', options.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  if (options.loginHint) url.searchParams.set('login_hint', options.loginHint);
  return url.toString();
}

export interface AuthRedirect {
  code: string;
  state?: string;
}

export function parseAuthRedirect(redirectUrl: string): AuthRedirect {
  const url = new URL(redirectUrl);
  const error = url.searchParams.get('error');
  if (error) {
    throw new Error(`Google authorization failed: ${error}`);
  }
  const code = url.searchParams.get('code');
  if (!code) throw new Error('Google authorization response has no code');
  const state = url.searchParams.get('state');
  return { code, ...(state ? { state } : {}) };
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

async function requestToken(
  body: URLSearchParams,
  fetchImpl: typeof fetch,
): Promise<DriveTokens> {
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok || !data.access_token) {
    throw new Error(
      `Google token request failed: ${data.error_description ?? data.error ?? response.statusText}`,
    );
  }
  return {
    accessToken: data.access_token,
    ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
    expiresAt: Date.now() + Math.max((data.expires_in ?? 3600) - 60, 60) * 1000,
    ...(data.scope ? { scope: data.scope } : {}),
    ...(data.token_type ? { tokenType: data.token_type } : {}),
  };
}

export interface ExchangeCodeOptions {
  clientId: string;
  code: string;
  verifier: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}

export async function exchangeAuthorizationCode(
  options: ExchangeCodeOptions,
): Promise<DriveTokens> {
  const body = new URLSearchParams({
    client_id: options.clientId,
    code: options.code,
    code_verifier: options.verifier,
    grant_type: 'authorization_code',
    redirect_uri: options.redirectUri,
  });
  return requestToken(body, options.fetchImpl ?? fetch);
}

export interface RefreshOptions {
  clientId: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}

export async function refreshAccessToken(options: RefreshOptions): Promise<DriveTokens> {
  const body = new URLSearchParams({
    client_id: options.clientId,
    refresh_token: options.refreshToken,
    grant_type: 'refresh_token',
  });
  const tokens = await requestToken(body, options.fetchImpl ?? fetch);
  return { ...tokens, refreshToken: options.refreshToken };
}

export async function fetchUserInfo(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ email?: string; name?: string }> {
  const response = await fetchImpl('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return {};
  const data = (await response.json()) as { email?: string; name?: string };
  return {
    ...(data.email ? { email: data.email } : {}),
    ...(data.name ? { name: data.name } : {}),
  };
}

export async function revokeToken(token: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await fetchImpl(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
    method: 'POST',
  });
}

export function isTokenFresh(tokens: DriveTokens): boolean {
  return tokens.accessToken.length > 0 && tokens.expiresAt > Date.now() + 30_000;
}
