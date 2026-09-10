/**
 * The agent's face, as an SVG the chain can point at (sub-spec 23, § B).
 *
 * The web app has drawn a deterministic monogram face for every agent since
 * sub-spec 19 — a hue picked by hashing the agent id, initials taken from the
 * display name. It existed only in the browser, so an agent's ERC-8004
 * registration document shipped `image: ''` and the identity rendered as a
 * blank square in every reader outside our own site: 8004scan, wallets, any
 * explorer that follows the standard.
 *
 * This is that same face, server-side, so the token has a picture. The hash,
 * the palette and the monogram rule are deliberately IDENTICAL to
 * `faceFor()` in `packages/web/public/index.html` — an agent whose avatar
 * differed between its profile page and its on-chain identity would be two
 * agents to a reader, which is the one thing an identity must not be.
 */

/** Must stay byte-identical to FACE_HUES in the web app. */
const FACE_HUES: Array<{ bg: string; fg: string }> = [
  { bg: '#6fd68f', fg: '#0d2a1c' },
  { bg: '#3a6ea8', fg: '#ffffff' },
  { bg: '#c99a25', fg: '#2a1e02' },
  { bg: '#c2503f', fg: '#ffffff' },
  { bg: '#7fb0d8', fg: '#0d2029' },
  { bg: '#b98ad1', fg: '#1e1229' },
  { bg: '#e2c05a', fg: '#2a2205' },
  { bg: '#4fb8a5', fg: '#04231e' },
];

export interface Face {
  bg: string;
  fg: string;
  mono: string;
}

export function faceFor(agentId: string, displayName: string | null): Face {
  let h = 0;
  const key = String(agentId || '');
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const hue = FACE_HUES[h % FACE_HUES.length]!;
  const src = String(displayName || key).replace(/[^a-zA-Z0-9]/g, '');
  const digit = src.match(/\d/);
  const mono = ((src.slice(0, 1) + (digit ? digit[0] : src.slice(1, 2))) || '??').toUpperCase();
  return { bg: hue.bg, fg: hue.fg, mono };
}

/**
 * A square SVG, sized in `viewBox` units only so a reader can render it at
 * whatever size its grid wants. No external font is referenced: an NFT image
 * that needs a webfont to be legible is an NFT image that renders wrong
 * everywhere it is actually looked at.
 */
export function avatarSvg(agentId: string, displayName: string | null): string {
  const f = faceFor(agentId, displayName);
  const mono = f.mono.replace(/[&<>"']/g, '');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120" ` +
    `role="img" aria-label="${mono}">` +
    `<rect width="120" height="120" rx="24" fill="${f.bg}"/>` +
    `<text x="60" y="60" fill="${f.fg}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" ` +
    `font-size="52" font-weight="700" letter-spacing="1" text-anchor="middle" ` +
    `dominant-baseline="central">${mono}</text>` +
    `</svg>`
  );
}
