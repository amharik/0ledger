export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
export const SHEETS_MIME = 'application/vnd.google-apps.spreadsheet';
export const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
  parents?: string[];
  appProperties?: Record<string, string>;
}

export interface DriveAppProperties {
  app: '0ledger';
  workspaceId?: string;
  kind?: 'root' | 'workspace' | 'workbook' | 'archive';
  period?: string;
}

export type FetchLike = typeof fetch;

function escapeQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Drive request failed (${response.status}): ${text || response.statusText}`);
  }
  return (await response.json()) as T;
}

export function appPropertiesQuery(props: Record<string, string>): string {
  return Object.entries(props)
    .map(
      ([key, value]) =>
        `appProperties has { key='${escapeQuery(key)}' and value='${escapeQuery(value)}' }`,
    )
    .join(' and ');
}

export async function listFiles(
  token: string,
  query: string,
  fetchImpl: FetchLike = fetch,
): Promise<DriveFile[]> {
  const url = new URL(`${DRIVE_API}/files`);
  url.searchParams.set('q', query);
  url.searchParams.set('spaces', 'drive');
  url.searchParams.set('pageSize', '20');
  url.searchParams.set(
    'fields',
    'files(id,name,mimeType,modifiedTime,webViewLink,parents,appProperties)',
  );
  const data = await parseJson<{ files?: DriveFile[] }>(
    await fetchImpl(url.toString(), { headers: authHeaders(token) }),
  );
  return data.files ?? [];
}

export async function getFile(
  token: string,
  fileId: string,
  fetchImpl: FetchLike = fetch,
): Promise<DriveFile> {
  const url = new URL(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set(
    'fields',
    'id,name,mimeType,modifiedTime,webViewLink,parents,appProperties',
  );
  return parseJson<DriveFile>(await fetchImpl(url.toString(), { headers: authHeaders(token) }));
}

export interface CreateFileOptions {
  name: string;
  mimeType: string;
  parents?: string[];
  appProperties?: DriveAppProperties;
}

export async function createFile(
  token: string,
  options: CreateFileOptions,
  fetchImpl: FetchLike = fetch,
): Promise<DriveFile> {
  const url = new URL(`${DRIVE_API}/files`);
  url.searchParams.set(
    'fields',
    'id,name,mimeType,modifiedTime,webViewLink,parents,appProperties',
  );
  return parseJson<DriveFile>(
    await fetchImpl(url.toString(), {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: options.name,
        mimeType: options.mimeType,
        ...(options.parents && options.parents.length > 0 ? { parents: options.parents } : {}),
        ...(options.appProperties ? { appProperties: options.appProperties } : {}),
      }),
    }),
  );
}

export async function deleteFile(
  token: string,
  fileId: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const response = await fetchImpl(
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}`,
    { method: 'DELETE', headers: authHeaders(token) },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`Unable to delete Drive file ${fileId}: ${response.status}`);
  }
}

export async function updateFileMetadata(
  token: string,
  fileId: string,
  body: Record<string, unknown>,
  fetchImpl: FetchLike = fetch,
): Promise<DriveFile> {
  const url = new URL(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set(
    'fields',
    'id,name,mimeType,modifiedTime,webViewLink,parents,appProperties',
  );
  return parseJson<DriveFile>(
    await fetchImpl(url.toString(), {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export async function uploadFile(
  token: string,
  options: {
    name: string;
    mimeType: string;
    parents?: string[];
    appProperties?: DriveAppProperties;
    content: Blob;
  },
  fetchImpl: FetchLike = fetch,
): Promise<DriveFile> {
  const boundary = `0ledger-${crypto.randomUUID()}`;
  const metadata = JSON.stringify({
    name: options.name,
    mimeType: options.mimeType,
    ...(options.parents && options.parents.length > 0 ? { parents: options.parents } : {}),
    ...(options.appProperties ? { appProperties: options.appProperties } : {}),
  });
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Type: ${options.content.type || options.mimeType}\r\n\r\n`,
    options.content,
    `\r\n--${boundary}--`,
  ]);
  const url = new URL(`${UPLOAD_API}/files`);
  url.searchParams.set('uploadType', 'multipart');
  url.searchParams.set(
    'fields',
    'id,name,mimeType,modifiedTime,webViewLink,parents,appProperties',
  );
  return parseJson<DriveFile>(
    await fetchImpl(url.toString(), {
      method: 'POST',
      headers: {
        ...authHeaders(token),
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    }),
  );
}

export async function replaceFileContent(
  token: string,
  fileId: string,
  content: Blob,
  mimeType: string,
  fetchImpl: FetchLike = fetch,
): Promise<DriveFile> {
  const url = new URL(`${UPLOAD_API}/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set('uploadType', 'media');
  url.searchParams.set(
    'fields',
    'id,name,mimeType,modifiedTime,webViewLink,parents,appProperties',
  );
  return parseJson<DriveFile>(
    await fetchImpl(url.toString(), {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'Content-Type': mimeType },
      body: content,
    }),
  );
}

export interface SheetProperties {
  sheetId: number;
  title: string;
}

export async function getSpreadsheetSheets(
  token: string,
  spreadsheetId: string,
  fetchImpl: FetchLike = fetch,
): Promise<SheetProperties[]> {
  const url = new URL(`${SHEETS_API}/${encodeURIComponent(spreadsheetId)}`);
  url.searchParams.set('fields', 'sheets(properties(sheetId,title))');
  const data = await parseJson<{
    sheets?: { properties?: { sheetId?: number; title?: string } }[];
  }>(await fetchImpl(url.toString(), { headers: authHeaders(token) }));
  return (data.sheets ?? [])
    .map((sheet) => sheet.properties)
    .filter(
      (props): props is SheetProperties =>
        props !== undefined && typeof props.sheetId === 'number' && typeof props.title === 'string',
    );
}

export async function addSheet(
  token: string,
  spreadsheetId: string,
  title: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  await parseJson(
    await fetchImpl(
      `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
      {
        method: 'POST',
        headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{ addSheet: { properties: { title } } }],
        }),
      },
    ),
  );
}

export function sheetRange(title: string, suffix = ''): string {
  const escaped = `'${title.replace(/'/g, "''")}'`;
  return suffix ? `${escaped}!${suffix}` : escaped;
}

export async function clearSheet(
  token: string,
  spreadsheetId: string,
  title: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const range = encodeURIComponent(sheetRange(title));
  await parseJson(
    await fetchImpl(`${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${range}:clear`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: '{}',
    }),
  );
}

export async function writeSheetValues(
  token: string,
  spreadsheetId: string,
  title: string,
  values: unknown[][],
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const range = encodeURIComponent(sheetRange(title, 'A1'));
  await parseJson(
    await fetchImpl(
      `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${range}?valueInputOption=RAW`,
      {
        method: 'PUT',
        headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ majorDimension: 'ROWS', values }),
      },
    ),
  );
}

function columnLetter(index: number): string {
  let value = index + 1;
  let letters = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

export async function writeSheetFormulas(
  token: string,
  spreadsheetId: string,
  title: string,
  formulas: { row: number; column: number; formula: string }[],
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  if (formulas.length === 0) return;
  const data = formulas.map((item) => ({
    range: sheetRange(title, `${columnLetter(item.column)}${item.row}`),
    values: [[item.formula]],
  }));
  await parseJson(
    await fetchImpl(
      `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
      {
        method: 'POST',
        headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
      },
    ),
  );
}

export async function readSheetValues(
  token: string,
  spreadsheetId: string,
  title: string,
  fetchImpl: FetchLike = fetch,
): Promise<unknown[][]> {
  const range = encodeURIComponent(sheetRange(title));
  const url = `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${range}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`;
  const data = await parseJson<{ values?: unknown[][] }>(
    await fetchImpl(url, { headers: authHeaders(token) }),
  );
  return data.values ?? [];
}

export async function ensureSheets(
  token: string,
  spreadsheetId: string,
  titles: string[],
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const existing = new Set(
    (await getSpreadsheetSheets(token, spreadsheetId, fetchImpl)).map((sheet) => sheet.title),
  );
  for (const title of titles) {
    if (!existing.has(title)) {
      await addSheet(token, spreadsheetId, title, fetchImpl);
      existing.add(title);
    }
  }
}

export async function findFirstFile(
  token: string,
  query: string,
  fetchImpl: FetchLike = fetch,
): Promise<DriveFile | undefined> {
  const files = await listFiles(token, query, fetchImpl);
  return files[0];
}

export function parseDriveFileId(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const fromPath = /\/d\/([A-Za-z0-9_-]{10,})/.exec(trimmed);
  if (fromPath) return fromPath[1];
  const fromQuery = /[?&]id=([A-Za-z0-9_-]{10,})/.exec(trimmed);
  if (fromQuery) return fromQuery[1];
  if (/^[A-Za-z0-9_-]{20,}$/.test(trimmed)) return trimmed;
  return undefined;
}
