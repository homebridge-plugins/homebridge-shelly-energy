// The settings page's server side, without the Homebridge UI library (so it can be tested on its own): passes each request
// from the page to the running plugin over its local link (lib/control.js), and splits large files into pieces, because the
// Homebridge UI's connection to the page is meant for small messages.
import crypto from 'node:crypto';
import path from 'node:path';
import { callPlugin } from '../lib/control.js';

const SLOW = { shellyFind: 120000 }; // actions that take longer than the usual 20 s
const PIECE = 256 * 1024, MAX_FILE = 80 * 1024 * 1024, KEEP = 10 * 60e3;
export const ACTIONS = new Set(['view', 'summary', 'setSettings', 'editSig', 'forgetSig', 'nameCluster', 'dismiss', 'track', 'untrack', 'estWatts', 'estReset',
  'keepSteps', 'forgetLearned', 'hideDevice', 'dismissAnomaly', 'dismissTip', 'matterAdd', 'matterRetry', 'matterRemove', 'importBackup', 'shellyFind', 'nameCycle', 'forgetCycle',
  'webSetPin', 'webSet', 'webSignOutAll']); // web*: only from the Homebridge UI, never from the web page itself (lib/web.js)

export function makeHandlers(storagePath, call = callPlugin, allowed = ACTIONS) {
  const dataDir = path.join(storagePath, 'home-energy');
  const uploads = new Map(), downloads = new Map();
  const tidy = () => { const t = Date.now() - KEEP; for (const m of [uploads, downloads]) for (const [k, v] of m) if (v.at < t) m.delete(k); };
  const fail = (m) => { throw new Error(m); };
  return {
    '/call': async ({ action, args } = {}) => {
      if (!allowed.has(action)) fail('Unknown action');
      try { return { ok: true, result: await call(dataDir, action, args || {}, SLOW[action]) }; }
      catch (e) { return { ok: false, error: e.message, notRunning: !!e.notRunning }; }
    },
    // a file chosen on the page, sent in pieces: start -> piece × n -> finish (which imports it)
    '/upload/start': async ({ size, name } = {}) => {
      tidy(); if (!(size > 0) || size > MAX_FILE) fail('That file is too large to be an export.');
      const id = crypto.randomBytes(8).toString('hex'); uploads.set(id, { parts: [], size: +size, name: String(name || '').slice(0, 80), at: Date.now() }); return { id, piece: PIECE };
    },
    '/upload/piece': async ({ id, i, data } = {}) => {
      const u = uploads.get(id); if (!u) fail('The upload expired; choose the file again.');
      if (typeof data !== 'string' || data.length > PIECE * 2 || !Number.isInteger(i) || i < 0 || i > 1000) fail('Bad piece');
      u.parts[i] = data; u.at = Date.now(); return true;
    },
    '/upload/finish': async ({ id } = {}) => {
      const u = uploads.get(id); uploads.delete(id); if (!u) fail('The upload expired; choose the file again.');
      const text = u.parts.join(''); let data;
      try { data = JSON.parse(text); } catch { return { ok: false, error: 'That file isn\'t a backup (it isn\'t JSON).' }; }
      try { return { ok: true, result: await call(dataDir, 'importFile', { data, name: u.name }, 120000) }; }
      catch (e) { return { ok: false, error: e.message, notRunning: !!e.notRunning }; }
    },
    // this plugin's own data as a file, fetched in pieces
    '/export/start': async () => {
      tidy();
      try {
        const { savedAs, ...data } = await call(dataDir, 'exportData', {}, 60000);
        const text = JSON.stringify(data), id = crypto.randomBytes(8).toString('hex');
        downloads.set(id, { text, at: Date.now() }); return { ok: true, id, n: Math.ceil(text.length / PIECE), savedAs, folder: path.join(dataDir, 'backups') };
      } catch (e) { return { ok: false, error: e.message, notRunning: !!e.notRunning }; }
    },
    '/export/piece': async ({ id, i } = {}) => {
      const d = downloads.get(id); if (!d) fail('The download expired; try again.');
      const part = d.text.slice(i * PIECE, (i + 1) * PIECE); if ((i + 1) * PIECE >= d.text.length) downloads.delete(id); return part;
    },
  };
}
