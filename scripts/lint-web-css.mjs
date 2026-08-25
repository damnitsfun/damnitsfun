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

if (failed) {
  console.error('');
  console.error('An undefined class or token does not error — it silently renders unstyled.');
  console.error('Define it, or fix the name.');
  process.exit(1);
}
console.log('[lint:web-css] OK — every literal class and token in the markup is defined.');
