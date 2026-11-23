import { z } from 'zod';

export interface ValidatedImapConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  mailbox: string;
  tls: boolean;
}

export interface ValidatedImapQuery {
  preset: 'fastag' | 'bank' | 'shopping' | 'all' | 'custom';
  custom_search?: string;
  limit: number;
  days: number;
  cursor?: number;
}

const hostSchema = z
  .string()
  .trim()
  .min(1, 'IMAP host is required (e.g., imap.gmail.com).')
  .max(253, 'IMAP host is too long.')
  .refine((value) => !/[\s/@]/.test(value) && !value.includes('://'), {
    message: 'IMAP host must be a hostname or IP address, not a URL.',
  });

const configSchema = z.object({
  host: hostSchema,
  port: z.coerce
    .number()
    .int('IMAP port must be an integer.')
    .min(1, 'IMAP port must be between 1 and 65535.')
    .max(65535, 'IMAP port must be between 1 and 65535.')
    .default(993),
  username: z
    .string()
    .trim()
    .min(1, 'Email address / username is required.')
    .max(320, 'Email address / username is too long.'),
  password: z
    .string()
    .min(1, 'Password or App Password is required.')
    .max(2048, 'Password or App Password is too long.'),
  mailbox: z.string().trim().max(255, 'Mailbox name is too long.').optional(),
  tls: z.boolean().optional(),
});

const querySchema = z.object({
  preset: z.enum(['fastag', 'bank', 'shopping', 'all', 'custom']).default('bank'),
  custom_search: z.string().trim().max(200, 'Custom search is too long.').optional(),
  limit: z.coerce
    .number()
    .int('Limit must be an integer.')
    .min(1, 'Limit must be at least 1.')
    .max(50, 'Limit cannot exceed 50.')
    .default(25),
  days: z.coerce
    .number()
    .int('Days must be an integer.')
    .min(1, 'Days must be at least 1.')
    .max(365, 'Days cannot exceed 365.')
    .default(60),
  cursor: z.coerce
    .number()
    .int('Cursor must be an integer.')
    .positive('Cursor must be positive.')
    .optional(),
});

function zodMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      return `${path}${issue.message}`;
    })
    .join('; ');
}

export function parseImapConfig(raw: unknown): ValidatedImapConfig {
  const result = configSchema.safeParse(raw);
  if (!result.success) throw new Error(zodMessage(result.error));
  const data = result.data;
  return {
    host: data.host,
    port: data.port,
    username: data.username,
    password: data.password,
    mailbox: data.mailbox?.trim() || 'INBOX',
    tls: data.tls ?? data.port === 993,
  };
}

export function parseImapQuery(raw: unknown): ValidatedImapQuery {
  const result = querySchema.safeParse(raw ?? {});
  if (!result.success) throw new Error(zodMessage(result.error));
  const data = result.data;
  const query: ValidatedImapQuery = {
    preset: data.preset,
    limit: data.limit,
    days: data.days,
  };
  if (data.custom_search) query.custom_search = data.custom_search;
  if (data.cursor !== undefined) query.cursor = data.cursor;
  return query;
}
