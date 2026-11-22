import { parseAmountToMinor } from '@/core/money/money';
import { detectStatementAdapter } from './adapters';
import { parseStatementDate } from './parsers';
import type { ParsedStatement, ParsedStatementRow, StatementKind } from './types';

const AMOUNT_REGEX = /(?:₹|inr|rs\.?)?\s*([\d,]+(?:\.\d{1,2})?)/i;

function cleanAmount(raw: unknown): number {
  if (typeof raw === 'number') return Math.round(raw * 100);
  if (!raw || typeof raw !== 'string') return 0;
  const match = raw.match(AMOUNT_REGEX);
  if (!match?.[1]) return 0;
  try {
    return Math.abs(parseAmountToMinor(match[1]));
  } catch {
    return 0;
  }
}

/**
 * Parses NPS (National Pension System) Statements from Protean (CRA-NSDL) or KFintech.
 * Extracts PRAN, Tier I / Tier II, subscriber/employer contributions, NAV, and units.
 */
export function parseNpsStatement(
  text: string,
  options: { fileName?: string | undefined } = {},
): ParsedStatement {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows: ParsedStatementRow[] = [];

  // Extract PRAN (12 numeric digits)
  const pranMatch = text.match(/\b(?:pran|pran\s*no\.?)[:\s]*(\d{12})\b/i);
  const pran = pranMatch?.[1];

  // Extract Tier
  const tierMatch = text.match(/\b(tier\s*i{1,2})\b/i);
  const tier = tierMatch?.[1] ? tierMatch[1].toUpperCase() : 'TIER I';

  for (const line of lines) {
    // Look for lines with dates
    const dateMatch = line.match(/\b(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/);
    if (!dateMatch?.[1]) continue;

    const rawDate = dateMatch[1];
    const date = parseStatementDate(rawDate) ?? rawDate;
    const lower = line.toLowerCase();

    // Check if line represents a contribution or unit allocation
    const isContribution =
      lower.includes('contribution') ||
      lower.includes('subscriber') ||
      lower.includes('employer') ||
      lower.includes('purchase') ||
      lower.includes('invested');

    if (!isContribution) continue;

    // Extract amount
    const amountMatches = [...line.matchAll(/(?:₹|inr|rs\.?)?\s*([\d,]+\.\d{2})/gi)];
    if (amountMatches.length === 0) continue;

    const lastMatch = amountMatches[amountMatches.length - 1];
    if (!lastMatch?.[1]) continue;
    const lastAmount = cleanAmount(lastMatch[1]);
    if (lastAmount === 0) continue;

    // Extract units and NAV if present
    let units: number | undefined;
    let nav: number | undefined;
    if (amountMatches.length >= 3) {
      const navStr = amountMatches[amountMatches.length - 3]?.[1];
      const unitsStr = amountMatches[amountMatches.length - 2]?.[1];
      if (navStr) nav = parseFloat(navStr.replace(/,/g, ''));
      if (unitsStr) units = parseFloat(unitsStr.replace(/,/g, ''));
    }

    const isEmployer = lower.includes('employer');
    const desc = isEmployer
      ? `NPS ${tier} Employer Contribution`
      : `NPS ${tier} Subscriber Contribution`;

    rows.push({
      date,
      description: desc,
      debitMinor: lastAmount, // Investment into NPS asset
      creditMinor: 0,
      currency: 'INR',
      raw: {
        ...(pran ? { pran } : {}),
        tier,
        isEmployer,
        ...(nav !== undefined ? { nav } : {}),
        ...(units !== undefined ? { units } : {}),
        statementKind: 'nps',
        sourceLine: line,
      },
    });
  }

  const adapter = detectStatementAdapter(text, options.fileName, 'nps');

  return {
    adapterId: adapter.id,
    adapterName: adapter.name,
    kind: 'nps',
    currency: 'INR',
    rows,
    sourceText: text,
  };
}

/**
 * Parses Public Provident Fund (PPF) Statements.
 * Extracts PPF A/c number, subscriptions (deposits), and annual tax-free interest credited u/s 10(11).
 */
export function parsePpfStatement(
  text: string,
  options: { fileName?: string | undefined } = {},
): ParsedStatement {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows: ParsedStatementRow[] = [];

  // Extract PPF A/c
  const accMatch = text.match(/\b(?:ppf\s*(?:a\/c|account|no\.?))[:\s]*([Xx\*0-9]{8,18})\b/i);
  const ppfAccount = accMatch?.[1];

  for (const line of lines) {
    const dateMatch = line.match(/\b(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/);
    if (!dateMatch?.[1]) continue;

    const rawDate = dateMatch[1];
    const date = parseStatementDate(rawDate) ?? rawDate;
    const rest = line.slice((dateMatch.index ?? 0) + dateMatch[0].length);
    const lower = rest.toLowerCase();

    // Check if interest credit or subscription deposit
    const isInterest = lower.includes('interest') || lower.includes('int.');
    const isDeposit = lower.includes('deposit') || lower.includes('subscription') || lower.includes('cr') || isInterest;

    const amounts = [...rest.matchAll(/(?:₹|inr|rs\.?)?\s*(\d{1,3}(?:,\d{2,3})*(?:\.\d{2})|\d{1,3}(?:,\d{2,3})+)/gi)]
      .map((m) => (m[1] ? cleanAmount(m[1]) : 0))
      .filter((a) => a > 0);

    if (amounts.length === 0) continue;

    const amount = amounts[0];
    if (amount === undefined) continue;
    const balance = amounts.length > 1 ? amounts[amounts.length - 1] : undefined;

    let desc = 'PPF Subscription / Deposit';
    if (isInterest) {
      desc = 'Interest Credited u/s 10(11) (Tax-Free)';
    }

    rows.push({
      date,
      description: desc,
      debitMinor: isDeposit ? amount : 0, // Asset increase in PPF
      creditMinor: isDeposit ? 0 : amount,
      ...(balance !== undefined ? { balanceMinor: balance } : {}),
      currency: 'INR',
      raw: {
        ...(ppfAccount ? { ppfAccount } : {}),
        isInterest,
        taxSection: isInterest ? '10(11)' : undefined,
        statementKind: 'ppf',
        sourceLine: line,
      },
    });
  }

  const adapter = detectStatementAdapter(text, options.fileName, 'ppf');

  return {
    adapterId: adapter.id,
    adapterName: adapter.name,
    kind: 'ppf',
    currency: 'INR',
    rows,
    sourceText: text,
  };
}

/**
 * Parses Bank Interest & TDS Statements (Interest Certificates, Form 16A, FD Interest Statements).
 * Identifies:
 * 1. Savings Bank (SB) Interest (exempt u/s 80TTA up to ₹10,000)
 * 2. Term Deposit / Fixed Deposit (FD) Interest Credited
 * 3. TDS Deducted u/s 194A (typically 10%)
 */
export function parseInterestCertificate(
  text: string,
  options: { fileName?: string | undefined } = {},
): ParsedStatement {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows: ParsedStatementRow[] = [];

  for (const line of lines) {
    const lower = line.toLowerCase();
    const hasInterest = lower.includes('interest') || lower.includes('sb int') || lower.includes('fd int') || lower.includes('term deposit');
    const hasTds = lower.includes('tds') || lower.includes('194a') || lower.includes('tax deducted');

    if (!hasInterest && !hasTds) continue;

    const dateMatch = line.match(/\b(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/);
    if (!dateMatch?.[1]) continue;
    const rawDate = dateMatch[1];
    const date = parseStatementDate(rawDate) ?? rawDate;
    const rest = line.slice((dateMatch.index ?? 0) + dateMatch[0].length);

    const amounts = [...rest.matchAll(/(?:₹|inr|rs\.?)?\s*(\d{1,3}(?:,\d{2,3})*(?:\.\d{2})|\d{1,3}(?:,\d{2,3})+)/gi)]
      .map((m) => (m[1] ? cleanAmount(m[1]) : 0))
      .filter((a) => a > 0);

    if (amounts.length === 0) continue;
    const amount = amounts[0];
    if (amount === undefined) continue;

    if (hasTds) {
      rows.push({
        date,
        description: 'TDS Deducted u/s 194A on Interest',
        debitMinor: amount, // Asset / Tax receivable: TDS Asset
        creditMinor: 0,
        currency: 'INR',
        raw: {
          taxSection: '194A',
          type: 'tds_deduction',
          statementKind: 'interest',
          sourceLine: line,
        },
      });
    } else {
      const isSb = lower.includes('savings') || lower.includes('sb') || lower.includes('saving');
      const desc = isSb
        ? 'Savings Bank Interest Credited (u/s 80TTA)'
        : 'Fixed Deposit / Term Deposit Interest Credited';

      rows.push({
        date,
        description: desc,
        debitMinor: 0,
        creditMinor: amount, // Income credit
        currency: 'INR',
        raw: {
          type: isSb ? 'savings_interest' : 'fd_interest',
          taxSection: isSb ? '80TTA' : undefined,
          statementKind: 'interest',
          sourceLine: line,
        },
      });
    }
  }

  const adapter = detectStatementAdapter(text, options.fileName, 'interest');

  return {
    adapterId: adapter.id,
    adapterName: adapter.name,
    kind: 'interest',
    currency: 'INR',
    rows,
    sourceText: text,
  };
}

/**
 * Parses P2P Lending Statements (12% Club, Faircent, LenDenClub, CRED Mint).
 * Accurately distinguishes between:
 * 1. Interest earnings/payouts (Taxable Income)
 * 2. Principal repayments from borrowers (Asset recovery)
 * 3. Fresh lending investments (Asset additions)
 */
export function parseP2pStatement(
  text: string,
  options: { fileName?: string | undefined } = {},
): ParsedStatement {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows: ParsedStatementRow[] = [];

  for (const line of lines) {
    const dateMatch = line.match(/\b(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/);
    if (!dateMatch?.[1]) continue;

    const rawDate = dateMatch[1];
    const date = parseStatementDate(rawDate) ?? rawDate;
    const rest = line.slice((dateMatch.index ?? 0) + dateMatch[0].length);
    const lower = rest.toLowerCase();

    const isInterest = lower.includes('interest') || lower.includes('return') || lower.includes('payout');
    const isPrincipal = lower.includes('principal') || lower.includes('repayment') || lower.includes('recovery');
    const isInvest = lower.includes('invest') || lower.includes('deposit') || lower.includes('add money');

    if (!isInterest && !isPrincipal && !isInvest) continue;

    const amounts = [...rest.matchAll(/(?:₹|inr|rs\.?)?\s*(\d{1,3}(?:,\d{2,3})*(?:\.\d{2})|\d{1,3}(?:,\d{2,3})+)/gi)]
      .map((m) => (m[1] ? cleanAmount(m[1]) : 0))
      .filter((a) => a > 0);

    if (amounts.length === 0) continue;
    const amount = amounts[0];
    if (amount === undefined) continue;
    const balance = amounts.length > 1 ? amounts[amounts.length - 1] : undefined;

    let desc = 'P2P Lending Transaction';
    let debitMinor = 0;
    let creditMinor = 0;
    let type = 'general';

    if (isInterest) {
      desc = 'P2P Interest Income Payout';
      creditMinor = amount; // Income
      type = 'p2p_interest';
    } else if (isPrincipal) {
      desc = 'P2P Principal Repayment from Borrower';
      creditMinor = amount; // Principal cash inflow / reduction in P2P asset
      type = 'p2p_principal';
    } else if (isInvest) {
      desc = 'P2P Lending Fresh Investment';
      debitMinor = amount; // Investment asset increase
      type = 'p2p_investment';
    }

    rows.push({
      date,
      description: desc,
      debitMinor,
      creditMinor,
      ...(balance !== undefined ? { balanceMinor: balance } : {}),
      currency: 'INR',
      raw: {
        type,
        statementKind: 'p2p',
        sourceLine: line,
      },
    });
  }

  const adapter = detectStatementAdapter(text, options.fileName, 'p2p');

  return {
    adapterId: adapter.id,
    adapterName: adapter.name,
    kind: 'p2p',
    currency: 'INR',
    rows,
    sourceText: text,
  };
}

/**
 * Dispatches to specialized parsers if text or fileName matches NPS, PPF, Interest, or P2P.
 */
export function parseSpecializedStatement(
  text: string,
  options: { fileName?: string | undefined; kind?: StatementKind | undefined } = {},
): ParsedStatement | undefined {
  const kind = options.kind ?? detectStatementAdapter(text, options.fileName).kind;

  if (kind === 'nps') {
    return parseNpsStatement(text, options);
  }
  if (kind === 'ppf') {
    return parsePpfStatement(text, options);
  }
  if (kind === 'interest') {
    return parseInterestCertificate(text, options);
  }
  if (kind === 'p2p') {
    return parseP2pStatement(text, options);
  }

  return undefined;
}
