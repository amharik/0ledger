import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type LedgerDatabase } from '@/core/db/db';
import { createWorkspace } from '@/core/db/workspace-service';
import { syncGmailStatements } from '@/core/ingest';

const databases: LedgerDatabase[] = [];

function newDb() {
  const db = createTestDb();
  databases.push(db);
  return db;
}

afterEach(async () => {
  for (const db of databases.splice(0)) {
    await db.delete();
    db.close();
  }
});

function base64Url(text: string): string {
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const CSV = `HDFC Bank Statement

Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.,Closing Balance
01/11/2026,UPI-PAID-VENDOR,REF123,"1,500.00",,"98,500.00"
`;

function eml(): string {
  return `From: HDFC Bank <statements@hdfcbank.net>
To: owner@example.com
Subject: Account statement
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="BOUNDARY"

--BOUNDARY
Content-Type: text/plain; charset=utf-8

Statement attached.
--BOUNDARY
Content-Type: text/csv; name="hdfc.csv"
Content-Disposition: attachment; filename="hdfc.csv"
Content-Transfer-Encoding: base64

${btoa(CSV)}
--BOUNDARY--
`;
}

describe('gmail sync', () => {
  it('fetches raw messages and stages statement attachments', async () => {
    const db = newDb();
    const bundle = await createWorkspace(db, { name: 'Gmail Co', state: 'Karnataka' });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/messages?')) {
        return new Response(JSON.stringify({ messages: [{ id: 'm1' }] }), { status: 200 });
      }
      if (url.includes('/messages/m1')) {
        return new Response(JSON.stringify({ raw: base64Url(eml()) }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const result = await syncGmailStatements(db, bundle.workspace.id, {
      accessToken: 'test-token',
      fetchImpl,
    });

    expect(result.messages).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(result.batches).toHaveLength(1);
    expect(result.batches[0]?.batch.totalLines).toBe(1);
    expect(await db.statementLines.count()).toBe(1);
  });
});
