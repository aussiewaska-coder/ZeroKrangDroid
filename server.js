// ZeroKrang — Personal AI Agent Server v3.1
// Fully wired: chat + calls + ADB + ZeroClaw + memory + search + browse + collector + skills + research

import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { execSync } from 'child_process';

// Core
import * as AI       from './modules/ai.js';
import * as Calls    from './modules/calls.js';
import * as ADB      from './modules/adb.js';
import * as ZeroClaw from './modules/zeroclaw.js';
import * as Memory   from './modules/memory.js';
import * as Brain    from './modules/brain.js';
import { startTunnel, getPublicUrl } from './modules/tunnel.js';

// Web intelligence
import * as Search    from './modules/search.js';
import * as Browse    from './modules/browse.js';
import * as Collector from './modules/collector.js';
import * as Skills    from './modules/skills.js';
import * as Research  from './modules/research.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3001');

const app = express();
const httpServer = createServer(app);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ABSOLUTE CACHE ANNIHILATION — nothing survives
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
  res.set('Vary', '*');
  res.set('X-ZK-Build', Date.now().toString());
  next();
});

// Force-refresh route — busts Chrome's aggressive cache
app.get('/fresh', (req, res) => res.redirect(`/?v=${Date.now()}`));

app.use(express.static(join(__dirname, 'public'), { etag: false, lastModified: false, maxAge: 0, immutable: false }));

// ─────────────────────────────────────────────────
// WEBSOCKET — UI clients
// ─────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
const uiClients = new Set();

wss.on('connection', (ws) => {
  uiClients.add(ws);
  ws.send(J('connected', { msg: 'ZeroKrang online' }));
  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    await handle(ws, msg);
  });
  ws.on('close', () => uiClients.delete(ws));
  ws.on('error', () => uiClients.delete(ws));
  sendState(ws);
});

// Twilio Media Streams
const callWss = new WebSocketServer({ server: httpServer, path: '/calls/stream' });
callWss.on('connection', (ws) => Calls.handleMediaStream(ws, broadcast));

// Give browse module access to broadcast
Browse.setBroadcast(broadcast);

// ─────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────
const J = (type, data = {}) => JSON.stringify({ type, ...data });

function broadcast(type, data = {}) {
  const p = J(type, data);
  for (const c of uiClients) if (c.readyState === WebSocket.OPEN) c.send(p);
}

// ─────────────────────────────────────────────────
// SESSION MANAGEMENT
// ─────────────────────────────────────────────────
const sessions = new Map(); // wsId → { history, sessionId }
let wsCounter = 0;

function getSession(ws) {
  if (!ws._zkId) ws._zkId = ++wsCounter;
  if (!sessions.has(ws._zkId)) {
    sessions.set(ws._zkId, {
      history: [],
      sessionId: `session_${Date.now()}_${ws._zkId}`
    });
  }
  return sessions.get(ws._zkId);
}

function reply(ws, type, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(J(type, data));
}

// ─────────────────────────────────────────────────
// MAIN MESSAGE HANDLER
// ─────────────────────────────────────────────────
async function handle(ws, msg) {
  const r = (type, data) => reply(ws, type, data);
  const session = getSession(ws);

  switch (msg.type) {

    // ══ CHAT ════════════════════════════════════
    case 'chat': {
      const { text, image, useClaude = true } = msg;
      if (!text && !image) return;

      // Append to working memory
      Memory.workingAppend(session.sessionId, 'user', text || '(image)');
      session.history.push({ role: 'user', content: text || '(image attached)' });
      r('chat_thinking', {});

      try {
        // Recall relevant memories for context
        const memories = await Memory.recall(text, { limit: 6 });

        // Detect if research is needed
        const gap = await Research.detectGap(text, memories.join('\n'));
        if (gap.needs_research) {
          r('chat_tool', { name: 'research', input: gap.topic, status: 'running' });
          const resResult = await Research.research(gap.topic, {
            depth: 'quick',
            broadcast,
            sessionId: session.sessionId
          });
          r('chat_tool', { name: 'research', input: gap.topic, status: 'done', result: `${resResult.pages?.length || 0} pages` });
        }

        let full = '';

        if (useClaude) {
          // Build system prompt with memory + mode
          const systemPrompt = await Brain.buildSystemPrompt(Brain.MODES.CHAT, {
            recentMemory: memories
          });

          // Check for matching skills
          const matchedSkills = await Skills.match(text);
          if (matchedSkills.length) {
            const skill = await Skills.run(matchedSkills[0].name);
            if (skill) r('chat_tool', { name: 'skill:'+skill.name, input: '', status: 'active' });
          }

          await AI.chatWithClaude(session.history, (chunk) => {
            full += chunk;
            r('chat_chunk', { chunk });
          }, systemPrompt);

        } else {
          // ZeroClaw bridge
          await ZeroClaw.send(text, (chunk) => {
            full += chunk;
            r('chat_chunk', { chunk });
          });
        }

        session.history.push({ role: 'assistant', content: full });
        Memory.workingAppend(session.sessionId, 'assistant', full);
        r('chat_done', { text: full });

        // Auto-detect explicit memory requests
        if (/remember this|save this|note that/i.test(text)) {
          await Memory.storeExplicit(text.replace(/remember this[:\s]*/i, '').trim());
          r('chat_tool', { name: 'memory_store', input: 'explicit', status: 'done', result: 'stored' });
        }

      } catch (e) {
        r('chat_error', { error: e.message });
      }
      break;
    }

    case 'chat_clear': {
      const session = getSession(ws);
      await Memory.flushSession(session.sessionId).catch(() => {});
      session.history.length = 0;
      r('chat_cleared', {});
      break;
    }

    // ══ CALLS ════════════════════════════════════
    case 'call_make': {
      const url = getPublicUrl();
      if (!url) return r('error', { error: 'Tunnel not running — start ngrok first' });
      try {
        const sid = await Calls.makeCall(msg.to, url);
        r('call_initiated', { callSid: sid, to: msg.to });
      } catch (e) { r('error', { error: e.message }); }
      break;
    }

    case 'call_hangup':
      if (msg.callSid) await Calls.hangUp(msg.callSid);
      break;

    case 'calls_list':
      r('calls_active', { calls: Calls.getActiveCalls() });
      break;

    // ══ ADB ══════════════════════════════════════
    case 'adb_shell': {
      if (!msg.command) return;
      const result = await ADB.shell(msg.command);
      r('adb_result', { command: msg.command, ...result });
      break;
    }

    case 'adb_device_info': {
      try { r('adb_device_info', { info: await ADB.getDeviceInfo() }); }
      catch (e) { r('error', { error: e.message }); }
      break;
    }

    case 'adb_key':    await ADB.keyEvent(msg.keycode);          r('adb_ok', { action: 'key', keycode: msg.keycode }); break;
    case 'adb_tap':    await ADB.tap(msg.x, msg.y);              r('adb_ok', { action: 'tap' }); break;
    case 'adb_swipe':  await ADB.swipe(msg.x1, msg.y1, msg.x2, msg.y2); r('adb_ok', { action: 'swipe' }); break;
    case 'adb_launch': await ADB.launchApp(msg.pkg, msg.activity); r('adb_ok', { action: 'launch' }); break;

    case 'adb_screenshot': {
      const path = await ADB.screenshot();
      if (path && existsSync(path)) {
        const buf = await readFile(path);
        r('adb_screenshot', { data: buf.toString('base64') });
      } else r('error', { error: 'Screenshot failed' });
      break;
    }

    case 'adb_list_apps': {
      const apps = await ADB.listApps(msg.thirdParty ?? true);
      r('adb_apps', { apps });
      break;
    }

    // ══ ZEROCLAW ════════════════════════════════
    case 'zc_pair': {
      try { r('zc_paired', { token: await ZeroClaw.pair(msg.code) }); }
      catch (e) { r('error', { error: e.message }); }
      break;
    }
    case 'zc_status':    r('zc_status', await ZeroClaw.status()); break;
    case 'zc_set_token': ZeroClaw.setToken(msg.token); r('zc_token_set', {}); break;
    case 'zc_send': {
      try {
        let full = '';
        await ZeroClaw.send(msg.message, chunk => { full += chunk; r('zc_chunk', { chunk }); });
        r('zc_done', { text: full });
      } catch (e) { r('error', { error: e.message }); }
      break;
    }

    // ══ MEMORY ══════════════════════════════════
    case 'memory_recall': {
      const results = await Memory.recall(msg.query, { limit: msg.limit || 8 });
      r('memory_results', { results });
      break;
    }
    case 'memory_store': {
      const id = await Memory.store(msg.content, {
        source: msg.source || 'explicit',
        importance: msg.importance || 0.8,
        tags: msg.tags || []
      });
      r('memory_stored', { id });
      break;
    }
    case 'memory_stats':
      r('memory_stats', { stats: Memory.stats() });
      break;
    case 'memory_identity':
      r('memory_identity', { identity: Memory.getIdentity() });
      break;
    case 'memory_recent':
      r('memory_recent', { memories: Memory.getRecentEpisodic(msg.limit || 20) });
      break;
    case 'memory_compact':
      Memory.runCompaction().catch(console.error);
      r('memory_compacting', {});
      break;

    // ══ SEARCH ══════════════════════════════════
    case 'web_search': {
      r('search_start', { query: msg.query, provider: msg.provider || 'auto' });
      try {
        const results = await Search.search(msg.query, {
          provider: msg.provider || 'auto',
          limit: msg.limit || 8,
          country: 'AU',
          freshness: msg.freshness
        });
        r('search_results', { query: msg.query, results, provider: msg.provider || 'auto' });

        // Store search in memory if important
        if (msg.remember !== false && results.length) {
          await Memory.store(
            `Web search: "${msg.query}" → ${results.slice(0,3).map(r=>r.title).join(', ')}`,
            { source: 'chat', importance: 0.4, tags: ['search'] }
          );
        }
      } catch (e) { r('search_error', { error: e.message }); }
      break;
    }

    case 'perplexity_ask': {
      r('search_start', { query: msg.query, provider: 'perplexity' });
      try {
        const results = await Search.perplexityAsk(msg.query);
        r('search_results', { query: msg.query, results, provider: 'perplexity' });
      } catch (e) { r('search_error', { error: e.message }); }
      break;
    }

    // ══ BROWSE ══════════════════════════════════
    case 'web_fetch': {
      r('browse_fetching', { url: msg.url });
      try {
        const page = await Browse.fetch(msg.url, { maxChars: msg.maxChars || 20000 });
        r('browse_page', {
          url: msg.url,
          title: page.title,
          text: page.text,
          links: page.links?.slice(0, 50),
          emails: page.text ? page.text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [] : [],
          phones: page.text ? page.text.match(/(\+61|0)[2-9]\d{8}|(\+61|0)4\d{8}/g) || [] : [],
          error: page.error
        });
      } catch (e) { r('browse_error', { url: msg.url, error: e.message }); }
      break;
    }

    case 'web_extract': {
      r('extract_start', { url: msg.url });
      try {
        const result = await Browse.extract(msg.url, msg.schema || {
          name: 'Name or title',
          email: 'Email address',
          phone: 'Phone number'
        });
        r('extract_done', result);
      } catch (e) { r('extract_error', { error: e.message }); }
      break;
    }

    case 'web_screenshot': {
      try {
        const result = await Browse.screenshot(msg.url);
        r('screenshot_done', { url: msg.url, base64: result.base64, error: result.error });
      } catch (e) { r('screenshot_error', { error: e.message }); }
      break;
    }

    case 'web_browse': {
      // Playwright full browser — streams actions via broadcast
      r('browse_starting', { instructions: msg.instructions });
      try {
        const result = await Browse.browse(msg.instructions, {
          startUrl: msg.startUrl,
          timeout: msg.timeout || 60000
        });
        r('browse_done', result);
      } catch (e) { r('browse_error', { error: e.message }); }
      break;
    }

    case 'web_follow_links': {
      r('crawl_start', { url: msg.url, goal: msg.goal });
      try {
        const result = await Browse.followLinks(msg.url, {
          goal: msg.goal,
          maxPages: msg.maxPages || 5,
          sameDomain: msg.sameDomain !== false
        });
        r('crawl_done', result);
      } catch (e) { r('crawl_error', { error: e.message }); }
      break;
    }

    // ══ COLLECTOR ════════════════════════════════
    case 'collector_parse': {
      // Parse natural language into a job spec
      try {
        const job = await Collector.parseIntent(msg.message);
        r('collector_job_parsed', { job });
      } catch (e) { r('error', { error: e.message }); }
      break;
    }

    case 'collector_run': {
      const job = {
        id: `job_${Date.now()}`,
        topic: msg.topic,
        target: msg.target,
        is_url: msg.is_url ?? msg.target?.startsWith('http'),
        schema: {
          table: msg.table || 'collected_data',
          fields: msg.fields || { name: 'Name', email: 'Email', phone: 'Phone' }
        },
        follow_links: msg.follow_links ?? true,
        max_pages: msg.max_pages || 5
      };

      r('collector_job_started', { jobId: job.id, job });

      // Run async — streams updates via broadcast and direct replies
      Collector.run(job, { broadcast: (type, data) => r(type, data) })
        .then(result => r('collector_job_done', { jobId: job.id, result }))
        .catch(e => r('collector_job_error', { jobId: job.id, error: e.message }));
      break;
    }

    case 'collector_push': {
      // Push already-collected rows to Supabase
      try {
        const result = await Collector.query(msg.table, { limit: 1 });
        r('collector_push_done', result);
      } catch (e) { r('error', { error: e.message }); }
      break;
    }

    case 'collector_query': {
      try {
        const result = await Collector.query(msg.table, { limit: msg.limit || 50, filter: msg.filter });
        r('collector_data', result);
      } catch (e) { r('error', { error: e.message }); }
      break;
    }

    // ══ SKILLS ══════════════════════════════════
    case 'skills_list': {
      const skills = await Skills.list();
      r('skills_list', { skills });
      break;
    }

    case 'skills_get': {
      const skill = await Skills.get(msg.name);
      r('skill', { skill });
      break;
    }

    case 'skills_run': {
      const result = await Skills.run(msg.name);
      r('skill_instructions', result);
      break;
    }

    case 'skills_learn': {
      try {
        const skill = await Skills.learn(msg.skill);
        r('skill_learned', { skill });
      } catch (e) { r('error', { error: e.message }); }
      break;
    }

    case 'skills_delete': {
      try {
        await Skills.remove(msg.name);
        r('skill_deleted', { name: msg.name });
      } catch (e) { r('error', { error: e.message }); }
      break;
    }

    // ══ RESEARCH ════════════════════════════════
    case 'research': {
      r('research_started', { topic: msg.topic });
      try {
        const result = await Research.research(msg.topic, {
          depth: msg.depth || 'standard',
          broadcast: (type, data) => r(type, data),
          sessionId: session.sessionId,
          trigger: msg.trigger || 'explicit'
        });
        r('research_done', { topic: msg.topic, result });

        // Surface summary in chat
        if (result.summary) {
          r('chat_chunk', { chunk: `\n\n**Research complete:** ${result.summary}` });
          if (result.facts?.length) {
            r('chat_chunk', { chunk: `\n\n**Key findings:**\n${result.facts.map(f=>'- '+f).join('\n')}` });
          }
          if (result.skillLearned) {
            r('chat_chunk', { chunk: `\n\n*Learned new skill: \`${result.skillLearned}\`*` });
          }
          r('chat_done', { text: result.summary });
        }
      } catch (e) { r('research_error', { error: e.message }); }
      break;
    }

    case 'research_caller': {
      // Post-call auto-research
      Research.researchCaller({
        from: msg.from,
        summary: msg.summary,
        broadcast: (type, data) => broadcast(type, data)
      }).catch(console.error);
      r('research_started', { topic: `Caller: ${msg.from}` });
      break;
    }

    // ══ SYSTEM ══════════════════════════════════
    case 'system_status':
      sendState(ws);
      break;

    case 'system_restart':
      r('system_restarting', {});
      setTimeout(() => process.exit(0), 500);
      break;

    default:
      console.warn('Unknown message type:', msg.type);
  }
}

// ─────────────────────────────────────────────────
// STATE BROADCAST
// ─────────────────────────────────────────────────
async function sendState(ws) {
  const [zcStatus, memStats] = await Promise.all([
    ZeroClaw.status(),
    Promise.resolve(Memory.stats())
  ]);
  reply(ws, 'system_state', {
    tunnel: getPublicUrl(),
    port: PORT,
    zeroclaw: zcStatus,
    memory: memStats,
    activeCalls: Calls.getActiveCalls(),
    skills: (await Skills.list()).length
  });
}

// ─────────────────────────────────────────────────
// TWILIO HTTP WEBHOOKS
// ─────────────────────────────────────────────────
app.post('/calls/incoming', (req, res) => {
  const url = getPublicUrl();
  if (!url) return res.status(503).send('<Response><Reject/></Response>');
  Calls.handleIncoming(req, res, url);
  broadcast('call_incoming', { from: req.body.From, callSid: req.body.CallSid });
});

app.post('/calls/status', (req, res) => {
  const { CallSid, CallStatus, CallDuration } = req.body;
  broadcast('call_status', { callSid: CallSid, status: CallStatus });

  // Post-call research on completion
  if (CallStatus === 'completed' && CallDuration > 10) {
    const call = Calls.getActiveCalls().find(c => c.callSid === CallSid);
    if (call) {
      Research.researchCaller({ from: call.from, broadcast }).catch(console.error);
    }
  }
  res.sendStatus(200);
});

// ─────────────────────────────────────────────────
// REST API
// ─────────────────────────────────────────────────
app.get('/api/status', async (req, res) => {
  res.json({
    ok: true,
    tunnel: getPublicUrl(),
    zeroclaw: await ZeroClaw.status(),
    memory: Memory.stats(),
    activeCalls: Calls.getActiveCalls(),
    skills: (await Skills.list()).length
  });
});

app.post('/api/call', async (req, res) => {
  const url = getPublicUrl();
  if (!url) return res.status(503).json({ error: 'Tunnel not running' });
  try { res.json({ ok: true, callSid: await Calls.makeCall(req.body.to, url) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/adb', async (req, res) => {
  res.json(await ADB.shell(req.body.command));
});

app.post('/api/research', async (req, res) => {
  const result = await Research.research(req.body.topic, { depth: req.body.depth || 'standard' });
  res.json(result);
});

app.get('/api/git', (req, res) => {
  try {
    const commit = execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: __dirname }).toString().trim();
    const msg = execSync('git log -1 --pretty=%s', { cwd: __dirname }).toString().trim();
    const date = execSync('git log -1 --pretty=%ci', { cwd: __dirname }).toString().trim();
    res.json({ commit, branch, msg, date });
  } catch (e) { res.json({ commit: 'unknown', branch: 'unknown', msg: '', date: '' }); }
});

app.get('/api/memory/stats', (req, res) => res.json(Memory.stats()));
app.get('/api/memory/identity', (req, res) => res.json(Memory.getIdentity()));

app.post('/api/search', async (req, res) => {
  try {
    const results = await Search.search(req.body.query, { provider: req.body.provider, country: 'AU' });
    res.json({ results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/fetch', async (req, res) => {
  const page = await Browse.fetch(req.body.url);
  res.json(page);
});

// ─────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────
async function boot() {
  console.log('\n🧠 ZeroKrang v3.1 starting...\n');

  // Init memory DB
  Memory.init();
  console.log('✅ Memory: SQLite initialised');

  // Init skills
  await Skills.init();
  console.log('✅ Skills: registry loaded');

  // Start HTTP + WS server
  await new Promise(r => httpServer.listen(PORT, '0.0.0.0', r));
  console.log(`✅ Server: http://localhost:${PORT}`);

  // Start ngrok
  try {
    const url = await startTunnel(PORT);
    console.log(`✅ Tunnel: ${url}`);
    console.log(`\n📞 Twilio webhook → ${url}/calls/incoming`);
    console.log(`📊 Status callback → ${url}/calls/status\n`);
  } catch (e) {
    console.warn(`⚠️  Tunnel: ${e.message} — local only`);
  }

  // Load brain identity
  await Brain.loadIdentity();

  // Check ZeroClaw
  const zcOnline = await ZeroClaw.health();
  console.log(`${zcOnline ? '✅' : '⚠️ '} ZeroClaw: ${zcOnline ? 'online' : 'offline'}`);

  const memStats = Memory.stats();
  if (memStats) {
    console.log(`✅ Memory: ${memStats.episodic} episodic · ${memStats.semantic} semantic · ${memStats.identity} identity facts`);
  }

  console.log('\n🔥 ZeroKrang ready.');
  console.log(`   Open: http://localhost:${PORT}\n`);
}

boot().catch(console.error);

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  process.exit(0);
});
