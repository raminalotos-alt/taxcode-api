import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import puppeteer from "puppeteer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// --------- CORS (для OpenAI Actions) ---------
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, OpenAI-Beta");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

// --------- источники ---------
const cfgPath = path.join(__dirname, "sources.json");
const CFG = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const ALLOWED = CFG.sources || [];
if (!ALLOWED.length) console.warn("⚠️ sources.json пуст — добавь HTML-ссылки на кодекс");

// --------- нормализация / токены / «стем» ---------
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

// --------- рендер динамической страницы как браузер ---------
async function loadDynamicPage(url) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--lang=ru-RU,ru",
      "--disable-dev-shm-usage"
    ]
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({ "Accept-Language": "ru-RU,ru;q=0.9" });

  // грузим страницу и ждём сети
  await page.goto(url, { waitUntil: "networkidle2", timeout: 120000 });

  // 1) пробуем дождаться явных контейнеров на ТЕКУЩЕЙ странице
  const selectors = [
    "main", ".document", ".law", ".content", ".text", "#content", ".doc", ".paper"
  ];

  let html = null;

  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { timeout: 8000 });
      // есть контейнер на самой странице — берём контент
      html = await page.content();
      break;
    } catch { /* игнор, пойдём дальше */ }
  }

  // 2) если пусто — значит внутри iframe. Считаем текст из всех фреймов
  if (!html) {
    const frames = page.frames();
    for (const f of frames) {
      try {
        const got = await f.evaluate(() => {
          const root =
            document.querySelector("main,.document,.law,.content,.text,#content,.doc,.paper") ||
            document.body;
          return root ? root.innerText : "";
        });
        if (got && got.length > 2000) {
          html = `<html><body><main>${got.replace(/&/g,"&amp;")
                                          .replace(/</g,"&lt;")
                                          .replace(/>/g,"&gt;")
                                          .replace(/\n/g,"<br/>")}</main></body></html>`;
          break;
        }
      } catch { /* фрейм мог быть кросс-доменным — пропускаем */ }
    }
  }

  // 3) последний шанс — content() как есть
  if (!html) html = await page.content();

  await browser.close();
  return html;
}

// --------- извлечение текста из HTML (сохраняем переносы строк!) ---------
function extractTextHTML(html) {
  const $ = cheerio.load(html, { decodeEntities: false });

  $("script, style, noscript, header, nav, footer").remove();

  const candidates = [
    ".document", ".law", ".content", ".article", ".text",
    "#content", ".container", "main", "#main", ".doc"
  ];

  function blocksToText(root) {
    const parts = [];
    $(root).find("h1,h2,h3,h4,p,li,td,pre,section,article,div").each((_, el) => {
      const t = $(el).text().replace(/\s+/g, " ").trim();
      if (t) parts.push(t);
    });
    return parts.join("\n");
  }

  for (const sel of candidates) {
    if ($(sel).length) {
      const cleaned = blocksToText(sel).trim();
      if (cleaned.length > 2000) return cleaned;
    }
  }

  const all = blocksToText("body").trim();
  return all;
}

// --------- разбиение на фрагменты (Статья/Глава/Раздел) ---------
function splitIntoSections(rawText, url, docIndex) {
  // критичный момент: разбиваем по заголовкам в НАЧАЛЕ СТРОК (многострочный режим)
  const headerRe = /(?=^\s*(?:СТАТЬЯ|Статья|ГЛАВА|Глава|РАЗДЕЛ|Раздел)[\s\u00A0]*\d+(?:[.\:\-–—])?\s)/m;
  const chunks = rawText
    .split(headerRe)
    .map(s => s.trim())
    .filter(Boolean);

  const out = [];
  if (chunks.length <= 1) {
    out.push({ id: docIndex + 1, title: "Документ (целиком)", url, text: rawText });
  } else {
    let local = 1;
    for (const chunk of chunks) {
      const firstLine = (chunk.split(/\n/, 1)[0] || "").slice(0, 180);
      const title = firstLine || chunk.slice(0, 180);
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

// --------- загрузка всех источников ---------
let SECTIONS = [];
let META = { loaded: 0 };

async function loadOne(url, idx) {
  let html;
  try {
    if (/adilet\.zan\.kz/i.test(url)) {
      html = await loadDynamicPage(url);           // динамический сайт
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
  } catch (e) {
    console.error("loadOne: navigation failed:", url, e.message);
    throw e;
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

// --------- endpoints ---------
app.get("/health", (req, res) => {
  res.json({ status: "ok", sources: ALLOWED.length, sections: META.loaded });
});

app.get("/sources", (req, res) => {
  res.json({ sources: ALLOWED });
});

// вернёт первую 1000 символов сырого текста первой секции (если есть)
app.get("/debug/peek", (req, res) => {
  if (!SECTIONS.length) return res.json({ sections: 0, sample: "" });
  const s = SECTIONS[0];
  res.json({ sections: SECTIONS.length, firstId: s.id, title: s.title, sample: s.text.slice(0, 1000) });
});

// список первых 150 заголовков
app.get("/debug/titles", (req, res) => {
  const list = SECTIONS.slice(0, 150).map(x => ({ id: x.id, title: x.title }));
  res.json({ count: SECTIONS.length, titles: list });
});

// отладочный список заголовков (первые 120)
app.get("/debug/titles", (req, res) => {
  const sample = SECTIONS.slice(0, 120).map(s => ({ id: s.id, title: s.title }));
  res.json({ count: SECTIONS.length, titles: sample });
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

  // приоритетный матч "статья N" (учитываем формы и NBSP)
  const numMatch = q.match(/стать[ьяи]\s*№?\s*(\d{1,4})/iu);
  if (numMatch) {
    const num = numMatch[1];
    const artRe = new RegExp(
      `^\\s*(?:СТАТЬЯ|Статья)[\\s\\u00A0]*${num}(?:[\\.:\\-–—])?\\s`,
      "m"
    );
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

  // обычный «мягкий» поиск (фразы + стем-слова)
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

  // fallback по числам (если вообще пусто)
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

  // dedup по id: оставляем запись с максимальным score
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
app.listen(PORT, () => console.log(`TaxCode API (Puppeteer) on ${PORT}, sections: ${META.loaded}`));
