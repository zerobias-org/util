/**
 * zbb dataloader — wraps platform dataloader CLI with slot PG env injection
 *
 * Usage:
 *   zbb dataloader [args...]         → run dataloader with slot PG env vars injected
 *   zbb dataloader -d .              → process current directory
 *   zbb dataloader -d /path/to/pkg   → process specific package directory
 *
 * Reads PG connection from active zbb slot (ZB_SLOT env var) and injects:
 *   PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE
 */
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
export async function handleDataloader(args) {
    // Preflight: verify dataloader is on PATH
    try {
        execFileSync('which', ['dataloader'], { stdio: 'pipe' });
    }
    catch {
        console.error("Error: 'dataloader' not found on PATH");
        console.error('Install: npm i -g @zerobias-com/platform-dataloader');
        process.exit(1);
    }
    // Require active slot for PG env injection
    const slotName = process.env.ZB_SLOT;
    if (!slotName) {
        console.error('Error: No active slot. Run: zbb slot load <name>');
        process.exit(1);
    }
    // Load slot to get PG connection vars
    const { SlotManager } = await import('./slot/SlotManager.js');
    const slot = await SlotManager.load(slotName);
    const slotEnv = slot.env.getAll();
    // Build child env: start from current process env, then inject PG vars from slot
    const childEnv = { ...process.env };
    // Inject PG connection from slot (slot wins for PG vars)
    const pgVars = ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'];
    for (const v of pgVars) {
        if (slotEnv[v])
            childEnv[v] = slotEnv[v];
    }
    // Also inject NPM_TOKEN if in slot (needed for registry access)
    if (slotEnv.NPM_TOKEN)
        childEnv.NPM_TOKEN = slotEnv.NPM_TOKEN;
    // Default to -d . if no args provided
    const effectiveArgs = args.length === 0 ? ['-d', '.'] : args;
    // Spawn dataloader with pass-through args
    const child = spawn('dataloader', effectiveArgs, {
        env: childEnv,
        stdio: 'inherit',
        cwd: process.cwd(),
    });
    child.on('close', (code) => {
        process.exit(code ?? 1);
    });
}
