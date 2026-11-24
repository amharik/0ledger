import { isTauri } from '@tauri-apps/api/core';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export interface PdfMarkdownResult {
  markdown?: string;
  code?: string;
  error?: string;
}

export async function pdfMarkdownFromRust(
  bytes: ArrayBuffer | Uint8Array,
  password?: string,
): Promise<PdfMarkdownResult> {
  if (!isTauri()) {
    return { code: 'desktopRequired', error: 'PDF extraction requires the desktop app.' };
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return await invoke<PdfMarkdownResult>('extract_pdf_markdown', {
      req: {
        bytes_base64: bytesToBase64(data),
        ...(password ? { password } : {}),
      },
    });
  } catch (cause) {
    return { code: 'invoke', error: cause instanceof Error ? cause.message : String(cause) };
  }
}

export interface PdfTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  page: number;
}

export interface PdfLayoutResult {
  items: PdfTextItem[];
  page_count: number;
  code?: string;
  error?: string;
}

export async function pdfLayoutFromRust(
  bytes: ArrayBuffer | Uint8Array,
  password?: string,
): Promise<PdfLayoutResult> {
  if (!isTauri()) {
    return {
      items: [],
      page_count: 0,
      code: 'desktopRequired',
      error: 'PDF layout extraction requires the desktop app.',
    };
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const result = await invoke<PdfLayoutResult>('extract_pdf_layout', {
      req: {
        bytes_base64: bytesToBase64(data),
        ...(password ? { password } : {}),
      },
    });
    return {
      ...result,
      items: Array.isArray(result.items) ? result.items : [],
      page_count: result.page_count ?? 0,
    };
  } catch (cause) {
    return {
      items: [],
      page_count: 0,
      code: 'invoke',
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

export interface PdfOcrResult {
  markdown?: string;
  code?: string;
  error?: string;
}

export async function pdfOcrFromDocling(
  bytes: ArrayBuffer | Uint8Array,
  password?: string,
): Promise<PdfOcrResult> {
  if (!isTauri()) {
    return { code: 'desktopRequired', error: 'Docling extraction requires the desktop app.' };
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const markdown = await invoke<string>('ocr_pdf_with_docling', {
      req: {
        bytes_base64: bytesToBase64(data),
        ...(password ? { password } : {}),
      },
    });
    return { markdown };
  } catch (cause) {
    return {
      code: 'invoke',
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
