// modules/browse.js — Web browsing, extraction, Playwright control
// fetch()      — fast HTML fetch + clean text extract
// extract()    — structured data extraction (contacts, prices, tables)
// browse()     — Playwright full browser (forms, JS sites, interaction)
// screenshot() — capture page screenshot
// preview()    — stream live browser state to UI

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { writeFile, readFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';

const execAsync = promisify(exec);

// Broadcast function — set by server.js
let _broadcast = null;
export function setBroadcast(fn) { _broadcast = fn; }

function broadcast(type, data) { _broadcast?.(type, data); }

// ─────────────────────────────────────────────
// FETCH — fast clean text extraction
// No JS execution, instant, most sites work
// ─────────────────────────────────────────────
export async function fetch(url, { timeout = 15000, maxChars = 50000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await globalThis.fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13; SM-N986B) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'en-AU,en;q=0.9'
      }
    });

    if (!res.ok) return { url, error: `HTTP ${res.status}`, text: null };

    const html = await res.text();
    const text = cleanHtml(html, maxChars);
    const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() || '';
    const links = extractLinks(html, url);
    const meta = extractMeta(html);

    broadcast('browse_fetch', { url, title, chars: text.length });

    return { url, title, text, links, meta, html: html.slice(0, 100000) };
  } catch (e) {
    return { url, error: e.message, text: null };
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────
// EXTRACT — structured data from a page
// Uses Claude to parse the cleaned text
// ─────────────────────────────────────────────
export async function extract(url, schema, { useAI = true } = {}) {
  const page = await fetch(url);
  if (!page.text) return { url, error: page.error, data: null };

  broadcast('browse_extract', { url, schema });

  if (!useAI) {
    // Regex-based fallback for common patterns
    return {
      url,
      data: {
        emails:  extractEmails(page.text),
        phones:  extractPhones(page.text),
        links:   page.links?.slice(0, 20),
        title:   page.title
      }
    };
  }

  // Claude extracts structured data
  const { chatWithClaude } = await import('./ai.js');
  const prompt = `Extract the following from this webpage content.
Schema: ${JSON.stringify(schema)}
Return ONLY valid JSON matching the schema. If a field is not found, use null.

Page: ${page.url}
Content:
${page.text.slice(0, 8000)}`;

  try {
    const raw = await chatWithClaude([{ role: 'user', content: prompt }], null,
      'You are a precise data extraction assistant. Return only valid JSON, no markdown.');
    const clean = raw.replace(/```json|```/g, '').trim();
    return { url, title: page.title, data: JSON.parse(clean) };
  } catch (e) {
    // Fallback to regex
    return {
      url, title: page.title,
      data: { emails: extractEmails(page.text), phones: extractPhones(page.text) }
    };
  }
}

// ─────────────────────────────────────────────
// BROWSE — Playwright full browser
// Handles JS sites, forms, clicks, navigation
// Streams actions to UI via WebSocket
// ─────────────────────────────────────────────
export async function browse(instructions, { startUrl = null, timeout = 60000 } = {}) {
  // Check Playwright is available
  const hasPw = await checkPlaywright();
  if (!hasPw) {
    console.warn('Playwright not installed — using fetch fallback');
    if (startUrl) {
      const page = await fetch(startUrl);
      return { success: true, result: page.text?.slice(0, 5000), screenshots: [] };
    }
    return { success: false, error: 'Playwright not available. Install with: npm install playwright && npx playwright install chromium' };
  }

  broadcast('browse_start', { instructions, startUrl });

  // Write a Playwright script via Claude then execute it
  const script = await generatePlaywrightScript(instructions, startUrl);
  const scriptPath = `/tmp/zk_browse_${Date.now()}.js`;
  const resultPath = `/tmp/zk_result_${Date.now()}.json`;

  await writeFile(scriptPath, script);

  return new Promise((resolve) => {
    const proc = spawn('node', [scriptPath, resultPath], { timeout });
    let output = '';

    proc.stdout.on('data', d => {
      output += d.toString();
      // Stream action updates to UI
      const lines = output.split('\n');
      for (const line of lines) {
        if (line.startsWith('ACTION:')) {
          broadcast('browse_action', { action: line.slice(7).trim() });
        }
        if (line.startsWith('URL:')) {
          broadcast('browse_url', { url: line.slice(4).trim() });
        }
        if (line.startsWith('SCREENSHOT:')) {
          broadcast('browse_screenshot', { path: line.slice(11).trim() });
        }
      }
    });

    proc.stderr.on('data', d => {
      broadcast('browse_error', { error: d.toString() });
    });

    proc.on('close', async () => {
      try {
        const result = JSON.parse(await readFile(resultPath, 'utf8'));
        broadcast('browse_done', { result });
        resolve({ success: true, ...result });
      } catch {
        resolve({ success: false, error: 'Script produced no output', rawOutput: output });
      } finally {
        unlink(scriptPath).catch(() => {});
        unlink(resultPath).catch(() => {});
      }
    });
  });
}

// ─────────────────────────────────────────────
// SCREENSHOT — capture any URL
// ─────────────────────────────────────────────
export async function screenshot(url, { fullPage = false } = {}) {
  const hasPw = await checkPlaywright();
  if (!hasPw) return { error: 'Playwright not available' };

  const outPath = `/tmp/zk_screenshot_${Date.now()}.png`;
  const script = `
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(${JSON.stringify(url)}, { waitUntil: 'networkidle', timeout: 30000 });
  await page.screenshot({ path: ${JSON.stringify(outPath)}, fullPage: ${fullPage} });
  await browser.close();
  console.log('DONE');
})();`;

  const tmpScript = `/tmp/zk_ss_${Date.now()}.js`;
  await writeFile(tmpScript, script);

  try {
    await execAsync(`node ${tmpScript}`, { timeout: 35000 });
    const data = await readFile(outPath);
    const base64 = data.toString('base64');
    broadcast('browse_screenshot', { url, base64 });
    return { url, base64, path: outPath };
  } catch (e) {
    return { url, error: e.message };
  } finally {
    unlink(tmpScript).catch(() => {});
  }
}

// ─────────────────────────────────────────────
// GENERATE PLAYWRIGHT SCRIPT via Claude
// ─────────────────────────────────────────────
async function generatePlaywrightScript(instructions, startUrl) {
  const { chatWithClaude } = await import('./ai.js');

  const prompt = `Write a complete Node.js Playwright script that:
${instructions}
${startUrl ? `Starting URL: ${startUrl}` : ''}

Requirements:
- Use require('playwright') not import
- headless: true
- Log each action with console.log('ACTION: <description>')
- Log URL changes with console.log('URL: <url>')
- Log screenshots with console.log('SCREENSHOT: <path>')
- Write final results to process.argv[2] as JSON: { result, data, urls_visited, screenshots }
- Handle errors gracefully
- Timeout each page load at 30000ms
- Extract any requested data and include in result

Return ONLY the complete Node.js script, no markdown.`;

  const script = await chatWithClaude(
    [{ role: 'user', content: prompt }],
    null,
    'You write precise Playwright automation scripts. Return only the script, no explanation.'
  );

  return script.replace(/```javascript|```js|```/g, '').trim();
}

// ─────────────────────────────────────────────
// FOLLOW LINKS — autonomous multi-page crawl
// ─────────────────────────────────────────────
export async function followLinks(startUrl, {
  goal,
  maxPages = 5,
  sameDomain = true,
  broadcast: broadcastFn = null
} = {}) {
  const visited = new Set();
  const queue = [startUrl];
  const pages = [];
  const { chatWithClaude } = await import('./ai.js');

  while (queue.length && pages.length < maxPages) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    broadcast('browse_crawl', { url, visited: visited.size, goal });
    const page = await fetch(url);
    if (!page.text) continue;

    pages.push({ url, title: page.title, text: page.text.slice(0, 2000) });

    // Ask Claude which links to follow
    if (page.links?.length && pages.length < maxPages) {
      const linkList = page.links.slice(0, 30).map(l => `${l.text}: ${l.url}`).join('\n');
      const decision = await chatWithClaude([{
        role: 'user',
        content: `Goal: "${goal}"\nCurrent page: ${url}\n\nAvailable links:\n${linkList}\n\nWhich links (0-3) should I follow to achieve the goal? Return JSON: {"follow": ["url1","url2"],"reason":"..."}`
      }], null, 'Return only JSON. Be selective — only follow links directly relevant to the goal.');

      try {
        const { follow } = JSON.parse(decision.replace(/```json|```/g, '').trim());
        for (const link of (follow || [])) {
          if (sameDomain && !link.includes(new URL(startUrl).hostname)) continue;
          if (!visited.has(link)) queue.push(link);
        }
      } catch {}
    }
  }

  return { pages, visited: [...visited] };
}

// ─────────────────────────────────────────────
// HTML CLEANING
// ─────────────────────────────────────────────
function cleanHtml(html, maxChars) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s{3,}/g, '\n\n')
    .trim()
    .slice(0, maxChars);
}

function extractLinks(html, baseUrl) {
  const links = [];
  const base = (() => { try { return new URL(baseUrl); } catch { return null; } })();
  const re = /<a[^>]+href=["']([^"']+)["'][^>]*>([^<]*)</gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const url = new URL(m[1], baseUrl).href;
      const text = m[2].trim().replace(/\s+/g, ' ');
      if (text && url.startsWith('http')) links.push({ url, text: text.slice(0, 100) });
    } catch {}
  }
  return [...new Map(links.map(l => [l.url, l])).values()].slice(0, 100);
}

function extractMeta(html) {
  const desc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1];
  const og = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)?.[1];
  return { description: desc || og || '' };
}

function extractEmails(text) {
  return [...new Set((text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || []))];
}

function extractPhones(text) {
  return [...new Set((text.match(/(\+61|0)[2-9]\d{8}|(\+61|0)4\d{8}|\b\d{2}[\s-]\d{4}[\s-]\d{4}\b/g) || []))];
}

async function checkPlaywright() {
  try {
    await execAsync('node -e "require(\'playwright\')"', { timeout: 3000 });
    return true;
  } catch { return false; }
}
