import { describe, expect, it } from 'vitest';
import {
  createLicenseKey,
  verifyLicenseKey,
  getLicenseState,
  isFeatureEnabled,
} from '../src/core/license/license';

describe('Product Licensing & Monetization Engine', () => {
  it('creates and verifies a valid Pro license key offline', async () => {
    const payload = {
      licensee: 'Acme Traders LLP',
      email: 'founder@acmetraders.in',
      tier: 'pro' as const,
      issuedAt: '2026-01-01',
      expiresAt: '2027-01-01',
      maxWorkspaces: 1,
    };

    const key = await createLicenseKey(payload);
    expect(key).toMatch(/^0L-PRO-[A-Za-z0-9+/=]+-[A-F0-9]{16}$/);

    const verified = await verifyLicenseKey(key);
    expect(verified).not.toBeNull();
    expect(verified?.licensee).toBe('Acme Traders LLP');
    expect(verified?.tier).toBe('pro');
  });

  it('rejects tampered or corrupt license keys', async () => {
    const validKey = await createLicenseKey({
      licensee: 'Real Company',
      email: 'real@example.com',
      tier: 'pro',
      issuedAt: '2026-01-01',
      expiresAt: '2027-01-01',
      maxWorkspaces: 1,
    });

    const tampered = validKey.slice(0, -4) + 'AAAA';
    const verified = await verifyLicenseKey(tampered);
    expect(verified).toBeNull();
  });

  it('rejects expired license keys', async () => {
    const expiredKey = await createLicenseKey({
      licensee: 'Past Company',
      email: 'past@example.com',
      tier: 'pro',
      issuedAt: '2024-01-01',
      expiresAt: '2024-12-31',
      maxWorkspaces: 1,
    });

    const verified = await verifyLicenseKey(expiredKey);
    expect(verified).toBeNull();
  });

  it('provisions 1-year free trial for new workspaces', async () => {
    const justCreated = new Date().toISOString();
    const state = await getLicenseState(undefined, justCreated);
    expect(state.tier).toBe('pro');
    expect(state.isTrial).toBe(true);
    expect(state.trialDaysRemaining).toBe(365);
    expect(isFeatureEnabled('gstr2b_reconciliation', state)).toBe(true);
    expect(isFeatureEnabled('direct_tally_bridge', state)).toBe(true);
  });

  it('falls back to Community tier when trial expires and no key is present', async () => {
    const fourHundredDaysAgo = new Date(Date.now() - 400 * 86400000).toISOString();
    const state = await getLicenseState(undefined, fourHundredDaysAgo);
    expect(state.tier).toBe('community');
    expect(state.isTrial).toBe(false);
    expect(isFeatureEnabled('gstr2b_reconciliation', state)).toBe(false);
  });
});
