import { Fountain } from './fountain.bundle.js';

const $ = (sel, root = document) => root.querySelector(sel);
const FULL = '__full__';
const LOG = '__log__';
const SPECIAL = new Set([FULL, LOG]);
const SAVE_DELAY = 1200;
const isMobile = () => matchMedia('(max-width: 800px)').matches;
const isWide = () => matchMedia('(min-width: 1101px)').matches;

const state = {
  scripts: [],
  script: null,
  files: [],
  panes: [],
  active: 0,
};

// ---------- API ----------
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'screenplay-web' },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}
const enc = encodeURIComponent;
const getFile = (p) => api('GET', `api/file?path=${enc(p)}`);

// ---------- 渲染 ----------
const fountain = new Fountain();
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function renderFountain(text) {
  const out = fountain.parse(text || '');
  const title = out.html.title_page ? `<div class="title-page">${out.html.title_page}</div>` : '';
  return title + out.html.script;
}
function renderInto(pageEl, filePath, text) {
  pageEl.classList.remove('history');
  if (/\.fountain$/i.test(filePath)) {
    pageEl.classList.remove('markdown');
    pageEl.innerHTML = renderFountain(text) || '<p style="color:#999">（空白场景，开始写吧）</p>';
  } else {
    pageEl.classList.add('markdown');
    pageEl.innerHTML = escapeHtml(text || '');
  }
}
const shortName = (p) => p.split('/').pop().replace(/\.(fountain|md|txt)$/i, '');

// ---------- 剧本切换 ----------
function renderScriptSelect() {
  const sel = $('#script-select');
  sel.innerHTML = '';
  for (const s of state.scripts) {
    const o = document.createElement('option');
    o.value = s.name;
    o.textContent = s.name;
    sel.appendChild(o);
  }
  const add = document.createElement('option');
  add.value = '__new__';
  add.textContent = '＋ 新建剧本…';
  sel.appendChild(add);
  if (state.script) sel.value = state.script;
}

async function refreshScripts() {
  const r = await api('GET', 'api/scripts');
  if (r.ok) { state.scripts = r.data.scripts; renderScriptSelect(); }
}

async function newScript() {
  const name = prompt('新剧本的名字');
  if (!name || !name.trim()) { renderScriptSelect(); return; }
  const r = await api('POST', 'api/scripts', { name: name.trim() });
  if (!r.ok) { alert(r.data.error || '新建失败'); renderScriptSelect(); return; }
  await refreshScripts();
  await switchScript(r.data.name);
}

async function switchScript(name) {
  for (const p of state.panes) if (p.dirty) { clearTimeout(p.saveTimer); await save(p); }
  state.script = name;
  localStorage.setItem('script', name);
  renderScriptSelect();
  state.panes.forEach((p) => p.el.remove());
  state.panes = [];
  state.active = 0;
  $('#btn-compare').classList.remove('active');
  await refreshList();
  addPane();
  const saved = JSON.parse(localStorage.getItem(`layout:${name}`) || '[]');
  const valid = saved.filter((p) => SPECIAL.has(p) || state.files.some((f) => f.path === p));
  if (valid.length) {
    await openFile(valid[0]);
    if (valid[1] && !isMobile()) { toggleCompare(); await openFile(valid[1]); }
  } else {
    const first = state.files.find((f) => f.dir === 'scenes');
    if (first) await openFile(first.path);
    else if (isMobile()) document.body.classList.add('drawer-open');
  }
}

// ---------- 侧栏 ----------
function renderList() {
  const openPaths = new Set(state.panes.map((p) => p.path));
  for (const dir of ['scenes', 'notes']) {
    const ul = $(`#list-${dir}`);
    ul.innerHTML = '';
    for (const f of state.files.filter((x) => x.dir === dir)) {
      const li = document.createElement('li');
      if (openPaths.has(f.path)) li.classList.add('open');
      li.innerHTML = `<div class="fname"></div><div class="fhead"></div>`;
      li.querySelector('.fname').textContent = shortName(f.name);
      li.querySelector('.fhead').textContent = f.heading || '';
      li.onclick = () => { openFile(f.path); closeDrawer(); };
      const more = document.createElement('button');
      more.className = 'more';
      more.textContent = '⋯';
      more.title = '改名 / 删除';
      more.onclick = (e) => { e.stopPropagation(); fileMenu(f); };
      li.appendChild(more);
      ul.appendChild(li);
    }
  }
  $('#btn-full').classList.toggle('active', openPaths.has(FULL));
  $('#btn-log').classList.toggle('active', openPaths.has(LOG));
}
async function refreshList() {
  if (!state.script) return;
  const r = await api('GET', `api/files?script=${enc(state.script)}`);
  if (r.ok) { state.files = r.data.files; renderList(); }
}
const closeDrawer = () => document.body.classList.remove('drawer-open');

// ---------- 栏位 ----------
function defaultMode() { return isMobile() ? 'preview' : isWide() ? 'split' : 'edit'; }

function createPane() {
  const el = $('#tpl-pane').content.firstElementChild.cloneNode(true);
  const pane = { el, path: null, version: null, saved: '', dirty: false, saveTimer: null, renderTimer: null, remote: null };
  const editor = $('.editor', el);
  const page = $('.page', el);

  el.addEventListener('pointerdown', () => { state.active = state.panes.indexOf(pane); });
  el.querySelectorAll('.seg button').forEach((b) => (b.onclick = () => setMode(pane, b.dataset.mode)));
  $('.pane-close', el).onclick = () => closePane(pane);

  editor.addEventListener('input', () => {
    pane.dirty = editor.value !== pane.saved;
    setSaveState(pane, pane.dirty ? '未保存…' : '已保存');
    clearTimeout(pane.renderTimer);
    pane.renderTimer = setTimeout(() => renderInto(page, pane.path, editor.value), 120);
    clearTimeout(pane.saveTimer);
    if (pane.dirty) pane.saveTimer = setTimeout(() => save(pane), SAVE_DELAY);
  });
  editor.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); clearTimeout(pane.saveTimer); save(pane); }
  });

  $('.conflict', el).addEventListener('click', async (e) => {
    const act = e.target.dataset.act;
    if (!act || !pane.remote) return;
    if (act === 'theirs') {
      loadContent(pane, pane.remote.content, pane.remote.version);
    } else {
      pane.version = pane.remote.version;
      await save(pane);
    }
    pane.remote = null;
    $('.conflict', el).hidden = true;
  });

  page.addEventListener('click', (e) => {
    const link = e.target.closest('[data-open]');
    if (link) { openFile(link.dataset.open, { mode: isMobile() ? 'edit' : undefined }); return; }
    const commit = e.target.closest('[data-commit]');
    if (commit) { showDiff(pane, commit.dataset.commit, commit.dataset.subject); return; }
    if (e.target.closest('[data-back]')) showLog(pane);
  });

  return pane;
}

function setMode(pane, mode) {
  if (SPECIAL.has(pane.path)) mode = 'preview';
  if (mode === 'split' && !isWide()) mode = 'edit';
  pane.el.dataset.mode = mode;
  pane.el.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  if (pane.path && !SPECIAL.has(pane.path)) {
    localStorage.setItem('mode', mode);
    if (mode !== 'edit') renderInto($('.page', pane.el), pane.path, $('.editor', pane.el).value);
  }
}

function setSaveState(pane, text, err = false) {
  const s = $('.save-state', pane.el);
  s.textContent = text;
  s.classList.toggle('err', err);
}

function loadContent(pane, content, version) {
  pane.saved = content;
  pane.version = version;
  pane.dirty = false;
  const editor = $('.editor', pane.el);
  const pos = [editor.selectionStart, editor.selectionEnd, editor.scrollTop];
  editor.value = content;
  if (document.activeElement === editor) { editor.setSelectionRange(pos[0], pos[1]); editor.scrollTop = pos[2]; }
  const preview = $('.preview', pane.el);
  const st = preview.scrollTop;
  renderInto($('.page', pane.el), pane.path, content);
  preview.scrollTop = st;
  setSaveState(pane, '已保存');
}

async function save(pane) {
  if (!pane.path || SPECIAL.has(pane.path) || !pane.dirty) return;
  const content = $('.editor', pane.el).value;
  setSaveState(pane, '保存中…');
  const r = await api('PUT', 'api/file', { path: pane.path, content, baseVersion: pane.version });
  if (r.ok) {
    pane.saved = content;
    pane.version = r.data.version;
    pane.dirty = $('.editor', pane.el).value !== content;
    setSaveState(pane, pane.dirty ? '未保存…' : '已保存');
  } else if (r.status === 409) {
    showConflict(pane, r.data.content, r.data.version);
    setSaveState(pane, '有冲突', true);
  } else {
    setSaveState(pane, `保存失败：${r.data.error || r.status}`, true);
  }
}

function showConflict(pane, content, version) {
  pane.remote = { content, version };
  $('.conflict', pane.el).hidden = false;
}

// ---------- 全本 ----------
async function showFull(pane) {
  $('.pane-title', pane.el).textContent = '全本预览';
  const scenes = state.files.filter((f) => f.dir === 'scenes' && /\.fountain$/i.test(f.name));
  const texts = await Promise.all(scenes.map((f) => getFile(f.path).then((r) => (r.ok ? r.data.content : ''))));
  const page = $('.page', pane.el);
  page.classList.remove('markdown', 'history');
  page.innerHTML = scenes.map((f, i) =>
    `<div class="scene-link" data-open="${escapeHtml(f.path)}" title="点击编辑这一场">${renderFountain(texts[i])}</div>`,
  ).join('<hr class="scene-sep" />') || '<p style="color:#999">还没有场景</p>';
  setSaveState(pane, `${scenes.length} 场`);
}

// ---------- 历史 ----------
function fmtDate(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const STATUS = { A: '新增', M: '修改', D: '删除', R: '重命名' };

async function showLog(pane) {
  $('.pane-title', pane.el).textContent = `${state.script} · 修改历史`;
  const page = $('.page', pane.el);
  page.classList.remove('markdown');
  page.classList.add('history');
  page.innerHTML = '<p style="color:#999">加载中…</p>';
  const r = await api('GET', `api/log?script=${enc(state.script)}`);
  if (!r.ok) { page.innerHTML = `<p>加载失败：${escapeHtml(r.data.error || r.status)}</p>`; return; }
  const commits = r.data.commits;
  setSaveState(pane, `${commits.length} 次提交`);
  page.innerHTML = commits.map((c) => `
    <div class="commit" data-commit="${escapeHtml(c.hash)}" data-subject="${escapeHtml(c.subject)}">
      <div class="c-subject">${escapeHtml(c.subject)}</div>
      <div class="c-meta">${fmtDate(c.date)} · ${escapeHtml(c.hash.slice(0, 7))}</div>
      <div class="c-files">${c.files.map((f) => `${STATUS[f.status] || f.status} ${escapeHtml(shortName(f.path))}`).join('　')}</div>
    </div>`).join('') || '<p style="color:#999">还没有提交记录（编辑后约 1 分钟会自动提交）</p>';
}

async function showDiff(pane, hash, subject) {
  const page = $('.page', pane.el);
  page.innerHTML = '<p style="color:#999">加载中…</p>';
  const r = await api('GET', `api/diff?script=${enc(state.script)}&commit=${enc(hash)}`);
  if (!r.ok) { page.innerHTML = `<p>加载失败：${escapeHtml(r.data.error || r.status)}</p>`; return; }
  const lines = r.data.diff.split('\n').filter((l) => !/^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename from|rename to|\\ No newline)/.test(l));
  const html = lines.map((l) => {
    if (l.startsWith('diff --git')) {
      const m = l.match(/ b\/(.+)$/);
      return `<div class="d-file">📄 ${escapeHtml(m ? shortName(m[1]) : l)}</div>`;
    }
    if (l.startsWith('@@')) return `<div class="d-hunk">⋯</div>`;
    if (l.startsWith('+')) return `<div class="d-add">${escapeHtml(l)}</div>`;
    if (l.startsWith('-')) return `<div class="d-del">${escapeHtml(l)}</div>`;
    return `<div>${escapeHtml(l) || '&nbsp;'}</div>`;
  }).join('');
  page.innerHTML = `<span class="back" data-back>← 返回历史列表</span>
    <div class="c-subject">${escapeHtml(subject)}</div>
    <div class="c-meta">${escapeHtml(hash.slice(0, 7))}</div>
    <div class="diff">${html}</div>`;
  $('.preview', pane.el).scrollTop = 0;
}

// ---------- 打开文件 ----------
async function openFile(filePath, opts = {}) {
  if (!state.panes.length) addPane();
  const existing = state.panes.findIndex((p) => p.path === filePath);
  if (existing >= 0 && !SPECIAL.has(filePath)) {
    state.active = existing;
    if (opts.mode) setMode(state.panes[existing], opts.mode);
    return;
  }
  const pane = state.panes[Math.min(state.active, state.panes.length - 1)];
  if (pane.dirty) { clearTimeout(pane.saveTimer); await save(pane); }
  pane.remote = null;
  $('.conflict', pane.el).hidden = true;
  $('.seg', pane.el).style.display = SPECIAL.has(filePath) ? 'none' : '';

  if (SPECIAL.has(filePath)) {
    pane.path = filePath;
    pane.dirty = false;
    setMode(pane, 'preview');
    if (filePath === FULL) await showFull(pane);
    else await showLog(pane);
  } else {
    const r = await getFile(filePath);
    if (!r.ok) { alert(r.data.error || '打开失败'); return; }
    pane.path = filePath;
    $('.pane-title', pane.el).textContent = shortName(filePath);
    loadContent(pane, r.data.content, r.data.version);
    setMode(pane, opts.mode || localStorage.getItem('mode') || defaultMode());
  }
  pane.el.dataset.path = filePath;
  persistLayout();
  renderList();
}

function addPane() {
  const pane = createPane();
  state.panes.push(pane);
  $('#panes').appendChild(pane.el);
  $('.pane-title', pane.el).textContent = isMobile() ? '点左上角 ☰ 选场景' : '← 从左边选一个场景';
  setMode(pane, defaultMode());
  return pane;
}

async function closePane(pane) {
  if (state.panes.length <= 1) return;
  if (pane.dirty) { clearTimeout(pane.saveTimer); await save(pane); }
  pane.el.remove();
  state.panes.splice(state.panes.indexOf(pane), 1);
  state.active = 0;
  $('#btn-compare').classList.remove('active');
  persistLayout();
  renderList();
}

function toggleCompare() {
  if (state.panes.length >= 2) { closePane(state.panes[1]); return; }
  $('#btn-compare').classList.add('active');
  addPane();
  state.active = 1;
  state.panes.forEach((p) => { if (!SPECIAL.has(p.path) && p.el.dataset.mode === 'split') setMode(p, 'preview'); });
  persistLayout();
}

function persistLayout() {
  if (!state.script) return;
  localStorage.setItem(`layout:${state.script}`, JSON.stringify(state.panes.map((p) => p.path).filter(Boolean)));
}

// ---------- 新建场景 ----------
async function newScene() {
  if (!state.script) return;
  const name = prompt('新场景名（比如：天台对峙）');
  if (!name || !name.trim()) return;
  const clean = name.trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/^\.+/, '');
  if (!clean) return;
  const nums = state.files.filter((f) => f.dir === 'scenes').map((f) => parseInt(f.name, 10)).filter((n) => !isNaN(n));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  const file = `${state.script}/scenes/${String(next).padStart(3, '0')}-${clean}.fountain`;
  const r = await api('POST', 'api/file', { path: file, content: `.${next} 日 内 ${clean}\n\n` });
  if (!r.ok) { alert(r.data.error || '新建失败'); return; }
  await refreshList();
  openFile(file, { mode: 'edit' });
}

// ---------- 操作面板 ----------
function sheet(title, actions) {
  return new Promise((resolve) => {
    const mask = $('#sheet');
    $('.sheet-title', mask).textContent = title;
    const box = $('.sheet-actions', mask);
    box.innerHTML = '';
    const done = (key) => { mask.hidden = true; mask.onclick = null; resolve(key); };
    for (const a of [...actions, { key: null, label: '取消', cls: 'cancel' }]) {
      const b = document.createElement('button');
      b.textContent = a.label;
      if (a.cls) b.className = a.cls;
      b.onclick = (e) => { e.stopPropagation(); done(a.key); };
      box.appendChild(b);
    }
    mask.onclick = (e) => { if (e.target === mask) done(null); };
    mask.hidden = false;
  });
}

// ---------- 场景 / 笔记：改名、删除 ----------
function replacePanePath(oldPath, newPath) {
  for (const p of state.panes) {
    if (p.path !== oldPath) continue;
    if (newPath) {
      p.path = newPath;
      p.el.dataset.path = newPath;
      $('.pane-title', p.el).textContent = shortName(newPath);
    } else {
      p.path = null;
      p.dirty = false;
      clearTimeout(p.saveTimer);
      delete p.el.dataset.path;
      $('.editor', p.el).value = '';
      $('.page', p.el).innerHTML = '';
      $('.pane-title', p.el).textContent = '文件已删除';
      setSaveState(p, '');
    }
  }
  persistLayout();
}

async function fileMenu(f) {
  const kind = f.dir === 'scenes' ? '场景' : '笔记';
  const act = await sheet(shortName(f.name), [
    { key: 'rename', label: `重命名${kind}` },
    { key: 'delete', label: `删除${kind}`, cls: 'danger' },
  ]);
  if (act === 'rename') {
    const newName = prompt(`新的${kind}名（保留前面的编号可以维持排序）`, shortName(f.name));
    if (!newName || !newName.trim() || newName.trim() === shortName(f.name)) return;
    for (const p of state.panes) if (p.path === f.path && p.dirty) { clearTimeout(p.saveTimer); await save(p); }
    const r = await api('POST', 'api/rename', { path: f.path, newName: newName.trim() });
    if (!r.ok) { alert(r.data.error || '改名失败'); return; }
    replacePanePath(f.path, r.data.path);
    await refreshList();
  } else if (act === 'delete') {
    if (!confirm(`确定删除「${shortName(f.name)}」吗？\n（修改历史里还能找回）`)) return;
    const r = await api('DELETE', `api/file?path=${enc(f.path)}`);
    if (!r.ok) { alert(r.data.error || '删除失败'); return; }
    replacePanePath(f.path, null);
    await refreshList();
  }
}

// ---------- 剧本：改名、删除（删除藏在二级入口 + 输入全名确认） ----------
async function scriptMenu() {
  if (!state.script || state.busy) return;
  state.busy = true;
  try { await scriptMenuInner(); } finally { setTimeout(() => { state.busy = false; }, 500); }
}
async function scriptMenuInner() {
  const act = await sheet(`📖 ${state.script}`, [
    { key: 'rename', label: '重命名剧本' },
    { key: 'danger', label: '删除这个剧本…', cls: 'quiet' },
  ]);
  if (act === 'rename') {
    const newName = prompt('新的剧本名', state.script);
    if (!newName || !newName.trim() || newName.trim() === state.script) return;
    for (const p of state.panes) if (p.dirty) { clearTimeout(p.saveTimer); await save(p); }
    const old = state.script;
    const r = await api('PATCH', 'api/scripts', { name: old, newName: newName.trim() });
    if (!r.ok) { alert(r.data.error || '改名失败'); return; }
    const layout = JSON.parse(localStorage.getItem(`layout:${old}`) || '[]')
      .map((p) => (p.startsWith(`${old}/`) ? r.data.name + p.slice(old.length) : p));
    localStorage.setItem(`layout:${r.data.name}`, JSON.stringify(layout));
    localStorage.removeItem(`layout:${old}`);
    state.script = null;
    await refreshScripts();
    await switchScript(r.data.name);
  } else if (act === 'danger') {
    const sure = await sheet(`删除「${state.script}」会移除它的全部场景和笔记`, [
      { key: 'go', label: '我确定，继续删除', cls: 'danger' },
    ]);
    if (sure !== 'go') return;
    const typed = prompt(`最后一步：请完整输入剧本名「${state.script}」来确认删除`);
    if (typed !== state.script) { if (typed !== null) alert('名字不一致，已取消'); return; }
    const name = state.script;
    state.panes.forEach((p) => { p.dirty = false; clearTimeout(p.saveTimer); });
    const r = await api('DELETE', 'api/scripts', { name, confirm: typed });
    if (!r.ok) { alert(r.data.error || '删除失败'); return; }
    localStorage.removeItem(`layout:${name}`);
    await onScriptsChanged(true);
  }
}

async function onScriptsChanged(force = false) {
  await refreshScripts();
  if (state.script && state.scripts.some((s) => s.name === state.script) && !force) return;
  // 当前剧本不存在了：切到第一个剧本，或显示空状态
  const next = state.scripts[0]?.name;
  if (next) { await switchScript(next); return; }
  state.script = null;
  state.files = [];
  state.panes.forEach((p) => p.el.remove());
  state.panes = [];
  renderList();
  renderScriptSelect();
  addPane();
  $('.pane-title', state.panes[0].el).textContent = '还没有剧本，点上面的下拉框新建一个';
}

// ---------- 实时同步 ----------
let logRefreshTimer = null;
function listenChanges() {
  const es = new EventSource('api/events');
  es.onmessage = async (e) => {
    const evt = JSON.parse(e.data);
    if (evt.type === 'scripts') { if (!state.busy) onScriptsChanged(); return; }
    if (evt.type !== 'changed') return;
    if (evt.script !== state.script) { refreshScripts(); return; }
    refreshList();
    for (const pane of state.panes) {
      if (pane.path === FULL) { showFull(pane); continue; }
      if (pane.path === LOG) {
        // 自动提交有约 1 分钟延迟，稍后刷新历史列表
        clearTimeout(logRefreshTimer);
        logRefreshTimer = setTimeout(() => {
          if (pane.path === LOG && !$('[data-back]', pane.el)) showLog(pane);
        }, 65_000);
        continue;
      }
      if (pane.path !== evt.path || evt.version === pane.version) continue;
      if (evt.version === null) { setSaveState(pane, '文件已被删除', true); continue; }
      const r = await getFile(pane.path);
      if (!r.ok || r.data.version === pane.version) continue;
      if (pane.dirty) showConflict(pane, r.data.content, r.data.version);
      else loadContent(pane, r.data.content, r.data.version);
    }
  };
}

// ---------- 启动 ----------
$('#btn-menu').onclick = () => document.body.classList.toggle('drawer-open');
$('#backdrop').onclick = closeDrawer;
$('#btn-new').onclick = newScene;
$('#btn-compare').onclick = toggleCompare;
$('#btn-full').onclick = () => openFile(FULL);
$('#btn-log').onclick = () => openFile(LOG);
$('#btn-script-menu').onclick = scriptMenu;
$('#script-select').onchange = (e) => {
  if (e.target.value === '__new__') newScript();
  else switchScript(e.target.value);
};
window.addEventListener('beforeunload', (e) => {
  if (state.panes.some((p) => p.dirty)) { state.panes.forEach(save); e.preventDefault(); }
});
matchMedia('(max-width: 800px)').addEventListener('change', (e) => {
  if (e.matches && state.panes.length > 1) closePane(state.panes[1]);
});

await refreshScripts();
listenChanges();
const last = localStorage.getItem('script');
const initial = state.scripts.find((s) => s.name === last)?.name || state.scripts[0]?.name;
if (initial) await switchScript(initial);
else {
  addPane();
  $('.pane-title', state.panes[0].el).textContent = '还没有剧本，点上面的下拉框新建一个';
}
