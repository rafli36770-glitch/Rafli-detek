# app.py
import time
from flask import Flask, render_template

app = Flask(__name__)

@app.route("/")
def index():
    # Simulasi data checker
    # Nanti tinggal sambungin ke API/database asli lo
    now = time.time()
    data = {
        "stats": {
            "siap": 1,
            "cooldown": 1,
            "banned": 0,
            "no_otp": 0,
            "no_clone": 0,
            "ngambek": 2,
            "error": 0,
        },
        "ready": ["+94703007162"],
        "cooldowns": {
            "+94703007338": now + (14 * 3600) + (36 * 60) + 9,
        }
    }
    return render_template("index.html", data=data)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
