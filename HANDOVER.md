# ZeroKrang v3.2 — Full System Handover

## CRITICAL WARNING: DEMO VS REAL

**The frontend has TWO script blocks.** The second one overwrites the first with demo/simulation functions. This means:

- **Chat** → does NOT call the server. It cycles through 8 hardcoded fake responses with fake tool animations.
- **Calls** → does NOT call Twilio. It simulates a fake inbound call after 9 seconds with hardcoded transcript.
- **ADB** → does NOT run real ADB commands. It returns hardcoded strings. `alistApps()` returns a fake package list.
- **ADB Screenshot** → logs a fake path. Does NOT capture screen.
- **Web Search** → does NOT call Brave/Perplexity/SERP/DDG. Returns 2 hardcoded result sets based on whether query contains "tug".
- **Preview** → does NOT fetch URLs. Simulates a fake "extracting" animation and shows a fake contact page.
- **Jobs/Collector** → does NOT crawl. Generates random fake names/emails/phones from hardcoded name arrays.
- **Data → CSV** → WORKS (exports whatever fake data was generated).
- **Data → Supabase** → does NOT push. Simulates with a timeout.
- **Config → Save Keys** → does NOT save to server. Toast only.
- **Config → Pair** → simulates pairing with a timeout. Does NOT call server.
- **Config → Restart/Clear Memory** → toast only.
- **Config → Refresh Status** → simulates tunnel URL "abc123.ngrok.io" after timeout. Does NOT call server.
- **GitHub → Connect** → REAL — calls `api.github.com` directly from browser.
- **GitHub → Pull** → REAL — calls `api.github.com`.
- **GitHub → Status** → REAL — calls `api.github.com`.
- **GitHub → Push** → FAKE — simulates a random commit hash. Does NOT push code.
- **Map** → REAL — Leaflet + OpenStreetMap tiles. GPS locate works if browser permits.
- **Health page** → NOT wired in demo. `refreshHealth()` is defined in first script block but second block doesn't override it — it just doesn't get live data.

---

## ARCHITECTURE

### Stack
- **Runtime**: Node.js (ESM), Express, ws
- **Port**: 3001
- **Frontend**: Single HTML file — `public/index.html`
- **Database**: SQLite via `sql.js` (in-memory, persisted manually)
- **Process manager**: PM2 (expected, not included in repo)
- **Tunnel**: ngrok via `modules/tunnel.js`

### Entry Point
`server.js` — imports all modules, starts HTTP + WS + Twilio Media Stream servers, boots memory and skills on startup.

---

## MODULES

| Module | File | Purpose |
|---|---|---|
| AI | `modules/ai.js` | OpenRouter → Claude. `chatWithClaude(history, onChunk, systemPrompt)` |
| Brain | `modules/brain.js` | Builds system prompts per mode (CHAT/CALL/COMMAND). `loadIdentity()`, `buildSystemPrompt()` |
| Memory | `modules/memory.js` | SQLite memory DB. `init()`, `store()`, `recall()`, `stats()`, `getIdentity()`, `getRecentEpisodic()`, `flushSession()`, `runCompaction()`, `workingAppend()`, `storeExplicit()` |
| Skills | `modules/skills.js` | Skill registry. `init()`, `list()`, `get()`, `run()`, `learn()`, `remove()`, `match()` |
| Calls | `modules/calls.js` | Twilio. `makeCall()`, `hangUp()`, `getActiveCalls()`, `handleIncoming()`, `handleMediaStream()` |
| ADB | `modules/adb.js` | `shell()`, `keyEvent()`, `tap()`, `swipe()`, `launchApp()`, `screenshot()`, `listApps()`, `getDeviceInfo()` |
| ZeroClaw | `modules/zeroclaw.js` | `pair()`, `setToken()`, `send()`, `status()`, `health()` |
| Search | `modules/search.js` | `search()` (Brave/SERP/DDG), `perplexityAsk()` |
| Browse | `modules/browse.js` | `fetch()`, `extract()`, `screenshot()`, `browse()`, `followLinks()`, `setBroadcast()` |
| Collector | `modules/collector.js` | `parseIntent()`, `run()`, `query()` |
| Research | `modules/research.js` | `detectGap()`, `research()`, `researchCaller()` |
| Tunnel | `modules/tunnel.js` | `startTunnel()`, `getPublicUrl()` |

---

## WEBSOCKET PROTOCOL

All messages are JSON `{ type, ...data }` over `ws://host:3001/ws`.

### Client → Server (what the UI sends)

| Message Type | Payload | What it does |
|---|---|---|
| `chat` | `{ text, image, useClaude }` | Send chat message. `useClaude=false` routes to ZeroClaw |
| `chat_clear` | — | Flush session memory, clear history |
| `call_make` | `{ to }` | Dial number via Twilio. Requires tunnel running |
| `call_hangup` | `{ callSid }` | Hang up call |
| `calls_list` | — | Get active calls |
| `adb_shell` | `{ command }` | Run shell command via ADB |
| `adb_device_info` | — | Get battery/model/screen/mem/storage/temp |
| `adb_key` | `{ keycode }` | Send keyevent (HOME/BACK/etc) |
| `adb_tap` | `{ x, y }` | Tap screen at coordinates |
| `adb_swipe` | `{ x1, y1, x2, y2 }` | Swipe gesture |
| `adb_launch` | `{ pkg, activity }` | Launch app |
| `adb_screenshot` | — | Capture screen → base64 PNG |
| `adb_list_apps` | `{ thirdParty }` | List installed packages |
| `zc_pair` | `{ code }` | Pair with ZeroClaw using 6-digit code |
| `zc_status` | — | Get ZeroClaw connection status |
| `zc_set_token` | `{ token }` | Set ZeroClaw auth token |
| `zc_send` | `{ message }` | Send message via ZeroClaw bridge |
| `memory_recall` | `{ query, limit }` | Semantic search of memory |
| `memory_store` | `{ content, source, importance, tags }` | Store a memory |
| `memory_stats` | — | Get counts per memory type |
| `memory_identity` | — | Get identity facts |
| `memory_recent` | `{ limit }` | Get recent episodic memories |
| `memory_compact` | — | Trigger nightly compaction |
| `web_search` | `{ query, provider, limit, freshness }` | Search via Brave/SERP/DDG |
| `perplexity_ask` | `{ query }` | Ask Perplexity |
| `web_fetch` | `{ url, maxChars }` | Fetch and parse a URL |
| `web_extract` | `{ url, schema }` | Extract structured data from URL |
| `web_screenshot` | `{ url }` | Screenshot a URL |
| `web_browse` | `{ instructions, startUrl, timeout }` | Playwright autonomous browse |
| `web_follow_links` | `{ url, goal, maxPages, sameDomain }` | Crawl links from URL |
| `collector_parse` | `{ message }` | Parse NL into job spec |
| `collector_run` | `{ topic, target, is_url, table, fields, follow_links, max_pages }` | Start a crawl job |
| `collector_push` | `{ table, rows }` | Push data to Supabase |
| `collector_query` | `{ table, limit, filter }` | Query collected data |
| `skills_list` | — | List all skills |
| `skills_get` | `{ name }` | Get a skill by name |
| `skills_run` | `{ name }` | Run/activate a skill |
| `skills_learn` | `{ skill }` | Store a new skill |
| `skills_delete` | `{ name }` | Delete a skill |
| `research` | `{ topic, depth, trigger }` | Run multi-page research |
| `research_caller` | `{ from, summary }` | Post-call auto-research on caller |
| `system_status` | — | Request full system state |
| `system_restart` | — | `process.exit(0)` — PM2 restarts |

### Server → Client (what the UI receives)

| Message Type | Payload | Meaning |
|---|---|---|
| `connected` | `{ msg }` | WS handshake confirmed |
| `system_state` | `{ tunnel, port, zeroclaw, memory, activeCalls, skills }` | Full state on connect |
| `chat_thinking` | — | Claude is processing |
| `chat_tool` | `{ name, input, status, result }` | Tool use in progress or done |
| `chat_chunk` | `{ chunk }` | Streaming token from Claude |
| `chat_done` | `{ text }` | Full response complete |
| `chat_error` | `{ error }` | Chat failed |
| `chat_cleared` | — | History wiped |
| `search_start` | `{ query, provider }` | Search initiated |
| `search_results` | `{ query, results, provider }` | Results array |
| `search_error` | `{ error }` | Search failed |
| `browse_fetching` | `{ url }` | Fetching URL |
| `browse_page` | `{ url, title, text, links, emails, phones, error }` | Parsed page content |
| `browse_action` | `{ action }` | Playwright step label |
| `browse_url` | `{ url }` | Current browser URL |
| `browse_screenshot` | `{ base64 }` | Screenshot from Playwright |
| `browse_done` | — | Browse session complete |
| `browse_error` | `{ error }` | Browse failed |
| `extract_done` | `{ data }` | Structured extract result |
| `collector_job_started` | `{ jobId, job }` | Crawl job begun |
| `collector_log` | `{ msg }` | Crawl progress log |
| `collector_url` | `{ url, status }` | Currently crawling this URL |
| `collector_extracted` | `{ count, rows }` | Batch of extracted records |
| `collector_push` | `{ count, table }` | Supabase push in progress |
| `collector_job_done` | `{ jobId, result }` | Crawl complete |
| `collector_job_error` | `{ jobId, error }` | Crawl failed |
| `research_started` | `{ topic }` | Research begun |
| `research_log` | `{ msg }` | Research progress |
| `research_done` | `{ topic, result }` | Research complete |
| `research_error` | `{ error }` | Research failed |
| `call_incoming` | `{ from, callSid }` | Inbound Twilio call |
| `call_started` | `{ callSid, from, to, dir }` | Call connected |
| `call_ended` | `{ callSid, from, summary }` | Call hung up |
| `call_transcript` | `{ role, text }` | Live transcript line (agent/caller) |
| `call_status` | `{ callSid, status }` | Twilio status callback |
| `call_initiated` | `{ callSid, to }` | Outbound dial confirmed |
| `adb_result` | `{ command, stdout, stderr }` | Shell output |
| `adb_ok` | `{ action, keycode }` | ADB action confirmed |
| `adb_device_info` | `{ info }` | Device stats object |
| `adb_apps` | `{ apps }` | Package list |
| `adb_screenshot` | `{ data }` | Base64 PNG |
| `zc_paired` | `{ token }` | ZeroClaw paired |
| `zc_status` | `{ online, paired }` | ZeroClaw status |
| `zc_token_set` | — | Token stored |
| `zc_chunk` | `{ chunk }` | Streaming from ZeroClaw |
| `zc_done` | `{ text }` | ZeroClaw response complete |
| `memory_stats` | `{ stats }` | Memory counts |
| `memory_results` | `{ results }` | Recall results |
| `memory_stored` | `{ id }` | Memory stored |
| `memory_identity` | `{ identity }` | Identity facts |
| `memory_recent` | `{ memories }` | Recent episodic entries |
| `memory_compacting` | — | Compaction started |
| `skills_list` | `{ skills }` | Skill array |
| `skill` | `{ skill }` | Single skill |
| `skill_instructions` | — | Skill run result |
| `skill_learned` | `{ skill }` | Skill stored |
| `skill_deleted` | `{ name }` | Skill removed |
| `error` | `{ error }` | Generic error |
| `system_restarting` | — | Server about to exit |

---

## REST ENDPOINTS

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Serve `public/index.html` |
| GET | `/fresh` | Cache-bust redirect to `/?v=timestamp` |
| GET | `/api/status` | Full system status JSON |
| GET | `/api/git` | Current git commit/branch/message |
| GET | `/api/memory/stats` | Memory counts |
| GET | `/api/memory/identity` | Identity facts |
| POST | `/api/call` | Initiate outbound call (body: `{ to }`) |
| POST | `/api/adb` | Run ADB shell command (body: `{ command }`) |
| POST | `/api/research` | Run research (body: `{ topic, depth }`) |
| POST | `/api/search` | Search (body: `{ query, provider }`) |
| POST | `/api/fetch` | Fetch URL (body: `{ url }`) |
| POST | `/calls/incoming` | Twilio webhook — inbound call TwiML |
| POST | `/calls/status` | Twilio status callback |
| WS | `/ws` | UI client WebSocket |
| WS | `/calls/stream` | Twilio Media Stream (Gemini Voice) |

---

## MEMORY DATABASE

SQLite via `sql.js`. Types stored:

| Type | Purpose |
|---|---|
| `episodic` | Conversation events, what happened |
| `semantic` | Facts and knowledge |
| `identity` | Persistent facts about the user (name, preferences, location) |
| `knowledge` | Learned domain knowledge |
| `compacted` | Summarised old episodic memories |
| `skills` | Learned skill definitions |

Auto-recalled on every chat message (top 6 by relevance). Auto-stored when message contains "remember this", "save this", or "note that". Session working memory flushed to DB on `chat_clear`.

---

## ENV VARS (`.env`)

| Var | Purpose |
|---|---|
| `PORT` | HTTP port (default 3001) |
| `OPENROUTER_API_KEY` | Claude via OpenRouter |
| `GEMINI_API_KEY` | Gemini Live voice |
| `BRAVE_API_KEY` | Brave search |
| `PERPLEXITY_API_KEY` | Perplexity |
| `SERP_API_KEY` | SerpAPI/Google |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anon key |
| `TWILIO_ACCOUNT_SID` | Twilio account |
| `TWILIO_AUTH_TOKEN` | Twilio auth |
| `TWILIO_PHONE_NUMBER` | Twilio outbound number |
| `ZEROCLAW_URL` | ZeroClaw server URL |
| `ZEROCLAW_TOKEN` | ZeroClaw auth token |
| `NGROK_AUTHTOKEN` | ngrok tunnel token |

---

## STARTUP SEQUENCE

1. `Memory.init()` — load SQLite DB
2. `Skills.init()` — load skill registry
3. `httpServer.listen(3001)` — start HTTP + WS
4. `startTunnel(3001)` — start ngrok, get public URL
5. `Brain.loadIdentity()` — load user identity from memory into system prompt
6. `ZeroClaw.health()` — check ZeroClaw connection

---

## PAGES — UI ELEMENTS & BACKEND CONNECTIONS

### CHAT

| Element | Real backend call | Notes |
|---|---|---|
| CLAUDE brain button | `chat` WS msg with `useClaude:true` | **OVERRIDDEN BY DEMO — sends nothing** |
| ZEROCLAW brain button | `chat` WS msg with `useClaude:false` | **OVERRIDDEN BY DEMO — sends nothing** |
| Send button / Enter | `chat` WS msg | **OVERRIDDEN BY DEMO — cycles fake responses** |
| Mic button | Web Speech API → fills textarea | **OVERRIDDEN BY DEMO — fills random preset** |
| Clear Chat | `chat_clear` WS msg | **OVERRIDDEN BY DEMO — local DOM clear only** |

Real chat flow (when WS connected and demo removed):
1. User sends → `chat` msg → server recalls memory → detects research gap → builds system prompt → streams Claude → stores to memory

### CALLS

| Element | Real backend call | Notes |
|---|---|---|
| CALL button | `call_make` WS msg | **OVERRIDDEN BY DEMO — fake call added locally** |
| END button | `call_hangup` WS msg | **OVERRIDDEN BY DEMO — local DOM remove** |
| Transcript | `call_transcript` WS events | **OVERRIDDEN BY DEMO — hardcoded lines** |
| Inbound call | `call_incoming` WS event from Twilio webhook | **OVERRIDDEN BY DEMO — fake call after 9 seconds** |

Real call flow:
- Inbound: Twilio hits `/calls/incoming` → TwiML → `/calls/stream` WS → Gemini Live STT → Claude decides → Gemini TTS
- Outbound: `call_make` → `Calls.makeCall()` → Twilio REST API → same stream flow

### WEB INTEL

| Element | Real backend call | Notes |
|---|---|---|
| Search (all providers) | `web_search` or `perplexity_ask` WS msg | **OVERRIDDEN BY DEMO — 2 hardcoded result sets** |
| Preview / Load URL | `web_fetch` WS msg | **OVERRIDDEN BY DEMO — fake extract animation + fake contact page** |
| Collect button (on result) | `collector_run` WS msg | **OVERRIDDEN BY DEMO — generates random fake rows** |
| Jobs → RUN | `collector_run` WS msg | **OVERRIDDEN BY DEMO — simulation** |
| Data → CSV | local blob download | **WORKS — exports whatever data is in memory** |
| Data → Supabase | `collector_push` WS msg | **OVERRIDDEN BY DEMO — fake timeout** |

### MAP

| Element | Real backend call | Notes |
|---|---|---|
| Leaflet map | None — Leaflet renders OSM tiles directly | **REAL** |
| ME / Locate | `navigator.geolocation.getCurrentPosition` | **REAL — falls back to Gold Coast coords** |
| Search/Geocode | `mapGeocode()` — **NOT IMPLEMENTED** in either script block | **BROKEN — function called but not defined** |
| Drop Pin | Leaflet marker added locally | **REAL** |
| Clear Pins | Leaflet markers removed locally | **REAL** |
| Street/Sat toggle | Leaflet tile layer swap | **REAL** |

### ADB

| Element | Real backend call | Notes |
|---|---|---|
| Device stats | `adb_device_info` WS msg | **OVERRIDDEN BY DEMO — hardcoded SM-N986B stats** |
| Refresh | same | **OVERRIDDEN BY DEMO** |
| All key buttons | `adb_key` WS msg | **OVERRIDDEN BY DEMO — logs fake cmd only** |
| Swipe | `adb_swipe` WS msg | **OVERRIDDEN BY DEMO** |
| Tap | `adb_tap` WS msg | **OVERRIDDEN BY DEMO** |
| APPS | `adb_list_apps` WS msg | **OVERRIDDEN BY DEMO — hardcoded 8 packages** |
| SHOT | `adb_screenshot` WS msg | **OVERRIDDEN BY DEMO — logs fake path** |
| Shell input | `adb_shell` WS msg | **OVERRIDDEN BY DEMO — `xdemo()` lookup table** |
| Arrow Up/Down | command history | **REAL — works in demo** |

Shell demo commands that return real-looking output: `getprop ro.product.model`, `getprop ro.build.version.release`, `date`, `whoami`, `pwd`, `uptime`, `zeroclaw status`, `zeroclaw --version`, `node --version`, `python3 --version`, `free -h`, `ls`. Everything else returns `[demo mode — connect server for live output]`.

### CONFIG

| Element | Real backend call | Notes |
|---|---|---|
| System status tiles | `system_status` WS msg | **OVERRIDDEN BY DEMO — refStatus() fakes tunnel URL** |
| ZeroClaw Pair | `zc_pair` WS msg | **OVERRIDDEN BY DEMO — fake pair after 1s** |
| Save Keys | none | **OVERRIDDEN BY DEMO — toast only, not sent to server** |
| Save Connection | none | **OVERRIDDEN BY DEMO — toast only** |
| Mode buttons | local badge only | **UI only, no server state** |
| GitHub Connect | `fetch api.github.com` | **REAL** |
| GitHub Push | fake setTimeout | **FAKE — does not push code** |
| GitHub Pull | `fetch api.github.com` | **REAL** |
| GitHub Status | `fetch api.github.com` | **REAL** |
| Clear Chat | `chat_clear` WS msg | **OVERRIDDEN BY DEMO — local only** |
| Clear Memory | toast only | **FAKE** |
| Restart | toast only | **FAKE** |

Token/repo/branch saved to `localStorage` keys: `gh_token`, `gh_repo`, `gh_branch`. Auto-restores and auto-connects on page load if saved.

### HEALTH

| Element | Real backend call | Notes |
|---|---|---|
| Refresh | `refreshHealth()` | Defined in first script block, calls `wsSend('system_status')` — second script block does NOT override this. **MAY WORK if WS connected** |
| Auto refresh | `toggleAutoRefresh()` | Polls every ~10s via `setInterval` |
| Health tiles | Updated via `system_state` WS event | Data comes from server on connect |
| Memory counts | Updated via `system_state` `memory` field | |
| Live log | `addHealthLog()` called throughout — local only | |
| RESTART | `healthAction('restart')` → `wsSend('system_restart')` | **REAL — server exits, PM2 restarts** |
| COMPACT MEM | `healthAction('compact')` → `wsSend('memory_compact')` | **REAL** |
| WIPE MEMORY | `healthAction('clearmem')` → not yet handled server-side | **NOT IMPLEMENTED in server switch** |
| CLEAR LOG | `innerHTML=''` | Local only |

### GITHUB FAB (floating button)

Same as Config → GitHub section. Dual implementation — both panels share the same underlying `ghConnect/ghPush/ghPull/ghStatus` logic pattern but with different element IDs (`ghFab*` vs `gh-*`).

---

## WHAT NEEDS FIXING TO MAKE IT REAL

1. **Remove the second `<script>` block** in `index.html` or merge it. It clobbers all the real WS-connected functions.
2. **`mapGeocode()`** is called from HTML but not defined anywhere. Add it.
3. **GitHub Push** is fake. Wire it to a real git operation on the server (new WS message `git_push`).
4. **Config → Save Keys** needs to send keys to server (new WS message or REST POST).
5. **Config → Clear Memory / Restart** buttons call `toast()` only. Wire to `wsSend('system_restart')` and `wsSend('memory_compact')` / a new `memory_wipe` message.
6. **Health → WIPE MEMORY** — `healthAction('clearmem')` sends WS but server has no case for it.
7. **`saveKeys()`** — locally updates Claude status indicator but doesn't persist keys to `.env` or server config.
8. **ZeroClaw token from Config** — `c-zct` input exists but `saveKeys()` doesn't read or send it.

---

## FILE STRUCTURE

```
ZeroKrangDroid/
├── server.js              # Entry point
├── package.json           # express, ws, twilio, sql.js, cors, dotenv
├── .env                   # API keys (not in repo)
├── public/
│   └── index.html         # Entire frontend (HTML + CSS + 2x JS blocks)
└── modules/
    ├── ai.js              # OpenRouter/Claude
    ├── brain.js           # System prompt builder
    ├── memory.js          # SQLite memory DB
    ├── skills.js          # Skill registry
    ├── calls.js           # Twilio voice + media streams
    ├── adb.js             # Android Debug Bridge
    ├── zeroclaw.js        # ZeroClaw bridge
    ├── search.js          # Brave/SERP/DDG/Perplexity
    ├── browse.js          # HTTP fetch + Playwright
    ├── collector.js       # Multi-page data collector
    ├── research.js        # Auto-research engine
    └── tunnel.js          # ngrok tunnel
```
