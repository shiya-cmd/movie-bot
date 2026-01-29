import asyncio
import sqlite3
import feedparser
import requests
from bs4 import BeautifulSoup
from io import BytesIO
from PIL import Image
from telegram import Update, Bot
from telegram.ext import (
    Application,
    ContextTypes,
)
from groq import Groq
from flask import Flask, request

# ================= CONFIG =================
BOT_TOKEN = "YOUR_BOT_TOKEN"
CHANNEL = "@GeoPoliticsOnly"
GROQ_API_KEY = "YOUR_GROQ_API_KEY"
PEXELS_API_KEY = "YOUR_PEXELS_API_KEY"

POST_INTERVAL = 900  # 15 minutes

RSS_FEEDS = [
    "https://www.thehindu.com/news/national/feeder/default.rss",
    "https://indianexpress.com/section/india/feed/",
]
# =========================================

bot = Bot(BOT_TOKEN)
groq = Groq(api_key=GROQ_API_KEY)

# ================= DATABASE =================
conn = sqlite3.connect("news.db", check_same_thread=False)
cur = conn.cursor()
cur.execute("""
CREATE TABLE IF NOT EXISTS news (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT UNIQUE,
    signature TEXT
)
""")
conn.commit()

# ================= HELPERS =================

def url_exists(url):
    cur.execute("SELECT 1 FROM news WHERE url = ?", (url,))
    return cur.fetchone() is not None


def save_news(url, signature):
    cur.execute(
        "INSERT OR IGNORE INTO news (url, signature) VALUES (?, ?)",
        (url, signature)
    )
    conn.commit()


def get_article_image(url):
    try:
        r = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=10)
        soup = BeautifulSoup(r.text, "html.parser")
        og = soup.find("meta", property="og:image")
        if not og or not og.get("content"):
            return None

        img_url = og["content"]
        if any(x in img_url.lower() for x in ["/logo", "/icon", "/static", "/assets"]):
            return None

        img = Image.open(BytesIO(requests.get(img_url).content))
        w, h = img.size
        if w < 500 or h < 300 or w / h > 3 or w / h < 0.6:
            return None

        return img_url
    except:
        return None


def generate_image_query(title, summary):
    prompt = f"Generate 3-6 word image search query for news:\n{title}\n{summary}"
    r = groq.chat.completions.create(
        model="llama-3.1-8b-instant",
        messages=[{"role": "user", "content": prompt}],
        temperature=0
    )
    return r.choices[0].message.content.strip()


def fetch_image_from_pexels(query):
    r = requests.get(
        "https://api.pexels.com/v1/search",
        headers={"Authorization": PEXELS_API_KEY},
        params={"query": query, "per_page": 1},
        timeout=10
    )
    photos = r.json().get("photos", [])
    return photos[0]["src"]["large"] if photos else None


def refine_news(title, summary):
    prompt = f"Rewrite in 1–2 neutral factual sentences:\n{title}\n{summary}"
    r = groq.chat.completions.create(
        model="llama-3.1-8b-instant",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.3
    )
    return r.choices[0].message.content.strip()


def generate_signature(title, summary):
    r = groq.chat.completions.create(
        model="llama-3.1-8b-instant",
        messages=[{"role": "user", "content": f"{title}\n{summary}"}],
        temperature=0
    )
    return r.choices[0].message.content.strip()


# ================= CORE TASK =================

async def fetch_and_post_one():
    for feed_url in RSS_FEEDS:
        feed = feedparser.parse(feed_url)

        for entry in feed.entries:
            link = entry.link
            summary = entry.get("summary", "")

            if url_exists(link):
                continue

            signature = generate_signature(entry.title, summary)
            image = get_article_image(link) or fetch_image_from_pexels(
                generate_image_query(entry.title, summary)
            )

            if not image:
                continue

            refined = refine_news(entry.title, summary)

            await bot.send_photo(
                chat_id=CHANNEL,
                photo=image,
                caption=f"🇮🇳 *{entry.title}*\n\n{refined}\n\n🔗 {link}",
                parse_mode="Markdown"
            )

            save_news(link, signature)
            return


async def scheduler():
    while True:
        await fetch_and_post_one()
        await asyncio.sleep(POST_INTERVAL)

# ================= FLASK WEBHOOK =================

flask_app = Flask(__name__)

@flask_app.route("/", methods=["GET"])
def home():
    return "Bot is running"

@flask_app.route("/webhook", methods=["POST"])
async def webhook():
    return "OK"

# ================= START =================

def main():
    loop = asyncio.get_event_loop()
    loop.create_task(scheduler())
    flask_app.run(host="0.0.0.0", port=10000)

if __name__ == "__main__":
    main()
