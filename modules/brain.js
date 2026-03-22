// modules/brain.js — ZeroKrang Cognitive Engine
// Builds system prompts, orchestrates tools, manages mode switching
// Claude is the brain. Gemini is the voice. Memory is the spine.

import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import * as AI from './ai.js';
import * as Memory from './memory.js';
import * as ADB from './adb.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ─────────────────────────────────────────────────
// LOAD IDENTITY DOCS
// ─────────────────────────────────────────────────
let soul = '', personality = '', tools = '';

export async function loadIdentity() {
  try {
    soul        = await readFile(join(ROOT, 'SOUL.md'), 'utf8');
    personality = await readFile(join(ROOT, 'PERSONALITY.md'), 'utf8');
    tools       = await readFile(join(ROOT, 'TOOLS.md'), 'utf8');
    console.log('🧠 Identity loaded: SOUL + PERSONALITY + TOOLS');
  } catch (e) {
    console.warn('⚠️  Could not load identity docs:', e.message);
  }
}

// ─────────────────────────────────────────────────
// MODE DETECTION
// ─────────────────────────────────────────────────
export const MODES = { CHAT: 'CHAT', CALL: 'CALL', COMMAND: 'COMMAND' };

export function detectMode(source) {
  if (source === 'call') return MODES.CALL;
  if (source === 'command' || source === 'adb' || source === 'cron') return MODES.COMMAND;
  return MODES.CHAT;
}

// ─────────────────────────────────────────────────
// SYSTEM PROMPT BUILDER
// ─────────────────────────────────────────────────
export async function buildSystemPrompt(mode, context = {}) {
  const { callerNumber, callerName, callHistory, recentMemory } = context;

  const now = new Date().toLocaleString('en-AU', {
    timeZone: 'Australia/Brisbane',
    dateStyle: 'full', timeStyle: 'short'
  });

  // Recall relevant memory
  const memoryContext = recentMemory ||
    await Memory.recall(mode === MODES.CALL ? (callerNumber || '') : 'recent', 5);

  const memoryBlock = memoryContext.length
    ? `## Recent Memory\n${memoryContext.map(m => `- [${m.tags?.join(',')}] ${m.content}`).join('\n')}`
    : '';

  const callerBlock = callerNumber
    ? `## Current Call\nNumber: ${callerNumber}\nName: ${callerName || 'Unknown'}\n${callHistory ? `History: ${callHistory}` : 'No previous calls from this number.'}`
    : '';

  const modeInstructions = {
    [MODES.CALL]: `## Active Mode: CALL
You are currently on a live phone call. Follow CALL mode from PERSONALITY.md.
Keep responses SHORT (1-2 sentences). You are being spoken aloud via Gemini Live.
No markdown. No bullet points. Natural spoken language only.
If you need to use a tool, do it silently and fast, then speak the result naturally.`,

    [MODES.CHAT]: `## Active Mode: CHAT
You are in a text chat session. Follow CHAT mode from PERSONALITY.md.
Full markdown is fine. You can think out loud. Be detailed when depth is needed.
Narrate tool usage briefly. Write memory after significant exchanges.`,

    [MODES.COMMAND]: `## Active Mode: COMMAND
You are executing a task autonomously. Follow COMMAND mode from PERSONALITY.md.
Terse output. Format: [ACTION] → [RESULT]
Only ask for confirmation for HIGH risk actions.`
  };

  return `${soul}

${personality}

${tools}

## Runtime Context
Time: ${now}
Mode: ${mode}
Device: Samsung Note 20 Ultra (SM-N986B) · Android 13 · arm64 · Termux

${modeInstructions[mode]}

${callerBlock}

${memoryBlock}`.trim();
}

// ─────────────────────────────────────────────────
// TOOL DEFINITIONS (passed to Claude API)
// ─────────────────────────────────────────────────
export const TOOL_DEFINITIONS = [
  {
    name: 'adb',
    description: 'Execute an ADB shell command on the connected Android device. Use for device control, app launching, input injection, screenshots, device info.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The adb shell command to run (without "adb shell" prefix)' },
        reason: { type: 'string', description: 'Brief reason for running this command' }
      },
      required: ['command']
    }
  },
  {
    name: 'web_search',
    description: 'Search the web for current information. Use for news, prices, business lookups, weather, anything requiring up-to-date data.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        max_results: { type: 'number', description: 'Number of results (default 5)' }
      },
      required: ['query']
    }
  },
  {
    name: 'file_read',
    description: 'Read a file from the Termux filesystem.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path to read' } },
      required: ['path']
    }
  },
  {
    name: 'file_write',
    description: 'Write content to a file in the Termux filesystem.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to write' },
        content: { type: 'string', description: 'Content to write' },
        append: { type: 'boolean', description: 'Append instead of overwrite' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'sms',
    description: 'Send an SMS message via Twilio.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Phone number in E.164 format (+61XXXXXXXXX)' },
        message: { type: 'string', description: 'SMS message content' }
      },
      required: ['to', 'message']
    }
  },
  {
    name: 'call',
    description: 'Initiate an outbound phone call via Twilio + Gemini Live.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Phone number to call' },
        context: { type: 'string', description: 'Briefing for the call agent — purpose, what to say, what to find out' }
      },
      required: ['to']
    }
  },
  {
    name: 'memory_store',
    description: 'Store something in long-term memory for future sessions.',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'What to remember' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags: call, contact, task, preference, project, note'
        }
      },
      required: ['content']
    }
  },
  {
    name: 'memory_recall',
    description: 'Recall relevant memories from past sessions.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for in memory' },
        limit: { type: 'number', description: 'Max results (default 5)' }
      },
      required: ['query']
    }
  },
  {
    name: 'http',
    description: 'Make an HTTP request to an external API.',
    input_schema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
        url: { type: 'string', description: 'Full URL' },
        headers: { type: 'object', description: 'Request headers' },
        body: { type: 'string', description: 'Request body (JSON string)' }
      },
      required: ['method', 'url']
    }
  }
];

// ─────────────────────────────────────────────────
// TOOL EXECUTOR
// ─────────────────────────────────────────────────
export async function executeTool(toolName, input, context = {}) {
  console.log(`🔧 Tool: ${toolName}`, JSON.stringify(input).slice(0, 100));

  switch (toolName) {

    case 'adb': {
      const result = await ADB.shell(input.command);
      return result.ok
        ? (result.stdout || 'OK')
        : `Error: ${result.stderr}`;
    }

    case 'web_search': {
      const results = await webSearch(input.query, input.max_results || 5);
      return results.map((r, i) => `${i+1}. ${r.title}\n   ${r.snippet}\n   ${r.url}`).join('\n\n');
    }

    case 'file_read': {
      try {
        const { readFile } = await import('fs/promises');
        const content = await readFile(input.path.replace('~', process.env.HOME), 'utf8');
        return content.slice(0, 10000); // cap at 10k chars
      } catch (e) { return `Error reading file: ${e.message}`; }
    }

    case 'file_write': {
      try {
        const { writeFile, appendFile } = await import('fs/promises');
        const path = input.path.replace('~', process.env.HOME);
        if (input.append) await appendFile(path, input.content);
        else await writeFile(path, input.content);
        return `Written to ${input.path}`;
      } catch (e) { return `Error writing file: ${e.message}`; }
    }

    case 'sms': {
      const twilio = (await import('twilio')).default;
      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const msg = await client.messages.create({
        to: input.to,
        from: process.env.TWILIO_PHONE_NUMBER,
        body: input.message
      });
      return `SMS sent to ${input.to} — SID: ${msg.sid}`;
    }

    case 'call': {
      const { makeCall } = await import('./calls.js');
      const { getPublicUrl } = await import('./tunnel.js');
      const sid = await makeCall(input.to, getPublicUrl(), input.context);
      return `Call initiated to ${input.to} — SID: ${sid}`;
    }

    case 'memory_store': {
      await Memory.store(input.content, input.tags || ['note']);
      return `Stored in memory: "${input.content.slice(0, 60)}..."`;
    }

    case 'memory_recall': {
      const results = await Memory.recall(input.query, input.limit || 5);
      if (!results.length) return 'No relevant memories found.';
      return results.map(m => `[${m.tags?.join(',')}] ${m.content}`).join('\n');
    }

    case 'http': {
      const res = await fetch(input.url, {
        method: input.method,
        headers: input.headers || {},
        body: input.body || undefined,
        signal: AbortSignal.timeout(15000)
      });
      const text = await res.text();
      return `HTTP ${res.status}: ${text.slice(0, 2000)}`;
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}

// ─────────────────────────────────────────────────
// MAIN THINK FUNCTION
// Full agentic loop — Claude thinks, uses tools, responds
// ─────────────────────────────────────────────────
export async function think(userMessage, options = {}) {
  const {
    mode = MODES.CHAT,
    context = {},
    history = [],
    onChunk = null,
    onToolUse = null,
    maxIterations = 8
  } = options;

  const systemPrompt = await buildSystemPrompt(mode, context);

  const messages = [
    ...history,
    { role: 'user', content: userMessage }
  ];

  let iteration = 0;
  let finalText = '';

  while (iteration < maxIterations) {
    iteration++;

    const response = await AI.claudeWithTools({
      systemPrompt,
      messages,
      tools: TOOL_DEFINITIONS,
      stream: !!onChunk && iteration === 1 // stream first response only
    });

    // Text response
    if (response.type === 'text') {
      finalText = response.content;
      if (onChunk) onChunk(response.content);
      break;
    }

    // Tool use
    if (response.type === 'tool_use') {
      const toolResults = [];

      for (const toolCall of response.tools) {
        onToolUse?.({ name: toolCall.name, input: toolCall.input });
        const result = await executeTool(toolCall.name, toolCall.input, context);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: result
        });
        onToolUse?.({ name: toolCall.name, result });
      }

      // Feed results back for next iteration
      messages.push({ role: 'assistant', content: response.rawContent });
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    break;
  }

  // Auto-store memory after chat exchanges
  if (mode === MODES.CHAT && finalText) {
    const shouldStore = userMessage.length > 20; // don't store trivial one-liners
    if (shouldStore) {
      await Memory.store(
        `User: ${userMessage.slice(0, 200)}\nZeroKrang: ${finalText.slice(0, 200)}`,
        ['chat']
      ).catch(() => {}); // non-blocking
    }
  }

  return finalText;
}

// ─────────────────────────────────────────────────
// CALL TURN — fast Claude response for voice calls
// ─────────────────────────────────────────────────
export async function callTurn(callerSpeech, callContext) {
  return think(callerSpeech, {
    mode: MODES.CALL,
    context: callContext,
    maxIterations: 4 // faster on calls
  });
}

// ─────────────────────────────────────────────────
// WEB SEARCH (simple DuckDuckGo)
// ─────────────────────────────────────────────────
async function webSearch(query, maxResults = 5) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();

    const results = [];
    if (data.AbstractText) {
      results.push({ title: data.Heading, snippet: data.AbstractText, url: data.AbstractURL });
    }
    for (const r of (data.RelatedTopics || []).slice(0, maxResults - 1)) {
      if (r.Text && r.FirstURL) {
        results.push({ title: r.Text.slice(0, 60), snippet: r.Text, url: r.FirstURL });
      }
    }
    return results.slice(0, maxResults);
  } catch (e) {
    return [{ title: 'Search failed', snippet: e.message, url: '' }];
  }
}
