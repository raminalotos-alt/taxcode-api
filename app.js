// app.js — TaxCode API (Playwright edition: deep text + shadow DOM + iframes)

import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { chromium } from "playwright";

// ====== setup ======
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// CORS for OpenAI Actions
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, OpenAI-Beta");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

// Sources
const cfgPath = path.join(__dirname, "sources.json");
const CFG = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const ALLOWED = CFG.sources || [];
if (!ALLOWED.length) console.warn("⚠️ sources.json пуст — добавь ссылку(и) на Adilet.");

// ====== small utils ======
const normalize = s =>
  String(s || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();

const tokenize = s =>
  normalize(s).replace(/[^\p{L}\p{N}\s]/gu, " ").split(" ").filter(Boolean);

function stemRegex(word) {
  const w = word.normalize("NFC");
  if (/^\d+$/.test(w)) return new RegExp(`\\b${w}\\b`, "i");
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

// ====== Playwright deep extraction ======
async function loadDynamicPageWithPlaywright(url) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--lang=ru-RU,ru", "--disable-dev-shm-usage"]
  });

  const context = await browser.newContext({
    locale: "ru-RU",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36"
  });

  const page = await context.newPage();
  await page.goto(url, { waitUntil: "networkidle", timeout: 120000 });

  // ждём, пока в тексте появится «Статья»
  await page.waitForFunction(
    () => /статья/i.test(document?.body?.innerText || ""),
    { timeout: 60000 }
  ).catch(() => { /* ок, продолжим с тем, что есть */ });

  // функция: собрать текст из DOM + shadowRoot
  const getDeepText = async (frameLike) => {
    return frameLike.evaluate(() => {
      const seen = new WeakSet();
      const parts = [];

      const collect = (root) => {
        if (!root || seen.has(root)) return;
        seen.add(root);

        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        const blocks = [];
        while (walker.nextNode()) {
          const el = walker.currentNode;
          const tag = (el.tagName || "").toLowerCase();
          if (["h1","h2","h3","h4","p","li","td","pre","section","article","div","main"].includes(tag)) {
            const t = (el.innerText || "").replace(/\s+/g, " ").trim();
            if (t) blocks.push(t);
          }
          if (el.shadowRoot) collect(el.shadowRoot);
        }
        parts.push(blocks.join("\n"));
      };

      collect(document.documentElement);
      return parts.filter(Boolean).join("\n").trim();
    });
  };

  let text = await getDeepText(page);

  // если мало — обойдём все фреймы
  if (!text || text.length < 4000) {
    for (const f of page.frames()) {
      try {
        const t = await getDeepText(f);
        if (t && t.length > (text?.length || 0)) text = t;
      } catch {
        /* кросс-доменный — пропускаем */
      }
    }
  }

  await browser.close();

  // упакуем текст как «html»
  if (text && text.length > 0) {
    const safe = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br/>");
    return `<html><body><main>${safe}</main></body></html>`;
  }

  // fallback — вернём пустое
  return "<html><body></body></html>";
}

// ====== extract text / split ======
function extractTextHTML(html) {
  const $ = cheerio.load(html, { decodeEntities: false });
  $("script, style, noscript, header, nav, footer").remove();

  function blocksToText(root) {
    const parts = [];
    $(root).find("h1,h2,h3,h4,p,li,td,pre,section,article,div,main").each((_, el) => {
      const t = $(el).text().replace(/\s+/g, " ").trim();
      if (t) parts.push(t);
    });
    return parts.join("\n");
  }

  const candidates = [
    "main", ".document", ".law", ".content", ".article", ".text",
    "#content", ".container", "#main", ".doc", ".paper", "body"
  ];

  for (const sel of candidates) {
    if ($(sel).length) {
      const cleaned = blocksToText(sel).trim();
      if (cleaned.length > 1000) return cleaned;
    }
  }
  return $("body").text().replace(/\s+/g, " ").trim();
}

function splitIntoSections(rawText, url, docIndex) {
  const headerRe = /(?=^\s*(?:СТАТЬЯ|Статья|ГЛАВА|Глава|РАЗДЕЛ|Раздел)[\s\u00A0]*\d+(?:[.\:\-–—])?\s)/m;
  const chunks = rawText.split(headerRe).map(s => s.trim()).filter(Boolean);

  const out = [];
  if (chunks.length <= 1) {
    out.push({ id: docIndex + 1, title: "Документ (целиком)", url, text: rawText });
  } else {
    let local = 1;
    for (const chunk of chunks) {
      const firstLine = (chunk.split(/\n/, 1)[0] || "").slice(0, 200);
      const title = firstLine || chunk.slice(0, 200);
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

// ====== loader ======
let SECTIONS = [];
let META = { loaded: 0 };

async function loadOne(url, idx) {
  let html;
  if (/adilet\.zan\.kz/i.test(url)) {
    html = await loadDynamicPageWithPlaywright(url);
  } else {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36",
        "Accept-Language": "ru-RU,ru;q=0.9"
      }
    });
    if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
    html = await r.text();
  }
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

// ====== endpoints ======
app.get("/health", (req, res) => {
  res.json({ status: "ok", sources: ALLOWED.length, sections: META.loaded });
});

app.get("/sources", (req, res) => res.json({ sources: ALLOWED }));

app.get("/debug/titles", (req, res) => {
  const list = SECTIONS.slice(0, 150).map(x => ({ id: x.id, title: x.title }));
  res.json({ count: SECTIONS.length, titles: list });
});

app.get("/debug/peek", (req, res) => {
  if (!SECTIONS.length) return res.json({ sections: 0, sample: "" });
  const s = SECTIONS[0];
  res.json({ sections: SECTIONS.length, firstId: s.id, title: s.title, sample: s.text.slice(0, 1000) });
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

  // приоритет: «статья N»
  const numMatch = q.match(/стать[ьяи]\s*№?\s*(\d{1,4})/iu);
  if (numMatch) {
    const num = numMatch[1];
    const artRe = new RegExp(`^\\s*(?:СТАТЬЯ|Статья)[\\s\\u00A0]*${num}(?:[.\\:\\-–—])?\\s`, "m");
    for (const s of SECTIONS) {
      const m = s.text.match(artRe);
      if (m) {
        const pos = m.index ?? 0;
        allHits.push({
          id: s.id,
          title: s.title,
          url: s.url,
          score: 999,
          excerpt: makeSnippet(s.text, pos, pos + String(num).length + 20)
        });
      }
    }
  }

  // мягкий поиск
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

  // fallback: цифры
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

  // dedup по id
  const dedup = new Map();
  for (const h of allHits) {
    const prev = dedup.get(h.id);
    if (!prev || h.score > prev.score) dedup.set(h.id, h);
  }
  const out = Array.from(dedup.values()).sort((a, b) => b.score - a.score).slice(0, limit);
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
app.listen(PORT, () => console.log(`TaxCode API (Playwright) on ${PORT}, sections: ${META.loaded}`));


