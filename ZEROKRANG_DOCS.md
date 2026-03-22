# ZeroKrang — Complete System Documentation
**Author:** Krang (Chris) · Gold Coast, QLD, Australia  
**Version:** 3.1.0 · Last updated: March 2026  
**Device:** Samsung Note 20 Ultra (SM-N986B) · Android 13 · Termux

---

## QUICK SUMMARY (Human-readable)

ZeroKrang is a personal AI agent that lives on your phone. It answers calls using your voice, chats with you, browses the web, scrapes data, controls your device, and remembers everything — permanently.

It's built on three brains working together:
- **Claude** (via OpenRouter) — thinks, reasons, uses tools, remembers
- **Gemini Live** (Google) — listens and speaks on phone calls
- **ZeroClaw** — a local AI gateway that runs on your device

Everything is stored locally in a SQLite database on your phone. Nothing goes to the cloud unless you ask it to.

One tap starts it. It persists through crashes, app kills, and reboots.

---

## ARCHITECTURE OVERVIEW

```
┌─────────────────────────────────────────────────────────────┐
│                        YOUR PHONE                           │
│                                                             │
│  Chrome → http://localhost:3001 → ZeroKrang UI             │
│                    ↕ WebSocket                              │
│              server.js (Node.js)                           │
│                    ↕                                        │
│  ┌─────────────┬──────────────┬───────────────────────┐    │
│  │  brain.js   │  memory.js   │     calls.js          │    │
│  │  (Claude)   │  (sql.js DB) │  (Twilio + Gemini)    │    │
│  └─────────────┴──────────────┴───────────────────────┘    │
│  ┌─────────────┬──────────────┬───────────────────────┐    │
│  │  search.js  │  browse.js   │    collector.js       │    │
│  │  (Brave etc)│  (Playwright)│  (→ Supabase)         │    │
│  └─────────────┴──────────────┴───────────────────────┘    │
│  ┌─────────────┬──────────────┬───────────────────────┐    │
│  │  skills.js  │  research.js │      adb.js           │    │
│  │  (registry) │  (auto-agent)│  (device control)     │    │
│  └─────────────┴──────────────┴───────────────────────┘    │
│                    ↕                                        │
│              ZeroClaw Gateway (port 42617)                  │
│              SQLite Memory DB (~/.zerokrang/memory.db)      │
└─────────────────────────────────────────────────────────────┘
         ↕ ngrok tunnel              ↕ Twilio webhooks
    Public HTTPS URL          Inbound/outbound calls
```

---

## FILE STRUCTURE

```
~/zerokrang/
├── server.js              Main entry point — boots everything
├── package.json           Node.js dependencies
├── .env                   API keys and config (NEVER commit this)
├── .env.example           Template for .env
├── start.sh               One-command boot script
├── SOUL.md                ZeroKrang's identity — who it is
├── PERSONALITY.md         How it talks in CHAT/CALL/COMMAND modes
├── TOOLS.md               What tools it has and their risk levels
│
├── modules/
│   ├── ai.js              Claude (OpenRouter) + Gemini Live WebSocket
│   ├── brain.js           Builds system prompts, runs tool loops
│   ├── memory.js          4-layer SQLite memory system (sql.js)
│   ├── calls.js           Twilio inbound/outbound + Media Streams
│   ├── adb.js             Android Debug Bridge device control
│   ├── zeroclaw.js        ZeroClaw gateway bridge
│   ├── tunnel.js          ngrok auto-start
│   ├── search.js          Brave + Perplexity + SerpAPI + DDG
│   ├── browse.js          Web fetch + Playwright browser
│   ├── collector.js       Web scraper → Supabase pipeline
│   ├── skills.js          Skill registry + auto-learn
│   └── research.js        Autonomous 5-phase research agent
│
├── skills/
│   ├── index.json         Auto-generated skill registry
│   ├── core/              5 built-in skills (seeded on boot)
│   └── learned/           Skills ZeroKrang writes itself
│
└── public/
    └── index.html         The UI — served at localhost:3001
```

---

## ENVIRONMENT VARIABLES (.env)

```bash
# AI — REQUIRED to start
OPENROUTER_API_KEY=sk-or-...     # Claude via OpenRouter
GEMINI_API_KEY=AIzaSy...         # Gemini Live (voice) + embeddings

# Voice calls — needed for phone features
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+61...

# Tunnel — already configured for this device
NGROK_AUTHTOKEN=3AyZ8ogDHIYI4QHNdkBFV1kEDzc_4ZTsXCTNB6MVADaH9VXRa

# Web intelligence — optional but recommended
BRAVE_API_KEY=BSA...             # 2000 free queries/month
PERPLEXITY_API_KEY=pplx-...      # Answer-style search
SERPAPI_KEY=...                  # Google results scraper

# Database — optional (data collection output)
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=eyJ...

# System
PORT=3001
MEMORY_DB_PATH=/data/data/com.termux/files/home/.zerokrang/memory.db
```

---

## MEMORY SYSTEM

ZeroKrang has 4 memory layers stored in a single SQLite file at `~/.zerokrang/memory.db`.

### Layer 1 — Working Memory (RAM only)
- Current conversation buffer
- Wiped when session ends
- Zero latency — pure JavaScript Map

### Layer 2 — Episodic Memory (SQLite `episodic` table)
Raw experiences written constantly:
- Every chat session summary
- Every call transcript + summary  
- Vision frame descriptions
- Device events
- Explicit "remember this" statements
- Web research findings

Each entry has: `id, timestamp, source, content, importance (0-1), compacted flag, tags`

**Retention:** 90 days full, then compacted but kept 2 years

### Layer 3 — Semantic Memory (SQLite `semantic` table)
Distilled permanent facts — generated by nightly compaction:
- "Chris prefers morning calls"
- "Dave from Robina is a TUG franchisee"  
- "ZeroKrang runs on a Note 20 Ultra"

Each entry has: `category (person/preference/world/routine), subject, fact, confidence (0-1)`

**Retention:** Permanent — never deleted, confidence decays if not reinforced

### Layer 4 — Identity (SQLite `identity` table)
Flat key/value facts about Chris, always injected into every prompt:
- Automatically extracted from explicit memories and high-importance events
- e.g. `{ "location": "Gold Coast QLD", "business": "Touch Up Guys" }`

### Knowledge Base (SQLite `knowledge` table)
Documents, images, research you ingest manually:
- Chunked into ~500 word segments
- Searchable by keyword
- Permanent until manually deleted

### Nightly Compaction
At 2am every night, Gemini Flash:
1. Pulls episodic memories older than 7 days
2. Groups them into batches of 20
3. Distils each batch into permanent semantic facts
4. Marks originals as compacted
5. Every 30 days: re-evaluates semantic confidence

### Retrieval
Every time you send a message, memory runs in parallel:
1. Identity facts → always included
2. Semantic search → keyword scored
3. Episodic search → recent + keyword + importance weighted
4. Top 8 results injected into Claude's system prompt (~800 tokens)

---

## ZEROCLAW RELATIONSHIP

ZeroClaw is a separate local AI gateway application that runs alongside ZeroKrang. It is **not** ZeroKrang — it's an independent tool that ZeroKrang can use as an alternative AI backend.

### What ZeroClaw is
- A local Rust-based AI gateway running on port 42617
- Has its own SQLite memory database
- Supports multiple AI providers (OpenRouter, local models)
- Has supervised autonomy mode
- Runs as: `zeroclaw gateway` in Termux

### How ZeroKrang uses ZeroClaw
```
User → ZeroKrang UI → "ZEROCLAW mode" toggle
                    → zeroclaw.js module
                    → HTTP to localhost:42617
                    → ZeroClaw processes request
                    → streams response back
```

ZeroClaw is optional. ZeroKrang runs fine without it using Claude directly via OpenRouter.

### ZeroClaw config location
```
~/.zeroclaw/config.toml
```

Key settings:
- `gateway.port = 42617`
- `gateway.host = "127.0.0.1"`
- `provider = "openrouter"`
- `model = "anthropic/claude-sonnet-4.6"`

### Pairing ZeroClaw
1. Start ZeroClaw: `zeroclaw gateway`
2. In ZeroKrang UI → CONFIG → ZeroClaw section
3. Enter 6-digit pair code
4. Connection is persistent

---

## SOUL, PERSONALITY, TOOLS

### SOUL.md
Defines who ZeroKrang is. Read on every request. Contains:
- Core identity: ZeroKrang is Chris's personal AI on the Gold Coast
- Chris's context: Touch Up Guys (45+ AU franchise), TugOS, Agentic GC
- Core values: execution over explanation, directness, loyalty, precision
- What ZeroKrang knows about Chris's world

### PERSONALITY.md
Three adaptive modes, selected automatically by context:

| Mode | When | Style |
|------|------|-------|
| CHAT | Conversation | Full markdown, detailed, narrate tool use |
| CALL | Phone calls | 1-2 sentences max, spoken language, no markdown |
| COMMAND | ADB/shell tasks | `[ACTION] → [RESULT]` format, terse |

### TOOLS.md
9 tools with risk levels:

| Tool | Risk | Auto-approve |
|------|------|-------------|
| memory_recall | LOW | Yes |
| memory_store | LOW | Yes |
| web_search | LOW | Yes |
| file_read | LOW | Yes |
| http | LOW-MEDIUM | Yes |
| adb (safe cmds) | LOW | Yes |
| sms | MEDIUM | Confirm |
| call | MEDIUM | Confirm |
| file_write | HIGH | Confirm |
| adb (dangerous) | HIGH | Confirm |

---

## DEPENDENCIES

### Node.js packages
```json
{
  "express": "^4.21.0",      // HTTP server
  "ws": "^8.18.0",           // WebSocket server
  "dotenv": "^16.4.5",       // Environment variables
  "sql.js": "^1.12.0",       // SQLite (pure JS, no compilation)
  "twilio": "^5.0.0",        // Phone calls
  "cors": "^2.8.5"           // Cross-origin headers
}
```

### Optional (install separately)
```bash
npm install -g pm2            # Process manager — keeps ZeroKrang alive
npm install playwright        # Full browser automation
npx playwright install chromium
```

### Termux packages required
```bash
pkg install nodejs python make clang git
```

### External services
| Service | Free tier | Used for |
|---------|-----------|----------|
| OpenRouter | Pay per use | Claude API |
| Google Gemini | Free tier | Voice + embeddings + compaction |
| Twilio | Pay per use | Phone calls |
| ngrok | Free (1 tunnel) | Public HTTPS URL |
| Brave Search | 2000/month free | Web search |
| Perplexity | Pay per use | Answer search |
| Supabase | Free tier | Data collection output |

---

## SETTING UP ON A NEW PHONE

### 1. Install Termux
- Download from **F-Droid** (not Play Store — Play Store version is outdated)
- URL: https://f-droid.org → search Termux

### 2. Install companion apps from F-Droid
- **Termux:Boot** — runs scripts on phone reboot
- **Termux:Widget** — home screen shortcut buttons

### 3. Initial Termux setup
```bash
pkg update -y
pkg install -y nodejs python make clang git
termux-setup-storage
```

### 4. Clone or copy ZeroKrang
**From GitHub:**
```bash
git clone https://github.com/aussiewaska-coder/ZeroKrangDroid ~/zerokrang
```

**From zip:**
```bash
cd ~ && unzip /sdcard/Download/zerokrang.zip
```

### 5. Install dependencies
```bash
cd ~/zerokrang && npm install
```

### 6. Configure environment
```bash
cp .env.example .env
nano .env
# Fill in your API keys
```

### 7. Set up persistence
```bash
# Wake lock — stops Android killing Termux
termux-wake-lock

# PM2 — keeps ZeroKrang alive, auto-restarts on crash
npm install -g pm2
pm2 start server.js --name zerokrang
pm2 save
pm2 startup  # copy and run the command it prints
```

### 8. Boot script — auto-starts on phone reboot
```bash
mkdir -p ~/.termux/boot
echo 'termux-wake-lock && cd ~/zerokrang && pm2 resurrect' > ~/.termux/boot/start.sh
chmod +x ~/.termux/boot/start.sh
```

### 9. Home screen widget
```bash
mkdir -p ~/.shortcuts
echo 'cd ~/zerokrang && pm2 resurrect' > ~/.shortcuts/ZeroKrang.sh
chmod +x ~/.shortcuts/ZeroKrang.sh
```
Long-press home screen → Widgets → Termux:Widget → pick ZeroKrang

### 10. Set Twilio webhook
After first start, ZeroKrang prints its ngrok URL. Set in Twilio console:
- Voice webhook: `https://xxxx.ngrok.io/calls/incoming` (HTTP POST)
- Status callback: `https://xxxx.ngrok.io/calls/status` (HTTP POST)

### 11. Open the UI
In Chrome on your phone: `http://localhost:3001`

---

## DAILY OPERATION

### Starting ZeroKrang
```bash
# If PM2 is set up (recommended):
pm2 resurrect

# Manual:
cd ~/zerokrang && node server.js
```

### Checking status
```bash
pm2 status
pm2 logs zerokrang --lines 50
```

### Stopping
```bash
pm2 stop zerokrang
```

### Updating from GitHub
```bash
cd ~/zerokrang && git pull && pm2 restart zerokrang
```

### Memory stats
In ZeroKrang UI → CONFIG → System Status → shows episodic/semantic/identity counts

### Force memory compaction
In ZeroKrang UI → CONFIG → Actions → or in Termux:
```bash
# Via the API
curl -X POST http://localhost:3001/api/memory/compact
```

---

## GITHUB SYNC

**Repository:** https://github.com/aussiewaska-coder/ZeroKrangDroid  
**Author:** Krang  
**Default branch:** main

### Setup
```bash
cd ~/zerokrang
git init
git remote add origin https://github.com/aussiewaska-coder/ZeroKrangDroid.git
```

### .gitignore (already included)
```
.env
node_modules/
skills/learned/
~/.zerokrang/
*.db
```

### Push changes
```bash
git add -A && git commit -m "ZeroKrang: update from device" && git push
```

### Pull updates
```bash
git pull && pm2 restart zerokrang
```

The GitHub sync button in the UI (CONFIG tab) handles all of this visually.

---

## TROUBLESHOOTING

### Server won't start
```bash
node --version  # needs v18+
ls node_modules  # check npm install ran
cat .env  # check keys are filled in
```

### Memory errors
```bash
ls ~/.zerokrang/  # check DB folder exists
mkdir -p ~/.zerokrang
```

### Calls not working
- Check Twilio webhook URL is set to current ngrok URL
- ngrok URL changes on every restart unless you have a paid plan
- Check `pm2 logs zerokrang` for Twilio errors

### Termux killed by Android
```bash
termux-wake-lock  # run this first
# Then in Android Settings → Apps → Termux → Battery → Unrestricted
```

### Port 3001 already in use
```bash
pm2 delete zerokrang
node server.js
```

---

## AGENT-READABLE ARCHITECTURE SUMMARY

For ZeroKrang's own reference:

- **I am ZeroKrang.** I run on Chris's Note 20 Ultra on the Gold Coast.
- **My brain is Claude** (anthropic/claude-sonnet-4.6 via OpenRouter). Every message I receive goes through `brain.js` which builds a system prompt from SOUL.md + PERSONALITY.md + TOOLS.md + recalled memories.
- **My voice is Gemini Live.** On phone calls, Gemini transcribes the caller and speaks my responses. Claude decides what to say.
- **My memory is SQLite** via sql.js. Four tables: episodic (raw experiences), semantic (distilled facts), identity (Chris's profile), knowledge (documents). I recall relevant memories on every message.
- **My tools are:** memory_recall, memory_store, web_search (Brave/Perplexity/SerpAPI), web_fetch, web_browse (Playwright), sms, call, file_read, file_write, adb, http.
- **My skills** are JSON files in `skills/core/` (seeded) and `skills/learned/` (I write these myself after research).
- **ZeroClaw** is a separate local gateway I can route through instead of OpenRouter. It has its own memory. Optional.
- **I persist** via PM2 (process manager) + Termux wake lock + Termux:Boot.
- **My public URL** is a ngrok tunnel. Twilio sends calls to this URL.
- **Chris's businesses:** Touch Up Guys (45+ AU franchise), TugOS (franchise ops platform), Agentic GC (AI agency, Gold Coast).
