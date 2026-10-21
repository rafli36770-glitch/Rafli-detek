require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const SECRET = process.env.OTP_SECRET || '';
const PHONE_NUMBER = process.env.PHONE_NUMBER || '';
const COOLDOWN_MS = parseInt(process.env.COOLDOWN_MS || '60000', 10);
const OTP_TTL_MS = parseInt(process.env.OTP_TTL_MS || '300000', 10);
const MAX_ATTEMPTS = parseInt(process.env.MAX_ATTEMPTS || '3', 10);
const MAX_SENDS_PER_HOUR = parseInt(process.env.MAX_SENDS_PER_HOUR || '5', 10);

if (!SECRET || SECRET.length < 32) {
    console.error('OTP_SECRET wajib di-set, minimal 32 karakter.');
    process.exit(1);
}
if (!PHONE_NUMBER) {
    console.error('PHONE_NUMBER wajib di-set.');
    process.exit(1);
}

app.use(express.json());
app.use(express.static('public'));

let isReady = false;

const sessionPath = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'session')
    : path.join(__dirname, 'session');

const client = new Client({
    authStrategy: new LocalAuth({
        clientId: 'otp-sender-v2', // GANTI KE V2 BIAR SESI BARU
        dataPath: sessionPath
    }),
    pairWithPhoneNumber: {
        phoneNumber: PHONE_NUMBER,
        showNotification: true,
        intervalMs: 180000
    },
    puppeteer: {
        headless: true,
        executablePath: '/usr/bin/chromium',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
});

client.on('code', (code) => {
    console.log('\n============================================');
    console.log('  KODE PAIRING WHATSAPP: ' + code);
    console.log('============================================');
    console.log('Buka WhatsApp -> Linked Devices -> Link with phone number -> masukkan kode.\n');
});
client.on('ready', () => {
    isReady = true;
    console.log('\nWhatsApp READY.\n');
});
client.on('authenticated', () => console.log('Authenticated.'));
client.on('auth_failure', (m) => { isReady = false; console.error('Auth gagal:', m); });
client.on('disconnected', (r) => { isReady = false; console.log('Disconnected:', r); });

client.initialize();

const store = new Map();

function normalizeNumber(raw) {
    let s = String(raw).replace(/[^0-9]/g, '');
    if (s.startsWith('0')) s = '62' + s.slice(1);
    return s;
}
function hashOtp(code) {
    return crypto.createHmac('sha256', SECRET).update(code).digest('hex');
}
function generateOtp() {
    return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}
function checkCooldown(num) {
    const entry = store.get(num);
    const now = Date.now();
    if (!entry) return { ok: true };
    if (entry.lastSentAt && now - entry.lastSentAt < COOLDOWN_MS) {
        return { ok: false, reason: 'cooldown', remainingMs: COOLDOWN_MS - (now - entry.lastSentAt) };
    }
    const recent = (entry.sendTimestamps || []).filter(t => now - t < 3600000);
    if (recent.length >= MAX_SENDS_PER_HOUR) {
        return { ok: false, reason: 'hourly_limit', remainingMs: 3600000 - (now - recent[0]) };
    }
    return { ok: true };
}

setInterval(() => {
    const now = Date.now();
    for (const [k, v] of store.entries()) {
        const expired = v.expiresAt < now;
        const stale = !v.lastSentAt || now - v.lastSentAt > 3600000;
        if (expired && stale) store.delete(k);
    }
}, 10 * 60 * 1000);

app.post('/api/otp/send', async (req, res) => {
    if (!isReady) return res.status(503).json({ error: 'WhatsApp belum terhubung.' });
    const { number } = req.body || {};
    if (!number) return res.status(400).json({ error: 'Field number wajib.' });
    const num = normalizeNumber(number);
    if (num.length < 8 || num.length > 15) return res.status(400).json({ error: 'Nomor tidak valid.' });

    const cd = checkCooldown(num);
    if (!cd.ok) return res.status(429).json({
        error: cd.reason === 'cooldown' ? 'Masih cooldown.' : 'Batas per jam tercapai.',
        reason: cd.reason, remainingMs: cd.remainingMs
    });

    const code = generateOtp();
    const hash = hashOtp(code);
    const now = Date.now();
    const waId = num + '@c.us';

    try {
        const registered = await client.isRegisteredUser(waId);
        if (!registered) return res.status(404).json({ error: 'Nomor tidak terdaftar di WhatsApp.' });
        const ttlMin = Math.round(OTP_TTL_MS / 60000);
        const message = 'Kode OTP kamu: *' + code + '*\n\nBerlaku ' + ttlMin + ' menit. Jangan bagikan.';
        await client.sendMessage(waId, message);

        const existing = store.get(num) || { sendTimestamps: [] };
        const recent = (existing.sendTimestamps || []).filter(t => now - t < 3600000);
        recent.push(now);
        store.set(num, { hash, expiresAt: now + OTP_TTL_MS, attempts: 0, lastSentAt: now, sendTimestamps: recent });

        return res.json({
            ok: true, message: 'OTP terkirim.', cooldownMs: COOLDOWN_MS, ttlMs: OTP_TTL_MS,
            sendsThisHour: recent.length, maxSendsPerHour: MAX_SENDS_PER_HOUR
        });
    } catch (err) {
        return res.status(500).json({ error: 'Gagal kirim.', detail: err.message });
    }
});

app.post('/api/otp/verify', (req, res) => {
    const { number, code } = req.body || {};
    if (!number || !code) return res.status(400).json({ error: 'number & code wajib.' });
    const num = normalizeNumber(number);
    const entry = store.get(num);
    if (!entry) return res.status(404).json({ error: 'Belum ada OTP.' });
    if (Date.now() > entry.expiresAt) { store.delete(num); return res.status(410).json({ error: 'OTP kedaluwarsa.' }); }
    if (entry.attempts >= MAX_ATTEMPTS) return res.status(429).json({ error: 'Terlalu banyak percobaan.' });
    entry.attempts += 1;
    const expected = hashOtp(String(code).trim());
    const a = Buffer.from(entry.hash, 'hex');
    const b = Buffer.from(expected, 'hex');
    const match = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!match) return res.status(401).json({ error: 'Kode salah.', attemptsLeft: Math.max(0, MAX_ATTEMPTS - entry.attempts) });
    store.delete(num);
    return res.json({ ok: true, message: 'Verifikasi berhasil.' });
});

app.get('/api/otp/status', (req, res) => {
    const raw = req.query.number;
    if (!raw) return res.status(400).json({ error: 'number wajib.' });
    const num = normalizeNumber(raw);
    const entry = store.get(num);
    const now = Date.now();
    if (!entry) return res.json({ number: num, hasOtp: false, cooldownRemainingMs: 0 });
    return res.json({
        number: num,
        hasOtp: Math.max(0, entry.expiresAt - now) > 0,
        cooldownRemainingMs: entry.lastSentAt ? Math.max(0, COOLDOWN_MS - (now - entry.lastSentAt)) : 0,
        expiresInMs: Math.max(0, entry.expiresAt - now),
        attemptsUsed: entry.attempts,
        attemptsLeft: Math.max(0, MAX_ATTEMPTS - entry.attempts),
        sendsThisHour: (entry.sendTimestamps || []).filter(t => now - t < 3600000).length
    });
});

app.get('/api/otp/logs', (req, res) => {
    const list = [];
    for (const [num, e] of store.entries()) {
        const masked = num.length > 4 ? '*'.repeat(num.length - 4) + num.slice(-4) : '****';
        list.push({ number: masked, lastSentAt: e.lastSentAt || null, expiresAt: e.expiresAt, attempts: e.attempts });
    }
    list.sort((a, b) => (b.lastSentAt || 0) - (a.lastSentAt || 0));
    res.json({ logs: list.slice(0, 50) });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log('Server jalan di port ' + PORT);
    console.log('Menunggu pairing code...');
});
