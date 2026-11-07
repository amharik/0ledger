import { describe, expect, it, vi } from 'vitest';
import {
  buildAuthUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  parseAuthRedirect,
  refreshAccessToken,
  revokeToken,
} from '@/core/drive/auth';

describe('Google Drive OAuth', () => {
  it('builds a PKCE verifier and SHA-256 challenge', async () => {
    const pair = await createPkcePair();
    expect(pair.verifier.length).toBeGreaterThan(40);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pair.verifier).not.toBe(pair.challenge);
  });

  it('builds the consent URL with offline access and drive.file scope', () => {
    const url = new URL(
      buildAuthUrl({
        clientId: 'client.apps.googleusercontent.com',
        redirectUri: 'https://abc.chromiumapp.org/',
        challenge: 'challenge',
        state: 'state-1',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('client.apps.googleusercontent.com');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('scope')).toContain('auth/drive.file');
  });

  it('parses the redirect and rejects errors', () => {
    expect(parseAuthRedirect('https://abc.chromiumapp.org/?code=one&state=two')).toEqual({
      code: 'one',
      state: 'two',
    });
    expect(() => parseAuthRedirect('https://abc.chromiumapp.org/?error=access_denied')).toThrow(
      /access_denied/,
    );
  });

  it('exchanges a code and refreshes while keeping the refresh token', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access-1',
            refresh_token: 'refresh-1',
            expires_in: 3600,
            scope: 'drive.file',
            token_type: 'Bearer',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'access-2', expires_in: 3600 }), {
          status: 200,
        }),
      );

    const tokens = await exchangeAuthorizationCode({
      clientId: 'client',
      code: 'code',
      verifier: 'verifier',
      redirectUri: 'https://abc.chromiumapp.org/',
      fetchImpl: fetchMock,
    });
    expect(tokens.accessToken).toBe('access-1');
    expect(tokens.refreshToken).toBe('refresh-1');
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());

    const refreshed = await refreshAccessToken({
      clientId: 'client',
      refreshToken: tokens.refreshToken!,
      fetchImpl: fetchMock,
    });
    expect(refreshed.accessToken).toBe('access-2');
    expect(refreshed.refreshToken).toBe('refresh-1');

    const exchangeBody = fetchMock.mock.calls[0]![1]!.body as URLSearchParams;
    expect(exchangeBody.get('grant_type')).toBe('authorization_code');
    expect(exchangeBody.get('code_verifier')).toBe('verifier');
  });

  it('revokes a token', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    await revokeToken('token with space', fetchMock);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('token%20with%20space');
  });
});

describe('Drive file ids', () => {
  it('parses pasted Sheets URLs and ids', async () => {
    const { parseDriveFileId } = await import('@/core/drive/api');
    expect(
      parseDriveFileId('https://docs.google.com/spreadsheets/d/abcDEF1234567890/edit#gid=0'),
    ).toBe('abcDEF1234567890');
    expect(
      parseDriveFileId('https://drive.google.com/open?id=abcDEF1234567890'),
    ).toBe('abcDEF1234567890');
    expect(parseDriveFileId('abcDEF1234567890abcdefghij')).toBe('abcDEF1234567890abcdefghij');
    expect(parseDriveFileId('not a link')).toBeUndefined();
  });
});
