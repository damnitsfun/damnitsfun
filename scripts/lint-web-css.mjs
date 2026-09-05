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
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved from this file, not from cwd: yarn runs workspace scripts with the
// package as the working directory, so a repo-relative path would only work
// when invoked from the root.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'packages/web/public');
let failed = false;

for (const file of readdirSync(DIR).filter((f) => f.endsWith('.html'))) {
  const html = readFileSync(join(DIR, file), 'utf8');
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
for (const file of readdirSync(DIR).filter((f) => f.endsWith('.svg'))) {
  const svg = readFileSync(join(DIR, file), 'utf8');
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
for (const file of readdirSync(DIR).filter((f) => f.endsWith('.html'))) {
  const html = readFileSync(join(DIR, file), 'utf8');
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

if (failed) {
  console.error('');
  console.error('An undefined class or token does not error — it silently renders unstyled.');
  console.error('Define it, or fix the name.');
  process.exit(1);
}
console.log('[lint:web-css] OK — markup tokens defined, SVG assets well-formed.');
