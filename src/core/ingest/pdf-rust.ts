import { isTauri } from '@tauri-apps/api/core';
import type { PdfExtractionProgress } from './types';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export interface PdfExtractionResult {
  markdown: string;
  page_count: number;
  text_pages: number;
  ocr_pages: number;
  mode: string;
  code?: string;
  error?: string;
}

export interface PdfExtractionOptions {
  requestId?: string;
  onProgress?: (progress: PdfExtractionProgress) => void;
}

function failed(code: string, error: string): PdfExtractionResult {
  return {
    markdown: '',
    page_count: 0,
    text_pages: 0,
    ocr_pages: 0,
    mode: 'unavailable',
    code,
    error,
  };
}

/**
 * Run Docling through the Rust bridge. Docling decides between native text
 * extraction and OCR based on the PDF's text layer; the Rust side emits
 * `pdf-extract-progress` events while the CLI is running.
 */
export async function pdfDoclingFromRust(
  bytes: ArrayBuffer | Uint8Array,
  password?: string,
  options: PdfExtractionOptions = {},
): Promise<PdfExtractionResult> {
  if (!isTauri()) {
    return failed('desktopRequired', 'PDF extraction requires the desktop app.');
  }

  const requestId = options.requestId ?? crypto.randomUUID();
  let unlisten: (() => void) | undefined;
  if (options.onProgress) {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen<PdfExtractionProgress>('pdf-extract-progress', (event) => {
        if (event.payload.request_id === requestId) options.onProgress?.(event.payload);
      });
    } catch {
      // Progress is best-effort; extraction still works without the listener.
    }
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return await invoke<PdfExtractionResult>('extract_pdf_with_docling', {
      req: {
        bytes_base64: bytesToBase64(data),
        request_id: requestId,
        ...(password ? { password } : {}),
      },
    });
  } catch (cause) {
    return failed('invoke', cause instanceof Error ? cause.message : String(cause));
  } finally {
    unlisten?.();
  }
}
