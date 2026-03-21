/**
 * Internal dependencies — overridable for testing.
 * @internal
 */
export declare const _deps: {
    readResolvConf(): string;
    resolveTxt(hostname: string): Promise<string[][]>;
};
/**
 * Read /etc/resolv.conf and return the first domain from the `search` line.
 * Returns undefined if file is missing or has no search directive.
 */
export declare function getSearchDomain(): string | undefined;
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
export declare function lookupDnsTxt(prefix: string): Promise<Record<string, string> | undefined>;
/**
 * Resolve DNS TXT records at `${prefix}.${searchDomain}` and return as a Map.
 * This is the integration point for slot create/load to pre-populate env.
 *
 * @param prefix - The DNS prefix to query (e.g., `_hub`)
 * @returns Map of KEY->value pairs (empty Map if DNS unavailable)
 */
export declare function resolveDnsEnv(prefix: string): Promise<Map<string, string>>;
