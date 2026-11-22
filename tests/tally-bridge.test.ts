import { describe, expect, it } from 'vitest';
import {
  parseTallyResponseXml,
  buildListCompaniesXml,
} from '../src/core/interchange/tally-bridge';

describe('Tally Prime Live Bridge', () => {
  it('builds valid company listing request XML', () => {
    const xml = buildListCompaniesXml();
    expect(xml).toContain('<TALLYREQUEST>Export Data</TALLYREQUEST>');
    expect(xml).toContain('<ID>List of Companies</ID>');
  });

  it('parses successful Tally response XML', () => {
    const resXml = `
      <RESPONSE>
        <CREATED>4</CREATED>
        <ALTERED>1</ALTERED>
        <DELETED>0</DELETED>
        <LASTVCHID>987654</LASTVCHID>
        <ERRORS>0</ERRORS>
      </RESPONSE>
    `;
    const parsed = parseTallyResponseXml(resXml);
    expect(parsed.success).toBe(true);
    expect(parsed.created).toBe(4);
    expect(parsed.altered).toBe(1);
    expect(parsed.errors).toBe(0);
    expect(parsed.lastVchId).toBe('987654');
    expect(parsed.errorMessages).toHaveLength(0);
  });

  it('parses Tally error response with line errors', () => {
    const resXml = `
      <RESPONSE>
        <CREATED>0</CREATED>
        <ALTERED>0</ALTERED>
        <ERRORS>1</ERRORS>
        <LINEERROR>Ledger 'HDFC Bank Ltd' does not exist in company.</LINEERROR>
      </RESPONSE>
    `;
    const parsed = parseTallyResponseXml(resXml);
    expect(parsed.success).toBe(false);
    expect(parsed.errors).toBe(1);
    expect(parsed.errorMessages).toContain("Ledger 'HDFC Bank Ltd' does not exist in company.");
  });
});
