# Netflix Tools — Telegram Bot (Railway)

A tiny Telegram bot that fetches Netflix **verification codes** and **password-reset
links** from your existing tool at `https://cigaop.club/verificationcode/`.

It uses **long-polling**, not a webhook, so it never touches your site's firewall
(Imunify360) — which was returning `406` to Telegram. Zero npm dependencies
(uses Node 18+ built-in `fetch`).

---

## Deploy on Railway

### Option A — from GitHub (recommended)
1. Put these files (`bot.js`, `nf-account.js`, `package.json`, `.gitignore`, `README.md`) in a GitHub repo.
2. Go to **railway.app → New Project → Deploy from GitHub repo** → pick the repo.
3. Open the service → **Variables** tab → add:
   | Variable | Value |
   |---|---|
   | `BOT_TOKEN` | your @BotFather token |
   | `ALLOWED_CHAT_IDS` | your numeric Telegram ID (comma-separated for several) |
   | `TOOL_URL` | *(optional)* `https://cigaop.club/verificationcode/` |
4. Railway builds and starts it automatically. Open the **Deploy Logs** — you should see
   `Bot started. Long-polling for updates…`.

### Option B — from your computer (Railway CLI)
```bash
npm i -g @railway/cli
railway login
railway init          # create a project
railway up            # deploy this folder
```
Then add the same variables in the Railway dashboard.

---

## First run
1. After it's deployed, message your bot **`/id`** in Telegram — it replies with your
   numeric ID (this command works even before you're in the allowlist).
2. Put that number into the **`ALLOWED_CHAT_IDS`** variable → Railway redeploys.
3. Now use it:
   - `/code someone@email.com` — Netflix verification code
   - `/reset someone@email.com` — password-reset link
   - `/cookies https://example.com` — fetch a URL and list its `Set-Cookie` headers
   - `/nf https://your-login-url` — extract the Netflix session cookie from a login URL
     (follows redirects, harvests `NetflixId`/`SecureNetflixId`), then reports the account:
     country of signup, membership status, **on-hold**, plan, member-since, email, plus a
     no-password login URL (`nftoken` deep link). You can also paste a cookie directly:
     `/nf NetflixId=…; SecureNetflixId=…;`
   - `/scan <links…>` — paste many login URLs at once (emails optional); the bot processes
     them one by one, reads each account, and saves the results. Reports how many loaded and
     how many are on hold.
   - `/hold` — list the saved **on-hold** accounts with their country and plan.
   - `/update <id>` — mint a fresh no-password login URL for that account (from its saved
     cookie) so you can open it and clear the hold.
   - `/done <id>` — remove an account from the record after you've fixed it.
   - `/list` — show every saved account · `/clear yes` — wipe the record.

   The scanned record is stored in `records.json` next to the bot. Set `DATA_DIR` to a
   Railway **Volume** mount path if you want it to survive restarts and redeploys; otherwise
   it resets when the service restarts.
   - `/ping` — check it's alive
   - `/help` — command list

---

## Notes
- **No webhook needed.** On startup the bot deletes any existing webhook (including the
  old cigaop.club one that returned 406). Run only **one** instance per bot token,
  otherwise Telegram returns `409 Conflict`.
- The bot talks to your tool with a normal browser User-Agent, so Imunify360 lets it
  through (an empty User-Agent would get 406 there too).
- Health check: open the Railway service URL in a browser — it shows a plain status page.
- **Railway's $5 trial credit is one-time** (roughly a few weeks for a small always-on
  service). For a permanent free setup, run this same `bot.js` on your droplet — it's
  already always-on and runs Node.
