// memory.js — ZeroKrang Memory (sql.js — pure JS, no native compilation)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

const DB_PATH = process.env.MEMORY_DB_PATH || `${process.env.HOME}/.zerokrang/memory.db`;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const COMPACT_MODEL = 'gemini-1.5-flash-latest';

let db = null;
let SQL = null;

export async function init() {
  const dir = DB_PATH.substring(0, DB_PATH.lastIndexOf('/'));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const sqljs = await import('sql.js');
  SQL = await sqljs.default();

  if (existsSync(DB_PATH)) {
    db = new SQL.Database(readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  db.run(`CREATE TABLE IF NOT EXISTS episodic (
    id TEXT PRIMARY KEY, ts INTEGER, source TEXT, content TEXT,
    importance REAL DEFAULT 0.5, compacted INTEGER DEFAULT 0, tags TEXT DEFAULT '[]'
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS semantic (
    id TEXT PRIMARY KEY, category TEXT, subject TEXT, fact TEXT,
    confidence REAL DEFAULT 0.8, created INTEGER, updated INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS identity (
    key TEXT PRIMARY KEY, value TEXT, updated INTEGER, confidence REAL DEFAULT 0.9
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS knowledge (
    id TEXT PRIMARY KEY, type TEXT, title TEXT, content TEXT,
    ingested INTEGER, tags TEXT DEFAULT '[]'
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS working (
    id TEXT PRIMARY KEY, session TEXT, ts INTEGER, role TEXT, content TEXT
  )`);

  save();
  console.log('💾 Memory ready (sql.js):', DB_PATH);
  scheduleCompaction();
  return db;
}

function save() {
  if (!db) return;
  try { writeFileSync(DB_PATH, Buffer.from(db.export())); } catch(e) {}
}

function run(sql, p=[]) { if(!db) return; db.run(sql, p); save(); }

function all(sql, p=[]) {
  if (!db) return [];
  const stmt = db.prepare(sql);
  stmt.bind(p);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// ── WORKING MEMORY ──────────────────────────
const sessions = new Map();

export function workingAppend(sessionId, role, content) {
  if (!sessions.has(sessionId)) sessions.set(sessionId, []);
  sessions.get(sessionId).push({ role, content, ts: Date.now() });
}
export function workingGet(sessionId) { return sessions.get(sessionId) || []; }
export function workingClear(sessionId) { sessions.delete(sessionId); }

// ── STORE ───────────────────────────────────
export async function store(content, { source='chat', importance=0.5, tags=[] } = {}) {
  if (!db) throw new Error('Memory not init');
  const id = uid();
  run('INSERT OR REPLACE INTO episodic(id,ts,source,content,importance,tags) VALUES(?,?,?,?,?,?)',
    [id, Date.now(), source, content, importance, JSON.stringify(tags)]);
  if (source === 'explicit' || importance >= 0.85) extractFacts(content).catch(()=>{});
  console.log(`💾 [${source}] ${content.slice(0,60)}`);
  return id;
}

// ── RECALL ──────────────────────────────────
export async function recall(query, { limit=8 } = {}) {
  if (!db) return [];
  const results = [];
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);

  all('SELECT key,value FROM identity ORDER BY confidence DESC LIMIT 15')
    .forEach(r => results.push({ content: `[you] ${r.key}: ${r.value}`, score: 0.8 }));

  all('SELECT * FROM semantic LIMIT 200').forEach(r => {
    const s = kwScore(words, r.fact + ' ' + r.subject);
    if (s > 0.2) results.push({ content: `[${r.category}] ${r.subject}: ${r.fact}`, score: s * 1.2 });
  });

  const now = Date.now();
  all('SELECT * FROM episodic WHERE compacted=0 ORDER BY ts DESC LIMIT 300').forEach(r => {
    const age = (now - r.ts) / 86400000;
    const recency = Math.max(0, 1 - age/30) * 0.2;
    const s = kwScore(words, r.content) + recency;
    if (s > 0.3) results.push({ content: `[${fmtDate(r.ts)}·${r.source}] ${r.content}`, score: s * r.importance });
  });

  return results.sort((a,b) => b.score - a.score).slice(0, limit).map(r => r.content);
}

// ── CONVENIENCE ─────────────────────────────
export async function storeExplicit(content) {
  return store(content, { source: 'explicit', importance: 0.95, tags: ['explicit'] });
}
export async function storeVision(desc, importance=0.4) {
  return store(`[vision] ${desc}`, { source: 'vision', importance });
}
export async function storeDeviceEvent(event) {
  return store(event, { source: 'device', importance: 0.3 });
}
export async function logCall({ from, duration, transcript, summary }) {
  const content = [`Call with ${from} · ${Math.floor(duration/60)}m ${duration%60}s`,
    summary && `Summary: ${summary}`, transcript && `Transcript: ${transcript.slice(0,400)}`
  ].filter(Boolean).join('\n');
  await store(content, { source: 'call', importance: 0.7, tags: ['call', from] });
  if (summary) extractFacts(summary).catch(()=>{});
}
export async function flushSession(sessionId) {
  const msgs = workingGet(sessionId);
  if (msgs.length < 2) { workingClear(sessionId); return; }
  const transcript = msgs.map(m => `${m.role}: ${m.content}`).join('\n');
  await store(transcript.slice(0, 500), { source: 'chat', importance: 0.5, tags: ['session'] });
  workingClear(sessionId);
}
export async function ingestDocument({ type, title, content, tags=[] }) {
  const chunks = chunkText(content);
  for (const chunk of chunks) {
    const id = uid();
    run('INSERT OR REPLACE INTO knowledge(id,type,title,content,ingested,tags) VALUES(?,?,?,?,?,?)',
      [id, type, title, chunk, Date.now(), JSON.stringify(tags)]);
  }
  await store(`Ingested ${type}: "${title}"`, { source: 'doc', importance: 0.6 });
}

// ── IDENTITY EXTRACTION ──────────────────────
async function extractFacts(text) {
  if (!GEMINI_KEY) return;
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${COMPACT_MODEL}:generateContent?key=${GEMINI_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `Extract facts about the user (Chris) from this text. Return JSON array: [{"key":"...","value":"..."}] or []\n\nText: "${text.slice(0,800)}"` }] }],
        generationConfig: { responseMimeType: 'application/json' }
      }),
      signal: AbortSignal.timeout(10000)
    });
    const data = await res.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return;
    const facts = JSON.parse(raw.replace(/```json|```/g, '').trim());
    for (const f of facts) {
      if (f.key && f.value) {
        run('INSERT OR REPLACE INTO identity(key,value,updated,confidence) VALUES(?,?,?,?)',
          [f.key, f.value, Date.now(), 0.85]);
        console.log(`🧠 Identity: ${f.key} = ${f.value}`);
      }
    }
  } catch {}
}

// ── COMPACTION ───────────────────────────────
function scheduleCompaction() {
  const now = new Date();
  const next = new Date(); next.setHours(2,0,0,0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(() => { runCompaction(); setInterval(runCompaction, 86400000); }, next - now);
}

export async function runCompaction() {
  if (!db || !GEMINI_KEY) return;
  const cutoff = Date.now() - 7 * 86400000;
  const rows = all('SELECT * FROM episodic WHERE ts<? AND compacted=0 AND importance>=? ORDER BY ts ASC LIMIT 60',
    [cutoff, 0.4]);
  if (!rows.length) return;
  try {
    const text = rows.map(r => `[${fmtDate(r.ts)}·${r.source}] ${r.content}`).join('\n');
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${COMPACT_MODEL}:generateContent?key=${GEMINI_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `Distil these raw memories into permanent facts for Chris's AI assistant ZeroKrang on the Gold Coast.\nReturn JSON: [{"category":"person|preference|world|routine","subject":"...","fact":"...","confidence":0.0-1.0}]\n\n${text}` }] }],
        generationConfig: { responseMimeType: 'application/json' }
      }),
      signal: AbortSignal.timeout(20000)
    });
    const data = await res.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return;
    const facts = JSON.parse(raw.replace(/```json|```/g, '').trim());
    const now = Date.now();
    for (const f of facts) {
      if (!f.fact || !f.subject) continue;
      run('INSERT OR REPLACE INTO semantic(id,category,subject,fact,confidence,created,updated) VALUES(?,?,?,?,?,?,?)',
        [uid(), f.category||'world', f.subject, f.fact, f.confidence||0.75, now, now]);
    }
    const ids = rows.map(()=>'?').join(',');
    run(`UPDATE episodic SET compacted=1 WHERE id IN (${ids})`, rows.map(r=>r.id));
    console.log(`💾 Compacted ${rows.length} → ${facts.length} facts`);
  } catch(e) { console.error('Compaction error:', e.message); }
}

// ── STATS ────────────────────────────────────
export function stats() {
  if (!db) return null;
  return {
    episodic: all('SELECT COUNT(*) n FROM episodic')[0]?.n || 0,
    semantic: all('SELECT COUNT(*) n FROM semantic')[0]?.n || 0,
    knowledge: all('SELECT COUNT(*) n FROM knowledge')[0]?.n || 0,
    identity: all('SELECT COUNT(*) n FROM identity')[0]?.n || 0,
    compacted: all('SELECT COUNT(*) n FROM episodic WHERE compacted=1')[0]?.n || 0,
    dbPath: DB_PATH
  };
}
export function getIdentity() {
  if (!db) return {};
  return Object.fromEntries(all('SELECT key,value FROM identity').map(r=>[r.key,r.value]));
}
export function getRecentEpisodic(limit=20) {
  return all('SELECT ts,source,content,importance FROM episodic ORDER BY ts DESC LIMIT ?', [limit]);
}
export function getSemanticFacts() {
  return all('SELECT * FROM semantic ORDER BY updated DESC LIMIT 100');
}
export function forget(id) {
  run('DELETE FROM episodic WHERE id=?', [id]);
  run('DELETE FROM semantic WHERE id=?', [id]);
}

// ── UTILS ────────────────────────────────────
function uid() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`; }
function fmtDate(ts) { return new Date(ts).toLocaleDateString('en-AU'); }
function kwScore(words, text) {
  if (!words.length) return 0;
  const t = text.toLowerCase();
  return words.filter(w => t.includes(w)).length / words.length;
}
function chunkText(text, max=400) {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks=[]; let cur='';
  for (const s of sentences) {
    if ((cur+s).split(' ').length > max && cur) { chunks.push(cur.trim()); cur=s; }
    else cur += ' '+s;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.length ? chunks : [text];
}
