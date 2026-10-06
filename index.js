const express = require('express');
require('dotenv').config();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const nodemailer = require('nodemailer');

const app = express();
const PORT = Number(process.env.PORT || 2500);
const JWT_SECRET = process.env.JWT_SECRET || 'atx_panel_change_this_secret';

// Recuperação de senha por e-mail. As credenciais devem ficar somente nas variáveis de ambiente.
const SMTP_HOST = String(process.env.SMTP_HOST || '').trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || SMTP_PORT === 465;
const SMTP_USER = String(process.env.SMTP_USER || '').trim();
const SMTP_PASS = String(process.env.SMTP_PASS || '');
const SMTP_FROM = String(process.env.SMTP_FROM || SMTP_USER).trim();
const SMTP_CONNECTION_TIMEOUT_MS = Math.max(3000, Number(process.env.SMTP_CONNECTION_TIMEOUT_MS || 10000));
const SMTP_GREETING_TIMEOUT_MS = Math.max(3000, Number(process.env.SMTP_GREETING_TIMEOUT_MS || 10000));
const SMTP_SOCKET_TIMEOUT_MS = Math.max(5000, Number(process.env.SMTP_SOCKET_TIMEOUT_MS || 20000));
const APP_BASE_URL = String(process.env.APP_BASE_URL || '').trim().replace(/\/$/, '');
const RESET_TOKEN_TTL_MS = Math.max(5, Number(process.env.RESET_TOKEN_TTL_MINUTES || 30)) * 60 * 1000;
const RESET_RATE_WINDOW_MS = 15 * 60 * 1000;
const RESET_RATE_MAX = 5;
const resetRateBuckets = new Map();

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.set('trust proxy', true);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
// Serve o Vue localmente para que o dashboard não dependa do unpkg atrás de proxy/Worker.
app.use('/vendor', express.static(path.join(__dirname, 'node_modules', 'vue', 'dist')));

// Pasta pÃºblica para APKs por usuÃ¡rio
const APK_DIR = path.join(__dirname, 'public', 'apks');
if (!fs.existsSync(APK_DIR)) {
    fs.mkdirSync(APK_DIR, { recursive: true });
}

const apkStorage = multer.diskStorage({
    destination(req, file, cb) {
        const username = req.user && req.user.username ? String(req.user.username) : 'anon';
        const dir = path.join(APK_DIR, username);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename(req, file, cb) {
        cb(null, 'app.apk');
    }
});

const apkUpload = multer({
    storage: apkStorage,
    limits: { fileSize: 120 * 1024 * 1024 }, // 120 MB
    fileFilter(req, file, cb) {
        const name = String(file.originalname || '').toLowerCase();
        const ok = name.endsWith('.apk') || file.mimetype === 'application/vnd.android.package-archive'
            || file.mimetype === 'application/octet-stream';
        if (!ok) return cb(new Error('Envie apenas arquivo .apk'));
        cb(null, true);
    }
});

// Recursos de atualizaÃ§Ã£o do aplicativo. Os arquivos ficam em public/updates
// para que possam ser substituÃ­dos sem misturar dados privados dos usuÃ¡rios.
const UPDATE_RESOURCES = {
    appupdate: 'appupdate',
    config: 'config',
    sms: 'sms',
    theme: 'theme'
};

function requestBaseUrl(req) {
    if (APP_BASE_URL) return APP_BASE_URL;
    const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
    const forwardedHost = String(req.get('x-forwarded-host') || '').split(',')[0].trim();
    const protocol = forwardedProto || req.protocol;
    const host = forwardedHost || req.get('host');
    return `${protocol}://${host}`;
}

function parseUserConfig(user) {
    try {
        const config = JSON.parse(user.config_json || '{}');
        // MantÃ©m apenas o contrato ATX TUNNEL e metadados internos necessÃ¡rios ao painel.
        const allowedRootKeys = ['Version', 'VersionName', 'AppVersion', 'UpdateApk', 'Actualization', 'UdpPort', 'Contato', 'Site', 'WebView', 'Html', 'Theme', 'Servers', 'Sms'];
        Object.keys(config).forEach((key) => {
            if (!allowedRootKeys.includes(key)) delete config[key];
        });
        if (!Array.isArray(config.Servers)) config.Servers = [];
        if (config.UdpPort === undefined) config.UdpPort = '7300';
        if (config.Contato === undefined) config.Contato = '';
        if (config.Site === undefined) config.Site = '';
        if (config.Actualization === undefined) config.Actualization = 'false';
        // Normaliza para string "true" | "false" (contrato do app)
        config.Actualization = (config.Actualization === true || config.Actualization === 'true' || config.Actualization === 1 || config.Actualization === '1')
            ? 'true'
            : 'false';
        // Bloco SMS do aplicativo
        const sms = (config.Sms && typeof config.Sms === 'object') ? config.Sms : {};
        config.Sms = {
            Version: String(sms.Version ?? '1'),
            Update: String(sms.Update ?? ''),
            Notes: String(sms.Notes ?? '')
        };
        return config;
    } catch (error) {
        return {
            Version: 1,
            UdpPort: '7300',
            Contato: '',
            Site: '',
            Servers: [],
            Sms: { Version: '1', Update: '', Notes: '' }
        };
    }
}

function buildSmsPayload(user) {
    const stored = parseUserConfig(user);
    const sms = stored.Sms || {};
    return {
        Version: String(sms.Version ?? '1'),
        Update: String(sms.Update ?? ''),
        Notes: String(sms.Notes ?? '')
    };
}

function buildPublicResourceUrl(req, identifier, resource, publicPrefix = '') {
    const prefix = String(publicPrefix || '');
    return `${requestBaseUrl(req)}${prefix}/${encodeURIComponent(identifier)}/${resource}`;
}

function buildUpdateEntryUrl(req, uuid) {
    return `${requestBaseUrl(req)}/u/${encodeURIComponent(uuid)}`;
}

function buildAtxConfigUrl(req, token = '') {
    const suffix = token ? `?key=${encodeURIComponent(String(token))}` : '';
    return `${requestBaseUrl(req)}/atx/config${suffix}`;
}

function buildCredentialPayload(req, user) {
    const token = ensureUserUpdateUuid(user);
    return {
        version: 1,
        token,
        configUrl: buildAtxConfigUrl(req, token),
        assetPath: 'assets/config/credential.txt',
        format: 'plain-text-token'
    };
}

const SUPPORTED_SERVER_MODES = ['Ssl', 'Direct', 'Proxy', 'Tlsws', 'XHTTP', 'SSH_BHTTP'];
const COMPATIBILITY_PAYLOAD = 'GET / HTTP/1.1[lf]Host: [app_host][lf]Connection: keep-alive[lf][lf]';

function normalizeBhttpConfig(value) {
    const source = value && typeof value === 'object' ? value : {};
    const upload = source.upload && typeof source.upload === 'object' ? source.upload : {};
    const download = source.download && typeof source.download === 'object' ? source.download : {};
    const timeouts = source.timeouts && typeof source.timeouts === 'object' ? source.timeouts : {};
    const integer = (input, fallback, min = 0) => {
        const n = Number(input);
        return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
    };
    return {
        schema_version: integer(source.schema_version, 1, 1),
        mode: ['AUTO', 'BHP1', 'BHP2'].includes(String(source.mode || '').toUpperCase()) ? String(source.mode).toUpperCase() : 'AUTO',
        capability_probe: source.capability_probe === true || source.capability_probe === 'true' || source.capability_probe === 1 || source.capability_probe === '1',
        upload: {
            chunk_size: integer(upload.chunk_size, 32768, 1),
            connections: integer(upload.connections, 16, 1),
            requests_per_connection: integer(upload.requests_per_connection, 1, 1),
            max_attempts: integer(upload.max_attempts, 10, 1),
            retry_backoff_ms: integer(upload.retry_backoff_ms, 150, 0)
        },
        download: {
            chunk_size: integer(download.chunk_size, 30000, 1),
            connections: integer(download.connections, 32, 1),
            requests_per_connection: integer(download.requests_per_connection, 1, 1),
            max_attempts: integer(download.max_attempts, 10, 1),
            retry_backoff_ms: integer(download.retry_backoff_ms, 150, 0)
        },
        timeouts: {
            dns_ms: integer(timeouts.dns_ms, 5000, 1),
            connect_ms: integer(timeouts.connect_ms, 15000, 1),
            read_ms: integer(timeouts.read_ms, 30000, 1),
            probe_ms: integer(timeouts.probe_ms, 8000, 1),
            shutdown_ms: integer(timeouts.shutdown_ms, 5000, 1)
        }
    };
}

function normalizeServerMode(value) {
    const raw = String(value || '').trim();
    const upper = raw.toUpperCase();
    if (['SSH_BHTTP', 'BHTTP_SSH', 'BHTTP'].includes(upper)) return 'SSH_BHTTP';
    return SUPPORTED_SERVER_MODES.includes(raw) ? raw : 'Tlsws';
}

function buildPublicServer(server) {
    const clean = {};
    const serverKeys = ['Name', 'ColorName', 'Description', 'ColorDescription', 'FLAG', 'ServerIP', 'ServerPort', 'CheckUser', 'USER', 'PASS', 'Payload', 'ProxyIP', 'ProxyPort', 'SNI', 'Path', 'Color', 'Info', 'TLSVersion'];
    serverKeys.forEach((key) => {
        if (server[key] !== undefined) clean[key] = server[key];
    });
    clean.Info = normalizeServerMode(server.Info || server.mode || server.TYPE);
    if (['XHTTP', 'SSH_BHTTP'].includes(clean.Info) && !String(clean.Payload || '').trim()) {
        clean.Payload = COMPATIBILITY_PAYLOAD;
    }
    if (clean.Info === 'SSH_BHTTP') {
        clean.mode = 'SSH_BHTTP';
        clean.dt_protocol = String(server.dt_protocol || 'TCP').toUpperCase();
        clean.dt_port = String(server.dt_port ?? server.ServerPort ?? '8000');
        clean.tls_version = String(server.tls_version || server.TLSVersion || 'TLSv1.2');
        clean.bhttp_config = normalizeBhttpConfig(server.bhttp_config || server.bhttp);
    }
    return clean;
}

function buildUserConfig(req, username, user, publicPrefix = '') {
    const stored = parseUserConfig(user);
    const configUrl = buildPublicResourceUrl(req, username, 'config', publicPrefix);
    const servers = Array.isArray(stored.Servers) ? stored.Servers.map(buildPublicServer) : [];

    // O endpoint pÃºblico segue exclusivamente o modelo ATX TUNNEL enviado.
    return {
        Version: String(stored.Version ?? 1),
        Update: configUrl,
        UdpPort: String(stored.UdpPort ?? '7300'),
        Contato: String(stored.Contato ?? ''),
        Site: String(stored.Site ?? ''),
        Servers: servers
    };
}

function buildAtxConfig(req, user, token = '') {
    const stored = parseUserConfig(user);
    const theme = (stored.Theme && typeof stored.Theme === 'object') ? stored.Theme : {};
    const servers = Array.isArray(stored.Servers) ? stored.Servers.map((server) => buildPublicServer({
        Name: String(server.Name ?? ''),
        ColorName: String(server.ColorName ?? '#ffffff'),
        Description: String(server.Description ?? ''),
        ColorDescription: String(server.ColorDescription ?? '#ffffff'),
        FLAG: String(server.FLAG ?? ''),
        ServerIP: String(server.ServerIP ?? ''),
        ServerPort: String(server.ServerPort ?? '443'),
        CheckUser: String(server.CheckUser ?? ''),
        USER: String(server.USER ?? ''),
        PASS: String(server.PASS ?? ''),
        Payload: String(server.Payload ?? ''),
        ProxyIP: String(server.ProxyIP ?? ''),
        ProxyPort: String(server.ProxyPort ?? '443'),
        SNI: String(server.SNI ?? ''),
        Path: String(server.Path ?? ''),
        TLSVersion: String(server.TLSVersion ?? server.tls_version ?? 'TLSv1.2'),
        mode: server.mode,
        dt_protocol: server.dt_protocol,
        dt_port: server.dt_port,
        bhttp_config: server.bhttp_config || server.bhttp,
        Color: String(server.Color ?? '#0000ff'),
        Info: normalizeServerMode(server.Info || server.mode)
    })) : [];
    return {
        Version: String(stored.Version ?? '1'),
        UrlContato: String(stored.Contato ?? ''),
        UrlUpdate: buildAtxConfigUrl(req, token),
        Logo: String(theme.ImgLogo ?? ''),
        Fundo: String(theme.ImgFundo ?? ''),
        CheckPop: 'true',
        CorMenu: String(theme.ColorOne ?? '#000000'),
        CorBtcu: String(theme.ColorButtons ?? '#ff0000'),
        WebView: String(stored.WebView ?? (stored.Html && stored.Html.WebView) ?? ''),
        Roteador: 'true',
        StatusIf: 'false',
        IconCor: '#ffffff',
        Html: {
            WebView: String((stored.Html && stored.Html.WebView) ?? stored.WebView ?? ''),
            HtmlUse: (stored.Html && String(stored.Html.HtmlUse) === 'true') ? 'true' : 'false',
            HtmlAPP: String((stored.Html && stored.Html.HtmlAPP) ?? '')
        },
        Background: { Cor: String(theme.ColorTwo ?? '#000000'), Borda: '35' },
        Border: { Cor: String(theme.ColorButtons ?? '#ff0000'), Borda: '14' },
        Servers: servers
    };
}

function publishAtxConfig(req, user) {
    const file = path.join(__dirname, 'public', 'updates', 'atx-config');
    fs.writeFileSync(file, JSON.stringify(buildAtxConfig(req, user), null, 2));
}

app.get('/atx/config', (req, res) => {
    const credential = String(req.query.key || req.query.token || '').trim();
    const users = listUsers();
    if (credential) {
        const user = findUserByUpdateUuid(credential);
        if (!user) return res.status(404).json({ error: 'Credencial inválida' });
        const token = ensureUserUpdateUuid(user);
        return sendDynamicJson(res, buildAtxConfig(req, user, token));
    }
    if (users.length > 1) {
        return res.status(401).json({ error: 'Informe a credencial da conta' });
    }
    const user = users[0];
    if (user) return sendDynamicJson(res, buildAtxConfig(req, user));
    const file = path.join(__dirname, 'public', 'updates', 'atx-config');
    res.type('application/json').sendFile(file);
});
app.get('/atx/config.json', (req, res) => res.redirect('/atx/config'));

function buildAppUpdate(req, username, user, publicPrefix = '') {
    const stored = parseUserConfig(user);
    const actualization = (stored.Actualization === true || stored.Actualization === 'true' || stored.Actualization === 1 || stored.Actualization === '1')
        ? 'true'
        : 'false';
    return {
        Version: String(stored.AppVersion ?? stored.Version ?? 1),
        VersionName: String(stored.VersionName ?? stored.Version ?? '1'),
        Update: buildPublicResourceUrl(req, username, 'config', publicPrefix),
        Actualization: actualization,
        UpdateApk: stored.UpdateApk || ''
    };
}

for (const [resource, filename] of Object.entries(UPDATE_RESOURCES)) {
    app.get(`/${resource}`, (req, res) => {
        const file = path.join(__dirname, 'public', 'updates', filename);
        if (!fs.existsSync(file)) return res.status(404).json({ error: 'Recurso nÃ£o encontrado' });
        res.type('application/json').sendFile(file);
    });
}

app.get('/updates/manifest.json', (req, res) => {
    const manifest = path.join(__dirname, 'public', 'updates', 'manifest.json');
    if (!fs.existsSync(manifest)) return res.status(404).json({ error: 'Manifesto nÃ£o encontrado' });
    res.type('application/json').sendFile(manifest);
});

// Improved Database setup for many users (File per user)
const DB_DIR = path.join(__dirname, 'data', 'users');
if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
}

function getUser(username) {
    if (!username) return null;
    const file = path.join(DB_DIR, `${username}.json`);
    if (fs.existsSync(file)) {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    return null;
}

function saveUser(username, data) {
    const file = path.join(DB_DIR, `${username}.json`);
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const UPDATE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUpdateUuid(value) {
    return UPDATE_UUID_PATTERN.test(String(value || '').trim());
}

function ensureUserUpdateUuid(user) {
    if (!user) return null;
    if (isValidUpdateUuid(user.updateUuid)) return String(user.updateUuid).toLowerCase();
    user.updateUuid = crypto.randomUUID();
    saveUser(user.username, user);
    return user.updateUuid;
}

function findUserByUpdateUuid(value) {
    const target = String(value || '').trim().toLowerCase();
    if (!isValidUpdateUuid(target)) return null;
    return listUsers().find((user) => String(user.updateUuid || '').toLowerCase() === target) || null;
}

function buildThemePayload(req, username, user, publicPrefix = '') {
    const config = parseUserConfig(user);
    const savedTheme = (config.Theme && typeof config.Theme === 'object') ? config.Theme : {};
    return {
        Version: String(savedTheme.Version ?? config.Version ?? 1),
        Update: buildPublicResourceUrl(req, username, 'theme', publicPrefix),
        AppName: 'ATX TUNNEL',
        ImgFundo: savedTheme.ImgFundo || '',
        ImgLogo: savedTheme.ImgLogo || '',
        ImgBanner: savedTheme.ImgBanner || '',
        ImgMenu: savedTheme.ImgMenu || '',
        ImgLogs: savedTheme.ImgLogs || '',
        ImgCheck: savedTheme.ImgCheck || '',
        ImgUser: savedTheme.ImgUser || '',
        ImgPass: savedTheme.ImgPass || '',
        ColorOne: savedTheme.ColorOne || '',
        ColorTwo: savedTheme.ColorTwo || '',
        ColorStarter: savedTheme.ColorStarter || '',
        ColorDialogs: savedTheme.ColorDialogs || '',
        ColorButtons: savedTheme.ColorButtons || '',
        ImgUpdate: savedTheme.ImgUpdate || ''
    };
}

function buildUpdateManifest(req, uuid, user) {
    const config = parseUserConfig(user);
    const resources = {
        config: buildPublicResourceUrl(req, uuid, 'config', '/u'),
        appupdate: buildPublicResourceUrl(req, uuid, 'appupdate', '/u'),
        sms: buildPublicResourceUrl(req, uuid, 'sms', '/u'),
        theme: buildPublicResourceUrl(req, uuid, 'theme', '/u')
    };
    return {
        uuid,
        version: String(config.Version ?? 1),
        Update: resources.config,
        AppUpdate: resources.appupdate,
        SmsUpdate: resources.sms,
        ThemeUpdate: resources.theme,
        config: resources.config,
        appupdate: resources.appupdate,
        sms: resources.sms,
        theme: resources.theme,
        resources
    };
}

function listUsers() {
    if (!fs.existsSync(DB_DIR)) return [];
    return fs.readdirSync(DB_DIR)
        .filter((name) => name.endsWith('.json'))
        .map((name) => {
            try {
                return JSON.parse(fs.readFileSync(path.join(DB_DIR, name), 'utf8'));
            } catch (e) {
                return null;
            }
        })
        .filter(Boolean);
}

function findUserByEmail(email) {
    const target = String(email || '').trim().toLowerCase();
    if (!target) return null;
    return listUsers().find((u) => String(u.email || '').trim().toLowerCase() === target) || null;
}

function hasSmtpConfiguration() {
    return Boolean(SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS && SMTP_FROM);
}

function getMailer() {
    if (!hasSmtpConfiguration()) return null;
    return nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_SECURE,
        connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
        greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
        socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
        auth: { user: SMTP_USER, pass: SMTP_PASS }
    });
}

function getAppBaseUrl(req) {
    return APP_BASE_URL || requestBaseUrl(req);
}

function getPasswordResetUrl(req, token) {
    return `${getAppBaseUrl(req)}/reset-password?token=${encodeURIComponent(token)}`;
}

function hashResetToken(token) {
    return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function issuePasswordResetToken(user) {
    const token = crypto.randomBytes(32).toString('hex');
    user.passwordResetTokenHash = hashResetToken(token);
    user.passwordResetExpiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
    user.passwordResetRequestedAt = new Date().toISOString();
    return token;
}

function findUserByResetToken(token) {
    const value = String(token || '').trim();
    if (!/^[a-f0-9]{64}$/i.test(value)) return null;
    const tokenHash = hashResetToken(value);
    const now = Date.now();
    return listUsers().find((user) => {
        if (!user.passwordResetTokenHash || user.passwordResetTokenHash !== tokenHash) return false;
        const expires = new Date(user.passwordResetExpiresAt || 0).getTime();
        return Number.isFinite(expires) && expires > now;
    }) || null;
}

function clearPasswordResetToken(user) {
    delete user.passwordResetTokenHash;
    delete user.passwordResetExpiresAt;
    delete user.passwordResetRequestedAt;
}

function isPasswordResetRateLimited(req, email) {
    const now = Date.now();
    for (const [key, bucket] of resetRateBuckets.entries()) {
        if (!bucket || now - bucket.startedAt >= RESET_RATE_WINDOW_MS) resetRateBuckets.delete(key);
    }
    const key = `${req.ip || 'unknown'}|${String(email || '').toLowerCase()}`;
    const bucket = resetRateBuckets.get(key);
    if (!bucket) {
        resetRateBuckets.set(key, { startedAt: now, count: 1 });
        return false;
    }
    if (bucket.count >= RESET_RATE_MAX) return true;
    bucket.count += 1;
    return false;
}

async function verifySmtpConfiguration() {
    if (!hasSmtpConfiguration()) {
        console.warn('SMTP de recuperação: NÃO configurado (defina SMTP_HOST, SMTP_PORT, SMTP_USER e SMTP_PASS)');
        return;
    }
    try {
        await getMailer().verify();
        console.log(`SMTP de recuperação: OK (${SMTP_HOST}:${SMTP_PORT})`);
    } catch (error) {
        console.error('SMTP de recuperação: FALHA na verificação:', error.message || error);
    }
}

async function sendPasswordResetEmail(user, resetUrl) {
    const mailer = getMailer();
    if (!mailer) throw new Error('SMTP não configurado');
    await mailer.sendMail({
        from: SMTP_FROM,
        to: user.email,
        subject: 'Redefinição de senha — ATX TUNNEL',
        text: `Olá ${user.username},\n\nRecebemos uma solicitação para redefinir a senha da sua conta ATX TUNNEL.\n\nAcesse o link abaixo em até ${Math.round(RESET_TOKEN_TTL_MS / 60000)} minutos:\n${resetUrl}\n\nSe você não solicitou essa alteração, ignore esta mensagem.`,
        html: `<p>Olá <strong>${user.username}</strong>,</p><p>Recebemos uma solicitação para redefinir a senha da sua conta ATX TUNNEL.</p><p>O link abaixo expira em ${Math.round(RESET_TOKEN_TTL_MS / 60000)} minutos e pode ser usado uma única vez:</p><p><a href="${resetUrl}">Redefinir minha senha</a></p><p>Se você não solicitou essa alteração, ignore esta mensagem.</p>`
    });
}

function findUserByLogin(login) {
    const value = String(login || '').trim();
    if (!value) return null;
    // Login aceita usuÃ¡rio ou e-mail
    if (value.includes('@')) return findUserByEmail(value);
    return getUser(value);
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function isAdminUser(user) {
    if (!user) return false;
    if (user.isAdmin === true || user.isAdmin === 1 || user.isAdmin === 'true' || user.isAdmin === '1') return true;
    if (String(user.role || '').toLowerCase() === 'admin') return true;
    // username Admin (legado)
    if (String(user.username || '').toLowerCase() === 'admin') return true;
    return false;
}

function isSubscriptionActive(user) {
    // Planos/pagamento removidos: acesso liberado para todas as contas.
    return !!user;
}

function getCdnPool(user) {
    return Array.isArray(user.cdn_pool) ? user.cdn_pool.filter(Boolean).map(String) : [];
}

function parseCdnInput(values) {
    const list = Array.isArray(values) ? values : String(values || '').split(/[\n,#]+/);
    return [...new Set(
        list
            .flatMap(item => String(item || '').split(/[\n,#]+/))
            .map(item => item.trim())
            .filter(Boolean)
            .map(normalizeCdnUrl)
            .filter(Boolean)
    )].slice(0, 100);
}

function normalizeCdnUrl(value) {
    try {
        const raw = String(value || '').trim();
        if (!raw) return null;
        const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
        if (!['http:', 'https:'].includes(url.protocol)) return null;
        if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(url.hostname)) return null;
        return url.toString().replace(/\/$/, '');
    } catch (error) {
        return null;
    }
}

async function testCdnUrl(value) {
    const started = Date.now();
    let target;
    try {
        target = normalizeCdnUrl(value);
        if (!target) throw new Error('URL invÃ¡lida');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const response = await fetch(target, {
            method: 'GET',
            headers: { Range: 'bytes=0-0', 'User-Agent': 'ATX-CDN-Pool/1.0' },
            redirect: 'follow',
            signal: controller.signal
        });
        clearTimeout(timer);
        // Para Azion: ONLINE apenas com HTTP 400 (host no ar). 404/outros = OFFLINE
        const online = response.status === 400;
        return {
            url: target,
            online,
            status: response.status,
            latency: Date.now() - started,
            host: new URL(response.url).hostname
        };
    } catch (error) {
        return {
            url: target || String(value || ''),
            online: false,
            status: 0,
            latency: Date.now() - started,
            error: error.name === 'AbortError' ? 'Tempo esgotado' : error.message
        };
    }
}

// Migration from old database.json
const OLD_DB_FILE = path.join(__dirname, 'database.json');
if (fs.existsSync(OLD_DB_FILE)) {
    try {
        const oldDb = JSON.parse(fs.readFileSync(OLD_DB_FILE, 'utf8'));
        if (oldDb.users) {
            oldDb.users.forEach(u => {
                saveUser(u.username, u);
            });
        }
        fs.renameSync(OLD_DB_FILE, path.join(__dirname, 'database.json.bak'));
        console.log('Migrated old database to file-per-user system.');
    } catch(e) {
        console.error('Failed to migrate db', e);
    }
}

// Default Config from the app
const DEFAULT_CONFIG = {
    "Version": 1,
    "VersionName": "1.0.0",
    "AppVersion": 1,
    "UpdateApk": "",
    "Actualization": "false",
    "UdpPort": "7300",
    "Contato": "",
    "Site": "",
    "Sms": {
        "Version": "1",
        "Update": "",
        "Notes": ""
    },
    "Theme": {
        "Version": "1",
        "Update": "",
        "AppName": "ATX TUNNEL",
        "ImgFundo": "https://cdn.awsli.com.br/2500x2500/549/549871/produto/29108392/60cdfb3799.jpg",
        "ImgLogo": "https://i.imgur.com/KMpSZOq.gif",
        "ImgBanner": "",
        "ImgMenu": "https://telegra.ph/file/828fa0ae4f65228764d39.png",
        "ImgLogs": "https://telegra.ph/file/ca921a93220cc2281f147.png",
        "ImgCheck": "https://telegra.ph/file/12ab1b8c54f671f72bc73.png",
        "ImgUser": "https://telegra.ph/file/51cfbf308fa6a293d6f7b.png",
        "ImgPass": "https://telegra.ph/file/0aae4b5cc75034f04611d.png",
        "ColorOne": "#7A333333",
        "ColorTwo": "#7A333333",
        "ColorStarter": "#7A333333",
        "ColorDialogs": "#84ffffff",
        "ColorButtons": "#333333",
        "ImgUpdate": "https://i.imgur.com/CJFEvDW.png"
    },
    "Servers": []
};

// Middleware to check authentication
function requireAuth(req, res, next) {
    const token = req.cookies.auth_token;
    const wantsJson = String(req.originalUrl || '').startsWith('/api/')
        || (req.headers.accept || '').includes('application/json')
        || req.xhr;

    if (!token) {
        if (wantsJson) return res.status(401).json({ error: 'Não autenticado' });
        return res.redirect('/login');
    }

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) {
            if (wantsJson) return res.status(401).json({ error: 'Sessão inválida' });
            return res.redirect('/login');
        }
        const user = getUser(decoded.username);
        if (!user) {
            res.clearCookie('auth_token');
            if (wantsJson) return res.status(401).json({ error: 'Usuário não encontrado' });
            return res.redirect('/login');
        }
        req.user = { id: user.id, username: user.username };
        req.userFull = user;
        next();
    });
}

function requireActivePlan(req, res, next) {
    const user = req.userFull || getUser(req.user && req.user.username);
    if (!user) return res.redirect('/login');
    next();
}

function requireActivePlanApi(req, res, next) {
    const user = req.userFull || getUser(req.user && req.user.username);
    if (!user) return res.status(401).json({ error: 'Não autenticado' });
    next();
}

// Routes
app.get('/', (req, res) => {
    res.redirect('/dashboard');
});

// Auth Routes
app.get('/login', (req, res) => {
    const message = req.query.reset === '1' ? 'Senha redefinida com sucesso. Faça login com a nova senha.' : null;
    res.render('login', { error: null, message });
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = findUserByLogin(username);

    if (!user) return res.render('login', { error: 'UsuÃ¡rio/e-mail ou senha invÃ¡lidos', message: null });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.render('login', { error: 'UsuÃ¡rio/e-mail ou senha invÃ¡lidos', message: null });

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
    res.cookie('auth_token', token).redirect('/dashboard');
});

app.get('/forgot-password', (req, res) => {
    res.set('Referrer-Policy', 'no-referrer');
    res.render('forgot-password', { error: null, message: null, email: '' });
});

app.post('/forgot-password', async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const genericMessage = 'Se existir uma conta com esse e-mail, enviaremos um link para redefinir a senha.';

    if (!isValidEmail(email)) {
        return res.render('forgot-password', {
            error: 'Informe um e-mail válido.',
            message: null,
            email
        });
    }

    if (isPasswordResetRateLimited(req, email)) {
        return res.render('forgot-password', { error: null, message: genericMessage, email: '' });
    }

    const user = findUserByEmail(email);
    if (!user) {
        return res.render('forgot-password', { error: null, message: genericMessage, email: '' });
    }

    if (!hasSmtpConfiguration()) {
        console.error('Password reset requested but SMTP is not configured. Define SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_FROM.');
        return res.render('forgot-password', {
            error: 'O serviço de e-mail está temporariamente indisponível. Tente novamente mais tarde.',
            message: null,
            email
        });
    }

    try {
        const resetToken = issuePasswordResetToken(user);
        saveUser(user.username, user);
        await sendPasswordResetEmail(user, getPasswordResetUrl(req, resetToken));
        return res.render('forgot-password', { error: null, message: genericMessage, email: '' });
    } catch (error) {
        clearPasswordResetToken(user);
        saveUser(user.username, user);
        console.error('Password reset email error:', error.stack || error.message || error);
        return res.render('forgot-password', {
            error: 'Não foi possível enviar o e-mail agora. Tente novamente mais tarde.',
            message: null,
            email
        });
    }
});

app.get('/reset-password', (req, res) => {
    res.set('Referrer-Policy', 'no-referrer');
    const token = String(req.query.token || '').trim();
    const user = findUserByResetToken(token);
    res.render('reset-password', {
        error: user ? null : 'Este link é inválido ou já expirou.',
        message: null,
        token: user ? token : ''
    });
});

app.post('/reset-password', async (req, res) => {
    const token = String(req.body.token || '').trim();
    const password = String(req.body.password || '');
    const confirmPassword = String(req.body.confirmPassword || '');
    const user = findUserByResetToken(token);

    if (!user) {
        return res.render('reset-password', {
            error: 'Este link é inválido ou já expirou.',
            message: null,
            token: ''
        });
    }
    if (password.length < 6) {
        return res.render('reset-password', {
            error: 'A nova senha deve ter no mínimo 6 caracteres.',
            message: null,
            token
        });
    }
    if (password !== confirmPassword) {
        return res.render('reset-password', {
            error: 'As senhas não conferem.',
            message: null,
            token
        });
    }

    user.password = await bcrypt.hash(password, 10);
    clearPasswordResetToken(user);
    saveUser(user.username, user);
    return res.redirect('/login?reset=1');
});

app.get('/register', (req, res) => {
    res.render('register', { error: null });
});

app.post('/register', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!username || !email || !password) {
        return res.render('register', { error: 'Preencha usuÃ¡rio, e-mail e senha' });
    }

    if (!/^[a-zA-Z0-9]+$/.test(username)) {
        return res.render('register', { error: 'UsuÃ¡rio deve ser alfanumÃ©rico (sem espaÃ§os)' });
    }

    if (!isValidEmail(email)) {
        return res.render('register', { error: 'E-mail invÃ¡lido' });
    }

    if (password.length < 6) {
        return res.render('register', { error: 'Senha deve ter no mÃ­nimo 6 caracteres' });
    }

    try {
        if (getUser(username)) {
            return res.render('register', { error: 'Nome de usuÃ¡rio jÃ¡ existe' });
        }
        if (findUserByEmail(email)) {
            return res.render('register', { error: 'E-mail jÃ¡ cadastrado' });
        }

        const hash = await bcrypt.hash(password, 10);
        const configJsonStr = JSON.stringify(DEFAULT_CONFIG, null, 2);

        saveUser(username, {
            id: Date.now(),
            username,
            displayName: username,
            email,
            password: hash,
            config_json: configJsonStr,
            updateUuid: crypto.randomUUID(),
            created_at: new Date().toISOString(),
            isAdmin: false
        });
        res.redirect('/login');
    } catch (e) {
        res.render('register', { error: 'Erro no servidor' });
    }
});

// Perfil do usuÃ¡rio logado
app.get('/api/profile', requireAuth, (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    const updateUuid = ensureUserUpdateUuid(user);
    res.json({
        username: user.username,
        displayName: String(user.displayName || user.username),
        email: user.email || '',
        updateUuid,
        updateUrl: buildUpdateEntryUrl(req, updateUuid),
        appConfigUrl: buildAtxConfigUrl(req, updateUuid),
        created_at: user.created_at || null,
        plan: user.plan || 'trial',
        expiresAt: user.expiresAt || null,
        active: isSubscriptionActive(user),
        isAdmin: isAdminUser(user)
    });
});

app.post('/api/profile', requireAuth, async (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

    const displayName = String(req.body.displayName ?? user.displayName ?? user.username).trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const currentPassword = String(req.body.currentPassword || '');
    const newPassword = String(req.body.newPassword || '');

    if (!displayName || displayName.length > 60) {
        return res.status(400).json({ error: 'O nome de exibição deve ter entre 1 e 60 caracteres' });
    }
    user.displayName = displayName;

    if (email) {
        if (!isValidEmail(email)) {
            return res.status(400).json({ error: 'E-mail invÃ¡lido' });
        }
        const other = findUserByEmail(email);
        if (other && other.username !== user.username) {
            return res.status(400).json({ error: 'E-mail jÃ¡ estÃ¡ em uso por outra conta' });
        }
        user.email = email;
    }

    if (newPassword) {
        if (!currentPassword) {
            return res.status(400).json({ error: 'Informe a senha atual para trocar a senha' });
        }
        const match = await bcrypt.compare(currentPassword, user.password);
        if (!match) {
            return res.status(400).json({ error: 'Senha atual incorreta' });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'Nova senha deve ter no mÃ­nimo 6 caracteres' });
        }
        user.password = await bcrypt.hash(newPassword, 10);
        clearPasswordResetToken(user);
    }

    saveUser(user.username, user);
    const updateUuid = ensureUserUpdateUuid(user);
    res.json({
        ok: true,
        username: user.username,
        displayName: String(user.displayName || user.username),
        email: user.email || '',
        updateUuid,
        updateUrl: buildUpdateEntryUrl(req, updateUuid),
        appConfigUrl: buildAtxConfigUrl(req, updateUuid)
    });
});

app.post('/api/profile/update-uuid/regenerate', requireAuth, (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    user.updateUuid = crypto.randomUUID();
    saveUser(user.username, user);
    res.json({
        ok: true,
        updateUuid: user.updateUuid,
        updateUrl: buildUpdateEntryUrl(req, user.updateUuid),
        appConfigUrl: buildAtxConfigUrl(req, user.updateUuid)
    });
});

app.get('/api/profile/credential.json', requireAuth, (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    const credential = buildCredentialPayload(req, user);
    res.set({
        'Cache-Control': 'private, no-store, no-cache, max-age=0',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'attachment; filename="credencial.json"'
    });
    return res.type('application/json').send(JSON.stringify(credential, null, 2));
});

app.get('/api/profile/credential.txt', requireAuth, (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).send('Usuário não encontrado');
    const token = ensureUserUpdateUuid(user);
    res.set({
        'Cache-Control': 'private, no-store, no-cache, max-age=0',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'attachment; filename="credential.txt"',
        'Content-Type': 'text/plain; charset=utf-8'
    });
    return res.send(`${token}\n`);
});

app.get('/logout', (req, res) => {
    res.clearCookie('auth_token').redirect('/login');
});


// Dashboard
app.get('/dashboard', requireAuth, requireActivePlan, (req, res) => {
    const user = req.userFull || getUser(req.user.username);
    if (!user) return res.redirect('/login');
    const updateUuid = ensureUserUpdateUuid(user);

    // Preserve the external port (for example :2000) in all generated URLs.
    const hostUrl = requestBaseUrl(req);
    const apkRelative = `/apks/${encodeURIComponent(user.username)}/app.apk`;
    const apkPath = path.join(APK_DIR, user.username, 'app.apk');
    const hasApk = fs.existsSync(apkPath);
    // The dashboard embeds configStr inside a <script>. Escape HTML-sensitive
    // characters so user HTML containing </script> cannot terminate that script.
    const configStr = JSON.stringify(parseUserConfig(user), null, 2)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
    res.render('dashboard', {
        user: {
            ...req.user,
            displayName: String(user.displayName || user.username),
            email: user.email || '',
            updateUuid,
            created_at: user.created_at || null,
            isAdmin: isAdminUser(user)
        },
        configStr,
        appUrl: buildAtxConfigUrl(req, updateUuid),
        appUpdateUrl: `${hostUrl}/${encodeURIComponent(user.username)}/appupdate`,
        smsUrl: `${hostUrl}/${encodeURIComponent(user.username)}/sms`,
        themeUrl: `${hostUrl}/${encodeURIComponent(user.username)}/theme`,
        updateUrl: buildUpdateEntryUrl(req, updateUuid),
        updateConfigUrl: buildPublicResourceUrl(req, updateUuid, 'config', '/u'),
        updateAppUpdateUrl: buildPublicResourceUrl(req, updateUuid, 'appupdate', '/u'),
        updateSmsUrl: buildPublicResourceUrl(req, updateUuid, 'sms', '/u'),
        updateThemeUrl: buildPublicResourceUrl(req, updateUuid, 'theme', '/u'),
        apkUrl: hasApk ? `${hostUrl}${apkRelative}` : '',
        hasApk
    });
});

// Upload do APK do aplicativo (atualizaÃ§Ã£o)
app.post('/api/apk/upload', requireAuth, requireActivePlanApi, (req, res) => {
    apkUpload.single('apk')(req, res, (err) => {
        if (err) {
            return res.status(400).json({ error: err.message || 'Falha no upload do APK' });
        }
        if (!req.file) {
            return res.status(400).json({ error: 'Nenhum arquivo enviado' });
        }

        const user = getUser(req.user.username);
        if (!user) return res.status(404).json({ error: 'UsuÃ¡rio nÃ£o encontrado' });

        const hostUrl = requestBaseUrl(req);
        const apkUrl = `${hostUrl}/apks/${encodeURIComponent(user.username)}/app.apk`;

        const config = parseUserConfig(user);
        config.UpdateApk = apkUrl;
        if (req.body && req.body.AppVersion) {
            config.AppVersion = Number(req.body.AppVersion) || config.AppVersion || 1;
        }
        if (req.body && req.body.VersionName) {
            config.VersionName = String(req.body.VersionName);
        }
        user.config_json = JSON.stringify(config, null, 2);
        saveUser(user.username, user);

        res.json({
            ok: true,
            apkUrl,
            AppVersion: config.AppVersion,
            VersionName: config.VersionName,
            UpdateApk: config.UpdateApk
        });
    });
});

app.delete('/api/apk', requireAuth, (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'UsuÃ¡rio nÃ£o encontrado' });
    const apkPath = path.join(APK_DIR, user.username, 'app.apk');
    if (fs.existsSync(apkPath)) fs.unlinkSync(apkPath);

    const config = parseUserConfig(user);
    const hostUrl = requestBaseUrl(req);
    const selfUrl = `${hostUrl}/apks/${encodeURIComponent(user.username)}/app.apk`;
    if (config.UpdateApk === selfUrl) config.UpdateApk = '';
    user.config_json = JSON.stringify(config, null, 2);
    saveUser(user.username, user);
    res.json({ ok: true });
});

app.get('/api/cdn-pool', requireAuth, (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'UsuÃ¡rio nÃ£o encontrado' });
    res.json({
        urls: getCdnPool(user),
        results: Array.isArray(user.cdn_pool_results) ? user.cdn_pool_results : [],
        active: Array.isArray(user.cdn_pool_active) ? user.cdn_pool_active : [],
        testedAt: user.cdn_pool_tested_at || null
    });
});

app.post('/api/cdn-pool', requireAuth, requireActivePlanApi, (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'UsuÃ¡rio nÃ£o encontrado' });
    const urls = parseCdnInput(req.body.urls);
    user.cdn_pool = urls;
    saveUser(user.username, user);
    res.json({ urls });
});

app.post('/api/cdn-pool/test', requireAuth, requireActivePlanApi, async (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'UsuÃ¡rio nÃ£o encontrado' });
    const urls = parseCdnInput(
        Array.isArray(req.body.urls) && req.body.urls.length
            ? req.body.urls
            : getCdnPool(user)
    );
    const results = await Promise.all(urls.map(testCdnUrl));
    const active = results.filter(item => item.online).map(item => item.url);
    // Guarda o Ãºltimo teste para nÃ£o sumir ao recarregar/relogar
    user.cdn_pool_results = results;
    user.cdn_pool_active = active;
    user.cdn_pool_tested_at = new Date().toISOString();
    saveUser(user.username, user);
    res.json({ results, active, testedAt: user.cdn_pool_tested_at });
});

app.delete('/api/cdn-pool', requireAuth, (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'UsuÃ¡rio nÃ£o encontrado' });
    const target = normalizeCdnUrl(req.body.url);
    user.cdn_pool = getCdnPool(user).filter(url => url !== target);
    saveUser(user.username, user);
    res.json({ urls: user.cdn_pool });
});

function normalizeConfigPayload(nextConfig, currentConfig = null) {
    const parsedVersion = Number(nextConfig.Version);
    const parsedAppVersion = Number(nextConfig.AppVersion);
    nextConfig.Version = Number.isFinite(parsedVersion) ? parsedVersion : 1;
    nextConfig.AppVersion = Number.isFinite(parsedAppVersion) ? parsedAppVersion : nextConfig.Version;
    nextConfig.VersionName = String(
        nextConfig.VersionName !== undefined && nextConfig.VersionName !== null && nextConfig.VersionName !== ''
            ? nextConfig.VersionName
            : nextConfig.Version
    );
    nextConfig.UpdateApk = String(nextConfig.UpdateApk ?? '');
    nextConfig.Actualization = (nextConfig.Actualization === true || nextConfig.Actualization === 'true' || nextConfig.Actualization === 1 || nextConfig.Actualization === '1')
        ? 'true'
        : 'false';

    const htmlIn = (nextConfig.Html && typeof nextConfig.Html === 'object') ? nextConfig.Html : {};
    nextConfig.Html = {
        WebView: String(htmlIn.WebView ?? nextConfig.WebView ?? ''),
        HtmlUse: (htmlIn.HtmlUse === true || htmlIn.HtmlUse === 'true' || htmlIn.HtmlUse === 1 || htmlIn.HtmlUse === '1') ? 'true' : 'false',
        HtmlAPP: String(htmlIn.HtmlAPP ?? '')
    };
    nextConfig.WebView = String(nextConfig.WebView ?? nextConfig.Html.WebView ?? '');

    const smsIn = (nextConfig.Sms && typeof nextConfig.Sms === 'object') ? nextConfig.Sms : {};
    nextConfig.Sms = {
        Version: String(smsIn.Version ?? '1'),
        Update: String(smsIn.Update ?? ''),
        Notes: String(smsIn.Notes ?? '')
    };

    const themeIn = (nextConfig.Theme && typeof nextConfig.Theme === 'object') ? nextConfig.Theme : {};
    nextConfig.Theme = {
        ...themeIn,
        Version: String(themeIn.Version ?? '1'),
        AppName: 'ATX TUNNEL'
    };

    nextConfig.Servers = Array.isArray(nextConfig.Servers) ? nextConfig.Servers.map((server) => {
        const item = server && typeof server === 'object' ? { ...server } : {};
        item.Info = normalizeServerMode(item.Info || item.mode || item.TYPE);
        item.TLSVersion = String(item.TLSVersion ?? item.tls_version ?? 'TLSv1.2');
        if (item.Info === 'SSH_BHTTP') {
            item.mode = 'SSH_BHTTP';
            item.dt_protocol = String(item.dt_protocol || 'TCP').toUpperCase();
            item.dt_port = String(item.dt_port ?? item.ServerPort ?? '8000');
            item.tls_version = String(item.tls_version || item.TLSVersion || 'TLSv1.2');
            item.bhttp_config = normalizeBhttpConfig(item.bhttp_config || item.bhttp);
        } else {
            delete item.mode;
            delete item.dt_protocol;
            delete item.dt_port;
            delete item.tls_version;
            delete item.bhttp_config;
        }
        return item;
    }) : [];

    const allowedRootKeys = ['Version', 'VersionName', 'AppVersion', 'UpdateApk', 'Actualization', 'UdpPort', 'Contato', 'Site', 'WebView', 'Html', 'Theme', 'Servers', 'Sms'];
    Object.keys(nextConfig).forEach((key) => {
        if (!allowedRootKeys.includes(key)) delete nextConfig[key];
    });
    nextConfig.UdpPort = String(nextConfig.UdpPort ?? '7300');
    nextConfig.Contato = String(nextConfig.Contato ?? '');
    nextConfig.Site = String(nextConfig.Site ?? '');
    if (!Array.isArray(nextConfig.Servers)) nextConfig.Servers = [];
    return nextConfig;
}

function stableSerialize(value) {
    if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function asVersionNumber(value, fallback = 1) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 1 ? number : fallback;
}

function getConfigVersionPayload(config) {
    return {
        UdpPort: String(config?.UdpPort ?? '7300'),
        Contato: String(config?.Contato ?? ''),
        Site: String(config?.Site ?? ''),
        Servers: Array.isArray(config?.Servers) ? config.Servers : []
    };
}

function getSmsVersionPayload(config) {
    const sms = (config?.Sms && typeof config.Sms === 'object') ? config.Sms : {};
    return {
        Update: String(sms.Update ?? ''),
        Notes: String(sms.Notes ?? '')
    };
}

function getThemeVersionPayload(config) {
    const theme = (config?.Theme && typeof config.Theme === 'object') ? { ...config.Theme } : {};
    delete theme.Version;
    delete theme.Update;
    return theme;
}

function applyAutomaticVersions(currentConfig, nextConfig) {
    if (!currentConfig) return nextConfig;

    const configChanged = stableSerialize(getConfigVersionPayload(currentConfig))
        !== stableSerialize(getConfigVersionPayload(nextConfig));
    const smsChanged = stableSerialize(getSmsVersionPayload(currentConfig))
        !== stableSerialize(getSmsVersionPayload(nextConfig));
    const themeChanged = stableSerialize(getThemeVersionPayload(currentConfig))
        !== stableSerialize(getThemeVersionPayload(nextConfig));

    nextConfig.Version = configChanged
        ? asVersionNumber(currentConfig.Version) + 1
        : asVersionNumber(currentConfig.Version);

    const currentSmsVersion = asVersionNumber(currentConfig.Sms?.Version);
    nextConfig.Sms.Version = String(smsChanged ? currentSmsVersion + 1 : currentSmsVersion);

    const currentThemeVersion = asVersionNumber(currentConfig.Theme?.Version);
    const requestedThemeVersion = asVersionNumber(nextConfig.Theme?.Version, currentThemeVersion);
    const themeVersionManuallyChanged = requestedThemeVersion !== currentThemeVersion;
    nextConfig.Theme.Version = String(
        themeVersionManuallyChanged
            ? requestedThemeVersion
            : (themeChanged ? currentThemeVersion + 1 : currentThemeVersion)
    );

    return nextConfig;
}

// Save completo — versões de config, tema e SMS sobem automaticamente. O APK continua manual.
app.post('/dashboard/save', requireAuth, requireActivePlanApi, (req, res) => {
    const { config_json } = req.body;
    try {
        const user = getUser(req.user.username);
        if (!user) return res.status(500).send('Erro ao salvar as configurações');
        const currentConfig = parseUserConfig(user);
        const incomingConfig = normalizeConfigPayload(JSON.parse(config_json));
        // SMS possui salvamento próprio; o botão global não pode sobrescrever esse bloco.
        incomingConfig.Sms = currentConfig.Sms;
        const nextConfig = applyAutomaticVersions(currentConfig, incomingConfig);
        user.config_json = JSON.stringify(nextConfig, null, 2);
        saveUser(user.username, user);
        publishAtxConfig(req, user);
        return res.json({
            ok: true,
            Version: nextConfig.Version,
            UdpPort: nextConfig.UdpPort,
            Contato: nextConfig.Contato,
            Site: nextConfig.Site,
            AppVersion: nextConfig.AppVersion,
            VersionName: nextConfig.VersionName,
            Actualization: nextConfig.Actualization,
            UpdateApk: nextConfig.UpdateApk,
            Sms: nextConfig.Sms,
            Theme: nextConfig.Theme
        });
    } catch (e) {
        res.status(400).send('Formato JSON invÃ¡lido');
    }
});

// Rotas legadas de SMS e tema: também calculam a versão automaticamente.
app.post('/api/sms', requireAuth, requireActivePlanApi, (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'UsuÃ¡rio nÃ£o encontrado' });
    const config = parseUserConfig(user);
    const body = req.body || {};
    const currentSmsVersion = asVersionNumber(config.Sms?.Version);
    const requestedSmsVersion = asVersionNumber(body.Version, currentSmsVersion);
    const nextSms = {
        Version: String(requestedSmsVersion),
        Update: String(body.Update ?? config.Sms?.Update ?? ''),
        Notes: String(body.Notes ?? config.Sms?.Notes ?? '')
    };
    const smsChanged = stableSerialize(getSmsVersionPayload(config))
        !== stableSerialize(getSmsVersionPayload({ ...config, Sms: nextSms }));
    const smsVersionManuallyChanged = requestedSmsVersion !== currentSmsVersion;
    nextSms.Version = String(
        smsVersionManuallyChanged
            ? requestedSmsVersion
            : (smsChanged ? currentSmsVersion + 1 : currentSmsVersion)
    );
    config.Sms = nextSms;
    user.config_json = JSON.stringify(config, null, 2);
    saveUser(user.username, user);
    publishAtxConfig(req, user);
    res.json({ ok: true, Sms: config.Sms });
});

app.post('/api/theme', requireAuth, requireActivePlanApi, (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'UsuÃ¡rio nÃ£o encontrado' });
    const config = parseUserConfig(user);
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const nextTheme = {
        ...((config.Theme && typeof config.Theme === 'object') ? config.Theme : {}),
        ...body,
        Version: String(body.Version ?? config.Theme?.Version ?? '1'),
        AppName: 'ATX TUNNEL'
    };
    const themeChanged = stableSerialize(getThemeVersionPayload(config))
        !== stableSerialize(getThemeVersionPayload({ ...config, Theme: nextTheme }));
    const currentThemeVersion = asVersionNumber(config.Theme?.Version);
    const requestedThemeVersion = asVersionNumber(nextTheme.Version, currentThemeVersion);
    const themeVersionManuallyChanged = requestedThemeVersion !== currentThemeVersion;
    nextTheme.Version = String(
        themeVersionManuallyChanged
            ? requestedThemeVersion
            : (themeChanged ? currentThemeVersion + 1 : currentThemeVersion)
    );
    config.Theme = nextTheme;
    user.config_json = JSON.stringify(config, null, 2);
    saveUser(user.username, user);
    publishAtxConfig(req, user);
    res.json({ ok: true, Theme: config.Theme });
});

// Importa uma configuração JSON hospedada em uma URL.
app.post('/api/config/import-url', requireAuth, requireActivePlanApi, async (req, res) => {
    const target = String(req.body?.url || '').trim();
    if (!/^https?:\/\//i.test(target)) return res.status(400).json({ error: 'Informe uma URL HTTP ou HTTPS válida' });
    try {
        const response = await fetch(target, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
        if (!response.ok) return res.status(400).json({ error: `A URL retornou HTTP ${response.status}` });
        const incoming = await response.json();
        const converted = convertExternalConfig(incoming);
        if (!converted.config || !Array.isArray(converted.config.Servers)) return res.status(400).json({ error: 'A URL não contém uma lista de servidores reconhecível' });
        const user = getUser(req.user.username);
        const current = parseUserConfig(user);
        const next = { ...current, ...converted.config, Sms: current.Sms, Theme: current.Theme };
        user.config_json = JSON.stringify(applyAutomaticVersions(current, next), null, 2);
        saveUser(user.username, user);
        publishAtxConfig(req, user);
        res.json({ ok: true, imported: converted.summary });
    } catch (error) {
        res.status(400).json({ error: 'Não foi possível ler a URL como JSON' });
    }
});

// Exportar configuraÃ§Ã£o completa
app.get('/api/config/export', requireAuth, (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'UsuÃ¡rio nÃ£o encontrado' });
    const config = parseUserConfig(user);
    res.setHeader('Content-Disposition', `attachment; filename="atx-config-${user.username}.json"`);
    res.type('application/json').send(JSON.stringify(config, null, 2));
});

function normalizeImportedList(value) {
    if (Array.isArray(value)) return value.filter((item) => item !== null && item !== undefined).map((item) => String(item)).join('#');
    if (value === null || value === undefined) return '';
    return String(value);
}

function normalizeImportedPayload(value) {
    return String(value ?? '')
        .replace(/\\r\\n/g, '[lf]')
        .replace(/\\n/g, '[lf]')
        .replace(/\\r/g, '[lf]')
        .replace(/\r?\n/g, '[lf]')
        .replace(/\[crlf\]/gi, '[lf]')
        .replace(/\[cr\]/gi, '[lf]');
}

function mapImportedMode(mode) {
    const normalized = String(mode ?? '').trim().toUpperCase();
    const map = {
        SSH_DIRECT: 'Direct',
        SSH_PROXY: 'Proxy',
        SSL_DIRECT: 'Ssl',
        SSL_PROXY: 'Tlsws',
        DIRECT: 'Direct',
        PROXY: 'Proxy',
        SSL: 'Ssl',
        TLSWS: 'Tlsws',
        XHTTP: 'XHTTP',
        SSH_BHTTP: 'SSH_BHTTP',
        BHTTP_SSH: 'SSH_BHTTP',
        BHTTP: 'SSH_BHTTP'
    };
    return map[normalized] || 'Direct';
}

function normalizeImportedTls(value) {
    const normalized = String(value ?? '').trim().toUpperCase();
    return ['TLSV1.3', 'TLSV1.2', 'TLSV1.1'].includes(normalized)
        ? normalized.replace('TLSV', 'TLSv')
        : 'TLSv1.2';
}

function convertExternalServer(item, index) {
    const source = item && typeof item === 'object' ? item : {};
    const auth = source.auth && typeof source.auth === 'object' ? source.auth : {};
    const category = source.category && typeof source.category === 'object' ? source.category : {};
    const payload = source.config_payload && typeof source.config_payload === 'object' ? source.config_payload : {};
    const server = source.server && typeof source.server === 'object' ? source.server : {};
    const proxy = source.proxy && typeof source.proxy === 'object' ? source.proxy : {};
    const mode = mapImportedMode(source.mode);
    const sourceBhttp = source.bhttp_config || source.bhttp || {};
    const categoryColor = String(category.color || '#0000ff').replace(/([A-Fa-f0-9]{6})[A-Fa-f0-9]{2}$/, '$1');

    return {
        Name: String(source.name || `Servidor ${index + 1}`),
        ColorName: categoryColor,
        Description: String(source.description || category.name || ''),
        ColorDescription: categoryColor,
        FLAG: String(source.icon || ''),
        ServerIP: normalizeImportedList(server.host),
        ServerPort: String(server.port ?? '443'),
        CheckUser: String(source.url_check_user || ''),
        USER: String(auth.username ?? ''),
        PASS: String(auth.password ?? ''),
        Payload: normalizeImportedPayload(payload.payload),
        ProxyIP: normalizeImportedList(proxy.host),
        ProxyPort: String(proxy.port ?? '443'),
        SNI: String(payload.sni ?? ''),
        Path: String(source.path || ''),
        TLSVersion: normalizeImportedTls(source.tls_version),
        Color: categoryColor,
        Info: mode,
        ...(mode === 'SSH_BHTTP' ? {
            mode: 'SSH_BHTTP',
            dt_protocol: String(source.dt_protocol || 'TCP').toUpperCase(),
            dt_port: String(source.dt_port ?? server.port ?? '8000'),
            tls_version: normalizeImportedTls(source.tls_version),
            bhttp_config: normalizeBhttpConfig(sourceBhttp)
        } : {})
    };
}

function convertExternalConfig(incoming) {
    let items = incoming;
    if (incoming && !Array.isArray(incoming) && typeof incoming === 'object') {
        items = incoming.servers || incoming.Servers || incoming.configs || incoming.profiles || incoming.items;
    }
    if (!Array.isArray(items)) return { config: incoming, summary: null };

    const servers = items.map(convertExternalServer);
    const firstUdpPort = items
        .flatMap((item) => Array.isArray(item?.udp_ports) ? item.udp_ports : [])
        .find((port) => port !== null && port !== undefined && String(port).trim() !== '');
    const firstCategory = items.find((item) => item?.category?.name)?.category?.name;
    const summary = {
        source: 'external-array',
        imported: servers.length,
        modes: servers.reduce((acc, server) => { acc[server.Info] = (acc[server.Info] || 0) + 1; return acc; }, {}),
        udpPort: firstUdpPort !== undefined ? String(firstUdpPort) : null,
        category: firstCategory || null,
        warnings: []
    };
    if (items.some((item) => Array.isArray(item?.udp_ports) && item.udp_ports.length > 1)) {
        summary.warnings.push('O painel usa uma única UdpPort global; foi importada a primeira porta encontrada.');
    }
    if (items.some((item) => item?.config_v2ray || item?.config_openvpn)) {
        summary.warnings.push('Configurações V2Ray/OpenVPN não possuem equivalente no formato ATX TUNNEL e foram ignoradas.');
    }
    return {
        config: {
            Servers: servers,
            UdpPort: firstUdpPort !== undefined ? String(firstUdpPort) : undefined,
            Contato: '',
            Site: '',
            Version: 1,
            AppVersion: 1,
            VersionName: '1',
            UpdateApk: '',
            Actualization: 'false',
            Sms: { Version: '1', Update: '', Notes: '' },
            Theme: { Version: '1', AppName: 'ATX TUNNEL' }
        },
        summary
    };
}

// Importar configuraÃ§Ã£o completa e converter arrays do formato externo.
app.post('/api/config/import', requireAuth, requireActivePlanApi, (req, res) => {
    const user = getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'UsuÃ¡rio nÃ£o encontrado' });
    try {
        let incoming = req.body;
        if (incoming && incoming.config_json) {
            incoming = typeof incoming.config_json === 'string'
                ? JSON.parse(incoming.config_json)
                : incoming.config_json;
        }
        if (typeof incoming === 'string') incoming = JSON.parse(incoming);
        if (!incoming || typeof incoming !== 'object') {
            return res.status(400).json({ error: 'JSON invÃ¡lido' });
        }
        const currentConfig = parseUserConfig(user);
        const converted = convertExternalConfig(incoming);
        const candidateConfig = converted.summary
            ? {
                ...currentConfig,
                ...converted.config,
                AppVersion: currentConfig.AppVersion,
                VersionName: currentConfig.VersionName,
                UpdateApk: currentConfig.UpdateApk,
                Actualization: currentConfig.Actualization,
                Contato: currentConfig.Contato,
                Site: currentConfig.Site,
                Sms: currentConfig.Sms,
                Theme: currentConfig.Theme
            }
            : converted.config;
        const nextConfig = applyAutomaticVersions(currentConfig, normalizeConfigPayload(candidateConfig));
        user.config_json = JSON.stringify(nextConfig, null, 2);
        saveUser(user.username, user);
        res.json({ ok: true, config: nextConfig, importSummary: converted.summary });
    } catch (e) {
        res.status(400).json({ error: 'JSON invÃ¡lido' });
    }
});

function sendDynamicJson(res, payload) {
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0'
    });
    return res.type('application/json').send(payload);
}

// Resolvedor unificado: o aplicativo precisa conhecer apenas o UUID.
app.get('/u/:uuid', (req, res) => {
    const user = findUserByUpdateUuid(req.params.uuid);
    if (!user) return res.status(404).json({ error: 'UUID de atualização não encontrado' });
    const uuid = ensureUserUpdateUuid(user);
    sendDynamicJson(res, buildUpdateManifest(req, uuid, user));
});

app.get('/u/:uuid/config', (req, res) => {
    const user = findUserByUpdateUuid(req.params.uuid);
    if (!user) return res.status(404).send('Not Found');
    const uuid = ensureUserUpdateUuid(user);
    sendDynamicJson(res, buildUserConfig(req, uuid, user, '/u'));
});

app.get('/u/:uuid/appupdate', (req, res) => {
    const user = findUserByUpdateUuid(req.params.uuid);
    if (!user) return res.status(404).send('Not Found');
    const uuid = ensureUserUpdateUuid(user);
    sendDynamicJson(res, buildAppUpdate(req, uuid, user, '/u'));
});

app.get('/u/:uuid/sms', (req, res) => {
    const user = findUserByUpdateUuid(req.params.uuid);
    if (!user) return res.status(404).send('Not Found');
    sendDynamicJson(res, buildSmsPayload(user));
});

app.get('/u/:uuid/theme', (req, res) => {
    const user = findUserByUpdateUuid(req.params.uuid);
    if (!user) return res.status(404).send('Not Found');
    const uuid = ensureUserUpdateUuid(user);
    sendDynamicJson(res, buildThemePayload(req, uuid, user, '/u'));
});

// Endpoints pÃºblicos no formato esperado pelo aplicativo (legado).
app.get('/:username/config', (req, res) => {
    const username = req.params.username;
    const user = getUser(username);
    if (!user) return res.status(404).send('Not Found');
    sendDynamicJson(res, buildUserConfig(req, username, user));
});

app.get('/:username/appupdate', (req, res) => {
    const username = req.params.username;
    const user = getUser(username);
    if (!user) return res.status(404).send('Not Found');
    sendDynamicJson(res, buildAppUpdate(req, username, user));
});

app.get('/:username/sms', (req, res) => {
    const username = req.params.username;
    const user = getUser(username);
    if (!user) return res.status(404).send('Not Found');
    sendDynamicJson(res, buildSmsPayload(user));
});

app.get('/:username/theme', (req, res) => {
    const username = req.params.username;
    const user = getUser(username);
    if (!user) return res.status(404).send('Not Found');
    sendDynamicJson(res, buildThemePayload(req, username, user));
});
app.listen(PORT, '0.0.0.0', () => {
    console.log(`ATX Config Panel listening on port ${PORT}`);
    void verifySmtpConfiguration();
});
