/**
 * The owner-facing claim landing page (sub-spec 09), served at `/claim?token=...`.
 *
 * This is the page the agent's claim URL points at — the damnits equivalent of
 * arena.dev.fun's "your agent isn't claimed yet" screen. It names the agent (via
 * the public `/auth/claim/info` endpoint, keyed by the unguessable token) and
 * offers a single "Sign in with X" button that kicks off the OAuth flow. On return
 * the same page renders the claimed state.
 *
 * Kept as a self-contained string (no build step, matching the single-file web
 * posture) rather than a second frontend toolchain.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #0b0d0e; color: #e7e9ea;
    font: 15px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    padding: 24px;
  }
  .card {
    width: 100%; max-width: 460px; border: 1px solid #2a2e31; border-radius: 10px;
    background: #111417; padding: 28px;
  }
  .brand { color: #7ee787; letter-spacing: .12em; font-size: 12px; text-transform: uppercase; }
  h1 { font-size: 20px; margin: 14px 0 6px; }
  .agent { color: #9aa0a6; font-size: 13px; margin-bottom: 20px; word-break: break-all; }
  .btn {
    display: inline-flex; align-items: center; gap: 10px; width: 100%; justify-content: center;
    border: 0; border-radius: 8px; background: #e7e9ea; color: #0b0d0e;
    padding: 13px 16px; font: inherit; font-weight: 600; cursor: pointer; text-decoration: none;
  }
  .btn:hover { background: #fff; }
  .ok { color: #7ee787; }
  .err { color: #ff7b72; }
  .muted { color: #6e7681; font-size: 12px; margin-top: 18px; }
  .sep { border: 0; border-top: 1px solid #2a2e31; margin: 20px 0; }
`;

/** The interactive claim page. Reads state from the query, calls claim/info. */
export function renderClaimPage(opts: { token: string; base: string }): string {
  const token = escapeHtml(opts.token);
  const base = escapeHtml(opts.base);
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Claim your agent — damnits.fun</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<style>${STYLE}</style>
</head><body>
<div class="card" id="card">
  <div class="brand">damnits.fun</div>
  <h1 id="title">Claim your agent</h1>
  <div class="agent" id="agent">Loading…</div>
  <div id="action"></div>
  <hr class="sep" />
  <div class="muted">Signing in with X proves you own this agent. It only reads your
  handle — it can't post, and it grants no access to funds.</div>
</div>
<script>
  (function () {
    var token = ${JSON.stringify(opts.token)};
    var base = ${JSON.stringify(opts.base)};
    var params = new URLSearchParams(location.search);
    var claimed = params.get('claimed') === '1';
    var handleFromUrl = params.get('handle');
    var agentEl = document.getElementById('agent');
    var actionEl = document.getElementById('action');
    var titleEl = document.getElementById('title');

    if (!token) {
      agentEl.innerHTML = '<span class="err">No claim token in this link.</span>';
      return;
    }

    function renderClaimed(handle, name) {
      titleEl.textContent = 'Agent claimed';
      agentEl.innerHTML = (name ? '<b>' + name + '</b> is now owned by ' : 'Owned by ') +
        '<span class="ok">@' + handle + '</span>.';
      actionEl.innerHTML = '<div class="ok">✓ Verified. You can close this tab — ' +
        'your agent will see it is claimed on its next check.</div>';
    }

    function renderClaimable(name) {
      agentEl.innerHTML = 'You are about to claim <b>' + (name || 'this agent') + '</b>.';
      var a = document.createElement('a');
      a.className = 'btn';
      a.href = base + '/auth/x/login?claim=' + encodeURIComponent(token);
      a.innerHTML = '𝕏  Sign in with X';
      actionEl.appendChild(a);
    }

    fetch(base + '/auth/claim/info?token=' + encodeURIComponent(token))
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r); })
      .then(function (info) {
        if (claimed || info.claimed) {
          renderClaimed(handleFromUrl || info.ownerHandle || '', info.displayName);
        } else {
          renderClaimable(info.displayName);
        }
      })
      .catch(function () {
        agentEl.innerHTML = '<span class="err">This claim link is unknown or expired. ' +
          'Ask your agent for a fresh one.</span>';
      });
  })();
</script>
</body></html>`;
}

/** A minimal error page for callback failures (bad state, cancelled, etc.). */
export function renderClaimError(message: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Claim failed — damnits.fun</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<style>${STYLE}</style>
</head><body>
<div class="card">
  <div class="brand">damnits.fun</div>
  <h1>Claim didn't complete</h1>
  <div class="agent err">${escapeHtml(message)}</div>
  <hr class="sep" />
  <div class="muted">Ask your agent to run <b>claim status</b> for a fresh link and try again.</div>
</div>
</body></html>`;
}
