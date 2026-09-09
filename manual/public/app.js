const $ = s => document.querySelector(s);
const view = $('#view'), qEl = $('#q'), chipsEl = $('#chips'), sheet = $('#sheet');

let DATA = { codes: [], procedures: [], manuals: [], equipment: [] };
let tab = 'codes';
let filter = null;
let searchTimer = null;

const esc = s => (s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const norm = s => (s || '').toLowerCase().replace(/[\s\-_·.]/g, '');
const kindOf = it => {
  if (typeof it === 'string') return it.toLowerCase();
  if (it && it.kind) return it.kind.toLowerCase();
  const t = ((it && it.tags) || []).find(x => /^(ES|EL|AD)-/.test(x));
  return t ? t.split('-')[0].toLowerCase() : '';
};
function hl(text, q) {
  const t = esc(text);
  if (!q) return t;
  const parts = q.split(/\s+/).filter(w => w.length > 1).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return parts.length ? t.replace(new RegExp(`(${parts.join('|')})`, 'gi'), '<mark>$1</mark>') : t;
}

async function boot() {
  try {
    const cached = localStorage.getItem('lm-index');
    if (cached) { DATA = JSON.parse(cached); render(); }
    const res = await fetch('api/index');
    if (res.ok) {
      DATA = await res.json();
      try { localStorage.setItem('lm-index', JSON.stringify(DATA)); } catch { }
    }
  } catch { /* 오프라인이면 캐시로 동작 */ }
  buildChips();
  render();
}

function buildChips() {
  const kinds = [['ES', '에스컬레이터'], ['EL', '엘리베이터'], ['AD', '자동문']];
  chipsEl.innerHTML = kinds.map(([k, label]) =>
    `<button class="chip" data-k="${k}">${label}</button>`).join('');
  chipsEl.onclick = e => {
    const b = e.target.closest('.chip'); if (!b) return;
    filter = filter === b.dataset.k ? null : b.dataset.k;
    [...chipsEl.children].forEach(c => c.classList.toggle('on', c.dataset.k === filter));
    render();
  };
}

const passes = item => !filter || item.kind === filter ||
  (item.tags || []).some(t => t.startsWith(filter + '-'));

function render() {
  const q = qEl.value.trim();
  if (tab === 'codes') return renderCodes(q);
  if (tab === 'procedures') return renderProcedures(q);
  if (tab === 'manuals') return renderManuals(q);
  return renderEquipment(q);
}

function renderCodes(q) {
  const n = norm(q);
  let list = DATA.codes.filter(passes);
  if (n) {
    const exact = list.filter(c => norm(c.code) === n);
    const starts = list.filter(c => norm(c.code).startsWith(n) && norm(c.code) !== n);
    const rest = list.filter(c => !norm(c.code).startsWith(n) &&
      (norm(c.meaning).includes(n) || norm(c.action).includes(n) || norm(c.maker).includes(n)));
    list = [...exact, ...starts, ...rest];
  }
  if (!list.length) return blank(q ? `"${esc(q)}"에 해당하는 코드가 없습니다.` : '코드 데이터가 비어 있습니다.');
  view.innerHTML = `<p class="count">${list.length}건</p>` + list.slice(0, 200).map((c) =>
    `<button class="row ${kindOf(c)}" data-t="code" data-i="${DATA.codes.indexOf(c)}">
      <span class="code">${hl(c.code, q)}</span><span class="maker">${esc(c.maker)}</span>
      <div class="desc">${hl(c.meaning, q)}</div>
      ${c.action ? `<div class="sub">조치 ${esc(c.action)}</div>` : ''}
    </button>`).join('');
}

function renderProcedures(q) {
  const n = norm(q);
  const list = DATA.procedures.filter(p => passes(p) &&
    (!n || norm(p.title).includes(n) || norm(p.body).includes(n)));
  if (!list.length) return blank('해당하는 절차가 없습니다.');
  view.innerHTML = list.map(p =>
    `<button class="row ${kindOf(p)}" data-t="proc" data-i="${DATA.procedures.indexOf(p)}">
      <div class="desc"><b>${hl(p.title, q)}</b></div>
      <div class="sub">${p.steps.length ? p.steps.length + '단계 · ' : ''}${esc(p.body.slice(0, 90))}</div>
    </button>`).join('');
}

function renderManuals(q) {
  const n = norm(q);
  const list = DATA.manuals.filter(m => passes(m) && (!n || norm(m.title + m.note).includes(n)));
  const head = `<p class="count">색인 ${list.length}건${DATA.docCount ? ` · 원문 ${DATA.docCount}건` : ''}</p>`;
  const rows = list.slice(0, 300).map(m =>
    `<div class="row ${kindOf(m)}"><div class="desc">${hl(m.title, q)}</div>
     ${m.note ? `<div class="sub">${esc(m.note)}</div>` : ''}</div>`).join('');
  view.innerHTML = head + (rows || '<p class="empty">색인이 비어 있습니다.</p>') +
    (q.length > 1 ? `<p class="section">매뉴얼 원문</p><div id="ft"><p class="count">찾는 중</p></div>` : '');
  if (q.length > 1) fullText(q);
}

async function fullText(q) {
  const box = $('#ft'); if (!box) return;
  if (!navigator.onLine) { box.innerHTML = '<p class="count">원문 검색은 통신이 연결되어야 합니다.</p>'; return; }
  try {
    const r = await fetch('api/search?q=' + encodeURIComponent(q));
    const { hits } = await r.json();
    if ($('#ft') !== box) return;
    box.innerHTML = hits.length
      ? hits.map(h => `<button class="row ${kindOf(h)}" data-t="doc" data-id="${h.id}">
          <div class="desc">${esc(h.title)}</div>
          <div class="sub">${hl(h.snippets[0] || '', q)}</div></button>`).join('')
      : '<p class="count">원문에서 찾지 못했습니다.</p>';
  } catch {
    box.innerHTML = '<p class="count">원문 검색에 실패했습니다.</p>';
  }
}

function renderEquipment(q) {
  const n = norm(q);
  const list = DATA.equipment.filter(e => (!filter || e.key.startsWith(filter + '-')) &&
    (!n || norm(e.key).includes(n)));
  if (!list.length) return blank('설비 목록이 비어 있습니다.');
  view.innerHTML = list.map(e =>
    `<button class="row ${e.key.split('-')[0].toLowerCase()}" data-t="eq" data-k="${e.key}">
      <span class="code">${esc(e.key)}</span><span class="maker">${esc(e.kind)}</span></button>`).join('');
}

const blank = msg => view.innerHTML = `<p class="empty">${msg}</p>`;

function open(html) { $('#sheet-body').innerHTML = html; sheet.showModal(); $('#sheet').scrollTop = 0; }
$('#sheet-close').onclick = () => sheet.close();
sheet.addEventListener('click', e => { if (e.target === sheet) sheet.close(); });

view.addEventListener('click', async e => {
  const row = e.target.closest('.row[data-t]'); if (!row) return;
  const t = row.dataset.t;

  if (t === 'code') {
    const c = DATA.codes[+row.dataset.i];
    const related = DATA.procedures.filter(p => norm(p.body).includes(norm(c.code))).slice(0, 4);
    open(`<h2><span class="code">${esc(c.code)}</span></h2>
      <p class="meta">${esc(c.maker || '제조사 미상')}${c.tags?.length ? ' · ' + c.tags.join(', ') : ''}</p>
      <h3>내용</h3><pre>${esc(c.meaning || '기재 없음')}</pre>
      ${c.action ? `<h3>조치</h3><div class="callout">${esc(c.action)}</div>` : ''}
      ${related.length ? `<h3>관련 절차</h3>` + related.map(p =>
      `<button class="row" data-t="proc" data-i="${DATA.procedures.indexOf(p)}">${esc(p.title)}</button>`).join('') : ''}`);
  }

  if (t === 'proc') {
    const p = DATA.procedures[+row.dataset.i];
    open(`<h2>${esc(p.title)}</h2>
      <p class="meta">${p.tags?.length ? p.tags.join(', ') : '현장조치 절차서'}</p>
      ${p.steps.length ? '<ol>' + p.steps.map(s => `<li>${esc(s)}</li>`).join('') + '</ol>'
        : `<pre>${esc(p.body)}</pre>`}`);
  }

  if (t === 'doc') {
    open('<p class="count">불러오는 중</p>');
    try {
      const d = await (await fetch('api/doc/' + row.dataset.id)).json();
      open(`<h2>${esc(d.title)}</h2><p class="meta">${esc(d.source)}</p>
        <pre>${hl(d.text.slice(0, 40000), qEl.value.trim())}</pre>`);
    } catch { open('<p class="count">문서를 불러오지 못했습니다.</p>'); }
  }

  if (t === 'eq') {
    const k = row.dataset.k;
    const cs = DATA.codes.filter(c => (c.tags || []).includes(k));
    const ps = DATA.procedures.filter(p => (p.tags || []).includes(k));
    const ms = DATA.manuals.filter(m => (m.tags || []).includes(k));
    open(`<h2><span class="code">${esc(k)}</span></h2>
      <p class="meta">코드 ${cs.length} · 절차 ${ps.length} · 매뉴얼 ${ms.length}</p>
      ${ps.length ? '<h3>절차</h3>' + ps.map(p => `<button class="row" data-t="proc" data-i="${DATA.procedures.indexOf(p)}">${esc(p.title)}</button>`).join('') : ''}
      ${ms.length ? '<h3>매뉴얼</h3>' + ms.slice(0, 30).map(m => `<div class="row">${esc(m.title)}</div>`).join('') : ''}
      ${cs.length ? '<h3>코드</h3>' + cs.slice(0, 40).map(c => `<div class="row"><span class="code">${esc(c.code)}</span> ${esc(c.meaning)}</div>`).join('') : ''}`);
  }
});
$('#sheet-body').addEventListener('click', e => {
  const row = e.target.closest('.row[data-t="proc"]'); if (!row) return;
  const p = DATA.procedures[+row.dataset.i];
  open(`<h2>${esc(p.title)}</h2><p class="meta">현장조치 절차서</p>
    ${p.steps.length ? '<ol>' + p.steps.map(s => `<li>${esc(s)}</li>`).join('') + '</ol>' : `<pre>${esc(p.body)}</pre>`}`);
});

qEl.addEventListener('input', () => {
  $('#clear').hidden = !qEl.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(render, 130);
});
$('#clear').onclick = () => { qEl.value = ''; $('#clear').hidden = true; render(); qEl.focus(); };
document.querySelector('.tabs').onclick = e => {
  const b = e.target.closest('button[data-tab]'); if (!b) return;
  tab = b.dataset.tab;
  [...e.currentTarget.children].forEach(c => c.classList.toggle('on', c === b));
  render();
};

const net = $('#net');
const setNet = () => {
  net.textContent = navigator.onLine ? '' : '오프라인';
  net.classList.toggle('off', !navigator.onLine);
};
addEventListener('online', setNet); addEventListener('offline', setNet); setNet();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
boot();
