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
import { SlotManager } from './slot/SlotManager.js';
import { runPreflightChecks, formatPreflightResults } from './preflight.js';
import { resolveStackAlias, runGradle } from './gradle.js';
import { findRepoRoot, loadRepoConfig, loadUserConfig, } from './config.js';
import { spawn } from 'node:child_process';
/**
 * Extend slot from cwd context: walk up to find repo root (.zbb.yaml/gradlew),
 * scan zbb.yaml declarations, add missing vars to slot, re-export to process.env.
 * Shared by: slot load, zbb up/down/destroy, zbb dataloader.
 * Returns the repo root path, or null if no project context found.
 */
async function extendSlotFromCwd(slot) {
    const repoRoot = findRepoRoot(process.cwd());
    if (!repoRoot)
        return null;
    const { extendSlot } = await import('./slot/extend.js');
    const result = await extendSlot(slot, repoRoot);
    if (result.extended) {
        console.log(`Extended slot with ${result.addedVars.length} new var(s): ${result.addedVars.join(', ')}`);
        const newEnv = slot.env.getAll();
        for (const varName of result.addedVars) {
            if (newEnv[varName])
                process.env[varName] = newEnv[varName];
        }
    }
    return repoRoot;
}
export async function main(argv) {
    let args = argv.slice(2);
    // Global --slot flag: load slot env before running any command
    // Usage: zbb --slot local build, zbb --slot local testDocker
    const slotIdx = args.indexOf('--slot');
    if (slotIdx !== -1 && args[slotIdx + 1]) {
        const slotName = args[slotIdx + 1];
        args = [...args.slice(0, slotIdx), ...args.slice(slotIdx + 2)];
        // Load slot env into process.env
        const slot = await SlotManager.load(slotName);
        process.env.ZB_SLOT = slotName;
        const slotEnv = slot.env.getAll();
        for (const [k, v] of Object.entries(slotEnv)) {
            if (v)
                process.env[k] = v;
        }
        // Set JAVA_HOME if not already correct
        if (!process.env.JAVA_HOME || !process.env.JAVA_HOME.includes('21')) {
            const java21Home = '/usr/lib/jvm/java-21-openjdk-amd64';
            const { existsSync } = await import('node:fs');
            if (existsSync(`${java21Home}/bin/java`)) {
                process.env.JAVA_HOME = java21Home;
                process.env.PATH = `${java21Home}/bin:${process.env.PATH ?? ''}`;
            }
        }
        // Extend from cwd context
        await extendSlotFromCwd(slot);
    }
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        printUsage();
        return;
    }
    if (args[0] === '--version') {
        const { readFileSync } = await import('node:fs');
        const { join, dirname } = await import('node:path');
        const { fileURLToPath } = await import('node:url');
        const dir = dirname(fileURLToPath(import.meta.url));
        const pkg = JSON.parse(readFileSync(join(dir, '..', 'package.json'), 'utf-8'));
        console.log(`zbb ${pkg.version}`);
        return;
    }
    const command = args[0];
    // Slot subcommands
    if (command === 'slot')
        return handleSlot(args.slice(1));
    // Secret subcommands
    if (command === 'secret')
        return handleSecretCmd(args.slice(1));
    // Env subcommands
    if (command === 'env')
        return handleEnv(args.slice(1));
    // Log subcommands
    if (command === 'logs')
        return handleLogs(args.slice(1));
    // Dataloader — spawn platform dataloader with slot PG env injection
    if (command === 'dataloader') {
        const { handleDataloader } = await import('./dataloader.js');
        return handleDataloader(args.slice(1));
    }
    // Destroy — slot-level: tear down ALL containers for this slot
    if (command === 'destroy') {
        const slotName = args[1] ?? process.env.ZB_SLOT;
        if (!slotName) {
            console.error('Usage: zbb destroy [slot-name]  (or run from inside a slot)');
            process.exit(1);
        }
        const slot = await SlotManager.load(slotName);
        const stackName = slot.env.get('STACK_NAME') ?? slotName;
        const { execSync } = await import('node:child_process');
        console.log(`Destroying all containers for stack: ${stackName}`);
        try {
            // Stop and remove all containers with the stack name prefix
            const containers = execSync(`docker ps -a --filter "name=${stackName}-" --format "{{.Names}}"`, { encoding: 'utf-8' }).trim();
            if (containers) {
                const names = containers.split('\n').filter(Boolean);
                console.log(`  Stopping ${names.length} container(s): ${names.join(', ')}`);
                execSync(`docker stop ${names.join(' ')}`, { stdio: 'inherit' });
                execSync(`docker rm ${names.join(' ')}`, { stdio: 'inherit' });
            }
            else {
                console.log('  No containers found');
            }
            // Remove volumes with stack name prefix
            const volumes = execSync(`docker volume ls --filter "name=${stackName}_" --format "{{.Name}}"`, { encoding: 'utf-8' }).trim();
            if (volumes) {
                const volNames = volumes.split('\n').filter(Boolean);
                console.log(`  Removing ${volNames.length} volume(s): ${volNames.join(', ')}`);
                execSync(`docker volume rm ${volNames.join(' ')}`, { stdio: 'inherit' });
            }
            // Remove networks with stack name prefix
            const networks = execSync(`docker network ls --filter "name=${stackName}_" --format "{{.Name}}"`, { encoding: 'utf-8' }).trim();
            if (networks) {
                const netNames = networks.split('\n').filter(Boolean);
                for (const net of netNames) {
                    try {
                        execSync(`docker network rm ${net}`, { stdio: 'inherit' });
                    }
                    catch { /* network may still be in use briefly */ }
                }
            }
            console.log(`✓ Stack destroyed: ${stackName}`);
        }
        catch (error) {
            console.error(`Failed to destroy stack: ${error.message}`);
            process.exit(1);
        }
        return;
    }
    // Publish — special handling for --dry-run flag conversion
    // Converts --dry-run to -PdryRun=true (Gradle property, not Gradle --dry-run flag)
    if (command === 'publish') {
        const publishArgs = args.slice(1).map(arg => arg === '--dry-run' ? '-PdryRun=true' : arg);
        if (process.env.ZB_SLOT) {
            const slot = await SlotManager.load(process.env.ZB_SLOT);
            await extendSlotFromCwd(slot);
        }
        runGradle(['publish', ...publishArgs]);
        return;
    }
    // Stack aliases → gradle
    const alias = resolveStackAlias(command);
    if (alias) {
        if (process.env.ZB_SLOT) {
            const slot = await SlotManager.load(process.env.ZB_SLOT);
            await extendSlotFromCwd(slot);
        }
        runGradle([alias, ...args.slice(1)]);
        return;
    }
    // Everything else → gradle
    runGradle(args);
}
// ── Slot Commands ────────────────────────────────────────────────────
async function handleSlot(args) {
    const sub = args[0];
    switch (sub) {
        case 'create': {
            const name = args.find(a => !a.startsWith('-')) !== args[0] ? '' : args[1] ?? '';
            const ephemeral = args.includes('--ephemeral');
            const ttlIdx = args.indexOf('--ttl');
            const ttl = ttlIdx !== -1 ? parseTtl(args[ttlIdx + 1]) : undefined;
            // Find the slot name — it's the positional arg after 'create' that isn't a flag
            let slotName = '';
            for (let i = 1; i < args.length; i++) {
                if (args[i].startsWith('--')) {
                    if (args[i] === '--ttl')
                        i++; // skip ttl value
                    continue;
                }
                slotName = args[i];
                break;
            }
            const slot = await SlotManager.create(slotName, { ephemeral, ttl });
            const envCount = slot.env.list().length;
            const portCount = Object.values(slot.env.getManifest())
                .filter(m => m.type === 'port').length;
            const secretCount = Object.values(slot.env.getManifest())
                .filter(m => m.type === 'secret').length;
            console.log(`Slot '${slot.name}' created.`);
            console.log(`  ${envCount} env vars (${portCount} ports, ${secretCount} secrets)`);
            console.log(`  ${slot.path}`);
            if (slot.isEphemeral()) {
                console.log(`  Ephemeral, expires: ${slot.meta.expires}`);
            }
            console.log(`\nLoad with: zbb slot load ${slot.name}`);
            break;
        }
        case 'load': {
            let slotName = args[1];
            const isReload = !slotName && !!process.env.ZB_SLOT;
            if (!slotName) {
                slotName = process.env.ZB_SLOT ?? '';
                if (!slotName) {
                    console.error('Not inside a slot. Usage: zbb slot load <name>');
                    process.exit(1);
                }
            }
            // GC expired ephemeral slots first
            const deleted = await SlotManager.gc();
            if (deleted.length > 0) {
                console.log(`GC: removed ${deleted.length} expired slot(s): ${deleted.join(', ')}`);
            }
            const slot = await SlotManager.load(slotName);
            // Extend slot from cwd context (walk up to nearest zbb.yaml)
            const repoRoot = await extendSlotFromCwd(slot);
            if (!repoRoot) {
                if (isReload) {
                    // No-args reload requires project context
                    console.error('No zbb.yaml or .zbb.yaml found. Run from inside a project directory.');
                    process.exit(1);
                }
                // Named load from non-project dir — warn but allow (user may cd into project after)
                console.warn('Warning: No zbb.yaml or .zbb.yaml found in directory tree. Slot extension skipped.');
            }
            // Re-eval mode: already inside a slot, just re-export env to current shell
            if (isReload) {
                const slotEnv = slot.env.getAll();
                // Write updated env to a sourceable file so the parent shell can pick it up
                // For now, print export statements that the user can eval, or just confirm
                // Actually: zbb runs as a child process, can't modify parent shell env.
                // But we CAN update the slot's .env so next command in this shell sees changes.
                console.log(`Slot '${slotName}' re-evaluated from ${process.cwd()}`);
                break;
            }
            // First load: apply slot env, run preflight, spawn subshell
            // Apply slot env to process.env BEFORE preflight so checks like
            // JAVA_HOME-dependent java version work correctly.
            const slotEnvForPreflight = slot.env.getAll();
            for (const [k, v] of Object.entries(slotEnvForPreflight)) {
                if (v)
                    process.env[k] = v;
            }
            // Run preflight checks and apply cleanse (only if in a project)
            if (repoRoot) {
                const repoConfig = await loadRepoConfig(repoRoot);
                const requirements = [...(repoConfig.require ?? [])];
                const userConfig = await loadUserConfig();
                if (requirements.length > 0) {
                    const results = runPreflightChecks(requirements, userConfig.skip_checks);
                    console.log(formatPreflightResults(results));
                    const failed = results.filter(r => !r.ok);
                    if (failed.length > 0) {
                        process.exit(1);
                    }
                    console.log('');
                }
            }
            // Build env for subshell
            const slotEnv = slot.env.getAll();
            const shellEnv = { ...process.env };
            // Apply cleanse list
            if (repoRoot) {
                const repoConfig = await loadRepoConfig(repoRoot);
                for (const varName of repoConfig.cleanse ?? []) {
                    delete shellEnv[varName];
                }
            }
            // Merge slot env
            Object.assign(shellEnv, slotEnv);
            // Ensure JAVA_HOME is set and on PATH if not already correct
            if (!shellEnv.JAVA_HOME || !shellEnv.JAVA_HOME.includes('21')) {
                const java21Home = '/usr/lib/jvm/java-21-openjdk-amd64';
                const { existsSync } = await import('node:fs');
                if (existsSync(`${java21Home}/bin/java`)) {
                    shellEnv.JAVA_HOME = java21Home;
                    shellEnv.PATH = `${java21Home}/bin:${shellEnv.PATH ?? ''}`;
                }
            }
            // Set prompt
            const userConfig = await loadUserConfig();
            const promptTemplate = userConfig.prompt ?? '[zb:{{slot}}]:\\w$ ';
            shellEnv.PS1 = promptTemplate.replace('{{slot}}', slotName);
            // Spawn subshell
            console.log(`Loading slot '${slotName}'...`);
            const shell = spawn('bash', ['--norc', '--noprofile', '-i'], {
                stdio: 'inherit',
                env: shellEnv,
            });
            shell.on('exit', (code) => {
                process.exit(code ?? 0);
            });
            // Keep the process alive while subshell runs
            await new Promise(() => { });
            break;
        }
        case 'list': {
            // GC first
            await SlotManager.gc();
            const slots = await SlotManager.list();
            if (slots.length === 0) {
                console.log('No slots. Create one with: zbb slot create <name>');
                return;
            }
            // Table header
            const header = '  NAME            STATUS    PORTS   TTL          CREATED';
            console.log(header);
            for (const s of slots) {
                const name = s.name.padEnd(16);
                const status = 'idle'.padEnd(10); // TODO: detect if loaded (check PID)
                const ports = Object.values(s.env.getManifest())
                    .filter(m => m.type === 'port').length;
                const portsStr = String(ports).padEnd(8);
                const ttl = s.isEphemeral()
                    ? (s.isExpired() ? 'expired' : formatTimeLeft(s.meta.expires))
                    : 'persistent';
                const ttlStr = ttl.padEnd(13);
                const created = s.meta.created.substring(0, 10);
                console.log(`  ${name}${status}${portsStr}${ttlStr}${created}`);
            }
            break;
        }
        case 'info': {
            const slotName = args[1];
            if (!slotName) {
                console.error('Usage: zbb slot info <name>');
                process.exit(1);
            }
            const slot = await SlotManager.load(slotName);
            const manifest = slot.env.getManifest();
            const ports = Object.entries(manifest).filter(([, m]) => m.type === 'port');
            const secrets = Object.entries(manifest).filter(([, m]) => m.type === 'secret');
            const overrides = slot.env.list().filter(k => slot.env.isOverride(k));
            console.log(`Slot: ${slot.name}`);
            console.log(`Created: ${slot.meta.created.substring(0, 10)}`);
            console.log(`Type: ${slot.isEphemeral() ? `ephemeral (expires: ${slot.meta.expires})` : 'persistent'}`);
            console.log('');
            if (ports.length > 0) {
                console.log('Ports:');
                for (const [name, m] of ports) {
                    console.log(`  ${name}=${m.allocated}  (${m.source})`);
                }
                console.log('');
            }
            console.log(`Secrets: ${secrets.length} generated`);
            console.log(`Env vars: ${slot.env.list().length} total (${overrides.length} overrides)`);
            console.log('');
            console.log('Directories:');
            console.log(`  config  ${slot.configDir}`);
            console.log(`  logs    ${slot.logsDir}`);
            console.log(`  state   ${slot.stateDir}`);
            break;
        }
        case 'delete': {
            const slotName = args[1];
            if (!slotName) {
                console.error('Usage: zbb slot delete <name>');
                process.exit(1);
            }
            const result = await SlotManager.delete(slotName);
            const parts = [`Slot '${slotName}' deleted.`];
            if (result.containers > 0)
                parts.push(`Removed ${result.containers} container(s).`);
            if (result.volumes > 0)
                parts.push(`Removed ${result.volumes} volume(s).`);
            if (result.containers === 0 && result.volumes === 0)
                parts.push('No docker resources to clean up.');
            console.log(parts.join(' '));
            break;
        }
        case 'gc': {
            const deleted = await SlotManager.gc();
            if (deleted.length === 0) {
                console.log('No expired ephemeral slots.');
            }
            else {
                console.log(`Removed ${deleted.length} expired slot(s): ${deleted.join(', ')}`);
            }
            break;
        }
        default:
            console.error(`Unknown slot command: ${sub}`);
            console.error('Usage: zbb slot <create|load|list|info|delete|gc>');
            process.exit(1);
    }
}
// ── Secret Commands ──────────────────────────────────────────────────
async function handleSecretCmd(args) {
    const slotName = process.env.ZB_SLOT;
    if (!slotName) {
        console.error('Not inside a loaded slot. Run: zbb slot load <name>');
        process.exit(1);
    }
    if (!args[0]) {
        console.error('Usage: zbb secret <create|get|list|update|delete>');
        process.exit(1);
    }
    const slot = await SlotManager.load(slotName);
    const { handleSecret } = await import('./secret.js');
    return handleSecret(args, slot);
}
// ── Env Commands ─────────────────────────────────────────────────────
async function handleEnv(args) {
    const slotName = process.env.ZB_SLOT;
    if (!slotName) {
        console.error('Not inside a loaded slot. Run: zbb slot load <name>');
        process.exit(1);
    }
    const slot = await SlotManager.load(slotName);
    const sub = args[0];
    switch (sub) {
        case 'list': {
            const unmask = args.includes('--unmask');
            const manifest = slot.env.getManifest();
            for (const key of slot.env.list()) {
                const value = unmask ? slot.env.get(key) : (slot.env.shouldMask(key) ? '***' : slot.env.getMasked(key));
                const entry = manifest[key];
                const source = entry?.source ?? '';
                const typeInfo = entry?.derived ? 'derived' : (entry?.type ?? '');
                const override = slot.env.isOverride(key) ? ' (override)' : '';
                console.log(`  ${key}=${value}  (${source} — ${typeInfo}${override})`);
            }
            break;
        }
        case 'get': {
            const key = args[1];
            if (!key) {
                console.error('Usage: zbb env get <VAR>');
                process.exit(1);
            }
            const value = slot.env.get(key);
            if (value === undefined) {
                console.error(`Variable '${key}' not set.`);
                process.exit(1);
            }
            console.log(value);
            break;
        }
        case 'set': {
            const key = args[1];
            const value = args[2];
            if (!key || value === undefined) {
                console.error('Usage: zbb env set <VAR> <value>');
                process.exit(1);
            }
            const old = slot.env.get(key);
            await slot.env.set(key, value);
            console.log(`  ${key}: ${old ?? '(unset)'} -> ${value} (saved to overrides.env)`);
            break;
        }
        case 'unset': {
            const key = args[1];
            if (!key) {
                console.error('Usage: zbb env unset <VAR>');
                process.exit(1);
            }
            await slot.env.unset(key);
            console.log(`  ${key}: unset`);
            break;
        }
        case 'reset': {
            await slot.env.reset();
            console.log('All overrides cleared.');
            break;
        }
        case 'diff': {
            const slotEnv = slot.env.getAll();
            const parentKeys = new Set(Object.keys(process.env));
            const slotKeys = new Set(Object.keys(slotEnv));
            // Vars added by slot
            for (const key of slotKeys) {
                if (!parentKeys.has(key)) {
                    const value = slot.env.shouldMask(key) ? '***' : slotEnv[key];
                    console.log(`  + ${key}=${value}`);
                }
                else if (process.env[key] !== slotEnv[key]) {
                    const value = slot.env.shouldMask(key) ? '***' : slotEnv[key];
                    console.log(`  ~ ${key}=${value}`);
                }
            }
            break;
        }
        default:
            console.error(`Unknown env command: ${sub}`);
            console.error('Usage: zbb env <list|get|set|unset|reset|diff>');
            process.exit(1);
    }
}
// ── Logs Commands ────────────────────────────────────────────────────
async function handleLogs(args) {
    const slotName = process.env.ZB_SLOT;
    if (!slotName) {
        console.error('Not inside a loaded slot. Run: zbb slot load <name>');
        process.exit(1);
    }
    const slot = await SlotManager.load(slotName);
    const sub = args[0];
    switch (sub) {
        case 'list': {
            const { readdir, stat } = await import('node:fs/promises');
            const { existsSync } = await import('node:fs');
            const { join } = await import('node:path');
            if (!existsSync(slot.logsDir)) {
                console.log('No logs directory.');
                return;
            }
            const files = await readdir(slot.logsDir);
            const logFiles = files.filter(f => f.endsWith('.log'));
            if (logFiles.length === 0) {
                console.log('No log files.');
                return;
            }
            for (const f of logFiles) {
                const s = await stat(join(slot.logsDir, f));
                const size = formatSize(s.size);
                const modified = formatAge(s.mtimeMs);
                const name = f.replace('.log', '');
                console.log(`  ${name.padEnd(16)} ${size.padEnd(10)} modified ${modified}`);
            }
            break;
        }
        case 'show': {
            const logName = args[1];
            if (!logName) {
                console.error('Usage: zbb logs show <name> [--source local|docker|aws] [--tail N] [--follow]');
                process.exit(1);
            }
            const follow = args.includes('--follow') || args.includes('-f');
            const tailIdx = args.indexOf('--tail');
            const tailN = tailIdx !== -1 ? args[tailIdx + 1] : '50';
            const sourceIdx = args.indexOf('--source');
            const source = sourceIdx !== -1 ? args[sourceIdx + 1] : 'local';
            const { execFileSync } = await import('node:child_process');
            switch (source) {
                case 'local': {
                    const { join } = await import('node:path');
                    const { existsSync } = await import('node:fs');
                    const logPath = join(slot.logsDir, `${logName}.log`);
                    if (!existsSync(logPath)) {
                        console.error(`Log file not found: ${logPath}`);
                        process.exit(1);
                    }
                    const tailArgs = ['-n', tailN];
                    if (follow)
                        tailArgs.push('-f');
                    tailArgs.push(logPath);
                    try {
                        execFileSync('tail', tailArgs, { stdio: 'inherit' });
                    }
                    catch {
                        // tail exits non-zero on signal (Ctrl+C for follow mode)
                    }
                    break;
                }
                case 'docker': {
                    const stackName = slot.env.get('STACK_NAME') ?? slot.name;
                    const containerName = `${stackName}-${logName}`;
                    const dockerArgs = ['logs', '--tail', tailN, containerName];
                    if (follow)
                        dockerArgs.push('-f');
                    try {
                        execFileSync('docker', dockerArgs, { stdio: 'inherit' });
                    }
                    catch {
                        console.error(`Docker container not found or docker not available: ${containerName}`);
                    }
                    break;
                }
                case 'aws': {
                    const envKey = `HUB_AWS_LOG_GROUP_${logName.toUpperCase().replace(/-/g, '_')}`;
                    const logGroup = slot.env.get(envKey) ?? slot.env.get('HUB_AWS_LOG_GROUP');
                    if (!logGroup) {
                        console.error(`No log group configured. Set ${envKey} or HUB_AWS_LOG_GROUP in slot env.`);
                        process.exit(1);
                    }
                    const awsArgs = ['logs', 'tail', logGroup];
                    if (follow)
                        awsArgs.push('--follow');
                    try {
                        execFileSync('aws', awsArgs, { stdio: 'inherit' });
                    }
                    catch {
                        console.error('AWS CLI not found or not configured. Install aws-cli and run: aws configure');
                    }
                    break;
                }
                default:
                    console.error(`Unknown source: ${source}. Use: local, docker, aws`);
                    process.exit(1);
            }
            break;
        }
        default:
            console.error(`Unknown logs command: ${sub}`);
            console.error('Usage: zbb logs <list|show>');
            process.exit(1);
    }
}
// ── Helpers ──────────────────────────────────────────────────────────
function printUsage() {
    console.log(`zbb — ZeroBias Build

Usage:
  zbb slot <create|load|list|info|delete|gc>   Slot management
  zbb env <list|get|set|unset|reset|diff>       Environment variables
  zbb secret <create|get|list|update|delete>    Secret management
  zbb logs <list|show>                           Log viewer (local/docker/aws)
  zbb dataloader [args...]                       Run dataloader with slot SQL env
  zbb publish [--dry-run]                        Publish all artifacts (Gradle)
  zbb up|down|destroy|info                       Stack aliases (Gradle)
  zbb <gradle-task> [args...]                    Run Gradle task
  zbb --version                                  Show version
  zbb --help                                     Show this help

Secret commands:
  zbb secret create <name> [key=value ...] [@file.yml] [--type @schema.yml]
  zbb secret get <name> [key] [--json]    Read secret (resolves {{env.X}} refs)
  zbb secret list [--module <key>]        List secrets in slot
  zbb secret update <name> [key=value ...]  Update secret values
  zbb secret delete <name>                Delete secret`);
}
function parseTtl(value) {
    if (!value)
        return 7200;
    const match = value.match(/^(\d+)(s|m|h)?$/);
    if (!match)
        throw new Error(`Invalid TTL: ${value}. Use e.g. 30m, 2h, 1800`);
    const num = parseInt(match[1], 10);
    const unit = match[2] ?? 's';
    switch (unit) {
        case 's': return num;
        case 'm': return num * 60;
        case 'h': return num * 3600;
        default: return num;
    }
}
function formatTimeLeft(expires) {
    const ms = new Date(expires).getTime() - Date.now();
    if (ms <= 0)
        return 'expired';
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60)
        return `${minutes}m left`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m left`;
}
function formatSize(bytes) {
    if (bytes < 1024)
        return `${bytes}B`;
    if (bytes < 1024 * 1024)
        return `${Math.round(bytes / 1024)}K`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}
function formatAge(mtimeMs) {
    const seconds = Math.floor((Date.now() - mtimeMs) / 1000);
    if (seconds < 60)
        return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
}
