// AJD Work — board (table view) rendering + real-time sync engine.
let STATE = { board: null, groups: [], columns: [], items: [] };
let ALL_USERS = [];
let socket = null;

function esc(s){ return (s==null?'':String(s)).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

async function init(){
  const [boardResp, usersResp] = await Promise.all([
    fetch(`/api/boards/${BOARD_ID}`).then(r => r.json()),
    fetch('/api/users').then(r => r.json()),
  ]);
  STATE.board = boardResp.board;
  STATE.groups = boardResp.groups.sort((a,b) => a.position - b.position);
  STATE.columns = boardResp.columns.sort((a,b) => a.position - b.position);
  STATE.items = boardResp.items;
  ALL_USERS = usersResp;
  render();
  connectSocket();
  wireBoardTitleEdit();
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.picker') && !e.target.closest('.cell')) closePicker();
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
    if (item) { item.values[column_id] = value; render(); }
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
  socket.on('group_created', (group) => {
    if (!STATE.groups.find(g => g.id === group.id)) STATE.groups.push(group);
    render();
  });
  socket.on('board_updated', (board) => {
    STATE.board = board;
    document.getElementById('boardTitle').textContent = board.name;
  });
  socket.on('update_posted', (upd) => {
    const panel = document.getElementById('updatesPanel');
    if (panel.dataset.itemId == upd.item_id) appendUpdateToPanel(upd);
  });
}

function itemsForGroup(groupId){
  return STATE.items.filter(i => i.group_id === groupId).sort((a,b) => a.position - b.position);
}

function render(){
  document.getElementById('boardScroll').innerHTML =
    STATE.groups.map(renderGroup).join('') +
    `<button class="add-group-btn" onclick="addGroup()">+ Add Group</button>`;
}

function renderGroup(group){
  const items = itemsForGroup(group.id);
  return `
    <div class="group-block" data-group-id="${group.id}">
      <div class="group-hdr" onclick="toggleGroup(${group.id})">
        <span class="group-collapse-arrow ${group.collapsed ? 'collapsed' : ''}">▼</span>
        <span class="group-name" style="color:${group.color};">${esc(group.name)}</span>
        <span class="group-count">${items.length} item${items.length===1?'':'s'}</span>
      </div>
      ${group.collapsed ? '' : renderTable(group, items)}
    </div>`;
}

function renderTable(group, items){
  return `
    <table class="board-table">
      <thead><tr>
        <th style="min-width:240px;">Item</th>
        ${STATE.columns.map(c => `<th style="width:${c.width}px;">${esc(c.name)}</th>`).join('')}
        <th style="width:36px;"><span class="add-col-btn" onclick="openNewColumnModal()">+</span></th>
      </tr></thead>
      <tbody>
        ${items.map(item => renderRow(group, item)).join('')}
        <tr class="add-item-row">
          <td colspan="${STATE.columns.length + 2}" style="border-left:4px solid ${group.color};">
            <input class="add-item-input" placeholder="+ Add item"
                   onkeydown="if(event.key==='Enter'){addItem(${group.id}, this);}"/>
          </td>
        </tr>
      </tbody>
    </table>`;
}

function renderRow(group, item){
  return `
    <tr data-item-id="${item.id}">
      <td class="item-name-cell" style="--gcolor:${group.color};" contenteditable="true"
          onblur="saveItemName(${item.id}, this)"
          onkeydown="if(event.key==='Enter'){event.preventDefault(); this.blur();}"
          ondblclick="openUpdates(${item.id})">${esc(item.name)}</td>
      ${STATE.columns.map(col => `<td>${renderCell(item, col)}</td>`).join('')}
      <td></td>
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
        ${label ? `<span class="pill" style="background:${label.color};">${esc(label.text)}</span>` : `<span class="pill empty">Empty</span>`}
      </div>`;
    }
    case 'person': {
      const ids = val.user_ids || [];
      const users = ids.map(uid => ALL_USERS.find(u => u.id === uid)).filter(Boolean);
      return `<div class="cell" onclick="openPersonPicker(event, ${item.id}, ${col.id})">
        ${users.length ? `<div class="avatar-stack">${users.map(u => `<div class="avatar" style="background:${u.color};" title="${esc(u.name)}">${esc(u.name[0].toUpperCase())}</div>`).join('')}</div>` : `<span class="pill empty">+</span>`}
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
        ${selected.length ? selected.map(o => `<span class="pill" style="background:#579bfc;margin-right:2px;">${esc(o.text)}</span>`).join('') : `<span class="pill empty">Empty</span>`}
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

// ── Mutations ────────────────────────────────────────────────────────────

async function saveValue(itemId, columnId, value){
  const item = STATE.items.find(i => i.id === itemId);
  if (item) item.values[columnId] = value;  // optimistic
  await fetch(`/api/items/${itemId}/values/${columnId}`, {
    method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({value})
  });
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
function openNewBoardModal(){ document.getElementById('newBoardModal').style.display = 'flex'; }
function closeNewBoardModal(){
  document.getElementById('newBoardModal').style.display = 'none';
  document.getElementById('newBoardName').value = '';
}
async function submitNewBoard(){
  const name = document.getElementById('newBoardName').value.trim();
  if (!name) return;
  const r = await fetch('/api/boards', {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({name})
  });
  const board = await r.json();
  window.location.href = '/board/' + board.id;
}

// ── Pickers (status/priority, person, dropdown) ─────────────────────────

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
    <div style="display:flex;gap:4px;padding:6px;border-top:1px solid #f0f1f4;margin-top:4px;">
      <input id="newDropdownOpt" placeholder="Add option" style="flex:1;border:1px solid #d0d4e4;border-radius:6px;padding:5px 8px;font-size:12px;"/>
      <button onclick="addDropdownOption(${columnId})" style="border:none;background:#1a3a6b;color:#fff;border-radius:6px;padding:0 10px;cursor:pointer;">+</button>
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

// ── Updates (per-item comment thread) ────────────────────────────────────

async function openUpdates(itemId){
  const panel = document.getElementById('updatesPanel');
  panel.dataset.itemId = itemId;
  panel.style.display = 'flex';
  panel.style.flexDirection = 'column';
  panel.innerHTML = `
    <div class="updates-hdr">
      <b>Updates</b>
      <span style="cursor:pointer;color:#9699a6;" onclick="closeUpdates()">✕</span>
    </div>
    <div class="updates-list" id="updatesList"><div style="color:#9699a6;font-size:12px;">Loading…</div></div>
    <div class="updates-input-row">
      <textarea id="newUpdateBody" placeholder="Write an update…"></textarea>
      <button class="btn-primary" onclick="postUpdate(${itemId})">Post</button>
    </div>`;
  const r = await fetch(`/api/items/${itemId}/updates`);
  const updates = await r.json();
  const list = document.getElementById('updatesList');
  list.innerHTML = updates.length ? '' : '<div style="color:#9699a6;font-size:12px;">No updates yet.</div>';
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

init();
