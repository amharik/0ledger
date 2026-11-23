import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { Download, FileText, Mail, Paperclip, X } from 'lucide-react';
import { getDb } from '@/core/db/db';
import {
  base64ToBytes,
  findAttachment,
  findEmailArchiveForAttachment,
  getEmailArchive,
  listEmailArchiveFiles,
} from '@/core/desktop/email-archive';
import type { Attachment, EmailArchive, EmailArchiveFile } from '@/core/model';

interface Props {
  workspaceId: string;
  emailArchiveId?: string;
  attachmentId?: string;
  onClose: () => void;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function downloadBytes(bytes: Uint8Array, fileName: string, mimeType: string): void {
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function readStoredBytes(storagePath: string): Promise<Uint8Array> {
  if (!isTauri()) throw new Error('Archived file bytes are only readable in the desktop app.');
  const { invoke } = await import('@tauri-apps/api/core');
  const base64 = await invoke<string>('read_file_base64', { filePath: storagePath });
  return base64ToBytes(base64);
}

async function archiveBytes(archive: EmailArchive): Promise<Uint8Array> {
  if (archive.rawBase64) return base64ToBytes(archive.rawBase64);
  if (archive.rawStoragePath) return readStoredBytes(archive.rawStoragePath);
  throw new Error('The raw email was not stored for this archive.');
}

async function fileBytes(file: EmailArchiveFile): Promise<Uint8Array> {
  if (file.contentBase64) return base64ToBytes(file.contentBase64);
  if (file.storagePath) return readStoredBytes(file.storagePath);
  throw new Error('Attachment bytes are unavailable for this archive.');
}

function openBytes(bytes: Uint8Array, mimeType: string): void {
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mimeType });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener,noreferrer');
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function SourceEmailPreview({
  workspaceId,
  emailArchiveId,
  attachmentId,
  onClose,
}: Props) {
  const [archive, setArchive] = useState<EmailArchive>();
  const [files, setFiles] = useState<EmailArchiveFile[]>([]);
  const [attachment, setAttachment] = useState<Attachment>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [actionError, setActionError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    const db = getDb();
    void (async () => {
      let found: EmailArchive | undefined;
      if (emailArchiveId) found = await getEmailArchive(db, workspaceId, emailArchiveId);
      if (!found && attachmentId) {
        found = await findEmailArchiveForAttachment(db, workspaceId, attachmentId);
        if (!found) setAttachment(await findAttachment(db, workspaceId, attachmentId));
      }
      if (cancelled) return;
      setArchive(found);
      if (found) setFiles(await listEmailArchiveFiles(db, workspaceId, found.id));
      if (cancelled) return;
      setLoading(false);
    })().catch((cause) => {
      if (!cancelled) {
        setError(errorMessage(cause));
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, emailArchiveId, attachmentId]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/50 p-4 sm:p-8">
      <div className="w-full max-w-2xl rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div className="flex min-w-0 items-start gap-3">
            <div className="mt-0.5 rounded-lg bg-indigo-50 p-2 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-300">
              <Mail className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                {archive?.subject ?? attachment?.fileName ?? 'Source email'}
              </h3>
              <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
                {archive
                  ? `${archive.from} · ${archive.date ? new Date(archive.date).toLocaleString() : archive.receivedAt}`
                  : attachment
                    ? `${attachment.mimeType} · ${attachment.sizeBytes.toLocaleString()} bytes`
                    : 'Email archive'}
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close source email preview"
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {loading ? (
            <div className="h-24 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" />
          ) : error ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
              {error}
            </div>
          ) : archive ? (
            <>
            {actionError ? (
              <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
                {actionError}
              </div>
            ) : null}
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-full bg-slate-100 px-2 py-1 font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  {archive.statementCount} statement{archive.statementCount === 1 ? '' : 's'}
                </span>
                {archive.isMonthlyStatement ? (
                  <span className="rounded-full bg-emerald-50 px-2 py-1 font-medium text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
                    Monthly statement{archive.statementPeriod ? ` · ${archive.statementPeriod}` : ''}
                  </span>
                ) : null}
                <span className="text-slate-400">{archive.sizeBytes.toLocaleString()} bytes</span>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() =>
                    void archiveBytes(archive)
                      .then((bytes) =>
                        downloadBytes(
                          bytes,
                          `${(archive.subject || 'email').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)}.eml`,
                          'message/rfc822',
                        ),
                      )
                      .catch((cause) => setActionError(errorMessage(cause)))
                  }
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download .eml
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void archiveBytes(archive)
                      .then((bytes) => openBytes(bytes, 'message/rfc822'))
                      .catch((cause) => setActionError(errorMessage(cause)))
                  }
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  <FileText className="h-3.5 w-3.5" />
                  Open email
                </button>
              </div>

              <div>
                <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                  <Paperclip className="h-3.5 w-3.5" />
                  Attachments ({files.length})
                </div>
                {files.length === 0 ? (
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    No attachment bytes were archived for this email.
                  </p>
                ) : (
                  <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
                    {files.map((file) => {
                      return (
                        <li
                          key={file.id}
                          className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                        >
                          <div className="min-w-0">
                            <div className="truncate text-xs font-medium text-slate-800 dark:text-slate-200">
                              {file.fileName}
                            </div>
                            <div className="text-[11px] text-slate-500 dark:text-slate-400">
                              {file.mimeType} · {file.sizeBytes.toLocaleString()} bytes
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() =>
                                void fileBytes(file)
                                  .then((bytes) => openBytes(bytes, file.mimeType))
                                  .catch((cause) => setActionError(errorMessage(cause)))
                              }
                              className="rounded-md px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-indigo-950/50"
                            >
                              Preview
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                void fileBytes(file)
                                  .then((bytes) => downloadBytes(bytes, file.fileName, file.mimeType))
                                  .catch((cause) => setActionError(errorMessage(cause)))
                              }
                              className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
                              aria-label={`Download ${file.fileName}`}
                            >
                              <Download className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </>
            </>
          ) : attachment ? (
            <div className="space-y-2 text-sm">
              <p className="text-slate-700 dark:text-slate-300">
                {attachment.fileName}
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Archived at {attachment.storageKey}
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                This proof was archived before email previews were enabled, so attachment bytes are
                only available at the vault path.
              </p>
            </div>
          ) : (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              No archived source email was found for this record.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
