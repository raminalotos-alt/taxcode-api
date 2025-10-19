// app.js
import express from "express";
import fetch from "node-fetch";
import cheerio from "cheerio";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// === Конфигурация ===
const PORT = process.env.PORT || 3000;
const SOURCE_URL = "https://adilet.zan.kz/rus/docs/K2500000214?lang=rus";

let sections = [];
let loaded = false;

// === Функция загрузки Налогового кодекса ===
async function loadTaxCode() {
  console.log("⏳ Загрузка Налогового кодекса РК 2025 с Adilet...");
  try {
    const res = await fetch(SOURCE_URL);
    const html = await res.text();
    const $ = cheerio.load(html);

    sections = [];
    let current = null;

    $("p").each((i, el) => {
      const text = $(el).text().trim();

      if (text.startsWith("Статья")) {
        // новая статья
        if (current) sections.push(current);
        current = {
          id: sections.length + 1,
          title: text,
          text: ""
        };
      } else if (current) {
        current.text += " " + text;
      }
    });

    if (current) sections.push(current);
    loaded = true;

    console.log(`✅ Загружено ${sections.length} статей из Налогового кодекса.`);
  } catch (err) {
    console.error("Ошибка при загрузке кодекса:", err);
  }
}

// === Эндпоинты API ===

// Проверка состояния
app.get("/health", (req, res) => {
  res.json({
    status: loaded ? "ok" : "loading",
    sections: sections.length,
    sources: 1
  });
});

// Список всех статей (только заголовки)
app.get("/debug/titles", (req, res) => {
  res.json({
    count: sections.length,
    titles: sections.map(s => ({
      id: s.id,
      title: s.title
    }))
  });
});

// Поиск по статьям
app.post("/search", (req, res) => {
  const q = (req.body.query || "").toLowerCase();
  const limit = req.body.limit || 5;

  if (!q) {
    return res.status(400).json({ error: "Не указан параметр 'query'." });
  }

  const results = sections.filter(
    s => s.title.toLowerCase().includes(q) || s.text.toLowerCase().includes(q)
  );

  res.json({
    results: results.slice(0, limit).map(s => ({
      id: s.id,
      title: s.title,
      text: s.text.slice(0, 500) + "...",
      url: `${SOURCE_URL}#${s.id}`
    }))
  });
});

// Получить конкретную статью по ID
app.get("/section", (req, res) => {
  const id = parseInt(req.query.id);
  if (!id) return res.status(400).json({ error: "Укажите ?id=" });

  const section = sections.find(s => s.id === id);
  if (!section) return res.status(404).json({ error: "Статья не найдена." });

  res.json(section);
});

// Ручная перезагрузка (при обновлении источника)
app.get("/reload", async (req, res) => {
  await loadTaxCode();
  res.json({ reloaded: true, sections: sections.length });
});

// Главная страница
app.get("/", (req, res) => {
  res.send(`
    <h2>TaxCode API 2025</h2>
    <p>Источник: <a href="${SOURCE_URL}" target="_blank">${SOURCE_URL}</a></p>
    <ul>
      <li>GET /health — состояние API</li>
      <li>POST /search — поиск по статьям</li>
      <li>GET /section?id=xx — текст статьи</li>
      <li>GET /debug/titles — список всех статей</li>
      <li>GET /reload — перезагрузить базу вручную</li>
    </ul>
  `);
});

// === Запуск ===
app.listen(PORT, async () => {
  console.log(`🚀 TaxCode API доступен на порту ${PORT}`);
  await loadTaxCode();
});
