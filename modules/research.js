// modules/research.js — Autonomous Research Agent
// Orchestrates: search → browse → extract → summarise → store → learn skill
// Triggered by: explicit request, knowledge gap, post-call, scheduled

import * as Search from './search.js';
import * as Browse from './browse.js';
import * as Memory from './memory.js';
import * as Skills from './skills.js';

// ─────────────────────────────────────────────
// MAIN RESEARCH FUNCTION
// ─────────────────────────────────────────────
export async function research(topic, {
  depth = 'standard',    // 'quick' | 'standard' | 'deep'
  broadcast = null,
  sessionId = null,
  trigger = 'explicit'   // 'explicit' | 'gap' | 'post-call' | 'scheduled'
} = {}) {
  const emit = (type, data) => broadcast?.(type, { ...data, topic });
  const log = (msg) => { console.log(`🔬 [research] ${msg}`); emit('research_log', { msg }); };

  log(`Starting ${depth} research: "${topic}" (trigger: ${trigger})`);
  emit('research_start', { topic, depth });

  // Check if we have a relevant skill to guide this research
  const matchedSkills = await Skills.match(topic);
  const skillInstructions = matchedSkills.length
    ? `\n\nApply these skill instructions:\n${matchedSkills.map(s => s.name).join(', ')}`
    : '';

  // Check memory first — what do we already know?
  log('Checking memory...');
  const existingMemory = await Memory.recall(topic, { limit: 5 });
  if (existingMemory.length) {
    log(`Found ${existingMemory.length} existing memories`);
    emit('research_memory', { memories: existingMemory });
  }

  const result = {
    topic,
    trigger,
    timestamp: new Date().toISOString(),
    searchResults: [],
    pages: [],
    contacts: [],
    facts: [],
    summary: '',
    skillLearned: null,
    memoryIds: []
  };

  try {
    // ── PHASE 1: SEARCH ──────────────────────────
    log('Phase 1: Searching...');

    // Generate smart search queries
    const queries = await generateQueries(topic, trigger, existingMemory);
    log(`Generated ${queries.length} queries: ${queries.join(' | ')}`);

    for (const query of queries) {
      emit('research_query', { query });
      try {
        const results = await Search.search(query, { limit: 6, country: 'AU' });
        result.searchResults.push(...results);
        log(`"${query}" → ${results.length} results`);
      } catch (e) {
        log(`Search error: ${e.message}`);
      }
    }

    // Deduplicate
    const urlsSeen = new Set();
    result.searchResults = result.searchResults.filter(r => {
      if (!r.url || urlsSeen.has(r.url)) return false;
      urlsSeen.add(r.url); return true;
    });

    emit('research_search_done', { count: result.searchResults.length });

    // ── PHASE 2: BROWSE ──────────────────────────
    const browseLimit = depth === 'quick' ? 2 : depth === 'deep' ? 6 : 3;
    const toRead = result.searchResults
      .filter(r => r.url && !r.featured)
      .slice(0, browseLimit);

    log(`Phase 2: Reading ${toRead.length} pages...`);

    for (const r of toRead) {
      emit('research_browse', { url: r.url, title: r.title });
      log(`Fetching: ${r.url}`);
      const page = await Browse.fetch(r.url, { maxChars: 8000 });
      if (page.text) {
        result.pages.push({
          url: r.url,
          title: page.title || r.title,
          text: page.text,
          links: page.links
        });

        // Extract contacts from every page
        const emails = page.text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
        const phones = page.text.match(/(\+61|0)[2-9]\d{8}|(\+61|0)4\d{8}/g) || [];
        if (emails.length || phones.length) {
          result.contacts.push({ url: r.url, emails, phones });
          log(`Found contacts at ${r.url}: ${emails.length} emails, ${phones.length} phones`);
        }
      }
    }

    // If deep — follow relevant links
    if (depth === 'deep' && result.pages.length > 0) {
      log('Phase 2b: Following links...');
      const { pages: deepPages } = await Browse.followLinks(result.pages[0].url, {
        goal: topic,
        maxPages: 3,
        sameDomain: true
      });
      result.pages.push(...deepPages);
    }

    // ── PHASE 3: SYNTHESISE ──────────────────────
    log('Phase 3: Synthesising...');
    emit('research_synthesise', {});

    const { chatWithClaude } = await import('./ai.js');

    const pageContent = result.pages
      .map(p => `URL: ${p.url}\nTitle: ${p.title}\n${p.text.slice(0, 2000)}`)
      .join('\n\n---\n\n');

    const existingKnowledge = existingMemory.length
      ? `\n\nExisting knowledge:\n${existingMemory.join('\n')}`
      : '';

    const synthesis = await chatWithClaude([{
      role: 'user',
      content: `Research topic: "${topic}"
Trigger: ${trigger}
${skillInstructions}
${existingKnowledge}

Search results summary:
${result.searchResults.slice(0, 5).map(r => `- ${r.title}: ${r.snippet}`).join('\n')}

Page content:
${pageContent.slice(0, 10000)}

Contacts found:
${JSON.stringify(result.contacts).slice(0, 1000)}

Provide:
1. SUMMARY: 3-5 sentence summary of findings
2. KEY_FACTS: bullet list of most important facts
3. CONTACTS: any important contacts found
4. ACTION_ITEMS: what should Chris know or do based on this
5. GAPS: what I couldn't find / should research further

Format as JSON: {summary, key_facts, contacts, action_items, gaps}`
    }], null, `You are ZeroKrang's research assistant for Chris on the Gold Coast.
Be direct, practical, focused on what matters to Chris (Touch Up Guys, Agentic GC, Gold Coast market).
Return only valid JSON.`);

    try {
      const parsed = JSON.parse(synthesis.replace(/```json|```/g, '').trim());
      result.summary = parsed.summary || '';
      result.facts = parsed.key_facts || [];
      result.actionItems = parsed.action_items || [];
      result.gaps = parsed.gaps || [];
      if (parsed.contacts?.length) {
        result.contacts.push(...parsed.contacts);
      }
    } catch {
      result.summary = synthesis.slice(0, 500);
    }

    // ── PHASE 4: STORE TO MEMORY ─────────────────
    log('Phase 4: Storing to memory...');

    const memContent = `Research: ${topic}\n\nSummary: ${result.summary}\n\nKey facts:\n${result.facts.join('\n')}\n\nSources: ${result.pages.map(p => p.url).join(', ')}`;
    const memId = await Memory.store(memContent, {
      source: 'research',
      importance: 0.75,
      tags: ['research', topic.toLowerCase().replace(/\s+/g, '-')]
    });
    result.memoryIds.push(memId);

    // Store contacts
    for (const c of result.contacts) {
      if (c.emails?.length || c.phones?.length) {
        await Memory.store(
          `Contact found via research "${topic}": ${JSON.stringify(c)}`,
          { source: 'research', importance: 0.8, tags: ['contact', 'research'] }
        );
      }
    }

    // ── PHASE 5: AUTO-LEARN SKILL ────────────────
    if (depth !== 'quick' && result.pages.length >= 2) {
      log('Phase 5: Learning skill...');
      const skill = await Skills.autoLearnFromResearch(topic, {
        summary: result.summary,
        queries,
        sourcesUsed: result.pages.map(p => p.url),
        contactsFound: result.contacts.length
      });
      if (skill) {
        result.skillLearned = skill.name;
        log(`Learned skill: ${skill.name}`);
      }
    }

    emit('research_done', { result });
    log(`Research complete. ${result.pages.length} pages, ${result.contacts.length} contact sources, ${result.facts.length} facts`);

  } catch (e) {
    log(`Research error: ${e.message}`);
    result.error = e.message;
  }

  return result;
}

// ─────────────────────────────────────────────
// POST-CALL RESEARCH
// Auto-triggered after every call ends
// ─────────────────────────────────────────────
export async function researchCaller({ from, summary, broadcast }) {
  const topic = `Phone number ${from} Australia business lookup`;
  return research(topic, {
    depth: 'quick',
    broadcast,
    trigger: 'post-call'
  });
}

// ─────────────────────────────────────────────
// GENERATE SMART QUERIES
// ─────────────────────────────────────────────
async function generateQueries(topic, trigger, existingMemory) {
  const { chatWithClaude } = await import('./ai.js');

  const context = trigger === 'post-call'
    ? 'This is a post-call research task. Focus on identifying the person/business, their relevance to Touch Up Guys franchise or Agentic GC, and any contact information.'
    : 'Generate searches that will find the most useful, current information.';

  try {
    const raw = await chatWithClaude([{
      role: 'user',
      content: `Generate 2-4 search queries for: "${topic}"
${context}
Bias toward Australian results.
Return JSON array of strings only: ["query1", "query2", ...]`
    }], null, 'Return only a JSON array of search query strings.');

    const queries = JSON.parse(raw.replace(/```json|```/g, '').trim());
    return Array.isArray(queries) ? queries.slice(0, 4) : [topic];
  } catch {
    return [topic, `${topic} Australia`, `${topic} site:au`];
  }
}

// ─────────────────────────────────────────────
// KNOWLEDGE GAP DETECTION
// Call this mid-conversation to check if research is needed
// ─────────────────────────────────────────────
export async function detectGap(message, existingContext) {
  const { chatWithClaude } = await import('./ai.js');

  try {
    const raw = await chatWithClaude([{
      role: 'user',
      content: `Does answering this message require information I likely don't have?
Message: "${message}"
Existing context: ${existingContext?.slice(0, 500) || 'none'}

Return JSON: {"needs_research": true/false, "topic": "what to research if yes", "reason": "brief reason"}`
    }], null, 'Return only JSON. Be conservative — only flag genuine knowledge gaps.');

    const result = JSON.parse(raw.replace(/```json|```/g, '').trim());
    return result;
  } catch {
    return { needs_research: false };
  }
}
