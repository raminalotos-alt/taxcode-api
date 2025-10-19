// app.js — TaxCode API (robust HTML parsing, no Playwright)
import express from "express";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const app = express();
app.use(express.json());

// ===== Config
const PORT = process.env.PORT || 3000;
const SOURCE_URL = "https://adilet.zan.kz/rus/docs/K2500000214?lang=rus";

let SECTIONS = [];
let LOADED = false;

// ===== Helpers
function normalize(s) {
  return String(s || "").replace(/\r/g, "").replace(/\u00A0/g, " ").replace(/[ \t]+/g, " ").trim();
}

// выбираем текст из популярных контейнеров + fallback = весь body
function extractText(html) {
  const $ = cheerio.load(html, { decodeEntities: false });
  $("script,style,noscript,header,nav,footer").remove();

  const candidates = [
    "main",
    "#content, .content",
    ".document, .doc, .law, .paper, .article, .text",
    ".container, #main",
    "body"
  ];

  for (const sel of candidates) {
    const $root = $(sel).first();
    if (!$root.length) continue;

    // берём валидные блочные элементы
    const blocks = [];
    $root.find("h1,h2,h3,h4,p,div,section,article,li,td,pre").each((_, el) => {
      const t = normalize($(el).text());
      if (t) blocks.push(t);
    });
    const joined = normalize(blocks.join("\n"));
    if (joined.length > 2000) return joined; // считаем, что это «основной» текст
  }

  // если ничего не подошло — весь body
  return normalize($("body").text());
}

// режем на статьи/главы/разделы
function splitIntoSections(bigText) {
  // вставляем маркер перед каждым заголовком, чтобы не потерять его
  const marked = bigText.replace(
    /(^|\n)\s*((?:СТАТЬЯ|Статья|ГЛАВА|Глава|РАЗДЕЛ|Раздел)\s*\d+[.\-–—:]?)/g,
    "\n@@@CUT@@@ $2"
  );

  const parts = marked.split("@@CUT@@@").map(s => normalize(s)).filter(Boolean);

  const out = [];
  let idx = 1;
  for (const chunk of parts) {
    // первая строка — заголовок, дальше — тело
    const lines = chunk.split("\n").filter(Boolean);
    const title = lines[0] || `Фрагмент ${idx}`;
    const text = lines.slice(1).join("\n").trim();
    // если текст пуст, всё равно добавим — многие статьи «короткие»
    out.push({ id: idx, title, text: text || title, url: SOURCE_URL });
    idx++;
  }
  return out;
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Accept-Language": "ru-RU,ru;q=0.9"
    },
    redirect: "follow"
  });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return await res.text();
}

async function loadSource(url = SOURCE_URL) {
  console.log("⏳ Загружаю источник:", url);
  const html = await fetchHtml(url);
  const text = extractText(html);

  if (!text || text.length < 2000) {
    console.warn("⚠️ Извлечён слишком короткий текст:", text.length);
  }

  const sections = splitIntoSections(text);

  // фильтр: оставим только то, где в заголовке явно есть «Статья/Глава/Раздел» (если есть что оставить),
  // иначе — берём всё как есть
  const strong = sections.filter(s => /^(СТАТЬЯ|Статья|ГЛАВА|Глава|РАЗДЕЛ|Раздел)\b/.test(s.title));
  const final = strong.length ? strong : sections;

  console.log(`✅ Сформировано разделов: ${final.length}`);
  return final;
}

async function loadAll() {
  try {
    SECTIONS = await loadSource(SOURCE_URL);
    LOADED = SECTIONS.length > 0;
  } catch (e) {
    console.error("❌ Ошибка загрузки:", e.message);
    SECTIONS = [];
    LOADED = false;
  }
}

// ===== API
app.get("/health", (req, res) => {
  res.json({ status: LOADED ? "ok" : "loading", sections: SECTIONS.length, sources: 1 });
});

app.get("/debug/titles", (req, res) => {
  res.json({
    count: SECTIONS.length,
    titles: SECTIONS.slice(0, 200).map(s => ({ id: s.id, title: s.title }))
  });
});

// посмотреть сырец первого фрагмента
app.get("/debug/peek", (req, res) => {
  if (!SECTIONS.length) return res.json({ sections: 0, sample: "" });
  const s = SECTIONS[0];
  res.json({ sections: SECTIONS.length, firstId: s.id, title: s.title, sample: s.text.slice(0, 1500) });
});

// ручной перезахват основного источника
app.get("/reload", async (req, res) => {
  await loadAll();
  res.json({ reloaded: true, sections: SECTIONS.length });
});

// протестировать другой URL adilet без деплоя
app.get("/ingest", async (req, res) => {
  const url = String(req.query.url || "").trim();
  if (!url) return res.status(400).json({ error: "Укажи ?url=" });
  try {
    const tmp = await loadSource(url);
    res.json({ url, sections: tmp.length, sample: tmp[0]?.title || "" });
  } catch (e) {
    res.status(500).json({ error: "ingest_failed", detail: String(e) });
  }
});

app.post("/search", (req, res) => {
  const q = (req.body?.query || "").toLowerCase().trim();
  const limit = Math.max(1, Math.min(20, Number(req.body?.limit || 5)));
  if (!q) return res.status(400).json({ error: "field 'query' is required" });

  // приоритетная ветка: «статья 54»
  const m = q.match(/стать[ьяи]\s*№?\s*(\d{1,4})/i);
  const hits = [];
  if (m) {
    const num = m[1];
    const re = new RegExp(`^(?:СТАТЬЯ|Статья)\\s*${num}\\b`);
    for (const s of SECTIONS) {
      if (re.test(s.title)) hits.push({ ...s, score: 1000 });
    }
  }

  // мягкий поиск — по вхождению слов из запроса
  const words = q.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  for (const s of SECTIONS) {
    const t = (s.title + " " + s.text).toLowerCase();
    let score = 0;
    for (const w of words) if (t.includes(w)) score += Math.min(20, 3 + w.length);
    if (score > 0) hits.push({ ...s, score });
  }

  // dedup и сортировка
  const best = Array.from(
    hits.reduce((map, h) => map.set(h.id, map.has(h.id) && map.get(h.id).score > h.score ? map.get(h.id) : h), new Map())
      .values()
  ).sort((a, b) => b.score - a.score).slice(0, limit)
   .map(h => ({ id: h.id, title: h.title, url: SOURCE_URL, text: h.text.slice(0, 600) + "…" }));

  res.json({ results: best });
});

app.get("/section", (req, res) => {
  const id = Number(req.query.id);
  const s = SECTIONS.find(x => x.id === id);
  if (!s) return res.status(404).json({ error: "not_found" });
  res.json({ id: s.id, title: s.title, url: SOURCE_URL, text: s.text });
});

app.get("/", (req, res) => {
  res.type("html").send(`
    <h2>TaxCode API</h2>
    <p>Источник: <a href="${SOURCE_URL}" target="_blank">${SOURCE_URL}</a></p>
    <ul>
      <li>GET /health</li>
      <li>GET /debug/titles</li>
      <li>GET /debug/peek</li>
      <li>GET /reload</li>
      <li>GET /ingest?url=... (проверка другого URL)</li>
      <li>POST /search { query, limit }</li>
      <li>GET /section?id=..</li>
    </ul>
  `);
});

// ===== Start
app.listen(PORT, async () => {
  console.log(`🚀 TaxCode API on ${PORT}`);
  await loadAll();
});

