/**
 * Alert Scheduler
 *
 * Runs on a schedule to check for new alerts and send notifications to Slack.
 * Uses node-cron for scheduling and a state file to track sent alerts.
 */

import 'dotenv/config';
import cron from 'node-cron';
import { fetchAlerts, fetchAlert, extractAccounts } from './alertFetcher.js';
import { sendAlertToSlack } from './slackNotifier.js';
import {
  loadAlertState,
  saveAlertState,
  getNewAlertIds,
  markAlertSent,
  cleanupOldAlerts,
} from './alertStateTracker.js';

// Default schedule: every day at 9:00 AM
const DEFAULT_CRON_SCHEDULE = '0 9 * * *';

interface SchedulerConfig {
  boundaryId: string;
  portalUrl: string;
  orgId: string;
  apiKey: string;
  slackWebhookUrls: string[];
  cronSchedule: string;
}

function getConfig(): SchedulerConfig {
  const boundaryId = process.env.BOUNDARY_ID;
  const portalUrl = process.env.PORTAL_URL || 'https://app.zerobias.com/api/portal';
  const orgId = process.env.ORG_ID;
  const apiKey = process.env.API_KEY;
  const slackWebhookUrls = process.env.SLACK_WEBHOOK_URLS
    ? process.env.SLACK_WEBHOOK_URLS.split(',').map((url) => url.trim()).filter(Boolean)
    : [];
  const cronSchedule = process.env.CRON_SCHEDULE || DEFAULT_CRON_SCHEDULE;

  if (!boundaryId) {
    throw new Error('BOUNDARY_ID is required in .env file');
  }
  if (!orgId) {
    throw new Error('ORG_ID is required in .env file');
  }
  if (!apiKey) {
    throw new Error('API_KEY is required in .env file');
  }
  if (slackWebhookUrls.length === 0) {
    throw new Error('SLACK_WEBHOOK_URLS is required in .env file for scheduler');
  }

  return { boundaryId, portalUrl, orgId, apiKey, slackWebhookUrls, cronSchedule };
}

async function checkAndNotifyNewAlerts(config: SchedulerConfig): Promise<void> {
  console.log(`[${new Date().toISOString()}] Checking for new alerts...`);

  try {
    // Load current state
    let state = loadAlertState();

    // Fetch all alerts for the boundary
    const alerts = fetchAlerts({
      portalUrl: config.portalUrl,
      boundaryId: config.boundaryId,
      apiKey: config.apiKey,
      orgId: config.orgId,
    });

    console.log(`Found ${alerts.length} total alerts`);

    // Get alert IDs that haven't been sent yet
    const alertIds = alerts.map((a) => a.id);
    const newAlertIds = getNewAlertIds(alertIds, state);

    if (newAlertIds.length === 0) {
      console.log('No new alerts to send');
      state.lastChecked = new Date().toISOString();
      saveAlertState(state);
      return;
    }

    console.log(`Found ${newAlertIds.length} new alert(s) to send`);

    // Process each new alert
    for (const alertId of newAlertIds) {
      try {
        console.log(`Processing alert: ${alertId}`);

        // Fetch full alert details
        const alert = fetchAlert({
          portalUrl: config.portalUrl,
          boundaryId: config.boundaryId,
          alertId,
          apiKey: config.apiKey,
          orgId: config.orgId,
        });

        // Extract accounts
        const accounts = extractAccounts(alert.body);

        // Send to all Slack webhooks
        for (const webhookUrl of config.slackWebhookUrls) {
          try {
            sendAlertToSlack({ webhookUrl }, alert, accounts);
            console.log(`  ✓ Sent to webhook: ${webhookUrl.substring(0, 50)}...`);
          } catch (err) {
            console.error(`  ✗ Failed to send to webhook: ${webhookUrl.substring(0, 50)}...`, err);
          }
        }

        // Mark alert as sent
        state = markAlertSent(alertId, state);
      } catch (err) {
        console.error(`Error processing alert ${alertId}:`, err);
      }
    }

    // Cleanup old alerts and save state
    state = cleanupOldAlerts(state);
    saveAlertState(state);

    console.log(`Done. Sent ${newAlertIds.length} new alert(s)`);
  } catch (err) {
    console.error('Error checking for new alerts:', err);
  }
}

async function main(): Promise<void> {
  console.log('Alert Scheduler Starting...');

  const config = getConfig();

  console.log(`Boundary ID: ${config.boundaryId}`);
  console.log(`Slack Webhooks: ${config.slackWebhookUrls.length}`);
  console.log(`Schedule: ${config.cronSchedule}`);
  console.log('');

  // Validate cron schedule
  if (!cron.validate(config.cronSchedule)) {
    throw new Error(`Invalid cron schedule: ${config.cronSchedule}`);
  }

  // Run immediately on startup
  console.log('Running initial check...');
  await checkAndNotifyNewAlerts(config);

  // Schedule recurring checks
  console.log(`\nScheduler running. Next check according to: ${config.cronSchedule}`);
  console.log('Press Ctrl+C to stop.\n');

  cron.schedule(config.cronSchedule, () => {
    checkAndNotifyNewAlerts(config);
  });
}

main().catch((err) => {
  console.error('Scheduler failed to start:', err);
  process.exit(1);
});
