import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA = process.env.DATA_DIR || '/data';
const URL = process.env.PERSISTENCE_URL || '';
const KEY = process.env.PERSISTENCE_KEY || '';
const INTERVAL_MS = Math.max(1000, +(process.env.PERSISTENCE_INTERVAL_MS || 3000) || 3000);

const hashes = new Map();
let syncing = false;
let started = false;

function enabled() {
  return Boolean(URL && KEY);
}

function safeRel(rel) {
  const normalized = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..')) return null;
  return normalized;
}

async function call(body) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-opengym-key': KEY,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`persistence ${res.status}: ${await res.text()}`);
  return res.json();
}

function isPersistentPath(rel) {
  return rel === 'secret' ||
    rel === 'db.json' ||
    rel === 'vapid.json' ||
    rel === 'coach.json' ||
    /^state-[a-zA-Z0-9_-]+\.json$/.test(rel) ||
    /^coach\/[a-zA-Z0-9_-]+\.json$/.test(rel) ||
    rel === 'codex/auth.json' ||
    rel === 'codex/config.toml';
}

function walk(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, base, out);
    else if (ent.isFile() && !ent.name.endsWith('.tmp')) {
      const rel = safeRel(path.relative(base, full));
      if (rel && isPersistentPath(rel)) out.push(full);
    }
  }
  return out;
}

function digest(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function restoreRemote() {
  const payload = await call({ action: 'list' });
  const objects = Array.isArray(payload?.objects) ? payload.objects : [];
  fs.mkdirSync(DATA, { recursive: true });

  for (const obj of objects) {
    const rel = safeRel(String(obj.path || ''));
    if (!rel || !isPersistentPath(rel)) continue;
    const full = path.join(DATA, rel);
    if (!full.startsWith(path.resolve(DATA) + path.sep) && full !== path.resolve(DATA)) continue;
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, String(obj.content ?? ''), { mode: 0o600 });
    hashes.set(rel, digest(String(obj.content ?? '')));
  }
}

export async function syncPersistence() {
  if (!enabled() || syncing) return;
  syncing = true;
  try {
    const seen = new Set();
    for (const full of walk(DATA)) {
      const rel = safeRel(path.relative(DATA, full));
      if (!rel) continue;
      seen.add(rel);
      const content = fs.readFileSync(full, 'utf8');
      const hash = digest(content);
      if (hash === hashes.get(rel)) continue;
      await call({ action: 'put', path: rel, content, content_type: 'text/plain' });
      hashes.set(rel, hash);
    }

    for (const rel of [...hashes.keys()]) {
      if (seen.has(rel)) continue;
      await call({ action: 'delete', path: rel });
      hashes.delete(rel);
    }
  } finally {
    syncing = false;
  }
}

export async function initializePersistence() {
  if (started || !enabled()) return;
  started = true;
  await restoreRemote();
  await syncPersistence();

  const timer = setInterval(() => {
    syncPersistence().catch(err => console.error('persistence sync failed:', err.message));
  }, INTERVAL_MS);
  timer.unref?.();

  const flush = () => syncPersistence().catch(() => {});
  process.once('SIGTERM', flush);
  process.once('SIGINT', flush);
}
