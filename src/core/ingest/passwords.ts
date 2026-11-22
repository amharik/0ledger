export interface StatementUserProfile {
  fullName?: string;
  dob?: string; // YYYY-MM-DD
  pan?: string; // 10 chars e.g. ABCDE1234F
  cardLast4?: string;
  accountLast4?: string;
  mobileLast4?: string;
  customerId?: string;
}

export type PasswordPattern =
  | 'name4_upper_ddmm'
  | 'name4_lower_ddmm'
  | 'name4_upper_card4'
  | 'name4_lower_card4'
  | 'dob_ddmmyyyy'
  | 'dob_ddmm'
  | 'dob_ddmmyy'
  | 'pan_upper'
  | 'pan_lower'
  | 'card4_ddmmyyyy'
  | 'customer_id'
  | 'custom';

export interface GeneratedCandidate {
  password: string;
  pattern: PasswordPattern;
  priority: number;
}

/**
 * Extracts password hints embedded in email notifications.
 * Many Indian banks include instructions such as:
 * - "Password is 16-digit Card Number"
 * - "Password is first 4 letters of your name in CAPITALS followed by DDMM of DOB"
 */
export function extractPasswordHintFromText(text: string): {
  detectedPattern?: PasswordPattern;
  hintSnippet?: string;
} {
  const clean = text.replace(/\s+/g, ' ');

  if (/first\s*4\s*letters.*(?:capital|upper).*dob|first\s*4\s*char.*ddmm/i.test(clean)) {
    return { detectedPattern: 'name4_upper_ddmm', hintSnippet: 'Name (4 caps) + DDMM' };
  }
  if (/first\s*4\s*letters.*(?:lower|small).*dob/i.test(clean)) {
    return { detectedPattern: 'name4_lower_ddmm', hintSnippet: 'Name (4 lower) + DDMM' };
  }
  if (/first\s*4\s*letters.*card/i.test(clean)) {
    return { detectedPattern: 'name4_upper_card4', hintSnippet: 'Name (4 letters) + Card Last 4' };
  }
  if (/ddmmyyyy|date\s*of\s*birth\s*in\s*ddmmyyyy/i.test(clean)) {
    return { detectedPattern: 'dob_ddmmyyyy', hintSnippet: 'DOB in DDMMYYYY' };
  }
  if (/pan\b.*lowercase/i.test(clean)) {
    return { detectedPattern: 'pan_lower', hintSnippet: 'PAN in lowercase' };
  }
  if (/pan\b/i.test(clean)) {
    return { detectedPattern: 'pan_upper', hintSnippet: 'PAN in UPPERCASE' };
  }

  return {};
}

/**
 * Generates an ordered candidate list of passwords for a statement PDF.
 */
export function generatePasswordCandidates(
  profile: StatementUserProfile,
  options: {
    institution?: string;
    hintText?: string;
    rememberedPattern?: PasswordPattern;
  } = {},
): GeneratedCandidate[] {
  const candidates: GeneratedCandidate[] = [];
  const seen = new Set<string>();

  // 1. If we have a remembered pattern that worked previously for this institution, prioritize it!
  const remembered = options.rememberedPattern;
  const hintMatch = options.hintText ? extractPasswordHintFromText(options.hintText) : {};
  const topPriorityPattern = remembered ?? hintMatch.detectedPattern;

  const add = (pwd: string | undefined, pattern: PasswordPattern, priority: number) => {
    if (!pwd || pwd.length < 4) return;
    const trimmed = pwd.trim();
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    const effectivePriority = pattern === topPriorityPattern ? priority + 100 : priority;
    candidates.push({ password: trimmed, pattern, priority: effectivePriority });
  };

  // Parse Name Tokens
  const rawName = (profile.fullName ?? '').replace(/[^a-zA-Z]/g, '');
  const name4Upper = rawName.slice(0, 4).toUpperCase();
  const name4Lower = rawName.slice(0, 4).toLowerCase();

  // Parse DOB Tokens
  let dd = '';
  let mm = '';
  let yyyy = '';
  let yy = '';
  if (profile.dob && /^\d{4}-\d{2}-\d{2}$/.test(profile.dob)) {
    const parts = profile.dob.split('-');
    yyyy = parts[0]!;
    mm = parts[1]!;
    dd = parts[2]!;
    yy = yyyy.slice(-2);
  }

  const ddmm = dd && mm ? `${dd}${mm}` : '';
  const ddmmyyyy = dd && mm && yyyy ? `${dd}${mm}${yyyy}` : '';
  const ddmmyy = dd && mm && yy ? `${dd}${mm}${yy}` : '';

  const panUpper = (profile.pan ?? '').trim().toUpperCase();
  const panLower = (profile.pan ?? '').trim().toLowerCase();
  const card4 = (profile.cardLast4 ?? '').trim();

  // Institution-Specific Base Priority
  const inst = (options.institution ?? '').toLowerCase();

  if (inst.includes('hdfc')) {
    // HDFC: Name(4) + DDMM or Customer ID
    add(name4Upper + ddmm, 'name4_upper_ddmm', 90);
    add(name4Lower + ddmm, 'name4_lower_ddmm', 85);
    add(profile.customerId, 'customer_id', 80);
    add(name4Upper + card4, 'name4_upper_card4', 75);
  } else if (inst.includes('icici')) {
    // ICICI: Name(4 lower) + DDMM or Name(4 upper) + DDMM
    add(name4Lower + ddmm, 'name4_lower_ddmm', 90);
    add(name4Upper + ddmm, 'name4_upper_ddmm', 85);
    add(ddmmyyyy, 'dob_ddmmyyyy', 80);
  } else if (inst.includes('sbi')) {
    // SBI: DDMMYYYY + Card4 or DDMMYYYY
    if (ddmmyyyy && card4) add(ddmmyyyy + card4, 'card4_ddmmyyyy', 90);
    add(ddmmyyyy, 'dob_ddmmyyyy', 85);
    add(name4Lower + ddmm, 'name4_lower_ddmm', 80);
  } else if (inst.includes('axis')) {
    // Axis: Name(4 upper) + Card(4)
    add(name4Upper + card4, 'name4_upper_card4', 90);
    add(name4Lower + card4, 'name4_lower_card4', 85);
    add(name4Upper + ddmm, 'name4_upper_ddmm', 80);
  } else if (inst.includes('kotak')) {
    // Kotak: CRN or DDMMYYYY
    add(profile.customerId, 'customer_id', 90);
    add(ddmmyyyy, 'dob_ddmmyyyy', 85);
  }

  // Universal fallback candidates
  add(name4Upper + ddmm, 'name4_upper_ddmm', 70);
  add(name4Lower + ddmm, 'name4_lower_ddmm', 68);
  add(ddmmyyyy, 'dob_ddmmyyyy', 65);
  add(ddmm, 'dob_ddmm', 60);
  add(ddmmyy, 'dob_ddmmyy', 55);
  add(panUpper, 'pan_upper', 50);
  add(panLower, 'pan_lower', 48);
  if (name4Upper && card4) add(name4Upper + card4, 'name4_upper_card4', 45);
  if (name4Lower && card4) add(name4Lower + card4, 'name4_lower_card4', 42);
  add(profile.customerId, 'customer_id', 40);

  // Sort descending by priority
  candidates.sort((a, b) => b.priority - a.priority);
  return candidates;
}

const PATTERN_STORAGE_KEY = '0ledger.pwd_pattern';

export function getRememberedPasswordPattern(institution: string): PasswordPattern | undefined {
  if (typeof localStorage === 'undefined' || !institution) return undefined;
  try {
    const raw = localStorage.getItem(`${PATTERN_STORAGE_KEY}:${institution.toLowerCase().trim()}`);
    return (raw as PasswordPattern) ?? undefined;
  } catch {
    return undefined;
  }
}

export function saveRememberedPasswordPattern(
  institution: string,
  pattern: PasswordPattern,
): void {
  if (typeof localStorage === 'undefined' || !institution) return;
  try {
    localStorage.setItem(`${PATTERN_STORAGE_KEY}:${institution.toLowerCase().trim()}`, pattern);
  } catch {}
}
