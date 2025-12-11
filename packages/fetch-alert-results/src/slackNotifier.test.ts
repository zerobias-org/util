import { describe, it, expect } from 'vitest';
import {
  formatAlertForSlack,
  getSeverityColor,
  getSeverityEmoji,
  formatDate,
} from './slackNotifier.js';
import type { AlertResult, Account } from './alertFetcher.js';

describe('getSeverityColor', () => {
  it('should return red for critical', () => {
    expect(getSeverityColor('critical')).toBe('#E01E5A');
  });

  it('should return red for high', () => {
    expect(getSeverityColor('high')).toBe('#E01E5A');
  });

  it('should return yellow for medium', () => {
    expect(getSeverityColor('medium')).toBe('#ECB22E');
  });

  it('should return blue for low', () => {
    expect(getSeverityColor('low')).toBe('#36C5F0');
  });

  it('should return gray for unknown', () => {
    expect(getSeverityColor('unknown')).toBe('#808080');
  });

  it('should be case insensitive', () => {
    expect(getSeverityColor('Medium')).toBe('#ECB22E');
    expect(getSeverityColor('HIGH')).toBe('#E01E5A');
  });
});

describe('getSeverityEmoji', () => {
  it('should return alarm for critical', () => {
    expect(getSeverityEmoji('critical')).toBe('🚨');
  });

  it('should return red circle for high', () => {
    expect(getSeverityEmoji('high')).toBe('🔴');
  });

  it('should return orange circle for medium', () => {
    expect(getSeverityEmoji('medium')).toBe('🟠');
  });

  it('should return white circle for unknown', () => {
    expect(getSeverityEmoji('unknown')).toBe('⚪');
  });
});

describe('formatDate', () => {
  it('should format ISO date string', () => {
    const formatted = formatDate('2024-01-15T10:30:00Z');
    expect(formatted).toContain('Jan');
    expect(formatted).toContain('15');
    expect(formatted).toContain('2024');
  });
});

describe('formatAlertForSlack', () => {
  const sampleAlert: AlertResult = {
    id: 'alert-123',
    name: 'MFA Not Enabled Alert',
    title: 'Users without MFA',
    severity: 'high',
    created: '2024-01-15T10:30:00Z',
    body: {},
  };

  const sampleAccounts: Account[] = [
    { name: 'John Doe', email: 'john@example.com', mfaEnabled: false },
    { name: 'Jane Smith', email: 'jane@example.com', mfaEnabled: true },
  ];

  it('should include header with severity emoji and alert name', () => {
    const message = formatAlertForSlack(sampleAlert, sampleAccounts);

    const header = message.blocks?.find((b) => b.type === 'header');
    expect(header).toBeDefined();
    expect(header?.text?.text).toContain('🔴');
    expect(header?.text?.text).toContain('MFA Not Enabled Alert');
  });

  it('should include severity and created date fields', () => {
    const message = formatAlertForSlack(sampleAlert, sampleAccounts);

    const section = message.blocks?.find(
      (b) => b.type === 'section' && b.fields
    );
    expect(section?.fields).toHaveLength(4);
    expect(section?.fields?.[0].text).toContain('high');
    expect(section?.fields?.[1].text).toContain('Jan');
  });

  it('should include total accounts and MFA disabled count', () => {
    const message = formatAlertForSlack(sampleAlert, sampleAccounts);

    const section = message.blocks?.find(
      (b) => b.type === 'section' && b.fields
    );
    expect(section?.fields?.[2].text).toContain('2'); // Total
    expect(section?.fields?.[3].text).toContain('1'); // MFA Disabled
  });

  it('should use color based on severity', () => {
    const message = formatAlertForSlack(sampleAlert, sampleAccounts);

    expect(message.attachments).toHaveLength(1);
    expect(message.attachments?.[0].color).toBe('#E01E5A'); // Red for high
  });

  it('should format accounts in table with box drawing', () => {
    const message = formatAlertForSlack(sampleAlert, sampleAccounts);

    const tableSection = message.attachments?.[0].blocks.find(
      (b) => b.text?.text?.includes('```')
    );
    expect(tableSection?.text?.text).toContain('┌');
    expect(tableSection?.text?.text).toContain('│');
    expect(tableSection?.text?.text).toContain('└');
  });

  it('should show MFA status in table', () => {
    const message = formatAlertForSlack(sampleAlert, sampleAccounts);

    const tableSection = message.attachments?.[0].blocks.find(
      (b) => b.text?.text?.includes('```')
    );
    expect(tableSection?.text?.text).toContain('No'); // John has no MFA
    expect(tableSection?.text?.text).toContain('Yes'); // Jane has MFA
  });

  it('should include summary with MFA counts', () => {
    const message = formatAlertForSlack(sampleAlert, sampleAccounts);

    const context = message.attachments?.[0].blocks.find(
      (b) => b.type === 'context'
    );
    expect(context?.elements?.[0].text).toContain('🔴 1 without MFA');
    expect(context?.elements?.[0].text).toContain('🟢 1 with MFA');
  });

  it('should handle empty accounts array', () => {
    const message = formatAlertForSlack(sampleAlert, []);

    const noAccountsSection = message.attachments?.[0].blocks.find(
      (b) => b.text?.text?.includes('No accounts found')
    );
    expect(noAccountsSection).toBeDefined();
  });

  it('should not show title context if title equals name', () => {
    const alertSameTitle: AlertResult = {
      ...sampleAlert,
      title: 'MFA Not Enabled Alert',
    };
    const message = formatAlertForSlack(alertSameTitle, sampleAccounts);

    const context = message.blocks?.find(
      (b) => b.type === 'context' && b.elements?.[0].text?.includes('📋')
    );
    expect(context).toBeUndefined();
  });

  it('should chunk large account lists', () => {
    const manyAccounts: Account[] = Array.from({ length: 30 }, (_, i) => ({
      name: `User ${i}`,
      email: `user${i}@example.com`,
      mfaEnabled: false,
    }));

    const message = formatAlertForSlack(sampleAlert, manyAccounts);

    const codeBlocks = message.attachments?.[0].blocks.filter(
      (b) => b.text?.text?.includes('```')
    );
    expect(codeBlocks?.length).toBeGreaterThan(1);
  });
});
