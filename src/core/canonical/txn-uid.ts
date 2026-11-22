import { sha256Bytes } from '@/core/util/hash';
import type { IdBasis } from '@/core/model/enums';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function bytesToBase32(bytes: Uint8Array): string {
  let result = '';
  let buffer = 0;
  let bitsLeft = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bitsLeft += 8;
    while (bitsLeft >= 5) {
      bitsLeft -= 5;
      const index = (buffer >> bitsLeft) & 0x1f;
      result += BASE32_ALPHABET[index];
    }
  }

  if (bitsLeft > 0) {
    const index = (buffer << (5 - bitsLeft)) & 0x1f;
    result += BASE32_ALPHABET[index];
  }

  return result;
}

export interface TxnUidParams {
  upiRrn?: string | undefined;
  utr?: string | undefined;
  arn?: string | undefined;
  card?: {
    issuer?: string | undefined;
    last4: string;
    authCode?: string | undefined;
  } | undefined;
  order?: {
    merchant: string;
    orderId: string;
    shipmentId?: string | undefined;
  } | undefined;
  date: string; // YYYY-MM-DD
  amountMinor: number;
  direction: 'in' | 'out';
  merchantRaw?: string | undefined;
  channel?: string | undefined;
  instrumentRef?: string | undefined;
  seqInDay?: number | undefined;
}

export interface ComputedTxnUid {
  txnUid: string;
  basis: string;
  idBasis: IdBasis;
}

/**
 * Computes deterministic canonical transaction UID following natural-key-first priority:
 * 1. UPI / IMPS RRN: "upi:" + rrn12 (global nationwide switch key)
 * 2. NEFT / RTGS: "utr:" + utr
 * 3. Card Refund: "arn:" + arn23 + ":" + amount_minor
 * 4. Card Charge: "card:" + issuer + last4 + ":" + auth_code + ":" + yyyymmdd + ":" + amount_minor
 * 5. Commerce Order: "ord:" + merchant + order_id [:shipment_id]
 * 6. Fallback Fingerprint: "fp1:" + sha256(inst_ref | yyyymmdd | amount | direction | merchant | channel | seq)
 *
 * Output: RFC 4648 Base32 encoded 26-character identifier.
 */
export async function computeCanonicalTxnUid(params: TxnUidParams): Promise<ComputedTxnUid> {
  const yyyymmdd = params.date.replace(/-/g, '').slice(0, 8);

  // 1. UPI / IMPS (12-digit RRN: global nationwide switch ID)
  if (params.upiRrn && /^\d{12}$/.test(params.upiRrn.trim())) {
    const basis = `upi:${params.upiRrn.trim()}`;
    const hashBytes = await sha256Bytes(basis);
    const txnUid = bytesToBase32(hashBytes).slice(0, 26);
    return { txnUid, basis, idBasis: 'upi' };
  }

  // 2. NEFT / RTGS (UTR)
  if (params.utr && params.utr.trim().length >= 10) {
    const basis = `utr:${params.utr.trim().toUpperCase()}`;
    const hashBytes = await sha256Bytes(basis);
    const txnUid = bytesToBase32(hashBytes).slice(0, 26);
    return { txnUid, basis, idBasis: 'utr' };
  }

  // 3. Card Refund (ARN 23-digit + amount)
  if (params.arn && /^\d{23}$/.test(params.arn.trim())) {
    const basis = `arn:${params.arn.trim()}:${params.amountMinor}`;
    const hashBytes = await sha256Bytes(basis);
    const txnUid = bytesToBase32(hashBytes).slice(0, 26);
    return { txnUid, basis, idBasis: 'arn' };
  }

  // 4. Card Charge (issuer + last4 + authCode + date + amount)
  if (params.card?.last4 && params.card.authCode) {
    const issuer = (params.card.issuer || 'card').toLowerCase().replace(/[^a-z0-9]/g, '');
    const auth = params.card.authCode.trim().toUpperCase();
    const basis = `card:${issuer}${params.card.last4}:${auth}:${yyyymmdd}:${params.amountMinor}`;
    const hashBytes = await sha256Bytes(basis);
    const txnUid = bytesToBase32(hashBytes).slice(0, 26);
    return { txnUid, basis, idBasis: 'card' };
  }

  // 5. Commerce Order (merchant + orderId)
  if (params.order?.merchant && params.order.orderId) {
    const merchant = params.order.merchant.toLowerCase().replace(/[^a-z0-9]/g, '');
    const orderId = params.order.orderId.trim().toUpperCase();
    const shipment = params.order.shipmentId ? `:${params.order.shipmentId.trim()}` : '';
    const basis = `ord:${merchant}:${orderId}${shipment}`;
    const hashBytes = await sha256Bytes(basis);
    const txnUid = bytesToBase32(hashBytes).slice(0, 26);
    return { txnUid, basis, idBasis: 'order' };
  }

  // 6. Versioned Fingerprint Fallback (fp1)
  const normMerchant = (params.merchantRaw ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const instRef = params.instrumentRef ?? (params.card?.last4 ? `card_${params.card.last4}` : 'gen');
  const seq = params.seqInDay ?? 1;
  const channel = params.channel ?? 'generic';

  const basis = [
    'fp1',
    instRef,
    yyyymmdd,
    params.amountMinor,
    params.direction,
    normMerchant,
    channel,
    seq,
  ].join('|');

  const hashBytes = await sha256Bytes(basis);
  const txnUid = bytesToBase32(hashBytes).slice(0, 26);
  return { txnUid, basis, idBasis: 'fingerprint' };
}
