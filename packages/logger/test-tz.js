import { LoggerEngine, ConsoleTransport, TransportType } from './dist/src/index.js';

const root = LoggerEngine.root();
root.removeTransport(TransportType.CONSOLE);

console.log('\n=== FULL mode with different timezones ===\n');

// GMT
let transport = new ConsoleTransport({ timestamp: 'FULL', timezone: 'GMT' });
root.addTransport(transport);
root.info('FULL timestamp in GMT');

// New York
root.removeTransport(TransportType.CONSOLE);
transport = new ConsoleTransport({ timestamp: 'FULL', timezone: 'America/New_York' });
root.addTransport(transport);
root.info('FULL timestamp in America/New_York');

// Tokyo
root.removeTransport(TransportType.CONSOLE);
transport = new ConsoleTransport({ timestamp: 'FULL', timezone: 'Asia/Tokyo' });
root.addTransport(transport);
root.info('FULL timestamp in Asia/Tokyo');

console.log('\n=== TIME mode with different timezones ===\n');

// GMT
root.removeTransport(TransportType.CONSOLE);
transport = new ConsoleTransport({ timestamp: 'TIME', timezone: 'GMT' });
root.addTransport(transport);
root.info('TIME timestamp in GMT');

// New York
root.removeTransport(TransportType.CONSOLE);
transport = new ConsoleTransport({ timestamp: 'TIME', timezone: 'America/New_York' });
root.addTransport(transport);
root.info('TIME timestamp in America/New_York');

console.log('\n=== Runtime reconfiguration ===\n');

root.removeTransport(TransportType.CONSOLE);
transport = new ConsoleTransport({ timestamp: 'FULL', timezone: 'GMT' });
root.addTransport(transport);
root.info('Started with FULL in GMT');

transport.apply({ timezone: 'Europe/London' });
root.info('Changed to Europe/London');

transport.apply({ timestamp: 'TIME' });
root.info('Changed to TIME mode');

console.log('\n');
