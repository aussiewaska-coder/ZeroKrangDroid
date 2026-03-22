// modules/collector.js — Web Intelligence Collector
// Chat-triggered structured data extraction → Supabase
// Usage: "go find TUG franchise leads from touchupguys.com.au"

import * as Browse from './browse.js';
import * as Search from './search.js';
import * as Memory from './memory.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY; // or service_role key

// ─────────────────────────────────────────────
// PARSE COLLECTION INTENT from natural language
// "find TUG leads from site.com" → structured job
// ─────────────────────────────────────────────
export async function parseIntent(message) {
  const { chatWithClaude } = await import('./ai.js');

  const raw = await chatWithClaude([{ role: 'user', content: `Parse this data collection request into a structured job.

Message: "${message}"

Return JSON:
{
  "action": "collect",
  "target": "URL or search query to start from",
  "is_url": true/false,
  "topic": "brief description of what to find",
  "schema": {
    "table": "supabase_table_name (snake_case)",
    "fields": {
      "field_name": "description of what to extract"
    }
  },
  "follow_links": true/false,
  "max_pages": 1-20,
  "confidence": 0.0-1.0
}

Examples:
- "find all TUG franchisees from touchupguys.com.au/find-a-repairer" →
  target: "https://touchupguys.com.au/find-a-repairer", is_url: true,
  schema: { table: "tug_franchisees", fields: { name, suburb, phone, email } }

- "find car detailing businesses in Gold Coast" →
  target: "car detailing Gold Coast", is_url: false,
  schema: { table: "leads", fields: { business_name, phone, website, suburb } }

Return only JSON.` }],
    null, 'Return only valid JSON. Be precise about field names.');

  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// RUN COLLECTION JOB
// ─────────────────────────────────────────────
export async function run(job, { broadcast } = {}) {
  const emit = (type, data) => broadcast?.(type, { ...data, jobId: job.id });
  const log = (msg, data = {}) => {
    console.log(`🕷️  [collector] ${msg}`);
    emit('collector_log', { msg, ...data });
  };

  const result = {
    id: job.id || `job_${Date.now()}`,
    topic: job.topic,
    table: job.schema?.table,
    rows: [],
    errors: [],
    pagesVisited: [],
    startedAt: new Date().toISOString()
  };

  emit('collector_start', { job, result });
  log(`Starting: ${job.topic}`);
  log(`Target: ${job.target}`);
  log(`Schema: ${JSON.stringify(job.schema?.fields)}`);

  try {
    // Get starting URLs
    let urls = [];

    if (job.is_url) {
      urls = [job.target];
    } else {
      // Search first, collect URLs
      log('Searching for starting URLs...');
      emit('collector_url', { url: null, status: 'searching' });
      const results = await Search.search(job.target, { limit: job.max_pages || 8, country: 'AU' });
      urls = results.filter(r => r.url).map(r => r.url).slice(0, job.max_pages || 8);
      log(`Found ${urls.length} URLs to visit`);
    }

    const visited = new Set();

    for (const startUrl of urls) {
      if (visited.has(startUrl)) continue;
      visited.add(startUrl);
      result.pagesVisited.push(startUrl);

      emit('collector_url', { url: startUrl, status: 'fetching' });
      log(`Fetching: ${startUrl}`, { url: startUrl });

      const page = await Browse.fetch(startUrl, { maxChars: 15000 });

      if (!page.text) {
        log(`Failed to fetch: ${startUrl}`, { url: startUrl, error: page.error });
        result.errors.push({ url: startUrl, error: page.error });
        continue;
      }

      emit('collector_url', { url: startUrl, status: 'extracting', title: page.title });
      log(`Extracting from: ${page.title || startUrl}`);

      // Extract structured data using Claude
      const extracted = await extractWithSchema(page, job.schema, startUrl);

      if (extracted?.length) {
        log(`Extracted ${extracted.length} records from ${startUrl}`);
        emit('collector_extracted', { url: startUrl, count: extracted.length, rows: extracted });

        for (const row of extracted) {
          result.rows.push({ ...row, _source_url: startUrl, _collected_at: new Date().toISOString() });
        }
      } else {
        log(`No records found at ${startUrl}`);
      }

      // Follow internal links if requested
      if (job.follow_links && page.links?.length) {
        const relevantLinks = await filterRelevantLinks(page.links, job.topic, visited, startUrl);
        for (const link of relevantLinks.slice(0, 3)) {
          if (!visited.has(link)) urls.push(link);
        }
        if (relevantLinks.length) log(`Queued ${relevantLinks.length} follow links`);
      }

      // Live preview update
      emit('collector_preview', {
        url: startUrl,
        title: page.title,
        totalRows: result.rows.length,
        lastExtracted: extracted?.slice(0, 2)
      });

      // Small delay to be polite
      await sleep(800);
    }

    result.completedAt = new Date().toISOString();
    log(`Collection complete: ${result.rows.length} records from ${result.pagesVisited.length} pages`);

    // Push to Supabase
    if (result.rows.length > 0 && SUPABASE_URL && SUPABASE_KEY) {
      log(`Pushing ${result.rows.length} records to Supabase table: ${job.schema.table}`);
      emit('collector_push', { count: result.rows.length, table: job.schema.table });

      const pushResult = await pushToSupabase(job.schema.table, result.rows);
      result.supabase = pushResult;

      if (pushResult.error) {
        log(`Supabase error: ${pushResult.error}`);
      } else {
        log(`✅ Pushed ${result.rows.length} records to ${job.schema.table}`);
      }
    } else if (!SUPABASE_URL) {
      log('Supabase not configured — data available in result only');
    }

    // Store summary in memory
    await Memory.store(
      `Collected ${result.rows.length} records about "${job.topic}" from ${result.pagesVisited.length} pages. Table: ${job.schema?.table}`,
      { source: 'collector', importance: 0.7, tags: ['collection', job.schema?.table || 'data'] }
    );

    emit('collector_done', { result });
    return result;

  } catch (e) {
    log(`Fatal error: ${e.message}`);
    result.error = e.message;
    emit('collector_error', { error: e.message });
    return result;
  }
}

// ─────────────────────────────────────────────
// EXTRACT with custom schema using Claude
// ─────────────────────────────────────────────
async function extractWithSchema(page, schema, url) {
  const { chatWithClaude } = await import('./ai.js');

  const fieldDescriptions = Object.entries(schema.fields)
    .map(([k, v]) => `  "${k}": "${v}"`)
    .join(',\n');

  const prompt = `Extract structured data from this webpage.

Page URL: ${url}
Page Title: ${page.title || 'Unknown'}

Extract all records matching this schema. Return a JSON array.
Each record should have these fields:
{
${fieldDescriptions}
}

Rules:
- Extract EVERY record found on the page, not just one
- Use null for fields not found
- Clean up formatting (remove extra spaces, standardise phone numbers to +61 format)
- For Australian phone numbers: convert 04xx to +614xx, 07xx to +617xx etc
- Return [] if no matching records found
- Return ONLY the JSON array, no explanation

Page content:
${page.text.slice(0, 10000)}`;

  try {
    const raw = await chatWithClaude(
      [{ role: 'user', content: prompt }],
      null,
      'You are a precise data extraction engine. Return only valid JSON arrays. Extract every record you can find.'
    );
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    return Array.isArray(parsed) ? parsed.filter(r => hasAnyValue(r)) : [];
  } catch (e) {
    console.error('Extraction error:', e.message);
    return [];
  }
}

// ─────────────────────────────────────────────
// FILTER RELEVANT LINKS
// ─────────────────────────────────────────────
async function filterRelevantLinks(links, topic, visited, baseUrl) {
  try {
    const base = new URL(baseUrl);
    // Only same domain, not visited, looks content-like
    return links
      .filter(l => {
        try {
          const u = new URL(l.url);
          return u.hostname === base.hostname &&
            !visited.has(l.url) &&
            !l.url.match(/\.(pdf|jpg|png|gif|zip|css|js)$/i) &&
            !l.url.includes('#') &&
            !l.url.includes('logout') &&
            !l.url.includes('login');
        } catch { return false; }
      })
      .filter(l => {
        // Basic relevance check on link text
        const text = (l.text || '').toLowerCase();
        const topicWords = topic.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        return topicWords.some(w => text.includes(w)) ||
          l.url.includes('page') || l.url.includes('listing') ||
          l.url.match(/\/\d+/) || l.url.includes('result');
      })
      .map(l => l.url)
      .slice(0, 5);
  } catch { return []; }
}

// ─────────────────────────────────────────────
// PUSH TO SUPABASE
// ─────────────────────────────────────────────
async function pushToSupabase(table, rows) {
  try {
    const res = await globalThis.fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal,resolution=merge-duplicates'
      },
      body: JSON.stringify(rows),
      signal: AbortSignal.timeout(30000)
    });

    if (!res.ok) {
      const err = await res.text();
      return { ok: false, error: `${res.status}: ${err}` };
    }

    return { ok: true, inserted: rows.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─────────────────────────────────────────────
// SUPABASE — create table from schema
// ─────────────────────────────────────────────
export async function ensureTable(tableName, fields) {
  // Generate SQL to create the table
  const cols = Object.keys(fields).map(f => `  ${f} TEXT`).join(',\n');
  const sql = `
CREATE TABLE IF NOT EXISTS ${tableName} (
  id BIGSERIAL PRIMARY KEY,
${cols},
  _source_url TEXT,
  _collected_at TIMESTAMPTZ DEFAULT NOW()
);`;

  // Push via Supabase SQL API (requires service_role key)
  if (!SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { sql, note: 'Run this SQL in your Supabase dashboard to create the table' };
  }

  try {
    const res = await globalThis.fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
      method: 'POST',
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ sql })
    });
    return { ok: res.ok, sql };
  } catch (e) {
    return { ok: false, error: e.message, sql };
  }
}

// ─────────────────────────────────────────────
// QUICK QUERY — read back from Supabase
// ─────────────────────────────────────────────
export async function query(table, { limit = 50, filter = null } = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return { error: 'Supabase not configured' };

  let url = `${SUPABASE_URL}/rest/v1/${table}?limit=${limit}&order=id.desc`;
  if (filter) url += `&${filter}`;

  const res = await globalThis.fetch(url, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Accept': 'application/json'
    },
    signal: AbortSignal.timeout(10000)
  });

  if (!res.ok) return { error: `${res.status}: ${await res.text()}` };
  return { data: await res.json() };
}

// ─────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────
function hasAnyValue(obj) {
  return Object.values(obj).some(v => v !== null && v !== '' && v !== undefined);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
