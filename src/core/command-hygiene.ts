/**
 * Command hygiene patterns (home path, private IPv4, socket path), shared by
 * land and receipt add (C-v4.1 3.1: moved from land.ts, unchanged).
 */

export interface HygienePattern {
  readonly name: string;
  readonly test: (line: string) => boolean;
}

const HOME_PATH = /\/(?:Users|home)\/[^/\r\n]+/;
const SOCKET_PATH = /\/[^/\s]*\.sock(?![A-Za-z0-9_.\-])/;
const IPV4_CANDIDATE = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\d|\.\d)/g;

/** True when the line holds an RFC 1918 IPv4 address with valid octets. */
export function hasPrivateIpv4(line: string): boolean {
  for (const m of line.matchAll(IPV4_CANDIDATE)) {
    const o = m.slice(1, 5).map(Number);
    if (o.some((n) => n > 255)) continue;
    const [a, b] = o as [number, number, number, number];
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

export const DEFAULT_HYGIENE_PATTERNS: readonly HygienePattern[] = [
  { name: "home path", test: (line) => HOME_PATH.test(line) },
  { name: "private IPv4", test: hasPrivateIpv4 },
  { name: "socket path", test: (line) => SOCKET_PATH.test(line) },
];
