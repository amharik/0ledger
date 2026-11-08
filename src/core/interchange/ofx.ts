import type { WorkbookData } from '../template/data';
import { minorToDecimalString } from '../money/money';
import { escapeXml } from './xml';

function ofxDate(isoDate: string): string {
  return `${isoDate.replace(/-/g, '')}120000`;
}

export interface OfxOptions {
  bankLedgerId?: string;
  bankId?: string;
  accountId?: string;
  accountType?: 'CHECKING' | 'SAVINGS' | 'MONEYMRKT' | 'CREDITLINE';
}

export function exportOfx(data: WorkbookData, options: OfxOptions = {}): string {
  const bank =
    data.ledgers.find((ledger) => ledger.id === options.bankLedgerId) ??
    data.ledgers.find((ledger) => ledger.isBank);
  if (!bank) throw new Error('No bank ledger found for OFX export');

  const bankLinesByVoucher = new Map<string, number>();
  for (const line of data.voucherLines) {
    if (line.ledgerId !== bank.id) continue;
    const voucher = data.vouchers.find((item) => item.id === line.voucherId);
    if (!voucher || voucher.status !== 'regular') continue;
    bankLinesByVoucher.set(voucher.id, (bankLinesByVoucher.get(voucher.id) ?? 0) + line.amountMinor);
  }
  const vouchers = data.vouchers
    .filter((voucher) => bankLinesByVoucher.has(voucher.id))
    .sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));
  if (vouchers.length === 0) throw new Error(`No posted vouchers touch bank ledger "${bank.name}"`);

  const ledgerById = new Map(data.ledgers.map((ledger) => [ledger.id, ledger]));
  const closing = data.trialBalance.rows.find((row) => row.ledgerId === bank.id)?.closingMinor ?? 0;
  const currency = data.company.currency;
  const amount = (minor: number) => minorToDecimalString(minor, currency);

  const transactions = vouchers
    .map((voucher) => {
      const signed = bankLinesByVoucher.get(voucher.id) ?? 0;
      const party = voucher.partyLedgerId ? ledgerById.get(voucher.partyLedgerId)?.name : undefined;
      const name = party ?? voucher.voucherType;
      return [
        '<STMTTRN>',
        `<TRNTYPE>${signed >= 0 ? 'CREDIT' : 'DEBIT'}</TRNTYPE>`,
        `<DTPOSTED>${ofxDate(voucher.date)}</DTPOSTED>`,
        `<TRNAMT>${escapeXml(amount(signed))}</TRNAMT>`,
        `<FITID>${escapeXml(voucher.id)}</FITID>`,
        `<NAME>${escapeXml(name)}</NAME>`,
        `<MEMO>${escapeXml(voucher.narration ?? voucher.number)}</MEMO>`,
        '</STMTTRN>',
      ].join('');
    })
    .join('\n');

  const start = vouchers[0]!.date;
  const end = vouchers.at(-1)!.date;
  const accountId = options.accountId ?? bank.bankAccountNo ?? bank.code ?? bank.id;
  const bankId = options.bankId ?? bank.bankIfsc ?? '0LEDGER';
  const accountType = options.accountType ?? 'CHECKING';

  return [
    'OFXHEADER:100',
    'DATA:OFXSGML',
    'VERSION:102',
    'SECURITY:NONE',
    'ENCODING:USASCII',
    'CHARSET:1252',
    'COMPRESSION:NONE',
    'OLDFILEUID:NONE',
    'NEWFILEUID:NONE',
    '',
    '<OFX>',
    '<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>',
    `<DTSERVER>${ofxDate(new Date().toISOString().slice(0, 10))}</DTSERVER>`,
    '<LANGUAGE>ENG</LANGUAGE></SONRS></SIGNONMSGSRSV1>',
    '<BANKMSGSRSV1><STMTTRNRS><TRNUID>0</TRNUID>',
    '<STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>',
    '<STMTRS>',
    `<CURDEF>${escapeXml(currency)}</CURDEF>`,
    '<BANKACCTFROM>',
    `<BANKID>${escapeXml(bankId)}</BANKID>`,
    `<ACCTID>${escapeXml(accountId)}</ACCTID>`,
    `<ACCTTYPE>${accountType}</ACCTTYPE>`,
    '</BANKACCTFROM>',
    '<BANKTRANLIST>',
    `<DTSTART>${ofxDate(start)}</DTSTART>`,
    `<DTEND>${ofxDate(end)}</DTEND>`,
    transactions,
    '</BANKTRANLIST>',
    '<LEDGERBAL>',
    `<BALAMT>${escapeXml(amount(closing))}</BALAMT>`,
    `<DTASOF>${ofxDate(end)}</DTASOF>`,
    '</LEDGERBAL>',
    '</STMTRS></STMTTRNRS></BANKMSGSRSV1>',
    '</OFX>',
  ].join('\n');
}
