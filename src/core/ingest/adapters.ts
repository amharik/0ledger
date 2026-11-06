import type { StatementAdapter } from './types';

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

export const STATEMENT_ADAPTERS: StatementAdapter[] = [...BANK_ADAPTERS, ...FASTAG_ADAPTERS];

const GENERIC_BANK: StatementAdapter = {
  id: 'generic-bank',
  name: 'Generic bank statement',
  kind: 'bank',
  markers: [],
};

const GENERIC_FASTAG: StatementAdapter = {
  id: 'generic-fastag',
  name: 'Generic FASTag statement',
  kind: 'fastag',
  markers: [],
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
  fallbackKind: 'bank' | 'fastag' = 'bank',
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
  return fallbackKind === 'fastag' ? GENERIC_FASTAG : GENERIC_BANK;
}

export function allAdapters(): StatementAdapter[] {
  return [...STATEMENT_ADAPTERS];
}
