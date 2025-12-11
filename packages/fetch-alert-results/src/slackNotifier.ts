/**
 * Slack Notifier Module
 *
 * Sends alert account information to Slack via Incoming Webhooks.
 */

import { execSync } from 'child_process';
import type { AlertResult, Account } from './alertFetcher.js';
import { formatAccount, getAccountMfaStatus } from './alertFetcher.js';

export interface SlackConfig {
  webhookUrl: string;
}

export interface SlackMessage {
  text?: string;
  blocks?: SlackBlock[];
  attachments?: SlackAttachment[];
}

export interface SlackBlock {
  type: string;
  text?: { type: string; text: string; emoji?: boolean };
  fields?: Array<{ type: string; text: string }>;
  elements?: Array<{ type: string; text: string }>;
}

export interface SlackAttachment {
  color: string;
  blocks: SlackBlock[];
}

/**
 * Gets severity color for Slack attachment
 */
export function getSeverityColor(severity: string): string {
  const colors: Record<string, string> = {
    critical: '#E01E5A',
    high: '#E01E5A',
    medium: '#ECB22E',
    low: '#36C5F0',
    info: '#2EB67D',
  };
  return colors[severity.toLowerCase()] || '#808080';
}

/**
 * Gets severity emoji
 */
export function getSeverityEmoji(severity: string): string {
  const emojis: Record<string, string> = {
    critical: '🚨',
    high: '🔴',
    medium: '🟠',
    low: '🟡',
    info: '🔵',
  };
  return emojis[severity.toLowerCase()] || '⚪';
}

/**
 * Formats date for display
 */
export function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Sends a message to Slack via webhook
 */
export function sendSlackMessage(config: SlackConfig, message: SlackMessage): void {
  const payload = JSON.stringify(message);
  const curlCmd = `curl -s -X POST '${config.webhookUrl}' -H 'Content-Type: application/json' -d '${payload.replace(/'/g, "'\\''")}'`;
  execSync(curlCmd, { encoding: 'utf-8' });
}

/**
 * Formats alert and accounts into Slack blocks
 */
export function formatAlertForSlack(alert: AlertResult, accounts: Account[]): SlackMessage {
  const severityEmoji = getSeverityEmoji(alert.severity);
  const severityColor = getSeverityColor(alert.severity);
  const formattedDate = formatDate(alert.created);

  // Count MFA status
  const mfaDisabled = accounts.filter((a) => getAccountMfaStatus(a) === 'No').length;
  const mfaEnabled = accounts.filter((a) => getAccountMfaStatus(a) === 'Yes').length;
  const mfaUnknown = accounts.filter((a) => getAccountMfaStatus(a) === 'N/A').length;

  const headerBlocks: SlackBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${severityEmoji} ${alert.name}`, emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Severity*\n${alert.severity}` },
        { type: 'mrkdwn', text: `*Created*\n${formattedDate}` },
        { type: 'mrkdwn', text: `*Total Accounts*\n${accounts.length}` },
        { type: 'mrkdwn', text: `*MFA Disabled*\n${mfaDisabled}` },
      ],
    },
  ];

  if (alert.title && alert.title !== alert.name) {
    headerBlocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `📋 ${alert.title}` }],
    });
  }

  const attachmentBlocks: SlackBlock[] = [];

  if (accounts.length > 0) {
    attachmentBlocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*Affected Accounts:*' },
    });

    // Format accounts as a clean table with consistent column widths
    const nameWidth = 26;
    const emailWidth = 32;
    const mfaWidth = 5;

    // Each cell has: │ + space + content + space, so border width = content width + 2
    const nameBorder = nameWidth + 2;
    const emailBorder = emailWidth + 2;
    const mfaBorder = mfaWidth + 2;

    const header = '┌' + '─'.repeat(nameBorder) + '┬' + '─'.repeat(emailBorder) + '┬─────┐';
    const headerRow = '│ ' + 'Name'.padEnd(nameWidth) + ' │ ' + 'Email'.padEnd(emailWidth) + ' │ MFA │';
    const separator = '├' + '─'.repeat(nameBorder) + '┼' + '─'.repeat(emailBorder) + '┼─────┤';
    const footer = '└' + '─'.repeat(nameBorder) + '┴' + '─'.repeat(emailBorder) + '┴─────┘';

    const accountLines = accounts.map((account) => {
      const formatted = formatAccount(account);
      const mfaText = formatted.mfaEnabled === 'Yes' ? 'Yes' : formatted.mfaEnabled === 'No' ? 'No' : '-';
      return '│ ' + formatted.name.substring(0, nameWidth).padEnd(nameWidth) + ' │ ' + formatted.email.substring(0, emailWidth).padEnd(emailWidth) + ' │ ' + mfaText.padEnd(3) + ' │';
    });

    // Slack has a 3000 char limit per block, so chunk if needed
    const chunkSize = 15;
    for (let i = 0; i < accountLines.length; i += chunkSize) {
      const chunk = accountLines.slice(i, i + chunkSize);
      const isFirst = i === 0;
      const isLast = i + chunkSize >= accountLines.length;

      let tableContent = '';
      if (isFirst) {
        tableContent = header + '\n' + headerRow + '\n' + separator + '\n';
      }
      tableContent += chunk.join('\n');
      if (isLast) {
        tableContent += '\n' + footer;
      }

      attachmentBlocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '```' + tableContent + '```' },
      });
    }

    // Summary
    const summaryParts: string[] = [];
    if (mfaDisabled > 0) summaryParts.push(`🔴 ${mfaDisabled} without MFA`);
    if (mfaEnabled > 0) summaryParts.push(`🟢 ${mfaEnabled} with MFA`);
    if (mfaUnknown > 0) summaryParts.push(`⚪ ${mfaUnknown} unknown`);

    attachmentBlocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: summaryParts.join('  •  ') }],
    });
  } else {
    attachmentBlocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_No accounts found in alert body._' },
    });
  }

  return {
    blocks: headerBlocks,
    attachments: [{ color: severityColor, blocks: attachmentBlocks }],
  };
}

/**
 * Sends alert results to Slack
 */
export function sendAlertToSlack(
  config: SlackConfig,
  alert: AlertResult,
  accounts: Account[]
): void {
  const message = formatAlertForSlack(alert, accounts);
  sendSlackMessage(config, message);
}
