// 剧本工作台：多剧本管理、网页编辑与实时预览
// 数据目录 data/ 是独立 git 仓库，每个剧本一个子目录：data/<剧本>/{scenes,notes}
import http from 'node:http';
import fs from 'node:fs/promises';
import { watch, createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8444);
const DATA = path.resolve(process.env.SCREENPLAY_DATA || path.join(APP_DIR, 'data'));
const PUBLIC = path.join(APP_DIR, 'public');
const SUBDIRS = ['scenes', 'notes'];
const EXT = /\.(fountain|md|txt)$/i;
const COMMIT_DELAY_MS = 60_000;
const MAX_BODY = 5 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

// ---------- 工具函数 ----------
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');

function validName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 80 &&
    !name.startsWith('.') && !/[\\/\x00-\x1f:*?"<>|]/.test(name);
}

// 合法路径：<剧本>/<scenes|notes>/<文件>.fountain|md|txt
function safeRel(rel) {
  if (typeof rel !== 'string') return null;
  const parts = rel.split('/');
  if (parts.length !== 3) return null;
  const [script, dir, name] = parts;
  if (!validName(script) || !SUBDIRS.includes(dir) || !validName(name) || !EXT.test(name)) return null;
  return path.join(DATA, script, dir, name);
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('JSON 格式错误'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function git(args) {
  return new Promise((resolve) => {
    execFile('git', [
      '-c', 'user.name=screenplay-web', '-c', 'user.email=screenplay-web@localhost',
      '-c', 'core.quotepath=false', ...args,
    ], { cwd: DATA, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
}

async function ensureDataRepo() {
  await fs.mkdir(DATA, { recursive: true });
  if (!existsSync(path.join(DATA, '.git'))) {
    await git(['init', '-q']);
    await fs.writeFile(path.join(DATA, '.gitignore'), '.*.tmp\n', 'utf8');
    await git(['add', '.gitignore']);
    await git(['commit', '-q', '-m', '初始化剧本数据仓库']);
  }
}

// 合并提交：某个剧本最后一次变动后 COMMIT_DELAY_MS 再提交，每个剧本单独提交，日志互不混杂
const commitTimers = new Map();
const pendingFiles = new Map(); // script -> Set<fileInScript>
function scheduleCommit(script, file) {
  if (!pendingFiles.has(script)) pendingFiles.set(script, new Set());
  if (file) pendingFiles.get(script).add(file);
  clearTimeout(commitTimers.get(script));
  commitTimers.set(script, setTimeout(() => flushCommit(script), COMMIT_DELAY_MS));
}
async function flushCommit(script) {
  commitTimers.delete(script);
  const files = [...(pendingFiles.get(script) || [])];
  pendingFiles.delete(script);
  await git(['add', '-A', '--', `${script}/`]);
  const status = await git(['diff', '--cached', '--quiet', '--', `${script}/`]);
  if (!status.err) return; // 没有变化
  const label = files.length ? files.map((f) => f.split('/').pop().replace(EXT, '')).join('、') : '若干文件';
  const r = await git(['commit', '-q', '-m', `[${script}] 修改：${label}`, '--', `${script}/`]);
  if (r.err) console.error('git commit 失败', r.stderr);
}
async function flushAll() {
  for (const [script, t] of commitTimers) { clearTimeout(t); await flushCommit(script); }
}

async function writeAtomic(abs, content) {
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.tmp`);
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, abs);
}

function firstHeading(text) {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (/^\.[^.]/.test(t)) return t.slice(1).trim();
    if (/^(INT|EXT|EST|INT\.\/EXT|I\/E)[. ]/i.test(t)) return t;
    if (/^#\s+/.test(t)) return t.replace(/^#+\s+/, '');
  }
  return '';
}

// ---------- 数据查询 ----------
async function listScripts() {
  const entries = await fs.readdir(DATA, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || !validName(e.name)) continue;
    const scenes = await fs.readdir(path.join(DATA, e.name, 'scenes')).catch(() => []);
    out.push({ name: e.name, scenes: scenes.filter((n) => EXT.test(n) && !n.startsWith('.')).length });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));
  return out;
}

async function listFiles(script) {
  const out = [];
  for (const dir of SUBDIRS) {
    const abs = path.join(DATA, script, dir);
    const names = (await fs.readdir(abs).catch(() => [])).filter((n) => !n.startsWith('.') && EXT.test(n));
    names.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true }));
    for (const name of names) {
      const text = await fs.readFile(path.join(abs, name), 'utf8');
      out.push({ path: `${script}/${dir}/${name}`, dir, name, heading: firstHeading(text), version: sha(text) });
    }
  }
  return out;
}

async function gitLog(script, limit = 200) {
  const SEP = '\x1f';
  const r = await git(['log', `-n${limit}`, '--date=iso-strict', `--format=%x1e%H${SEP}%ad${SEP}%s`, '--name-status', '--', `${script}/`]);
  if (r.err) return [];
  return r.stdout.split('\x1e').filter((s) => s.trim()).map((block) => {
    const [head, ...rest] = block.split('\n');
    const [hash, date, subject] = head.split(SEP);
    const files = rest.filter(Boolean).map((l) => {
      const [st, ...ps] = l.split('\t');
      return { status: st[0], path: ps[ps.length - 1].replace(`${script}/`, '') };
    });
    return { hash, date, subject, files };
  });
}

// ---------- 实时推送 ----------
const clients = new Set();
function broadcast(evt) {
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of clients) res.write(line);
}

const watchTimers = new Map();
function startWatch() {
  watch(DATA, { recursive: true }, (_type, rel) => {
    if (!rel) return;
    rel = rel.split(path.sep).join('/');
    const parts = rel.split('/');
    if (parts[0].startsWith('.') || !validName(parts[0])) return;
    const script = parts[0];
    if (parts.length === 3 && (!EXT.test(parts[2]) || parts[2].startsWith('.'))) return;
    clearTimeout(watchTimers.get(rel));
    watchTimers.set(rel, setTimeout(async () => {
      watchTimers.delete(rel);
      let version = null;
      if (parts.length === 3) {
        try { version = sha(await fs.readFile(path.join(DATA, rel), 'utf8')); } catch { /* 已删除 */ }
        // 不管是网页还是外部工具改的，都纳入自动提交
        scheduleCommit(script, `${parts[1]}/${parts[2]}`);
      }
      broadcast({ type: 'changed', script, path: rel, version });
    }, 150));
  });
}

// ---------- API ----------
async function handleApi(req, res, url) {
  const q = url.searchParams;
  const mutating = req.method !== 'GET';
  // 防 CSRF：写操作必须带自定义头（跨站表单无法设置）
  if (mutating && req.headers['x-requested-with'] !== 'screenplay-web') {
    return send(res, 403, { error: '缺少请求头' });
  }
  const needScript = (name) => {
    if (!validName(name) || !existsSync(path.join(DATA, name))) {
      send(res, 404, { error: '剧本不存在' });
      return false;
    }
    return true;
  };

  if (url.pathname === '/api/scripts' && req.method === 'GET') {
    return send(res, 200, { scripts: await listScripts() });
  }

  if (url.pathname === '/api/scripts' && req.method === 'POST') {
    const { name } = await readBody(req);
    const clean = typeof name === 'string' ? name.trim() : '';
    if (!validName(clean)) return send(res, 400, { error: '剧本名不合法（不能含 / \\ : * ? " < > | 或以 . 开头）' });
    const dir = path.join(DATA, clean);
    if (existsSync(dir)) return send(res, 409, { error: '同名剧本已存在' });
    await fs.mkdir(path.join(dir, 'scenes'), { recursive: true });
    await fs.mkdir(path.join(dir, 'notes'), { recursive: true });
    await fs.writeFile(path.join(dir, 'notes', '00-logline.md'),
      '# Logline\n\n（一句话：谁，想要什么，被什么阻挡）\n', 'utf8');
    await fs.writeFile(path.join(dir, 'scenes', '001-开场.fountain'),
      `Title: ${clean}\nAuthor: \n\n.1 日 内 地点\n\n`, 'utf8');
    await git(['add', '-A', '--', `${clean}/`]);
    await git(['commit', '-q', '-m', `[${clean}] 新建剧本`, '--', `${clean}/`]);
    return send(res, 201, { ok: true, name: clean });
  }

  if (url.pathname === '/api/files' && req.method === 'GET') {
    if (!needScript(q.get('script'))) return;
    return send(res, 200, { files: await listFiles(q.get('script')) });
  }

  if (url.pathname === '/api/log' && req.method === 'GET') {
    if (!needScript(q.get('script'))) return;
    return send(res, 200, { commits: await gitLog(q.get('script')) });
  }

  if (url.pathname === '/api/diff' && req.method === 'GET') {
    const script = q.get('script');
    const commit = q.get('commit') || '';
    if (!needScript(script)) return;
    if (!/^[0-9a-f]{7,40}$/.test(commit)) return send(res, 400, { error: 'commit 不合法' });
    const r = await git(['show', '--format=', '-M', '--patch', commit, '--', `${script}/`]);
    if (r.err) return send(res, 404, { error: '找不到这个版本' });
    return send(res, 200, { diff: r.stdout.split(`${script}/`).join('') });
  }

  if (url.pathname === '/api/file' && req.method === 'GET') {
    const abs = safeRel(q.get('path'));
    if (!abs) return send(res, 400, { error: '路径不合法' });
    try {
      const content = await fs.readFile(abs, 'utf8');
      return send(res, 200, { content, version: sha(content) });
    } catch {
      return send(res, 404, { error: '文件不存在' });
    }
  }

  if (url.pathname === '/api/file' && req.method === 'PUT') {
    const body = await readBody(req);
    const abs = safeRel(body.path);
    if (!abs || typeof body.content !== 'string') return send(res, 400, { error: '参数不合法' });
    let current;
    try { current = await fs.readFile(abs, 'utf8'); } catch { return send(res, 404, { error: '文件不存在' }); }
    if (body.baseVersion && sha(current) !== body.baseVersion) {
      return send(res, 409, { error: '文件已被其他地方修改', content: current, version: sha(current) });
    }
    await writeAtomic(abs, body.content);
    return send(res, 200, { version: sha(body.content) });
  }

  if (url.pathname === '/api/file' && req.method === 'POST') {
    const body = await readBody(req);
    const abs = safeRel(body.path);
    if (!abs) return send(res, 400, { error: '文件名不合法' });
    if (!existsSync(path.join(DATA, body.path.split('/')[0]))) return send(res, 404, { error: '剧本不存在' });
    await fs.mkdir(path.dirname(abs), { recursive: true });
    try {
      await fs.writeFile(abs, typeof body.content === 'string' ? body.content : '', { encoding: 'utf8', flag: 'wx' });
    } catch (e) {
      if (e.code === 'EEXIST') return send(res, 409, { error: '同名文件已存在' });
      throw e;
    }
    return send(res, 201, { ok: true });
  }

  if (url.pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    res.write(': ok\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  return send(res, 404, { error: 'not found' });
}

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const abs = path.join(PUBLIC, path.normalize(rel));
  if (!abs.startsWith(PUBLIC + path.sep)) return send(res, 403, 'forbidden', 'text/plain');
  try {
    const st = await fs.stat(abs);
    if (!st.isFile()) throw new Error();
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    createReadStream(abs).pipe(res);
  } catch {
    send(res, 404, 'not found', 'text/plain');
  }
}

await ensureDataRepo();
startWatch();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else if (req.method === 'GET') await serveStatic(req, res, url);
    else send(res, 405, { error: 'method not allowed' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : '服务器错误' });
  }
});

async function shutdown() {
  await flushAll();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => console.log(`剧本工作台：http://${HOST}:${PORT}  数据目录 ${DATA}`));
