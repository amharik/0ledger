import { isTauri } from '@tauri-apps/api/core';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function pdfMarkdownFromRust(
  bytes: ArrayBuffer | Uint8Array,
): Promise<string | undefined> {
  if (!isTauri()) return undefined;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return await invoke<string>('extract_pdf_markdown', {
      req: { bytes_base64: bytesToBase64(data) },
    });
  } catch {
    return undefined;
  }
}

export interface PdfOcrResult {
  markdown?: string;
  error?: string;
}

export async function pdfOcrFromDocling(
  bytes: ArrayBuffer | Uint8Array,
): Promise<PdfOcrResult> {
  if (!isTauri()) {
    return { error: 'Docling OCR requires the desktop app.' };
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const markdown = await invoke<string>('ocr_pdf_with_docling', {
      req: { bytes_base64: bytesToBase64(data) },
    });
    return { markdown };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
}
