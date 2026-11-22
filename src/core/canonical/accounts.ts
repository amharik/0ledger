import type { LedgerDatabase } from '@/core/db/db';
import type { OwnAccount, FinancialObservation } from '@/core/model';
import { newId, nowIso } from '@/core/ids';

export async function registerOwnAccount(
  db: LedgerDatabase,
  workspaceId: string,
  input: {
    type: OwnAccount['type'];
    institution: string;
    accountTail: string;
    maskedNumber?: string | undefined;
    vpas?: string[] | undefined;
    ledgerId?: string | undefined;
    isPrimary?: boolean | undefined;
  },
): Promise<OwnAccount> {
  const existing = await db.ownAccounts
    .where('[workspaceId+accountTail]')
    .equals([workspaceId, input.accountTail])
    .first();

  const now = nowIso();

  if (existing) {
    const updated: OwnAccount = {
      ...existing,
      type: input.type,
      institution: input.institution,
      maskedNumber: input.maskedNumber ?? existing.maskedNumber,
      vpas: Array.from(new Set([...existing.vpas, ...(input.vpas ?? [])])),
      ledgerId: input.ledgerId ?? existing.ledgerId,
      isPrimary: input.isPrimary ?? existing.isPrimary,
      updatedAt: now,
    };
    await db.ownAccounts.put(updated);
    return updated;
  }

  const account: OwnAccount = {
    id: newId('oac'),
    workspaceId,
    type: input.type,
    institution: input.institution,
    accountTail: input.accountTail,
    maskedNumber: input.maskedNumber,
    vpas: input.vpas ?? [],
    ledgerId: input.ledgerId,
    isPrimary: input.isPrimary ?? false,
    createdAt: now,
    updatedAt: now,
  };

  await db.ownAccounts.add(account);
  return account;
}

export async function listOwnAccounts(
  db: LedgerDatabase,
  workspaceId: string,
): Promise<OwnAccount[]> {
  return await db.ownAccounts.where('workspaceId').equals(workspaceId).toArray();
}

export async function findOwnAccount(
  db: LedgerDatabase,
  workspaceId: string,
  query: {
    accountTail?: string | undefined;
    vpa?: string | undefined;
    institution?: string | undefined;
  },
): Promise<OwnAccount | undefined> {
  if (query.accountTail) {
    const found = await db.ownAccounts
      .where('[workspaceId+accountTail]')
      .equals([workspaceId, query.accountTail])
      .first();
    if (found) return found;
  }

  const accounts = await listOwnAccounts(db, workspaceId);

  if (query.vpa) {
    const vpaClean = query.vpa.toLowerCase().trim();
    const found = accounts.find((a) =>
      a.vpas.some((v) => v.toLowerCase().trim() === vpaClean),
    );
    if (found) return found;
  }

  if (query.institution) {
    const instClean = query.institution.toLowerCase().trim();
    const found = accounts.find((a) =>
      a.institution.toLowerCase().includes(instClean),
    );
    if (found) return found;
  }

  return undefined;
}

export interface TransferResolution {
  isTransfer: boolean;
  isCreditCardPayment: boolean;
  debitAccount?: OwnAccount | undefined;
  creditAccount?: OwnAccount | undefined;
  confidence: number;
  reason?: string | undefined;
}

/**
 * Evaluates whether two observations or a transaction represents a self-transfer or credit card settlement:
 * 1. Both instruments belong to the user's registered OwnAccounts.
 * 2. If debit account is Bank/Savings and credit is Credit Card -> CC Bill Settlement (Liabilities:CC <-> Assets:Bank).
 * 3. If both accounts are Banks/Wallets -> Inter-Account Contra Transfer (Assets:Bank:A <-> Assets:Bank:B).
 */
export async function detectTransferOrSettlement(
  db: LedgerDatabase,
  workspaceId: string,
  obs1: FinancialObservation,
  obs2?: FinancialObservation,
): Promise<TransferResolution> {
  const accounts = await listOwnAccounts(db, workspaceId);
  if (accounts.length === 0) {
    return { isTransfer: false, isCreditCardPayment: false, confidence: 0 };
  }

  // Helper to match observation to an own account
  const matchAccount = (obs: FinancialObservation): OwnAccount | undefined => {
    if (obs.accountTail) {
      const match = accounts.find((a) => a.accountTail === obs.accountTail);
      if (match) return match;
    }
    if (obs.counterpartyVpa) {
      const vpa = obs.counterpartyVpa.toLowerCase();
      const match = accounts.find((a) => a.vpas.some((v) => v.toLowerCase() === vpa));
      if (match) return match;
    }
    return undefined;
  };

  const acct1 = matchAccount(obs1);

  // If we have both legs of the transaction (e.g. Bank Debit alert and Card Credit / Bank B Credit alert)
  if (obs2) {
    const acct2 = matchAccount(obs2);
    if (acct1 && acct2 && acct1.id !== acct2.id) {
      const isCCPayment =
        (acct1.type === 'card' && acct2.type !== 'card') ||
        (acct2.type === 'card' && acct1.type !== 'card');

      return {
        isTransfer: true,
        isCreditCardPayment: isCCPayment,
        debitAccount: obs1.direction === 'out' ? acct1 : acct2,
        creditAccount: obs1.direction === 'in' ? acct1 : acct2,
        confidence: 0.98,
        reason: isCCPayment
          ? 'Matched own credit card payment settlement across registered accounts'
          : 'Matched own inter-account transfer across registered accounts',
      };
    }
  }

  // Single observation analysis (e.g. "Payment received for your credit card" or "Self transfer")
  const narration = (obs1.merchantRaw ?? '').toLowerCase();
  const isCcKeyword =
    /credit card bill|cc payment|card payment received|billdesk.*credit|autopay.*card/i.test(
      narration,
    );

  if (acct1 && acct1.type === 'card' && obs1.direction === 'in') {
    return {
      isTransfer: true,
      isCreditCardPayment: true,
      creditAccount: acct1,
      confidence: 0.92,
      reason: 'Credit card payment received on registered own card',
    };
  }

  if (isCcKeyword && obs1.direction === 'out') {
    return {
      isTransfer: true,
      isCreditCardPayment: true,
      debitAccount: acct1,
      confidence: 0.88,
      reason: 'Credit card bill payment debit detected from bank',
    };
  }

  return { isTransfer: false, isCreditCardPayment: false, confidence: 0 };
}
