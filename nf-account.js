'use strict';

/**
 * Netflix account inspector — Node port of token-ui.php, extended.
 * ---------------------------------------------------------------------------
 * Give it a Netflix SESSION cookie (the `NetflixId=...; SecureNetflixId=...;`
 * string your panel stores per account) and it returns, in one call:
 *
 *   • token / tokenExpires  — the nftoken minted by Netflix's iOS FTL API
 *                             (same value the PHP used for the /unsupported deep link)
 *   • email, userGuid
 *   • countryOfSignUp, currentCountry
 *   • membershipStatus      — CURRENT_MEMBER | FORMER_MEMBER | NEVER_MEMBER | ANONYMOUS
 *   • memberSince
 *   • onHold + hold{}        — from the /account `growthHoldMetadata` object
 *                             (isUserOnHold, retryEligibility, serviceEndReason)
 *   • plan{}                 — currentPlan (populated for paying members, null otherwise)
 *
 * WHY THIS WORKS (and the login flow doesn't): reading /account with a valid
 * session cookie is captcha-free. On-hold is NOT reflected by membershipStatus
 * (an on-hold account still says CURRENT_MEMBER) — the reliable signal is
 * growthHoldMetadata.isUserOnHold in the /account reactContext.
 *
 * No dependencies — uses Node 18+ global fetch.
 *
 *   CLI:  node nf-account.js "NetflixId=...; SecureNetflixId=...;"
 *   Lib:  const { getNetflixInfo } = require('./nf-account');
 *         const info = await getNetflixInfo(cookieString);
 */

const REQUEST_TIMEOUT = 30000;
const IOS_TOKEN_URL = 'https://ios.prod.ftl.netflix.com/iosui/user/15.48';
const ACCOUNT_URL   = 'https://www.netflix.com/account';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── generic helpers ────────────────────────────────────────────────────────
function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

// Netflix embeds its reactContext JSON with \xHH / \uHHHH / \/ escapes.
function decodeNfString(s) {
  if (s == null) return null;
  const out = String(s)
    .replace(/\\x([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\//g, '/')
    .replace(/\u00A0/g, ' ')
    .trim();
  return out !== '' ? out : null;
}

function firstMatch(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1] != null && m[1] !== '') return m[1];
  }
  return null;
}

// Read a balanced {...} (or literal null) that follows `keyToken` in `text`.
function extractBalanced(text, keyToken) {
  let i = text.indexOf(keyToken);
  if (i < 0) return undefined;
  i += keyToken.length;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text.startsWith('null', i)) return null;
  if (text[i] !== '{') return undefined;
  let depth = 0;
  const start = i;
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return decodeNfString(text.slice(start, i + 1)); }
  }
  return undefined;
}

function extractNetflixId(rawCookie) {
  const m = String(rawCookie).match(/NetflixId=([^;]+)/);
  if (!m) return null;
  let v = m[1].trim();
  if (/%[0-9A-Fa-f]{2}/.test(v)) { try { v = decodeURIComponent(v); } catch (_) {} }
  return v;
}

// ─── iOS FTL token API (mints the nftoken) ──────────────────────────────────
const IOS_CONFIG = '{"gamesInTrailersEnabled":"false","isTrailersEvidenceEnabled":"false","cdsMyListSortEnabled":"true","kidsBillboardEnabled":"true","addHorizontalBoxArtToVideoSummariesEnabled":"false","skOverlayTestEnabled":"false","homeFeedTestTVMovieListsEnabled":"false","baselineOnIpadEnabled":"true","trailersVideoIdLoggingFixEnabled":"true","postPlayPreviewsEnabled":"false","bypassContextualAssetsEnabled":"false","roarEnabled":"false","useSeason1AltLabelEnabled":"false","disableCDSSearchPaginationSectionKinds":["searchVideoCarousel"],"cdsSearchHorizontalPaginationEnabled":"true","searchPreQueryGamesEnabled":"true","kidsMyListEnabled":"true","billboardEnabled":"true","useCDSGalleryEnabled":"true","contentWarningEnabled":"true","videosInPopularGamesEnabled":"true","avifFormatEnabled":"false","sharksEnabled":"true"}';
const IOS_ESN = 'NFAPPL-02-IPHONE8=1-PXA-02026U9VV5O8AUKEAEO8PUJETCGDD4PQRI9DEB3MDLEMD0EACM4CS78LMD334MN3MQ3NMJ8SU9O9MVGS6BJCURM1PH1MUTGDPF4S4200';

function iosTokenParams() {
  return new URLSearchParams({
    appVersion: '15.48.1', config: IOS_CONFIG, device_type: 'NFAPPL-02-', esn: IOS_ESN,
    idiom: 'phone', iosVersion: '15.8.5', isTablet: 'false', languages: 'en-US', locale: 'en-US',
    maxDeviceWidth: '375', model: 'saget', modelType: 'IPHONE8-1', odpAware: 'true',
    path: '["account","token","default"]', pathFormat: 'graph', pixelDensity: '2.0',
    progressive: 'false', responseFormat: 'json',
  });
}

function iosTokenHeaders() {
  return {
    'User-Agent': 'Argo/15.48.1 (iPhone; iOS 15.8.5; Scale/2.00)',
    'x-netflix.request.attempt': '1',
    'x-netflix.request.client.user.guid': 'A4CS633D7VCBPE2GPK2HL4EKOE',
    'x-netflix.context.profile-guid': 'A4CS633D7VCBPE2GPK2HL4EKOE',
    'x-netflix.request.routing': '{"path":"/nq/mobile/nqios/~15.48.0/user","control_tag":"iosui_argo"}',
    'x-netflix.context.app-version': '15.48.1',
    'x-netflix.argo.translated': 'true',
    'x-netflix.context.form-factor': 'phone',
    'x-netflix.context.sdk-version': '2012.4',
    'x-netflix.client.appversion': '15.48.1',
    'x-netflix.context.max-device-width': '375',
    'x-netflix.tracing.cl.useractionid': '4DC655F2-9C3C-4343-8229-CA1B003C3053',
    'x-netflix.client.type': 'argo',
    'x-netflix.client.ftl.esn': IOS_ESN,
    'x-netflix.context.locales': 'en-US',
    'x-netflix.context.top-level-uuid': '90AFE39F-ADF1-4D8A-B33E-528730990FE3',
    'x-netflix.client.iosversion': '15.8.5',
    'accept-language': 'en-US;q=1',
    'x-netflix.context.os-version': '15.8.5',
    'x-netflix.request.client.context': '{"appState":"foreground"}',
    'x-netflix.context.ui-flavor': 'argo',
    'x-netflix.argo.nfnsm': '9',
    'x-netflix.context.pixel-density': '2.0',
    'x-netflix.request.toplevel.uuid': '90AFE39F-ADF1-4D8A-B33E-528730990FE3',
    'x-netflix.request.client.timezoneid': 'Asia/Kolkata',
  };
}

async function getNftoken(cookie) {
  const netflixId = extractNetflixId(cookie);
  if (!netflixId) throw new Error('No NetflixId found in cookie');
  const url = IOS_TOKEN_URL + '?' + iosTokenParams().toString();
  const to = withTimeout(REQUEST_TIMEOUT);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { ...iosTokenHeaders(), Cookie: 'NetflixId=' + netflixId, Accept: '*/*' },
      signal: to.signal,
    });
    const text = await res.text();
    if (res.status !== 200) throw new Error('iOS token API HTTP ' + res.status + ': ' + text.slice(0, 160));
    let data;
    try { data = JSON.parse(text); } catch (_) { throw new Error('Bad JSON from iOS token API'); }
    const td = (data && data.value && data.value.account && data.value.account.token && data.value.account.token.default) || {};
    if (!td.token) return { token: null, expires: null };
    let expiresUnix = null;
    if (td.expires != null && !isNaN(td.expires)) {
      const n = Math.trunc(Number(td.expires));
      expiresUnix = String(Math.abs(n)).length === 13 ? Math.floor(n / 1000) : n;
    }
    return { token: td.token, expires: expiresUnix };
  } finally { to.done(); }
}

// ─── /account read (country, membership, hold, plan) ────────────────────────
async function getAccountInfo(cookie) {
  const to = withTimeout(REQUEST_TIMEOUT);
  let res, body;
  try {
    res = await fetch(ACCOUNT_URL, {
      method: 'GET',
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        Cookie: cookie,
      },
      redirect: 'follow',
      signal: to.signal,
    });
    body = await res.text();
  } finally { to.done(); }

  const finalUrl = res.url || '';
  const membershipStatus = firstMatch(body, [/"membershipStatus":"([A-Z_]+)"/]);
  const authenticated = !/\/login/.test(finalUrl) && membershipStatus != null && membershipStatus !== 'ANONYMOUS';

  if (!authenticated) {
    return {
      authenticated: false,
      reason: /\/login/.test(finalUrl)
        ? 'Cookie expired or invalid (Netflix redirected to /login)'
        : 'Not authenticated (no member reactContext)',
      httpStatus: res.status,
      finalUrl,
      membershipStatus: membershipStatus || 'ANONYMOUS',
    };
  }

  const isUserOnHold = (() => {
    const m = body.match(/"growthHoldMetadata":\{[^}]*?"isUserOnHold":(true|false)/);
    return m ? m[1] === 'true' : null;
  })();

  return {
    authenticated: true,
    httpStatus: res.status,
    finalUrl,
    email: decodeNfString(firstMatch(body, [/"emailAddress":"([^"]+)"/])),
    userGuid: firstMatch(body, [/"userGuid":"([A-Z0-9]+)"/]),
    countryOfSignUp: firstMatch(body, [
      /"countryOfSignUp":\{[^}]*?"code":"([A-Z]{2,3})"/,
      /"countryOfSignup":"([A-Z]{2,3})"/,
    ]),
    currentCountry: firstMatch(body, [/"currentCountry":"([A-Z]{2,3})"/]),
    membershipStatus,
    memberSince: decodeNfString(firstMatch(body, [/"memberSince":"([^"]+)"/])),
    onHold: isUserOnHold === true,
    hold: {
      isUserOnHold,
      retryEligibility: firstMatch(body, [/"growthHoldMetadata":\{[^}]*?"retryEligibility":"([A-Z_]+)"/]),
      serviceEndReason: firstMatch(body, [/"growthHoldMetadata":\{[^}]*?"serviceEndReason":"([A-Z_]+)"/]),
    },
    plan: {
      name: decodeNfString(firstMatch(body, [/"localizedPlanName":"([^"]+)"/, /"formattedPlanName":"([^"]+)"/])),
      nextBillingDate: decodeNfString(firstMatch(body, [/"nextBillingDate":"([^"]+)"/])),
      currentPlan: extractBalanced(body, '"currentPlan":'), // null for non-paying members
    },
  };
}

// ─── one-shot combined lookup ───────────────────────────────────────────────
async function getNetflixInfo(cookie) {
  if (!cookie || typeof cookie !== 'string') throw new Error('A cookie string is required');

  const account = await getAccountInfo(cookie);

  let token = null, tokenExpires = null, tokenError = null;
  try {
    const t = await getNftoken(cookie);
    token = t.token;
    tokenExpires = t.expires;
  } catch (e) { tokenError = e.message; }

  return {
    ...account,
    token,
    tokenExpires,
    tokenExpiresISO: tokenExpires ? new Date(tokenExpires * 1000).toISOString() : null,
    ...(tokenError ? { tokenError } : {}),
    deepLink: token ? 'https://www.netflix.com/unsupported?nftoken=' + encodeURIComponent(token) : null,
  };
}

module.exports = { getNetflixInfo, getAccountInfo, getNftoken, extractNetflixId };

// ─── CLI ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const cookie = process.argv.slice(2).join(' ').trim();
  if (!cookie) {
    console.error('Usage: node nf-account.js "NetflixId=...; SecureNetflixId=...;"');
    process.exit(1);
  }
  getNetflixInfo(cookie)
    .then(info => console.log(JSON.stringify(info, null, 2)))
    .catch(e => { console.error('Error:', e.message); process.exit(1); });
}
