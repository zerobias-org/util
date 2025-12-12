import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import {
  loadAlertState,
  saveAlertState,
  isAlertSent,
  markAlertSent,
  getNewAlertIds,
  cleanupOldAlerts,
} from './alertStateTracker.js';

const TEST_STATE_FILE = join(import.meta.dirname, '..', '.test-alert-state.json');

describe('alertStateTracker', () => {
  beforeEach(() => {
    // Clean up test state file before each test
    if (existsSync(TEST_STATE_FILE)) {
      unlinkSync(TEST_STATE_FILE);
    }
  });

  afterEach(() => {
    // Clean up test state file after each test
    if (existsSync(TEST_STATE_FILE)) {
      unlinkSync(TEST_STATE_FILE);
    }
  });

  describe('loadAlertState', () => {
    it('should return empty state when file does not exist', () => {
      const state = loadAlertState(TEST_STATE_FILE);
      expect(state.sentAlertIds).toEqual([]);
      expect(state.lastChecked).toBeNull();
    });

    it('should load state from file', () => {
      const testState = { sentAlertIds: ['alert-1', 'alert-2'], lastChecked: '2024-01-01T00:00:00Z' };
      saveAlertState(testState, TEST_STATE_FILE);

      const loaded = loadAlertState(TEST_STATE_FILE);
      expect(loaded.sentAlertIds).toEqual(['alert-1', 'alert-2']);
      expect(loaded.lastChecked).toBe('2024-01-01T00:00:00Z');
    });
  });

  describe('saveAlertState', () => {
    it('should save state to file', () => {
      const state = { sentAlertIds: ['alert-1'], lastChecked: '2024-01-01T00:00:00Z' };
      saveAlertState(state, TEST_STATE_FILE);

      expect(existsSync(TEST_STATE_FILE)).toBe(true);
      const loaded = loadAlertState(TEST_STATE_FILE);
      expect(loaded).toEqual(state);
    });
  });

  describe('isAlertSent', () => {
    it('should return true if alert is in sentAlertIds', () => {
      const state = { sentAlertIds: ['alert-1', 'alert-2'], lastChecked: null };
      expect(isAlertSent('alert-1', state)).toBe(true);
    });

    it('should return false if alert is not in sentAlertIds', () => {
      const state = { sentAlertIds: ['alert-1'], lastChecked: null };
      expect(isAlertSent('alert-2', state)).toBe(false);
    });
  });

  describe('markAlertSent', () => {
    it('should add alert to sentAlertIds', () => {
      let state = { sentAlertIds: [], lastChecked: null };
      state = markAlertSent('alert-1', state);

      expect(state.sentAlertIds).toContain('alert-1');
      expect(state.lastChecked).not.toBeNull();
    });

    it('should not add duplicate alerts', () => {
      let state = { sentAlertIds: ['alert-1'], lastChecked: null };
      state = markAlertSent('alert-1', state);

      expect(state.sentAlertIds).toEqual(['alert-1']);
    });
  });

  describe('getNewAlertIds', () => {
    it('should return alerts not in state', () => {
      const state = { sentAlertIds: ['alert-1'], lastChecked: null };
      const allAlerts = ['alert-1', 'alert-2', 'alert-3'];

      const newAlerts = getNewAlertIds(allAlerts, state);
      expect(newAlerts).toEqual(['alert-2', 'alert-3']);
    });

    it('should return empty array if all alerts are sent', () => {
      const state = { sentAlertIds: ['alert-1', 'alert-2'], lastChecked: null };
      const allAlerts = ['alert-1', 'alert-2'];

      const newAlerts = getNewAlertIds(allAlerts, state);
      expect(newAlerts).toEqual([]);
    });

    it('should return all alerts if none are sent', () => {
      const state = { sentAlertIds: [], lastChecked: null };
      const allAlerts = ['alert-1', 'alert-2'];

      const newAlerts = getNewAlertIds(allAlerts, state);
      expect(newAlerts).toEqual(['alert-1', 'alert-2']);
    });
  });

  describe('cleanupOldAlerts', () => {
    it('should keep only maxAlerts most recent alerts', () => {
      const alertIds = Array.from({ length: 20 }, (_, i) => `alert-${i}`);
      let state = { sentAlertIds: alertIds, lastChecked: null };

      state = cleanupOldAlerts(state, 10);
      expect(state.sentAlertIds.length).toBe(10);
      expect(state.sentAlertIds[0]).toBe('alert-10');
      expect(state.sentAlertIds[9]).toBe('alert-19');
    });

    it('should not modify state if under maxAlerts', () => {
      const state = { sentAlertIds: ['alert-1', 'alert-2'], lastChecked: null };
      const cleaned = cleanupOldAlerts(state, 10);

      expect(cleaned.sentAlertIds).toEqual(['alert-1', 'alert-2']);
    });
  });
});
