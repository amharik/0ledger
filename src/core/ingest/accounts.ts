import type { LedgerDatabase } from '@/core/db/db';

export type AccountCategory =
  | 'bank_account'
  | 'credit_card'
  | 'wallet'
  | 'loan'
  | 'investment'
  | 'shopping'
  | 'gift_card';

export interface ExtractedAccount {
  accountNumberMasked: string; // e.g. "XX7317" or "••••4472" or "user@okhdfcbank"
  accountTail: string; // trailing digits e.g. "7317" or handle
  category: AccountCategory;
  institution?: string | undefined; // e.g. "HDFC Bank", "Amazon", "State Bank of India"
  rawToken: string;
  vpa?: string | undefined; // if UPI
}

/**
 * Validates a potential card number using the Luhn (Mod-10) algorithm.
 * Used for PCI-DSS & DPDP compliance to identify and redact raw PANs.
 */
export function passesLuhnCheck(digits: string): boolean {
  const sanitized = digits.replace(/\D/g, '');
  if (sanitized.length < 10 || sanitized.length > 19) return false;

  let sum = 0;
  let shouldDouble = false;
  for (let i = sanitized.length - 1; i >= 0; i--) {
    let digit = parseInt(sanitized.charAt(i), 10);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

/**
 * Masks a primary account number or sensitive identifier,
 * retaining only the last 4 digits (e.g. ••••1234).
 */
export function maskPan(rawNumber: string): string {
  const digits = rawNumber.replace(/\D/g, '');
  if (digits.length <= 4) return rawNumber;
  const tail = digits.slice(-4);
  return `••••${tail}`;
}

/**
 * Normalize text using Unicode Normalization Form KC (NFKC)
 * and strip non-breaking spaces (\u00A0), zero-width joiners (\u200D), and artifacts.
 */
export function normalizeText(text: string): string {
  if (!text) return '';
  return text
    .normalize('NFKC')
    .replace(/\u00A0/g, ' ')
    .replace(/\u200D/g, '')
    .replace(/\u200B/g, '')
    .replace(/[\r\t]+/g, ' ');
}

export function detectInstitution(text: string, from?: string): string | undefined {
  const combined = `${from ?? ''}\n${text}`.toLowerCase();

  if (/(?:hdfcbank|alerts@hdfcbank\.net|hdfc)/i.test(combined)) return 'HDFC Bank';
  if (/(?:icicibank|alerts@icicibank\.com|icici)/i.test(combined)) return 'ICICI Bank';
  if (/(?:sbi\.co\.in|state bank of india|sbin)/i.test(combined)) return 'State Bank of India';
  if (/(?:axisbank|axis)/i.test(combined)) return 'Axis Bank';
  if (/(?:kotak|kkbk)/i.test(combined)) return 'Kotak Mahindra Bank';
  if (/(?:idfcfirst|idfc)/i.test(combined)) return 'IDFC FIRST Bank';
  if (/(?:yesbank|yes bank)/i.test(combined)) return 'YES Bank';
  if (/(?:pnb|punjab national bank)/i.test(combined)) return 'Punjab National Bank';
  if (/(?:bank of baroda|bob|baroda)/i.test(combined)) return 'Bank of Baroda';
  if (/(?:canara bank|canara)/i.test(combined)) return 'Canara Bank';
  if (/(?:indusind)/i.test(combined)) return 'IndusInd Bank';
  if (/(?:rbl bank|rbl)/i.test(combined)) return 'RBL Bank';
  if (/(?:amazon\.in|auto-confirm@amazon|amazon)/i.test(combined)) return 'Amazon';
  if (/(?:flipkart\.com|flipkart)/i.test(combined)) return 'Flipkart';
  if (/(?:swiggy)/i.test(combined)) return 'Swiggy';
  if (/(?:zomato)/i.test(combined)) return 'Zomato';
  if (/(?:paytm|one97)/i.test(combined)) return 'Paytm';
  if (/(?:phonepe)/i.test(combined)) return 'PhonePe';
  if (/(?:cra-nsdl|protean|kfintech|nps)/i.test(combined)) return 'National Pension System';
  if (/(?:12% club|12percentclub|bharatpe)/i.test(combined)) return '12% Club';
  if (/(?:faircent)/i.test(combined)) return 'Faircent';
  if (/(?:lendenclub)/i.test(combined)) return 'LenDenClub';
  if (/(?:cred mint|cred)/i.test(combined)) return 'CRED Mint';

  return undefined;
}

export interface IdentifyAccountInput {
  text: string;
  subject?: string | undefined;
  from?: string | undefined;
  html?: string | undefined;
}

/**
 * Extracts unique accounts (bank, card, wallet, loan, investment, shopping) from text.
 * Strictly adheres to PCI-DSS / DPDP by masking full PANs.
 */
export function identifyAllAccounts(input: IdentifyAccountInput): ExtractedAccount[] {
  const rawText = `${input.subject ?? ''}\n${input.from ?? ''}\n${input.text}\n${input.html ?? ''}`;
  const normalized = normalizeText(rawText);
  const institution = detectInstitution(normalized, input.from);
  const results: ExtractedAccount[] = [];
  const seenMasks = new Set<string>();

  function addAccount(acc: ExtractedAccount) {
    const key = `${acc.category}:${acc.accountNumberMasked}`;
    if (!seenMasks.has(key)) {
      seenMasks.add(key);
      results.push(acc);
    }
  }

  // Check for raw 10-19 digit card PANs first (and immediately redact/mask per PCI-DSS)
  const panMatches = normalized.matchAll(/\b(?:\d[\s-]?){10,19}\b/g);
  for (const match of panMatches) {
    const candidate = match[0].replace(/[\s-]/g, '');
    if (candidate.length >= 10 && candidate.length <= 19 && passesLuhnCheck(candidate)) {
      const masked = maskPan(candidate);
      addAccount({
        accountNumberMasked: masked,
        accountTail: candidate.slice(-4),
        category: 'credit_card',
        ...(institution ? { institution } : {}),
        rawToken: masked,
      });
    }
  }

  // 1. Dedicated Credit/Debit Card Alert Pattern
  // Matches: "Card ending in 4472", "credit card ending with 1234", "Card No. XXXX2123", "Card ending 4472"
  const cardPatterns = [
    /(?:credit\s*card|debit\s*card|card)\s*(?:no\.?|num|number|ending(?:\s*(?:in|with))?)[:\s]*[\w\*]*([Xx\*]{2,}\d{3,4}|\b\d{4}\b)/gi,
    /(?:card)[\s\w\*]*([Xx\*]{2,}\d{4})\b/gi,
  ];
  for (const pattern of cardPatterns) {
    const matches = normalized.matchAll(pattern);
    for (const match of matches) {
      const token = match[1];
      if (!token) continue;
      const tail = token.replace(/\D/g, '').slice(-4);
      if (tail.length >= 3) {
        addAccount({
          accountNumberMasked: token.startsWith('X') || token.startsWith('*') ? token : `••••${tail}`,
          accountTail: tail,
          category: 'credit_card',
          ...(institution ? { institution } : {}),
          rawToken: match[0].trim(),
        });
      }
    }
  }

  // 2. Bank Account Pattern
  // Matches: "A/c XX7317", "Account No. *******5666", "A/c No: 1234", "Account Number: XX7317"
  const bankPatterns = [
    /(?:a\/c|acct|account)\s*(?:no\.?|number|num)?[:\s]*[\w\*]*([Xx\*]{2,}\d{3,6}|\b\d{4}\b)/gi,
    /(?:account|a\/c)\s*(?:number|no\.?)[:\s]+(xx\w+|\b\d{4}\b)/gi,
  ];
  for (const pattern of bankPatterns) {
    const matches = normalized.matchAll(pattern);
    for (const match of matches) {
      const token = match[1];
      if (!token) continue;
      const tail = token.replace(/\D/g, '').slice(-4);
      if (tail.length >= 3) {
        addAccount({
          accountNumberMasked: token.startsWith('X') || token.startsWith('*') ? token : `XX${tail}`,
          accountTail: tail,
          category: 'bank_account',
          ...(institution ? { institution } : {}),
          rawToken: match[0].trim(),
        });
      }
    }
  }

  // 3. Investment: NPS (PRAN) or PPF Accounts
  // NPS PRAN: 12 digits
  const pranMatch = normalized.match(/\b(?:pran)(?:\s*(?:no|number|a\/c))?[:\s]*([0-9]{12})\b/i);
  if (pranMatch?.[1]) {
    const pran = pranMatch[1];
    addAccount({
      accountNumberMasked: `PRAN-••••${pran.slice(-4)}`,
      accountTail: pran.slice(-4),
      category: 'investment',
      institution: 'National Pension System',
      rawToken: pranMatch[0].trim(),
    });
  }

  // PPF Account: 9 to 18 digits or masked
  const ppfMatch = normalized.match(/\b(?:ppf)(?:\s*(?:a\/c|account|no\.?))?[:\s]*([Xx\*0-9]{8,18})\b/i);
  if (ppfMatch?.[1]) {
    const ppfToken = ppfMatch[1];
    const tail = ppfToken.replace(/\D/g, '').slice(-4);
    addAccount({
      accountNumberMasked: `PPF-${tail ? 'XX' + tail : ppfToken}`,
      accountTail: tail || ppfToken.slice(-4),
      category: 'investment',
      institution: institution || 'Public Provident Fund',
      rawToken: ppfMatch[0].trim(),
    });
  }

  // 4. Loan / EMI Account
  const loanMatch = normalized.match(/\b(?:loan|emi|mortgage)\s*(?:a\/c|acct|account|no\.?)?[:\s]*([A-Za-z0-9\*-]{4,20})\b/i);
  if (loanMatch?.[1]) {
    const loanToken = loanMatch[1];
    const tail = loanToken.replace(/[^A-Za-z0-9]/g, '').slice(-4);
    addAccount({
      accountNumberMasked: `LOAN-XX${tail}`,
      accountTail: tail,
      category: 'loan',
      ...(institution ? { institution } : {}),
      rawToken: loanMatch[0].trim(),
    });
  }

  // 5. UPI VPA (Contextual or known PSP handles)
  const upiMatch =
    normalized.match(/(?:upi(?:\s*id)?|vpa|paid\s*to|to)\s*[:\s]*([a-zA-Z0-9.\-_]{2,64}@[a-zA-Z]{2,32})\b/i) ??
    normalized.match(/\b([a-zA-Z0-9.\-_]{2,64}@(?:okhdfcbank|okicici|okaxis|oksbi|paytm|ybl|axl|ibl|apl|upi|sbi|icici|hdfcbank|axisbank|kotak|postbank))\b/i);
  if (upiMatch?.[1]) {
    const vpa = upiMatch[1].toLowerCase();
    // Exclude standard email and commercial domains
    if (!/(?:amazon|flipkart|google|swiggy|zomato|gmail|yahoo|outlook|hotmail|icloud|\.gov|\.edu)/i.test(vpa)) {
      addAccount({
        accountNumberMasked: vpa,
        accountTail: vpa.split('@')[0]?.slice(-4) ?? '',
        category: 'wallet',
        vpa,
        institution: institution || 'UPI Rail',
        rawToken: vpa,
      });
    }
  }

  // 6. E-Commerce / Shopping Accounts
  if (/(?:amazon\.in|amazon pay|amazon\.com|auto-confirm@amazon)/i.test(normalized)) {
    addAccount({
      accountNumberMasked: 'Amazon Account',
      accountTail: 'AMZN',
      category: 'shopping',
      institution: 'Amazon',
      rawToken: 'Amazon',
    });
  } else if (/(?:flipkart\.com|flipkart)/i.test(normalized)) {
    addAccount({
      accountNumberMasked: 'Flipkart Account',
      accountTail: 'FLPK',
      category: 'shopping',
      institution: 'Flipkart',
      rawToken: 'Flipkart',
    });
  }

  // 7. Gift Card / Shopping Voucher Accounts
  if (
    /(?:shopping\s*voucher|gift\s*(?:card|voucher)|e-gift|brand\s*voucher|voucher\s*booking|voucher\s*code|ishop|gyftr|woohoo|qwikcilver|hubble)/i.test(
      normalized,
    )
  ) {
    let platform = 'Gift Card';
    if (/ishop/i.test(normalized)) platform = 'iShop';
    else if (/gyftr|vouchagram/i.test(normalized)) platform = 'Gyftr';
    else if (/woohoo/i.test(normalized)) platform = 'Woohoo';
    else if (/qwikcilver|pine\s*labs/i.test(normalized)) platform = 'Qwikcilver';
    else if (/amazon/i.test(normalized)) platform = 'Amazon';
    else if (/flipkart/i.test(normalized)) platform = 'Flipkart';
    else if (/hubble/i.test(normalized)) platform = 'Hubble';

    const codeMatch = normalized.match(
      /\b(?:voucher\s*(?:code|no|number|id)|card\s*(?:no|number|id)|gift\s*card\s*(?:code|no|number)|claim\s*code)[:\s#-]*([A-Za-z0-9\t -]{4,32})/i,
    );
    const rawCode = codeMatch?.[1]?.replace(/[\s-]/g, '').trim();
    const tail = rawCode && rawCode.length >= 4 ? rawCode.slice(-4) : platform.slice(0, 4).toUpperCase();
    const masked = `••••${tail}`;

    addAccount({
      accountNumberMasked: masked,
      accountTail: tail,
      category: 'gift_card',
      institution: platform,
      rawToken: platform,
    });
  }

  // 7. Gift Card / Shopping Voucher Accounts
  if (
    /(?:shopping\s*voucher|gift\s*(?:card|voucher)|e-gift|brand\s*voucher|voucher\s*booking|voucher\s*code|ishop|gyftr|woohoo|qwikcilver|hubble)/i.test(
      normalized,
    )
  ) {
    let platform = 'Gift Card';
    if (/ishop/i.test(normalized)) platform = 'iShop';
    else if (/gyftr|vouchagram/i.test(normalized)) platform = 'Gyftr';
    else if (/woohoo/i.test(normalized)) platform = 'Woohoo';
    else if (/qwikcilver|pine\s*labs/i.test(normalized)) platform = 'Qwikcilver';
    else if (/amazon/i.test(normalized)) platform = 'Amazon';
    else if (/flipkart/i.test(normalized)) platform = 'Flipkart';
    else if (/hubble/i.test(normalized)) platform = 'Hubble';

    const codeMatch = normalized.match(
      /\b(?:voucher\s*(?:code|no|number|id)|card\s*(?:no|number|id)|gift\s*card\s*(?:code|no|number)|claim\s*code)[:\s#-]*([A-Za-z0-9\-]{4,32})/i,
    );
    const rawCode = codeMatch?.[1]?.replace(/[\s-]/g, '').trim();
    const tail = rawCode && rawCode.length >= 4 ? rawCode.slice(-4) : platform.slice(0, 4).toUpperCase();
    const masked = `••••${tail}`;

    addAccount({
      accountNumberMasked: masked,
      accountTail: tail,
      category: 'gift_card',
      institution: platform,
      rawToken: platform,
    });
  }

  // 7. Gift Card / Shopping Voucher Accounts
  if (
    /(?:shopping\s*voucher|gift\s*(?:card|voucher)|e-gift|brand\s*voucher|voucher\s*booking|voucher\s*code|ishop|gyftr|woohoo|qwikcilver|hubble)/i.test(
      normalized,
    )
  ) {
    let platform = 'Gift Card';
    if (/ishop/i.test(normalized)) platform = 'iShop';
    else if (/gyftr|vouchagram/i.test(normalized)) platform = 'Gyftr';
    else if (/woohoo/i.test(normalized)) platform = 'Woohoo';
    else if (/qwikcilver|pine\s*labs/i.test(normalized)) platform = 'Qwikcilver';
    else if (/amazon/i.test(normalized)) platform = 'Amazon';
    else if (/flipkart/i.test(normalized)) platform = 'Flipkart';
    else if (/hubble/i.test(normalized)) platform = 'Hubble';

    const codeMatch = normalized.match(
      /\b(?:voucher\s*(?:code|no|number|id)|card\s*(?:no|number|id)|gift\s*card\s*(?:code|no|number)|claim\s*code)[:\s#-]*([A-Za-z0-9\t -]{4,32})/i,
    );
    const rawCode = codeMatch?.[1]?.replace(/[\s-]/g, '').trim();
    const tail = rawCode && rawCode.length >= 4 ? rawCode.slice(-4) : platform.slice(0, 4).toUpperCase();
    const masked = `••••${tail}`;

    addAccount({
      accountNumberMasked: masked,
      accountTail: tail,
      category: 'gift_card',
      institution: platform,
      rawToken: platform,
    });
  }

  return results;
}

/**
 * Identify the primary unique account for an email or alert snippet.
 */
export function identifyUniqueAccount(input: IdentifyAccountInput): ExtractedAccount | undefined {
  const accounts = identifyAllAccounts(input);
  if (accounts.length === 0) return undefined;

  // Prioritize bank accounts and credit cards over generic shopping tags
  const priorityOrder: Record<AccountCategory, number> = {
    bank_account: 1,
    credit_card: 2,
    investment: 3,
    loan: 4,
    wallet: 5,
    shopping: 6,
    gift_card: 7,
  };

  return accounts.sort((a, b) => priorityOrder[a.category] - priorityOrder[b.category])[0];
}

/**
 * Matches an extracted account mask to an existing double-entry Ledger account in Dexie.
 * Auto-links incoming alerts and statements to the user's chart of accounts.
 */
export async function resolveLedgerForAccount(
  db: LedgerDatabase,
  workspaceId: string,
  account: ExtractedAccount,
): Promise<string | undefined> {
  const ledgers = await db.ledgers.where('workspaceId').equals(workspaceId).toArray();
  const activeLedgers = ledgers.filter((ledger) => !ledger.archived);

  // 1. Direct match on bankAccountNo tail
  if (account.accountTail) {
    const matchingAccountNo = activeLedgers.find((l) => {
      if (!l.bankAccountNo) return false;
      const cleanNo = l.bankAccountNo.replace(/\D/g, '');
      return cleanNo.endsWith(account.accountTail);
    });
    if (matchingAccountNo) return matchingAccountNo.id;
  }

  // 2. Match by ledger name and institution
  if (account.institution) {
    const instLower = account.institution.toLowerCase();
    const matchingName = activeLedgers.find((l) => {
      const nameLower = l.name.toLowerCase();
      if (account.category === 'credit_card') {
        const isCard = nameLower.includes('card') || nameLower.includes('credit');
        return isCard && (nameLower.includes(instLower) || (account.accountTail && nameLower.includes(account.accountTail)));
      }
      if (account.category === 'bank_account') {
        const isBank = l.isBank || nameLower.includes('bank') || nameLower.includes('savings') || nameLower.includes('current');
        return isBank && (nameLower.includes(instLower) || (account.accountTail && nameLower.includes(account.accountTail)));
      }
      if (account.category === 'investment') {
        if (account.institution === 'National Pension System') {
          return nameLower.includes('nps') || nameLower.includes('pension');
        }
        if (account.institution === 'Public Provident Fund') {
          return nameLower.includes('ppf') || nameLower.includes('provident');
        }
      }
      if (account.category === 'gift_card') {
        return nameLower.includes('gift') || nameLower.includes('voucher');
      }
      return false;
    });
    if (matchingName) return matchingName.id;
  }

  // 3. Fallback to generic Bank Account if category is bank_account
  if (account.category === 'bank_account') {
    const genericBank = activeLedgers.find((l) => l.isBank && !l.name.toLowerCase().includes('cash'));
    if (genericBank) return genericBank.id;
  }

  // 4. Fallback for Gift Cards & Vouchers
  if (account.category === 'gift_card') {
    const giftCardLedger = activeLedgers.find(
      (l) => l.name.toLowerCase().includes('gift') || l.name.toLowerCase().includes('voucher'),
    );
    if (giftCardLedger) return giftCardLedger.id;
  }

  return undefined;
}
