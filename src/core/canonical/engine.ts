import type { LedgerDatabase } from '@/core/db/db';
import type {
  RawArtifact,
  FinancialObservation,
  CanonicalTxn,
  MoneyEvent,
} from '@/core/model';
import { newId, nowIso } from '@/core/ids';
import { computeCanonicalTxnUid, type TxnUidParams } from './txn-uid';
import { detectTransferOrSettlement } from './accounts';

export interface IngestArtifactInput {
  source: RawArtifact['source'];
  messageId?: string | undefined;
  fileName?: string | undefined;
  mimeType: string;
  sha256: string;
  sizeBytes: number;
  storagePath?: string | undefined;
  authStatus?: RawArtifact['authStatus'] | undefined;
  metadata?: Record<string, unknown> | undefined;
  receivedAt?: string | undefined;
}

export interface IngestObservationInput {
  instrumentType?: FinancialObservation['instrumentType'] | undefined;
  issuer?: string | undefined;
  accountTail?: string | undefined;
  channel?: FinancialObservation['channel'] | undefined;
  date: string;
  amountMinor: number;
  direction: 'in' | 'out';
  currency?: string | undefined;
  merchantRaw?: string | undefined;
  merchantNormalized?: string | undefined;
  counterpartyVpa?: string | undefined;
  counterpartyName?: string | undefined;
  referenceId?: string | undefined;
  rail?: string | undefined;
  confidence?: number | undefined;
  rawSnippet?: string | undefined;
  orderId?: string | undefined;
}

export async function storeRawArtifact(
  db: LedgerDatabase,
  workspaceId: string,
  input: IngestArtifactInput,
): Promise<RawArtifact> {
  const existing = await db.rawArtifacts
    .where('sha256')
    .equals(input.sha256)
    .first();
  if (existing && existing.workspaceId === workspaceId) {
    return existing;
  }

  const now = nowIso();
  const artifact: RawArtifact = {
    id: newId('art'),
    workspaceId,
    source: input.source,
    messageId: input.messageId,
    fileName: input.fileName,
    mimeType: input.mimeType,
    sha256: input.sha256,
    sizeBytes: input.sizeBytes,
    storagePath: input.storagePath,
    authStatus: input.authStatus,
    metadata: input.metadata,
    receivedAt: input.receivedAt,
    createdAt: now,
    updatedAt: now,
  };

  await db.rawArtifacts.add(artifact);
  return artifact;
}

export async function processFinancialObservation(
  db: LedgerDatabase,
  workspaceId: string,
  artifactId: string,
  input: IngestObservationInput,
): Promise<{ observation: FinancialObservation; canonicalTxn: CanonicalTxn; isNew: boolean }> {
  const now = nowIso();

  // 1. Compute Deterministic Canonical Txn UID
  const uidParams: TxnUidParams = {
    date: input.date,
    amountMinor: input.amountMinor,
    direction: input.direction,
    merchantRaw: input.merchantRaw,
    channel: input.channel,
    instrumentRef: input.accountTail ? `${input.issuer ?? 'inst'}_${input.accountTail}` : undefined,
  };

  if (input.referenceId) {
    if (input.rail === 'upi' || /^\d{12}$/.test(input.referenceId)) {
      uidParams.upiRrn = input.referenceId;
    } else if (input.rail === 'neft' || input.rail === 'rtgs' || input.referenceId.length >= 10) {
      uidParams.utr = input.referenceId;
    } else if (input.rail === 'card_auth' && input.accountTail) {
      uidParams.card = {
        issuer: input.issuer,
        last4: input.accountTail,
        authCode: input.referenceId,
      };
    }
  }

  if (input.orderId && input.merchantRaw) {
    uidParams.order = {
      merchant: input.merchantRaw,
      orderId: input.orderId,
    };
  }

  const computedUid = await computeCanonicalTxnUid(uidParams);

  // 2. Create the Observation Record
  const obsId = newId('obs');
  const observation: FinancialObservation = {
    id: obsId,
    workspaceId,
    artifactId,
    instrumentType: input.instrumentType ?? 'unknown',
    issuer: input.issuer,
    accountTail: input.accountTail,
    channel: input.channel ?? 'generic',
    date: input.date,
    amountMinor: input.amountMinor,
    direction: input.direction,
    currency: input.currency ?? 'INR',
    merchantRaw: input.merchantRaw,
    merchantNormalized: input.merchantNormalized,
    counterpartyVpa: input.counterpartyVpa,
    counterpartyName: input.counterpartyName,
    referenceId: input.referenceId,
    rail: input.rail,
    confidence: input.confidence ?? 0.85,
    rawSnippet: input.rawSnippet,
    createdAt: now,
    updatedAt: now,
  };

  // 3. Cluster with existing CanonicalTxn
  // A. Exact match by deterministic txnUid
  let existingTxn = await db.canonicalTxns
    .where('txnUid')
    .equals(computedUid.txnUid)
    .first();

  // B. Or match by exact payment rail reference (UPI RRN / UTR) if already recorded
  if (!existingTxn && input.referenceId && (input.rail === 'upi' || input.rail === 'neft' || input.rail === 'rtgs')) {
    existingTxn = await db.canonicalTxns
      .where('reference')
      .equals(input.referenceId)
      .first();
  }

  let canonicalTxn: CanonicalTxn;
  let isNew = false;

  if (existingTxn && existingTxn.workspaceId === workspaceId) {
    // Merge Observation into Existing Transaction!
    const updatedObsIds = Array.from(new Set([...existingTxn.observationIds, obsId]));
    const isStatementObservation = input.channel === 'generic' && input.rail === 'generic';

    const preferredCounterparty =
      observation.counterpartyName ??
      (existingTxn.counterparty && !/^upi[/-]/i.test(existingTxn.counterparty)
        ? existingTxn.counterparty
        : (observation.merchantNormalized ?? existingTxn.counterparty));

    canonicalTxn = {
      ...existingTxn,
      observationIds: updatedObsIds,
      confidence: Math.max(existingTxn.confidence, observation.confidence),
      // Promote from pending to posted if confirmed by statement or reliable alert
      status: isStatementObservation ? 'posted' : existingTxn.status,
      // Enrich merchant/counterparty details if new observation has better info
      counterparty: preferredCounterparty,
      counterpartyVpa: existingTxn.counterpartyVpa || observation.counterpartyVpa,
      reference: existingTxn.reference || observation.referenceId,
      updatedAt: now,
    };

    await db.canonicalTxns.put(canonicalTxn);
    observation.canonicalTxnId = canonicalTxn.id;
    await db.observations.add(observation);
  } else {
    // Create New CanonicalTxn
    isNew = true;
    const transferCheck = await detectTransferOrSettlement(db, workspaceId, observation);

    const ctxId = newId('ctx');
    canonicalTxn = {
      id: ctxId,
      workspaceId,
      txnUid: computedUid.txnUid,
      idBasis: computedUid.idBasis,
      date: input.date,
      amountMinor: input.amountMinor,
      direction: input.direction,
      currency: input.currency ?? 'INR',
      instrumentType: input.instrumentType ?? 'unknown',
      issuer: input.issuer,
      accountTail: input.accountTail,
      channel: input.channel ?? 'generic',
      counterparty: input.counterpartyName ?? input.merchantNormalized ?? input.merchantRaw,
      counterpartyVpa: input.counterpartyVpa,
      reference: input.referenceId,
      status: 'posted',
      isTransfer: transferCheck.isTransfer,
      category: transferCheck.isCreditCardPayment
        ? 'Liabilities:CreditCard'
        : transferCheck.isTransfer
          ? 'Transfers:OwnAccount'
          : undefined,
      confidence: observation.confidence,
      observationIds: [obsId],
      createdAt: now,
      updatedAt: now,
    };

    await db.canonicalTxns.add(canonicalTxn);
    observation.canonicalTxnId = ctxId;
    await db.observations.add(observation);

    // Also bridge to MoneyEvent to ensure 100% backward compatibility with Double-Entry Autopilot
    const existingMoneyEvent = await db.moneyEvents
      .where('sourceRef')
      .equals(input.referenceId ?? '')
      .first();

    if (!existingMoneyEvent && input.amountMinor > 0) {
      const mev: MoneyEvent = {
        id: newId('mev'),
        workspaceId,
        source: 'email',
        sourceRef: input.referenceId,
        contentHash: computedUid.txnUid.toLowerCase(),
        date: input.date,
        amountMinor: input.amountMinor,
        direction: input.direction,
        partyHint: canonicalTxn.counterparty,
        narration: input.merchantRaw ?? input.counterpartyName ?? 'Transaction observation',
        confidence: canonicalTxn.confidence,
        status: canonicalTxn.isTransfer ? 'suggested' : 'captured',
        createdAt: now,
        updatedAt: now,
      };
      await db.moneyEvents.add(mev);
    }
  }

  return { observation, canonicalTxn, isNew };
}

export async function listCanonicalTransactions(
  db: LedgerDatabase,
  workspaceId: string,
): Promise<Array<CanonicalTxn & { observations: FinancialObservation[] }>> {
  const txns = await db.canonicalTxns
    .where('workspaceId')
    .equals(workspaceId)
    .reverse()
    .sortBy('date');

  const result: Array<CanonicalTxn & { observations: FinancialObservation[] }> = [];

  for (const txn of txns) {
    const obsList = await db.observations
      .where('canonicalTxnId')
      .equals(txn.id)
      .toArray();
    result.push({ ...txn, observations: obsList });
  }

  return result;
}
