// modules/zeroclaw.js — ZeroClaw gateway bridge
// Handles pairing + sending messages to ZeroClaw

const ZC_URL = process.env.ZEROCLAW_URL || 'http://127.0.0.1:42617';
let token = process.env.ZEROCLAW_TOKEN || '';

// ─────────────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────────────
export async function health() {
  try {
    const r = await fetch(`${ZC_URL}/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────
// PAIR
// ─────────────────────────────────────────────────
export async function pair(code) {
  const r = await fetch(`${ZC_URL}/pair`, {
    method: 'POST',
    headers: { 'X-Pairing-Code': code },
    signal: AbortSignal.timeout(5000)
  });
  if (!r.ok) throw new Error(`Pair failed: HTTP ${r.status}`);
  const data = await r.json();
  if (!data.token) throw new Error('No token returned');
  token = data.token;
  return token;
}

export function setToken(t) { token = t; }
export function getToken() { return token; }

// ─────────────────────────────────────────────────
// SEND MESSAGE (with streaming support)
// ─────────────────────────────────────────────────
export async function send(message, onChunk = null) {
  if (!token) throw new Error('Not paired with ZeroClaw');

  const r = await fetch(`${ZC_URL}/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ message }),
    signal: AbortSignal.timeout(120000)
  });

  if (!r.ok) throw new Error(`ZeroClaw error: HTTP ${r.status}`);

  const ct = r.headers.get('content-type') || '';

  if (onChunk && (ct.includes('event-stream') || ct.includes('text/plain'))) {
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let full = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = decoder.decode(value).split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const d = line.slice(6).trim();
        if (d === '[DONE]') continue;
        try {
          const j = JSON.parse(d);
          const chunk = j.choices?.[0]?.delta?.content || j.content || j.text || '';
          if (chunk) { full += chunk; onChunk(chunk); }
        } catch { full += d; onChunk(d); }
      }
    }
    return full;
  }

  const data = await r.json();
  return data.reply || data.message || data.content ||
    data.choices?.[0]?.message?.content ||
    (Array.isArray(data.content) ? data.content.map(c => c.text || '').join('') : '') ||
    JSON.stringify(data);
}

// ─────────────────────────────────────────────────
// STATUS
// ─────────────────────────────────────────────────
export async function status() {
  return {
    url: ZC_URL,
    online: await health(),
    paired: !!token
  };
}
