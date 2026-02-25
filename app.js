/**
 * KeywordCat – SEO Keyword Categorizer
 *
 * Flow:
 *  1. User provides brand name, domain, API key, and keyword list
 *  2. We crawl key pages of the brand site via Jina AI Reader (r.jina.ai),
 *     which converts any URL to clean Markdown and allows CORS requests.
 *  3. We send the extracted site content + keywords to Claude claude-sonnet-4-6
 *     and ask it to reason about themes, sub-themes, and categorization.
 *  4. We render the structured results and offer CSV / JSON export.
 */

// ── Constants ────────────────────────────────────────────────────────────────

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL   = 'claude-sonnet-4-6';
// Jina AI Reader: converts a URL to clean Markdown, CORS-friendly
const JINA_READER    = 'https://r.jina.ai/';
// Max characters of page content to send to Claude per page
const MAX_PAGE_CHARS = 3000;
// Max total site content characters sent to Claude
const MAX_TOTAL_CHARS = 12000;

// Theme palette – rotated as themes are created
const THEME_COLORS = [
  '#4F46E5', '#0891B2', '#059669', '#D97706',
  '#DC2626', '#7C3AED', '#DB2777', '#0284C7',
  '#16A34A', '#CA8A04',
];

// ── State ────────────────────────────────────────────────────────────────────

let lastResult = null; // Stores the last successful analysis result

// ── DOM helpers ──────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

function showEl(id)  { $(id).style.display = ''; }
function hideEl(id)  { $(id).style.display = 'none'; }

function showError(msg) {
  $('error-text').textContent = msg;
  showEl('error-banner');
  $('error-banner').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function hideError() { hideEl('error-banner'); }

// ── Progress tracker ─────────────────────────────────────────────────────────

const STEPS = [
  { id: 'step-validate',  label: 'Validating inputs' },
  { id: 'step-crawl',     label: 'Crawling brand website' },
  { id: 'step-analyze',   label: 'Analyzing content with Claude' },
  { id: 'step-render',    label: 'Rendering results' },
];

function initProgress() {
  hideError();
  hideEl('section-results');
  showEl('section-progress');

  const container = $('progress-steps');
  container.innerHTML = '';

  for (const step of STEPS) {
    const el = document.createElement('div');
    el.className = 'progress-step';
    el.id = step.id;
    el.innerHTML = `
      <svg class="step-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <circle cx="10" cy="10" r="10" fill="var(--gray-300)"/>
      </svg>
      <span>${step.label}</span>`;
    container.appendChild(el);
  }
}

function setStepActive(stepId) {
  const el = $(stepId);
  if (!el) return;
  el.className = 'progress-step active';
  el.querySelector('.step-icon').outerHTML =
    '<div class="spinner"></div>';
}

function setStepDone(stepId, note = '') {
  const el = $(stepId);
  if (!el) return;
  el.className = 'progress-step done';
  el.querySelector('.spinner, .step-icon').outerHTML = `
    <svg class="step-icon" viewBox="0 0 20 20" fill="currentColor">
      <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>
    </svg>`;
  if (note) {
    el.querySelector('span').textContent += ` – ${note}`;
  }
}

function setStepFailed(stepId, note = '') {
  const el = $(stepId);
  if (!el) return;
  el.className = 'progress-step failed';
  el.querySelector('.spinner, .step-icon').outerHTML = `
    <svg class="step-icon" viewBox="0 0 20 20" fill="currentColor">
      <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"/>
    </svg>`;
  if (note) {
    el.querySelector('span').textContent += ` – ${note}`;
  }
}

// ── Input parsing ─────────────────────────────────────────────────────────────

function parseKeywords(raw) {
  // Accept newline-separated or comma-separated keywords; trim whitespace
  return raw
    .split(/[\n,]+/)
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

function normalizeDomain(raw) {
  return raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/$/, '');
}

// ── Website crawling (via Jina AI Reader) ─────────────────────────────────────

/**
 * Fetch a URL through Jina AI Reader (r.jina.ai) which converts any page to
 * clean Markdown and serves it with permissive CORS headers.
 * Returns the markdown text or null on failure.
 */
async function fetchViaJina(url) {
  try {
    const jinaUrl = `${JINA_READER}${url}`;
    const res = await fetch(jinaUrl, {
      headers: {
        'Accept': 'text/plain',
        'X-Return-Format': 'markdown',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text.slice(0, MAX_PAGE_CHARS) || null;
  } catch {
    return null;
  }
}

/**
 * Build a list of candidate URLs to crawl given a domain and the user's
 * checkbox selections.
 */
function buildCrawlUrls(domain, options) {
  const base = `https://${domain}`;
  const urls = [{ url: base, label: 'Homepage' }];

  const slugGuesses = {
    about:    ['about', 'about-us', 'company', 'who-we-are'],
    products: ['products', 'services', 'solutions', 'offerings', 'features'],
    blog:     ['blog', 'resources', 'insights', 'learn', 'news'],
  };

  for (const [key, slugs] of Object.entries(slugGuesses)) {
    if (options[key]) {
      // Pick the most common first slug; we'll try only one per category
      urls.push({ url: `${base}/${slugs[0]}`, label: key.charAt(0).toUpperCase() + key.slice(1) });
    }
  }

  return urls;
}

/**
 * Crawl the website and return an array of { url, label, content, ok } objects.
 */
async function crawlWebsite(domain, options) {
  const targets = buildCrawlUrls(domain, options);
  const results = [];

  for (const target of targets) {
    const content = await fetchViaJina(target.url);
    results.push({
      url: target.url,
      label: target.label,
      content,
      ok: !!content,
    });
  }

  return results;
}

// ── Claude API ────────────────────────────────────────────────────────────────

/**
 * Build the prompt for Claude.
 */
function buildPrompt({ brandName, domain, siteContent, keywords, allowSubthemes, includeRationale, extraContext }) {
  const keywordList = keywords.map((k, i) => `${i + 1}. ${k}`).join('\n');

  const subthemeInstruction = allowSubthemes
    ? 'Use sub-themes where a theme is broad enough to contain meaningfully distinct clusters. Not every theme needs sub-themes.'
    : 'Do NOT use sub-themes. Only use top-level themes.';

  const rationaleInstruction = includeRationale
    ? 'For each theme (and sub-theme), add a brief "rationale" field (1–2 sentences) explaining why these keywords belong together and how they relate to the brand.'
    : 'Omit the "rationale" field.';

  const extraInstruction = extraContext?.trim()
    ? `\nAdditional context from the user:\n${extraContext.trim()}\n`
    : '';

  return `You are an expert SEO strategist and content architect. Your task is to categorize a list of SEO keywords into meaningful themes that align with a specific brand's products and services.

## Brand
- Name: ${brandName}
- Domain: ${domain}

## Website Content (extracted from crawl)
${siteContent}
${extraInstruction}
## Keywords to Categorize (${keywords.length} total)
${keywordList}

## Instructions

1. **Analyze the brand**: Based on the website content, identify the brand's core offerings, target audience, and key topics.
2. **Determine themes**: Decide how many top-level themes are needed (typically 3–8). Each theme should represent a distinct topical cluster meaningful to this brand's SEO strategy.
3. **${subthemeInstruction}**
4. **Assign every keyword** to exactly one theme or sub-theme. Do not leave any keyword uncategorized unless it is truly unrelated to the brand (put those in an "Uncategorized" theme).
5. **${rationaleInstruction}**
6. Ensure theme names are concise (2–5 words), title-case, and would make sense as content pillars.

## Output Format

Respond with ONLY a valid JSON object matching this schema (no prose before or after):

\`\`\`json
{
  "brand_analysis": "2–4 sentence summary of the brand and its offerings based on the crawl",
  "themes": [
    {
      "name": "Theme Name",
      "rationale": "Why these keywords belong together and how they serve the brand (omit if not requested)",
      "keywords": ["keyword a", "keyword b"],
      "sub_themes": [
        {
          "name": "Sub-theme Name",
          "rationale": "...",
          "keywords": ["keyword c", "keyword d"]
        }
      ]
    }
  ]
}
\`\`\`

Rules:
- "keywords" at the theme level should only contain keywords NOT assigned to a sub-theme.
- "sub_themes" may be an empty array [] if not used.
- Every keyword from the input list must appear exactly once in the output.
- Sort themes by the number of keywords they contain (descending).
- Sort keywords alphabetically within each theme/sub-theme.`;
}

/**
 * Call the Anthropic Messages API from the browser.
 * Requires the user's API key and the anthropic-dangerous-direct-browser-calls header.
 */
async function callClaude(apiKey, prompt) {
  const res = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-calls': 'true',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    let errMsg = `API error ${res.status}`;
    try {
      const errData = await res.json();
      errMsg = errData?.error?.message || errMsg;
    } catch { /* ignore */ }
    throw new Error(errMsg);
  }

  const data = await res.json();
  const rawText = data?.content?.[0]?.text;

  if (!rawText) throw new Error('Claude returned an empty response.');

  // Extract JSON from the response (Claude may wrap it in a code block)
  const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]+?)\s*```/) ||
                    rawText.match(/(\{[\s\S]+\})/);

  if (!jsonMatch) {
    throw new Error('Could not parse JSON from Claude\'s response. Try again.');
  }

  try {
    return JSON.parse(jsonMatch[1]);
  } catch (e) {
    throw new Error(`JSON parse error: ${e.message}`);
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function totalKeywordsInTheme(theme) {
  const direct = (theme.keywords || []).length;
  const sub = (theme.sub_themes || []).reduce((acc, st) => acc + (st.keywords || []).length, 0);
  return direct + sub;
}

function renderCrawlStatus(crawlResults) {
  const container = $('crawl-status');
  container.innerHTML = '';

  for (const r of crawlResults) {
    const pill = document.createElement('span');
    pill.className = `crawl-pill ${r.ok ? 'ok' : 'fail'}`;
    pill.innerHTML = r.ok
      ? `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><polyline points="3.5,6 5,7.5 8.5,4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg> ${r.label}`
      : `<svg width="12" height="12" viewBox="0 0 12 12"><line x1="3" y1="3" x2="9" y2="9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="9" y1="3" x2="3" y2="9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> ${r.label} (skipped)`;
    container.appendChild(pill);
  }
}

function renderThemes(themes) {
  const container = $('themes-container');
  container.innerHTML = '';

  themes.forEach((theme, idx) => {
    const color = THEME_COLORS[idx % THEME_COLORS.length];
    const total = totalKeywordsInTheme(theme);
    const block = document.createElement('div');
    block.className = 'theme-block';
    block.dataset.idx = idx;

    // Header
    const header = document.createElement('div');
    header.className = 'theme-header';
    header.setAttribute('role', 'button');
    header.setAttribute('aria-expanded', 'true');
    header.innerHTML = `
      <div class="theme-header-left">
        <span class="theme-color-dot" style="background:${color}"></span>
        <span class="theme-name">${escapeHtml(theme.name)}</span>
      </div>
      <span class="theme-count-badge">${total} keyword${total !== 1 ? 's' : ''}</span>
      <svg class="theme-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="6 9 12 15 18 9"/>
      </svg>`;

    header.addEventListener('click', () => {
      block.classList.toggle('collapsed');
      header.setAttribute('aria-expanded', !block.classList.contains('collapsed'));
    });

    // Body
    const body = document.createElement('div');
    body.className = 'theme-body';

    if (theme.rationale) {
      const rat = document.createElement('p');
      rat.className = 'theme-rationale';
      rat.textContent = theme.rationale;
      body.appendChild(rat);
    }

    // Direct keywords (not in sub-themes)
    if (theme.keywords && theme.keywords.length > 0) {
      body.appendChild(buildKeywordTags(theme.keywords, color));
    }

    // Sub-themes
    if (theme.sub_themes && theme.sub_themes.length > 0) {
      for (const sub of theme.sub_themes) {
        const subBlock = document.createElement('div');
        subBlock.className = 'subtheme-block';

        const subHeader = document.createElement('div');
        subHeader.className = 'subtheme-header';
        subHeader.innerHTML = `
          <span class="theme-color-dot" style="background:${color};opacity:0.5;width:8px;height:8px"></span>
          <span class="subtheme-name">${escapeHtml(sub.name)}</span>
          <span class="subtheme-count">${(sub.keywords || []).length} keywords</span>`;
        subBlock.appendChild(subHeader);

        if (sub.rationale) {
          const subRat = document.createElement('p');
          subRat.className = 'theme-rationale';
          subRat.style.padding = '8px 14px 0';
          subRat.textContent = sub.rationale;
          subBlock.appendChild(subRat);
        }

        const subBody = document.createElement('div');
        subBody.className = 'subtheme-body';
        subBody.appendChild(buildKeywordTags(sub.keywords || [], color));
        subBlock.appendChild(subBody);

        body.appendChild(subBlock);
      }
    }

    block.appendChild(header);
    block.appendChild(body);
    container.appendChild(block);
  });
}

function buildKeywordTags(keywords, color) {
  const wrap = document.createElement('div');
  wrap.className = 'keyword-tags';
  for (const kw of keywords) {
    const tag = document.createElement('span');
    tag.className = 'kw-tag';
    tag.textContent = kw;
    wrap.appendChild(tag);
  }
  return wrap;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Export helpers ────────────────────────────────────────────────────────────

function flattenResult(result) {
  const rows = [];
  for (const theme of result.themes) {
    for (const kw of (theme.keywords || [])) {
      rows.push({ keyword: kw, theme: theme.name, sub_theme: '' });
    }
    for (const sub of (theme.sub_themes || [])) {
      for (const kw of (sub.keywords || [])) {
        rows.push({ keyword: kw, theme: theme.name, sub_theme: sub.name });
      }
    }
  }
  return rows;
}

function exportCSV(result) {
  const rows = flattenResult(result);
  const header = 'keyword,theme,sub_theme\n';
  const body = rows
    .map((r) => [r.keyword, r.theme, r.sub_theme].map(csvCell).join(','))
    .join('\n');
  downloadFile('keywords_categorized.csv', header + body, 'text/csv');
}

function csvCell(val) {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

function exportJSON(result) {
  downloadFile('keywords_categorized.json', JSON.stringify(result, null, 2), 'application/json');
}

function copyFormatted(result) {
  const lines = [];
  lines.push(`# Keyword Themes for ${result.brand_name || 'Brand'}\n`);
  if (result.brand_analysis) {
    lines.push(`${result.brand_analysis}\n`);
  }
  for (const theme of result.themes) {
    const total = totalKeywordsInTheme(theme);
    lines.push(`\n## ${theme.name} (${total} keywords)`);
    if (theme.rationale) lines.push(`_${theme.rationale}_`);
    for (const kw of (theme.keywords || [])) lines.push(`- ${kw}`);
    for (const sub of (theme.sub_themes || [])) {
      lines.push(`\n### ${sub.name}`);
      if (sub.rationale) lines.push(`_${sub.rationale}_`);
      for (const kw of (sub.keywords || [])) lines.push(`- ${kw}`);
    }
  }
  navigator.clipboard.writeText(lines.join('\n')).then(() => {
    const btn = $('btn-copy');
    const original = btn.innerHTML;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.innerHTML = original; }, 2000);
  });
}

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Main analysis flow ────────────────────────────────────────────────────────

async function runAnalysis() {
  // --- Gather inputs ---
  const brandName    = $('brand-name').value.trim();
  const rawDomain    = $('brand-domain').value.trim();
  const apiKey       = $('api-key').value.trim();
  const rawKeywords  = $('keywords-input').value;
  const allowSubthemes   = $('allow-subthemes').checked;
  const includeRationale = $('include-rationale').checked;
  const extraContext     = $('extra-context').value;

  const crawlAbout    = $('crawl-about').checked;
  const crawlProducts = $('crawl-products').checked;
  const crawlBlog     = $('crawl-blog').checked;

  initProgress();

  // --- Step 1: Validate ---
  setStepActive('step-validate');

  if (!brandName) {
    setStepFailed('step-validate', 'brand name is required');
    showError('Please enter a brand name.');
    $('btn-analyze').disabled = false;
    return;
  }
  if (!rawDomain) {
    setStepFailed('step-validate', 'domain is required');
    showError('Please enter a website domain.');
    $('btn-analyze').disabled = false;
    return;
  }
  if (!apiKey || !apiKey.startsWith('sk-ant-')) {
    setStepFailed('step-validate', 'invalid API key');
    showError('Please enter a valid Anthropic API key (starts with sk-ant-).');
    $('btn-analyze').disabled = false;
    return;
  }

  const keywords = parseKeywords(rawKeywords);
  if (keywords.length === 0) {
    setStepFailed('step-validate', 'no keywords found');
    showError('Please paste at least one keyword.');
    $('btn-analyze').disabled = false;
    return;
  }

  const domain = normalizeDomain(rawDomain);
  setStepDone('step-validate', `${keywords.length} keywords, domain: ${domain}`);

  // --- Step 2: Crawl ---
  setStepActive('step-crawl');

  const crawlOptions = { about: crawlAbout, products: crawlProducts, blog: crawlBlog };
  let crawlResults;
  try {
    crawlResults = await crawlWebsite(domain, crawlOptions);
  } catch (err) {
    setStepFailed('step-crawl', err.message);
    showError(`Crawl failed: ${err.message}`);
    $('btn-analyze').disabled = false;
    return;
  }

  const successfulCrawls = crawlResults.filter((r) => r.ok);
  if (successfulCrawls.length === 0) {
    setStepFailed('step-crawl', 'all pages failed');
    showError(
      'Could not retrieve any pages from the website. ' +
      'Check that the domain is correct and the site is publicly accessible. ' +
      'You can add context manually in the "Additional context" field.'
    );
    $('btn-analyze').disabled = false;
    return;
  }

  // Combine site content up to MAX_TOTAL_CHARS
  let siteContent = '';
  for (const r of successfulCrawls) {
    const section = `\n--- ${r.label} (${r.url}) ---\n${r.content}\n`;
    if ((siteContent + section).length > MAX_TOTAL_CHARS) {
      siteContent += section.slice(0, MAX_TOTAL_CHARS - siteContent.length);
      break;
    }
    siteContent += section;
  }

  setStepDone('step-crawl', `${successfulCrawls.length}/${crawlResults.length} pages retrieved`);

  // --- Step 3: Claude analysis ---
  setStepActive('step-analyze');

  let result;
  try {
    const prompt = buildPrompt({
      brandName,
      domain,
      siteContent,
      keywords,
      allowSubthemes,
      includeRationale,
      extraContext,
    });
    result = await callClaude(apiKey, prompt);
  } catch (err) {
    setStepFailed('step-analyze', err.message);
    showError(`Claude API error: ${err.message}`);
    $('btn-analyze').disabled = false;
    return;
  }

  // Validate result has themes array
  if (!result?.themes || !Array.isArray(result.themes)) {
    setStepFailed('step-analyze', 'unexpected response format');
    showError('Received an unexpected response from Claude. Please try again.');
    $('btn-analyze').disabled = false;
    return;
  }

  // Attach brand name to result for export
  result.brand_name = brandName;
  lastResult = result;

  setStepDone('step-analyze', `${result.themes.length} themes identified`);

  // --- Step 4: Render ---
  setStepActive('step-render');

  const totalThemes = result.themes.length;
  const totalSubthemes = result.themes.reduce((a, t) => a + (t.sub_themes?.length || 0), 0);
  const totalCategorized = result.themes.reduce((a, t) => a + totalKeywordsInTheme(t), 0);

  $('results-summary').textContent =
    `${totalCategorized} keyword${totalCategorized !== 1 ? 's' : ''} organized into ` +
    `${totalThemes} theme${totalThemes !== 1 ? 's' : ''}` +
    (totalSubthemes > 0 ? ` and ${totalSubthemes} sub-theme${totalSubthemes !== 1 ? 's' : ''}` : '');

  if (result.brand_analysis) {
    $('brand-analysis-text').textContent = result.brand_analysis;
    showEl('brand-analysis-card');
  }

  renderCrawlStatus(crawlResults);
  renderThemes(result.themes);

  setStepDone('step-render');
  showEl('section-results');
  $('section-results').scrollIntoView({ behavior: 'smooth', block: 'start' });

  $('btn-analyze').disabled = false;
}

// ── Event listeners ───────────────────────────────────────────────────────────

// Keyword counter
$('keywords-input').addEventListener('input', () => {
  const keywords = parseKeywords($('keywords-input').value);
  if (keywords.length > 0) {
    $('keyword-count').textContent = `${keywords.length} keyword${keywords.length !== 1 ? 's' : ''} detected`;
    showEl('keywords-meta');
  } else {
    hideEl('keywords-meta');
  }
});

// API key visibility toggle
$('toggle-key').addEventListener('click', () => {
  const input = $('api-key');
  const isPassword = input.type === 'password';
  input.type = isPassword ? 'text' : 'password';
  $('icon-eye').style.display     = isPassword ? 'none' : '';
  $('icon-eye-off').style.display = isPassword ? '' : 'none';
});

// Main analyze button
$('btn-analyze').addEventListener('click', async () => {
  $('btn-analyze').disabled = true;
  try {
    await runAnalysis();
  } catch (err) {
    showError(`Unexpected error: ${err.message}`);
    $('btn-analyze').disabled = false;
  }
});

// Export buttons
$('btn-export-csv').addEventListener('click', () => {
  if (lastResult) exportCSV(lastResult);
});
$('btn-export-json').addEventListener('click', () => {
  if (lastResult) exportJSON(lastResult);
});
$('btn-copy').addEventListener('click', () => {
  if (lastResult) copyFormatted(lastResult);
});

// Reset button
$('btn-reset').addEventListener('click', () => {
  hideEl('section-results');
  hideEl('section-progress');
  hideError();
  lastResult = null;
  $('btn-analyze').disabled = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
