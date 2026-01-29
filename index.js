import TelegramBot from "node-telegram-bot-api";
import Parser from "rss-parser";
import fetch from "node-fetch";
import Database from "better-sqlite3";
import Groq from "groq-sdk";
import sharp from "sharp";

// ================= CONFIG =================
const BOT_TOKEN = "8572802638:AAHlrrMSdCB8rFG8YF-Sl3X6sOfc3-57X6I";
const CHANNEL = "@GeoPoliticsOnly";
const GROQ_API_KEY = "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";
const PEXELS_API_KEY = "dAx3quwUwITeyuTpKaISaByhksu51TgH0tUUVAFlryAwYzvv8OkNmJOQ";

const POST_INTERVAL = 15 * 60 * 1000;

const RSS_FEEDS = [
  "https://indianexpress.com/section/india/feed/"
];
// =========================================

// ================= INIT =================
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const parser = new Parser();
const groq = new Groq({ apiKey: GROQ_API_KEY });

// ================= DATABASE =================
const db = new Database("news.db");

db.prepare(`
  CREATE TABLE IF NOT EXISTS news (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT UNIQUE,
    signature TEXT
  )
`).run();

// ================= DB HELPERS =================

function urlExists(url) {
  return !!db.prepare("SELECT 1 FROM news WHERE url = ?").get(url);
}

function saveNews(url, signature) {
  db.prepare(
    "INSERT OR IGNORE INTO news (url, signature) VALUES (?, ?)"
  ).run(url, signature);
}

async function isDuplicateSignature(signature) {
  const rows = db.prepare(`
    SELECT signature FROM news
    ORDER BY id DESC
    LIMIT 25
  `).all();

  if (!rows.length) return false;

  const old = rows.map(r => r.signature).join("\n");

  const res = await groq.chat.completions.create({
    model: "llama-3.1-8b-instant",
    temperature: 0,
    messages: [{
      role: "user",
      content: `
Decide if the NEW event is the SAME as any OLD event.
Minor wording changes are NOT new events.
Answer ONLY YES or NO.

NEW:
${signature}

OLD:
${old}
      `
    }]
  });

  return res.choices[0].message.content.trim() === "YES";
}

// ================= IMAGE LOGIC =================

async function getArticleImage(url) {
  try {
    const html = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" }
    }).then(r => r.text());

    const match = html.match(
      /<meta property="og:image" content="([^"]+)"/
    );
    if (!match) return null;

    const imgUrl = match[1].toLowerCase();
    const bad = [
      "/logo", "/icon", "/favicon", "/brand",
      "/sprite", "/header", "/static", "/assets", "/themes"
    ];
    if (bad.some(b => imgUrl.includes(b))) return null;

    const imgBuf = await fetch(match[1]).then(r => r.arrayBuffer());
    const meta = await sharp(Buffer.from(imgBuf)).metadata();

    if (meta.width < 500 || meta.height < 300) return null;

    const ratio = meta.width / meta.height;
    if (ratio > 3 || ratio < 0.6) return null;

    return match[1];
  } catch {
    return null;
  }
}

async function generateImageQuery(title, summary) {
  const res = await groq.chat.completions.create({
    model: "llama-3.1-8b-instant",
    temperature: 0,
    messages: [{
      role: "user",
      content: `
Generate a short image search query for this news.
3–6 words, no punctuation, no dates.

Title: ${title}
Details: ${summary}
      `
    }]
  });
  return res.choices[0].message.content.trim();
}

async function fetchImageFromPexels(query) {
  const r = await fetch(
    `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1`,
    { headers: { Authorization: PEXELS_API_KEY } }
  ).then(r => r.json());

  return r.photos?.[0]?.src?.large || null;
}

async function getBestImage(link, title, summary) {
  return (
    await getArticleImage(link) ||
    await fetchImageFromPexels(
      await generateImageQuery(title, summary)
    )
  );
}

// ================= GROQ TEXT =================

async function refineNews(title, summary) {
  const res = await groq.chat.completions.create({
    model: "llama-3.1-8b-instant",
    temperature: 0.3,
    messages: [{
      role: "user",
      content: `
Rewrite into 1–2 factual sentences.
Neutral tone, no hype.

Title: ${title}
Details: ${summary}
      `
    }]
  });
  return res.choices[0].message.content.trim();
}

async function generateSignature(title, summary) {
  const res = await groq.chat.completions.create({
    model: "llama-3.1-8b-instant",
    temperature: 0,
    messages: [{
      role: "user",
      content: `
Summarize the core event in ONE factual sentence.

${title}
${summary}
      `
    }]
  });
  return res.choices[0].message.content.trim();
}

// ================= CORE LOOP =================

async function fetchAndPostOne() {
  for (const feedUrl of RSS_FEEDS) {
    const feed = await parser.parseURL(feedUrl);

    for (const entry of feed.items) {
      const link = entry.link;
      const summary = entry.contentSnippet || "";

      if (urlExists(link)) continue;

      const signature = await generateSignature(entry.title, summary);
      if (await isDuplicateSignature(signature)) continue;

      const image = await getBestImage(link, entry.title, summary);
      if (!image) continue;

      const refined = await refineNews(entry.title, summary);

      const caption =
        `🇮🇳 *${entry.title}*\n\n` +
        `${refined}\n\n` +
        `🔗 ${link}`;

      try {
        await bot.sendPhoto(CHANNEL, image, {
          caption,
          parse_mode: "Markdown"
        });
        saveNews(link, signature);
        console.log("✅ Posted:", entry.title);
        return;
      } catch (e) {
        console.log("Telegram error:", e.message);
        return;
      }
    }
  }
}

// ================= SCHEDULER =================

console.log("🤖 Bot running (Node.js polling)");

fetchAndPostOne();
setInterval(fetchAndPostOne, POST_INTERVAL);
