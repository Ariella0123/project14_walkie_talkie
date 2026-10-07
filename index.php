<?php
declare(strict_types=1);

const ROOT = __DIR__;

function env(string $key, string $default = ''): string {
    static $values = null;
    if ($values === null) {
        $values = [];
        $file = ROOT . DIRECTORY_SEPARATOR . '.env';
        if (is_file($file)) {
            foreach (file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
                $line = trim($line);
                if ($line === '' || str_starts_with($line, '#') || !str_contains($line, '=')) continue;
                [$name, $value] = explode('=', $line, 2);
                $values[trim($name)] = trim($value, " \t\n\r\0\x0B\"'");
            }
        }
    }
    return $values[$key] ?? $default;
}

date_default_timezone_set('UTC');
session_set_cookie_params(['httponly' => true, 'samesite' => 'Lax', 'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off']);
session_start();

$storage = ROOT . DIRECTORY_SEPARATOR . 'storage';
foreach ([$storage, "$storage/rooms", "$storage/logs"] as $dir) {
    if (!is_dir($dir)) mkdir($dir, 0770, true);
}

function jsonResponse(array $data, int $status = 200): never {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_SLASHES);
    exit;
}
function body(): array {
    $raw = file_get_contents('php://input') ?: '';
    if (strlen($raw) > (int)env('SIGNAL_MAX_BODY', '32768')) jsonResponse(['error' => 'Payload too large'], 413);
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}
function clean(string $value, int $max): string {
    $value = trim(preg_replace('/[^\p{L}\p{N}_ .-]/u', '', $value) ?? '');
    return mb_substr($value, 0, $max);
}
function roomFile(string $room): string { return ROOT . '/storage/rooms/' . hash('sha256', $room) . '.json'; }
function signedToken(string $peer, string $nickname, string $room): string {
    $payload = ['peer' => $peer, 'nickname' => $nickname, 'room' => $room, 'exp' => time() + 86400];
    $encoded = rtrim(strtr(base64_encode(json_encode($payload)), '+/', '-_'), '=');
    return $encoded . '.' . hash_hmac('sha256', $encoded, env('SIGNAL_SECRET', 'change-me'));
}
function tokenData(string $token): ?array {
    [$encoded, $signature] = array_pad(explode('.', $token, 2), 2, '');
    $expected = hash_hmac('sha256', $encoded, env('SIGNAL_SECRET', 'change-me'));
    if ($encoded === '' || !hash_equals($expected, $signature)) return null;
    $data = json_decode(base64_decode(strtr($encoded, '-_', '+/')), true);
    return is_array($data) && ($data['exp'] ?? 0) >= time() ? $data : null;
}
function withRoom(string $room, callable $callback): mixed {
    $handle = fopen(roomFile($room), 'c+');
    if (!$handle) jsonResponse(['error' => 'Storage unavailable'], 500);
    flock($handle, LOCK_EX);
    $contents = stream_get_contents($handle);
    $state = json_decode($contents ?: '', true);
    if (!is_array($state)) $state = ['users' => [], 'events' => [], 'sequence' => 0, 'speaker' => null, 'speakerUntil' => 0];
    $result = $callback($state);
    ftruncate($handle, 0);
    rewind($handle);
    fwrite($handle, json_encode($state, JSON_UNESCAPED_SLASHES));
    fflush($handle);
    flock($handle, LOCK_UN);
    fclose($handle);
    return $result;
}
function auth(): array {
    $data = tokenData((string)($_SERVER['HTTP_X_SIGNAL_TOKEN'] ?? ($_POST['token'] ?? ($_GET['token'] ?? ''))));
    if (!$data) jsonResponse(['error' => 'Session expired'], 401);
    return $data;
}
function addEvent(array &$state, string $type, array $data = []): void {
    $state['sequence']++;
    $state['events'][] = ['id' => $state['sequence'], 'type' => $type, 'data' => $data, 'at' => time()];
    $state['events'] = array_slice($state['events'], -200);
}

if (isset($_GET['asset'])) {
    $asset = ltrim((string)$_GET['asset'], '/');
    $allowed = [
        'app.css' => ['assets/app.css', 'text/css; charset=utf-8'],
        'app.js' => ['assets/app.js', 'application/javascript; charset=utf-8'],
        'sw.js' => ['sw.js', 'application/javascript; charset=utf-8'],
        'manifest.webmanifest' => ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
        'icon-192.svg' => ['icons/icon-192.svg', 'image/svg+xml'],
        'icon-512.svg' => ['icons/icon-512.svg', 'image/svg+xml'],
    ];
    if (!isset($allowed[$asset])) {
        http_response_code(404);
        exit('Asset not found');
    }
    [$file, $contentType] = $allowed[$asset];
    $file = ROOT . DIRECTORY_SEPARATOR . $file;
    if (!is_file($file)) {
        http_response_code(404);
        exit('Asset not found');
    }
    header('Content-Type: ' . $contentType);
    header('Cache-Control: public, max-age=3600');
    readfile($file);
    exit;
}

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$base = rtrim(env('APP_BASE_PATH', ''), '/');
if ($base === '') {
    $scriptDirectory = str_replace('\\', '/', dirname((string)($_SERVER['SCRIPT_NAME'] ?? '/index.php')));
    $base = $scriptDirectory === '/' || $scriptDirectory === '.' ? '' : rtrim($scriptDirectory, '/');
}
if ($base !== '' && str_starts_with($path, $base)) $path = substr($path, strlen($base)) ?: '/';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($path === '/api/join' && $method === 'POST') {
    $input = body();
    $nickname = clean((string)($input['nickname'] ?? ''), 24);
    $room = strtolower(preg_replace('/\s+/', '-', clean((string)($input['channel'] ?? ''), 64)) ?? '');
    if ($nickname === '' || $room === '') jsonResponse(['error' => 'Nickname and channel are required'], 422);
    $peer = bin2hex(random_bytes(8));
    $result = withRoom($room, function (array &$state) use ($peer, $nickname, $room) {
        if (count($state['users']) >= (int)env('SIGNAL_MAX_PEERS', '8')) jsonResponse(['error' => 'This channel is full'], 409);
        $state['users'][$peer] = ['peer' => $peer, 'nickname' => $nickname, 'joined' => time(), 'speaking' => false];
        addEvent($state, 'user_joined', ['user' => $state['users'][$peer]]);
        return true;
    });
    $_SESSION['walkie'] = ['peer' => $peer, 'nickname' => $nickname, 'room' => $room, 'token' => signedToken($peer, $nickname, $room)];
    jsonResponse(['token' => $_SESSION['walkie']['token'], 'peer' => $peer, 'nickname' => $nickname, 'channel' => $room]);
}

if (str_starts_with($path, '/api/')) {
    $identity = auth();
    $room = (string)$identity['room'];
    $peer = (string)$identity['peer'];
    if ($path === '/api/poll' && $method === 'POST') {
        $input = body();
        $after = max(0, (int)($input['after'] ?? 0));
        $result = withRoom($room, function (array &$state) use ($peer, $after) {
            $now = (int)(microtime(true) * 1000);
            if ($state['speaker'] && $state['speakerUntil'] < $now) {
                $old = $state['speaker']; $state['speaker'] = null; $state['speakerUntil'] = 0;
                if (isset($state['users'][$old])) $state['users'][$old]['speaking'] = false;
                addEvent($state, 'speaker_stopped', ['peer' => $old, 'reason' => 'timeout']);
            }
            return ['users' => array_values($state['users']), 'speaker' => $state['speaker'], 'sequence' => $state['sequence'], 'events' => array_values(array_filter($state['events'], fn($event) => $event['id'] > $after))];
        });
        jsonResponse($result);
    }
    if ($path === '/api/ptt' && $method === 'POST') {
        $action = (string)(body()['action'] ?? '');
        $result = withRoom($room, function (array &$state) use ($peer, $action) {
            $now = (int)(microtime(true) * 1000);
            if ($action === 'request') {
                if ($state['speaker'] && $state['speaker'] !== $peer && $state['speakerUntil'] > $now) return ['granted' => false, 'speaker' => $state['speaker']];
                $state['speaker'] = $peer; $state['speakerUntil'] = $now + (int)env('SIGNAL_FLOOR_TIMEOUT_MS', '30000');
                $state['users'][$peer]['speaking'] = true;
                addEvent($state, 'speaker_started', ['peer' => $peer]);
                return ['granted' => true, 'speaker' => $peer];
            }
            if ($action === 'release' && $state['speaker'] === $peer) {
                $state['speaker'] = null; $state['speakerUntil'] = 0; $state['users'][$peer]['speaking'] = false;
                addEvent($state, 'speaker_stopped', ['peer' => $peer]);
            }
            return ['granted' => false];
        });
        jsonResponse($result);
    }
    if ($path === '/api/signal' && $method === 'POST') {
        $input = body(); $to = clean((string)($input['to'] ?? ''), 32); $signal = $input['signal'] ?? null;
        if (!$to || !is_array($signal) || strlen(json_encode($signal)) > (int)env('SIGNAL_MAX_DATA', '12288')) jsonResponse(['error' => 'Invalid signal'], 422);
        withRoom($room, function (array &$state) use ($peer, $to, $signal) { addEvent($state, 'signal', ['from' => $peer, 'to' => $to, 'signal' => $signal]); return true; });
        jsonResponse(['ok' => true]);
    }
    if ($path === '/api/leave' && $method === 'POST') {
        withRoom($room, function (array &$state) use ($peer) { unset($state['users'][$peer]); if ($state['speaker'] === $peer) { $state['speaker'] = null; $state['speakerUntil'] = 0; } addEvent($state, 'user_left', ['peer' => $peer]); return true; });
        jsonResponse(['ok' => true]);
    }
    jsonResponse(['error' => 'Not found'], 404);
}

if ($path === '/manifest.webmanifest') { header('Content-Type: application/manifest+json'); readfile(ROOT . '/manifest.webmanifest'); exit; }
if ($path === '/sw.js') { header('Content-Type: application/javascript'); readfile(ROOT . '/sw.js'); exit; }
if ($path === '/assets/app.js') { header('Content-Type: application/javascript'); readfile(ROOT . '/assets/app.js'); exit; }
if ($path === '/assets/app.css') { header('Content-Type: text/css'); readfile(ROOT . '/assets/app.css'); exit; }

$session = $_SESSION['walkie'] ?? null;
?><!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#09111f"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="Walkie Talkie"><link rel="apple-touch-icon" href="<?= htmlspecialchars(($base ?: '') . '/index.php?asset=icon-192.svg') ?>"><link rel="manifest" href="<?= htmlspecialchars(($base ?: '') . '/index.php?asset=manifest.webmanifest') ?>"><link rel="stylesheet" href="<?= htmlspecialchars(($base ?: '') . '/index.php?asset=app.css') ?>"><title>Walkie Talkie</title></head>
<body data-session="<?= htmlspecialchars(json_encode($session, JSON_UNESCAPED_SLASHES) ?: 'null') ?>">
<main id="app"></main><script src="https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js"></script><script src="<?= htmlspecialchars(($base ?: '') . '/index.php?asset=app.js') ?>" defer></script>
</body></html>
