// modules/ai.js — AI providers
// Claude via OpenRouter (brain) + Gemini Live (voice)

import WebSocket from 'ws';

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const CLAUDE_MODEL   = process.env.CLAUDE_MODEL || 'anthropic/claude-sonnet-4.6';
const GEMINI_KEY     = process.env.GEMINI_API_KEY;
const GEMINI_MODEL   = process.env.GEMINI_MODEL || 'gemini-2.0-flash-live-001';

// ─────────────────────────────────────────────────
// CLAUDE — text chat (streaming)
// ─────────────────────────────────────────────────
export async function chatWithClaude(messages, onChunk = null, systemPrompt = null) {
  const sys = systemPrompt || `You are ZeroKrang, a personal AI assistant for Chris on the Gold Coast, Australia. Be direct, efficient, and useful.`;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://zerokrang.local',
      'X-Title': 'ZeroKrang'
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      stream: !!onChunk,
      messages: [{ role: 'system', content: sys }, ...messages]
    })
  });

  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);

  if (onChunk) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let full = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value).split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const d = line.slice(6).trim();
        if (d === '[DONE]') continue;
        try {
          const chunk = JSON.parse(d).choices?.[0]?.delta?.content || '';
          if (chunk) { full += chunk; onChunk(chunk); }
        } catch {}
      }
    }
    return full;
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// ─────────────────────────────────────────────────
// CLAUDE WITH TOOLS — agentic loop support
// Returns { type: 'text', content } or { type: 'tool_use', tools, rawContent }
// ─────────────────────────────────────────────────
export async function claudeWithTools({ systemPrompt, messages, tools = [], stream = false }) {
  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 2048,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages
    ],
    tools: tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema
      }
    }))
  };

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://zerokrang.local',
      'X-Title': 'ZeroKrang'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error('No response from Claude');

  if (msg.tool_calls?.length > 0) {
    return {
      type: 'tool_use',
      tools: msg.tool_calls.map(tc => ({
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || '{}')
      })),
      rawContent: msg
    };
  }

  return { type: 'text', content: msg.content || '' };
}

// ─────────────────────────────────────────────────
// GEMINI LIVE — bidirectional voice WebSocket
// Used as ears + mouth for calls — Claude is the brain
// ─────────────────────────────────────────────────
export class GeminiLiveSession {
  constructor({ systemPrompt, onAudio, onTranscript, onError }) {
    this.systemPrompt = systemPrompt;
    this.onAudio      = onAudio;
    this.onTranscript = onTranscript;
    this.onError      = onError;
    this.ws           = null;
    this.ready        = false;
    this.audioQueue   = [];
    this.transcript   = [];
  }

  async connect() {
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_KEY}`;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({
          setup: {
            model: `models/${GEMINI_MODEL}`,
            generation_config: {
              response_modalities: ['AUDIO'],
              speech_config: {
                voice_config: { prebuilt_voice_config: { voice_name: 'Aoede' } }
              }
            },
            system_instruction: {
              parts: [{ text: this.systemPrompt || 'You are ZeroKrang, a voice assistant.' }]
            }
          }
        }));
      });

      this.ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());

          if (msg.setupComplete) {
            this.ready = true;
            this.audioQueue.forEach(c => this._sendAudio(c));
            this.audioQueue = [];
            resolve(this);
            return;
          }

          const parts = msg.serverContent?.modelTurn?.parts || [];
          for (const part of parts) {
            if (part.inlineData?.mimeType?.startsWith('audio/')) {
              this.onAudio?.(Buffer.from(part.inlineData.data, 'base64'));
            }
            if (part.text) {
              this.transcript.push({ role: 'agent', text: part.text });
              this.onTranscript?.('agent', part.text);
            }
          }

          const inputParts = msg.serverContent?.inputTranscription?.parts || [];
          for (const part of inputParts) {
            if (part.text) {
              this.transcript.push({ role: 'caller', text: part.text });
              this.onTranscript?.('caller', part.text);
            }
          }

          if (msg.serverContent?.turnComplete) {
            this.onTranscript?.('system', '[turn_complete]');
          }
        } catch (e) {
          this.onError?.(`Parse error: ${e.message}`);
        }
      });

      this.ws.on('error', e => { this.onError?.(`WS error: ${e.message}`); reject(e); });
      this.ws.on('close', () => { this.ready = false; });
      setTimeout(() => reject(new Error('Gemini connect timeout')), 10000);
    });
  }

  sendAudio(buf) {
    if (!this.ready) { this.audioQueue.push(buf); return; }
    this._sendAudio(buf);
  }

  _sendAudio(buf) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      realtime_input: {
        media_chunks: [{ mime_type: 'audio/pcm;rate=8000', data: buf.toString('base64') }]
      }
    }));
  }

  // Inject Claude's response as text for Gemini to speak
  speakText(text) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      client_content: {
        turns: [{ role: 'model', parts: [{ text }] }],
        turn_complete: true
      }
    }));
  }

  getTranscript() { return [...this.transcript]; }
  close() { this.ws?.close(); this.ws = null; this.ready = false; }
}
