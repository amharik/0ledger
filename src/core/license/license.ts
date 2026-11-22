import { sha256Hex } from '../util/hash';
import { nowIso } from '../ids';

export type LicenseTier = 'community' | 'pro' | 'ca_practice';

export type LicenseFeature =
  | 'gstr2b_reconciliation'
  | 'direct_tally_bridge'
  | 'ocr_invoice_scanner'
  | 'unlimited_rules'
  | 'multi_client_cockpit'
  | 'priority_ca_pack';

export interface LicensePayload {
  licensee: string;
  email: string;
  tier: LicenseTier;
  issuedAt: string; // YYYY-MM-DD
  expiresAt: string; // YYYY-MM-DD
  maxWorkspaces: number;
}

export interface LicenseState {
  tier: LicenseTier;
  isTrial: boolean;
  trialDaysRemaining?: number;
  isActive: boolean;
  licensee?: string;
  expiresAt?: string;
  enabledFeatures: LicenseFeature[];
}

const TIER_FEATURES: Record<LicenseTier, LicenseFeature[]> = {
  community: [],
  pro: [
    'gstr2b_reconciliation',
    'direct_tally_bridge',
    'ocr_invoice_scanner',
    'unlimited_rules',
    'priority_ca_pack',
  ],
  ca_practice: [
    'gstr2b_reconciliation',
    'direct_tally_bridge',
    'ocr_invoice_scanner',
    'unlimited_rules',
    'multi_client_cockpit',
    'priority_ca_pack',
  ],
};

const LICENSE_SALT = '0ledger-monetized-pro-v1';

/**
 * Creates a signed license key string for the given payload.
 */
export async function createLicenseKey(payload: LicensePayload): Promise<string> {
  const json = JSON.stringify(payload);
  const base64 = btoa(unescape(encodeURIComponent(json)));
  const sig = await sha256Hex(`${base64}:${LICENSE_SALT}`);
  const shortSig = sig.slice(0, 16).toUpperCase();
  return `0L-${payload.tier.toUpperCase()}-${base64}-${shortSig}`;
}

/**
 * Validates a formatted license key string offline.
 */
export async function verifyLicenseKey(keyString: string): Promise<LicensePayload | null> {
  const trimmed = keyString.trim();
  const match = /^0L-(COMMUNITY|PRO|CA_PRACTICE)-([A-Za-z0-9+/=]+)-([A-F0-9]{16})$/i.exec(trimmed);
  if (!match) return null;

  const base64Payload = match[2];
  const signature = match[3];
  if (!base64Payload || !signature) return null;

  const expectedSig = (await sha256Hex(`${base64Payload}:${LICENSE_SALT}`)).slice(0, 16).toUpperCase();

  if (signature.toUpperCase() !== expectedSig) {
    return null;
  }

  try {
    const json = decodeURIComponent(escape(atob(base64Payload)));
    const payload = JSON.parse(json) as LicensePayload;

    const today = nowIso().slice(0, 10);
    if (payload.expiresAt && payload.expiresAt < today) {
      return null; // Expired
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Computes active license state given stored key or falls back to a 14-day trial.
 */
export async function getLicenseState(
  storedKey?: string,
  workspaceCreatedAt?: string,
): Promise<LicenseState> {
  if (storedKey) {
    const verified = await verifyLicenseKey(storedKey);
    if (verified) {
      return {
        tier: verified.tier,
        isTrial: false,
        isActive: true,
        licensee: verified.licensee,
        expiresAt: verified.expiresAt,
        enabledFeatures: TIER_FEATURES[verified.tier],
      };
    }
  }

  // Evaluate 1-Year (365 days) Pro Trial based on workspace creation timestamp
  if (workspaceCreatedAt) {
    const createdDate = new Date(workspaceCreatedAt);
    const now = new Date();
    const diffDays = Math.floor((now.getTime() - createdDate.getTime()) / (1000 * 60 * 60 * 24));
    const trialDaysRemaining = Math.max(0, 365 - diffDays);

    if (trialDaysRemaining > 0) {
      return {
        tier: 'pro',
        isTrial: true,
        trialDaysRemaining,
        isActive: true,
        licensee: 'Pro Trial User',
        expiresAt: new Date(createdDate.getTime() + 365 * 86400000).toISOString().slice(0, 10),
        enabledFeatures: TIER_FEATURES['pro'],
      };
    }
  }

  // Community Free Default
  return {
    tier: 'community',
    isTrial: false,
    isActive: true,
    enabledFeatures: TIER_FEATURES['community'],
  };
}

export function isFeatureEnabled(feature: LicenseFeature, state: LicenseState): boolean {
  return state.enabledFeatures.includes(feature);
}
