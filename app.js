import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import iconv from "iconv-lite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// ---- CORS (для OpenAI Actions)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, OpenAI-Beta");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

// ---- Конфиг источников
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "sources.json"), "utf8"));
const ALLOWED = cfg.sources || [];

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim();
}
function tokenize(s) {
  return normalize(s).replace(/[^\p{L}\p{N}\s]/gu, " ").split(" ").filter(Boolean);
}
function makeSnippet(text, start, end, pad = 160) {
  const beg = Math.max(0, start - pad);
  const fin = Math.min(text.length, end + pad);
  let snip = text.slice(beg, fin).replace(/\s+/g, " ").trim();
  if (beg > 0) snip = "… " + snip;
  if (fin < text.length) snip = snip + " …";
  return snip;
}

async function fetchBuffer(url, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept-Language": "ru,en;q=0.8"
      }
    });
    if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const ctype = (r.headers.get("content-type") || "").toLowerCase();
    // чаще всего UTF-8, но перестрахуемся
    const isUtf8 = /charset=utf-8|utf8/.test(ctype);
    return isUtf8 ? buf.toString("utf8") : iconv.decode(buf, "utf8");
  } finally {
    clearTimeout(t);
  }
}

// Простейший HTML→текст
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|h\d)>/gi, "$&\n")   // переносы после блоков
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\u00A0/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

// Разбиение на фрагменты по «Статья/Глава/Раздел»
function splitTaxText(raw) {
  const chunks = raw.split(/(?=\b(статья|глава|раздел)\b[\s\d.:–—-]*)/gi)
    .map(s => s.trim()).filter(Boolean);
  if (chunks.length <= 1) {
    return [{ id: 1, title: "Налоговый кодекс (весь текст)", text: raw }];
  }
  let i = 1;
  return chunks.map(c => {
    const title = c.slice(0, 140);
    return { id: i++, title, text: c };
  });
}

let SECTIONS = [];
let META = { sections: 0 };

async function loadAll() {
  SECTIONS = [];
  for (const [i, url] of ALLOWED.entries()) {
    try {
      const html = await fetchBuffer(url);
      const text = htmlToText(html);
      const parts = splitTaxText(text);
      // помечаем id с префиксом источника (если их будет несколько)
      parts.forEach((p, k) => (p.id = Number(`${i + 1}${String(k + 1).padStart(3, "0")}`), p.url = url));
      SECTIONS.push(...parts);
    } catch (e) {
      console.error("Load failed:", url, e.message);
    }
  }
  META.sections = SECTIONS.length;
  console.log(`Loaded sections: ${META.sections}`);
}

await loadAll();

// ---- Эндпоинты
app.get("/health", (req, res) => {
  res.json({ status: "ok", sources: ALLOWED.length, sections: META.sections });
});

app.get("/sources", (req, res) => {
  res.json({ sources: ALLOWED });
});

app.get("/section", (req, res) => {
  const id = Number(req.query.id);
  const s = SECTIONS.find(x => x.id === id);
  if (!s) return res.status(404).json({ error: "not_found" });
  res.json({ id: s.id, title: s.title, url: s.url, text: s.text });
});

function scoreMatch(hayRaw, needleRaw, terms) {
  const hay = normalize(hayRaw);
  const needle = normalize(needleRaw);

  const idxPhrase = hay.indexOf(needle);
  if (needle && idxPhrase >= 0) {
    return { score: 120 + needle.length, posStart: idxPhrase, posEnd: idxPhrase + needle.length };
  }

  let score = 0;
  let firstPos = -1;
  for (const t of terms) {
    const re = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    const m = hay.match(re);
    if (m) {
      score += Math.min(25, t.length * 2);
      if (firstPos < 0) firstPos = m.index;
    }
  }
  if (score > 0) {
    const span = Math.min(hay.length, (firstPos >= 0 ? firstPos : 0) + 100);
    return { score, posStart: Math.max(0, (firstPos >= 0 ? firstPos : 0)), posEnd: span };
  }
  return { score: 0, posStart: -1, posEnd: -1 };
}

app.post("/search", (req, res) => {
  const q = String(req.body?.query || "").trim();
  const limit = Math.max(1, Math.min(50, Number(req.body?.limit ?? 10)));
  if (!q) return res.status(400).json({ error: "bad_request", detail: "field 'query' is required" });

  const qNorm = normalize(q);
  const terms = tokenize(qNorm);
  const hits = [];

  for (const s of SECTIONS) {
    const { score, posStart, posEnd } = scoreMatch(s.text, qNorm, terms);
    if (score > 0) {
      hits.push({
        id: s.id,
        title: s.title,
        url: s.url,
        score,
        excerpt: makeSnippet(s.text, posStart, posEnd)
      });
    }
  }

  // fallback по числам (например, «статья 19»)
  if (hits.length === 0) {
    const nums = (q.match(/\d+/g) || []).slice(0, 2);
    for (const s of SECTIONS) {
      for (const n of nums) {
        const idx = normalize(s.text).indexOf(n);
        if (idx >= 0) {
          hits.push({
            id: s.id,
            title: s.title,
            url: s.url,
            score: 5,
            excerpt: makeSnippet(s.text, idx, idx + String(n).length)
          });
          break;
        }
      }
    }
  }

  hits.sort((a, b) => b.score - a.score);
  res.json({ result: hits.slice(0, limit) });
});

app.post("/reload", async (req, res) => {
  try {
    await loadAll();
    res.json({ reloaded: true, sections: META.sections });
  } catch (e) {
    res.status(500).json({ error: "reload_failed", detail: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Taxcode API on ${PORT}, sections=${META.sections}`));
