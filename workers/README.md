# AO3 LLM API Worker

Backend for `awbem.dev/ao3-llm/`.

## What it does

1. Sends the user's plain-English request to an OpenAI-compatible LLM.
2. Builds a broad AO3 work search from fandom / relationship / length / completion preferences.
3. Fetches a small number of AO3 result pages and caches them briefly.
4. Applies explicit metadata exclusions.
5. Sends the real AO3 candidates back to the LLM for semantic ranking.
6. Returns only metadata and links to AO3; it does not download full work text.

## Setup

From this folder:

```bash
npm install
npx wrangler login
npx wrangler secret put LLM_API_KEY
npm run deploy
```

When Wrangler prints your Worker URL, put it in:

`/ao3-llm/config.js`

Example:

```js
window.AO3_LLM_CONFIG = {
  API_BASE_URL: "https://ao3-llm-api.example.workers.dev"
};
```

## LLM provider

The Worker expects an OpenAI-compatible `POST /chat/completions` endpoint.

The defaults in `wrangler.toml` are:

- `LLM_BASE_URL = "https://api.openai.com/v1"`
- `LLM_MODEL = "gpt-5.6-luna"`

You can change both values for another compatible provider without changing the frontend.

Never place `LLM_API_KEY` in GitHub, `config.js`, or `wrangler.toml`. Store it with `wrangler secret put LLM_API_KEY`.

## Local frontend testing

`ALLOWED_ORIGINS` already includes common Live Server / Five Server origins on port 5500. If your preview uses a different port, add it to `ALLOWED_ORIGINS` and redeploy.
