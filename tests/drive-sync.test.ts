import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, type LedgerDatabase } from '@/core/db/db';
import { createWorkspace } from '@/core/db/workspace-service';
import { isDriveDirty } from '@/core/db/sync-state';
import { postVoucher } from '@/core/ledger/post-voucher';
import {
  archiveMonthToDrive,
  diffDriveSnapshot,
  ensureDriveLocation,
  flushDirtyWorkspaces,
  readDriveSnapshot,
  restoreDriveSnapshot,
  syncWorkspaceToDrive,
} from '@/core/drive/sync';
import { makeLineInput, makeNewVoucher } from './fixtures';

const databases: LedgerDatabase[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) {
    await db.delete();
    db.close();
  }
});

interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  appProperties?: Record<string, string>;
  modifiedTime: string;
  webViewLink: string;
}

function fakeDrive() {
  const files = new Map<string, FakeFile>();
  const sheets = new Map<string, Map<string, unknown[][]>>();
  let counter = 0;
  const now = () => new Date(Date.UTC(2026, 10, 7, 10, 0, counter++)).toISOString();

  function create(body: Record<string, unknown>): FakeFile {
    const file: FakeFile = {
      id: `file-${++counter}`,
      name: String(body.name),
      mimeType: String(body.mimeType),
      parents: (body.parents as string[] | undefined) ?? [],
      ...(body.appProperties
        ? { appProperties: body.appProperties as Record<string, string> }
        : {}),
      modifiedTime: now(),
      webViewLink: `https://drive.example/file-${counter}`,
    };
    files.set(file.id, file);
    if (file.mimeType === 'application/vnd.google-apps.spreadsheet') {
      sheets.set(file.id, new Map());
    }
    return file;
  }

  function queryFiles(query: string): FakeFile[] {
    const mime = /mimeType='([^']+)'/.exec(query)?.[1];
    const parent = /'([^']+)' in parents/.exec(query)?.[1];
    const props: Record<string, string> = {};
    for (const match of query.matchAll(
      /appProperties has \{ key='([^']+)' and value='([^']+)' \}/g,
    )) {
      props[decodeQuery(match[1]!)] = decodeQuery(match[2]!);
    }
    return [...files.values()].filter((file) => {
      if (mime && file.mimeType !== mime) return false;
      if (parent && !(file.parents ?? []).includes(parent)) return false;
      return Object.entries(props).every(([key, value]) => file.appProperties?.[key] === value);
    });
  }

  function decodeQuery(value: string): string {
    return value.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  }

  function rangeTitle(path: string): string {
    const marker = '/values/';
    const index = path.indexOf(marker);
    const raw = decodeURIComponent(path.slice(index + marker.length));
    const withoutRange = raw.split('!')[0] ?? raw;
    if (withoutRange.startsWith("'") && withoutRange.endsWith("'")) {
      return withoutRange.slice(1, -1).replace(/''/g, "'");
    }
    return withoutRange;
  }

  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';
    const path = url.pathname;
    const json = (data: unknown) =>
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    if (path === '/drive/v3/files' && method === 'GET') {
      return json({ files: queryFiles(url.searchParams.get('q') ?? '') });
    }
    if (path === '/drive/v3/files' && method === 'POST') {
      return json(create(JSON.parse(String(init?.body)) as Record<string, unknown>));
    }
    if (path === '/upload/drive/v3/files' && method === 'POST') {
      const text = await (init?.body as Blob).text();
      const metadataText = /\r\n\r\n(\{.*?\})\r\n--/s.exec(text)?.[1];
      const metadata = JSON.parse(metadataText ?? '{}') as Record<string, unknown>;
      return json(create(metadata));
    }

    const uploadMatch = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(path);
    if (uploadMatch && method === 'PATCH') {
      const file = files.get(uploadMatch[1]!)!;
      file.modifiedTime = now();
      return json(file);
    }

    const fileMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
    if (fileMatch && method === 'GET') {
      const file = files.get(fileMatch[1]!);
      return file ? json(file) : new Response('not found', { status: 404 });
    }
    if (fileMatch && method === 'DELETE') {
      files.delete(fileMatch[1]!);
      return new Response('', { status: 204 });
    }
    if (fileMatch && method === 'PATCH') {
      const file = files.get(fileMatch[1]!)!;
      Object.assign(file, JSON.parse(String(init?.body)));
      return json(file);
    }

    const sheetMatch = /^\/v4\/spreadsheets\/([^/]+)$/.exec(path);
    if (sheetMatch && method === 'GET') {
      const titles = [...(sheets.get(sheetMatch[1]!)?.keys() ?? [])];
      return json({
        sheets: titles.map((title, index) => ({ properties: { sheetId: index + 1, title } })),
      });
    }

    const batchMatch = /^\/v4\/spreadsheets\/([^/]+):batchUpdate$/.exec(path);
    if (batchMatch && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as {
        requests?: { addSheet?: { properties?: { title?: string } } }[];
      };
      const store = sheets.get(batchMatch[1]!)!;
      for (const request of body.requests ?? []) {
        const title = request.addSheet?.properties?.title;
        if (title) store.set(title, []);
      }
      return json({});
    }

    const clearMatch = /^\/v4\/spreadsheets\/([^/]+)\/values\/.+:clear$/.exec(path);
    if (clearMatch && method === 'POST') {
      sheets.get(clearMatch[1]!)!.set(rangeTitle(path), []);
      return json({});
    }

    const batchValuesMatch = /^\/v4\/spreadsheets\/([^/]+)\/values:batchUpdate$/.exec(path);
    if (batchValuesMatch && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as {
        data?: { range?: string; values?: unknown[][] }[];
      };
      const store = sheets.get(batchValuesMatch[1]!)!;
      for (const update of body.data ?? []) {
        const title = String(update.range ?? '').split('!')[0]?.replace(/^'|'$/g, '');
        if (title) store.set(title, update.values ?? []);
      }
      return json({});
    }

    const valuesMatch = /^\/v4\/spreadsheets\/([^/]+)\/values\/.+$/.exec(path);
    if (valuesMatch) {
      const store = sheets.get(valuesMatch[1]!)!;
      const title = rangeTitle(path);
      if (method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as { values?: unknown[][] };
        store.set(title, body.values ?? []);
        return json({});
      }
      return json({ values: store.get(title) ?? [] });
    }

    throw new Error(`unexpected fake Drive request: ${method} ${url}`);
  };

  return { fetchMock: fetchMock as typeof fetch, files, sheets };
}

async function setup() {
  const db = createTestDb();
  databases.push(db);
  const bundle = await createWorkspace(db, { name: 'Drive Co', state: 'Karnataka' });
  return { db, bundle };
}

describe('Drive workbook sync', () => {
  it('creates folders and workbook, writes sheets once, then skips unchanged content', async () => {
    const { db, bundle } = await setup();
    const fake = fakeDrive();
    const first = await syncWorkspaceToDrive(db, bundle.workspace.id, {
      token: 'token',
      fetchImpl: fake.fetchMock,
      generatedAt: '2026-11-07T00:00:00.000Z',
    });
    expect(first.skipped).toBe(false);
    expect(first.sheets).toBeGreaterThan(20);

    const root = [...fake.files.values()].find(
      (file) => file.appProperties?.kind === 'root' && file.name === '0ledger',
    );
    const folder = [...fake.files.values()].find(
      (file) => file.appProperties?.kind === 'workspace',
    );
    expect(root).toBeDefined();
    expect(folder?.name).toBe('drive-co');
    expect(folder?.parents).toEqual([root!.id]);
    expect([...fake.files.values()].some((file) => file.name.includes('— Ledger'))).toBe(true);
    expect(fake.sheets.get(first.fileId)?.get('Vouchers')?.length).toBeGreaterThan(0);

    const second = await syncWorkspaceToDrive(db, bundle.workspace.id, {
      token: 'token',
      fetchImpl: fake.fetchMock,
      generatedAt: '2026-11-08T00:00:00.000Z',
    });
    expect(second.skipped).toBe(true);

    const snapshot = await readDriveSnapshot('token', first.fileId, fake.fetchMock);
    expect(snapshot.tables.ledgers?.length).toBeGreaterThan(0);
    expect(snapshot.tables.workspaces?.[0]).toMatchObject({ id: bundle.workspace.id });
  });

  it('rewrites a workbook that was deleted in Drive', async () => {
    const { db, bundle } = await setup();
    const fake = fakeDrive();
    const first = await syncWorkspaceToDrive(db, bundle.workspace.id, {
      token: 'token',
      fetchImpl: fake.fetchMock,
    });
    fake.files.delete(first.fileId);

    const recreated = await syncWorkspaceToDrive(db, bundle.workspace.id, {
      token: 'token',
      fetchImpl: fake.fetchMock,
    });
    expect(recreated.fileId).not.toBe(first.fileId);
    expect(recreated.skipped).toBe(false);
    expect(fake.sheets.get(recreated.fileId)?.get('CoA')?.length).toBeGreaterThan(1);
  });

  it('queues dirty workspaces and flushes a changed voucher', async () => {
    const { db, bundle } = await setup();
    const fake = fakeDrive();
    const bank = bundle.ledgers.find((ledger) => ledger.name === 'Bank Account')!;
    const purchases = bundle.ledgers.find((ledger) => ledger.name === 'Purchases')!;

    const first = await syncWorkspaceToDrive(db, bundle.workspace.id, {
      token: 'token',
      fetchImpl: fake.fetchMock,
    });
    expect(await isDriveDirty(db, bundle.workspace.id)).toBe(false);

    await postVoucher(
      db,
      makeNewVoucher({
        workspaceId: bundle.workspace.id,
        voucherType: 'Payment',
        date: '2026-11-07',
        lines: [makeLineInput(purchases.id, 125000), makeLineInput(bank.id, -125000)],
      }),
    );
    expect(await isDriveDirty(db, bundle.workspace.id)).toBe(true);

    const flush = await flushDirtyWorkspaces(db, 'token', fake.fetchMock);
    expect(flush.failed).toEqual([]);
    expect(flush.synced).toHaveLength(1);
    expect(flush.synced[0]!.skipped).toBe(false);
    expect(flush.synced[0]!.fileId).toBe(first.fileId);
    expect(await isDriveDirty(db, bundle.workspace.id)).toBe(false);
  });

  it('diffs and restores a snapshot from Sheets', async () => {
    const { db, bundle } = await setup();
    const fake = fakeDrive();
    const synced = await syncWorkspaceToDrive(db, bundle.workspace.id, {
      token: 'token',
      fetchImpl: fake.fetchMock,
    });
    const baseline = await readDriveSnapshot('token', synced.fileId, fake.fetchMock);

    const bank = bundle.ledgers.find((ledger) => ledger.name === 'Bank Account')!;
    const purchases = bundle.ledgers.find((ledger) => ledger.name === 'Purchases')!;
    await postVoucher(
      db,
      makeNewVoucher({
        workspaceId: bundle.workspace.id,
        voucherType: 'Payment',
        date: '2026-11-07',
        lines: [makeLineInput(purchases.id, 50000), makeLineInput(bank.id, -50000)],
      }),
    );

    const diff = await diffDriveSnapshot(db, bundle.workspace.id, baseline);
    expect(diff.localOnly).toBeGreaterThan(0);

    await restoreDriveSnapshot(db, bundle.workspace.id, baseline, 'replace');
    expect(await db.vouchers.where('workspaceId').equals(bundle.workspace.id).count()).toBe(0);
    expect(await db.ledgers.where('workspaceId').equals(bundle.workspace.id).count()).toBe(
      bundle.ledgers.length,
    );
  });

  it('creates and replaces the monthly xlsx archive', async () => {
    const { db, bundle } = await setup();
    const fake = fakeDrive();
    const first = await archiveMonthToDrive(db, bundle.workspace.id, '2026-11', {
      token: 'token',
      fetchImpl: fake.fetchMock,
    });
    expect(first.file.name).toBe('Drive Co — 2026-11.xlsx');
    expect(first.file.appProperties).toMatchObject({
      app: '0ledger',
      kind: 'archive',
      period: '2026-11',
    });

    const second = await archiveMonthToDrive(db, bundle.workspace.id, '2026-11', {
      token: 'token',
      fetchImpl: fake.fetchMock,
    });
    expect(second.file.id).toBe(first.file.id);
    const link = await db.driveLinks.where('workspaceId').equals(bundle.workspace.id).toArray();
    expect(link.find((item) => item.kind === 'xlsx')?.fileId).toBe(first.file.id);
  });

  it('refuses to reuse a workbook link that was not created by 0ledger', async () => {
    const { db, bundle } = await setup();
    const fake = fakeDrive();
    const location = await ensureDriveLocation(db, bundle.workspace.id, 'token', fake.fetchMock);
    const external = fake.files.get(location.workbook.id)!;
    external.appProperties = { owner: 'someone-else' };
    const link = await db.driveLinks.where('workspaceId').equals(bundle.workspace.id).toArray();
    const sheetsLink = link.find((item) => item.kind === 'sheets')!;

    await expect(
      syncWorkspaceToDrive(db, bundle.workspace.id, {
        token: 'token',
        fetchImpl: fake.fetchMock,
        force: true,
      }),
    ).rejects.toThrow(/not created by 0ledger/);
    expect(sheetsLink.fileId).toBe(location.workbook.id);
  });
});
