// AJD Work — shared across every page: global search, notifications bell.
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
