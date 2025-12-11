/**
 * Alert Fetcher Module
 *
 * Core logic for fetching and parsing alert results.
 */

import { execSync } from 'child_process';

export interface Account {
  name?: string;
  displayName?: string;
  username?: string;
  email?: string | string[];
  userPrincipalName?: string;
  mail?: string;
  mfaEnabled?: boolean;
  isMfaRegistered?: boolean;
  [key: string]: unknown;
}

export interface AlertResult {
  id: string;
  name: string;
  title?: string;
  severity: string;
  created: string;
  body: Record<string, unknown>;
  elements?: Array<{ name: string; code: string }>;
}

export interface FetchConfig {
  portalUrl: string;
  boundaryId: string;
  alertId: string;
  apiKey: string;
  orgId: string;
}

/**
 * Fetches an alert from the portal API using curl
 */
export function fetchAlert(config: FetchConfig): AlertResult {
  const { portalUrl, boundaryId, alertId, apiKey, orgId } = config;
  const url = `${portalUrl}/boundaries/${boundaryId}/alerts/${alertId}`;
  const curlCmd = `curl -s '${url}' --header 'Accept: */*' --header 'Authorization: APIKey ${apiKey}' --header 'dana-org-id: ${orgId}'`;
  const result = execSync(curlCmd, { encoding: 'utf-8' });
  return JSON.parse(result) as AlertResult;
}

/**
 * Extracts accounts from the alert body
 * The body structure is: body.data.Account[]
 */
export function extractAccounts(body: Record<string, unknown>): Account[] {
  const accounts: Account[] = [];

  if (body && body.data) {
    const data = body.data as Record<string, unknown>;
    if (Array.isArray(data.Account)) {
      accounts.push(...data.Account);
    }
  }

  return accounts;
}

/**
 * Gets the email value from an account
 * Email can be an array or string
 */
export function getAccountEmail(account: Account): string {
  if (Array.isArray(account.email) && account.email.length > 0) {
    return account.email[0];
  } else if (typeof account.email === 'string') {
    return account.email;
  } else if (account.userPrincipalName) {
    return String(account.userPrincipalName);
  } else if (account.mail) {
    return String(account.mail);
  }
  return 'N/A';
}

/**
 * Gets the name value from an account
 */
export function getAccountName(account: Account): string {
  return String(account.name || account.displayName || account.username || 'N/A');
}

/**
 * Gets the MFA status from an account
 */
export function getAccountMfaStatus(account: Account): 'Yes' | 'No' | 'N/A' {
  if (account.mfaEnabled !== undefined) {
    return account.mfaEnabled ? 'Yes' : 'No';
  }
  if (account.isMfaRegistered !== undefined) {
    return account.isMfaRegistered ? 'Yes' : 'No';
  }
  return 'N/A';
}

/**
 * Formats an account for display
 */
export function formatAccount(account: Account): { name: string; email: string; mfaEnabled: string } {
  return {
    name: getAccountName(account).substring(0, 28),
    email: getAccountEmail(account).substring(0, 33),
    mfaEnabled: getAccountMfaStatus(account),
  };
}
