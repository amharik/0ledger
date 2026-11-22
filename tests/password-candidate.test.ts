import { describe, expect, it } from 'vitest';
import {
  generatePasswordCandidates,
  extractPasswordHintFromText,
  type StatementUserProfile,
} from '@/core/ingest/passwords';

describe('Statement PDF Password Candidate Engine', () => {
  const profile: StatementUserProfile = {
    fullName: 'Ravi Kumar Sharma',
    dob: '1992-05-18', // 18 May 1992
    pan: 'ABCDE1234F',
    cardLast4: '9876',
    accountLast4: '5432',
    customerId: 'CUST10293847',
  };

  it('generates candidates for HDFC statements prioritizing uppercase Name4 + DDMM', () => {
    const candidates = generatePasswordCandidates(profile, {
      institution: 'HDFC Bank',
    });

    const passwords = candidates.map((c) => c.password);
    // HDFC standard format: RAVI1805
    expect(passwords).toContain('RAVI1805');
    expect(passwords).toContain('ravi1805');
    expect(passwords).toContain('CUST10293847');
    expect(candidates[0]!.password).toBe('RAVI1805');
  });

  it('generates candidates for ICICI statements prioritizing lowercase Name4 + DDMM', () => {
    const candidates = generatePasswordCandidates(profile, {
      institution: 'ICICI Bank',
    });

    const passwords = candidates.map((c) => c.password);
    expect(passwords).toContain('ravi1805');
    expect(passwords).toContain('RAVI1805');
    expect(candidates[0]!.password).toBe('ravi1805');
  });

  it('generates candidates for Axis Bank statements prioritizing Name4 + Card Last 4', () => {
    const candidates = generatePasswordCandidates(profile, {
      institution: 'Axis Bank',
    });

    const passwords = candidates.map((c) => c.password);
    expect(passwords).toContain('RAVI9876');
    expect(passwords).toContain('ravi9876');
    expect(candidates[0]!.password).toBe('RAVI9876');
  });

  it('generates candidates for SBI Card statements prioritizing DDMMYYYY + Card Last 4', () => {
    const candidates = generatePasswordCandidates(profile, {
      institution: 'SBI Card',
    });

    const passwords = candidates.map((c) => c.password);
    expect(passwords).toContain('180519929876');
    expect(passwords).toContain('18051992');
    expect(candidates[0]!.password).toBe('180519929876');
  });

  it('extracts embedded password hints from email text and promotes matching pattern', () => {
    const emailBody = `
      Dear Customer,
      Your e-statement is password protected.
      Password is your Date of Birth in DDMMYYYY format.
    `;

    const hint = extractPasswordHintFromText(emailBody);
    expect(hint.detectedPattern).toBe('dob_ddmmyyyy');

    const candidates = generatePasswordCandidates(profile, {
      hintText: emailBody,
    });

    // When hint is DDMMYYYY, it must be the #1 candidate!
    expect(candidates[0]!.password).toBe('18051992');
  });

  it('prioritizes remembered working pattern when previously saved for an institution', () => {
    const candidates = generatePasswordCandidates(profile, {
      institution: 'HDFC Bank',
      rememberedPattern: 'customer_id',
    });

    // The remembered pattern takes precedence
    expect(candidates[0]!.password).toBe('CUST10293847');
  });
});
