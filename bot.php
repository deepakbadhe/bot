<?php
/**
 * Telegram Bot — webhook handler for cigaop.club
 * ---------------------------------------------------------------------------
 * Send commands in Telegram → Telegram POSTs here → this script runs → replies.
 *
 * SETUP (do these once):
 *   1) Message @BotFather in Telegram → /newbot → copy the TOKEN below.
 *   2) Put a long random string in WEBHOOK_SECRET below (e.g. 40 random chars).
 *   3) Upload this file to your site, e.g. https://cigaop.club/bot.php
 *   4) Register the webhook ONCE by opening this URL in your browser
 *      (replace <TOKEN> and <SECRET> with the same values you set below):
 *
 *      https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://cigaop.club/bot.php&secret_token=<SECRET>
 *
 *   5) In Telegram, send the bot /id → it replies with your numeric ID.
 *      Put that number in ALLOWED_CHAT_IDS below, then re-upload this file.
 *   6) Done. Only you can now run the real commands.
 *
 *   Check status any time:  https://api.telegram.org/bot<TOKEN>/getWebhookInfo
 * ---------------------------------------------------------------------------
 */

// ─── CONFIG ──────────────────────────────────────────────────────────────────
// Keep the token secret. Anyone with it controls your bot.
const BOT_TOKEN      = '8673434335:AAEOgdd12k3LK53R9v4aCXTyinxhdKdGP50';
const WEBHOOK_SECRET = 'deepakbadhe';   // must match secret_token in setWebhook

// Only these Telegram IDs can run real commands. Send /id to the bot to find yours.
const ALLOWED_CHAT_IDS = [
    // 123456789,
];

// Your existing verification-code tool (the AJAX one with the JSON API).
// Set this to wherever it actually lives on your host.
const TOOL_URL = 'https://cigaop.club/verificationcode/';

// ─── Telegram helpers ────────────────────────────────────────────────────────
function tg(string $method, array $params): array {
    $ch = curl_init('https://api.telegram.org/bot' . BOT_TOKEN . '/' . $method);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => $params,
        CURLOPT_TIMEOUT        => 20,
    ]);
    $res = curl_exec($ch);
    curl_close($ch);
    return json_decode((string)$res, true) ?: [];
}

function reply(int $chat_id, string $text): void {
    tg('sendMessage', [
        'chat_id'                  => $chat_id,
        'text'                     => $text,
        'parse_mode'               => 'HTML',
        'disable_web_page_preview' => true,
    ]);
}

// Ack Telegram immediately, then keep running. This stops slow IMAP lookups
// from tripping Telegram's webhook timeout (which causes duplicate messages).
function ack_telegram(): void {
    http_response_code(200);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'ok';
    if (function_exists('fastcgi_finish_request')) {
        fastcgi_finish_request();
    } elseif (function_exists('litespeed_finish_request')) {
        litespeed_finish_request();
    } else {
        @ob_end_flush();
        @flush();
    }
}

// ─── Security: only accept requests carrying Telegram's secret header ─────────
$hdr = $_SERVER['HTTP_X_TELEGRAM_BOT_API_SECRET_TOKEN'] ?? '';
if (!hash_equals(WEBHOOK_SECRET, $hdr)) {
    http_response_code(403);
    exit('forbidden');
}

// ─── Read the incoming update ────────────────────────────────────────────────
$update = json_decode(file_get_contents('php://input'), true);
$msg    = $update['message'] ?? $update['edited_message'] ?? null;

// Ack right away; ignore anything that isn't a normal message.
ack_telegram();
@set_time_limit(120);
if (!$msg) { exit; }

$chat_id = (int)($msg['chat']['id'] ?? 0);
$text    = trim($msg['text'] ?? '');
$is_owner = in_array($chat_id, ALLOWED_CHAT_IDS, true);

// ─── Parse command + argument ────────────────────────────────────────────────
$parts = preg_split('/\s+/', $text, 2);
$cmd   = strtolower($parts[0] ?? '');
$cmd   = preg_replace('/@.*$/', '', $cmd);   // strip @BotName in groups
$arg   = trim($parts[1] ?? '');

// ─── Command router ──────────────────────────────────────────────────────────
switch ($cmd) {

    case '/id':
        // Open to everyone so you can discover your ID during setup.
        reply($chat_id, "Your Telegram ID: <code>$chat_id</code>");
        break;

    case '/start':
    case '/help':
        if (!$is_owner) {
            reply($chat_id, "Not authorized.\nYour ID: <code>$chat_id</code>\nAsk the owner to add it to the allowlist.");
            break;
        }
        reply($chat_id,
            "<b>Netflix Tools Bot</b>\n\n" .
            "/code <i>email</i> — get the Netflix verification code\n" .
            "/reset <i>email</i> — get the password reset link\n" .
            "/id — show your Telegram ID\n" .
            "/ping — check the bot is alive"
        );
        break;

    case '/ping':
        if (!$is_owner) { deny($chat_id); break; }
        reply($chat_id, "✅ pong");
        break;

    case '/code':
    case '/reset':
        if (!$is_owner) { deny($chat_id); break; }
        if ($arg === '' || !filter_var($arg, FILTER_VALIDATE_EMAIL)) {
            reply($chat_id, "Usage: <code>$cmd someone@email.com</code>");
            break;
        }
        $action = $cmd === '/reset' ? 'reset' : 'signin';
        reply($chat_id, "🔍 Searching for <code>" . htmlspecialchars($arg) . "</code>…");

        $value = fetch_from_tool($arg, $action);
        $label = $action === 'reset' ? 'Reset link' : 'Verification code';

        if ($value === null) {
            reply($chat_id, "⚠️ Could not reach the tool. Try again in a moment.");
        } elseif ($value === '') {
            reply($chat_id, "❌ No $label found for <code>" . htmlspecialchars($arg) . "</code> in the last 24 hours.");
        } else {
            reply($chat_id, "✅ $label for <code>" . htmlspecialchars($arg) . "</code>:\n<b>" . htmlspecialchars($value) . "</b>");
        }
        break;

    default:
        if ($is_owner && strpos($cmd, '/') === 0) {
            reply($chat_id, "Unknown command. Send /help.");
        }
        break;
}

exit;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function deny(int $chat_id): void {
    reply($chat_id, "⛔ Not authorized. Your ID: <code>$chat_id</code>");
}

/**
 * Calls your verification-code tool's JSON API and returns:
 *   - the code / reset link string on success
 *   - '' if nothing was found
 *   - null on a transport error (tool unreachable)
 */
function fetch_from_tool(string $email, string $action): ?string {
    $ch = curl_init(TOOL_URL);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST           => true,
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json', 'X-Inbox-Action: ' . $action],
        CURLOPT_POSTFIELDS     => json_encode(['emails' => [$email]]),
        CURLOPT_TIMEOUT        => 90,
    ]);
    $res  = curl_exec($ch);
    $http = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($res === false || $http >= 400) return null;

    $data = json_decode((string)$res, true);
    if (!is_array($data) || !isset($data[0])) return null;

    $key = $action === 'reset' ? 'link' : 'code';
    return (string)($data[0][$key] ?? '');
}
?>
