# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

KeywordCat is a client-side SEO keyword categorization tool that runs entirely in the browser. Users provide a brand name, domain, Anthropic API key, and keyword list. The app crawls the brand's website via Jina AI Reader (`r.jina.ai`), sends the content + keywords to Claude, and renders themed/categorized results with CSV/JSON export.

## Development

This is a static site with no build step, no bundler, and no dependencies. To run locally:

```
python -m http.server 8080
# then visit http://localhost:8080
```

Opening `index.html` as a `file://` URL will fail due to CORS restrictions on the Anthropic API.

Deployed via GitHub Pages from the `main` branch.

## Architecture

Three files make up the entire app:

- **`index.html`** — Markup for the 3-step form (brand config, keyword input, crawl options), progress indicators, and results section with export buttons.
- **`app.js`** — All application logic in a single file, organized into sections:
  - **Constants** — API URLs, model config (`claude-sonnet-4-6`), Jina Reader URL, content limits
  - **DOM/Progress helpers** — Step-based progress tracker with active/done/failed states
  - **Website crawling** — Uses Jina AI Reader (`r.jina.ai/{url}`) as a CORS-friendly proxy to convert pages to Markdown. Crawls homepage + guessed slugs for about/products/blog pages.
  - **Claude API** — Direct browser-to-API call using `x-api-key` and `anthropic-version` headers. Do NOT add non-standard headers (like `anthropic-dangerous-direct-browser-calls`) as they break CORS preflight.
  - **Prompt construction** (`buildPrompt`) — Assembles the SEO strategist prompt with brand context, crawled content, keyword list, and user preferences (sub-themes, rationale).
  - **Rendering** — Builds collapsible theme/sub-theme cards with keyword tags.
  - **Export** — `flattenResult()` normalizes the nested theme structure for CSV/JSON/clipboard export.
- **`style.css`** — CSS custom properties in `:root` for colors, spacing, typography. Responsive breakpoint at 640px.

## Key Constraints

- The API key is never stored or sent anywhere except directly to Anthropic's API.
- Site content sent to Claude is capped at 3000 chars per page (`MAX_PAGE_CHARS`) and 12000 chars total (`MAX_TOTAL_CHARS`).
- Claude's response must be valid JSON matching the `{ brand_analysis, themes[] }` schema. The app extracts JSON from code blocks or raw text.
