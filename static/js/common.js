// Danboise Flow — shared across every page: global search, notifications bell.
function timeAgo(iso){
  if (!iso) return '';
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString('en-US', {month:'short', day:'numeric'});
}
function esc_(s){ return (s==null?'':String(s)).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// True while focus is somewhere the user is actively typing — every
// single-key shortcut below must check this first so "n" in an item name
// or "/" in a URL field never gets hijacked.
function isTypingTarget(el){
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!el.isContentEditable;
}

// ── Confirm modal (every page that needs a blocking "are you sure?") ────
// Requires a #confirmModal backdrop with #confirmModalHdr/#confirmModalBody/
// #confirmModalOkBtn in the page markup.
function confirmAction(title, body, okLabel, onConfirm){
  document.getElementById('confirmModalHdr').textContent = title;
  document.getElementById('confirmModalBody').textContent = body;
  const okBtn = document.getElementById('confirmModalOkBtn');
  okBtn.textContent = okLabel || 'Delete';
  okBtn.onclick = () => { closeConfirmModal(); onConfirm(); };
  document.getElementById('confirmModal').style.display = 'flex';
}
function closeConfirmModal(){ document.getElementById('confirmModal').style.display = 'none'; }

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (typeof closePicker === 'function') closePicker();
  if (typeof closeAllMenus === 'function') closeAllMenus();
  if (typeof closeMenus === 'function') closeMenus();
  if (typeof closeUpdates === 'function') closeUpdates();
  if (typeof closeCommandPalette === 'function') closeCommandPalette();
  document.querySelectorAll('.modal-backdrop').forEach(m => { m.style.display = 'none'; });
});

// ── Undo toast — for reversible, frequent actions (item/column/group
// delete) where a grace period beats a blocking confirm dialog. Nothing
// is actually sent to the server until the toast times out unanswered. ──
let _pendingUndos = {};
function showUndoToast(message, onUndo, onCommit){
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const id = 'toast_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  const toast = document.createElement('div');
  toast.className = 'undo-toast';
  toast.id = id;
  toast.innerHTML = `<span>${esc_(message)}</span><button onclick="undoToast('${id}')">Undo</button>`;
  container.appendChild(toast);
  const timeoutId = setTimeout(() => {
    delete _pendingUndos[id];
    toast.remove();
    onCommit();
  }, 6000);
  _pendingUndos[id] = {timeoutId, onUndo};
}
function undoToast(id){
  const pending = _pendingUndos[id];
  if (!pending) return;
  clearTimeout(pending.timeoutId);
  delete _pendingUndos[id];
  const el = document.getElementById(id);
  if (el) el.remove();
  pending.onUndo();
}

// ── Desktop notifications ─────────────────────────────────────────────────
function initNotificationBanner(){
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'default') return;
  if (localStorage.getItem('ajdwork_notif_dismissed') === '1') return;
  const banner = document.createElement('div');
  banner.className = 'notif-banner';
  banner.innerHTML = `
    <span>Enable desktop notifications on this computer</span>
    <button onclick="enableDesktopNotifications()">Enable now</button>
    <span class="notif-banner-close" onclick="dismissNotifBanner()">✕</span>`;
  document.body.prepend(banner);
}
async function enableDesktopNotifications(){
  await Notification.requestPermission();
  dismissNotifBanner();
}
function dismissNotifBanner(){
  localStorage.setItem('ajdwork_notif_dismissed', '1');
  const b = document.querySelector('.notif-banner');
  if (b) b.remove();
}
function fireDesktopNotification(title, body){
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (!document.hidden) return;  // only pop up when the tab isn't the one you're looking at
  try { new Notification(title, {body, icon: '/static/img/logo.png'}); } catch (e) {}
}
if (document.readyState !== 'loading') initNotificationBanner();
else document.addEventListener('DOMContentLoaded', initNotificationBanner);

// ── Shared "New Board" modal — markup lives once in _sidebar.html so every
// page that includes the sidebar (home, board, team, my-work) gets a working
// "+ New Board" button for free, instead of each page needing its own copy.
async function populateBoardTemplateSelect(){
  const sel = document.getElementById('newBoardTemplate');
  if (!sel || sel.options.length) return;  // already populated
  const templates = await fetch('/api/board_templates').then(r => r.json());
  sel.innerHTML = templates.map(t => `<option value="${t.key}">${esc_(t.label)}</option>`).join('');
}
function populateNewBoardFolderSelect(){
  const sel = document.getElementById('newBoardFolder');
  if (!sel) return;
  const folders = typeof SB_FOLDERS !== 'undefined' ? SB_FOLDERS : [];
  sel.innerHTML = '<option value="">No folder</option>' +
    folders.map(f => `<option value="${f.id}">${esc_(f.name)}</option>`).join('');
}
function openNewBoardModal(){
  document.getElementById('newBoardModal').style.display = 'flex';
  document.getElementById('newBoardName').focus();
  populateBoardTemplateSelect();
  populateNewBoardFolderSelect();
}
function closeNewBoardModal(){
  document.getElementById('newBoardModal').style.display = 'none';
  document.getElementById('newBoardName').value = '';
}
async function submitNewBoard(){
  const name = document.getElementById('newBoardName').value.trim();
  if (!name) return;
  const template = document.getElementById('newBoardTemplate').value;
  const folderSel = document.getElementById('newBoardFolder');
  const folder_id = folderSel && folderSel.value ? parseInt(folderSel.value, 10) : null;
  const r = await fetch('/api/boards', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({name, template, folder_id})
  });
  const board = await r.json();
  window.location.href = '/board/' + board.id;
}

// ── Global search ─────────────────────────────────────────────────────────
let _searchDebounce = null;
function onGlobalSearchInput(q){
  clearTimeout(_searchDebounce);
  const dd = document.getElementById('searchDropdown');
  if (!q.trim()) { dd.style.display = 'none'; return; }
  _searchDebounce = setTimeout(async () => {
    const r = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}`);
    const data = await r.json();
    renderSearchDropdown(data);
  }, 150);
}
function renderSearchDropdown(data){
  const dd = document.getElementById('searchDropdown');
  const hasResults = data.boards.length || data.items.length;
  if (!hasResults) {
    dd.innerHTML = `<div class="search-empty">No matches</div>`;
  } else {
    let html = '';
    if (data.boards.length) {
      html += `<div class="search-group-label">Boards</div>` + data.boards.map(b => `
        <a class="search-result" href="/board/${b.id}"><b>${esc_(b.icon)} ${esc_(b.name)}</b></a>`).join('');
    }
    if (data.items.length) {
      html += `<div class="search-group-label">Items</div>` + data.items.map(i => `
        <a class="search-result" href="/board/${i.board_id}">
          <span>${esc_(i.name)}</span><span class="search-result-sub">${esc_(i.board_name)}</span>
        </a>`).join('');
    }
    dd.innerHTML = html;
  }
  dd.style.display = 'block';
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.global-search')) {
    const dd = document.getElementById('searchDropdown');
    if (dd) dd.style.display = 'none';
  }
  if (!e.target.closest('.topbar-actions')) {
    const bp = document.getElementById('bellPanel');
    if (bp) bp.style.display = 'none';
  }
});

// ── Notifications bell ───────────────────────────────────────────────────
// Shared with the per-board Activity Log panel in board.js — one mapping
// of action -> past-tense phrase for both surfaces.
const ACTIVITY_ACTION_TEXT = {
  created_board: 'created board', created_item: 'created', deleted_item: 'deleted an item',
  changed_value: 'updated', created_column: 'added a column', deleted_column: 'removed a column',
};
async function toggleBellPanel(){
  const panel = document.getElementById('bellPanel');
  if (panel.style.display === 'block') { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  panel.innerHTML = `<div class="bell-hdr">Notifications</div><div class="activity-empty">Loading…</div>`;
  const r = await fetch('/api/activity?limit=25');
  const rows = await r.json();
  panel.innerHTML = `<div class="bell-hdr">Notifications</div>` + (rows.length ? rows.map(r => `
    <div class="activity-row">
      <b>${esc_(r.user_name)}</b> ${esc_(ACTIVITY_ACTION_TEXT[r.action] || r.action)}
      ${r.detail ? '— ' + esc_(r.detail) : ''} <span style="color:var(--text-faint);">in ${esc_(r.board_name)}</span>
      <div class="activity-time">${timeAgo(r.created_at)}</div>
    </div>`).join('') : `<div class="activity-empty">No activity yet.</div>`);
}

// ── Command palette (Ctrl/Cmd+K) — quick nav + fuzzy jump to any board or
// item, from anywhere in the app. The overlay markup lives once in
// _topbar.html, same "shared partial" approach as the New Board modal.
const CMD_STATIC_ACTIONS = [
  {label: 'Go to My Work', icon: '🗂️', href: '/my-work'},
  {label: 'Go to Team', icon: '👥', href: '/team'},
  {label: 'Go to All Boards', icon: '🏠', href: '/'},
  {label: 'Create a new board', icon: '➕', run: () => { closeCommandPalette(); openNewBoardModal(); }},
];
let CMD_ITEMS = [];
let CMD_SELECTED = 0;
let _cmdDebounce = null;

function openCommandPalette(){
  const bd = document.getElementById('cmdPaletteBackdrop');
  if (!bd) return;
  if (typeof closeAllMenus === 'function') closeAllMenus();
  if (typeof closePicker === 'function') closePicker();
  bd.style.display = 'flex';
  const input = document.getElementById('cmdPaletteInput');
  input.value = '';
  input.focus();
  renderCommandPaletteResults('', {boards: [], items: []});
}
function closeCommandPalette(){
  const bd = document.getElementById('cmdPaletteBackdrop');
  if (bd) bd.style.display = 'none';
}
function onCommandPaletteInput(q){
  clearTimeout(_cmdDebounce);
  if (!q.trim()) { renderCommandPaletteResults('', {boards: [], items: []}); return; }
  _cmdDebounce = setTimeout(async () => {
    const r = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}`);
    renderCommandPaletteResults(q, await r.json());
  }, 150);
}
function renderCommandPaletteResults(q, data){
  const ql = q.trim().toLowerCase();
  const actions = CMD_STATIC_ACTIONS.filter(a => !ql || a.label.toLowerCase().includes(ql));
  CMD_ITEMS = [];
  let html = '';
  const addSection = (label, rows, toItem, rowHtml) => {
    if (!rows.length) return;
    html += `<div class="cmd-section-label">${label}</div>`;
    rows.forEach(row => {
      const idx = CMD_ITEMS.length;
      CMD_ITEMS.push(toItem(row));
      html += `<div class="cmd-result-row" data-idx="${idx}" onclick="runCommandPaletteItem(${idx})">${rowHtml(row)}</div>`;
    });
  };
  addSection('Actions', actions, a => a, a => `<span class="cmd-result-icon">${a.icon}</span><span>${esc_(a.label)}</span>`);
  addSection('Boards', data.boards || [], b => ({label: b.name, href: `/board/${b.id}`}),
    b => `<span class="cmd-result-icon">${esc_(b.icon)}</span><span>${esc_(b.name)}</span>`);
  addSection('Items', data.items || [], i => ({label: i.name, href: `/board/${i.board_id}`}),
    i => `<span class="cmd-result-icon">▤</span><span>${esc_(i.name)}</span><span class="cmd-result-sub">${esc_(i.board_name)}</span>`);
  const results = document.getElementById('cmdPaletteResults');
  results.innerHTML = CMD_ITEMS.length ? html : `<div class="cmd-palette-empty">No matches</div>`;
  CMD_SELECTED = 0;
  highlightCommandPaletteSelection();
}
function highlightCommandPaletteSelection(){
  document.querySelectorAll('#cmdPaletteResults .cmd-result-row').forEach(el => {
    el.classList.toggle('active', Number(el.dataset.idx) === CMD_SELECTED);
  });
  const active = document.querySelector('#cmdPaletteResults .cmd-result-row.active');
  if (active) active.scrollIntoView({block: 'nearest'});
}
function runCommandPaletteItem(idx){
  const item = CMD_ITEMS[idx];
  if (!item) return;
  if (item.run) { item.run(); return; }
  closeCommandPalette();
  window.location.href = item.href;
}
function cmdPaletteKeydown(evt){
  if (evt.key === 'ArrowDown') {
    evt.preventDefault();
    CMD_SELECTED = Math.min(CMD_SELECTED + 1, CMD_ITEMS.length - 1);
    highlightCommandPaletteSelection();
  } else if (evt.key === 'ArrowUp') {
    evt.preventDefault();
    CMD_SELECTED = Math.max(CMD_SELECTED - 1, 0);
    highlightCommandPaletteSelection();
  } else if (evt.key === 'Enter') {
    evt.preventDefault();
    runCommandPaletteItem(CMD_SELECTED);
  }
}
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'k') return;
  e.preventDefault();
  const bd = document.getElementById('cmdPaletteBackdrop');
  if (!bd) return;
  if (bd.style.display === 'flex') closeCommandPalette(); else openCommandPalette();
});

// ── Single-key shortcuts (/, n, ?) — Linear/Notion/GitHub convention ────
// Only "/" search-focus, "n" new-item, and "?" help; deliberately no
// multi-key chords (g+h etc.) to keep the surface small and predictable.
function openShortcutsModal(){
  if (typeof closeAllMenus === 'function') closeAllMenus();
  const m = document.getElementById('shortcutsModal');
  if (m) m.style.display = 'flex';
}
function closeShortcutsModal(){
  const m = document.getElementById('shortcutsModal');
  if (m) m.style.display = 'none';
}
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (isTypingTarget(e.target)) return;

  if (e.key === '/') {
    e.preventDefault();
    const input = document.getElementById('globalSearchInput');
    if (input) input.focus();
  } else if (e.key === 'n' || e.key === 'N') {
    e.preventDefault();
    if (typeof focusFirstAddItem === 'function') focusFirstAddItem();
    else if (typeof openNewBoardModal === 'function') openNewBoardModal();
  } else if (e.key === '?') {
    e.preventDefault();
    openShortcutsModal();
  }
});
