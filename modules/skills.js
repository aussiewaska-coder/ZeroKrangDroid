// modules/skills.js — ZeroKrang Skill System
// Skills are reusable behaviours with instructions + tools + triggers
// Two types: seeded (you write) + learned (agent writes autonomously)

import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, '..', 'skills');
const INDEX_PATH = join(SKILLS_DIR, 'index.json');

// ─────────────────────────────────────────────
// INIT — ensure skill directories exist
// ─────────────────────────────────────────────
export async function init() {
  await mkdir(join(SKILLS_DIR, 'core'), { recursive: true });
  await mkdir(join(SKILLS_DIR, 'learned'), { recursive: true });

  // Write core skills if not present
  for (const [name, skill] of Object.entries(CORE_SKILLS)) {
    const path = join(SKILLS_DIR, 'core', `${name}.skill.json`);
    if (!existsSync(path)) {
      await writeFile(path, JSON.stringify(skill, null, 2));
    }
  }

  await rebuildIndex();
  console.log('🛠  Skills system ready:', await list().then(s => `${s.length} skills`));
}

// ─────────────────────────────────────────────
// LIST all skills
// ─────────────────────────────────────────────
export async function list() {
  try {
    const index = JSON.parse(await readFile(INDEX_PATH, 'utf8'));
    return index.skills || [];
  } catch { return []; }
}

// ─────────────────────────────────────────────
// GET a skill by name
// ─────────────────────────────────────────────
export async function get(name) {
  const skills = await list();
  const meta = skills.find(s => s.name === name);
  if (!meta) return null;
  try {
    return JSON.parse(await readFile(meta.path, 'utf8'));
  } catch { return null; }
}

// ─────────────────────────────────────────────
// MATCH — find skills relevant to a message
// ─────────────────────────────────────────────
export async function match(text) {
  const skills = await list();
  const lower = text.toLowerCase();
  return skills.filter(s =>
    s.triggers?.some(t => lower.includes(t.toLowerCase()))
  );
}

// ─────────────────────────────────────────────
// RUN — inject a skill's instructions into context
// Returns the skill's instructions + tool hints
// ─────────────────────────────────────────────
export async function run(name) {
  const skill = await get(name);
  if (!skill) return null;

  console.log(`🛠  Running skill: ${name}`);

  return {
    name: skill.name,
    instructions: skill.instructions,
    tools: skill.tools || [],
    context: skill.context || null
  };
}

// ─────────────────────────────────────────────
// LEARN — agent writes a new skill from experience
// Called after a successful research or task
// ─────────────────────────────────────────────
export async function learn({
  name,
  description,
  triggers,
  instructions,
  tools,
  learnedFrom = [],
  createdBy = 'zerokrang'
}) {
  const skill = {
    name,
    description,
    triggers,
    instructions,
    tools: tools || [],
    learned_from: learnedFrom,
    created: new Date().toISOString(),
    created_by: createdBy,
    version: 1
  };

  const safeName = name.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const path = join(SKILLS_DIR, 'learned', `${safeName}.skill.json`);
  await writeFile(path, JSON.stringify(skill, null, 2));
  await rebuildIndex();

  console.log(`🛠  Learned new skill: ${name}`);
  return skill;
}

// ─────────────────────────────────────────────
// AUTO-LEARN from a completed research task
// Claude distils the research into a reusable skill
// ─────────────────────────────────────────────
export async function autoLearnFromResearch(topic, researchResult) {
  const { chatWithClaude } = await import('./ai.js');

  const prompt = `You just completed research on: "${topic}"

Research result:
${JSON.stringify(researchResult).slice(0, 3000)}

Create a reusable skill for future use. Return ONLY valid JSON:
{
  "name": "kebab-case-name",
  "description": "one sentence",
  "triggers": ["keyword1", "keyword2", "keyword3"],
  "instructions": "Step-by-step instructions for how to do this research/task effectively in future. Be specific about search queries, websites to check, data to extract.",
  "tools": ["brave_search", "web_fetch", "memory_recall"],
  "should_save": true/false
}

Only set should_save=true if this is genuinely reusable for future tasks.`;

  try {
    const raw = await chatWithClaude([{ role: 'user', content: prompt }], null,
      'Create practical, reusable skill definitions. Return only JSON.');
    const skill = JSON.parse(raw.replace(/```json|```/g, '').trim());

    if (skill.should_save) {
      await learn({
        ...skill,
        learnedFrom: [topic],
        createdBy: 'zerokrang'
      });
      return skill;
    }
  } catch (e) {
    console.error('Auto-learn failed:', e.message);
  }
  return null;
}

// ─────────────────────────────────────────────
// DELETE a skill
// ─────────────────────────────────────────────
export async function remove(name) {
  const skills = await list();
  const meta = skills.find(s => s.name === name);
  if (!meta || meta.type === 'core') throw new Error('Cannot delete core skills');
  const { unlink } = await import('fs/promises');
  await unlink(meta.path);
  await rebuildIndex();
}

// ─────────────────────────────────────────────
// REBUILD INDEX
// ─────────────────────────────────────────────
async function rebuildIndex() {
  const skills = [];

  for (const subdir of ['core', 'learned']) {
    const dir = join(SKILLS_DIR, subdir);
    if (!existsSync(dir)) continue;
    const files = (await readdir(dir)).filter(f => f.endsWith('.skill.json'));
    for (const file of files) {
      try {
        const path = join(dir, file);
        const skill = JSON.parse(await readFile(path, 'utf8'));
        skills.push({
          name: skill.name,
          description: skill.description,
          triggers: skill.triggers || [],
          type: subdir,
          path,
          created: skill.created
        });
      } catch {}
    }
  }

  await writeFile(INDEX_PATH, JSON.stringify({ skills, updated: new Date().toISOString() }, null, 2));
  return skills;
}

// ─────────────────────────────────────────────
// CORE SKILLS — seeded at init
// ─────────────────────────────────────────────
const CORE_SKILLS = {
  'web-research': {
    name: 'web-research',
    description: 'Deep research on any topic using search + browse + summarise',
    triggers: ['research', 'find out about', 'look up', 'investigate', 'learn about'],
    instructions: `When asked to research a topic:
1. Start with a Brave search to get an overview (3-5 results)
2. Identify the 2-3 most authoritative sources
3. Fetch and read each source fully
4. If you find contact info (email, phone) — extract and store it
5. Look for links to go deeper if the topic warrants it
6. Synthesise findings into a concise summary
7. Store key facts in memory with appropriate tags
8. Return: summary, key facts, sources, contacts found`,
    tools: ['brave_search', 'web_fetch', 'web_extract', 'memory_store'],
    created: new Date().toISOString(),
    created_by: 'system'
  },

  'caller-research': {
    name: 'caller-research',
    description: 'Research a phone number or person after a call',
    triggers: ['who called', 'research caller', 'look up number'],
    instructions: `After a call ends, to research the caller:
1. Search for the phone number: "{number} Australia"
2. Search for the person/business name if known
3. Check LinkedIn, ABN lookup (abr.business.gov.au), Yellow Pages
4. Extract: business name, address, website, key people, what they do
5. Check if they're relevant to Touch Up Guys (automotive, franchise, property)
6. Store findings in memory tagged as 'contact' with the phone number
7. If relevant to TUG — flag as a potential lead`,
    tools: ['brave_search', 'serp_search', 'web_fetch', 'web_extract', 'memory_store'],
    created: new Date().toISOString(),
    created_by: 'system'
  },

  'contact-extraction': {
    name: 'contact-extraction',
    description: 'Extract contacts from any website',
    triggers: ['find contacts', 'extract emails', 'find phone numbers', 'get contact details'],
    instructions: `To extract contacts from a website:
1. Fetch the homepage
2. Look for /contact, /about, /team, /staff pages in the links
3. Fetch each of those pages
4. Extract all emails, phone numbers, names, and roles
5. For AU numbers, look for 02/03/04/07/08 prefix or +61
6. For emails, look for @domain patterns
7. Store contacts in memory tagged as 'contact'
8. Return structured: [{name, role, email, phone, company}]`,
    tools: ['web_fetch', 'web_extract', 'memory_store'],
    created: new Date().toISOString(),
    created_by: 'system'
  },

  'tug-lead-research': {
    name: 'tug-lead-research',
    description: 'Research potential Touch Up Guys franchise leads',
    triggers: ['tug lead', 'franchise lead', 'touch up guys', 'automotive repair lead'],
    instructions: `To research a potential TUG franchise lead:
1. Search for their name + "Australia" to get background
2. Check LinkedIn for professional history
3. Look for automotive or trade experience
4. Check if they own a business (ABN lookup)
5. Look for their suburb to check territory availability
6. Assess: do they have capital? trade background? local presence?
7. Store assessment in memory tagged: ['lead', 'tug', their suburb]
8. Rate lead quality: hot / warm / cold`,
    tools: ['brave_search', 'web_fetch', 'web_extract', 'memory_store'],
    created: new Date().toISOString(),
    created_by: 'system'
  },

  'gold-coast-intelligence': {
    name: 'gold-coast-intelligence',
    description: 'Research Gold Coast local business, property, and events',
    triggers: ['gold coast', 'GC', 'robina', 'surfers', 'broadbeach', 'southport', 'coolangatta'],
    instructions: `For Gold Coast local intelligence:
1. Check GC Bulletin for local news
2. Check realestate.com.au for property trends if relevant
3. Check local council (goldcoast.qld.gov.au) for permits/development
4. For business leads: check local Facebook groups, LinkedIn
5. Weather: bom.gov.au for Gold Coast forecast
6. Events: visitgoldcoast.com
Store relevant findings in memory tagged: ['gold-coast', topic]`,
    tools: ['brave_search', 'web_fetch', 'memory_store'],
    created: new Date().toISOString(),
    created_by: 'system'
  }
};
