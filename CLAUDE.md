# ADB Control Dashboard

## What this is
Browser-based dashboard for managing Android devices via ADB. Multi-agent AI chat (OpenRouter), SMS inbox/compose/delete (ADB + Twilio), per-device detail pages, and a local Node.js relay server.

## Stack
- `public/index.html` — entire frontend, single file, no framework, no build
- `server.js` — Express relay on port 3456, executes ADB commands, receives Twilio webhooks
- `package.json` — express, cors, twilio, body-parser

## Run
```bash
npm install
node server.js        # relay at http://localhost:3456
# open public/index.html in Chrome
```

## Device
Samsung Note 20 Ultra, Android 12, rooted (Magisk). Connects via USB, WiFi ADB, or Tailscale.

## Self-hosted on phone (Termux)
```bash
pkg install nodejs android-tools
npm install
adb connect localhost:5555   # phone controls itself
node server.js
# open http://localhost:3456 in Chrome on phone
```

## Architecture
```
Browser (index.html)
  ├── OpenRouter API  — direct fetch, AI agent responses
  └── server.js :3456
        ├── GET  /health
        ├── GET  /adb/devices
        ├── POST /adb/exec
        ├── GET  /adb/sms/inbox
        ├── GET  /adb/sms/sent
        ├── POST /adb/sms/send
        ├── POST /adb/sms/bulk-delete
        ├── POST /twilio/send
        ├── POST /twilio/incoming   ← Twilio webhook
        └── GET  /twilio/received
```

## State / Storage
All state in `S{}`. All localStorage keys prefixed `adb4_`:
- `adb4_key` — OpenRouter API key
- `adb4_relay` — relay URL (default http://localhost:3456)
- `adb4_tsid` / `adb4_ttoken` / `adb4_tfrom` — Twilio creds
- `adb4_agents` — agent configs + conversation histories
- `adb4_devices` — device configs + per-device chat histories
- `adb4_skills` — skills (built-in + user-created)
- `adb4_tokens` — token usage per model

## Key functions in index.html
- `callModel()` — OpenRouter API call, assembles system prompt, streams response
- `buildSys()` — assembles system prompt: agent.sys + skills + device context
- `sendAgent()` / `sendDevAgent()` — send in global / device agent chat
- `loadComms()` — fetches ADB SMS + Twilio log, populates commsState
- `renderCommsTab()` — renders full Comms UI
- `cSend()` — sends SMS (ADB or Twilio)
- `openGlobalSettings()` — ⚙️ settings modal

## Pending polish items (priority order)
1. Persist Comms threads to localStorage (currently lost on refresh)
2. Contact name resolution — `/adb/contacts` endpoint + map numbers to names
3. Toast notifications — success/fail feedback, 3s auto-dismiss
4. MapLibre GPS panel on device Info tab — `/adb/location` endpoint
5. Twilio raw log tab in Comms (data already in `cs.twilioLog`, needs render)
6. `.env` support in server.js (`dotenv`)
7. Agent avatar animated ring while streaming (`S.streaming === true`)
8. Unread count badge on device sidebar items

## Known gotchas
- ADB SMS delete needs root — unrooted devices reject `content delete`
- ADB SMS send briefly opens SMS app (uses intent, not silent root method)
- Twilio inbound is in-memory — relay restart loses messages (add SQLite to fix)
- ngrok URLs change on restart — use Cloudflare Tunnel for stable URL
- CORS is open (`*`) — fine for localhost, lock down if exposed

## Skills
- **adb** — ADB device control. See `ADB-SKILL.md` in project root.
