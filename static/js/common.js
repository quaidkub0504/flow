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

// ── Shared "New Board" template select (used by home.html and board.html) ─
async function populateBoardTemplateSelect(){
  const sel = document.getElementById('newBoardTemplate');
  if (!sel || sel.options.length) return;  // already populated
  const templates = await fetch('/api/board_templates').then(r => r.json());
  sel.innerHTML = templates.map(t => `<option value="${t.key}">${esc_(t.label)}</option>`).join('');
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
async function toggleBellPanel(){
  const panel = document.getElementById('bellPanel');
  if (panel.style.display === 'block') { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  panel.innerHTML = `<div class="bell-hdr">Notifications</div><div class="activity-empty">Loading…</div>`;
  const r = await fetch('/api/activity?limit=25');
  const rows = await r.json();
  const ACTION_TEXT = {
    created_board: 'created board', created_item: 'created', deleted_item: 'deleted an item',
    changed_value: 'updated', created_column: 'added a column', deleted_column: 'removed a column',
  };
  panel.innerHTML = `<div class="bell-hdr">Notifications</div>` + (rows.length ? rows.map(r => `
    <div class="activity-row">
      <b>${esc_(r.user_name)}</b> ${esc_(ACTION_TEXT[r.action] || r.action)}
      ${r.detail ? '— ' + esc_(r.detail) : ''} <span style="color:var(--text-faint);">in ${esc_(r.board_name)}</span>
      <div class="activity-time">${timeAgo(r.created_at)}</div>
    </div>`).join('') : `<div class="activity-empty">No activity yet.</div>`);
}
