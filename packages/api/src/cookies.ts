/**
 * Minimal cookie parse/serialize (sub-spec 11) — no plugin dependency. Used only
 * for the opaque `sid` browser-session cookie, which is httpOnly + SameSite=Lax
 * (+ Secure when the public origin is https).
 */

export const SESSION_COOKIE = 'sid';

/** Parse a raw `Cookie:` header into a name→value map. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    out[name] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/** Serialize a `Set-Cookie` value. `maxAgeMs<=0` expires the cookie immediately. */
export function serializeCookie(
  name: string,
  value: string,
  opts: { maxAgeMs: number; secure: boolean; path?: string },
): string {
  const attrs = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${opts.path ?? '/'}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(opts.maxAgeMs / 1000))}`,
  ];
  if (opts.secure) attrs.push('Secure');
  return attrs.join('; ');
}
