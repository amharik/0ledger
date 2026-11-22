import { exportTallyXml, type TallyExportOptions } from './tally-export';
import type { WorkbookData } from '../template/data';

export interface TallyBridgeConfig {
  endpoint: string; // e.g., 'http://localhost:9000'
  timeoutMs?: number;
}

export interface TallyConnectionStatus {
  online: boolean;
  endpoint: string;
  serverVersion?: string;
  companyNames: string[];
  errorMessage?: string;
  helpTip?: string;
}

export interface TallyPushResult {
  success: boolean;
  created: number;
  altered: number;
  errors: number;
  lastVchId?: string | undefined;
  errorMessages: string[];
  rawResponse?: string | undefined;
}

const DEFAULT_ENDPOINT = 'http://localhost:9000';
const DEFAULT_TIMEOUT_MS = 6000;

export function parseTallyResponseXml(xml: string): TallyPushResult {
  const createdMatch = /<CREATED>(\d+)<\/CREATED>/i.exec(xml);
  const alteredMatch = /<ALTERED>(\d+)<\/ALTERED>/i.exec(xml);
  const errorsMatch = /<ERRORS>(\d+)<\/ERRORS>/i.exec(xml);
  const lastVchMatch = /<LASTVCHID>([^<]+)<\/LASTVCHID>/i.exec(xml);

  const created = createdMatch?.[1] ? parseInt(createdMatch[1], 10) : 0;
  const altered = alteredMatch?.[1] ? parseInt(alteredMatch[1], 10) : 0;
  const errors = errorsMatch?.[1] ? parseInt(errorsMatch[1], 10) : 0;
  const lastVchId = lastVchMatch?.[1] ? lastVchMatch[1].trim() : undefined;

  const errorMessages: string[] = [];
  const lineErrors = xml.matchAll(/<LINEERROR>([^<]+)<\/LINEERROR>/gi);
  for (const m of lineErrors) {
    if (m[1]) errorMessages.push(m[1].trim());
  }

  // Tally sometimes returns error description directly
  const descMatch = /<DESCRIPTION>([^<]+)<\/DESCRIPTION>/i.exec(xml);
  if (descMatch?.[1] && !descMatch[1].toLowerCase().includes('success')) {
    errorMessages.push(descMatch[1].trim());
  }

  const success = errors === 0 && (created > 0 || altered > 0 || errorMessages.length === 0);

  return {
    success,
    created,
    altered,
    errors,
    lastVchId,
    errorMessages,
    rawResponse: xml,
  };
}

/**
 * Builds XML request to query active companies loaded in Tally Prime.
 */
export function buildListCompaniesXml(): string {
  return [
    '<ENVELOPE>',
    '  <HEADER>',
    '    <VERSION>1</VERSION>',
    '    <TALLYREQUEST>Export Data</TALLYREQUEST>',
    '    <TYPE>Data</TYPE>',
    '    <ID>List of Companies</ID>',
    '  </HEADER>',
    '  <BODY>',
    '    <DESC>',
    '      <STATICVARIABLES>',
    '        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>',
    '      </STATICVARIABLES>',
    '    </DESC>',
    '  </BODY>',
    '</ENVELOPE>',
  ].join('\n');
}

/**
 * Pings Tally Prime on the given endpoint to verify connectivity and get open company list.
 */
export async function testTallyConnection(
  endpoint = DEFAULT_ENDPOINT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<TallyConnectionStatus> {
  const url = endpoint.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml;charset=utf-8',
      },
      body: buildListCompaniesXml(),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      return {
        online: false,
        endpoint: url,
        errorMessage: `Tally server returned HTTP status ${res.status}: ${res.statusText}`,
        companyNames: [],
      };
    }

    const xml = await res.text();

    // Extract company names
    const companies: string[] = [];
    const compMatches = xml.matchAll(/<COMPANYNAME>([^<]+)<\/COMPANYNAME>/gi);
    for (const m of compMatches) {
      if (m[1]) companies.push(m[1].trim());
    }

    // Secondary match for company tags
    if (companies.length === 0) {
      const nameMatches = xml.matchAll(/<NAME[^>]*>([^<]+)<\/NAME>/gi);
      for (const m of nameMatches) {
        if (m[1] && !m[1].startsWith('$$')) companies.push(m[1].trim());
      }
    }

    return {
      online: true,
      endpoint: url,
      companyNames: [...new Set(companies)],
    };
  } catch (err: unknown) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    const isCors = msg.includes('Failed to fetch') || msg.includes('NetworkError');

    return {
      online: false,
      endpoint: url,
      errorMessage: isCors
        ? 'Cannot reach Tally Prime on localhost:9000. Tally may not be running or HTTP Server is not enabled.'
        : msg,
      helpTip:
        'To enable in Tally Prime: Press F1 (Help) → Settings → Connectivity → Set "Client/Server configuration" to "Both" or "Server" and port to 9000. Restart Tally Prime.',
      companyNames: [],
    };
  }
}

/**
 * Pushes full workspace ledger data directly to local Tally Prime over HTTP XML.
 */
export async function pushLedgerToTallyPrime(
  data: WorkbookData,
  options?: {
    endpoint?: string;
    exportOptions?: TallyExportOptions;
    timeoutMs?: number;
  },
): Promise<TallyPushResult> {
  const endpoint = (options?.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const timeoutMs = options?.timeoutMs ?? 15000;

  const xmlPayload = exportTallyXml(data, options?.exportOptions ?? { allowIncomplete: true });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml;charset=utf-8',
      },
      body: xmlPayload,
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      return {
        success: false,
        created: 0,
        altered: 0,
        errors: 1,
        errorMessages: [`Tally returned HTTP ${res.status}: ${res.statusText}`],
      };
    }

    const resXml = await res.text();
    return parseTallyResponseXml(resXml);
  } catch (err: unknown) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      created: 0,
      altered: 0,
      errors: 1,
      errorMessages: [`Connection error to ${endpoint}: ${msg}`],
    };
  }
}
