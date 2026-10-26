<?php
/* =====================================================================
 * Seal IPTV Sync Server — index.php   (the status page)
 * ---------------------------------------------------------------------
 * Open https://your-site/iptv-sync/ after uploading: every line should
 * be green. It shows nothing about your data (there's nothing readable
 * here anyway), only whether the server is set up correctly.
 * ===================================================================== */
declare(strict_types=1);
define('SEALIPTV', 1);
require __DIR__ . '/lib.php';
ini_set('display_errors', '0');

$checks = [];
$add = function (bool $ok, string $text, string $fix = '') use (&$checks) { $checks[] = [$ok, $text, $fix]; };

$add(PHP_VERSION_ID >= 80000, 'PHP ' . PHP_VERSION, 'Seal IPTV Sync needs PHP 8.0 or newer (cPanel → Select PHP Version).');
$sqlite = class_exists('PDO') && in_array('sqlite', PDO::getAvailableDrivers(), true);
$add($sqlite, 'SQLite (pdo_sqlite)', 'Turn on pdo_sqlite in cPanel → Select PHP Version → Extensions.');
$add(function_exists('random_bytes') && function_exists('password_hash'), 'Secure random numbers and password hashing');
$add(defined('PASSWORD_ARGON2ID'), 'Argon2id password hashing', 'Not required: bcrypt is used instead. Argon2id is a little stronger.');
$add(is_file(__DIR__ . '/config.php'), 'config.php exists', 'Copy config.example.php to config.php.');
$code = trim((string) cfg('setup_code'));
$add($code !== '' && strtoupper($code) !== 'CHANGE-THIS-CODE', 'Your own setup code is set', 'Set setup_code in config.php to something only you know.');
$add(is_https() || is_localhost(), 'HTTPS', 'Open this page with https://. In cPanel, run SSL/TLS Status → AutoSSL for this domain.');

$dir = data_dir();
$inWeb = ($root = realpath((string) ($_SERVER['DOCUMENT_ROOT'] ?? ''))) && ($real = realpath(is_dir($dir) ? $dir : dirname($dir))) && str_starts_with($real . '/', rtrim($root, '/') . '/');
$vault = null;
if ($sqlite) {
    try {
        $pdo = @db();
        $vault = vault_has_users();
        $add(true, 'Vault folder can be written', '');
    } catch (Throwable $e) {
        $add(false, 'Vault folder can be written', 'Check data_dir in config.php.');
    }
}
$add(!$inWeb, 'Vault folder is outside the website', 'Set data_dir in config.php to a folder above public_html.');

$allOk = !array_filter($checks, fn($c) => !$c[0] && $c[2] !== '' && !str_starts_with($c[2], 'Not required'));
header('Content-Type: text/html; charset=utf-8');
header('X-Robots-Tag: noindex, nofollow');
header('Referrer-Policy: no-referrer');
?><!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Seal IPTV Sync</title>
<style>
  :root { --bg:#121418; --card:#181b21; --line:#2c313b; --text:#e6e8ec; --muted:#a3a9b5; --ok:#3ccf91; --bad:#ff6464; --warn:#f0b445; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 "Segoe UI", system-ui, -apple-system, sans-serif; padding: 32px 16px; }
  main { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; } p { color: var(--muted); margin: 0 0 18px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 6px 16px; }
  .row { display: flex; gap: 12px; padding: 10px 0; border-top: 1px solid var(--line); }
  .row:first-child { border-top: 0; }
  .dot { width: 10px; height: 10px; border-radius: 50%; margin-top: 7px; flex: none; }
  .ok .dot { background: var(--ok); } .bad .dot { background: var(--bad); } .warn .dot { background: var(--warn); }
  .fix { color: var(--muted); font-size: 13px; }
  .sum { margin-top: 16px; padding: 12px 16px; border-radius: 10px; background: var(--card); border-left: 4px solid <?= $allOk ? 'var(--ok)' : 'var(--bad)' ?>; }
  code { background: #0d0f12; padding: 1px 6px; border-radius: 5px; }
</style></head>
<body><main>
  <h1>Seal IPTV Sync Server <?= htmlspecialchars(SEALIPTV_SERVER_VERSION) ?></h1>
  <p>Keeps your Seal IPTV installs in sync. Everything stored here is encrypted by Seal IPTV first.</p>
  <div class="card">
  <?php foreach ($checks as [$ok, $text, $fix]): $cls = $ok ? 'ok' : (str_starts_with($fix, 'Not required') ? 'warn' : 'bad'); ?>
    <div class="row <?= $cls ?>"><span class="dot"></span><div><?= htmlspecialchars($text) ?><?php if (!$ok && $fix): ?><div class="fix"><?= htmlspecialchars($fix) ?></div><?php endif; ?></div></div>
  <?php endforeach; ?>
  </div>
  <div class="sum">
    <?php if (!$allOk): ?>Fix the red lines above, then reload this page.
    <?php elseif ($vault): ?>Ready. A vault exists — in Seal IPTV choose Settings → Sync → <b>Connect</b>.
    <?php else: ?>Ready. In Seal IPTV choose Settings → Sync → <b>Create a new vault</b>, with this address and your setup code.
    <?php endif; ?>
    <div class="fix" style="margin-top:6px">Server address for Seal IPTV: <code><?= htmlspecialchars((is_https() ? 'https://' : 'http://') . ($_SERVER['HTTP_HOST'] ?? 'your-site') . rtrim(dirname($_SERVER['SCRIPT_NAME'] ?? '/'), '/') . '/') ?></code></div>
  </div>
</main></body></html>
