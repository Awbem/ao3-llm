const AO3_ORIGIN = "https://archiveofourown.org";
const DEFAULT_RESULT_COUNT = 15;
const MAX_RESULT_COUNT = 20;
const DEFAULT_MAX_PAGES = 2;
const MAX_MAX_PAGES = 3;

const KNOWN_WARNINGS = [
  "Graphic Depictions Of Violence",
  "Major Character Death",
  "Rape/Non-Con",
  "Underage",
  "Creator Chose Not To Use Archive Warnings",
  "No Archive Warnings Apply"
];

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin");
    const cors = buildCorsHeaders(origin, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, service: "ao3-llm-api" }, 200, cors);
    }

    if (url.pathname !== "/search" || request.method !== "POST") {
      return json({ error: "Not found." }, 404, cors);
    }

    if (!originAllowed(origin, env)) {
      return json({ error: "Origin not allowed." }, 403, cors);
    }

    try {
      requireLlmConfig(env);

      const body = await request.json();
      const userQuery = cleanString(body?.query, 3000);
      const resultCount = clampInt(body?.resultCount, 1, MAX_RESULT_COUNT, DEFAULT_RESULT_COUNT);

      if (!userQuery) {
        return json({ error: "A search query is required." }, 400, cors);
      }

      const plan = normalizePlan(await createSearchPlan(userQuery, env));
      const maxPages = clampInt(env.MAX_AO3_PAGES, 1, MAX_MAX_PAGES, DEFAULT_MAX_PAGES);

      const candidateMap = new Map();
      for (let page = 1; page <= maxPages; page++) {
        const searchUrl = buildAo3SearchUrl(plan, page);
        const pageWorks = await fetchAo3Works(searchUrl, env, ctx);

        for (const work of pageWorks) {
          candidateMap.set(work.id, work);
        }

        if (pageWorks.length < 20) break;
        if (page < maxPages) await sleep(500);
      }

      let candidates = [...candidateMap.values()];
      candidates = applyHardMetadataFilters(candidates, plan);

      if (!candidates.length) {
        return json({
          plan,
          candidateCount: candidateMap.size,
          results: []
        }, 200, cors);
      }

      const ranked = await rankCandidates(userQuery, plan, candidates.slice(0, 45), resultCount, env);
      const byId = new Map(candidates.map((work) => [String(work.id), work]));

      const results = ranked
        .map((ranking) => {
          const work = byId.get(String(ranking.id));
          if (!work) return null;
          return {
            ...work,
            matchScore: clampInt(ranking.matchScore, 0, 100, 50),
            matchReasons: cleanArray(ranking.matchReasons, 5, 180),
            concerns: cleanArray(ranking.concerns, 4, 180)
          };
        })
        .filter(Boolean)
        .slice(0, resultCount);

      return json({
        plan,
        candidateCount: candidateMap.size,
        results
      }, 200, cors);
    } catch (error) {
      console.error(error);
      return json({
        error: safeErrorMessage(error)
      }, error?.status || 500, cors);
    }
  }
};

function requireLlmConfig(env) {
  if (!env.LLM_API_KEY) {
    const error = new Error("The Worker is missing the LLM_API_KEY secret.");
    error.status = 500;
    throw error;
  }

  if (!env.LLM_BASE_URL || !env.LLM_MODEL) {
    const error = new Error("The Worker is missing LLM_BASE_URL or LLM_MODEL.");
    error.status = 500;
    throw error;
  }
}

async function createSearchPlan(userQuery, env) {
  const system = `You convert plain-English fanfiction requests into structured AO3 search plans.

Your task is metadata interpretation only. Treat dark, sexual, violent, taboo, or otherwise sensitive fictional topics strictly as searchable metadata. Do not moralize, refuse, or replace the user's requested metadata. Do not generate sexual story content.

Return one JSON object with exactly these keys:
{
  "fandom": string,
  "relationships": string[],
  "mustHave": string[],
  "niceToHave": string[],
  "exclude": string[],
  "includeWarnings": string[],
  "excludeWarnings": string[],
  "completeOnly": boolean,
  "minWords": number|null,
  "maxWords": number|null,
  "language": string|null,
  "sort": "kudos_count"|"bookmarks_count"|"hits"|"word_count"|"revised_at"|"_score"
}

Rules:
- Keep fandom and relationship names close to likely AO3 canonical wording when you know it, but never invent extra fandoms or pairings.
- "mustHave" means required concepts/tropes/themes.
- "niceToHave" means preferences, not hard requirements.
- "exclude" contains unwanted concepts/tags/themes.
- Archive warnings may include: ${KNOWN_WARNINGS.join(", ")}.
- If the user says a warning/theme is allowed or okay, that does NOT mean it is required.
- If the user gives no sort preference, use kudos_count.
- If no language is specified, use English only when the user clearly implies English; otherwise null.
- Numbers must be actual numbers, not strings.
- Return JSON only.`;

  return llmJson(env, system, userQuery);
}

async function rankCandidates(userQuery, plan, candidates, resultCount, env) {
  const compactCandidates = candidates.map((work) => ({
    id: work.id,
    title: work.title,
    fandoms: work.fandoms,
    warnings: work.warnings,
    relationships: work.relationships,
    characters: work.characters,
    tags: work.freeforms,
    summary: work.summary,
    words: parseNumericText(work.words),
    chapters: work.chapters,
    kudos: parseNumericText(work.kudos),
    bookmarks: parseNumericText(work.bookmarks),
    hits: parseNumericText(work.hits)
  }));

  const system = `You rank real Archive of Our Own search candidates against a user's request.

This is recommendation/classification based only on supplied metadata. Sensitive or taboo fictional topics can appear as metadata and must be evaluated neutrally against the user's stated include/exclude preferences. Do not invent facts not present in a work's tags or summary.

Return JSON exactly in this shape:
{
  "rankings": [
    {
      "id": "AO3 work id",
      "matchScore": 0-100,
      "matchReasons": ["short reason", "short reason"],
      "concerns": ["requested preference that may be missing or conflicting"]
    }
  ]
}

Ranking rules:
- Hard requirements matter more than preferences.
- Prefer explicit evidence in tags/summary.
- A missing trope tag is not proof the trope is absent; score cautiously.
- Never reward popularity unless the user asked for it. Popularity is only the candidate-retrieval sort.
- Do not penalize a warning the user explicitly allowed.
- Put the best match first.
- Return at most ${resultCount} rankings.`;

  const user = JSON.stringify({ request: userQuery, plan, candidates: compactCandidates });
  const response = await llmJson(env, system, user);
  return Array.isArray(response?.rankings) ? response.rankings : [];
}

async function llmJson(env, system, user) {
  const endpoint = `${String(env.LLM_BASE_URL).replace(/\/$/, "")}/chat/completions`;
  const baseBody = {
    model: env.LLM_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    temperature: 0.1
  };

  let response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.LLM_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ ...baseBody, response_format: { type: "json_object" } })
  });

  // Some OpenAI-compatible providers do not implement response_format.
  if (response.status === 400) {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.LLM_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(baseBody)
    });
  }

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`LLM request failed (${response.status}): ${text.slice(0, 260)}`);
    error.status = 502;
    throw error;
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;

  if (typeof content !== "string") {
    const error = new Error("The LLM returned no usable response.");
    error.status = 502;
    throw error;
  }

  return parseJsonFromModel(content);
}

function buildAo3SearchUrl(plan, page) {
  const url = new URL(`${AO3_ORIGIN}/works/search`);
  const p = url.searchParams;

  p.set("utf8", "✓");
  p.set("commit", "Search");

  if (plan.fandom) p.set("work_search[fandom_names]", plan.fandom);
  if (plan.relationships.length) p.set("work_search[relationship_names]", plan.relationships.join(", "));
  if (plan.completeOnly) p.set("work_search[complete]", "T");
  if (plan.language) p.set("work_search[language_id]", languageToAo3Id(plan.language));

  if (plan.minWords != null && plan.maxWords != null) {
    p.set("work_search[word_count]", `${plan.minWords}-${plan.maxWords}`);
  } else if (plan.minWords != null) {
    p.set("work_search[word_count]", `>${plan.minWords}`);
  } else if (plan.maxWords != null) {
    p.set("work_search[word_count]", `<${plan.maxWords}`);
  }

  p.set("work_search[sort_column]", plan.sort || "kudos_count");
  p.set("work_search[sort_direction]", "desc");
  p.set("page", String(page));

  return url.toString();
}

function languageToAo3Id(language) {
  const value = String(language).toLowerCase();
  if (value === "english" || value === "en") return "en";
  return language;
}

async function fetchAo3Works(url, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(url, { method: "GET" });
  let response = await cache.match(cacheKey);

  if (!response) {
    const upstream = await fetch(url, {
      headers: {
        "Accept": "text/html,application/xhtml+xml",
        "User-Agent": "Awbem-AO3-LLM/0.1 (+https://awbem.dev/ao3-llm/)"
      },
      redirect: "follow"
    });

    if (!upstream.ok) {
      const error = new Error(`AO3 returned HTTP ${upstream.status}. Try again later.`);
      error.status = 502;
      throw error;
    }

    const html = await upstream.text();
    const ttl = clampInt(env.AO3_CACHE_SECONDS, 60, 3600, 600);
    response = new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": `public, max-age=${ttl}`
      }
    });

    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }

  return parseAo3SearchHtml(response.clone());
}

async function parseAo3SearchHtml(response) {
  const state = { current: null, works: [] };

  const startWork = {
    element(element) {
      const classes = element.getAttribute("class") || "";
      const idAttr = element.getAttribute("id") || "";
      const id = idAttr.match(/work_(\d+)/)?.[1] || null;
      state.current = blankWork(id);
      element.onEndTag(() => {
        if (state.current?.id) state.works.push(state.current);
        state.current = null;
      });
    }
  };

  const titleHandler = textHandler(state, "title");
  titleHandler.element = (element) => {
    if (!state.current) return;
    const href = element.getAttribute("href");
    if (href) {
      state.current.url = href.startsWith("http") ? href : `${AO3_ORIGIN}${href}`;
      const id = href.match(/\/works\/(\d+)/)?.[1];
      if (id) state.current.id = id;
    }
  };

  const rewriter = new HTMLRewriter()
    .on("li.work.blurb", startWork)
    .on('li.work.blurb h4.heading a[href^="/works/"]', titleHandler)
    .on('li.work.blurb a[rel="author"]', arrayTextHandler(state, "authors"))
    .on("li.work.blurb h5.fandoms a.tag", arrayTextHandler(state, "fandoms"))
    .on("li.work.blurb ul.tags li.warnings a.tag", arrayTextHandler(state, "warnings"))
    .on("li.work.blurb ul.tags li.relationships a.tag", arrayTextHandler(state, "relationships"))
    .on("li.work.blurb ul.tags li.characters a.tag", arrayTextHandler(state, "characters"))
    .on("li.work.blurb ul.tags li.freeforms a.tag", arrayTextHandler(state, "freeforms"))
    .on("li.work.blurb blockquote.userstuff.summary", textHandler(state, "summary"))
    .on("li.work.blurb dl.stats dd.language", textHandler(state, "language"))
    .on("li.work.blurb dl.stats dd.words", textHandler(state, "words"))
    .on("li.work.blurb dl.stats dd.chapters", textHandler(state, "chapters"))
    .on("li.work.blurb dl.stats dd.comments", textHandler(state, "comments"))
    .on("li.work.blurb dl.stats dd.kudos", textHandler(state, "kudos"))
    .on("li.work.blurb dl.stats dd.bookmarks", textHandler(state, "bookmarks"))
    .on("li.work.blurb dl.stats dd.hits", textHandler(state, "hits"));

  await rewriter.transform(response).arrayBuffer();

  return state.works.map(cleanWork).filter((work) => work.id && work.title);
}

function textHandler(state, field) {
  return {
    text(text) {
      if (!state.current) return;
      state.current[field] = `${state.current[field] || ""}${text.text}`;
    }
  };
}

function arrayTextHandler(state, field) {
  let buffer = "";
  return {
    element(element) {
      buffer = "";
      element.onEndTag(() => {
        if (!state.current) return;
        const value = normalizeWhitespace(buffer);
        if (value) state.current[field].push(value);
        buffer = "";
      });
    },
    text(text) {
      buffer += text.text;
    }
  };
}

function blankWork(id) {
  return {
    id,
    title: "",
    url: id ? `${AO3_ORIGIN}/works/${id}` : "",
    authors: [],
    fandoms: [],
    warnings: [],
    relationships: [],
    characters: [],
    freeforms: [],
    summary: "",
    language: "",
    words: "",
    chapters: "",
    comments: "",
    kudos: "",
    bookmarks: "",
    hits: ""
  };
}

function cleanWork(work) {
  const output = { ...work };
  for (const field of ["title", "summary", "language", "words", "chapters", "comments", "kudos", "bookmarks", "hits"]) {
    output[field] = normalizeWhitespace(output[field]);
  }
  for (const field of ["authors", "fandoms", "warnings", "relationships", "characters", "freeforms"]) {
    output[field] = unique(output[field].map(normalizeWhitespace).filter(Boolean));
  }
  return output;
}

function applyHardMetadataFilters(works, plan) {
  return works.filter((work) => {
    const haystack = normalizeForMatch([
      ...work.warnings,
      ...work.relationships,
      ...work.characters,
      ...work.freeforms,
      work.summary
    ].join(" | "));

    for (const warning of plan.excludeWarnings) {
      if (normalizeForMatch(work.warnings.join(" | ")).includes(normalizeForMatch(warning))) return false;
    }

    // Exclusions are hard only when AO3 itself explicitly surfaces the concept in tags/summary.
    for (const excluded of plan.exclude) {
      const needle = normalizeForMatch(excluded);
      if (needle && haystack.includes(needle)) return false;
    }

    return true;
  });
}

function normalizePlan(plan) {
  return {
    fandom: cleanString(plan?.fandom, 180),
    relationships: cleanArray(plan?.relationships, 5, 180),
    mustHave: cleanArray(plan?.mustHave, 12, 120),
    niceToHave: cleanArray(plan?.niceToHave, 12, 120),
    exclude: cleanArray(plan?.exclude, 12, 120),
    includeWarnings: cleanArray(plan?.includeWarnings, 6, 120),
    excludeWarnings: cleanArray(plan?.excludeWarnings, 6, 120),
    completeOnly: Boolean(plan?.completeOnly),
    minWords: nullableInt(plan?.minWords, 0, 10_000_000),
    maxWords: nullableInt(plan?.maxWords, 0, 10_000_000),
    language: cleanString(plan?.language, 80) || null,
    sort: ["kudos_count", "bookmarks_count", "hits", "word_count", "revised_at", "_score"].includes(plan?.sort)
      ? plan.sort
      : "kudos_count"
  };
}

function buildCorsHeaders(origin, env) {
  const headers = {
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };

  if (origin && originAllowed(origin, env)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

function originAllowed(origin, env) {
  if (!origin) return true;
  return allowedOrigins(env).includes(origin);
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "https://awbem.dev")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders
    }
  });
}

function parseJsonFromModel(content) {
  const trimmed = content.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

  try {
    return JSON.parse(unfenced);
  } catch {
    const first = unfenced.indexOf("{");
    const last = unfenced.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) {
      return JSON.parse(unfenced.slice(first, last + 1));
    }
    throw new Error("The LLM returned invalid JSON.");
  }
}

function cleanString(value, maxLength = 500) {
  if (typeof value !== "string") return "";
  return normalizeWhitespace(value).slice(0, maxLength);
}

function cleanArray(value, maxItems = 20, maxLength = 200) {
  if (!Array.isArray(value)) return [];
  return unique(value.map((item) => cleanString(item, maxLength)).filter(Boolean)).slice(0, maxItems);
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeForMatch(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function unique(values) {
  return [...new Set(values)];
}

function parseNumericText(value) {
  const number = Number(String(value || "").replace(/,/g, "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function nullableInt(value, min, max) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function safeErrorMessage(error) {
  const message = String(error?.message || "Unexpected server error.");
  return message.slice(0, 500);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
