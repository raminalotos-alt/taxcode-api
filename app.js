// app.js — TaxCode API (локальный текст из data/*.txt, без парсинга и браузеров)
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// ---- Конфиг
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");

// ---- Память
let SECTIONS = [];
let LOADED = false;

// ---- Утилиты
const norm = s => String(s || "").replace(/\r/g, "").replace(/\u00A0/g, " ").trim();

function loadAllTxt() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const files = fs.readdirSync(DATA_DIR).filter(f => f.toLowerCase().endsWith(".txt")).sort();
  let big = "";
  for (const f of files) {
    const p = path.join(DATA_DIR, f);
    const t = fs.readFileSync(p, "utf8");
    big += (big ? "\n\n" : "") + t;
  }
  return norm(big);
}

function splitIntoSections(bigText) {
  if (!bigText) return [];
  // 1) Убедимся, что заголовки начинаются с новой строки
  let text = bigText
    .replace(/\t/g, " ")
    .replace(/[ \u00A0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n");

  // 2) Вставим маркер перед заголовками «Статья/Глава/Раздел N»
  text = text.replace(
    /(^|\n)\s*((?:СТАТЬЯ|Статья|ГЛАВА|Глава|РАЗДЕЛ|Раздел)\s*\d+(?:[.\-–—:]?)\s*)/g,
    "\n@@CUT@@ $2"
  );

  const rawParts = text.split("@@CUT@@").map(s => s.trim()).filter(Boolean);

  // Если в тексте не было явных заголовков — вернём один фрагмент целиком
  if (rawParts.length === 0) {
    return [{ id: 1, title: "Документ (целиком)", text }];
  }

  const out = [];
  let id = 1;
  for (const chunk of rawParts) {
    const lines = chunk.split("\n").map(l => l.trim()).filter(Boolean);
    const title = lines[0] || `Фрагмент ${id}`;
    const body = lines.slice(1).join("\n").trim();
    out.push({ id, title, text: body || title });
    id++;
  }
  return out;
}

function searchSections(query, limit = 5) {
  const q = String(query || "").toLowerCase().trim();
  if (!q) return [];

  // приоритет: "статья 54"
  const m = q.match(/стать[ьяи]\s*№?\s*(\d{1,4})/i);
  const hits = [];

  if (m) {
    const num = m[1];
    const re = new RegExp(`^(?:СТАТЬЯ|Статья)\\s*${num}\\b`);
    for (const s of SECTIONS) {
      if (re.test(s.title)) hits.push({ ...s, score: 1000 });
    }
  }

  // мягкий поиск по словам
  const words = q.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  for (const s of SECTIONS) {
    const hay = (s.title + " " + s.text).toLowerCase();
    let score = 0;
    for (const w of words) if (hay.includes(w)) score += Math.min(20, 3 + w.length);
    if (score > 0) hits.push({ ...s, score });
  }

  // dedup и топ-N
  const dedup = new Map();
  for (const h of hits) {
    const prev = dedup.get(h.id);
    if (!prev || h.score > prev.score) dedup.set(h.id, h);
  }
  return Array.from(dedup.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(h => ({ id: h.id, title: h.title, text: h.text.slice(0, 800) + "…" }));
}

// ---- Загрузка
async function loadIndex() {
  try {
    const big = loadAllTxt();
    SECTIONS = splitIntoSections(big);
    LOADED = SECTIONS.length > 0;
    console.log(`✅ Загружено фрагментов: ${SECTIONS.length}`);
  } catch (e) {
    LOADED = false;
    SECTIONS = [];
    console.error("❌ Ошибка загрузки текста:", e.message);
  }
}

// ---- API
app.get("/health", (req, res) => {
  res.json({ status: LOADED ? "ok" : "loading", sections: SECTIONS.length, sources: "local_txt" });
});

app.get("/debug/titles", (req, res) => {
  res.json({ count: SECTIONS.length, titles: SECTIONS.slice(0, 200).map(s => ({ id: s.id, title: s.title })) });
});

app.get("/section", (req, res) => {
  const id = Number(req.query.id);
  const s = SECTIONS.find(x => x.id === id);
  if (!s) return res.status(404).json({ error: "not_found" });
  res.json(s);
});

app.post("/search", (req, res) => {
  const { query, limit } = req.body || {};
  if (!query) return res.status(400).json({ error: "field 'query' is required" });
  const results = searchSections(query, Number(limit) || 5);
  res.json({ results });
});

app.get("/reload", async (req, res) => {
  await loadIndex();
  res.json({ reloaded: true, sections: SECTIONS.length });
});

app.get("/", (req, res) => {
  res.type("html").send(`
    <h2>TaxCode API (local text)</h2>
    <ul>
      <li>GET /health</li>
      <li>GET /debug/titles</li>
      <li>POST /search { "query": "статья 54", "limit": 5 }</li>
      <li>GET /section?id=123</li>
      <li>GET /reload</li>
    </ul>
  `);
});

// ---- Start
app.listen(PORT, async () => {
  console.log(`🚀 TaxCode API (local) on ${PORT}`);
  await loadIndex();
});

