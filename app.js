// ==== нормализация ====
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

// ==== простая "стемминговая" регэксп-форма: корень слова -> совпадение любых окончаний ====
// Берём первые 5–6 букв (для длинных слов) и ищем \bstem\w*
function stemRegex(word) {
  const w = word.normalize('NFC');
  if (/^\d+$/.test(w)) return new RegExp(`\\b${w}\\b`, "i"); // числа — точные
  const base = w.length >= 6 ? w.slice(0, 5) : w.length >= 4 ? w.slice(0, 4) : w;
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${esc}\\w*`, "i");
}

// ==== синонимы/перефразы для частых запросов ====
function expandSynonyms(q) {
  const nq = normalize(q);
  const variants = [nq];

  // примеры; расширяй по мере надобности
  if (/\bтранспорт\w*\b/.test(nq) && /\bналог\w*\b/.test(nq)) {
    variants.push("налог на транспортные средства");
    variants.push("налог на автомобили");
    variants.push("налогообложение транспортных средств");
  }
  if (/\bиндивидуаль\w*\b/.test(nq) && /\bпредпринимател\w*\b/.test(nq)) {
    variants.push("ИП");
    variants.push("индивидуальные предприниматели налогообложение");
  }
  if (/\bНДС\b/i.test(q) || /\bндс\b/.test(nq)) {
    variants.push("налог на добавленную стоимость");
  }

  // уберём дубликаты
  return Array.from(new Set(variants));
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

app.post("/search", (req, res) => {
  const q = String(req.body?.query || "").trim();
  const limit = Math.max(1, Math.min(50, Number(req.body?.limit ?? 10)));
  if (!q) return res.status(400).json({ error: "bad_request", detail: "field 'query' is required" });

  const variants = expandSynonyms(q);     // перефразированные запросы
  const allHits = [];

  for (const v of variants) {
    const phrase = normalize(v);
    const terms = tokenize(v);
    const hits = [];

    for (const s of SECTIONS) {
      const { score, posStart, posEnd } = bestScore(s.text, phrase, terms);
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
    hits.sort((a, b) => b.score - a.score);
    for (const h of hits) allHits.push(h);
  }

  // fallback по числам
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

  // уберём повторы по id, оставим самый высокий score
  const dedup = new Map();
  for (const h of allHits) {
    const prev = dedup.get(h.id);
    if (!prev || h.score > prev.score) dedup.set(h.id, h);
  }
  const out = Array.from(dedup.values()).sort((a, b) => b.score - a.score).slice(0, limit);
  res.json({ result: out });
});

