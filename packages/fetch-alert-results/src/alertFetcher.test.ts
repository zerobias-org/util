import { describe, it, expect } from 'vitest';
import {
  extractAccounts,
  getAccountEmail,
  getAccountName,
  getAccountMfaStatus,
  formatAccount,
  type Account,
} from './alertFetcher.js';

describe('extractAccounts', () => {
  it('should extract accounts from body.data.Account', () => {
    const body = {
      data: {
        Account: [
          { name: 'Test User', email: 'test@example.com', mfaEnabled: false },
          { name: 'Another User', email: 'another@example.com', mfaEnabled: true },
        ],
      },
    };

    const accounts = extractAccounts(body);

    expect(accounts).toHaveLength(2);
    expect(accounts[0].name).toBe('Test User');
    expect(accounts[1].name).toBe('Another User');
  });

  it('should return empty array if body is empty', () => {
    const accounts = extractAccounts({});
    expect(accounts).toHaveLength(0);
  });

  it('should return empty array if data.Account is missing', () => {
    const body = { data: { SomethingElse: [] } };
    const accounts = extractAccounts(body);
    expect(accounts).toHaveLength(0);
  });

  it('should return empty array if data is not an object', () => {
    const body = { data: 'string' };
    const accounts = extractAccounts(body as Record<string, unknown>);
    expect(accounts).toHaveLength(0);
  });
});

describe('getAccountEmail', () => {
  it('should return first email from array', () => {
    const account: Account = {
      email: ['first@example.com', 'second@example.com'],
    };
    expect(getAccountEmail(account)).toBe('first@example.com');
  });

  it('should return email string directly', () => {
    const account: Account = {
      email: 'direct@example.com',
    };
    expect(getAccountEmail(account)).toBe('direct@example.com');
  });

  it('should fall back to userPrincipalName', () => {
    const account: Account = {
      userPrincipalName: 'upn@example.com',
    };
    expect(getAccountEmail(account)).toBe('upn@example.com');
  });

  it('should fall back to mail', () => {
    const account: Account = {
      mail: 'mail@example.com',
    };
    expect(getAccountEmail(account)).toBe('mail@example.com');
  });

  it('should return N/A if no email found', () => {
    const account: Account = { name: 'No Email User' };
    expect(getAccountEmail(account)).toBe('N/A');
  });

  it('should return N/A for empty email array', () => {
    const account: Account = { email: [] };
    expect(getAccountEmail(account)).toBe('N/A');
  });
});

describe('getAccountName', () => {
  it('should return name property', () => {
    const account: Account = { name: 'Test User' };
    expect(getAccountName(account)).toBe('Test User');
  });

  it('should fall back to displayName', () => {
    const account: Account = { displayName: 'Display Name' };
    expect(getAccountName(account)).toBe('Display Name');
  });

  it('should fall back to username', () => {
    const account: Account = { username: 'username123' };
    expect(getAccountName(account)).toBe('username123');
  });

  it('should return N/A if no name found', () => {
    const account: Account = { email: 'test@example.com' };
    expect(getAccountName(account)).toBe('N/A');
  });

  it('should prefer name over displayName', () => {
    const account: Account = { name: 'Name', displayName: 'Display' };
    expect(getAccountName(account)).toBe('Name');
  });
});

describe('getAccountMfaStatus', () => {
  it('should return Yes when mfaEnabled is true', () => {
    const account: Account = { mfaEnabled: true };
    expect(getAccountMfaStatus(account)).toBe('Yes');
  });

  it('should return No when mfaEnabled is false', () => {
    const account: Account = { mfaEnabled: false };
    expect(getAccountMfaStatus(account)).toBe('No');
  });

  it('should fall back to isMfaRegistered', () => {
    const account: Account = { isMfaRegistered: true };
    expect(getAccountMfaStatus(account)).toBe('Yes');
  });

  it('should return N/A when no MFA status found', () => {
    const account: Account = { name: 'No MFA Info' };
    expect(getAccountMfaStatus(account)).toBe('N/A');
  });

  it('should prefer mfaEnabled over isMfaRegistered', () => {
    const account: Account = { mfaEnabled: false, isMfaRegistered: true };
    expect(getAccountMfaStatus(account)).toBe('No');
  });
});

describe('formatAccount', () => {
  it('should format account with all fields', () => {
    const account: Account = {
      name: 'Test User',
      email: 'test@example.com',
      mfaEnabled: false,
    };

    const formatted = formatAccount(account);

    expect(formatted.name).toBe('Test User');
    expect(formatted.email).toBe('test@example.com');
    expect(formatted.mfaEnabled).toBe('No');
  });

  it('should truncate long names to 28 characters', () => {
    const account: Account = {
      name: 'This is a very long name that exceeds the limit',
      email: 'test@example.com',
      mfaEnabled: true,
    };

    const formatted = formatAccount(account);

    expect(formatted.name).toHaveLength(28);
    expect(formatted.name).toBe('This is a very long name tha');
  });

  it('should truncate long emails to 33 characters', () => {
    const account: Account = {
      name: 'Test',
      email: 'this.is.a.very.long.email.address@example.com',
      mfaEnabled: true,
    };

    const formatted = formatAccount(account);

    expect(formatted.email).toHaveLength(33);
  });

  it('should handle account with email array', () => {
    const account: Account = {
      name: 'Array Email User',
      email: ['first@example.com', 'second@example.com'],
      mfaEnabled: false,
    };

    const formatted = formatAccount(account);

    expect(formatted.email).toBe('first@example.com');
  });
});

describe('integration: real alert data structure', () => {
  // Sample data from actual API response
  const sampleAlertBody = {
    data: {
      Account: [
        {
          id: '01f8d782-404f-42b9-89c5-4324173e19a5',
          name: 'Artisan Online',
          email: ['online@artisan179.com', 'online@lakefrontgrille.com'],
          mfaEnabled: false,
        },
        {
          id: '0254d372-3b02-4747-95d3-f73c5305fd7d',
          name: 'Caspian_adm',
          email: [],
          mfaEnabled: false,
        },
        {
          id: '19f62b97-6026-4bf4-80bc-f4b941ce634b',
          name: 'Chris Roberts',
          email: ['croberts@caspiantek.com', 'croberts@thinkcaspian.com'],
          mfaEnabled: false,
        },
      ],
    },
    rawData: {},
    gqlCount: { Account: 3 },
  };

  it('should extract all accounts from sample data', () => {
    const accounts = extractAccounts(sampleAlertBody);
    expect(accounts).toHaveLength(3);
  });

  it('should correctly format Artisan Online account', () => {
    const accounts = extractAccounts(sampleAlertBody);
    const formatted = formatAccount(accounts[0]);

    expect(formatted.name).toBe('Artisan Online');
    expect(formatted.email).toBe('online@artisan179.com');
    expect(formatted.mfaEnabled).toBe('No');
  });

  it('should handle account with empty email array', () => {
    const accounts = extractAccounts(sampleAlertBody);
    const formatted = formatAccount(accounts[1]);

    expect(formatted.name).toBe('Caspian_adm');
    expect(formatted.email).toBe('N/A');
    expect(formatted.mfaEnabled).toBe('No');
  });

  it('should use first email from array for Chris Roberts', () => {
    const accounts = extractAccounts(sampleAlertBody);
    const formatted = formatAccount(accounts[2]);

    expect(formatted.name).toBe('Chris Roberts');
    expect(formatted.email).toBe('croberts@caspiantek.com');
    expect(formatted.mfaEnabled).toBe('No');
  });
});
