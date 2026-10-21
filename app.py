import os
import sqlite3
import time
import requests
from flask import Flask, render_template, request, jsonify
from concurrent.futures import ThreadPoolExecutor

app = Flask(__name__)
DB_PATH = "wa_otp.db"

# ── [ KONFIGURASI WA GATEWAY ] ─────────────────────────────────────────────
# Isi ini di Environment Variables Railway
WA_API_URL = os.getenv("WA_API_URL", "") # Contoh: http://ip-vps:21465
WA_SESSION = os.getenv("WA_SESSION", "aldo")
WA_TOKEN = os.getenv("WA_TOKEN", "TOKEN_WPPCONNECT")

DEFAULT_CD = 300 # 5 Menit cooldown WhatsApp OTP

def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS numbers (
        phone TEXT PRIMARY KEY,
        status TEXT,
        last_sent REAL,
        cooldown_until REAL
    )''')
    conn.commit()
    conn.close()

init_db()

# ── [ LOGIKA WHATSAPP API ] ────────────────────────────────────────────────
def check_wa_exist(phone):
    """Nembak API WPPConnect buat cek nomor aktif di WA atau nggak."""
    if not WA_API_URL:
        # MOCK (Buat testing sebelum lo pasang WPPConnect)
        time.sleep(0.5)
        if phone.endswith("000"): return "not_registered"
        if phone.endswith("111"): return "clone_restricted"
        return "valid"

    url = f"{WA_API_URL}/api/{WA_SESSION}/checkNumberStatus"
    headers = {"Authorization": f"Bearer {WA_TOKEN}"}
    try:
        r = requests.post(url, json={"phone": phone}, headers=headers, timeout=10)
        data = r.json()
        if data.get("status") == "success":
            if data.get("response", {}).get("exists"):
                return "valid"
            return "not_registered"
        return "error"
    except Exception:
        return "error"

def process_number(phone):
    """Logika nentuin status: Siap, Cooldown, Terbanned, dll."""
    phone = phone.strip()
    if not phone.startswith("+"):
        phone = "+" + phone

    # 1. Cek validitas nomor ke WA
    wa_status = check_wa_exist(phone)
    if wa_status == "not_registered":
        return {"phone": phone, "status": "Terbanned", "cd": 0}
    elif wa_status == "clone_restricted":
        return {"phone": phone, "status": "Gak support clone", "cd": 0}
    elif wa_status == "error":
        return {"phone": phone, "status": "Error", "cd": 0}

    # 2. Cek Cooldown di Database
    now = time.time()
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT cooldown_until FROM numbers WHERE phone=?", (phone,))
    row = c.fetchone()
    conn.close()

    if row and row[0] > now:
        return {"phone": phone, "status": "Cooldown", "cd": row[0] - now}
    
    return {"phone": phone, "status": "Siap OTP", "cd": 0}

# ── [ ROUTING WEB & API ] ──────────────────────────────────────────────────
@app.route("/")
def index():
    return render_template("index.html")

@app.route("/api/scan", methods=["POST"])
def scan_massal():
    data = request.json or {}
    numbers = data.get("numbers", [])
    
    results = []
    # Cek 10 nomor barengan
    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = [executor.submit(process_number, num) for num in numbers]
        for future in futures:
            results.append(future.result())
            
    # Hitung statistik
    stats = {"siap": 0, "cooldown": 0, "banned": 0, "no_otp": 0, "no_clone": 0, "ngambek": 0, "error": 0}
    for r in results:
        if r["status"] == "Siap OTP": stats["siap"] += 1
        elif r["status"] == "Cooldown": stats["cooldown"] += 1
        elif r["status"] == "Terbanned": stats["banned"] += 1
        elif r["status"] == "Tidak dapat OTP": stats["no_otp"] += 1
        elif r["status"] == "Gak support clone": stats["no_clone"] += 1
        elif r["status"] == "Ngambek": stats["ngambek"] += 1
        elif r["status"] == "Error": stats["error"] += 1

    return jsonify({"stats": stats, "results": results})

@app.route("/api/send_otp", methods=["POST"])
def send_otp():
    """Dipanggil pas lo mau kirim OTP beneran. Ngunci cooldown di sini."""
    phone = request.json.get("phone")
    if not phone:
        return jsonify({"status": "error", "message": "No phone"}), 400
    
    # (Di sini lo bisa tambahin kode buat nembak WA API kirim OTP)
    # Misal: requests.post(f"{WA_API_URL}/api/{WA_SESSION}/sendText", ...)

    now = time.time()
    cooldown_until = now + DEFAULT_CD

    conn = sqlite3.connect(DB_PATH)
    conn.execute('''INSERT INTO numbers (phone, status, last_sent, cooldown_until)
                    VALUES (?, 'Cooldown', ?, ?)
                    ON CONFLICT(phone) DO UPDATE SET 
                    status='Cooldown', last_sent=?, cooldown_until=?''',
                 (phone, now, cooldown_until, now, cooldown_until))
    conn.commit()
    conn.close()

    return jsonify({"status": "success", "message": "OTP sent, cooldown started"})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
