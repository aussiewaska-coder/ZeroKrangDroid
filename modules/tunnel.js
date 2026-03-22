// modules/tunnel.js — ngrok auto-start
// Starts ngrok, returns public URL

import { exec } from 'child_process';

let publicUrl = null;

export async function startTunnel(port) {
  // Kill any existing ngrok
  await new Promise(r => exec('pkill ngrok', () => r()));
  await sleep(800);

  return new Promise((resolve, reject) => {
    const authtoken = process.env.NGROK_AUTHTOKEN;
    if (!authtoken) return reject(new Error('NGROK_AUTHTOKEN not set'));

    // Start ngrok
    const proc = exec(`ngrok http ${port} --authtoken=${authtoken} --log=stdout`);

    let attempts = 0;
    const check = setInterval(async () => {
      attempts++;
      if (attempts > 20) {
        clearInterval(check);
        reject(new Error('ngrok did not start in time'));
        return;
      }
      try {
        const url = await getTunnelUrl();
        if (url) {
          clearInterval(check);
          publicUrl = url;
          console.log(`🌐 Tunnel: ${url}`);
          resolve(url);
        }
      } catch {}
    }, 1000);

    proc.on('error', (e) => { clearInterval(check); reject(e); });
  });
}

async function getTunnelUrl() {
  const r = await fetch('http://localhost:4040/api/tunnels', {
    signal: AbortSignal.timeout(2000)
  });
  const data = await r.json();
  const https = data.tunnels?.find(t => t.proto === 'https');
  return https?.public_url || null;
}

export function getPublicUrl() { return publicUrl; }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
