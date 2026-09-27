import { Fountain, marked, DOMPurify } from './vendor.bundle.js';

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
  // 备注 [[...]] 默认被渲染成 HTML 注释，这里改成可见的黄色标签（内容已由解析器转义）
  const script = out.html.script.replace(/<!--([\s\S]*?)-->/g, (_, t) => `<span class="note-inline">💬 ${t.trim()}</span>`);
  return title + script;
}
function renderInto(pageEl, filePath, text) {
  pageEl.classList.remove('history');
  if (/\.fountain$/i.test(filePath)) {
    pageEl.classList.remove('markdown', 'md');
    pageEl.innerHTML = renderFountain(text) || '<p style="color:#999">（空白场景，开始写吧）</p>';
  } else if (/\.md$/i.test(filePath)) {
    pageEl.classList.remove('markdown');
    pageEl.classList.add('md');
    pageEl.innerHTML = DOMPurify.sanitize(marked.parse(text || '', { gfm: true, breaks: true }));
  } else {
    pageEl.classList.remove('md');
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
  const toolbar = $('.toolbar', el);
  // 按下时阻止默认行为，避免输入框失焦、手机键盘收起
  toolbar.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  toolbar.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-fmt]');
    if (b && pane.path && !SPECIAL.has(pane.path)) applyFormat(pane, b.dataset.fmt);
  });

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
  page.classList.remove('markdown', 'md', 'history');
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
  page.classList.remove('markdown', 'md');
  page.classList.add('history');
  page.innerHTML = '<p style="color:#999">加载中…</p>';
  const r = await api('GET', `api/log?script=${enc(state.script)}`);
  if (!r.ok) { page.innerHTML = `<p>加载失败：${escapeHtml(r.data.error || r.status)}</p>`; return; }
  if (r.data.gitAvailable === false) { page.innerHTML = '<p style="color:#999">服务器没有安装 git，暂时无法记录修改历史</p>'; setSaveState(pane, ''); return; }
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

// ---------- 新建笔记 ----------
const NOTE_TEMPLATES = {
  blank: (name) => `# ${name}\n\n`,
  character: (name) => `# ${name}

## 基本信息
| 项目 | 内容 |
| --- | --- |
| 姓名 |  |
| 年龄 |  |
| 职业 |  |
| 一句话形容 |  |

## 想要什么（外在目标）
他/她在故事里主动追求的东西。

## 真正需要什么（内在需求）
他/她自己可能都没意识到、但必须得到或领悟的东西。

## 缺陷与伤痕
过去发生过什么，让他/她变成现在这样。

## 人物弧光
- 开场时：
- 转折点：
- 结尾时：

## 人物关系
- 

## 标志性细节
口头禅、小动作、随身物品……
`,
  outline: (name) => `# ${name}

| 场次 | 时间 / 地点 | 发生了什么 | 作用（铺垫 / 转折 / 呼应） |
| --- | --- | --- | --- |
| 1 |  |  |  |
| 2 |  |  |  |
| 3 |  |  |  |

## 伏笔清单
- [ ] 伏笔：　　　→ 回收于第　场
`,
  world: (name) => `# ${name}

## 时代与地点
故事发生在什么时候、什么地方。

## 核心设定
和现实世界最不一样的一点是什么。

## 规则与代价
这个设定怎么运作？使用它要付出什么代价？

## 势力与组织
- 

## 日常细节
普通人在这个世界里怎么生活。
`,
};

async function newNote() {
  if (!state.script) return;
  const kind = await sheet('新建笔记', [
    { key: 'blank', label: '📝 空白笔记' },
    { key: 'character', label: '👤 人物小传' },
    { key: 'outline', label: '🗂 分场大纲' },
    { key: 'world', label: '🌍 世界观设定' },
  ]);
  if (!kind) return;
  const defaults = { blank: '', character: '人物小传-', outline: '分场大纲', world: '世界观设定' };
  const name = prompt('笔记名', defaults[kind]);
  if (!name || !name.trim()) return;
  const clean = name.trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/^\.+/, '');
  if (!clean) return;
  const nums = state.files.filter((f) => f.dir === 'notes').map((f) => parseInt(f.name, 10)).filter((n) => !isNaN(n));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  const file = `${state.script}/notes/${String(next).padStart(2, '0')}-${clean}.md`;
  const r = await api('POST', 'api/file', { path: file, content: NOTE_TEMPLATES[kind](clean) });
  if (!r.ok) { alert(r.data.error || '新建失败'); return; }
  await refreshList();
  closeDrawer();
  openFile(file, { mode: isMobile() ? 'edit' : undefined });
}

// ---------- 格式工具栏 ----------
const CHEATSHEET = `<table>
<tr><td>🎬 场景</td><td><code>.1 夜 内 便利店</code> 以英文句点开头，写场次、时间、内/外景、地点</td></tr>
<tr><td>📝 动作</td><td>普通的一段话，写画面里发生了什么。上下各空一行</td></tr>
<tr><td>🗣 角色台词</td><td><code>@小林</code> 角色名以 @ 开头单独一行，下一行紧跟台词，中间不空行</td></tr>
<tr><td>( ) 语气</td><td><code>(低声)</code> 放在角色名和台词之间，写语气或小动作</td></tr>
<tr><td>⇆ 同时说</td><td><code>@阿美 ^</code> 角色名后加 ^，和上一句台词左右并排</td></tr>
<tr><td>➡ 转场</td><td><code>&gt; 切至：</code> 以 &gt; 开头，靠右显示</td></tr>
<tr><td>≡ 居中</td><td><code>&gt; 三年后 &lt;</code> 两边用 &gt; &lt; 包住</td></tr>
<tr><td>♪ 歌词</td><td><code>~歌词</code> 以 ~ 开头</td></tr>
<tr><td>B I U</td><td><code>**粗体**</code> <code>*斜体*</code> <code>_下划线_</code></td></tr>
<tr><td>💬 备注</td><td><code>[[还要再改]]</code> 写给自己看的，正式剧本不会出现</td></tr>
<tr><td>📑 分幕 / ✎ 提要</td><td><code># 第一幕</code> <code>= 内容提要</code> 用来整理结构，预览里不显示</td></tr>
<tr><td>✂ 分页</td><td><code>===</code> 单独一行，强制换页</td></tr>
<tr><td>📄 标题页</td><td><code>Title: 剧名</code> <code>Author: 作者</code> 放在文件最开头</td></tr>
</table>
<p>小技巧：不同段落之间空一行；插入后自动选中的灰字，直接打字就能替换。</p>`;

function sceneCount(text, upto) {
  return text.slice(0, upto).split('\n').filter((l) => /^\.[^.]/.test(l.trim())).length;
}

// 在光标处插入文本，尽量走 execCommand 以保留撤销记录
function insertAt(editor, pos, text) {
  editor.focus();
  editor.setSelectionRange(pos, pos);
  const ok = document.execCommand && document.execCommand('insertText', false, text);
  if (!ok) {
    editor.setRangeText(text, pos, pos, 'end');
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  }
}
function replaceSelection(editor, start, end, text) {
  editor.focus();
  editor.setSelectionRange(start, end);
  const ok = document.execCommand && document.execCommand('insertText', false, text);
  if (!ok) {
    editor.setRangeText(text, start, end, 'end');
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  }
}
const lineEnd = (v, p) => { const i = v.indexOf('\n', p); return i < 0 ? v.length : i; };
const lineStart = (v, p) => v.lastIndexOf('\n', p - 1) + 1;

// 插入独立段落：自动补齐前后空行，并选中占位文字
function insertBlock(editor, block, placeholder) {
  const v = editor.value;
  let pos = editor.selectionStart;
  if (v.slice(lineStart(v, pos), lineEnd(v, pos)).trim()) pos = lineEnd(v, pos);
  const before = v.slice(0, pos);
  const after = v.slice(pos);
  const prefix = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const suffix = after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : after === '' ? '\n' : '\n\n';
  insertAt(editor, pos, prefix + block + suffix);
  selectPlaceholder(editor, pos + prefix.length, block, placeholder);
}
// 插入紧跟当前行的一行（语气、歌词），不加空行
function insertLine(editor, line, placeholder) {
  const v = editor.value;
  let pos = editor.selectionStart;
  const cur = v.slice(lineStart(v, pos), lineEnd(v, pos));
  let text = line;
  if (cur.trim()) { pos = lineEnd(v, pos); text = '\n' + line; }
  else pos = lineStart(v, pos);
  insertAt(editor, pos, text);
  selectPlaceholder(editor, pos + (text.length - line.length), line, placeholder);
}
function selectPlaceholder(editor, base, text, placeholder) {
  const i = placeholder ? text.indexOf(placeholder) : -1;
  if (i >= 0) editor.setSelectionRange(base + i, base + i + placeholder.length);
  else editor.setSelectionRange(base + text.length, base + text.length);
}
// 行内包裹：有选中文字就包住，没有就插入占位
function wrapInline(editor, left, right, placeholder) {
  const { selectionStart: s, selectionEnd: e, value: v } = editor;
  const inner = s !== e ? v.slice(s, e) : placeholder;
  replaceSelection(editor, s, e, left + inner + right);
  editor.setSelectionRange(s + left.length, s + left.length + inner.length);
}

function applyFormat(pane, fmt) {
  const editor = $('.editor', pane.el);
  const v = editor.value;
  switch (fmt) {
    case 'scene': {
      const n = sceneCount(v, editor.selectionStart) + 1;
      return insertBlock(editor, `.${n} 日 内 地点`, '日 内 地点');
    }
    case 'action': return insertBlock(editor, '画面描写', '画面描写');
    case 'character': return insertBlock(editor, '@角色名\n台词', '角色名');
    case 'dual': return insertBlock(editor, '@角色名 ^\n台词', '角色名');
    case 'paren': return insertLine(editor, '(语气)', '语气');
    case 'lyrics': return insertLine(editor, '~歌词', '歌词');
    case 'transition': return insertBlock(editor, '> 切至：', '切至：');
    case 'centered': return insertBlock(editor, '> 文字 <', '文字');
    case 'section': return insertBlock(editor, '# 第一幕', '第一幕');
    case 'synopsis': return insertBlock(editor, '= 这一段讲了什么', '这一段讲了什么');
    case 'pagebreak': return insertBlock(editor, '===', '');
    case 'bold': return wrapInline(editor, '**', '**', '粗体');
    case 'italic': return wrapInline(editor, '*', '*', '斜体');
    case 'underline': return /\.md$/i.test(pane.path) ? wrapInline(editor, '<u>', '</u>', '下划线') : wrapInline(editor, '_', '_', '下划线');
    case 'md-h': return insertBlock(editor, '## 小标题', '小标题');
    case 'md-list': return insertLine(editor, '- 要点', '要点');
    case 'md-olist': return insertLine(editor, '1. 要点', '要点');
    case 'md-quote': return insertBlock(editor, '> 引用', '引用');
    case 'md-hr': return insertBlock(editor, '---', '');
    case 'md-table': return insertBlock(editor, '| 角色 | 年龄 | 性格 |\n| --- | --- | --- |\n| 名字 | 岁数 | 一句话 |', '名字');
    case 'note': return wrapInline(editor, '[[', ']]', '备注');
    case 'title': {
      if (/^\s*Title\s*:/i.test(v)) { alert('开头已经有标题页了'); return; }
      const block = `Title: ${state.script || '剧名'}\nAuthor: 作者\n\n`;
      insertAt(editor, 0, block);
      const i = block.indexOf('作者');
      editor.setSelectionRange(i, i + 2);
      return;
    }
    case 'help': {
      const sheet = $('.cheatsheet', pane.el);
      if (!sheet.innerHTML) sheet.innerHTML = CHEATSHEET;
      sheet.hidden = !sheet.hidden;
      $('.tb-help', pane.el).classList.toggle('active', !sheet.hidden);
      return;
    }
  }
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
$('#btn-add-scene').onclick = () => { closeDrawer(); newScene(); };
$('#btn-add-note').onclick = newNote;
$('#btn-compare').onclick = toggleCompare;
$('#btn-full').onclick = () => openFile(FULL);
$('#btn-log').onclick = () => { openFile(LOG); closeDrawer(); };
$('#btn-script-menu').onclick = scriptMenu;

// 主题：手动选择优先，否则跟随系统
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $('#btn-theme').textContent = t === 'dark' ? '☀' : '☾';
  $('#btn-theme').title = t === 'dark' ? '切换到浅色' : '切换到深色';
}
applyTheme(document.documentElement.dataset.theme || 'light');
$('#btn-theme').onclick = () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', next);
  applyTheme(next);
};
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  if (!localStorage.getItem('theme')) applyTheme(e.matches ? 'dark' : 'light');
});
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
