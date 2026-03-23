/**
 * ADB Control — Local Relay Server
 * Runs on your machine, proxies ADB commands and Twilio webhooks to the dashboard
 *
 * Setup:
 *   npm install express cors twilio body-parser
 *   node server.js
 *
 * Then in dashboard settings, set Relay URL to: http://localhost:3456
 *
 * For Twilio webhooks (to receive SMS):
 *   npx ngrok http 3456
 *   Set Twilio webhook to: https://<ngrok-id>.ngrok.io/twilio/incoming
 */

const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const { exec }   = require('child_process');
const twilio     = require('twilio');

const app  = express();
const PORT = 3456;

// ── CONFIG (override via env vars) ──────────────────
const TWILIO_SID    = process.env.TWILIO_SID    || '';
const TWILIO_TOKEN  = process.env.TWILIO_TOKEN  || '';
const TWILIO_FROM   = process.env.TWILIO_FROM   || '';  // your Twilio number e.g. +61291234567

// In-memory store for received Twilio messages (persists until server restart)
const receivedMessages = [];

// ── MIDDLEWARE ───────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ── HEALTH ───────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ ok: true, version: '1.0', twilio: !!TWILIO_SID });
});

// ── ADB PROXY ────────────────────────────────────────
// POST /adb/exec  { serial, cmd }
// Executes an adb command and returns stdout/stderr
app.post('/adb/exec', (req, res) => {
  const { serial, cmd } = req.body;
  if (!cmd) return res.status(400).json({ error: 'cmd required' });

  // Safety: only allow adb commands
  if (!cmd.trim().startsWith('adb')) {
    return res.status(403).json({ error: 'Only adb commands allowed' });
  }

  const fullCmd = serial ? cmd.replace(/^adb /, `adb -s ${serial} `) : cmd;

  exec(fullCmd, { timeout: 15000 }, (err, stdout, stderr) => {
    res.json({
      ok: !err,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode: err ? err.code : 0,
    });
  });
});

// GET /adb/devices  — list connected devices
app.get('/adb/devices', (req, res) => {
  exec('adb devices -l', { timeout: 8000 }, (err, stdout) => {
    if (err) return res.status(500).json({ error: err.message });
    const lines = stdout.trim().split('\n').slice(1).filter(l => l.trim() && !l.includes('*'));
    const devices = lines.map(l => {
      const parts = l.trim().split(/\s+/);
      const serial = parts[0];
      const status = parts[1];
      const model  = (l.match(/model:(\S+)/) || [])[1] || 'unknown';
      return { serial, status, model };
    });
    res.json({ devices });
  });
});

// GET /adb/sms/inbox?serial=xxx&limit=100
// Reads SMS inbox via content provider (works on rooted + non-rooted)
app.get('/adb/sms/inbox', (req, res) => {
  const { serial, limit = 100 } = req.query;
  const s = serial ? `-s ${serial}` : '';
  const cmd = `adb ${s} shell content query --uri content://sms/inbox --projection _id,address,body,date,read,type --sort "date DESC" | head -${parseInt(limit) * 8}`;
  exec(cmd, { timeout: 15000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
    if (err) return res.status(500).json({ error: err.message, raw: stdout });
    res.json({ messages: parseSmsContentQuery(stdout), source: 'inbox' });
  });
});

// GET /adb/sms/sent?serial=xxx&limit=100
app.get('/adb/sms/sent', (req, res) => {
  const { serial, limit = 100 } = req.query;
  const s = serial ? `-s ${serial}` : '';
  const cmd = `adb ${s} shell content query --uri content://sms/sent --projection _id,address,body,date,read,type --sort "date DESC" | head -${parseInt(limit) * 8}`;
  exec(cmd, { timeout: 15000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ messages: parseSmsContentQuery(stdout), source: 'sent' });
  });
});

// GET /adb/sms/all?serial=xxx&limit=200
app.get('/adb/sms/all', (req, res) => {
  const { serial, limit = 200 } = req.query;
  const s = serial ? `-s ${serial}` : '';
  const cmd = `adb ${s} shell content query --uri content://sms --projection _id,address,body,date,read,type --sort "date DESC"`;
  exec(cmd, { timeout: 20000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
    if (err) return res.status(500).json({ error: err.message });
    const all = parseSmsContentQuery(stdout).slice(0, parseInt(limit));
    res.json({ messages: all });
  });
});

// POST /adb/sms/send  { serial, to, body }
// Sends SMS via ADB intent
app.post('/adb/sms/send', (req, res) => {
  const { serial, to, body } = req.body;
  if (!to || !body) return res.status(400).json({ error: 'to and body required' });
  const s = serial ? `-s ${serial}` : '';
  const escaped = body.replace(/"/g, '\\"').replace(/'/g, "\\'");
  const cmd = `adb ${s} shell am start -a android.intent.action.SENDTO -d sms:${to} --es sms_body "${escaped}" --ez exit_on_sent true`;
  exec(cmd, { timeout: 10000 }, (err, stdout, stderr) => {
    res.json({ ok: !err, stdout: stdout.trim(), stderr: stderr.trim() });
  });
});

// DELETE /adb/sms/:id?serial=xxx
// Deletes a single SMS by _id (requires root on most devices)
app.delete('/adb/sms/:id', (req, res) => {
  const { serial } = req.query;
  const { id } = req.params;
  const s = serial ? `-s ${serial}` : '';
  const cmd = `adb ${s} shell content delete --uri content://sms/${id}`;
  exec(cmd, { timeout: 8000 }, (err, stdout, stderr) => {
    res.json({ ok: !err, stdout: stdout.trim(), stderr: stderr.trim() });
  });
});

// DELETE /adb/sms/bulk  { serial, ids: [1,2,3] }
app.post('/adb/sms/bulk-delete', (req, res) => {
  const { serial, ids } = req.body;
  if (!ids?.length) return res.status(400).json({ error: 'ids required' });
  const s = serial ? `-s ${serial}` : '';
  const cmds = ids.map(id => `adb ${s} shell content delete --uri content://sms/${id}`).join(' && ');
  exec(cmds, { timeout: 30000 }, (err, stdout) => {
    res.json({ ok: !err, deleted: ids.length });
  });
});

// ── TWILIO OUTBOUND ──────────────────────────────────
// POST /twilio/send  { to, body }
app.post('/twilio/send', async (req, res) => {
  if (!TWILIO_SID || !TWILIO_TOKEN) return res.status(400).json({ error: 'Twilio not configured. Set TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM env vars.' });
  const { to, body } = req.body;
  if (!to || !body) return res.status(400).json({ error: 'to and body required' });
  try {
    const client = twilio(TWILIO_SID, TWILIO_TOKEN);
    const msg = await client.messages.create({ body, from: TWILIO_FROM, to });
    res.json({ ok: true, sid: msg.sid, status: msg.status });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /twilio/messages?limit=50  — fetch sent messages from Twilio log
app.get('/twilio/messages', async (req, res) => {
  if (!TWILIO_SID || !TWILIO_TOKEN) return res.status(400).json({ error: 'Twilio not configured' });
  const limit = parseInt(req.query.limit) || 50;
  try {
    const client = twilio(TWILIO_SID, TWILIO_TOKEN);
    const msgs = await client.messages.list({ limit });
    res.json({ messages: msgs.map(m => ({
      sid: m.sid, from: m.from, to: m.to, body: m.body,
      direction: m.direction, status: m.status,
      dateSent: m.dateSent, dateCreated: m.dateCreated,
      errorCode: m.errorCode, errorMessage: m.errorMessage,
    }))});
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /twilio/incoming  — Twilio webhook for inbound SMS
// Point your Twilio number's webhook here (use ngrok to expose publicly)
app.post('/twilio/incoming', (req, res) => {
  const { From, To, Body, MessageSid, NumMedia } = req.body;
  const msg = {
    sid: MessageSid,
    from: From,
    to: To,
    body: Body,
    direction: 'inbound',
    status: 'received',
    dateCreated: new Date().toISOString(),
    numMedia: parseInt(NumMedia) || 0,
  };
  receivedMessages.unshift(msg);
  if (receivedMessages.length > 500) receivedMessages.splice(500);
  console.log(`📨 Twilio inbound from ${From}: ${Body}`);
  // Respond with empty TwiML (no auto-reply)
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');
});

// GET /twilio/received  — poll for received messages
app.get('/twilio/received', (req, res) => {
  const since = req.query.since ? new Date(req.query.since) : null;
  const msgs = since ? receivedMessages.filter(m => new Date(m.dateCreated) > since) : receivedMessages;
  res.json({ messages: msgs });
});

// ── HELPERS ──────────────────────────────────────────
function parseSmsContentQuery(raw) {
  const messages = [];
  const rows = raw.split(/\nRow: \d+/).filter(r => r.trim());
  for (const row of rows) {
    const get = (key) => {
      const m = row.match(new RegExp(`${key}=([^,\n]+)`));
      return m ? m[1].trim() : '';
    };
    const id      = get('_id');
    const address = get('address');
    const body    = get('body');
    const date    = get('date');
    const read    = get('read');
    const type    = get('type'); // 1=inbox, 2=sent, 3=draft, 4=outbox
    if (id && address) {
      messages.push({
        id, address,
        body: body.replace(/\\n/g, '\n'),
        date: date ? parseInt(date) : Date.now(),
        read: read === '1',
        type: parseInt(type) || 1,
        source: 'adb',
      });
    }
  }
  return messages;
}

// ── START ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 ADB Control relay server running on http://localhost:${PORT}`);
  console.log(`\n  ADB proxy:     POST /adb/exec`);
  console.log(`  SMS inbox:     GET  /adb/sms/inbox?serial=<serial>`);
  console.log(`  SMS send:      POST /adb/sms/send`);
  console.log(`  Twilio send:   POST /twilio/send`);
  console.log(`  Twilio webhook: POST /twilio/incoming`);
  console.log(`\n  Env vars needed for Twilio:`);
  console.log(`    TWILIO_SID=ACxxx TWILIO_TOKEN=xxx TWILIO_FROM=+61xxxxxxxxx node server.js`);
  console.log(`\n  For Twilio webhooks: npx ngrok http ${PORT}`);
  console.log(`  Then set Twilio webhook to: https://<ngrok>.ngrok.io/twilio/incoming\n`);
});
