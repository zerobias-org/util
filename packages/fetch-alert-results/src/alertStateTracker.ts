/**
 * Alert State Tracker
 *
 * Tracks which alerts have been sent to avoid duplicate notifications.
 * Uses a JSON file to persist state between runs.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATE_FILE = join(__dirname, '..', '.alert-state.json');

export interface AlertState {
  sentAlertIds: string[];
  lastChecked: string | null;
}

/**
 * Loads the alert state from the state file
 */
export function loadAlertState(stateFile: string = DEFAULT_STATE_FILE): AlertState {
  if (existsSync(stateFile)) {
    try {
      const data = readFileSync(stateFile, 'utf-8');
      return JSON.parse(data) as AlertState;
    } catch {
      return { sentAlertIds: [], lastChecked: null };
    }
  }
  return { sentAlertIds: [], lastChecked: null };
}

/**
 * Saves the alert state to the state file
 */
export function saveAlertState(state: AlertState, stateFile: string = DEFAULT_STATE_FILE): void {
  writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Checks if an alert has already been sent
 */
export function isAlertSent(alertId: string, state: AlertState): boolean {
  return state.sentAlertIds.includes(alertId);
}

/**
 * Marks an alert as sent
 */
export function markAlertSent(alertId: string, state: AlertState): AlertState {
  if (!state.sentAlertIds.includes(alertId)) {
    state.sentAlertIds.push(alertId);
  }
  state.lastChecked = new Date().toISOString();
  return state;
}

/**
 * Gets new alert IDs that haven't been sent yet
 */
export function getNewAlertIds(alertIds: string[], state: AlertState): string[] {
  return alertIds.filter((id) => !isAlertSent(id, state));
}

/**
 * Cleans up old alert IDs to prevent the state file from growing indefinitely
 * Keeps only the most recent N alert IDs
 */
export function cleanupOldAlerts(state: AlertState, maxAlerts: number = 1000): AlertState {
  if (state.sentAlertIds.length > maxAlerts) {
    state.sentAlertIds = state.sentAlertIds.slice(-maxAlerts);
  }
  return state;
}
