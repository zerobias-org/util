/**
 * Platform-aware Java 21 home discovery.
 *
 * Why: zbb forces Java 21 because Gradle 8.10.2 breaks on Java 25+. The
 * fallback path used to be a single Linux Debian path
 * (`/usr/lib/jvm/java-21-openjdk-amd64`), which broke macOS (and Linux
 * arm64, and Linux non-Debian) builds. This helper centralises the
 * discovery so every site uses the same source of truth.
 */

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';

const DARWIN_CANDIDATES: string[] = [
  // Homebrew on Apple Silicon
  '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home',
  // Homebrew on Intel
  '/usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home',
  // Common JDK distributions installed under /Library
  '/Library/Java/JavaVirtualMachines/openjdk-21.jdk/Contents/Home',
  '/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home',
  '/Library/Java/JavaVirtualMachines/zulu-21.jdk/Contents/Home',
  '/Library/Java/JavaVirtualMachines/liberica-jdk-21.jdk/Contents/Home',
  '/Library/Java/JavaVirtualMachines/microsoft-21.jdk/Contents/Home',
];

const LINUX_CANDIDATES: string[] = [
  // Debian/Ubuntu
  '/usr/lib/jvm/java-21-openjdk-amd64',
  '/usr/lib/jvm/java-21-openjdk-arm64',
  '/usr/lib/jvm/java-21-openjdk',
  // Generic
  '/usr/lib/jvm/java-21',
  // RHEL/Fedora-style
  '/usr/lib/jvm/java-21-openjdk-21',
];

function isJavaHome(dir: string): boolean {
  return existsSync(`${dir}/bin/java`);
}

/**
 * Ask `/usr/libexec/java_home -v 21` for a Java 21 install registered with
 * macOS. Last-resort fallback for installs in non-standard prefixes.
 * Returns null if the helper isn't present (non-Mac) or no match found.
 */
function macJavaHomeHelper(): string | null {
  const helper = '/usr/libexec/java_home';
  if (!existsSync(helper)) return null;
  try {
    const out = execFileSync(helper, ['-v', '21'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5_000,
    }).trim();
    return out && isJavaHome(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * Find a Java 21 install on this host. Returns the first existing candidate,
 * or null if none found.
 *
 * Callers should treat null as "leave JAVA_HOME alone" — never crash on a
 * null return; let downstream tooling fail with its own diagnostic.
 */
export function findDefaultJavaHome(): string | null {
  const os = platform();
  const candidates = os === 'darwin' ? DARWIN_CANDIDATES : LINUX_CANDIDATES;
  for (const c of candidates) {
    if (isJavaHome(c)) return c;
  }
  if (os === 'darwin') {
    const fromHelper = macJavaHomeHelper();
    if (fromHelper) return fromHelper;
  }
  return null;
}

/**
 * All Java 21 candidate paths for this host (for callers like preflight that
 * need to enumerate, not just pick one).
 */
export function knownJavaHomes(): string[] {
  return platform() === 'darwin' ? [...DARWIN_CANDIDATES] : [...LINUX_CANDIDATES];
}
