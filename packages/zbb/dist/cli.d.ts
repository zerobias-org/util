/**
 * zbb CLI — command router
 *
 * Routes:
 *   zbb slot <create|load|list|info|delete|gc>  → slot management
 *   zbb env <list|get|set|unset|reset|diff>      → env var commands
 *   zbb logs <list|show>                          → log viewer
 *   zbb up|down|destroy|info                      → stack aliases → gradle
 *   zbb --version | --help                        → meta
 *   zbb <anything else>                           → gradle wrapper
 */
export declare function main(argv: string[]): Promise<void>;
