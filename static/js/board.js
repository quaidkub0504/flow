// AJD Work — board rendering (table + kanban views) + real-time sync engine.
let STATE = { board: null, groups: [], columns: [], items: [], views: [], currentViewId: null };
let ALL_USERS = [];
let socket = null;
let SEARCH_QUERY = '';
let FILTER_STATE = {};          // { columnId: Set(labelId/optionId) }
let SORT_STATE = { columnId: null, dir: 'asc' };
let HIDDEN_COLS = new Set();
let RENAME_COLUMN_ID = null;
let SELECTED_ITEMS = new Set();
let DRAG_ITEM_ID = null;
let DRAG_GROUP_ID = null;
const GROUP_COLORS = ["#579bfc","#00c875","#fdab3d","#e2445c","#a25ddc","#66ccff","#ff642e","#037f4c"];
let CALENDAR_VIEW_DATE = new Date();

function esc(s){ return (s==null?'':String(s)).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function loadHiddenCols(){
  try { return new Set(JSON.parse(localStorage.getItem(`ajdwork_hidden_${BOARD_ID}`) || '[]')); }
  catch(e) { return new Set(); }
}
function saveHiddenCols(){
  localStorage.setItem(`ajdwork_hidden_${BOARD_ID}`, JSON.stringify(Array.from(HIDDEN_COLS)));
}
function visibleColumns(){ return STATE.columns.filter(c => !HIDDEN_COLS.has(c.id)); }

async function init(){
  const [boardResp, usersResp] = await Promise.all([
    fetch(`/api/boards/${BOARD_ID}`).then(r => r.json()),
    fetch('/api/users').then(r => r.json()),
  ]);
  STATE.board = boardResp.board;
  STATE.groups = boardResp.groups.sort((a,b) => a.position - b.position);
  STATE.columns = boardResp.columns.sort((a,b) => a.position - b.position);
  STATE.items = boardResp.items;
  STATE.views = boardResp.views.sort((a,b) => a.position - b.position);
  STATE.currentViewId = STATE.views.length ? STATE.views[0].id : null;
  ALL_USERS = usersResp;
  HIDDEN_COLS = loadHiddenCols();
  document.getElementById('boardStarBtn').classList.toggle('starred', !!STATE.board.starred);

  render();
  connectSocket();
  wireBoardTitleEdit();
  wireBoardDescEdit();
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.picker') && !e.target.closest('.cell')) closePicker();
    if (!e.target.closest('.app-menu') && !e.target.closest('.th-menu-btn') && !e.target.closest('.row-menu-btn')
        && !e.target.closest('#filterBtn') && !e.target.closest('#sortBtn') && !e.target.closest('#hideBtn')
        && !e.target.closest('.icon-btn-sm') && !e.target.closest('.star-toggle')) {
      closeAllMenus();
    }
  });
}

function connectSocket(){
  socket = io();
  socket.on('connect', () => socket.emit('join_board', {board_id: BOARD_ID}));

  socket.on('item_created', (item) => {
    if (!STATE.items.find(i => i.id === item.id)) STATE.items.push(item);
    render();
  });
  socket.on('item_updated', (item) => {
    const idx = STATE.items.findIndex(i => i.id === item.id);
    if (idx >= 0) STATE.items[idx] = item;
    render();
  });
  socket.on('item_deleted', ({id}) => {
    STATE.items = STATE.items.filter(i => i.id !== id);
    render();
  });
  socket.on('value_updated', ({item_id, column_id, value}) => {
    const item = STATE.items.find(i => i.id === item_id);
    if (item) {
      const col = STATE.columns.find(c => c.id === column_id);
      if (col && col.type === 'person') {
        const before = new Set((item.values[column_id] || {}).user_ids || []);
        const after = new Set(value.user_ids || []);
        if (after.has(USER.id) && !before.has(USER.id)) {
          fireDesktopNotification('You were assigned', `${item.name} on ${STATE.board.name}`);
        }
      }
      item.values[column_id] = value;
      render();
    }
  });
  socket.on('column_created', (col) => {
    if (!STATE.columns.find(c => c.id === col.id)) STATE.columns.push(col);
    render();
  });
  socket.on('column_updated', (col) => {
    const idx = STATE.columns.findIndex(c => c.id === col.id);
    if (idx >= 0) STATE.columns[idx] = col;
    render();
  });
  socket.on('column_deleted', ({id}) => {
    STATE.columns = STATE.columns.filter(c => c.id !== id);
    render();
  });
  socket.on('group_created', (group) => {
    if (!STATE.groups.find(g => g.id === group.id)) STATE.groups.push(group);
    render();
  });
  socket.on('group_updated', (group) => {
    const idx = STATE.groups.findIndex(g => g.id === group.id);
    if (idx >= 0) STATE.groups[idx] = group;
    render();
  });
  socket.on('group_deleted', ({id}) => {
    STATE.groups = STATE.groups.filter(g => g.id !== id);
    render();
  });
  socket.on('groups_reordered', (groups) => {
    STATE.groups = groups;
    render();
  });
  socket.on('items_reordered', (items) => {
    items.forEach(updated => {
      const idx = STATE.items.findIndex(i => i.id === updated.id);
      if (idx >= 0) STATE.items[idx] = updated;
    });
    render();
  });
  socket.on('items_bulk_deleted', ({ids}) => {
    const idSet = new Set(ids);
    STATE.items = STATE.items.filter(i => !idSet.has(i.id));
    ids.forEach(id => SELECTED_ITEMS.delete(id));
    renderBulkBar();
    render();
  });
  socket.on('view_created', (view) => {
    if (!STATE.views.find(v => v.id === view.id)) STATE.views.push(view);
    renderTabs();
  });
  socket.on('view_updated', (view) => {
    const idx = STATE.views.findIndex(v => v.id === view.id);
    if (idx >= 0) STATE.views[idx] = view;
    render();
  });
  socket.on('view_deleted', ({id}) => {
    STATE.views = STATE.views.filter(v => v.id !== id);
    if (STATE.currentViewId === id) STATE.currentViewId = STATE.views[0] ? STATE.views[0].id : null;
    render();
  });
  socket.on('board_updated', (board) => {
    STATE.board = board;
    document.getElementById('boardTitle').textContent = board.name;
    document.getElementById('boardStarBtn').classList.toggle('starred', !!board.starred);
  });
  socket.on('board_deleted', ({id}) => {
    if (id === BOARD_ID) window.location.href = '/';
  });
  socket.on('update_posted', (upd) => {
    const panel = document.getElementById('updatesPanel');
    if (panel.dataset.itemId == upd.item_id) appendUpdateToPanel(upd);
    if (upd.user && upd.user.id !== USER.id) {
      const item = STATE.items.find(i => i.id === upd.item_id);
      fireDesktopNotification(`New update from ${upd.user.name}`, item ? item.name : 'An item was updated');
    }
  });
}

function setSearchQuery(q){ SEARCH_QUERY = q.trim().toLowerCase(); render(); }
function focusFirstAddItem(){
  const el = document.querySelector('.add-item-input');
  if (el) el.focus();
}

// ── Filter / Sort applied across every view ──────────────────────────────

function applyFilterSearch(items){
  return items.filter(i => {
    if (SEARCH_QUERY && !i.name.toLowerCase().includes(SEARCH_QUERY)) return false;
    for (const colId of Object.keys(FILTER_STATE)) {
      const selected = FILTER_STATE[colId];
      if (!selected || !selected.size) continue;
      const col = STATE.columns.find(c => c.id === Number(colId));
      if (!col) continue;
      const val = i.values[colId] || i.values[Number(colId)] || {};
      if (col.type === 'dropdown') {
        const ids = val.option_ids || [];
        if (!ids.some(id => selected.has(id))) return false;
      } else {
        if (!val.label_id || !selected.has(val.label_id)) return false;
      }
    }
    return true;
  });
}
function sortValueFor(item, col){
  const val = item.values[col.id] || {};
  switch (col.type) {
    case 'status': case 'priority': {
      const labels = col.settings.labels || [];
      const idx = labels.findIndex(l => l.id === val.label_id);
      return idx;
    }
    case 'number': case 'progress': return Number(val.number ?? -Infinity);
    case 'rating': return Number(val.stars ?? -Infinity);
    case 'time_tracking': return Number(val.total_seconds ?? -Infinity);
    case 'date': return val.date || '';
    case 'checkbox': return val.checked ? 1 : 0;
    case 'long_text': case 'text': return (val.text || '').toLowerCase();
    default: return 0;
  }
}
function applySort(items){
  if (!SORT_STATE.columnId) return [...items].sort((a,b) => a.position - b.position);
  const col = STATE.columns.find(c => c.id === SORT_STATE.columnId);
  if (!col) return items;
  const dir = SORT_STATE.dir === 'desc' ? -1 : 1;
  return [...items].sort((a,b) => {
    const av = sortValueFor(a, col), bv = sortValueFor(b, col);
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
}
function itemsForGroup(groupId){
  let items = STATE.items.filter(i => i.group_id === groupId);
  items = applyFilterSearch(items);
  return applySort(items);
}

// ── View dispatch ─────────────────────────────────────────────────────────

function render(){
  renderTabs();
  const view = STATE.views.find(v => v.id === STATE.currentViewId) || STATE.views[0];
  if (!view) { document.getElementById('boardScroll').innerHTML = ''; return; }
  if (view.type === 'kanban') renderKanbanView();
  else if (view.type === 'calendar') renderCalendarView();
  else if (view.type === 'dashboard') renderDashboardView();
  else renderTableView();
}
function renderTabs(){
  const el = document.getElementById('boardTabs');
  el.innerHTML = STATE.views.map(v => `
    <span class="board-tab ${v.id === STATE.currentViewId ? 'active' : ''}" onclick="switchView(${v.id})">${esc(v.name)}</span>
  `).join('') + `<span class="board-tab-add" onclick="openNewViewModal()">+</span>`;
}
function switchView(viewId){ STATE.currentViewId = viewId; render(); }

// ── Table view ────────────────────────────────────────────────────────────

function renderTableView(){
  document.getElementById('boardScroll').innerHTML =
    STATE.groups.map(renderGroup).join('') +
    `<button class="add-group-btn" onclick="addGroup()">+ Add Group</button>`;
}

function renderGroup(group){
  const items = itemsForGroup(group.id);
  return `
    <div class="group-block" data-group-id="${group.id}"
         ondragover="onGroupDragOver(event)" ondrop="onGroupDrop(event, ${group.id})">
      <div class="group-hdr" onclick="toggleGroup(${group.id})">
        <span class="drag-handle" draggable="true" onclick="event.stopPropagation();"
              ondragstart="onGroupDragStart(event, ${group.id})">⠿</span>
        <span class="group-collapse-arrow ${group.collapsed ? 'collapsed' : ''}">▼</span>
        <span class="group-name" contenteditable="true" style="color:${group.color};"
              onclick="event.stopPropagation();"
              onblur="saveGroupName(${group.id}, this)"
              onkeydown="if(event.key==='Enter'){event.preventDefault(); this.blur();}">${esc(group.name)}</span>
        <span class="group-count">${items.length} item${items.length===1?'':'s'}</span>
        <span class="th-menu-btn" onclick="event.stopPropagation(); openGroupMenu(event, ${group.id})">⋮</span>
      </div>
      ${group.collapsed ? '' : renderTable(group, items)}
    </div>`;
}

function renderTable(group, items){
  const cols = visibleColumns();
  const allSelected = items.length > 0 && items.every(i => SELECTED_ITEMS.has(i.id));
  return `
    <table class="board-table">
      <thead><tr>
        <th class="select-cell"><input type="checkbox" ${allSelected?'checked':''} onclick="toggleSelectAllInGroup(${group.id})"/></th>
        <th style="width:22px;"></th>
        <th style="min-width:240px;">Item</th>
        ${cols.map(c => `
          <th style="width:${c.width}px;">
            <div class="th-wrap">
              <span>${esc(c.name)}${SORT_STATE.columnId===c.id ? `<span class="th-sort-indicator">${SORT_STATE.dir==='desc'?'↓':'↑'}</span>` : ''}</span>
              <span class="th-menu-btn" onclick="openColumnMenu(event, ${c.id})">⋮</span>
            </div>
          </th>`).join('')}
        <th style="width:36px;"><span class="add-col-btn" onclick="openNewColumnModal()">+</span></th>
      </tr></thead>
      <tbody>
        ${items.map(item => renderRow(group, item)).join('')}
        <tr class="add-item-row">
          <td colspan="${cols.length + 4}" style="border-left:4px solid ${group.color};">
            <input class="add-item-input" placeholder="+ Add item"
                   onkeydown="if(event.key==='Enter'){addItem(${group.id}, this);}"/>
          </td>
        </tr>
        ${renderFooterRow(items, cols)}
      </tbody>
    </table>`;
}

function renderFooterRow(items, cols){
  const sums = cols.map(c => (c.type === 'number' || c.type === 'progress')
    ? items.reduce((acc,i) => acc + (Number((i.values[c.id]||{}).number) || 0), 0)
    : null);
  if (!sums.some(s => s !== null)) return '';
  return `<tr class="footer-row">
    <td class="footer-label" colspan="3">Sum</td>
    ${cols.map((c,idx) => `<td>${sums[idx] !== null ? `<span class="footer-sum">${sums[idx]}</span>` : ''}</td>`).join('')}
    <td></td>
  </tr>`;
}

function renderRow(group, item){
  const cols = visibleColumns();
  const draggable = !SORT_STATE.columnId;
  const selected = SELECTED_ITEMS.has(item.id);
  return `
    <tr data-item-id="${item.id}" class="${selected?'row-selected':''}"
        ondragover="onRowDragOver(event)" ondragleave="onRowDragLeave(event)"
        ondrop="onRowDrop(event, ${group.id}, ${item.id})">
      <td class="select-cell"><input type="checkbox" ${selected?'checked':''} onclick="toggleSelectItem(${item.id})"/></td>
      <td class="drag-handle-cell">${draggable ? `<span class="drag-handle" draggable="true" ondragstart="onRowDragStart(event, ${item.id})" ondragend="onRowDragEnd(event)">⠿</span>` : ''}</td>
      <td class="item-name-cell" style="--gcolor:${group.color};" contenteditable="true"
          onblur="saveItemName(${item.id}, this)"
          onkeydown="if(event.key==='Enter'){event.preventDefault(); this.blur();}"
          ondblclick="openUpdates(${item.id})">${esc(item.name)}</td>
      ${cols.map(col => `<td>${renderCell(item, col)}</td>`).join('')}
      <td><div class="row-menu-btn" onclick="openRowMenu(event, ${item.id})">⋮</div></td>
    </tr>`;
}

function renderCell(item, col){
  const val = item.values[col.id] || {};
  switch (col.type) {
    case 'status':
    case 'priority': {
      const labels = col.settings.labels || [];
      const label = labels.find(l => l.id === val.label_id);
      return `<div class="cell" onclick="openLabelPicker(event, ${item.id}, ${col.id})">
        ${label ? `<span class="pill" style="background:${label.color};">${esc(label.text)}</span>` : `<span class="pill empty"></span>`}
      </div>`;
    }
    case 'person': {
      const ids = val.user_ids || [];
      const users = ids.map(uid => ALL_USERS.find(u => u.id === uid)).filter(Boolean);
      return `<div class="cell" onclick="openPersonPicker(event, ${item.id}, ${col.id})">
        ${users.length ? `<div class="avatar-stack">${users.map(u => `<div class="avatar" style="background:${u.color};" title="${esc(u.name)}">${esc(u.name[0].toUpperCase())}</div>`).join('')}</div>` : `<div class="avatar avatar-placeholder">+</div>`}
      </div>`;
    }
    case 'date': {
      return `<div class="cell">
        <input type="date" value="${val.date || ''}" onchange="saveValue(${item.id},${col.id},{date:this.value})"/>
      </div>`;
    }
    case 'timeline': {
      return `<div class="cell" style="gap:4px;">
        <input type="date" value="${val.start || ''}" style="width:48%;"
               onchange="saveValue(${item.id},${col.id},Object.assign({},${JSON.stringify(val)},{start:this.value}))"/>
        <input type="date" value="${val.end || ''}" style="width:48%;"
               onchange="saveValue(${item.id},${col.id},Object.assign({},${JSON.stringify(val)},{end:this.value}))"/>
      </div>`;
    }
    case 'number': {
      return `<div class="cell">
        <input type="number" value="${val.number ?? ''}"
               onchange="saveValue(${item.id},${col.id},{number:this.value===''?null:Number(this.value)})"/>
      </div>`;
    }
    case 'progress': {
      const pct = Math.max(0, Math.min(100, Number(val.number) || 0));
      return `<div class="cell progress-cell" onclick="openProgressEditor(event, ${item.id}, ${col.id}, ${pct})">
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%;"></div></div>
        <span class="progress-label">${pct}%</span>
      </div>`;
    }
    case 'checkbox': {
      return `<div class="cell checkbox-cell">
        <input type="checkbox" ${val.checked ? 'checked' : ''}
               onchange="saveValue(${item.id},${col.id},{checked:this.checked})"/>
      </div>`;
    }
    case 'dropdown': {
      const opts = col.settings.options || [];
      const selected = (val.option_ids || []).map(id => opts.find(o => o.id === id)).filter(Boolean);
      return `<div class="cell" onclick="openDropdownPicker(event, ${item.id}, ${col.id})">
        ${selected.length ? selected.map(o => `<span class="pill" style="background:#579bfc;margin-right:2px;">${esc(o.text)}</span>`).join('') : `<span class="pill empty"></span>`}
      </div>`;
    }
    case 'files': {
      const files = val.files || [];
      return `<div class="cell" style="height:auto;min-height:36px;flex-wrap:wrap;padding:4px 8px;" onclick="openFilesPicker(event, ${item.id}, ${col.id})">
        ${files.length ? files.map(f => `<a class="file-chip" href="${esc(f.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation();">📎 ${esc(f.name)}</a>`).join('') : `<span class="pill empty"></span>`}
      </div>`;
    }
    case 'rating': {
      const stars = Math.max(0, Math.min(5, Number(val.stars) || 0));
      let starsHtml = '';
      for (let i = 1; i <= 5; i++) {
        starsHtml += `<span class="rating-star ${i<=stars?'lit':''}" onclick="event.stopPropagation(); saveValue(${item.id},${col.id},{stars:${i}}); render();">★</span>`;
      }
      return `<div class="cell rating-cell">${starsHtml}</div>`;
    }
    case 'time_tracking': {
      const running = !!val.running;
      const total = Number(val.total_seconds) || 0;
      const h = Math.floor(total/3600), m = Math.floor((total%3600)/60), s = total%60;
      const timeStr = `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
      return `<div class="cell time-cell">
        <button class="time-toggle-btn ${running?'running':''}" title="${running?'Stop':'Start'}"
                onclick="event.stopPropagation(); toggleTimeTracking(${item.id},${col.id});">${running?'⏸':'▶'}</button>
        <span class="time-display">${running ? 'Running…' : timeStr}</span>
      </div>`;
    }
    case 'link': {
      return `<div class="cell">
        <input type="text" value="${esc(val.url || '')}" placeholder="https://"
               onchange="saveValue(${item.id},${col.id},{url:this.value})"/>
      </div>`;
    }
    case 'long_text':
    case 'text':
    default: {
      return `<div class="cell">
        <input type="text" value="${esc(val.text || '')}"
               onchange="saveValue(${item.id},${col.id},{text:this.value})"/>
      </div>`;
    }
  }
}

// ── Kanban view ───────────────────────────────────────────────────────────

function renderKanbanView(){
  const container = document.getElementById('boardScroll');
  const statusCol = STATE.columns.find(c => c.type === 'status');
  if (!statusCol) {
    container.innerHTML = `<div class="empty-state">Add a Status column to use the Kanban view.</div>`;
    return;
  }
  const labels = statusCol.settings.labels || [];
  const items = applyFilterSearch(STATE.items.slice());
  const buckets = labels.map(l => ({label: l, items: items.filter(i => (i.values[statusCol.id]||{}).label_id === l.id)}));
  const noStatus = items.filter(i => !(i.values[statusCol.id]||{}).label_id);
  const allBuckets = buckets.concat([{label: {id: null, text: 'No Status', color: '#9295ac'}, items: noStatus}]);
  container.innerHTML = `<div class="kanban-board">
    ${allBuckets.map(b => `
      <div class="kanban-col" style="--kcolor:${b.label.color};">
        <div class="kanban-col-hdr">
          <span class="kanban-col-title">${esc(b.label.text)}</span>
          <span class="kanban-col-count">${b.items.length}</span>
        </div>
        <div class="kanban-cards">${b.items.map(renderKanbanCard).join('')}</div>
        <div class="kanban-add-card" onclick="addKanbanCard(${statusCol.id}, ${b.label.id ? `'${b.label.id}'` : 'null'})">+ Add card</div>
      </div>`).join('')}
  </div>`;
}
function renderKanbanCard(item){
  const personCol = STATE.columns.find(c => c.type === 'person');
  let avatarsHtml = '';
  if (personCol) {
    const ids = (item.values[personCol.id]||{}).user_ids || [];
    const users = ids.map(uid => ALL_USERS.find(u => u.id === uid)).filter(Boolean);
    if (users.length) avatarsHtml = `<div class="avatar-stack">${users.map(u => `<div class="avatar" style="background:${u.color};width:22px;height:22px;font-size:10px;">${esc(u.name[0].toUpperCase())}</div>`).join('')}</div>`;
  }
  return `<div class="kanban-card" onclick="openUpdates(${item.id})">
    <div class="kanban-card-name">${esc(item.name)}</div>
    <div class="kanban-card-meta">${avatarsHtml}</div>
  </div>`;
}
async function addKanbanCard(statusColId, labelId){
  const group = STATE.groups[0];
  if (!group) return;
  const r = await fetch(`/api/groups/${group.id}/items`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({name: 'New Item'})
  });
  const item = await r.json();
  if (!STATE.items.find(i => i.id === item.id)) STATE.items.push(item);
  if (labelId) await saveValue(item.id, statusColId, {label_id: labelId});
  render();
}

// ── Calendar view ─────────────────────────────────────────────────────────

function renderCalendarView(){
  const container = document.getElementById('boardScroll');
  const dateCol = STATE.columns.find(c => c.type === 'date');
  if (!dateCol) {
    container.innerHTML = `<div class="empty-state">Add a Date column to use the Calendar view.</div>`;
    return;
  }
  const statusCol = STATE.columns.find(c => c.type === 'status');
  const year = CALENDAR_VIEW_DATE.getFullYear();
  const month = CALENDAR_VIEW_DATE.getMonth();
  const startWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();
  const monthLabel = new Date(year, month, 1).toLocaleDateString('en-US', {month:'long', year:'numeric'});
  const todayStr = new Date().toISOString().slice(0, 10);

  const items = applyFilterSearch(STATE.items.slice()).filter(i => (i.values[dateCol.id] || {}).date);
  const itemsByDate = {};
  items.forEach(i => {
    const d = i.values[dateCol.id].date;
    (itemsByDate[d] = itemsByDate[d] || []).push(i);
  });

  let cellsHtml = '';
  for (let i = startWeekday - 1; i >= 0; i--) {
    cellsHtml += `<div class="cal-cell cal-outside"><div class="cal-daynum">${daysInPrevMonth - i}</div></div>`;
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const dayItems = itemsByDate[dateStr] || [];
    cellsHtml += `<div class="cal-cell ${dateStr === todayStr ? 'cal-today' : ''}">
      <div class="cal-daynum">${day}</div>
      <div class="cal-items">${dayItems.map(i => renderCalendarChip(i, statusCol)).join('')}</div>
      <div class="cal-add" onclick="addCalendarItem('${dateStr}', ${dateCol.id})">+ Add</div>
    </div>`;
  }
  const trailing = (7 - ((startWeekday + daysInMonth) % 7)) % 7;
  for (let i = 1; i <= trailing; i++) {
    cellsHtml += `<div class="cal-cell cal-outside"><div class="cal-daynum">${i}</div></div>`;
  }

  container.innerHTML = `
    <div class="calendar-toolbar">
      <button class="tb-btn" onclick="calendarNav(-1)">‹ Prev</button>
      <span class="calendar-month-label">${monthLabel}</span>
      <button class="tb-btn" onclick="calendarNav(1)">Next ›</button>
      <button class="tb-btn" onclick="calendarToday()">Today</button>
    </div>
    <div class="calendar-grid">
      ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => `<div class="cal-weekday">${d}</div>`).join('')}
      ${cellsHtml}
    </div>`;
}
function renderCalendarChip(item, statusCol){
  let color = '#579bfc';
  if (statusCol) {
    const label = (statusCol.settings.labels || []).find(l => l.id === (item.values[statusCol.id] || {}).label_id);
    if (label) color = label.color;
  }
  return `<div class="cal-chip" style="border-left-color:${color};" onclick="event.stopPropagation(); openUpdates(${item.id})">${esc(item.name)}</div>`;
}
function calendarNav(delta){
  CALENDAR_VIEW_DATE = new Date(CALENDAR_VIEW_DATE.getFullYear(), CALENDAR_VIEW_DATE.getMonth() + delta, 1);
  render();
}
function calendarToday(){
  CALENDAR_VIEW_DATE = new Date();
  render();
}
async function addCalendarItem(dateStr, dateColId){
  const group = STATE.groups[0];
  if (!group) return;
  const r = await fetch(`/api/groups/${group.id}/items`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({name: 'New Item'})
  });
  const item = await r.json();
  if (!STATE.items.find(i => i.id === item.id)) STATE.items.push(item);
  await saveValue(item.id, dateColId, {date: dateStr});
  render();
}

// ── Dashboard view ────────────────────────────────────────────────────────

function renderDashboardView(){
  const container = document.getElementById('boardScroll');
  const statusCol = STATE.columns.find(c => c.type === 'status');
  const priorityCol = STATE.columns.find(c => c.type === 'priority');
  const personCol = STATE.columns.find(c => c.type === 'person');
  const numberCols = STATE.columns.filter(c => c.type === 'number' || c.type === 'progress');
  const items = STATE.items;

  const kpis = [`<div class="dash-kpi"><div class="dash-kpi-num">${items.length}</div><div class="dash-kpi-label">Total Items</div></div>`]
    .concat(numberCols.map(c => {
      const sum = items.reduce((acc,i) => acc + (Number((i.values[c.id]||{}).number) || 0), 0);
      return `<div class="dash-kpi"><div class="dash-kpi-num">${sum}${c.type==='progress'?'%':''}</div><div class="dash-kpi-label">${esc(c.name)} total</div></div>`;
    }));

  let cards = '';
  if (statusCol) cards += renderDashDistribution('Status Breakdown', statusCol, items);
  if (priorityCol) cards += renderDashDistribution('Priority Breakdown', priorityCol, items);
  if (personCol) cards += renderDashWorkload(personCol, items);

  if (!statusCol && !priorityCol && !personCol && !numberCols.length) {
    container.innerHTML = `<div class="empty-state">Add a Status, Priority, Person, or Number column to see reporting here.</div>`;
    return;
  }
  container.innerHTML = `
    <div class="dash-kpi-row">${kpis.join('')}</div>
    <div class="dashboard-grid">${cards}</div>`;
}
function renderDashDistribution(title, col, items){
  const labels = col.settings.labels || [];
  const counts = labels.map(l => items.filter(i => (i.values[col.id]||{}).label_id === l.id).length);
  const noneCount = items.filter(i => !(i.values[col.id]||{}).label_id).length;
  const max = Math.max(1, ...counts, noneCount);
  let rows = labels.map((l, idx) => dashBarRow(l.text, l.color, counts[idx], max)).join('');
  if (noneCount) rows += dashBarRow(`No ${col.name}`, 'var(--pill-empty)', noneCount, max);
  return `<div class="dash-card"><div class="dash-card-title">${esc(title)}</div>${rows}</div>`;
}
function renderDashWorkload(personCol, items){
  const counts = {};
  items.forEach(i => {
    const ids = (i.values[personCol.id] || {}).user_ids || [];
    if (!ids.length) counts.__unassigned = (counts.__unassigned || 0) + 1;
    ids.forEach(uid => { counts[uid] = (counts[uid] || 0) + 1; });
  });
  const entries = Object.entries(counts).map(([k, v]) => {
    if (k === '__unassigned') return {name: 'Unassigned', color: 'var(--pill-empty)', count: v};
    const u = ALL_USERS.find(x => x.id === Number(k));
    return {name: u ? u.name : 'Unknown', color: u ? u.color : 'var(--pill-empty)', count: v};
  }).sort((a, b) => b.count - a.count);
  const max = Math.max(1, ...entries.map(e => e.count));
  const rows = entries.map(e => dashBarRow(e.name, e.color, e.count, max)).join('');
  return `<div class="dash-card"><div class="dash-card-title">Workload by Person</div>${rows || '<div class="empty-state" style="padding:12px;">No one assigned yet.</div>'}</div>`;
}
function dashBarRow(label, color, count, max){
  return `<div class="dash-bar-row">
    <span class="dash-bar-label">${esc(label)}</span>
    <div class="dash-bar-track"><div class="dash-bar-fill" style="width:${(count/max*100)}%;background:${color};"></div></div>
    <span class="dash-bar-count">${count}</span>
  </div>`;
}

// ── Drag-and-drop reordering (items + groups) ────────────────────────────
// Disabled for items while a Sort is active, since the on-screen order
// wouldn't match stored position — same rule real monday.com applies.

function onRowDragStart(evt, itemId){
  evt.stopPropagation();
  DRAG_ITEM_ID = itemId;
  evt.dataTransfer.effectAllowed = 'move';
}
function onRowDragEnd(){ DRAG_ITEM_ID = null; }
function onRowDragOver(evt){
  if (DRAG_ITEM_ID == null) return;
  evt.preventDefault();
  evt.currentTarget.classList.add('drag-over-row');
}
function onRowDragLeave(evt){ evt.currentTarget.classList.remove('drag-over-row'); }
async function onRowDrop(evt, targetGroupId, targetItemId){
  evt.preventDefault();
  evt.currentTarget.classList.remove('drag-over-row');
  if (DRAG_ITEM_ID == null || DRAG_ITEM_ID === targetItemId) return;
  await moveItemRelativeTo(DRAG_ITEM_ID, targetGroupId, targetItemId);
  DRAG_ITEM_ID = null;
}
async function moveItemRelativeTo(draggedId, targetGroupId, beforeItemId){
  const dragged = STATE.items.find(i => i.id === draggedId);
  if (!dragged) return;
  const sourceGroupId = dragged.group_id;

  let destItems = STATE.items.filter(i => i.group_id === targetGroupId && i.id !== draggedId)
    .sort((a,b) => a.position - b.position);
  const insertAt = beforeItemId != null ? destItems.findIndex(i => i.id === beforeItemId) : destItems.length;
  destItems.splice(insertAt < 0 ? destItems.length : insertAt, 0, dragged);

  const updates = destItems.map((it, idx) => ({id: it.id, group_id: targetGroupId, position: idx}));
  if (sourceGroupId !== targetGroupId) {
    const sourceItems = STATE.items.filter(i => i.group_id === sourceGroupId && i.id !== draggedId)
      .sort((a,b) => a.position - b.position);
    sourceItems.forEach((it, idx) => updates.push({id: it.id, group_id: sourceGroupId, position: idx}));
  }

  updates.forEach(u => {
    const it = STATE.items.find(i => i.id === u.id);
    if (it) { it.group_id = u.group_id; it.position = u.position; }
  });
  render();

  await fetch('/api/items/reorder', {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({items: updates})
  });
}

function onGroupDragStart(evt, groupId){
  evt.stopPropagation();
  DRAG_GROUP_ID = groupId;
}
function onGroupDragOver(evt){
  if (DRAG_GROUP_ID == null) return;
  evt.preventDefault();
}
async function onGroupDrop(evt, targetGroupId){
  evt.preventDefault();
  if (DRAG_GROUP_ID == null || DRAG_GROUP_ID === targetGroupId) return;
  const ordered = STATE.groups.slice().sort((a,b) => a.position - b.position).map(g => g.id);
  const fromIdx = ordered.indexOf(DRAG_GROUP_ID);
  ordered.splice(fromIdx, 1);
  const toIdx = ordered.indexOf(targetGroupId);
  ordered.splice(toIdx, 0, DRAG_GROUP_ID);
  DRAG_GROUP_ID = null;
  ordered.forEach((gid, idx) => { const g = STATE.groups.find(x => x.id === gid); if (g) g.position = idx; });
  render();
  await fetch(`/api/boards/${BOARD_ID}/reorder_groups`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({group_ids: ordered})
  });
}

// ── Bulk selection + actions ──────────────────────────────────────────────

function toggleSelectItem(itemId){
  if (SELECTED_ITEMS.has(itemId)) SELECTED_ITEMS.delete(itemId); else SELECTED_ITEMS.add(itemId);
  renderBulkBar();
  render();
}
function toggleSelectAllInGroup(groupId){
  const ids = itemsForGroup(groupId).map(i => i.id);
  const allSelected = ids.length > 0 && ids.every(id => SELECTED_ITEMS.has(id));
  ids.forEach(id => allSelected ? SELECTED_ITEMS.delete(id) : SELECTED_ITEMS.add(id));
  renderBulkBar();
  render();
}
function clearSelection(){ SELECTED_ITEMS.clear(); renderBulkBar(); render(); }
function renderBulkBar(){
  const bar = document.getElementById('bulkActionBar');
  if (!bar) return;
  if (!SELECTED_ITEMS.size) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  bar.innerHTML = `
    <b>${SELECTED_ITEMS.size} selected</b>
    <button class="tb-btn" onclick="bulkDuplicate()">⎘ Duplicate</button>
    <button class="tb-btn" onclick="bulkSetStatus(event)">🏷 Set Status</button>
    <button class="tb-btn" style="color:#ff6b81;" onclick="bulkDelete()">🗑 Delete</button>
    <button class="tb-btn" onclick="clearSelection()">✕ Clear</button>`;
}
function bulkDelete(){
  const ids = Array.from(SELECTED_ITEMS);
  const items = STATE.items.filter(i => ids.includes(i.id));
  STATE.items = STATE.items.filter(i => !ids.includes(i.id));
  SELECTED_ITEMS.clear();
  renderBulkBar();
  render();
  showUndoToast(`Deleted ${ids.length} item${ids.length===1?'':'s'}`, () => {
    STATE.items.push(...items);
    render();
  }, async () => {
    await fetch('/api/items/bulk_delete', {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ids})
    });
  });
}
async function bulkDuplicate(){
  const ids = Array.from(SELECTED_ITEMS);
  await fetch('/api/items/bulk_duplicate', {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ids})
  });
  SELECTED_ITEMS.clear();
  renderBulkBar();
}
function bulkSetStatus(evt){
  const statusCol = STATE.columns.find(c => c.type === 'status');
  if (!statusCol) return;
  const labels = statusCol.settings.labels || [];
  openMenuAt(evt, labels.map(l => `
    <div class="menu-item" onclick="applyBulkStatus(${statusCol.id},'${l.id}')">
      <span class="picker-swatch" style="background:${l.color};"></span>${esc(l.text)}
    </div>`).join(''));
}
async function applyBulkStatus(columnId, labelId){
  closeAllMenus();
  const ids = Array.from(SELECTED_ITEMS);
  await fetch('/api/items/bulk_set_value', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ids, column_id: columnId, value: {label_id: labelId}})
  });
  SELECTED_ITEMS.clear();
  renderBulkBar();
}

// ── Group management (rename / color / duplicate / delete) ──────────────

async function saveGroupName(groupId, el){
  const name = el.textContent.trim() || 'New Group';
  el.textContent = name;
  await fetch(`/api/groups/${groupId}`, {
    method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({name})
  });
}
function focusGroupNameEdit(groupId){
  const el = document.querySelector(`.group-block[data-group-id="${groupId}"] .group-name`);
  if (el) el.focus();
}
function openGroupMenu(evt, groupId){
  const swatches = GROUP_COLORS.map(c => `
    <span class="picker-swatch" style="background:${c};cursor:pointer;display:inline-block;margin:3px;width:18px;height:18px;"
          onclick="setGroupColor(${groupId}, '${c}')"></span>`).join('');
  openMenuAt(evt, `
    <div class="menu-item" onclick="closeAllMenus(); focusGroupNameEdit(${groupId})">✎ Rename</div>
    <div class="menu-item" onclick="duplicateGroup(${groupId})">⎘ Duplicate</div>
    <div class="menu-sep"></div>
    <div class="filter-col-name" style="padding:4px 10px;">Color</div>
    <div style="padding:0 6px 6px;">${swatches}</div>
    <div class="menu-sep"></div>
    <div class="menu-item danger" onclick="confirmDeleteGroup(${groupId})">🗑 Delete</div>
  `);
}
async function setGroupColor(groupId, color){
  closeAllMenus();
  await fetch(`/api/groups/${groupId}`, {
    method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({color})
  });
}
async function duplicateGroup(groupId){
  closeAllMenus();
  await fetch(`/api/groups/${groupId}/duplicate`, {method: 'POST'});
}
function confirmDeleteGroup(groupId){
  closeAllMenus();
  const group = STATE.groups.find(g => g.id === groupId);
  const groupItems = STATE.items.filter(i => i.group_id === groupId);
  STATE.groups = STATE.groups.filter(g => g.id !== groupId);
  STATE.items = STATE.items.filter(i => i.group_id !== groupId);
  render();
  showUndoToast(`Deleted group "${group.name}"`, () => {
    STATE.groups.push(group);
    STATE.items.push(...groupItems);
    render();
  }, async () => {
    await fetch(`/api/groups/${groupId}`, {method: 'DELETE'});
  });
}

// ── Mutations ────────────────────────────────────────────────────────────

async function saveValue(itemId, columnId, value){
  const item = STATE.items.find(i => i.id === itemId);
  if (item) item.values[columnId] = value;  // optimistic
  await fetch(`/api/items/${itemId}/values/${columnId}`, {
    method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({value})
  });
}

async function toggleTimeTracking(itemId, columnId){
  const item = STATE.items.find(i => i.id === itemId);
  const val = item.values[columnId] || {};
  if (val.running) {
    const elapsed = Math.floor((Date.now() - new Date(val.started_at).getTime()) / 1000);
    await saveValue(itemId, columnId, {running: false, started_at: null, total_seconds: (val.total_seconds || 0) + elapsed});
  } else {
    await saveValue(itemId, columnId, {running: true, started_at: new Date().toISOString(), total_seconds: val.total_seconds || 0});
  }
  render();
}

async function saveItemName(itemId, el){
  const name = el.textContent.trim() || 'Untitled';
  el.textContent = name;
  await fetch(`/api/items/${itemId}`, {
    method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({name})
  });
}

async function addItem(groupId, inputEl){
  const name = inputEl.value.trim();
  if (!name) return;
  inputEl.value = '';
  const r = await fetch(`/api/groups/${groupId}/items`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({name})
  });
  const item = await r.json();
  if (!STATE.items.find(i => i.id === item.id)) STATE.items.push(item);
  render();
}

async function addGroup(){
  const r = await fetch(`/api/boards/${BOARD_ID}/groups`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({name: 'New Group'})
  });
  const group = await r.json();
  if (!STATE.groups.find(g => g.id === group.id)) STATE.groups.push(group);
  render();
}

function toggleGroup(groupId){
  const g = STATE.groups.find(g => g.id === groupId);
  if (g) g.collapsed = !g.collapsed;
  render();
}

function wireBoardTitleEdit(){
  const el = document.getElementById('boardTitle');
  el.addEventListener('blur', async () => {
    const name = el.textContent.trim() || 'Untitled Board';
    el.textContent = name;
    await fetch(`/api/boards/${BOARD_ID}`, {
      method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({name})
    });
  });
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
}

function wireBoardDescEdit(){
  const el = document.getElementById('boardDesc');
  el.addEventListener('blur', async () => {
    await fetch(`/api/boards/${BOARD_ID}`, {
      method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({description: el.textContent.trim()})
    });
  });
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
}

// ── Generic popover menu helper (column/row/board-settings menus) ────────

function openMenuAt(evt, html){
  evt.stopPropagation();
  closePicker();
  closeAllMenus();
  const rect = evt.currentTarget.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'menu app-menu';
  menu.style.position = 'fixed';
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.left = Math.min(rect.left, window.innerWidth - 210) + 'px';
  menu.innerHTML = html;
  document.body.appendChild(menu);
}
function closeAllMenus(){ document.querySelectorAll('.app-menu').forEach(m => m.remove()); }

// ── Column header menu ────────────────────────────────────────────────────

function openColumnMenu(evt, colId){
  openMenuAt(evt, `
    <div class="menu-item" onclick="openRenameColumnModal(${colId})">✎ Rename</div>
    <div class="menu-item" onclick="duplicateColumn(${colId})">⎘ Duplicate</div>
    <div class="menu-sep"></div>
    <div class="menu-item danger" onclick="confirmDeleteColumn(${colId})">🗑 Delete</div>
  `);
}
function openRenameColumnModal(colId){
  closeAllMenus();
  const col = STATE.columns.find(c => c.id === colId);
  RENAME_COLUMN_ID = colId;
  document.getElementById('renameColName').value = col.name;
  document.getElementById('renameColumnModal').style.display = 'flex';
  document.getElementById('renameColName').focus();
}
function closeRenameColumnModal(){ document.getElementById('renameColumnModal').style.display = 'none'; }
async function submitRenameColumn(){
  const name = document.getElementById('renameColName').value.trim();
  if (name && RENAME_COLUMN_ID) {
    await fetch(`/api/columns/${RENAME_COLUMN_ID}`, {
      method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({name})
    });
  }
  closeRenameColumnModal();
}
async function duplicateColumn(colId){
  closeAllMenus();
  await fetch(`/api/columns/${colId}/duplicate`, {method: 'POST'});
}
function confirmDeleteColumn(colId){
  closeAllMenus();
  const col = STATE.columns.find(c => c.id === colId);
  STATE.columns = STATE.columns.filter(c => c.id !== colId);
  render();
  showUndoToast(`Deleted column "${col.name}"`, () => {
    STATE.columns.push(col);
    render();
  }, async () => {
    await fetch(`/api/columns/${colId}`, {method: 'DELETE'});
  });
}

// ── Row menu ──────────────────────────────────────────────────────────────

function openRowMenu(evt, itemId){
  openMenuAt(evt, `
    <div class="menu-item" onclick="closeAllMenus();openUpdates(${itemId})">⤢ Open</div>
    <div class="menu-item" onclick="duplicateItemRow(${itemId})">⎘ Duplicate</div>
    <div class="menu-sep"></div>
    <div class="menu-item danger" onclick="confirmDeleteItem(${itemId})">🗑 Delete</div>
  `);
}
async function duplicateItemRow(itemId){
  closeAllMenus();
  await fetch(`/api/items/${itemId}/duplicate`, {method: 'POST'});
}
function confirmDeleteItem(itemId){
  closeAllMenus();
  const item = STATE.items.find(i => i.id === itemId);
  STATE.items = STATE.items.filter(i => i.id !== itemId);
  render();
  showUndoToast(`Deleted "${item.name}"`, () => {
    STATE.items.push(item);
    render();
  }, async () => {
    await fetch(`/api/items/${itemId}`, {method: 'DELETE'});
  });
}

// ── Board settings menu (star / duplicate / move / archive / delete) ────

function toggleBoardStar(){
  const newVal = !STATE.board.starred;
  STATE.board.starred = newVal;
  document.getElementById('boardStarBtn').classList.toggle('starred', newVal);
  fetch(`/api/boards/${BOARD_ID}`, {
    method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({starred: newVal})
  });
}
async function openBoardSettingsMenu(evt){
  evt.stopPropagation();
  const folders = await fetch('/api/folders').then(r => r.json());
  const folderItems = folders.map(f => `<div class="menu-item" onclick="moveBoardToFolder(${f.id})">📁 ${esc(f.name)}</div>`).join('');
  openMenuAt(evt, `
    <div class="menu-item" onclick="closeAllMenus(); openAutomationsModal();">⚡ Automations</div>
    <div class="menu-sep"></div>
    <div class="menu-item" onclick="duplicateBoardFromPage()">⎘ Duplicate board</div>
    <div class="menu-item" onclick="closeAllMenus(); exportBoardCSV();">⬇ Export to CSV</div>
    <div class="menu-item" onclick="closeAllMenus(); openImportCSVModal();">⬆ Import CSV</div>
    <div class="menu-sep"></div>
    <div class="filter-col-name" style="padding:6px 10px 2px;">Move to folder</div>
    <div class="menu-item" onclick="moveBoardToFolder(null)">— No folder</div>
    ${folderItems}
    <div class="menu-sep"></div>
    <div class="menu-item" onclick="archiveBoardFromPage()">🗄 Archive board</div>
    <div class="menu-item danger" onclick="confirmDeleteBoard()">🗑 Delete board</div>
  `);
}
async function duplicateBoardFromPage(){
  closeAllMenus();
  const r = await fetch(`/api/boards/${BOARD_ID}/duplicate`, {method: 'POST'});
  const board = await r.json();
  window.location.href = '/board/' + board.id;
}
async function moveBoardToFolder(folderId){
  closeAllMenus();
  await fetch(`/api/boards/${BOARD_ID}`, {
    method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({folder_id: folderId})
  });
}
async function archiveBoardFromPage(){
  closeAllMenus();
  await fetch(`/api/boards/${BOARD_ID}`, {
    method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({archived: true})
  });
  window.location.href = '/';
}
function confirmDeleteBoard(){
  closeAllMenus();
  confirmAction('Delete board', `Delete "${STATE.board.name}" permanently? This can't be undone.`, 'Delete', async () => {
    await fetch(`/api/boards/${BOARD_ID}`, {method: 'DELETE'});
    window.location.href = '/';
  });
}

// ── Filter / Sort / Hide toolbar panels ──────────────────────────────────

function toggleFilterPanel(evt){
  evt.stopPropagation();
  if (document.getElementById('filterPanelEl')) { closeAllMenus(); return; }
  closeAllMenus();
  const cols = STATE.columns.filter(c => ['status','priority','dropdown'].includes(c.type));
  let html = cols.length ? '' : `<div style="padding:6px;color:var(--text-faint);font-size:12px;">No filterable columns (add a Status, Priority, or Dropdown column)</div>`;
  cols.forEach(c => {
    const opts = c.type === 'dropdown' ? (c.settings.options || []) : (c.settings.labels || []);
    const selected = FILTER_STATE[c.id] || new Set();
    html += `<div class="filter-col-block"><div class="filter-col-name">${esc(c.name)}</div>`;
    opts.forEach(o => {
      const on = selected.has(o.id);
      html += `<span class="filter-chip ${on?'on':''}" style="background:${o.color || '#579bfc'};" onclick="toggleFilterChip(${c.id},'${o.id}')">${esc(o.text)}</span>`;
    });
    html += `</div>`;
  });
  if (cols.length) html += `<div class="menu-item" style="justify-content:center;color:var(--accent-blue);" onclick="clearFilters()">Clear all filters</div>`;
  const rect = evt.currentTarget.getBoundingClientRect();
  const panel = document.createElement('div');
  panel.id = 'filterPanelEl';
  panel.className = 'filter-panel app-menu';
  panel.style.position = 'fixed'; panel.style.top = (rect.bottom+6)+'px'; panel.style.left = rect.left+'px';
  panel.innerHTML = html;
  document.body.appendChild(panel);
}
function toggleFilterChip(colId, optId){
  if (!FILTER_STATE[colId]) FILTER_STATE[colId] = new Set();
  const set = FILTER_STATE[colId];
  if (set.has(optId)) set.delete(optId); else set.add(optId);
  closeAllMenus();
  updateToolbarActiveStates();
  render();
}
function clearFilters(){ FILTER_STATE = {}; closeAllMenus(); updateToolbarActiveStates(); render(); }

function toggleSortPanel(evt){
  evt.stopPropagation();
  if (document.getElementById('sortPanelEl')) { closeAllMenus(); return; }
  closeAllMenus();
  const sortable = STATE.columns.filter(c => !['person','link','files','timeline'].includes(c.type));
  let html = sortable.map(c => `
    <div class="sort-row" onclick="setSort(${c.id},'asc')"><span>${esc(c.name)}</span><span>↑</span></div>
    <div class="sort-row" onclick="setSort(${c.id},'desc')"><span>${esc(c.name)}</span><span>↓</span></div>
  `).join('');
  html += `<div class="menu-sep"></div><div class="menu-item" onclick="clearSort()">Clear sort</div>`;
  const rect = evt.currentTarget.getBoundingClientRect();
  const panel = document.createElement('div');
  panel.id = 'sortPanelEl';
  panel.className = 'sort-panel app-menu';
  panel.style.position = 'fixed'; panel.style.top = (rect.bottom+6)+'px'; panel.style.left = rect.left+'px';
  panel.innerHTML = html;
  document.body.appendChild(panel);
}
function setSort(colId, dir){
  SORT_STATE = {columnId: colId, dir};
  closeAllMenus();
  updateToolbarActiveStates();
  render();
}
function clearSort(){
  SORT_STATE = {columnId: null, dir: 'asc'};
  closeAllMenus();
  updateToolbarActiveStates();
  render();
}

function toggleHidePanel(evt){
  evt.stopPropagation();
  if (document.getElementById('hidePanelEl')) { closeAllMenus(); return; }
  closeAllMenus();
  const rect = evt.currentTarget.getBoundingClientRect();
  const panel = document.createElement('div');
  panel.id = 'hidePanelEl';
  panel.className = 'hide-panel app-menu';
  panel.style.position = 'fixed'; panel.style.top = (rect.bottom+6)+'px'; panel.style.left = rect.left+'px';
  panel.innerHTML = hidePanelRows();
  document.body.appendChild(panel);
}
function hidePanelRows(){
  return STATE.columns.map(c => `
    <div class="hide-row" onclick="toggleHideColumn(${c.id})">
      <span>${esc(c.name)}</span><input type="checkbox" ${HIDDEN_COLS.has(c.id)?'':'checked'} onclick="return false;"/>
    </div>`).join('');
}
function toggleHideColumn(colId){
  if (HIDDEN_COLS.has(colId)) HIDDEN_COLS.delete(colId); else HIDDEN_COLS.add(colId);
  saveHiddenCols();
  updateToolbarActiveStates();
  const panel = document.getElementById('hidePanelEl');
  if (panel) panel.innerHTML = hidePanelRows();
  render();
}
function updateToolbarActiveStates(){
  const filterBtn = document.getElementById('filterBtn');
  const sortBtn = document.getElementById('sortBtn');
  const hideBtn = document.getElementById('hideBtn');
  if (filterBtn) filterBtn.classList.toggle('active-filter', Object.values(FILTER_STATE).some(s => s.size));
  if (sortBtn) sortBtn.classList.toggle('active-filter', !!SORT_STATE.columnId);
  if (hideBtn) hideBtn.classList.toggle('active-filter', HIDDEN_COLS.size > 0);
}

// ── Column modal ─────────────────────────────────────────────────────────

function openNewColumnModal(){ document.getElementById('newColumnModal').style.display = 'flex'; }
function closeNewColumnModal(){
  document.getElementById('newColumnModal').style.display = 'none';
  document.getElementById('newColName').value = '';
}
async function submitNewColumn(){
  const name = document.getElementById('newColName').value.trim();
  const type = document.getElementById('newColType').value;
  if (!name) return;
  const r = await fetch(`/api/boards/${BOARD_ID}/columns`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({name, type})
  });
  const col = await r.json();
  if (!STATE.columns.find(c => c.id === col.id)) STATE.columns.push(col);
  closeNewColumnModal();
  render();
}

// New-board modal (sidebar's "+ New Board" also works from inside a board page)
function openNewBoardModal(){
  document.getElementById('newBoardModal').style.display = 'flex';
  populateBoardTemplateSelect();
}
function closeNewBoardModal(){
  document.getElementById('newBoardModal').style.display = 'none';
  document.getElementById('newBoardName').value = '';
}
async function submitNewBoard(){
  const name = document.getElementById('newBoardName').value.trim();
  if (!name) return;
  const template = document.getElementById('newBoardTemplate').value;
  const r = await fetch('/api/boards', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({name, template})
  });
  const board = await r.json();
  window.location.href = '/board/' + board.id;
}

// New-view modal
function openNewViewModal(){
  document.getElementById('newViewModal').style.display = 'flex';
  document.getElementById('newViewName').focus();
}
function closeNewViewModal(){
  document.getElementById('newViewModal').style.display = 'none';
  document.getElementById('newViewName').value = '';
}
async function submitNewView(){
  const name = document.getElementById('newViewName').value.trim() || 'View';
  const type = document.getElementById('newViewType').value;
  const r = await fetch(`/api/boards/${BOARD_ID}/views`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({name, type})
  });
  const view = await r.json();
  if (!STATE.views.find(v => v.id === view.id)) STATE.views.push(view);
  STATE.currentViewId = view.id;
  closeNewViewModal();
  render();
}

// ── Pickers (status/priority, person, dropdown, files, progress) ────────

function closePicker(){
  document.querySelectorAll('.picker').forEach(p => p.remove());
}

function openLabelPicker(evt, itemId, columnId){
  evt.stopPropagation();
  closePicker();
  const col = STATE.columns.find(c => c.id === columnId);
  const labels = col.settings.labels || [];
  const picker = document.createElement('div');
  picker.className = 'picker';
  picker.innerHTML = labels.map(l => `
    <div class="picker-option" onclick="pickLabel(${itemId},${columnId},'${l.id}')">
      <span class="picker-swatch" style="background:${l.color};"></span>${esc(l.text)}
    </div>`).join('') + `<div class="picker-option" onclick="pickLabel(${itemId},${columnId},null)" style="color:#9699a6;">Clear</div>`;
  evt.currentTarget.appendChild(picker);
}
function pickLabel(itemId, columnId, labelId){
  saveValue(itemId, columnId, labelId ? {label_id: labelId} : {});
  closePicker();
  render();
}

function openPersonPicker(evt, itemId, columnId){
  evt.stopPropagation();
  closePicker();
  const item = STATE.items.find(i => i.id === itemId);
  const current = new Set((item.values[columnId] || {}).user_ids || []);
  const picker = document.createElement('div');
  picker.className = 'picker';
  picker.innerHTML = ALL_USERS.map(u => `
    <div class="picker-option ${current.has(u.id) ? 'selected' : ''}" onclick="togglePerson(${itemId},${columnId},${u.id})">
      <span class="picker-swatch" style="background:${u.color};border-radius:50%;"></span>${esc(u.name)}
    </div>`).join('');
  evt.currentTarget.appendChild(picker);
}
function togglePerson(itemId, columnId, userId){
  const item = STATE.items.find(i => i.id === itemId);
  const current = new Set((item.values[columnId] || {}).user_ids || []);
  if (current.has(userId)) current.delete(userId); else current.add(userId);
  saveValue(itemId, columnId, {user_ids: Array.from(current)});
  closePicker();
  render();
}

function openDropdownPicker(evt, itemId, columnId){
  evt.stopPropagation();
  closePicker();
  const col = STATE.columns.find(c => c.id === columnId);
  let opts = col.settings.options || [];
  const item = STATE.items.find(i => i.id === itemId);
  const current = new Set((item.values[columnId] || {}).option_ids || []);
  const picker = document.createElement('div');
  picker.className = 'picker';
  const renderOpts = () => opts.map(o => `
    <div class="picker-option ${current.has(o.id) ? 'selected' : ''}" onclick="toggleDropdownOption(${itemId},${columnId},'${o.id}')">${esc(o.text)}</div>
  `).join('');
  picker.innerHTML = `<div id="dropdownOptsList">${renderOpts()}</div>
    <div style="display:flex;gap:4px;padding:6px;border-top:1px solid var(--border);margin-top:4px;">
      <input id="newDropdownOpt" placeholder="Add option" style="flex:1;border:1px solid var(--border);border-radius:6px;padding:5px 8px;font-size:12px;background:var(--bg-app);color:var(--text);"/>
      <button onclick="addDropdownOption(${columnId})" style="border:none;background:var(--accent-blue);color:#fff;border-radius:6px;padding:0 10px;cursor:pointer;">+</button>
    </div>`;
  evt.currentTarget.appendChild(picker);
}
function toggleDropdownOption(itemId, columnId, optId){
  const item = STATE.items.find(i => i.id === itemId);
  const current = new Set((item.values[columnId] || {}).option_ids || []);
  if (current.has(optId)) current.delete(optId); else current.add(optId);
  saveValue(itemId, columnId, {option_ids: Array.from(current)});
  closePicker();
  render();
}
async function addDropdownOption(columnId){
  const input = document.getElementById('newDropdownOpt');
  const text = input.value.trim();
  if (!text) return;
  const col = STATE.columns.find(c => c.id === columnId);
  const opts = (col.settings.options || []).concat([{id: 'o' + Date.now(), text}]);
  const newSettings = Object.assign({}, col.settings, {options: opts});
  const r = await fetch(`/api/columns/${columnId}`, {
    method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({settings: newSettings})
  });
  const updated = await r.json();
  col.settings = updated.settings;
  closePicker();
  render();
}

function openProgressEditor(evt, itemId, columnId, currentPct){
  evt.stopPropagation();
  closePicker();
  const picker = document.createElement('div');
  picker.className = 'picker progress-picker';
  picker.innerHTML = `
    <input id="progressInput" type="number" min="0" max="100" value="${currentPct}"/>
    <button onclick="saveProgress(${itemId},${columnId})">Set</button>`;
  evt.currentTarget.appendChild(picker);
  document.getElementById('progressInput').focus();
}
function saveProgress(itemId, columnId){
  const input = document.getElementById('progressInput');
  const pct = Math.max(0, Math.min(100, Number(input.value) || 0));
  saveValue(itemId, columnId, {number: pct});
  closePicker();
  render();
}

function openFilesPicker(evt, itemId, columnId){
  evt.stopPropagation();
  closePicker();
  const item = STATE.items.find(i => i.id === itemId);
  const files = (item.values[columnId] || {}).files || [];
  const picker = document.createElement('div');
  picker.className = 'picker files-picker';
  const renderList = () => files.map((f, idx) => `
    <span class="file-chip"><a href="${esc(f.url)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;">📎 ${esc(f.name)}</a>
      <span class="file-chip-x" onclick="removeFileEntry(${itemId},${columnId},${idx})">✕</span></span>`).join('');
  picker.innerHTML = `
    <div class="files-picker-list">${renderList()}</div>
    <div class="files-picker-row"><input id="fileNameInput" placeholder="Name"/></div>
    <div class="files-picker-row">
      <input id="fileUrlInput" placeholder="https://…"/>
      <button onclick="addFileEntry(${itemId},${columnId})" style="border:none;background:var(--accent-blue);color:#fff;border-radius:6px;padding:0 10px;cursor:pointer;">+</button>
    </div>`;
  evt.currentTarget.appendChild(picker);
}
function addFileEntry(itemId, columnId){
  const name = document.getElementById('fileNameInput').value.trim();
  const url = document.getElementById('fileUrlInput').value.trim();
  if (!name || !url) return;
  const item = STATE.items.find(i => i.id === itemId);
  const files = ((item.values[columnId] || {}).files || []).concat([{name, url}]);
  saveValue(itemId, columnId, {files});
  closePicker();
  render();
}
function removeFileEntry(itemId, columnId, idx){
  const item = STATE.items.find(i => i.id === itemId);
  const files = ((item.values[columnId] || {}).files || []).slice();
  files.splice(idx, 1);
  saveValue(itemId, columnId, {files});
  closePicker();
  render();
}

// ── Item card (expanded item detail: fields + Updates thread) ───────────

async function openUpdates(itemId){
  const item = STATE.items.find(i => i.id === itemId);
  const panel = document.getElementById('updatesPanel');
  panel.dataset.itemId = itemId;
  panel.style.display = 'flex';
  panel.style.flexDirection = 'column';
  panel.innerHTML = `
    <div class="updates-hdr">
      <span class="item-card-name" contenteditable="true"
            onblur="saveItemName(${itemId}, this)"
            onkeydown="if(event.key==='Enter'){event.preventDefault(); this.blur();}">${esc(item.name)}</span>
      <span style="cursor:pointer;color:var(--text-faint);" onclick="closeUpdates()">✕</span>
    </div>
    <div class="item-card-fields">
      ${STATE.columns.map(c => `
        <div class="item-card-field-row">
          <div class="item-card-field-label">${esc(c.name)}</div>
          <div class="item-card-field-value">${renderCell(item, c)}</div>
        </div>`).join('')}
    </div>
    <div class="item-card-divider"></div>
    <div class="updates-list" id="updatesList" style="flex:1;"><div style="color:var(--text-faint);font-size:12px;">Loading…</div></div>
    <div class="updates-input-row">
      <textarea id="newUpdateBody" placeholder="Write an update…"></textarea>
      <button class="btn-primary" onclick="postUpdate(${itemId})">Post</button>
    </div>`;
  const r = await fetch(`/api/items/${itemId}/updates`);
  const updates = await r.json();
  const list = document.getElementById('updatesList');
  list.innerHTML = updates.length ? '' : '<div style="color:var(--text-faint);font-size:12px;">No updates yet.</div>';
  updates.forEach(u => appendUpdateToPanel(Object.assign({}, u, {user: ALL_USERS.find(x => x.id === u.user_id)})));
}
function closeUpdates(){
  document.getElementById('updatesPanel').style.display = 'none';
}
function appendUpdateToPanel(upd){
  const list = document.getElementById('updatesList');
  if (!list) return;
  const empty = list.querySelector('div');
  if (empty && list.children.length === 1 && empty.textContent.includes('No updates')) list.innerHTML = '';
  const name = upd.user ? upd.user.name : 'Someone';
  const when = upd.created_at ? new Date(upd.created_at).toLocaleString('en-US', {dateStyle:'medium', timeStyle:'short'}) : '';
  const div = document.createElement('div');
  div.className = 'update-item';
  div.innerHTML = `<div class="update-meta"><b>${esc(name)}</b> · ${when}</div><div class="update-body">${esc(upd.body)}</div>`;
  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
}
async function postUpdate(itemId){
  const ta = document.getElementById('newUpdateBody');
  const body = ta.value.trim();
  if (!body) return;
  ta.value = '';
  await fetch(`/api/items/${itemId}/updates`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({body})
  });
}

// ── CSV export / import ───────────────────────────────────────────────────

function exportBoardCSV(){
  window.location.href = `/api/boards/${BOARD_ID}/export.csv`;
}
let IMPORT_CSV_TEXT = '';
function openImportCSVModal(){ document.getElementById('importCsvModal').style.display = 'flex'; }
function closeImportCSVModal(){
  document.getElementById('importCsvModal').style.display = 'none';
  document.getElementById('importCsvFile') && (document.getElementById('importCsvFile').value = '');
  document.getElementById('importCsvStatus').textContent = '';
  IMPORT_CSV_TEXT = '';
}
function readImportFile(input){
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { IMPORT_CSV_TEXT = reader.result; };
  reader.readAsText(file);
}
async function submitImportCSV(){
  const status = document.getElementById('importCsvStatus');
  if (!IMPORT_CSV_TEXT) { status.textContent = 'Choose a CSV file first.'; return; }
  status.textContent = 'Importing…';
  const r = await fetch(`/api/boards/${BOARD_ID}/import_csv`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({csv: IMPORT_CSV_TEXT})
  });
  const data = await r.json();
  if (!r.ok) { status.textContent = data.error || 'Import failed.'; return; }
  closeImportCSVModal();
  window.location.reload();
}

// ── Automations ("when status changes to X, do Y") ───────────────────────

async function openAutomationsModal(){
  document.getElementById('automationsModal').style.display = 'flex';
  populateAutomationForm();
  await refreshAutomationsList();
}
function closeAutomationsModal(){ document.getElementById('automationsModal').style.display = 'none'; }

function populateAutomationForm(){
  const triggerCols = STATE.columns.filter(c => c.type === 'status' || c.type === 'priority');
  const form = document.getElementById('automationsForm');
  const noCols = document.getElementById('automationsNoCols');
  if (!triggerCols.length) { form.style.display = 'none'; noCols.style.display = 'block'; return; }
  form.style.display = 'block'; noCols.style.display = 'none';

  const colSel = document.getElementById('autoColumn');
  colSel.innerHTML = triggerCols.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  colSel.onchange = updateAutoLabelOptions;
  updateAutoLabelOptions();

  document.getElementById('autoTargetGroup').innerHTML =
    STATE.groups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
  document.getElementById('autoTargetUser').innerHTML =
    ALL_USERS.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('');
  onAutoActionChange();
}
function updateAutoLabelOptions(){
  const colId = Number(document.getElementById('autoColumn').value);
  const col = STATE.columns.find(c => c.id === colId);
  const labels = (col && col.settings.labels) || [];
  document.getElementById('autoLabel').innerHTML = labels.map(l => `<option value="${l.id}">${esc(l.text)}</option>`).join('');
}
function onAutoActionChange(){
  const action = document.getElementById('autoAction').value;
  document.getElementById('autoTargetGroup').style.display = action === 'move_to_group' ? 'block' : 'none';
  document.getElementById('autoTargetUser').style.display = action === 'notify_person' ? 'block' : 'none';
}
async function refreshAutomationsList(){
  const rules = await fetch(`/api/boards/${BOARD_ID}/automations`).then(r => r.json());
  const list = document.getElementById('automationsList');
  list.innerHTML = rules.length ? rules.map(r => {
    const col = STATE.columns.find(c => c.id === r.column_id);
    const label = col ? (col.settings.labels || []).find(l => l.id === r.trigger_label_id) : null;
    let actionText;
    if (r.action_type === 'move_to_group') {
      const g = STATE.groups.find(x => x.id === r.target_group_id);
      actionText = `move to "${g ? esc(g.name) : '?'}"`;
    } else {
      const u = ALL_USERS.find(x => x.id === r.target_user_id);
      actionText = `notify ${u ? esc(u.name) : '?'}`;
    }
    return `<div class="sort-row">
      <span>When <b>${col ? esc(col.name) : '?'}</b> → "${label ? esc(label.text) : '?'}", ${actionText}</span>
      <span class="file-chip-x" onclick="deleteAutomation(${r.id})">✕</span>
    </div>`;
  }).join('') : `<div style="color:var(--text-faint);font-size:12px;">No automations yet.</div>`;
}
async function submitAutomation(){
  const column_id = Number(document.getElementById('autoColumn').value);
  const trigger_label_id = document.getElementById('autoLabel').value;
  const action_type = document.getElementById('autoAction').value;
  if (!trigger_label_id) return;
  const body = {column_id, trigger_label_id, action_type};
  if (action_type === 'move_to_group') body.target_group_id = Number(document.getElementById('autoTargetGroup').value);
  else body.target_user_id = Number(document.getElementById('autoTargetUser').value);
  await fetch(`/api/boards/${BOARD_ID}/automations`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)
  });
  await refreshAutomationsList();
}
async function deleteAutomation(id){
  await fetch(`/api/automations/${id}`, {method: 'DELETE'});
  await refreshAutomationsList();
}

init();
