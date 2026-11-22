import type { StatementAdapter, StatementKind } from './types';

export const BANK_ADAPTERS: StatementAdapter[] = [
  {
    id: 'hdfc',
    name: 'HDFC Bank',
    kind: 'bank',
    markers: ['hdfc bank', 'hdfc000', 'hdfcbank', 'hdfc bank limited'],
    filePatterns: ['hdfc'],
  },
  {
    id: 'icici',
    name: 'ICICI Bank',
    kind: 'bank',
    markers: ['icici bank', 'icic000', 'icicibank'],
    filePatterns: ['icici'],
  },
  {
    id: 'sbi',
    name: 'State Bank of India',
    kind: 'bank',
    markers: ['state bank of india', 'sbin000', 'sbi'],
    filePatterns: ['sbi'],
  },
  {
    id: 'axis',
    name: 'Axis Bank',
    kind: 'bank',
    markers: ['axis bank', 'utib000', 'axisbank'],
    filePatterns: ['axis'],
  },
  {
    id: 'kotak',
    name: 'Kotak Mahindra Bank',
    kind: 'bank',
    markers: ['kotak mahindra bank', 'kkbk000', 'kotak'],
    filePatterns: ['kotak'],
  },
  {
    id: 'idfc-first',
    name: 'IDFC FIRST Bank',
    kind: 'bank',
    markers: ['idfc first bank', 'idfcfirst', 'idfb000'],
    filePatterns: ['idfc'],
  },
  {
    id: 'yes',
    name: 'YES Bank',
    kind: 'bank',
    markers: ['yes bank', 'yesb000'],
    filePatterns: ['yes-bank', 'yesbank'],
  },
  {
    id: 'pnb',
    name: 'Punjab National Bank',
    kind: 'bank',
    markers: ['punjab national bank', 'punb0', 'pnb'],
    filePatterns: ['pnb'],
  },
  {
    id: 'bob',
    name: 'Bank of Baroda',
    kind: 'bank',
    markers: ['bank of baroda', 'barb0', 'bob'],
    filePatterns: ['baroda', 'bob'],
  },
  {
    id: 'canara',
    name: 'Canara Bank',
    kind: 'bank',
    markers: ['canara bank', 'cnrb0', 'canara'],
    filePatterns: ['canara'],
  },
];

export const FASTAG_ADAPTERS: StatementAdapter[] = [
  {
    id: 'fastag',
    name: 'FASTag / NETC',
    kind: 'fastag',
    markers: ['fastag', 'netc', 'plaza', 'toll', 'tag id', 'vehicle'],
    filePatterns: ['fastag', 'netc', 'toll'],
  },
];

export const NPS_ADAPTERS: StatementAdapter[] = [
  {
    id: 'nps-protean',
    name: 'NPS (Protean / CRA-NSDL)',
    kind: 'nps',
    markers: ['national pension system', 'cra-nsdl', 'protean', 'pran', 'pfrda', 'tier i', 'tier ii', 'nps statement'],
    filePatterns: ['nps', 'pran', 'cra', 'protean'],
  },
  {
    id: 'nps-kfintech',
    name: 'NPS (KFintech CRA)',
    kind: 'nps',
    markers: ['kfintech', 'nps', 'pran', 'pfrda', 'cra transaction statement'],
    filePatterns: ['kfintech-nps', 'kfintech'],
  },
];

export const PPF_ADAPTERS: StatementAdapter[] = [
  {
    id: 'ppf',
    name: 'Public Provident Fund (PPF)',
    kind: 'ppf',
    markers: ['public provident fund', 'ppf account', 'ppf a/c', 'section 10(11)', 'ppf subscription'],
    filePatterns: ['ppf'],
  },
];

export const INTEREST_ADAPTERS: StatementAdapter[] = [
  {
    id: 'bank-interest',
    name: 'Bank Interest & TDS Certificate',
    kind: 'interest',
    markers: [
      'interest certificate',
      'interest statement',
      'savings bank interest',
      'term deposit interest',
      'fixed deposit interest',
      'tds certificate',
      'section 194a',
      'form 16a',
      'interest payout',
    ],
    filePatterns: ['interest', 'tds-194a', 'form-16a'],
  },
];

export const P2P_ADAPTERS: StatementAdapter[] = [
  {
    id: 'p2p-12club',
    name: '12% Club (BharatPe / Resilient)',
    kind: 'p2p',
    markers: ['12% club', '12 percent club', 'lenndbox', 'liquiloans', 'bharatpe p2p'],
    filePatterns: ['12club', '12percent'],
  },
  {
    id: 'p2p-faircent',
    name: 'Faircent P2P Lending',
    kind: 'p2p',
    markers: ['faircent', 'fairassets', 'p2p lending statement', 'escrow payout'],
    filePatterns: ['faircent'],
  },
  {
    id: 'p2p-lendenclub',
    name: 'LenDenClub P2P',
    kind: 'p2p',
    markers: ['lendenclub', 'innofin', 'finstars', 'p2p loan repayments'],
    filePatterns: ['lendenclub'],
  },
  {
    id: 'p2p-cred-mint',
    name: 'CRED Mint P2P',
    kind: 'p2p',
    markers: ['cred mint', 'dreamplug', 'liquiloans nbfc-p2p'],
    filePatterns: ['cred-mint', 'mint'],
  },
];

export const GIFTCARD_ADAPTERS: StatementAdapter[] = [
  {
    id: 'giftcard-ishop',
    name: 'iShop Shopping Voucher',
    kind: 'giftcard',
    markers: ['ishop', 'shopping voucher booking with ishop', 'shopping voucher booking', 'ishop voucher'],
    filePatterns: ['ishop'],
  },
  {
    id: 'giftcard-gyftr',
    name: 'Gyftr Brand Voucher',
    kind: 'giftcard',
    markers: ['gyftr', 'vouchagram', 'smartbuy vouchers', 'gyftr.com'],
    filePatterns: ['gyftr'],
  },
  {
    id: 'giftcard-woohoo',
    name: 'Woohoo Gift Card',
    kind: 'giftcard',
    markers: ['woohoo', 'woohoo.in', 'qwikcilver solutions'],
    filePatterns: ['woohoo'],
  },
  {
    id: 'giftcard-amazon',
    name: 'Amazon Gift Card',
    kind: 'giftcard',
    markers: ['amazon pay egift card', 'amazon gift card', 'amazon shopping voucher'],
    filePatterns: ['amazon-gift-card', 'amazon-voucher'],
  },
  {
    id: 'giftcard-flipkart',
    name: 'Flipkart Gift Card',
    kind: 'giftcard',
    markers: ['flipkart gift card', 'flipkart voucher'],
    filePatterns: ['flipkart-gift-card'],
  },
  {
    id: 'giftcard-qwikcilver',
    name: 'Qwikcilver / Pine Labs Gift Card',
    kind: 'giftcard',
    markers: ['qwikcilver', 'pine labs gift', 'pinelabs'],
    filePatterns: ['qwikcilver'],
  },
];

export const STATEMENT_ADAPTERS: StatementAdapter[] = [
  ...BANK_ADAPTERS,
  ...FASTAG_ADAPTERS,
  ...NPS_ADAPTERS,
  ...PPF_ADAPTERS,
  ...INTEREST_ADAPTERS,
  ...P2P_ADAPTERS,
  ...GIFTCARD_ADAPTERS,
];

const GENERIC_ADAPTERS: Record<StatementKind, StatementAdapter> = {
  bank: { id: 'generic-bank', name: 'Generic bank statement', kind: 'bank', markers: [] },
  fastag: { id: 'generic-fastag', name: 'Generic FASTag statement', kind: 'fastag', markers: [] },
  nps: { id: 'generic-nps', name: 'Generic NPS Statement', kind: 'nps', markers: [] },
  ppf: { id: 'generic-ppf', name: 'Generic PPF Statement', kind: 'ppf', markers: [] },
  interest: { id: 'generic-interest', name: 'Generic Interest Certificate', kind: 'interest', markers: [] },
  p2p: { id: 'generic-p2p', name: 'Generic P2P Statement', kind: 'p2p', markers: [] },
  credit_card: { id: 'generic-credit-card', name: 'Generic Credit Card Statement', kind: 'credit_card', markers: [] },
  gift_card: { id: 'generic-giftcard', name: 'Generic Gift Card / Voucher', kind: 'gift_card', markers: [] },
  giftcard: { id: 'generic-giftcard', name: 'Generic Gift Card / Voucher', kind: 'giftcard', markers: [] },
};

function score(adapter: StatementAdapter, haystack: string): number {
  let value = 0;
  for (const marker of adapter.markers) {
    if (haystack.includes(marker.toLowerCase())) value += marker.length >= 6 ? 3 : 1;
  }
  return value;
}

export function getAdapter(adapterId: string): StatementAdapter | undefined {
  return STATEMENT_ADAPTERS.find((adapter) => adapter.id === adapterId);
}

export function detectStatementAdapter(
  text: string,
  fileName = '',
  fallbackKind: StatementKind = 'bank',
): StatementAdapter {
  const haystack = `${fileName}\n${text}`.toLowerCase();
  let best: StatementAdapter | undefined;
  let bestScore = 0;
  for (const adapter of STATEMENT_ADAPTERS) {
    const candidateScore = score(adapter, haystack);
    if (candidateScore > bestScore) {
      best = adapter;
      bestScore = candidateScore;
    }
  }
  if (best) return best;
  return GENERIC_ADAPTERS[fallbackKind] ?? GENERIC_ADAPTERS.bank;
}

export function allAdapters(): StatementAdapter[] {
  return [...STATEMENT_ADAPTERS];
}
