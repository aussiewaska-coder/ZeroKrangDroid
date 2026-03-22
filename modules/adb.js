// modules/adb.js — ADB shell bridge
// Runs adb commands via child_process, returns output

import { exec, execFile } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const TIMEOUT = 15000;

// ─────────────────────────────────────────────────
// SHELL
// ─────────────────────────────────────────────────
export async function shell(command) {
  try {
    const { stdout, stderr } = await execAsync(`adb shell ${command}`, {
      timeout: TIMEOUT,
      maxBuffer: 1024 * 1024
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (e) {
    return { ok: false, stdout: '', stderr: e.message };
  }
}

// ─────────────────────────────────────────────────
// DEVICE INFO
// ─────────────────────────────────────────────────
export async function getDeviceInfo() {
  const [model, android, battery, screen, mem, storage] = await Promise.all([
    shell('getprop ro.product.model'),
    shell('getprop ro.build.version.release'),
    shell('dumpsys battery | grep -E "level|status|temperature"'),
    shell('wm size'),
    shell('cat /proc/meminfo | grep -E "MemTotal|MemFree|MemAvailable"'),
    shell('df /data | tail -1'),
  ]);

  // Parse battery
  const battLevel = battery.stdout.match(/level:\s*(\d+)/)?.[1];
  const battStatus = battery.stdout.match(/status:\s*(\d+)/)?.[1];
  const battTemp = battery.stdout.match(/temperature:\s*(\d+)/)?.[1];
  const statusMap = { '1': 'unknown', '2': 'charging', '3': 'discharging', '4': 'not charging', '5': 'full' };

  // Parse memory
  const memTotal = mem.stdout.match(/MemTotal:\s*(\d+)/)?.[1];
  const memAvail = mem.stdout.match(/MemAvailable:\s*(\d+)/)?.[1];

  // Parse storage
  const storageParts = storage.stdout.trim().split(/\s+/);

  return {
    model: model.stdout,
    android: android.stdout,
    battery: {
      level: battLevel ? parseInt(battLevel) : null,
      status: statusMap[battStatus] || 'unknown',
      temp: battTemp ? (parseInt(battTemp) / 10).toFixed(1) + '°C' : null
    },
    screen: screen.stdout.replace('Physical size:', '').trim(),
    memory: {
      total: memTotal ? Math.round(parseInt(memTotal) / 1024) + ' MB' : null,
      available: memAvail ? Math.round(parseInt(memAvail) / 1024) + ' MB' : null
    },
    storage: {
      size: storageParts[1] || null,
      used: storageParts[2] || null,
      free: storageParts[3] || null
    }
  };
}

// ─────────────────────────────────────────────────
// INPUT
// ─────────────────────────────────────────────────
export const tap = (x, y) => shell(`input tap ${x} ${y}`);
export const swipe = (x1, y1, x2, y2, dur = 300) => shell(`input swipe ${x1} ${y1} ${x2} ${y2} ${dur}`);
export const keyEvent = (keycode) => shell(`input keyevent ${keycode}`);
export const typeText = (text) => shell(`input text "${text.replace(/"/g, '\\"')}"`);

export const home = () => keyEvent('KEYCODE_HOME');
export const back = () => keyEvent('KEYCODE_BACK');
export const recents = () => keyEvent('KEYCODE_APP_SWITCH');
export const power = () => keyEvent('KEYCODE_POWER');
export const volumeUp = () => keyEvent('KEYCODE_VOLUME_UP');
export const volumeDown = () => keyEvent('KEYCODE_VOLUME_DOWN');

// ─────────────────────────────────────────────────
// APPS
// ─────────────────────────────────────────────────
export const launchApp = (pkg, activity = '') =>
  shell(`am start -n ${pkg}${activity ? '/' + activity : ''}`);

export const launchUrl = (url) =>
  shell(`am start -a android.intent.action.VIEW -d "${url}"`);

export async function listApps(thirdParty = true) {
  const r = await shell(`pm list packages${thirdParty ? ' -3' : ''}`);
  return r.stdout.split('\n').map(l => l.replace('package:', '').trim()).filter(Boolean);
}

export const uninstall = (pkg) => shell(`pm uninstall ${pkg}`);

// ─────────────────────────────────────────────────
// SCREENSHOT
// ─────────────────────────────────────────────────
export async function screenshot() {
  const path = '/sdcard/zk_screen.png';
  const r = await shell(`screencap -p ${path}`);
  if (!r.ok) return null;
  // Pull to termux tmp
  try {
    const { stdout } = await execAsync(`adb pull ${path} /tmp/zk_screen.png`, { timeout: 10000 });
    return '/tmp/zk_screen.png';
  } catch (e) {
    return null;
  }
}

// ─────────────────────────────────────────────────
// PHONE CALLS via ADB (native dialler)
// ─────────────────────────────────────────────────
export const dial = (number) => shell(`am start -a android.intent.action.CALL -d tel:${number}`);
export const answerCall = () => keyEvent('KEYCODE_CALL');
export const endCall = () => keyEvent('KEYCODE_ENDCALL');
