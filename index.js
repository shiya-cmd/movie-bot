import TelegramBot from "node-telegram-bot-api";
import Parser from "rss-parser";
import fetch from "node-fetch";
import Database from "better-sqlite3";

// ================= CONFIG =================
const BOT_TOKEN = "YOUR_BOT_TOKEN";
const CHANNEL = "@GeoPoliticsOnly";

const POST_INTERVAL = 15 * 60 * 1000; // 15 minutes

const RSS_FEEDS = [
  "https://www.thehindu.com/news/national/feeder/default.rss",
  "https://indianexpress.com/section/india/feed/"
];
// ========================================

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const parser = new Parser();

// ================= DATABASE =================
const db = new Database("news.db");
db.prepare(`
  CREATE TABLE IF NOT EXISTS news (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT UNIQUE
  )
`).run();

function urlExists(url) {
  const row = db.prepare("SELECT 1 FROM news WHERE url = ?").get(url);
  return !!row;
}

function saveUrl(url) {
  db.prepare("INSERT OR IGNORE INTO news (url) VALUES (?)").run(url);
}

// ================= NEWS LOGIC =================

async function fetchAndPostOne() {
  for (const feedUrl of RSS_FEEDS) {
    const feed = await parser.parseURL(feedUrl);

    for (const item of feed.items) {
      const link = item.link;
      if (!link || urlExists(link)) continue;

      const title = item.title || "News Update";
      const summary = item.contentSnippet || "";

      const caption =
        `🇮🇳 *${title}*\n\n` +
        `${summary}\n\n` +
        `🔗 ${link}`;

      try {
        await bot.sendMessage(CHANNEL, caption, {
          parse_mode: "Markdown"
        });
        saveUrl(link);
        console.log("✅ Posted:", title);
        return; // ONE news only
      } catch (e) {
        console.log("Telegram error:", e.message);
        return;
      }
    }
  }
}

// ================= SCHEDULER =================

console.log("🤖 Bot started (polling mode)");

setInterval(() => {
  fetchAndPostOne();
}, POST_INTERVAL);

// Run once at startup
fetchAndPostOne();
