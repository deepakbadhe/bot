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
const { getNetflixInfo } = require('./nf-account');

// ─── CONFIG (from environment) ────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const TOOL_URL  = process.env.TOOL_URL  || 'https://cigaop.club/verificationcode/';
const ALLOWED_CHAT_IDS = (process.env.ALLOWED_CHAT_IDS || '')
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
        '/code <i>email</i> — get the Netflix verification code\n' +
        '/reset <i>email</i> — get the password reset link\n' +
        '/cookies <i>url</i> — fetch a URL and list its Set-Cookie headers\n' +
        '/nf <i>cookie</i> — Netflix account details from a session cookie\n' +
        '/id — show your Telegram ID\n' +
        '/ping — check the bot is alive');
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
      if (!arg || !/NetflixId=/.test(arg)) {
        await reply(chatId,
          'Usage: <code>/nf NetflixId=…; SecureNetflixId=…;</code>\n' +
          'Paste the account\u2019s Netflix session cookie (must include NetflixId).');
        break;
      }

      await reply(chatId, '🔍 Reading Netflix account…');

      try {
        const info = await getNetflixInfo(arg);

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

        // Stay under Telegram's 4096-char limit by dropping WHOLE trailing lines,
        // so we never split a <code> tag (malformed HTML makes Telegram reject it).
        while (lines.length > 8 && lines.join('\n').length > 3900) lines.pop();

        await reply(chatId, lines.join('\n'));
      } catch (e) {
        await reply(chatId, `⚠️ Lookup failed: <code>${esc(e.message || String(e))}</code>`);
      }
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
