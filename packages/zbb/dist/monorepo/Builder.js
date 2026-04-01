/**
 * Build orchestration for monorepo workspaces.
 * Runs npm scripts across packages in dependency order.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { GateStampResult, countExpectedTests, writeGateStamp, buildPackageStampEntry, readGateStamp, validatePackageStamp, } from './GateStamp.js';
import { getCurrentBranch } from './ChangeDetector.js';
// ── Helpers ──────────────────────────────────────────────────────────
const isCI = process.env.CI === 'true';
function runNpmScript(pkg, script, options) {
    // Check if the package has this script
    const scriptBody = pkg.scripts[script];
    if (!scriptBody)
        return { status: 'not-found' };
    // Scripts that are empty or just echo "no tests" count as skipped
    if (!scriptBody.trim() || /^echo\s/.test(scriptBody.trim())) {
        return { status: 'skipped' };
    }
    const shortName = pkg.name.replace(/^@[^/]+\//, '');
    const inherit = options?.showOutput || options?.verbose;
    try {
        if (options?.verbose) {
            console.log(`    npm run ${script}`);
        }
        execFileSync('npm', ['run', script], {
            cwd: pkg.dir,
            stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, FORCE_COLOR: '1' },
            timeout: 300_000, // 5 min per phase
        });
        return { status: 'passed' };
    }
    catch (error) {
        if (inherit) {
            // Output was already shown via inherited stdio
            const msg = `${shortName}: "npm run ${script}" failed (exit ${error.status})`;
            if (options?.allowFailure) {
                return { status: 'failed', error: msg };
            }
            throw new Error(msg);
        }
        const stderr = error.stderr?.toString() ?? '';
        const stdout = error.stdout?.toString() ?? '';
        const output = stderr || stdout;
        const msg = `${shortName}: "npm run ${script}" failed (exit ${error.status})`;
        // Show captured output on failure
        if (output.trim()) {
            console.log(output.trimEnd());
        }
        if (options?.allowFailure) {
            return { status: 'failed', error: msg };
        }
        throw new Error(msg);
    }
}
function printPhaseHeader(phase, packageCount) {
    console.log(`\n── ${phase} (${packageCount} package${packageCount === 1 ? '' : 's'}) ──`);
}
// ── Clean ────────────────────────────────────────────────────────────
export function clean(ctx) {
    const { graph, affectedOrdered, verbose } = ctx;
    printPhaseHeader('clean', affectedOrdered.length);
    for (const name of affectedOrdered) {
        const pkg = graph.packages.get(name);
        const shortName = pkg.name.replace(/^@[^/]+\//, '');
        if (pkg.scripts.clean) {
            process.stdout.write(`  ${shortName}... `);
            runNpmScript(pkg, 'clean', { verbose });
            console.log('done');
        }
        else {
            // Fallback: remove dist/ directory
            const distDir = join(pkg.dir, 'dist');
            if (existsSync(distDir)) {
                rmSync(distDir, { recursive: true });
                console.log(`  ${shortName}... removed dist/`);
            }
            else {
                console.log(`  ${shortName}... nothing to clean`);
            }
        }
    }
}
// ── Build ────────────────────────────────────────────────────────────
export function build(ctx) {
    const { graph, affectedOrdered, config, verbose } = ctx;
    const phases = config.buildPhases ?? ['lint', 'generate', 'validate', 'transpile'];
    const allTaskResults = new Map();
    for (const phase of phases) {
        // Collect packages that have this script
        const packagesWithPhase = affectedOrdered.filter(name => {
            const pkg = graph.packages.get(name);
            const body = pkg.scripts[phase];
            return body && body.trim() && !/^echo\s/.test(body.trim());
        });
        if (packagesWithPhase.length === 0)
            continue;
        printPhaseHeader(phase, packagesWithPhase.length);
        for (const name of affectedOrdered) {
            const pkg = graph.packages.get(name);
            const shortName = pkg.name.replace(/^@[^/]+\//, '');
            const { status } = runNpmScript(pkg, phase, { verbose });
            // Track result
            if (!allTaskResults.has(name))
                allTaskResults.set(name, {});
            allTaskResults.get(name)[phase] = status === 'failed' ? 'skipped' : status;
            if (status === 'passed') {
                console.log(`  ✓ ${shortName}`);
            }
            else if (status === 'not-found') {
                // silent
            }
            else if (status === 'skipped') {
                // silent
            }
        }
    }
    return allTaskResults;
}
export function test(ctx) {
    const { graph, affectedOrdered, config, verbose } = ctx;
    const phases = config.testPhases ?? ['test'];
    const allTestResults = new Map();
    // Collect packages that have test scripts
    const packagesWithTests = affectedOrdered.filter(name => {
        const pkg = graph.packages.get(name);
        return phases.some(phase => {
            const body = pkg.scripts[phase];
            return body && body.trim() && !/^echo\s/.test(body.trim());
        });
    });
    if (packagesWithTests.length === 0) {
        console.log('\n── test (0 packages) ──');
        console.log('  No packages with test scripts.');
        return { results: allTestResults, failed: false };
    }
    printPhaseHeader('test', packagesWithTests.length);
    let testsFailed = false;
    for (const name of affectedOrdered) {
        const pkg = graph.packages.get(name);
        const shortName = pkg.name.replace(/^@[^/]+\//, '');
        const testSuiteResults = {};
        // Count expected tests per suite
        const suites = {
            unit: join(pkg.dir, 'test', 'unit'),
            integration: join(pkg.dir, 'test', 'integration'),
            e2e: join(pkg.dir, 'test', 'e2e'),
        };
        for (const [suite, dir] of Object.entries(suites)) {
            const expected = countExpectedTests(dir);
            testSuiteResults[suite] = {
                expected,
                ran: 0,
                status: expected === 0 ? 'skipped' : 'not-run',
            };
        }
        // Run test phases — always show output so devs see results
        for (const phase of phases) {
            console.log(`  ${shortName}: npm run ${phase}`);
            const { status, error } = runNpmScript(pkg, phase, { showOutput: true, allowFailure: true });
            if (status === 'passed') {
                console.log(`  ✓ ${shortName}`);
                // Mark all suites with tests as passed
                for (const [suite, entry] of Object.entries(testSuiteResults)) {
                    if (entry.expected > 0) {
                        entry.ran = entry.expected;
                        entry.status = 'passed';
                    }
                }
            }
            else if (status === 'failed') {
                console.log(`  ✗ ${shortName} (test failures)`);
                if (error)
                    console.log(`    ${error.split('\n')[0]}`);
                testsFailed = true;
            }
            else {
                // skipped or not-found
                for (const entry of Object.values(testSuiteResults)) {
                    if (entry.status === 'not-run')
                        entry.status = 'skipped';
                }
            }
        }
        allTestResults.set(name, testSuiteResults);
    }
    return { results: allTestResults, failed: testsFailed };
}
// ── Install ──────────────────────────────────────────────────────────
export function install(repoRoot) {
    console.log('\n── install ──');
    const cmd = isCI ? 'ci' : 'install';
    process.stdout.write(`  npm ${cmd}... `);
    execFileSync('npm', [cmd], {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '1' },
        timeout: 300_000,
    });
    console.log('done');
}
// ── Credential Sync ──────────────────────────────────────────────────
/**
 * Sync fresh credentials into process.env before tests run.
 * ~/.vault-token (written by `vault login`) is fresher than the slot's VAULT_TOKEN,
 * which may be stale from when the slot was created.
 */
function syncCredentials() {
    const tokenFile = join(homedir(), '.vault-token');
    if (existsSync(tokenFile)) {
        const token = readFileSync(tokenFile, 'utf-8').trim();
        if (token && token !== process.env.VAULT_TOKEN) {
            process.env.VAULT_TOKEN = token;
        }
    }
}
// ── Gate (full pipeline with caching) ────────────────────────────────
export function gate(ctx) {
    const { repoRoot, graph, affectedOrdered, config } = ctx;
    if (affectedOrdered.length === 0) {
        console.log('No packages affected — nothing to gate.');
        const existingStamp = readGateStamp(repoRoot) ?? { version: 1, branch: '', timestamp: '', packages: {} };
        existingStamp.branch = getCurrentBranch(repoRoot);
        existingStamp.timestamp = new Date().toISOString();
        writeGateStamp(repoRoot, existingStamp);
        return;
    }
    // Check existing stamp to determine what can be skipped
    const existingStamp = readGateStamp(repoRoot);
    const validPackages = [];
    const testsChangedPackages = [];
    const fullGatePackages = [];
    console.log('\n── cache check ──');
    for (const name of affectedOrdered) {
        const pkg = graph.packages.get(name);
        const shortName = pkg.name.replace(/^@[^/]+\//, '');
        const result = validatePackageStamp(pkg, existingStamp, config);
        switch (result) {
            case GateStampResult.VALID:
                validPackages.push(name);
                console.log(`  ✓ ${shortName} — up to date, skipping`);
                break;
            case GateStampResult.TESTS_CHANGED:
                testsChangedPackages.push(name);
                console.log(`  ~ ${shortName} — tests changed, re-running tests only`);
                break;
            default:
                fullGatePackages.push(name);
                console.log(`  ✗ ${shortName} — full gate needed`);
        }
    }
    const needsBuild = fullGatePackages.length > 0;
    const needsTest = testsChangedPackages.length > 0 || fullGatePackages.length > 0;
    if (!needsBuild && !needsTest) {
        console.log('\nAll packages up to date — nothing to do.');
        // Update timestamp only
        if (existingStamp) {
            existingStamp.branch = getCurrentBranch(repoRoot);
            existingStamp.timestamp = new Date().toISOString();
            writeGateStamp(repoRoot, existingStamp);
        }
        return;
    }
    // Install dependencies at workspace root (needed for both build and test)
    install(repoRoot);
    // Build only packages that need full gate
    const taskResults = new Map();
    if (needsBuild) {
        const buildCtx = { ...ctx, affectedOrdered: fullGatePackages };
        const buildResults = build(buildCtx);
        for (const [k, v] of buildResults)
            taskResults.set(k, v);
    }
    // Sync fresh credentials (e.g., ~/.vault-token) before running tests
    syncCredentials();
    // Test: packages needing full gate + packages with only test changes
    const packagesToTest = [...fullGatePackages, ...testsChangedPackages];
    const testOutput = test({ ...ctx, affectedOrdered: packagesToTest });
    const testResults = testOutput.results;
    const testsFailed = testOutput.failed;
    // Write gate stamp — merge new results with cached valid packages
    console.log('\n── gate-stamp ──');
    const stamp = {
        version: 1,
        branch: getCurrentBranch(repoRoot),
        timestamp: new Date().toISOString(),
        packages: existingStamp?.packages ?? {},
    };
    // Keep valid packages as-is in stamp (already cached)
    // Update packages that were rebuilt or retested
    const phases = config.buildPhases ?? ['lint', 'generate', 'validate', 'transpile'];
    const testPhases = config.testPhases ?? ['test'];
    for (const name of [...fullGatePackages, ...testsChangedPackages]) {
        const pkg = graph.packages.get(name);
        const tasks = taskResults.get(name) ?? {};
        const tests = testResults.get(name) ?? {};
        const allTasks = {};
        for (const phase of [...phases, ...testPhases]) {
            allTasks[phase] = tasks[phase] ?? 'skipped';
        }
        // For tests-changed packages that weren't rebuilt, carry forward build task results
        if (testsChangedPackages.includes(name) && !fullGatePackages.includes(name)) {
            const cachedEntry = existingStamp?.packages[name];
            if (cachedEntry) {
                for (const phase of phases) {
                    allTasks[phase] = cachedEntry.tasks[phase] ?? 'skipped';
                }
            }
        }
        stamp.packages[name] = buildPackageStampEntry(pkg, config, allTasks, tests);
    }
    writeGateStamp(repoRoot, stamp);
    const skipped = validPackages.length;
    const rebuilt = fullGatePackages.length;
    const retested = testsChangedPackages.length;
    console.log(`  ✓ gate-stamp.json written (${skipped} cached, ${rebuilt} rebuilt, ${retested} retested)`);
    // Print test summary
    let totalExpected = 0;
    let totalPassed = 0;
    for (const [, tests] of testResults) {
        for (const [, entry] of Object.entries(tests)) {
            if (entry.expected > 0) {
                totalExpected += entry.expected;
                totalPassed += entry.ran;
            }
        }
    }
    if (totalExpected > 0) {
        console.log(`  Tests: ${totalPassed}/${totalExpected} passed`);
    }
    if (testsFailed) {
        console.error('\nGate failed — test failures detected. Stamp written with current state.');
        process.exit(1);
    }
}
