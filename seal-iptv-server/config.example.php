<?php
/* =====================================================================
 * Seal IPTV Sync Server — config.php
 * ---------------------------------------------------------------------
 * Copy this file to config.php and set your own setup code. It's the
 * only file you should ever need to edit.
 *
 * Opening it in a browser shows nothing (see the guard just below) and
 * .htaccess blocks it as well.
 *
 * Sections:
 *   1. Direct-access guard
 *   2. Setup code (used once, to create your vault)
 *   3. Where the encrypted vault is stored
 *   4. Security switches
 *   5. Limits
 * ===================================================================== */

/* ---------------------------------------------------------------------
 * 1. DIRECT-ACCESS GUARD
 *    api.php / index.php define SEALIPTV before loading this file.
 * ------------------------------------------------------------------- */
if (!defined('SEALIPTV')) {
    http_response_code(404);
    exit;
}

return [

    /* -----------------------------------------------------------------
     * 2. SETUP CODE
     *    Seal IPTV asks for this code the first time you choose
     *    "Create a new vault". It stops anyone else who finds this page
     *    from creating the vault before you do. Choose something long.
     *    After your vault exists the code isn't accepted for anything.
     *    The example value below is refused on purpose.
     * --------------------------------------------------------------- */
    'setup_code' => 'CHANGE-THIS-CODE',

    /* -----------------------------------------------------------------
     * 3. VAULT LOCATION
     *    Folder that holds vault.sqlite (everything in it is encrypted
     *    by Seal IPTV before it is sent here).
     *    '' = automatic: a folder named "seal-iptv-data" one level ABOVE
     *         your public web folder, e.g. /home/username/seal-iptv-data
     *         — it can never be downloaded through the website.
     *    Or give a full path, e.g. '/home/username/seal-iptv-data'.
     * --------------------------------------------------------------- */
    'data_dir' => '',

    /* -----------------------------------------------------------------
     * 4. SECURITY SWITCHES
     *    require_https: refuse requests that didn't arrive over HTTPS
     *                   (requests from the server itself — localhost —
     *                   are always allowed, for testing).
     *    login_failures_per_user / per_ip: wrong passphrases allowed in
     *                   'lockout_minutes' before that username / that
     *                   internet address has to wait.
     * --------------------------------------------------------------- */
    'require_https'          => true,
    'login_failures_per_user'=> 5,
    'login_failures_per_ip'  => 20,
    'lockout_minutes'        => 15,

    /* -----------------------------------------------------------------
     * 5. LIMITS
     *    max_item_kb:     largest single synced item after encryption
     *                     (one playlist, one favorite, one watched mark …)
     *    max_items:       most items one vault may hold (every watched
     *                     episode is one item)
     *    max_request_mb:  largest single upload from Seal IPTV
     * --------------------------------------------------------------- */
    'max_item_kb'    => 256,
    'max_items'      => 100000,
    'max_request_mb' => 16,
];
