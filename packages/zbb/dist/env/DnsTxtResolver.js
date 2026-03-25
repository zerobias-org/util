import { readFileSync } from 'node:fs';
import { resolveTxt as _resolveTxt } from 'node:dns/promises';
/**
 * Internal dependencies — overridable for testing.
 * @internal
 */
export const _deps = {
    readResolvConf() {
        return readFileSync('/etc/resolv.conf', 'utf-8');
    },
    resolveTxt(hostname) {
        return _resolveTxt(hostname);
    },
};
/**
 * Read /etc/resolv.conf and return the first domain from the `search` line.
 * Returns undefined if file is missing or has no search directive.
 */
export function getSearchDomain() {
    let content;
    try {
        content = _deps.readResolvConf();
    }
    catch {
        return undefined;
    }
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('search ')) {
            const domains = trimmed.slice(7).trim().split(/\s+/);
            return domains[0] || undefined;
        }
    }
    return undefined;
}
/**
 * Look up DNS TXT records at `${prefix}.${domain}` and parse KEY=value pairs.
 *
 * TXT records may be split into multiple strings per RFC 7208 section 3.3;
 * these are joined before parsing. Each TXT record should contain one
 * KEY=value pair.
 *
 * @param prefix - The DNS prefix to query (e.g., `_hub`)
 * @returns Parsed key-value map, or undefined if DNS unavailable or no records found
 */
export async function lookupDnsTxt(prefix) {
    const domain = getSearchDomain();
    if (!domain)
        return undefined;
    const fqdn = `${prefix}.${domain}`;
    let records;
    try {
        records = await _deps.resolveTxt(fqdn);
    }
    catch {
        return undefined;
    }
    if (!records || records.length === 0)
        return undefined;
    const result = {};
    for (const parts of records) {
        // Join multi-string TXT records per RFC 7208
        const joined = parts.join('');
        const idx = joined.indexOf('=');
        if (idx === -1)
            continue;
        const key = joined.slice(0, idx).trim();
        const value = joined.slice(idx + 1).trim();
        if (key) {
            result[key] = value;
        }
    }
    if (Object.keys(result).length === 0)
        return undefined;
    return result;
}
/**
 * Resolve DNS TXT records at `${prefix}.${searchDomain}` and return as a Map.
 * This is the integration point for slot create/load to pre-populate env.
 *
 * @param prefix - The DNS prefix to query (e.g., `_hub`)
 * @returns Map of KEY->value pairs (empty Map if DNS unavailable)
 */
export async function resolveDnsEnv(prefix) {
    const result = await lookupDnsTxt(prefix);
    if (!result)
        return new Map();
    return new Map(Object.entries(result));
}
