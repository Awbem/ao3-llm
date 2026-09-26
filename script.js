const config = window.AO3_LLM_CONFIG || {};

const form = document.querySelector("#search-form");
const queryInput = document.querySelector("#query");
const resultCountInput = document.querySelector("#result-count");
const searchButton = document.querySelector("#search-button");
const statusEl = document.querySelector("#status");
const planPanel = document.querySelector("#plan-panel");
const planContent = document.querySelector("#plan-content");
const togglePlanButton = document.querySelector("#toggle-plan");
const resultsSection = document.querySelector("#results-section");
const resultsEl = document.querySelector("#results");
const resultSummary = document.querySelector("#result-summary");

let planVisible = true;

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const query = queryInput.value.trim();
  if (!query) return;

  if (!config.API_BASE_URL || config.API_BASE_URL.includes("YOUR-WORKER-NAME")) {
    setStatus("Set API_BASE_URL in ao3-llm/config.js after deploying the Worker.", true);
    return;
  }

  setLoading(true);
  setStatus("Interpreting your request…");
  planPanel.classList.add("hidden");
  resultsSection.classList.add("hidden");
  resultsEl.replaceChildren();

  try {
    const response = await fetch(`${config.API_BASE_URL.replace(/\/$/, "")}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        resultCount: Number(resultCountInput.value)
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || `Search failed (${response.status}).`);
    }

    renderPlan(data.plan);
    renderResults(data.results || []);

    const searched = data.candidateCount ?? 0;
    setStatus(`Searched ${searched} AO3 candidates and ranked the best matches.`);
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Something went wrong.", true);
  } finally {
    setLoading(false);
  }
});

togglePlanButton.addEventListener("click", () => {
  planVisible = !planVisible;
  planContent.classList.toggle("hidden", !planVisible);
  togglePlanButton.textContent = planVisible ? "Hide details" : "Show details";
});

function setLoading(isLoading) {
  searchButton.disabled = isLoading;
  searchButton.classList.toggle("loading", isLoading);
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function renderPlan(plan = {}) {
  const items = [
    ["Fandom", plan.fandom],
    ["Relationships", join(plan.relationships)],
    ["Must have", join(plan.mustHave)],
    ["Prefer", join(plan.niceToHave)],
    ["Exclude", join(plan.exclude)],
    ["Warning exclusions", join(plan.excludeWarnings)],
    ["Warning preferences", join(plan.includeWarnings)],
    ["Length", formatLength(plan)],
    ["Completion", plan.completeOnly ? "Complete works only" : "Complete or incomplete"],
    ["Language", plan.language || "Any"],
    ["Sort candidates", humanize(plan.sort || "kudos_count")]
  ].filter(([, value]) => value && value !== "—");

  planContent.replaceChildren(
    ...items.map(([label, value]) => {
      const div = document.createElement("div");
      div.className = "plan-item";

      const strong = document.createElement("strong");
      strong.textContent = label;

      const span = document.createElement("span");
      span.textContent = value;

      div.append(strong, span);
      return div;
    })
  );

  planVisible = true;
  planContent.classList.remove("hidden");
  togglePlanButton.textContent = "Hide details";
  planPanel.classList.remove("hidden");
}

function renderResults(results) {
  resultSummary.textContent = `${results.length} match${results.length === 1 ? "" : "es"}`;

  if (!results.length) {
    const empty = document.createElement("div");
    empty.className = "result-card";
    empty.textContent = "No matches survived the requested filters. Try making one requirement a preference instead.";
    resultsEl.append(empty);
    resultsSection.classList.remove("hidden");
    return;
  }

  for (const work of results) {
    const card = document.createElement("article");
    card.className = "result-card";

    const top = document.createElement("div");
    top.className = "result-topline";

    const titleWrap = document.createElement("div");
    const title = document.createElement("h3");
    const link = document.createElement("a");
    link.href = work.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = work.title || `AO3 Work ${work.id}`;
    title.append(link);

    const byline = document.createElement("div");
    byline.className = "byline";
    byline.textContent = work.authors?.length ? `by ${work.authors.join(", ")}` : "Anonymous";
    titleWrap.append(title, byline);

    const score = document.createElement("div");
    score.className = "match-score";
    score.textContent = `${Math.round(work.matchScore ?? 0)}%`;

    top.append(titleWrap, score);
    card.append(top);

    if (work.fandoms?.length) {
      const fandoms = document.createElement("div");
      fandoms.className = "fandoms";
      fandoms.textContent = work.fandoms.join(" • ");
      card.append(fandoms);
    }

    if (work.summary) {
      const summary = document.createElement("p");
      summary.className = "summary";
      summary.textContent = work.summary;
      card.append(summary);
    }

    const tagValues = [
      ...(work.warnings || []).map((text) => ({ text, type: "warning" })),
      ...(work.relationships || []).map((text) => ({ text, type: "relationship" })),
      ...(work.freeforms || []).slice(0, 14).map((text) => ({ text, type: "" }))
    ];

    if (tagValues.length) {
      const tags = document.createElement("div");
      tags.className = "tags";
      for (const item of tagValues) {
        const tag = document.createElement("span");
        tag.className = `tag ${item.type}`.trim();
        tag.textContent = item.text;
        tags.append(tag);
      }
      card.append(tags);
    }

    const stats = document.createElement("div");
    stats.className = "stats";
    stats.textContent = [
      work.words ? `${work.words} words` : null,
      work.chapters ? `${work.chapters} chapters` : null,
      work.kudos ? `${work.kudos} kudos` : null,
      work.bookmarks ? `${work.bookmarks} bookmarks` : null,
      work.hits ? `${work.hits} hits` : null
    ].filter(Boolean).join(" · ");
    if (stats.textContent) card.append(stats);

    if (work.matchReasons?.length) {
      const notes = document.createElement("div");
      notes.className = "match-notes";
      const strong = document.createElement("strong");
      strong.textContent = "Why it matches: ";
      notes.append(strong, document.createTextNode(work.matchReasons.join(" · ")));
      card.append(notes);
    }

    if (work.concerns?.length) {
      const concerns = document.createElement("div");
      concerns.className = "concerns";
      const strong = document.createElement("strong");
      strong.textContent = "Worth noting: ";
      concerns.append(strong, document.createTextNode(work.concerns.join(" · ")));
      card.append(concerns);
    }

    resultsEl.append(card);
  }

  resultsSection.classList.remove("hidden");
}

function join(value) {
  return Array.isArray(value) && value.length ? value.join(", ") : "—";
}

function formatLength(plan) {
  if (plan.minWords && plan.maxWords) return `${formatNumber(plan.minWords)}–${formatNumber(plan.maxWords)} words`;
  if (plan.minWords) return `${formatNumber(plan.minWords)}+ words`;
  if (plan.maxWords) return `Up to ${formatNumber(plan.maxWords)} words`;
  return "Any";
}

function formatNumber(value) {
  return Number(value).toLocaleString();
}

function humanize(value) {
  return String(value).replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}
