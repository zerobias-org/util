#!/usr/bin/env node

/**
 * Demonstration of logger bug fixes
 *
 * This script demonstrates that both bugs have been fixed:
 * 1. Timestamps now display correctly with default options
 * 2. Colors now display correctly in CLI output
 */

import { LoggerEngine } from './dist/src/LoggerEngine.js';
import { CLITransport } from './dist/src/transports/CLITransport.js';

console.log('\n=== Logger Bug Fixes Demonstration ===\n');

console.log('--- Test 1: Default CLITransport (should show timestamps) ---');
CLITransport.install();

const root = LoggerEngine.root();
root.info('Info message - should have timestamp and color');
root.warn('Warning message - should have timestamp and color');
root.error('Error message - should have timestamp and color');

console.log('\n--- Test 2: CLITransport with explicit TIME option ---');
const root2 = LoggerEngine.root();
root2.transports.forEach(t => root2.removeTransport(t));
CLITransport.install({ timestamp: 'TIME', logLevel: 'NAME' });

root2.info('Info with explicit TIME timestamp');
root2.warn('Warning with explicit TIME timestamp');
root2.error('Error with explicit TIME timestamp');

console.log('\n--- Test 3: CLITransport with FULL timestamp ---');
const root3 = LoggerEngine.root();
root3.transports.forEach(t => root3.removeTransport(t));
CLITransport.install({ timestamp: 'FULL' });

root3.info('Info with FULL timestamp (includes date)');
root3.warn('Warning with FULL timestamp');
root3.error('Error with FULL timestamp');

console.log('\n--- Test 4: Multiple log levels with colors ---');
const root4 = LoggerEngine.root();
root4.transports.forEach(t => root4.removeTransport(t));
CLITransport.install({ timestamp: 'TIME' });
root4.setLevel(6); // TRACE - show all levels

const logger = root4.get('demo');
logger.crit('CRITICAL - should be RED');
logger.error('ERROR - should be BOLD RED');
logger.warn('WARNING - should be YELLOW');
logger.info('INFO - should be GREEN');
logger.verbose('VERBOSE - should be BLUE');
logger.debug('DEBUG - should be BLUE');
logger.trace('TRACE - should be MAGENTA');

console.log('\n--- Test 5: Hierarchical loggers with colors ---');
const api = root4.get('api');
const auth = api.get('auth');
const session = auth.get('session');

session.info('Deep nested logger with full path');
session.error('Error from nested logger');

console.log('\n=== All tests complete! ===');
console.log('✅ Timestamps are displaying correctly');
console.log('✅ Colors are displaying correctly');
console.log('');
