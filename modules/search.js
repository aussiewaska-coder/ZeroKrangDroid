// modules/search.js — Multi-provider search
// Brave (primary) · Perplexity (answers) · SerpAPI (fallback)

const BRAVE_KEY      = process.env.BRAVE_API_KEY;
const PERPLEXITY_KEY = process.env.PERPLEXITY_API_KEY;
const SERP_KEY       = process.env.SERPAPI_KEY;

// ─────────────────────────────────────────────
// UNIFIED SEARCH — picks best provider
// ─────────────────────────────────────────────
export async function search(query, {
  provider = 'auto',  // auto | brave | perplexity | serp | ddg
  limit = 8,
  country = 'AU',
  freshness = null,   // 'day' | 'week' | 'month' — brave only
  type = 'web'        // 'web' | 'news'
} = {}) {
  // Auto-select best available provider
  if (provider === 'auto') {
    if (BRAVE_KEY) provider = 'brave';
    else if (SERP_KEY) provider = 'serp';
    else provider = 'ddg';
  }

  console.log(`🔍 [${provider}] ${query}`);

  switch (provider) {
    case 'brave':      return braveSearch(query, { limit, country, freshness, type });
    case 'perplexity': return perplexityAsk(query);
    case 'serp':       return serpSearch(query, { limit, country });
    case 'ddg':        return ddgSearch(query, limit);
    default:           return braveSearch(query, { limit, country });
  }
}

// ─────────────────────────────────────────────
// BRAVE SEARCH
// Free tier: 2000 queries/month
// Best for: general web, news, fresh results
// ─────────────────────────────────────────────
async function braveSearch(query, { limit = 8, country = 'AU', freshness = null, type = 'web' } = {}) {
  if (!BRAVE_KEY) throw new Error('BRAVE_API_KEY not set');

  const params = new URLSearchParams({
    q: query,
    count: Math.min(limit, 20),
    country,
    search_lang: 'en',
    ...(freshness && { freshness }),
    ...(type === 'news' && { result_filter: 'news' })
  });

  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': BRAVE_KEY
    },
    signal: AbortSignal.timeout(10000)
  });

  if (!res.ok) throw new Error(`Brave API ${res.status}: ${await res.text()}`);
  const data = await res.json();

  const results = [];

  // Web results
  for (const r of (data.web?.results || [])) {
    results.push({
      title: r.title,
      url: r.url,
      snippet: r.description,
      age: r.age,
      provider: 'brave'
    });
  }

  // Featured snippet / answer box
  if (data.query?.answer) {
    results.unshift({
      title: 'Answer',
      url: null,
      snippet: data.query.answer,
      featured: true,
      provider: 'brave'
    });
  }

  return results.slice(0, limit);
}

// ─────────────────────────────────────────────
// PERPLEXITY — returns synthesised answers
// Best for: questions, research, current events
// ─────────────────────────────────────────────
export async function perplexityAsk(query, { model = 'llama-3.1-sonar-small-128k-online' } = {}) {
  if (!PERPLEXITY_KEY) throw new Error('PERPLEXITY_API_KEY not set');

  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PERPLEXITY_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: 'Be precise and concise. Focus on factual, actionable information. Include sources.'
        },
        { role: 'user', content: query }
      ],
      return_citations: true,
      return_images: false,
      search_recency_filter: 'month'
    }),
    signal: AbortSignal.timeout(20000)
  });

  if (!res.ok) throw new Error(`Perplexity API ${res.status}`);
  const data = await res.json();

  const answer = data.choices?.[0]?.message?.content || '';
  const citations = data.citations || [];

  return [{
    title: 'Perplexity Answer',
    url: null,
    snippet: answer,
    citations,
    featured: true,
    provider: 'perplexity'
  }];
}

// ─────────────────────────────────────────────
// SERPAPI — Google results scraper
// Best for: AU-specific results, local search
// ─────────────────────────────────────────────
async function serpSearch(query, { limit = 8, country = 'au' } = {}) {
  if (!SERP_KEY) throw new Error('SERPAPI_KEY not set');

  const params = new URLSearchParams({
    q: query,
    api_key: SERP_KEY,
    gl: country.toLowerCase(),
    hl: 'en',
    num: limit
  });

  const res = await fetch(`https://serpapi.com/search.json?${params}`, {
    signal: AbortSignal.timeout(15000)
  });

  if (!res.ok) throw new Error(`SerpAPI ${res.status}`);
  const data = await res.json();

  const results = [];

  // Answer box
  if (data.answer_box?.answer || data.answer_box?.snippet) {
    results.push({
      title: data.answer_box.title || 'Answer',
      url: data.answer_box.link || null,
      snippet: data.answer_box.answer || data.answer_box.snippet,
      featured: true,
      provider: 'serp'
    });
  }

  for (const r of (data.organic_results || [])) {
    results.push({
      title: r.title,
      url: r.link,
      snippet: r.snippet,
      provider: 'serp'
    });
  }

  return results.slice(0, limit);
}

// ─────────────────────────────────────────────
// DUCKDUCKGO — no API key, fallback
// ─────────────────────────────────────────────
async function ddgSearch(query, limit = 5) {
  const res = await fetch(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
    { signal: AbortSignal.timeout(8000) }
  );
  const data = await res.json();
  const results = [];
  if (data.AbstractText) results.push({ title: data.Heading, url: data.AbstractURL, snippet: data.AbstractText, provider: 'ddg' });
  for (const r of (data.RelatedTopics || []).slice(0, limit - 1)) {
    if (r.Text && r.FirstURL) results.push({ title: r.Text.slice(0, 80), url: r.FirstURL, snippet: r.Text, provider: 'ddg' });
  }
  return results;
}

// ─────────────────────────────────────────────
// SEARCH + FETCH — search then deep read top results
// ─────────────────────────────────────────────
export async function searchAndRead(query, { limit = 3, readLimit = 2 } = {}) {
  const results = await search(query, { limit });
  const { fetch: webFetch } = await import('./browse.js');

  const enriched = await Promise.allSettled(
    results.slice(0, readLimit)
      .filter(r => r.url)
      .map(async r => {
        const page = await webFetch(r.url);
        return { ...r, fullText: page?.text?.slice(0, 3000) };
      })
  );

  return {
    results,
    enriched: enriched
      .filter(p => p.status === 'fulfilled')
      .map(p => p.value)
  };
}

export function formatResults(results) {
  return results.map((r, i) =>
    `${i + 1}. ${r.title}\n   ${r.snippet || ''}\n   ${r.url || ''}`
  ).join('\n\n');
}
