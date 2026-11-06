import type { StatementLine } from '@/core/model';

export interface FastagGroup {
  vehicle: string;
  plaza: string;
  count: number;
  debitMinor: number;
  creditMinor: number;
}

const VEHICLE_PATTERN = /\b([A-Z]{2}\s?\d{1,2}\s?[A-Z]{1,2}\s?\d{4})\b/i;

function field(line: StatementLine, names: string[]): string | undefined {
  if (!line.raw) return undefined;
  const entries = Object.entries(line.raw);
  for (const name of names) {
    const match = entries.find(([key]) => key.toLowerCase().replace(/[^a-z]/g, '') === name);
    if (match && match[1] !== null && match[1] !== undefined && String(match[1]).trim()) {
      return String(match[1]).trim();
    }
  }
  return undefined;
}

export function groupFastagLines(lines: StatementLine[]): FastagGroup[] {
  const groups = new Map<string, FastagGroup>();
  for (const line of lines) {
    const vehicle =
      field(line, ['vehicle', 'vehiclenumber', 'vehicleno', 'registrationnumber', 'tagid']) ??
      line.description.match(VEHICLE_PATTERN)?.[1]?.toUpperCase() ??
      'Unassigned';
    const plaza =
      field(line, ['plaza', 'tollplaza', 'tollplazaname', 'location', 'tollgate']) ??
      /(?:plaza|toll)\s*[:\-]?\s*([A-Za-z0-9 .&]+)/i.exec(line.description)?.[1]?.trim() ??
      'Unassigned';
    const key = `${vehicle}|${plaza}`;
    const group = groups.get(key) ?? { vehicle, plaza, count: 0, debitMinor: 0, creditMinor: 0 };
    group.count += 1;
    group.debitMinor += line.debitMinor;
    group.creditMinor += line.creditMinor;
    groups.set(key, group);
  }
  return [...groups.values()].sort(
    (a, b) => b.debitMinor - a.debitMinor || a.vehicle.localeCompare(b.vehicle),
  );
}
