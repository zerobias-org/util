/**
 * Fetch Alert Results
 *
 * Fetches alert results for specific alert IDs and displays
 * account information (name, email, mfaEnabled).
 */

import 'dotenv/config';
import { fetchAlert, extractAccounts, formatAccount } from './alertFetcher.js';
import { sendAlertToSlack } from './slackNotifier.js';

async function main() {
  // Get configuration from environment
  const alertBotId = process.env.ALERT_BOT_ID;
  const boundaryId = process.env.BOUNDARY_ID;
  const alertIds = process.env.ALERT_IDS
    ? process.env.ALERT_IDS.split(',').map((id) => id.trim()).filter(Boolean)
    : [];
  const portalUrl = process.env.PORTAL_URL || 'https://app.zerobias.com/api/portal';
  const orgId = process.env.ORG_ID;
  const apiKey = process.env.API_KEY;
  const slackWebhookUrls = process.env.SLACK_WEBHOOK_URLS
    ? process.env.SLACK_WEBHOOK_URLS.split(',').map((url) => url.trim()).filter(Boolean)
    : [];

  if (!alertBotId) {
    console.error('Error: ALERT_BOT_ID is required in .env file');
    process.exit(1);
  }

  if (!boundaryId) {
    console.error('Error: BOUNDARY_ID is required in .env file');
    process.exit(1);
  }

  if (alertIds.length === 0) {
    console.error('Error: ALERT_IDS is required in .env file');
    process.exit(1);
  }

  if (!orgId) {
    console.error('Error: ORG_ID is required in .env file');
    process.exit(1);
  }

  if (!apiKey) {
    console.error('Error: API_KEY is required in .env file');
    process.exit(1);
  }

  console.log('Fetching alert results...');
  console.log(`Alert Bot ID: ${alertBotId}`);
  console.log(`Boundary ID: ${boundaryId}`);
  console.log(`Alert IDs: ${alertIds.length}`);
  console.log('');

  for (const alertId of alertIds) {
    console.log('═'.repeat(80));
    console.log(`Processing Alert: ${alertId}`);
    console.log('═'.repeat(80));

    try {
      // Fetch the alert
      const alert = fetchAlert({
        portalUrl,
        boundaryId,
        alertId,
        apiKey,
        orgId,
      });

      console.log('Alert Details:');
      console.log(`  Name: ${alert.name}`);
      console.log(`  Title: ${alert.title || 'N/A'}`);
      console.log(`  Severity: ${alert.severity}`);
      console.log(`  Created: ${alert.created}`);
      console.log('');

      // Extract accounts from the alert body
      const accounts = extractAccounts(alert.body);

      // Also check elements if available
      if (alert.elements && alert.elements.length > 0) {
        console.log('Elements:');
        for (const element of alert.elements) {
          console.log(`  - ${element.name} (${element.code})`);
        }
        console.log('');
      }

      // Display accounts
      if (accounts.length > 0) {
        console.log('Accounts:');
        console.log('─'.repeat(80));
        console.log(
          'Name'.padEnd(30) +
          'Email'.padEnd(35) +
          'MFA Enabled'
        );
        console.log('─'.repeat(80));

        for (const account of accounts) {
          const formatted = formatAccount(account);
          console.log(
            formatted.name.padEnd(30) +
            formatted.email.padEnd(35) +
            formatted.mfaEnabled
          );
        }

        console.log('─'.repeat(80));
        console.log(`Total: ${accounts.length} accounts`);
      } else {
        console.log('No accounts found in alert body.');
        console.log('');
        console.log('Raw alert body:');
        console.log(JSON.stringify(alert.body, null, 2));
      }

      // Send to Slack if webhooks are configured
      if (slackWebhookUrls.length > 0) {
        console.log('');
        console.log(`Sending to ${slackWebhookUrls.length} Slack webhook(s)...`);
        for (const webhookUrl of slackWebhookUrls) {
          try {
            sendAlertToSlack({ webhookUrl }, alert, accounts);
            console.log(`  ✓ Sent to webhook: ${webhookUrl.substring(0, 50)}...`);
          } catch (err) {
            console.error(`  ✗ Failed to send to webhook: ${webhookUrl.substring(0, 50)}...`);
          }
        }
        console.log('Done sending to Slack.');
      }

    } catch (error) {
      console.error(`Error fetching alert ${alertId}:`, error);
    }

    console.log('');
  }

  console.log('All alerts processed.');
}

main();
