import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// ---- CORS для OpenAI Actions
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, OpenAI-Beta");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

// ---- конфиг источников (только HTML)
const cfgPath = path.join(__dirname, "sources.json");
const CFG = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const ALLOWED = CFG.sources || [];
if (!ALLOWED.length) console.warn("⚠️ sources.json пуст — добавь хотя бы одну HTML-ссылку.");

// ===== утилиты нормализации / поиска =====
function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim();
}
function tokenize(s) {
  return normalize(s)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(" ")
    .filter(Boolean);
}
function stemRegex(word) {
  const w = word.normalize("NFC");
  if (/^\d+$/.test(w)) return new RegExp(`\\b${w}\\b`, "i"); // числа — точные
  const base = w.length >= 6 ? w.slice(0, 5) : w.length >= 4 ? w.slice(0, 4) : w;
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${esc}\\w*`, "i");
}
function makeSnippet(text, start, end, pad = 160) {
  const beg = Math.max(0, start - pad);
  const fin = Math.min(text.length, end + pad);
  let snip = text.slice(beg, fin).replace(/\s+/g, " ").trim();
  if (beg > 0) snip = "… " + snip;
  if (fin < text.length) snip = snip + " …";
  return snip;
}
function bestScore(hayRaw, phrase, terms) {
  const hay = normalize(hayRaw);
  const idxPhrase = phrase ? hay.indexOf(phrase) : -1;
  if (phrase && idxPhrase >= 0) {
    return { score: 120 + phrase.length, posStart: idxPhrase, posEnd: idxPhrase + phrase.length };
  }
  let score = 0, firstPos = -1;
  for (const t of terms) {
    const re = stemRegex(t);
    const m = hay.match(re);
    if (m) {
      score += Math.min(25, t.length * 2);
      if (firstPos < 0) firstPos = m.index;
    }
  }
  if (score > 0) {
    const posStart = Math.max(0, firstPos);
    return { score, posStart, posEnd: Math.min(hay.length, posStart + 80) };
  }
  return { score: 0, posStart: -1, posEnd: -1 };
}

function expandSynonyms(q) {
  const nq = normalize(q);
  const out = [nq];
  if (/\bндс\b/.test(nq) || /\bНДС\b/.test(q)) out.push("налог на добавленную стоимость");
  if (/\bтранспорт\w*\b/.test(nq) && /\bналог\w*\b/.test(nq)) {
    out.push("налог на транспортные средства", "налогообложение транспортных средств", "налог на автомобили");
  }
  if (/\bиндивидуаль\w*\b/.test(nq) && /\bпредпринимател\w*\b/.test(nq)) out.push("ИП", "индивидуальные предприниматели");
  return Array.from(new Set(out));
}

// ===== парсинг HTML =====
async function fetchWithTimeout(url, ms = 20000) {
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; TaxCodeBot/1.0)",
        "Accept": "text/html,application/xhtml+xml"
      }
    });
    return r;
  } finally {
    clearTimeout(tm);
  }
}

function extractTextHTML(html) {
  // вытащим основной текст с помощью cheerio
  const $ = cheerio.load(html, { decodeEntities: false });

  // убираем скрипты/стили/навигацию
  $("script, style, noscript, header, nav, footer").remove();

  // если на странице есть очевидные контейнеры — пробуем их сначала
  const candidates = [
    ".document", ".law", ".content", ".article", ".text", "#content", ".container", "main"
  ];

  for (const sel of candidates) {
    if ($(sel).length) {
      const txt = $(sel).find("h1,h2,h3,h4,p,li,td,pre,section,article,div").text();
      const cleaned = txt.replace(/\s+/g, " ").trim();
      if (cleaned.length > 2000) return cleaned;
    }
  }

  // фолбэк: весь видимый текст
  const all = $("h1,h2,h3,h4,p,li,td,pre,section,article,div").text();
  return all.replace(/\s+/g, " ").trim();
}

// Разбиение на фрагменты: «Статья/Глава/Раздел …»
function splitIntoSections(rawText, url, docIndex) {
  const chunks = rawText
    .split(/(?=\b(статья|глава|раздел)\b[\s\d.:–—-]*)/gi)
    .map(s => s.trim())
    .filter(Boolean);

  const out = [];
  if (chunks.length <= 1) {
    out.push({ id: docIndex + 1, title: "Документ (целиком)", url, text: rawText });
  } else {
    let local = 1;
    for (const chunk of chunks) {
      const title = chunk.slice(0, 140);
      out.push({
        id: Number(`${docIndex + 1}${String(local).padStart(3, "0")}`),
        title,
        url,
        text: chunk
      });
      local++;
    }
  }
  return out;
}

// ===== загрузка всех источников =====
let SECTIONS = [];
let META = { loaded: 0 };

async function loadOne(url, idx) {
  const r = await fetchWithTimeout(url);
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  const html = await r.text();
  const text = extractTextHTML(html);
  return splitIntoSections(text, url, idx);
}

async function loadAll() {
  SECTIONS = [];
  let i = 0;
  for (const u of ALLOWED) {
    try {
      const parts = await loadOne(u, i++);
      SECTIONS.push(...parts);
    } catch (e) {
      console.error("Load failed:", u, e.message);
    }
  }
  META.loaded = SECTIONS.length;
  console.log(`Loaded sections: ${META.loaded}`);
}

await loadAll();

// ===== endpoints =====
app.get("/health", (req, res) => {
  res.json({ status: "ok", sources: ALLOWED.length, sections: META.loaded });
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

app.post("/search", (req, res) => {
  const q = String(req.body?.query || "").trim();
  const limit = Math.max(1, Math.min(50, Number(req.body?.limit ?? 10)));
  if (!q) return res.status(400).json({ error: "bad_request", detail: "field 'query' is required" });

  const variants = expandSynonyms(q);
  const allHits = [];

  for (const v of variants) {
    const phrase = normalize(v);
    const terms = tokenize(v);
    for (const s of SECTIONS) {
      const { score, posStart, posEnd } = bestScore(s.text, phrase, terms);
      if (score > 0) {
        allHits.push({
          id: s.id,
          title: s.title,
          url: s.url,
          score,
          excerpt: makeSnippet(s.text, posStart, posEnd)
        });
      }
    }
  }

  // fallback по числам (например, «статья 53»)
  if (allHits.length === 0) {
    const nums = (q.match(/\d+/g) || []).slice(0, 2);
    for (const s of SECTIONS) {
      for (const n of nums) {
        const idx = normalize(s.text).indexOf(n);
        if (idx >= 0) {
          allHits.push({
            id: s.id, title: s.title, url: s.url, score: 5,
            excerpt: makeSnippet(s.text, idx, idx + String(n).length)
          });
          break;
        }
      }
    }
  }

  // dedup по id с максимальным score
  const dedup = new Map();
  for (const h of allHits) {
    const prev = dedup.get(h.id);
    if (!prev || h.score > prev.score) dedup.set(h.id, h);
  }
  const out = Array.from(dedup.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  res.json({ result: out });
});

app.post("/reload", async (req, res) => {
  try {
    await loadAll();
    res.json({ reloaded: true, sections: META.loaded });
  } catch (e) {
    res.status(500).json({ error: "reload_failed", detail: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TaxCode API (HTML) on ${PORT}, sections: ${META.loaded}`));
