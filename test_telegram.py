import os
import requests
from dotenv import load_dotenv

load_dotenv()
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID   = os.getenv("TELEGRAM_CHAT_ID", "")

url     = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
payload = {
    "chat_id":    TELEGRAM_CHAT_ID,
    "text":       "✅ Test ABCD Scanner — Telegram funcionando correctamente.",
    "parse_mode": "Markdown",
}

resp = requests.post(url, json=payload, timeout=10)
print("Status:", resp.status_code)
print("Respuesta:", resp.json())
