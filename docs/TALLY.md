# Tally XML field mapping

Tally XML export/import is implemented in M5 and hardened in M6.

> Target: Tally Prime. Tally ERP 9 compatibility where practical. XML tag names are verified against fixtures; validate against your Tally build before relying on a production import.

## Envelope

```
<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY><IMPORTDATA>
    <REQUESTDESC>
      <REPORTNAME>Vouchers</REPORTNAME>
      <STATICVARIABLES><SVCURRENTCOMPANY>…</SVCURRENTCOMPANY></STATICVARIABLES>
    </REQUESTDESC>
    <REQUESTDATA>…masters and vouchers…</REQUESTDATA>
  </IMPORTDATA></BODY>
</ENVELOPE>
```

Masters use `REPORTNAME` `All Masters` or `Ledgers`/`Groups` as required.

## Company

| Tally concept | 0ledger field |
|---|---|
| Company name | `CompanyProfile.legalName` |
| Books beginning | `CompanyProfile.booksBegin` |
| Financial year start | `CompanyProfile.fyStartMonth` |
| Country / state | `CompanyProfile.country`, `.state` |
| GSTIN | `CompanyProfile.gstin` |
| Base currency | `CompanyProfile.currency` |
| Decimal places | `CompanyProfile.decimalPlaces` |

## Groups and ledgers

| Tally field | 0ledger field |
|---|---|
| `GROUP NAME` / `PARENT` | `LedgerGroup.name`, `.parent`, `.nature` |
| `LEDGER NAME` | `Ledger.name` |
| `PARENT` (group) | `Ledger.tallyParent` |
| `OPENINGBALANCE` | `Ledger.openingBalanceMinor` (signed) |
| `ISBILLWISEON` | `Ledger.isBillwise` |
| `ISCOSTCENTRESON` | `Ledger.costCenterApplicable` |
| `GSTIN` | `Ledger.gstin` |
| Bank details | `Ledger.bankAccountNo`, `.bankIfsc`, `.bankName` |
| Credit period / limit | `Ledger.creditPeriodDays`, `.creditLimitMinor` |
| Currency | `Ledger.currency` |
| Tax type | `Ledger.taxType` |
| Mailing details | `Party.address`, `.state`, `.pincode` |

## Voucher header

Emitted by `exportTallyVouchers`:

| Tally field | 0ledger field |
|---|---|
| `DATE` (`YYYYMMDD`) | `Voucher.date` |
| `EFFECTIVEDATE` | `Voucher.effectiveDate` |
| `VOUCHERTYPENAME` | `Voucher.voucherType` |
| `VOUCHERNUMBER` | `Voucher.number` |
| `REFERENCE` | `Voucher.reference` |
| `VOUCHERINVOICENUMBER` | `Voucher.invoiceNumber` |
| `VOUCHERINVOICEDATE` | `Voucher.invoiceDate` |
| `DUEDATE` / `CREDITDAYS` | `Voucher.dueDate`, `.creditDays` |
| `NARRATION` | `Voucher.narration` |
| `PARTYLEDGERNAME` | `Voucher.partyLedgerId` |
| `PLACEOFSUPPLY` | `Voucher.placeOfSupply` |
| `GSTREGISTRATION` | `Voucher.gstRegistration` |
| `ISOPTIONAL` / `ISCANCELLED` | `Voucher.status` |
| `ROUNDOFFLEDGERNAME` / `ROUNDOFFAMOUNT` | `Voucher.roundOffLedgerId`, `.roundOffAmountMinor` |
| `GUID` / `MASTERID` / `ALTERID` | `TallyFields.guid`, `.masterId`, `.alterId` |
| Reverse charge | `Voucher.reverseCharge` |

## Ledger entries

| Tally field | 0ledger field |
|---|---|
| `LEDGERNAME` | `VoucherLine.ledgerId` |
| `ISDEEMEDPOSITIVE` | derived from signed amount (debit = Yes) |
| `AMOUNT` | `VoucherLine.amountMinor` (signed) |
| Line narration | `VoucherLine.narration` |
| `FOREXAMOUNT` / `EXCHANGERATE` | `VoucherLine.forexAmountMinor`, `.exchangeRate` |

## Bill-wise allocation

| Tally field | 0ledger field |
|---|---|
| `BILLNAME` / `BILLTYPE` | `BillAllocation.billRef`, `.billType` (`New Ref`, `Against Ref`, `Advance`, `On Account`) |
| `AMOUNT` | `BillAllocation.amountMinor` |
| Due date / credit days | `BillAllocation.dueDate`, `.creditDays` |

## Cost centers

| Tally field | 0ledger field |
|---|---|
| `COSTCENTRENAME` / category | `CostCenter.name`, `.category` |
| Allocation amount | `CostCenterAllocation.amountMinor` |

## Inventory (captured; valuation implemented)

| Tally field | 0ledger field |
|---|---|
| `STOCKITEMNAME` | `ItemLine.stockItemId` / `StockItem.name` |
| `RATE` / `AMOUNT` | `ItemLine.rate`, `.amountMinor` |
| `ACTUALQTY` / `BILLEDQTY` | `ItemLine.quantity` |
| `HSNCODE` / `GSTOVRDNTAXABILITY` | `ItemLine.hsnSac` |
| `GODOWNNAME` / `BATCHNAME` | `ItemLine.godownId`, `.batchId` |
| UOM | `StockItem.uom` |
| Discount | `ItemLine.discountMinor` |

## GST / TDS (capture only)

| Tally field | 0ledger field |
|---|---|
| Tax ledger | `TaxAllocation.ledgerId` |
| CGST / SGST / IGST / CESS | `TaxAllocation.taxType`, `.amountMinor` |
| Taxable value / rate | `TaxAllocation.taxableValueMinor`, `.rate` |
| HSN/SAC | `VoucherLine.hsnSac` or `ItemLine.hsnSac` |
| TDS section / rate / amount | `TaxAllocation.tdsSection`, `.tdsRate`, `.tdsAmountMinor` |

`TaxAllocation` rows are mirrored in the workbook and can be captured in the invoice UI. Tally XML
only encodes tax amounts that exist as normal ledger entries; metadata-only allocations without a
`ledgerId` are not emitted into Tally tax ledgers. Gmail/Drive do not compute GST or TDS.

## Voucher types

| Tally field | 0ledger field |
|---|---|
| `VOUCHERTYPENAME` / parent | `VoucherType.name`, `.parent` |
| Numbering method, prefix, suffix | `NumberingScheme` |
| Active flag | `VoucherType.isActive` |

## Readiness rules (block export until satisfied)

- Every voucher balances to zero minor units (including round-off).
- Every referenced ledger exists and has a Tally parent group.
- Party ledgers are under Sundry Debtors/Creditors.
- Invoice numbers are present and unique per party + FY.
- Bill allocations reference valid bills and do not exceed balances.
- Tax vouchers warn when place of supply or a party ledger is missing.
- Item lines reference known stock items and godowns/batches belong to the workspace.
- Unsupported masters are reported explicitly, never silently dropped.
