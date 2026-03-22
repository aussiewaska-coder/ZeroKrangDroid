// modules/calls.js — Twilio voice agent
// Inbound + outbound calls bridged to Gemini Live

import twilio from 'twilio';
import WebSocket from 'ws';
import { GeminiLiveSession } from './ai.js';

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const VoiceResponse = twilio.twiml.VoiceResponse;

// Active call sessions: callSid → { gemini, twilioWs, callSid, from, startTime }
const activeCalls = new Map();

// ─────────────────────────────────────────────────
// INBOUND CALL WEBHOOK
// Twilio hits POST /calls/incoming when someone calls your number
// ─────────────────────────────────────────────────
export function handleIncoming(req, res, publicUrl) {
  const { CallSid, From, To } = req.body;
  console.log(`📞 Incoming call: ${From} → ${To} [${CallSid}]`);

  const twiml = new VoiceResponse();
  const connect = twiml.connect();

  // Open a Media Stream back to our server
  connect.stream({
    url: `wss://${new URL(publicUrl).host}/calls/stream`,
    track: 'both_tracks'
  });

  res.type('text/xml');
  res.send(twiml.toString());
}

// ─────────────────────────────────────────────────
// OUTBOUND CALL
// ─────────────────────────────────────────────────
export async function makeCall(to, publicUrl) {
  const from = process.env.TWILIO_PHONE_NUMBER;
  console.log(`📲 Outbound call: ${from} → ${to}`);

  const call = await client.calls.create({
    to,
    from,
    twiml: `<Response>
      <Connect>
        <Stream url="wss://${new URL(publicUrl).host}/calls/stream" track="both_tracks"/>
      </Connect>
    </Response>`
  });

  console.log(`📲 Call initiated: ${call.sid}`);
  return call.sid;
}

// ─────────────────────────────────────────────────
// HANG UP
// ─────────────────────────────────────────────────
export async function hangUp(callSid) {
  await client.calls(callSid).update({ status: 'completed' });
  const session = activeCalls.get(callSid);
  if (session) {
    session.gemini?.close();
    activeCalls.delete(callSid);
  }
}

// ─────────────────────────────────────────────────
// MEDIA STREAM WEBSOCKET HANDLER
// Twilio streams audio here, we pipe to Gemini Live
// ─────────────────────────────────────────────────
export function handleMediaStream(ws, broadcast) {
  let callSid = null;
  let gemini = null;
  let streamSid = null;
  let metaSent = false;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.event) {

      case 'connected':
        console.log('🔗 Twilio media stream connected');
        break;

      case 'start':
        callSid = msg.start.callSid;
        streamSid = msg.start.streamSid;
        const from = msg.start.customParameters?.from || 'unknown';
        console.log(`🎙️  Stream started: ${callSid}`);

        // Boot Gemini Live session
        gemini = new GeminiLiveSession({
          onAudio: (audioBuf) => {
            // Send audio back to Twilio as mulaw
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                event: 'media',
                streamSid,
                media: {
                  payload: audioBuf.toString('base64')
                }
              }));
            }
          },
          onText: (text) => {
            if (text === '[turn_complete]' || text === '[session_closed]') return;
            console.log(`🤖 Gemini: ${text}`);
            broadcast?.('call_transcript', { role: 'agent', text, callSid });
          },
          onError: (err) => {
            console.error(`❌ Gemini error: ${err}`);
            broadcast?.('call_error', { error: err, callSid });
          }
        });

        try {
          await gemini.connect();
          // Greet the caller
          gemini.sendText(`A call just connected from ${from}. Greet them as ZeroKrang, Chris's AI assistant. Ask how you can help.`);

          activeCalls.set(callSid, { gemini, twilioWs: ws, callSid, from, startTime: Date.now() });
          broadcast?.('call_started', { callSid, from });
        } catch (e) {
          console.error(`❌ Gemini connect failed: ${e.message}`);
          ws.close();
        }
        break;

      case 'media':
        // Inbound audio from caller — forward to Gemini
        if (gemini && msg.media?.payload) {
          const buf = Buffer.from(msg.media.payload, 'base64');
          gemini.sendAudio(buf);
          // Broadcast waveform data to UI (downsampled)
          if (!metaSent) {
            broadcast?.('call_audio', { callSid, level: buf.length });
            metaSent = true;
            setTimeout(() => { metaSent = false; }, 100);
          }
        }
        break;

      case 'stop':
        console.log(`📵 Stream stopped: ${callSid}`);
        gemini?.close();
        if (callSid) {
          activeCalls.delete(callSid);
          broadcast?.('call_ended', { callSid });
        }
        break;
    }
  });

  ws.on('close', () => {
    if (callSid) {
      gemini?.close();
      activeCalls.delete(callSid);
      broadcast?.('call_ended', { callSid });
    }
  });
}

// ─────────────────────────────────────────────────
// GET ACTIVE CALLS
// ─────────────────────────────────────────────────
export function getActiveCalls() {
  return Array.from(activeCalls.values()).map(s => ({
    callSid: s.callSid,
    from: s.from,
    duration: Math.floor((Date.now() - s.startTime) / 1000)
  }));
}
