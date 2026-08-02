'use strict';

/**
 * Netflix Tools — Telegram Bot (long-polling edition)
 * ---------------------------------------------------------------------------
 * Runs on Railway (or any always-on Node host: your droplet, Render, etc.).
 *
 * WHY POLLING INSTEAD OF A WEBHOOK?
 *   Your site (cigaop.club) is behind Imunify360, which returns 406 to
 *   Telegram's webhook because Telegram sends requests with no User-Agent.
 *   Long-polling means THIS bot reaches OUT to Telegram, so nothing ever hits
 *   the firewall. It then calls your verification-code tool over HTTP with a
 *   normal browser User-Agent (so the tool answers 200 instead of 406).
 *
 * SETUP (all config comes from environment variables — set them in Railway):
 *   BOT_TOKEN         (required)  your @BotFather token
 *   ALLOWED_CHAT_IDS  (required)  your numeric Telegram ID(s), comma-separated
 *   TOOL_URL          (optional)  defaults to https://cigaop.club/verificationcode/
 *   NOTIFY_CHAT_ID    (optional)  chat id pinged when a hold is fixed via /done
 *
 * FIRST RUN:
 *   1) Deploy with BOT_TOKEN set.
 *   2) In Telegram, send the bot  /id  → it replies with your numeric ID.
 *   3) Put that number in ALLOWED_CHAT_IDS, redeploy.
 *   4) Send  /code someone@email.com  or  /reset someone@email.com
 *
 * NOTE: On startup this bot DELETES any existing webhook (including the old
 * cigaop.club one that was returning 406) — a bot can't use a webhook and
 * polling at the same time. Run only ONE instance of this bot per token.
 * ---------------------------------------------------------------------------
 */

const http = require('http');
const { getNetflixInfo, resolveCookiesFromUrl } = require('./nf-account');
const store = require('./store');

// ─── CONFIG (from environment) ────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const TOOL_URL  = process.env.TOOL_URL  || 'https://cigaop.club/verificationcode/';
const ALLOWED_CHAT_IDS = (process.env.ALLOWED_CHAT_IDS || '')
  .split(/[\s,]+/)
  .map(s => s.trim())
  .filter(Boolean)
  .map(Number)
  .filter(Number.isFinite);

// Chat id(s) that get a message every time a hold is verified fixed by /done.
// Defaults to the id below; override with NOTIFY_CHAT_ID (or NOTIFY_CHAT_IDS,
// comma-separated) via a Railway variable — no code change needed.
const NOTIFY_CHAT_IDS = (process.env.NOTIFY_CHAT_IDS || process.env.NOTIFY_CHAT_ID || '858170312')
  .split(/[\s,]+/)
  .map(s => s.trim())
  .filter(Boolean)
  .map(Number)
  .filter(Number.isFinite);

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// The cigaop tool sits behind Imunify360, which 406s requests with an empty
// User-Agent. Sending a normal browser UA makes the tool return 200.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ─── small helpers ─────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function shortUrl(u) {
  u = String(u);
  return u.length > 60 ? u.slice(0, 57) + '…' : u;
}

// Send a list of lines as one or more messages, each under Telegram's 4096
// limit, without ever splitting a line (so <code> tags stay well-formed).
async function sendChunked(chatId, lines) {
  let buf = [];
  let len = 0;
  for (const ln of lines) {
    if (buf.length && len + ln.length + 1 > 3900) {
      await reply(chatId, buf.join('\n'));
      buf = [];
      len = 0;
    }
    buf.push(ln);
    len += ln.length + 1;
  }
  if (buf.length) await reply(chatId, buf.join('\n'));
}

async function fetchJson(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* leave null */ }
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(t);
  }
}

// ─── Telegram API ────────────────────────────────────────────────────────────
async function tg(method, params) {
  try {
    const r = await fetchJson(`${API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }, 25000);
    return r.json || {};
  } catch (e) {
    console.error(`tg(${method}) failed:`, e.message);
    return {};
  }
}

function reply(chatId, text) {
  return tg('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

function deny(chatId) {
  return reply(chatId, `⛔ Not authorized. Your ID: <code>${chatId}</code>`);
}

// ─── Your verification-code tool's JSON API ────────────────────────────────────
// Returns: the code/link string on success, '' if nothing found, null on error.
async function fetchFromTool(email, action) {
  try {
    const r = await fetchJson(TOOL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Inbox-Action': action,     // 'signin' or 'reset'
        'User-Agent': BROWSER_UA,     // avoid the tool's 406 empty-UA block
      },
      body: JSON.stringify({ emails: [email] }),
    }, 90000);

    if (!r.ok || r.status >= 400) return null;
    const data = r.json;
    if (!Array.isArray(data) || !data[0]) return null;

    const key = action === 'reset' ? 'link' : 'code';
    return String(data[0][key] ?? '');
  } catch (e) {
    console.error('fetchFromTool failed:', e.message);
    return null;
  }
}

// ─── URL cookie inspector (for /cookies) ───────────────────────────────────────
// Hits a URL WITHOUT following redirects and returns the status code, any
// Location header, and the raw Set-Cookie headers exactly as the server sent
// them. Node's built-in fetch returns the REAL 3xx response for
// redirect:'manual' (verified), so getSetCookie() also sees cookies set on a
// 302 — no need for the `undici` package, the global fetch already does this.
async function fetchCookies(url, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',              // don't auto-follow: show the FIRST response's cookies
      headers: { 'User-Agent': BROWSER_UA },
      signal: ctrl.signal,
    });
    const cookies = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
    return { status: res.status, location: res.headers.get('location'), cookies };
  } finally {
    clearTimeout(t);
  }
}

// ─── Command handling ──────────────────────────────────────────────────────────
async function handleUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg) return;

  const chatId = Number(msg.chat && msg.chat.id ? msg.chat.id : 0);
  const text = String(msg.text || '').trim();
  const isOwner = ALLOWED_CHAT_IDS.includes(chatId);

  const parts = text.split(/\s+/);
  const cmd = (parts[0] || '').toLowerCase().replace(/@.*$/, ''); // strip @BotName
  const arg = parts.slice(1).join(' ').trim();

  switch (cmd) {
    case '/id':
      // Open to everyone so you can discover your ID during setup.
      await reply(chatId, `Your Telegram ID: <code>${chatId}</code>`);
      break;

    case '/start':
    case '/help':
      if (!isOwner) {
        await reply(chatId,
          `Not authorized.\nYour ID: <code>${chatId}</code>\n` +
          `Add it to ALLOWED_CHAT_IDS, then redeploy.`);
        break;
      }
      await reply(chatId,
        '<b>Netflix Tools Bot</b>\n\n' +
        '<b>Batch + hold tracker</b>\n' +
        '/hold — list on-hold accounts still to fix (with country)\n' +
        '/get <i>id</i> — fresh no-password login URL to clear that hold\n' +
        '/done <i>id</i> — re-check; if the hold is cleared it moves to /list, else says not fixed\n' +
        '/list — accounts you have fixed (verified by /done)\n' +
        '/remove <i>id</i> — force-delete an entry\n\n' +
        '/id — show your Telegram ID');
      break;

    case '/ping':
      if (!isOwner) { await deny(chatId); break; }
      await reply(chatId, '✅ pong');
      break;

    case '/code':
    case '/reset': {
      if (!isOwner) { await deny(chatId); break; }
      if (!arg || !isEmail(arg)) {
        await reply(chatId, `Usage: <code>${cmd} someone@email.com</code>`);
        break;
      }
      const action = cmd === '/reset' ? 'reset' : 'signin';
      await reply(chatId, `🔍 Searching for <code>${esc(arg)}</code>…`);

      const value = await fetchFromTool(arg, action);
      const label = action === 'reset' ? 'Reset link' : 'Verification code';

      if (value === null) {
        await reply(chatId, '⚠️ Could not reach the tool. Try again in a moment.');
      } else if (value === '') {
        await reply(chatId,
          `❌ No ${label} found for <code>${esc(arg)}</code> in the last 24 hours.`);
      } else {
        await reply(chatId,
          `✅ ${label} for <code>${esc(arg)}</code>:\n<b>${esc(value)}</b>`);
      }
      break;
    }

    case '/cookie':
    case '/cookies': {
      if (!isOwner) { await deny(chatId); break; }

      let target = null;
      const rawUrl = (arg.split(/\s+/)[0] || '').trim();
      try { target = new URL(rawUrl); } catch (_) { /* invalid URL */ }
      if (!target || (target.protocol !== 'http:' && target.protocol !== 'https:')) {
        await reply(chatId, 'Usage: <code>/cookies https://example.com</code>');
        break;
      }

      await reply(chatId, `🍪 Fetching cookies from <code>${esc(target.href)}</code>…`);

      try {
        const { status, location, cookies } = await fetchCookies(target.href);

        const lines = [
          `🍪 <b>${esc(target.href)}</b>`,
          `Status: <code>${status}</code>`,
        ];
        if (location) lines.push(`Location: <code>${esc(location)}</code>`);

        if (!cookies.length) {
          lines.push('', 'No <code>Set-Cookie</code> headers returned.');
        } else {
          lines.push('', `<b>Set-Cookie (${cookies.length}):</b>`);
          for (const c of cookies) {
            const raw = c.length > 400 ? c.slice(0, 400) + '…' : c;
            lines.push(`<code>${esc(raw)}</code>`);
          }
        }

        // Stay under Telegram's 4096-char limit by dropping WHOLE lines, so we
        // never split an <code> tag (malformed HTML makes Telegram reject it).
        while (lines.length > 3 && lines.join('\n').length > 3900) lines.pop();

        await reply(chatId, lines.join('\n'));
      } catch (e) {
        await reply(chatId, `⚠️ Couldn't fetch that URL: <code>${esc(e.message || String(e))}</code>`);
      }
      break;
    }

    case '/nf':
    case '/netflix': {
      if (!isOwner) { await deny(chatId); break; }
      const nfInput = arg.trim();
      const nfFirst = (nfInput.split(/\s+/)[0] || '');
      let nfCookie = null;
      let nfCookieNote = '';

      if (/^https?:\/\//i.test(nfFirst)) {
        // URL mode: fetch the login URL, follow redirects, harvest the cookies.
        let target = null;
        try { target = new URL(nfFirst); } catch (_) { /* invalid */ }
        if (!target) { await reply(chatId, 'That URL looks invalid.'); break; }

        await reply(chatId, `🔗 Extracting cookies from <code>${esc(target.href)}</code>…`);
        let resolved;
        try {
          resolved = await resolveCookiesFromUrl(target.href);
        } catch (e) {
          await reply(chatId, `⚠️ Couldn't fetch that URL: <code>${esc(e.message || String(e))}</code>`);
          break;
        }

        if (!resolved.netflixCookie) {
          const seen = Object.keys(resolved.jar);
          await reply(chatId,
            '❌ That URL didn\u2019t return a Netflix session cookie ' +
            '(<code>NetflixId</code> + <code>SecureNetflixId</code>).\n' +
            `Redirects followed: <code>${resolved.chain.length}</code>\n` +
            (seen.length
              ? `Cookies seen: <code>${esc(seen.join(', '))}</code>`
              : 'No <code>Set-Cookie</code> headers at all.'));
          break;
        }
        nfCookie = resolved.netflixCookie;
        nfCookieNote = `🍪 Cookies extracted from URL (${resolved.chain.length} hop${resolved.chain.length === 1 ? '' : 's'})`;
      } else if (/NetflixId=/.test(nfInput)) {
        nfCookie = nfInput; // direct cookie mode
      } else {
        await reply(chatId,
          'Usage:\n' +
          '<code>/nf https://your-login-url</code> — extract cookies from the URL, then read the account\n' +
          'or paste a cookie directly:\n' +
          '<code>/nf NetflixId=…; SecureNetflixId=…;</code>');
        break;
      }

      await reply(chatId, '🔍 Reading Netflix account…');

      try {
        const info = await getNetflixInfo(nfCookie);

        if (!info.authenticated) {
          await reply(chatId,
            '❌ <b>Cookie is dead / not logged in.</b>\n' +
            `Status: <code>${esc(info.httpStatus)}</code>\n` +
            `Membership: <code>${esc(info.membershipStatus || 'ANONYMOUS')}</code>\n` +
            esc(info.reason || ''));
          break;
        }

        const yn = v => v === true ? '⛔ YES' : v === false ? '✅ No' : '❓ unknown';
        const or = (v, d = '—') => (v == null || v === '') ? d : v;
        const onHold = info.hold && info.hold.isUserOnHold;

        const lines = [
          '🎬 <b>Netflix account</b>',
          `📧 Email: <code>${esc(or(info.email))}</code>`,
          `🌍 Country of signup: <b>${esc(or(info.countryOfSignUp))}</b>`,
          `📍 Current country: <code>${esc(or(info.currentCountry))}</code>`,
          `🎫 Membership: <b>${esc(or(info.membershipStatus))}</b>`,
          `📅 Member since: <code>${esc(or(info.memberSince))}</code>`,
          `⏸️ On hold: <b>${yn(onHold)}</b>`,
        ];
        if (onHold) {
          lines.push(
            `   ↳ retry: <code>${esc(or(info.hold.retryEligibility))}</code>, ` +
            `reason: <code>${esc(or(info.hold.serviceEndReason))}</code>`);
        }
        lines.push(`💳 Plan: <b>${esc(or(info.plan && info.plan.name))}</b>`);
        if (info.plan && info.plan.nextBillingDate) {
          lines.push(`   ↳ next billing: <code>${esc(info.plan.nextBillingDate)}</code>`);
        }
        lines.push(`🆔 GUID: <code>${esc(or(info.userGuid))}</code>`);

        if (info.deepLink) {
          lines.push('', '🔑 <b>Login URL (no password):</b>', `<code>${esc(info.deepLink)}</code>`);
        }
        if (info.token) {
          const exp = info.tokenExpiresISO ? ` (expires ${info.tokenExpiresISO})` : '';
          lines.push('', `🎟️ <b>nftoken${esc(exp)}:</b>`, `<code>${esc(info.token)}</code>`);
        } else if (info.tokenError) {
          lines.push('', `🎟️ nftoken: <i>${esc(info.tokenError)}</i>`);
        }

        if (nfCookieNote) lines.unshift(nfCookieNote);

        // Stay under Telegram's 4096-char limit by dropping WHOLE trailing lines,
        // so we never split a <code> tag (malformed HTML makes Telegram reject it).
        while (lines.length > 8 && lines.join('\n').length > 3900) lines.pop();

        await reply(chatId, lines.join('\n'));
      } catch (e) {
        await reply(chatId, `⚠️ Lookup failed: <code>${esc(e.message || String(e))}</code>`);
      }
      break;
    }

    case '/scan':
    case '/batch':
    case '/check': {
      if (!isOwner) { await deny(chatId); break; }
      const urls = arg.match(/https?:\/\/[^\s<>"']+/gi) || [];
      const emails = arg.match(/[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+/gi) || [];
      if (!urls.length) {
        await reply(chatId,
          'Paste one or more login URLs after /scan (emails optional). Example:\n' +
          '<code>/scan\nuser1@mail.com https://link-1\nuser2@mail.com https://link-2</code>');
        break;
      }

      await reply(chatId, `🔎 Scanning <b>${urls.length}</b> link${urls.length === 1 ? '' : 's'} one by one…`);

      let ok = 0, held = 0, failed = 0;
      const rows = [];
      for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        const tag = `${i + 1}/${urls.length}`;
        try {
          const resolved = await resolveCookiesFromUrl(url);
          if (!resolved.netflixCookie) {
            failed++;
            rows.push(`❌ ${tag} no cookies — <code>${esc(shortUrl(url))}</code>`);
            continue;
          }
          const info = await getNetflixInfo(resolved.netflixCookie);
          if (!info.authenticated) {
            failed++;
            rows.push(`❌ ${tag} dead cookie (${esc(info.membershipStatus || 'ANONYMOUS')}) — <code>${esc(shortUrl(url))}</code>`);
            continue;
          }
          const onHold = !!(info.hold && info.hold.isUserOnHold);
          const email = info.email || emails[i] || '—';
          const country = info.countryOfSignUp || '—';
          const membership = info.membershipStatus || '—';
          if (onHold) {
            // Only on-hold accounts are tracked — they go into the /hold list.
            const rec = store.upsert({
              email: info.email || emails[i] || null,
              countryOfSignUp: info.countryOfSignUp || null,
              currentCountry: info.currentCountry || null,
              membershipStatus: info.membershipStatus || null,
              onHold: true,
              hold: info.hold || null,
              plan: info.plan || null,
              cookie: resolved.netflixCookie,
              link: url,
              userGuid: info.userGuid || null,
              status: 'hold',
              updatedAt: new Date().toISOString(),
            });
            held++;
            rows.push(
              `⛔ ${tag} #${rec.id} <code>${esc(email)}</code> — ` +
              `<b>${esc(country)}</b> — ${esc(membership)} — <b>ON HOLD</b>`);
          } else {
            // Not on hold → nothing to fix, so we don't save it.
            ok++;
            rows.push(
              `✅ ${tag} <code>${esc(email)}</code> — ` +
              `<b>${esc(country)}</b> — ${esc(membership)} — not on hold (not saved)`);
          }
        } catch (e) {
          failed++;
          rows.push(`⚠️ ${tag} error: <code>${esc((e.message || String(e)).slice(0, 100))}</code>`);
        }
      }

      const lines = [
        `📊 <b>Scan complete</b> — ${held} on hold (saved), ${ok} ok (not saved), ${failed} failed.`,
        '',
        ...rows,
      ];
      await sendChunked(chatId, lines);
      if (held) {
        await reply(chatId, `Send <code>/hold</code> to see the ${held} on-hold account${held === 1 ? '' : 's'}.`);
      }
      break;
    }

    case '/hold':
    case '/holds': {
      if (!isOwner) { await deny(chatId); break; }
      const list = store.holds();
      if (!list.length) {
        await reply(chatId, 'No on-hold accounts saved. Run <code>/scan</code> with some login URLs first.');
        break;
      }
      // Group by country so every account from the same country is listed
      // together (all US, then UK, then ID …) instead of interleaved in scan
      // order. Countries are alphabetical (unknown last); ids ascending within.
      const countryOf = a => (a.countryOfSignUp && String(a.countryOfSignUp).trim())
        ? String(a.countryOfSignUp).trim().toUpperCase() : '—';
      const numId = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
      const groups = new Map();
      for (const a of list) {
        const key = countryOf(a);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(a);
      }
      const keys = [...groups.keys()].sort((x, y) =>
        x === '—' ? 1 : y === '—' ? -1 : x.localeCompare(y));
      const lines = [`⛔ <b>On-hold accounts (${list.length})</b>`];
      for (const key of keys) {
        const rows = groups.get(key).sort((p, q) => numId(p.id) - numId(q.id));
        lines.push('', `<b>${esc(key)}</b> (${rows.length})`);
        for (const a of rows) {
          lines.push(
            `#${a.id} — <code>${esc(a.email || '—')}</code>` +
            ` — ${esc((a.plan && a.plan.name) || a.membershipStatus || '—')}` +
            (a.hold && a.hold.retryEligibility ? ` — retry: <code>${esc(a.hold.retryEligibility)}</code>` : ''));
        }
      }
      lines.push('', 'Get a login URL with <code>/get &lt;id&gt;</code>, then <code>/done &lt;id&gt;</code> once fixed.');
      await sendChunked(chatId, lines);
      break;
    }

    case '/get':
    case '/update':
    case '/login':
    case '/fix': {
      if (!isOwner) { await deny(chatId); break; }
      const id = (arg.split(/\s+/)[0] || '').replace(/^#/, '');
      const a = store.get(id);
      if (!a) {
        await reply(chatId, `No saved account with id <code>${esc(id || '?')}</code>. Send <code>/hold</code> or <code>/list</code>.`);
        break;
      }
      await reply(chatId, `🔑 Minting a fresh login URL for <code>${esc(a.email || ('#' + a.id))}</code>…`);
      try {
        const info = await getNetflixInfo(a.cookie);
        if (!info.authenticated || !info.deepLink) {
          await reply(chatId,
            '⚠️ Couldn\u2019t make a login URL — the saved cookie may be dead now.\n' +
            `Status: <code>${esc(info.httpStatus)}</code>, membership: <code>${esc(info.membershipStatus || 'ANONYMOUS')}</code>` +
            (info.tokenError ? `\n${esc(info.tokenError)}` : ''));
          break;
        }
        // refresh the saved details while we have a fresh read (status stays
        // 'hold' — only /done can move an account to the fixed /list)
        const freshOnHold = !!(info.hold && info.hold.isUserOnHold);
        store.patch(a.id, {
          onHold: freshOnHold,
          hold: info.hold || a.hold,
          membershipStatus: info.membershipStatus || a.membershipStatus,
          countryOfSignUp: info.countryOfSignUp || a.countryOfSignUp,
          updatedAt: new Date().toISOString(),
        });
        await reply(chatId,
          `🔑 <b>Login URL for ${esc(a.email || ('#' + a.id))}</b> (${esc(a.countryOfSignUp || '—')}):\n` +
          `<code>${esc(info.deepLink)}</code>\n\n` +
          (freshOnHold
            ? `Open it, clear the hold, then send <code>/done ${a.id}</code> — I\u2019ll re-check and move it to <code>/list</code> once it\u2019s fixed.`
            : `ℹ️ This account already reads as <b>not on hold</b>. Send <code>/done ${a.id}</code> to verify and move it to <code>/list</code>.`));
      } catch (e) {
        await reply(chatId, `⚠️ Failed: <code>${esc(e.message || String(e))}</code>`);
      }
      break;
    }

    case '/done':
    case '/resolved': {
      if (!isOwner) { await deny(chatId); break; }
      const id = (arg.split(/\s+/)[0] || '').replace(/^#/, '');
      const a = store.get(id);
      if (!a) {
        await reply(chatId, `No saved account with id <code>${esc(id || '?')}</code>. Send <code>/hold</code>.`);
        break;
      }
      if (a.status === 'fixed') {
        await reply(chatId, `#${esc(a.id)} is already marked fixed — see <code>/list</code>.`);
        break;
      }
      await reply(chatId, `🔁 Re-checking <code>${esc(a.email || ('#' + a.id))}</code> before removing…`);
      let info;
      try {
        info = await getNetflixInfo(a.cookie);
      } catch (e) {
        await reply(chatId, `⚠️ Re-check failed: <code>${esc(e.message || String(e))}</code>. Try again in a moment.`);
        break;
      }
      if (!info.authenticated) {
        await reply(chatId,
          `⚠️ Couldn\u2019t verify #${esc(a.id)} — its saved session is dead now.\n` +
          `Re-run <code>/scan</code> with a fresh login link for <code>${esc(a.email || '—')}</code>, ` +
          `clear the hold, then <code>/done ${esc(a.id)}</code> again.\n` +
          `(To just delete this entry, use <code>/remove ${esc(a.id)}</code>.)`);
        break;
      }
      const stillOnHold = !!(info.hold && info.hold.isUserOnHold);
      if (stillOnHold) {
        // Not fixed — keep it in the hold list, refresh the details.
        store.patch(a.id, {
          onHold: true,
          hold: info.hold || a.hold,
          membershipStatus: info.membershipStatus || a.membershipStatus,
          countryOfSignUp: info.countryOfSignUp || a.countryOfSignUp,
          status: 'hold',
          updatedAt: new Date().toISOString(),
        });
        await reply(chatId,
          `❌ <b>Not fixed.</b> #${esc(a.id)} <code>${esc(a.email || '—')}</code> is still on hold.\n` +
          `Open <code>/get ${esc(a.id)}</code>, clear the hold, then send <code>/done ${esc(a.id)}</code> again.`);
        break;
      }
      // Verified no longer on hold → move it to the fixed /list.
      store.patch(a.id, {
        onHold: false,
        hold: info.hold || null,
        membershipStatus: info.membershipStatus || a.membershipStatus,
        countryOfSignUp: info.countryOfSignUp || a.countryOfSignUp,
        status: 'fixed',
        fixedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await reply(chatId,
        `✅ <b>Fixed!</b> #${esc(a.id)} <code>${esc(a.email || '—')}</code> ` +
        `(${esc(info.countryOfSignUp || a.countryOfSignUp || '—')}) is no longer on hold — moved to <code>/list</code>.`);

      // Ping the configured watcher chat(s) that this hold is now fixed.
      const fixedEmail = a.email || info.email || ('#' + a.id);
      const fixedCountry = info.countryOfSignUp || a.countryOfSignUp || '—';
      const notice = `✅ <b>Hold fixed:</b> <code>${esc(fixedEmail)}</code> (${esc(fixedCountry)}) is no longer on hold.`;
      const notifyFailed = [];
      for (const nid of NOTIFY_CHAT_IDS) {
        if (nid === chatId) continue; // the operator already got the reply above
        const nr = await reply(nid, notice);
        if (!nr || nr.ok !== true) { notifyFailed.push(nid); console.error('notify ' + nid + ' failed:', JSON.stringify(nr)); }
      }
      if (notifyFailed.length) {
        await reply(chatId,
          `⚠️ Couldn\u2019t notify <code>${esc(notifyFailed.join(', '))}</code> — that chat must message this bot once (send it any text), then fix-notifications will go through.`);
      }
      break;
    }

    case '/remove':
    case '/drop': {
      if (!isOwner) { await deny(chatId); break; }
      const id = (arg.split(/\s+/)[0] || '').replace(/^#/, '');
      const a = store.get(id);
      if (!a) {
        await reply(chatId, `No saved account with id <code>${esc(id || '?')}</code>.`);
        break;
      }
      store.remove(id);
      await reply(chatId, `🗑️ Force-removed <code>${esc(a.email || ('#' + a.id))}</code> (${esc(a.countryOfSignUp || '—')}) from the record.`);
      break;
    }

    case '/list': {
      if (!isOwner) { await deny(chatId); break; }
      const list = store.fixed();
      if (!list.length) {
        await reply(chatId,
          'No fixed accounts yet. Clear a hold with <code>/get &lt;id&gt;</code>, ' +
          'then confirm with <code>/done &lt;id&gt;</code> to move it here.');
        break;
      }
      const lines = [`📒 <b>Fixed accounts (${list.length})</b>`, ''];
      for (const a of list) {
        const when = a.fixedAt ? ` — <i>${esc(String(a.fixedAt).slice(0, 10))}</i>` : '';
        lines.push(
          `✅ #${esc(a.id)} — <code>${esc(a.email || '—')}</code> — ` +
          `<b>${esc(a.countryOfSignUp || '—')}</b> — ${esc(a.membershipStatus || '—')}${when}`);
      }
      await sendChunked(chatId, lines);
      break;
    }

    case '/clear': {
      if (!isOwner) { await deny(chatId); break; }
      if ((arg.split(/\s+/)[0] || '').toLowerCase() !== 'yes') {
        await reply(chatId, `This wipes all ${store.all().length} saved account(s). Send <code>/clear yes</code> to confirm.`);
        break;
      }
      store.clear();
      await reply(chatId, '🗑️ Record cleared.');
      break;
    }

    default:
      if (isOwner && cmd.startsWith('/')) {
        await reply(chatId, 'Unknown command. Send /help.');
      }
      break;
  }
}

// ─── Long-polling loop ─────────────────────────────────────────────────────────
async function pollLoop() {
  // A webhook and getUpdates can't both be active — remove any existing webhook
  // (this also clears the old cigaop.club webhook that returned 406).
  const del = await tg('deleteWebhook', { drop_pending_updates: true });
  console.log('deleteWebhook:', JSON.stringify(del));

  let offset = 0;
  console.log('Bot started. Long-polling for updates…');

  while (true) {
    try {
      const r = await fetchJson(`${API}/getUpdates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          offset,
          timeout: 50,
          allowed_updates: ['message', 'edited_message'],
        }),
      }, 65000);

      const data = r.json;
      if (data && data.ok && Array.isArray(data.result)) {
        for (const u of data.result) {
          offset = u.update_id + 1;
          // Fire-and-forget so a slow IMAP lookup doesn't stall polling.
          handleUpdate(u).catch(e => console.error('handleUpdate error:', e.message));
        }
      } else if (data && !data.ok) {
        console.error('getUpdates not ok:', JSON.stringify(data));
        await sleep(3000);
      }
    } catch (e) {
      console.error('getUpdates failed:', e.message);
      await sleep(3000);
    }
  }
}

// ─── Tiny health page (so Railway sees an open port + you can check status) ─────
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(
    'Netflix Tools Bot (long-polling) is running.\n' +
    '-----------------------------------\n' +
    `Node          : ${process.version}\n` +
    `Bot token     : ${BOT_TOKEN ? 'configured' : 'NOT SET — set BOT_TOKEN'}\n` +
    `Allowlist IDs : ${ALLOWED_CHAT_IDS.length} (send /id to the bot to get yours)\n` +
    `Tool URL      : ${TOOL_URL}\n` +
    '-----------------------------------\n' +
    'This page just means the service is up. The bot talks to Telegram by polling.\n'
  );
}).listen(PORT, () => console.log(`Health server on :${PORT}`));

// ─── Boot ──────────────────────────────────────────────────────────────────────
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is not set. Add it in Railway → Variables, then redeploy.');
} else {
  pollLoop().catch(e => {
    console.error('Fatal poll loop error:', e);
    process.exit(1); // Railway will restart the service
  });
}
