/**
 * Catch CSS classes and custom properties that the markup uses but the sheet
 * never defines.
 *
 * Written after making the same mistake four times on one page: `cols-5`,
 * `--surface-2`, a bare `pad` (the sheet defines `.panel.pad`, both on one
 * element), and `.chip`. Every one read plausibly, and every one failed SILENTLY
 * — an undefined class is not an error, it is simply no styling, so the page
 * renders wrong instead of refusing to build. Three of the four reached staging.
 *
 * Deliberately conservative: it only reads class attributes that are plainly
 * literal, treats custom properties set inline as defined, and treats a class
 * referenced from a script selector as a legitimate hook. A quiet check that
 * catches real bugs beats a noisy one nobody trusts.
 *
 * WHAT IT DOES NOT CATCH, so nobody mistakes it for complete: a class that IS
 * defined, but only as part of a compound selector. The sheet writes
 * `.panel.pad { ... }`, meaning both classes on one element; a bare
 * `class="pad"` on a child therefore matches nothing while looking defined here.
 * That was one of the four bugs, and finding it needs a real CSS parser rather
 * than a regex.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved from this file, not from cwd: yarn runs workspace scripts with the
// package as the working directory, so a repo-relative path would only work
// when invoked from the root.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Every directory of hand-written pages. The docs site (sub-spec 27) is held to
// the same checks as the app for the same reason: it is single-file HTML by
// hand, with no build step to notice anything.
const DIRS = ['packages/web/public', 'packages/docs-site/public'];

// `{ name, path, html }`, where `name` is repo-relative — two directories both
// contain an `index.html`, and a bare filename in an error would be ambiguous.
const pagesIn = (ext) =>
  DIRS.flatMap((rel) => {
    const dir = join(ROOT, rel);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(ext))
      .map((f) => ({ name: `${rel}/${f}`, path: join(dir, f) }));
  });

const HTML = pagesIn('.html').map((p) => ({ ...p, html: readFileSync(p.path, 'utf8') }));
let failed = false;

for (const { name: file, html } of HTML) {
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
  if (!styles) continue;

  const definedClasses = new Set([...styles.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
  const definedVars = new Set([...styles.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  // Custom properties are legitimately set inline — home.html times its entrance
  // animation with `style="--i:-1.5; --y:7px; --d:80ms"`.
  for (const m of html.matchAll(/style="[^"]*?(--[a-z0-9-]+)\s*:/g)) definedVars.add(m[1]);
  for (const m of html.matchAll(/(--[a-z0-9-]+)\s*:[^;"]*[;"]/g)) definedVars.add(m[1]);

  // A class used only as a script selector is a HOOK, not a missing style.
  const hooks = new Set(
    [...html.matchAll(/['"`]\.([a-z][\w-]*)/g)].map((m) => m[1]),
  );

  // Only literal, lowercase-ish class lists — anything with a quote, brace or
  // operator in it is runtime-assembled and not ours to judge.
  const used = new Map();
  for (const m of html.matchAll(/class="([a-z0-9][a-z0-9 _-]*)"/g)) {
    const line = html.slice(0, m.index).split('\n').length;
    for (const c of m[1].split(/\s+/).filter(Boolean)) {
      if (!used.has(c)) used.set(c, line);
    }
  }

  const missingClasses = [...used].filter(([c]) => !definedClasses.has(c) && !hooks.has(c));
  const missingVars = [...html.matchAll(/var\((--[a-z0-9-]+)/g)]
    .map((m) => m[1])
    .filter((v, i, a) => a.indexOf(v) === i && !definedVars.has(v));

  if (missingClasses.length || missingVars.length) {
    failed = true;
    console.error(`[lint:web-css] ${file} — used but never defined:`);
    for (const [c, line] of missingClasses) console.error(`  .${c}  (first used line ${line})`);
    for (const v of missingVars) console.error(`  var(${v})`);
  }
}

/**
 * Every .svg here must be well-formed XML.
 *
 * SVG is XML, not HTML, and the difference is not forgiving: a comment may not
 * contain a double hyphen. The first favicon shipped with the CSS token names
 * written as `--paper` / `--live` inside its comment, which made the whole
 * document malformed. Nothing said so — the file looked right, the server sent
 * it with a 200 and the correct content type, and Chrome simply drew the default
 * globe. It reached staging and was found by eye.
 *
 * Same failure shape as the undefined-class bugs above: valid-looking input, no
 * error anywhere, wrong pixels.
 */
for (const { name: file, path } of pagesIn('.svg')) {
  const svg = readFileSync(path, 'utf8');
  for (const [i, line] of svg.split('\n').entries()) {
    // Cheap and exact: the only double hyphen legal in XML is the comment
    // delimiters themselves.
    const stripped = line.replaceAll('<!--', '').replaceAll('-->', '');
    if (stripped.includes('--')) {
      failed = true;
      console.error(`[lint:web-css] ${file}:${i + 1} — '--' inside XML makes the file malformed:`);
      console.error(`  ${line.trim()}`);
    }
  }
  // Plus the two other ways these small hand-written files go malformed: an
  // unterminated comment, and a bare `&` that is not an entity.
  //
  // This is NOT a full XML parse — Node ships no XML parser and one lint does not
  // justify a dependency. It checks the traps that have actually bitten, in files
  // short enough to read. If these grow into generated artwork, parse them
  // properly instead of extending this.
  const naked = svg.replaceAll(/<!--[\s\S]*?-->/g, '');
  if (naked.includes('<!--')) {
    failed = true;
    console.error(`[lint:web-css] ${file} — unterminated XML comment.`);
  }
  const badAmp = naked.match(/&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#[0-9]+|#x[0-9a-fA-F]+);)/);
  if (badAmp) {
    failed = true;
    console.error(`[lint:web-css] ${file} — bare '&' must be written '&amp;'.`);
  }
}

// ---------------------------------------------------------------------------
// Unguarded `$('some-id')` writes against ids the markup no longer carries.
//
// Added after `renderHero()` reached staging writing to `#join-cmd` while the
// element that carried it sat inside an HTML comment. A null dereference at
// boot is not a silent failure like the ones above — it is louder and worse: it
// aborts the whole script, so `loadAuth()` never ran, the account chip never
// rendered, and a signed-in profile showed the "Unnamed User" placeholder that
// was sitting in the markup. Every symptom pointed at login; nothing was wrong
// with login.
//
// Only DEREFERENCES count — `$('x').foo` or `$('x')(...)`. Assigning `$('x')` to
// a variable is how the guarded cases are already written (`const foot =
// $('foot-cmd'); if (foot) ...`), so those are correctly ignored.
for (const { name: file, html } of HTML) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  if (!scripts) continue;
  // Ids the markup actually defines, ignoring anything inside an HTML comment —
  // a commented-out element is exactly the case that bit us.
  const live = html.replaceAll(/<!--[\s\S]*?-->/g, '');
  const ids = new Set([...live.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  // …plus ids the script itself creates (innerHTML templates and setAttribute).
  for (const m of scripts.matchAll(/id="([^"]+)"/g)) ids.add(m[1]);
  for (const [, id] of scripts.matchAll(/\$\('([a-zA-Z0-9_-]+)'\)\s*[.(]/g)) {
    if (ids.has(id)) continue;
    failed = true;
    console.error(`[lint:web-css] ${file} — script dereferences $('${id}'), but no element has that id.`);
  }
}

// ---------------------------------------------------------------------------
// In-page anchors that land nowhere (sub-spec 27 T169).
//
// A page navigated entirely by `href="#section"` fails the same way everything
// else in this file does: no error, no warning, the browser simply does not
// scroll. On the docs site the anchor nav IS the navigation, so a typo there is
// a broken table of contents that looks perfectly fine in review.
//
// Only literal same-page hrefs count. `#` alone is the conventional inert link
// and is ignored.
for (const { name: file, html } of HTML) {
  const live = html.replaceAll(/<!--[\s\S]*?-->/g, '');
  const targets = new Set([...live.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const m of live.matchAll(/\sname="([^"]+)"/g)) targets.add(m[1]);
  // Anchors the script writes into the page are legitimate targets too.
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  for (const m of scripts.matchAll(/id="([^"]+)"/g)) targets.add(m[1]);

  const seen = new Set();
  for (const m of live.matchAll(/href="#([^"]+)"/g)) {
    const id = decodeURIComponent(m[1]);
    if (seen.has(id) || targets.has(id)) continue;
    seen.add(id);
    failed = true;
    const line = live.slice(0, m.index).split('\n').length;
    console.error(`[lint:web-css] ${file}:${line} — href="#${id}" but no element has that id.`);
  }
}

// ---------------------------------------------------------------------------
// One palette across every page (sub-spec 27 T171 / D224).
//
// Each page carries its own `:root` block — three copies of the same design
// tokens, and until now nothing compared them. The docs site is the third, and
// the whole point of it is to look like the product rather than like a
// write-up of it, so a `--gold` adjusted in one file and not the others is a
// real defect that renders as "close enough" and is never noticed.
//
// A page need not define every token — it defines what it uses. The rule is
// only that a token defined in two places must carry the SAME value.
const palettes = HTML.map(({ name, html }) => {
  const root = html.match(/:root\s*{([\s\S]*?)}/);
  if (!root) return null;
  const tokens = new Map();
  for (const m of root[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    // Compared on the VALUE, not on how it was typed: `rgba(34,32,26,.05)` and
    // `rgba(34, 32, 26, .05)` are the same colour, and the two current pages
    // genuinely differ that way. A lint that fails on whitespace is the noisy
    // kind this file's header warns about.
    tokens.set(m[1], m[2].trim().replaceAll(/\s+/g, '').toLowerCase());
  }
  return { name, tokens };
}).filter(Boolean);

for (let i = 1; i < palettes.length; i += 1) {
  const [base, page] = [palettes[0], palettes[i]];
  for (const [token, value] of page.tokens) {
    const theirs = base.tokens.get(token);
    if (theirs === undefined || theirs === value) continue;
    failed = true;
    console.error(
      `[lint:web-css] ${token} disagrees: ${base.name} has \`${theirs}\`, ${page.name} has \`${value}\`.`,
    );
  }
}

if (failed) {
  console.error('');
  console.error('None of these error at runtime — they render unstyled, scroll');
  console.error('nowhere, or draw the wrong shade. Fix the name or the value.');
  process.exit(1);
}
console.log(
  `[lint:web-css] OK — ${HTML.length} page(s): tokens defined, anchors resolve, `
  + 'palettes agree, SVG assets well-formed.',
);
