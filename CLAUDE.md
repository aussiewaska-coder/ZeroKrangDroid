# ADB Control Dashboard

## What this is
Local relay server (Express, port 3456) running on Mac.
Proxies ADB commands to USB-connected Android phone.
Handles SMS read/send via ADB content provider + Twilio.
Dashboard UI served at http://localhost:3456 (public/index.html).

## Stack
- server.js — Express relay, ADB exec proxy, Twilio SMS
- public/index.html — single-file dashboard UI

## Run
```
npm install
node server.js
```

## Skills
- **adb** (`/adb`): ADB device control reference. See ADB-SKILL.md.
