# Copyright (c) 2026 AJ Danboise Son Inc. All rights reserved.
"""
AJD Work — an in-house, AJ-Danboise-branded replacement for monday.com.

Real per-user accounts (not a single shared password) since collaboration
features (assigning a Person column, showing who changed what) fundamentally
need to identify individual users. Real-time board sync via Socket.IO: every
mutation (cell edit, new item, new column, new group) is broadcast to every
other browser currently viewing that board, the same way monday.com itself
updates live for everyone looking at a board at once.
"""

import os
from datetime import timedelta

from flask import Flask, request, jsonify, render_template, session, redirect
from flask_socketio import SocketIO, join_room, emit
from dotenv import load_dotenv

from sqlalchemy import inspect, text

from models import (
    db, User, Board, Group, Column, Item, ColumnValue, Update, ActivityLog, Folder, View,
    COLUMN_TYPES, DEFAULT_STATUS_LABELS, DEFAULT_PRIORITY_LABELS, GROUP_COLOR_ROTATION, VIEW_TYPES,
)

load_dotenv()

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = "/data" if os.path.isdir("/data") else os.path.join(APP_DIR, "data")
os.makedirs(DATA_DIR, exist_ok=True)

app = Flask(__name__, template_folder="templates", static_folder="static")
app.config["SQLALCHEMY_DATABASE_URI"] = os.getenv("DATABASE_URL") or f"sqlite:///{os.path.join(DATA_DIR, 'ajdwork.db')}"
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

_secret = os.getenv("FLASK_SECRET_KEY")
if not _secret:
    _secret = os.urandom(32).hex()
    print("⚠️  FLASK_SECRET_KEY not set — using an ephemeral key, sessions won't survive a restart. "
          "Set FLASK_SECRET_KEY in the environment for production.", flush=True)
app.secret_key = _secret
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(days=30)
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_SECURE"] = bool(os.getenv("PORT"))

db.init_app(app)
socketio = SocketIO(app, cors_allowed_origins=[], async_mode="threading")


@app.after_request
def _security_headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    if os.getenv("PORT"):
        resp.headers.setdefault("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
    return resp


def _migrate_schema():
    """Idempotent, additive-only migration for columns/tables added after
    the initial release — safe to run on every startup, including against
    an existing dev/production database that predates them."""
    insp = inspect(db.engine)
    existing_board_cols = {c["name"] for c in insp.get_columns("boards")}
    with db.engine.begin() as conn:
        if "folder_id" not in existing_board_cols:
            conn.execute(text("ALTER TABLE boards ADD COLUMN folder_id INTEGER"))
        if "starred" not in existing_board_cols:
            conn.execute(text("ALTER TABLE boards ADD COLUMN starred BOOLEAN DEFAULT 0"))
    db.create_all()  # picks up brand-new tables (folders, views)

    # Backfill a default "Main table" view for any board that predates the
    # View model, so every board always has at least one view.
    boards_without_views = Board.query.filter(~Board.views.any()).all()
    for b in boards_without_views:
        db.session.add(View(board_id=b.id, name="Main table", type="table", position=0))
    if boards_without_views:
        db.session.commit()


with app.app_context():
    db.create_all()
    _migrate_schema()


# ── Auth ─────────────────────────────────────────────────────────────────

def current_user():
    uid = session.get("user_id")
    return User.query.get(uid) if uid else None


@app.before_request
def require_login():
    if request.path.startswith("/static/") or request.path in ("/login", "/logout", "/api/login", "/setup", "/api/setup"):
        return
    if not session.get("user_id"):
        if request.accept_mimetypes.accept_html and not request.path.startswith("/api/"):
            return redirect("/login")
        return jsonify({"error": "Not authenticated"}), 401


@app.route("/setup")
def setup_page():
    # Only reachable at all when there are zero users — first-run only.
    if User.query.count() > 0:
        return redirect("/login")
    return render_template("setup.html")


@app.route("/api/setup", methods=["POST"])
def api_setup():
    if User.query.count() > 0:
        return jsonify({"error": "Already set up"}), 400
    data = request.get_json(force=True)
    name = (data.get("name") or "").strip()
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    if not name or not email or len(password) < 8:
        return jsonify({"error": "Name, email, and an 8+ character password are required"}), 400
    user = User(name=name, email=email, is_admin=True, color=GROUP_COLOR_ROTATION[0])
    user.set_password(password)
    db.session.add(user)
    db.session.commit()
    session.permanent = True
    session["user_id"] = user.id
    return jsonify({"success": True})


@app.route("/login", methods=["GET"])
def login_page():
    if User.query.count() == 0:
        return redirect("/setup")
    return render_template("login.html", error=None)


@app.route("/api/login", methods=["POST"])
def api_login():
    data = request.get_json(force=True)
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    user = User.query.filter_by(email=email).first()
    if user and user.check_password(password):
        session.permanent = True
        session["user_id"] = user.id
        return jsonify({"success": True})
    return jsonify({"error": "Incorrect email or password"}), 401


@app.route("/logout")
def logout():
    session.clear()
    return redirect("/login")


# ── Pages ────────────────────────────────────────────────────────────────

@app.route("/")
def home():
    return render_template("home.html", user=current_user().to_dict())


@app.route("/board/<int:board_id>")
def board_page(board_id):
    board = Board.query.get_or_404(board_id)
    return render_template("board.html", user=current_user().to_dict(), board=board.to_dict())


# ── Board / item / column APIs ──────────────────────────────────────────

@app.route("/api/users")
def api_users():
    return jsonify([u.to_dict() for u in User.query.all()])


@app.route("/api/boards", methods=["GET", "POST"])
def api_boards():
    if request.method == "GET":
        show_archived = request.args.get("archived") == "1"
        boards = Board.query.filter_by(archived=show_archived).order_by(Board.created_at.desc()).all()
        return jsonify([b.to_dict() for b in boards])

    data = request.get_json(force=True)
    name = (data.get("name") or "New Board").strip()
    user = current_user()
    board = Board(name=name, icon=data.get("icon") or "📋", created_by=user.id,
                  folder_id=data.get("folder_id"))
    db.session.add(board)
    db.session.flush()

    # Every new board starts with one group and a sensible default column
    # set (Status/Person/Date) — matches what monday.com itself seeds a
    # brand-new board with, so it's immediately usable.
    group = Group(board_id=board.id, name="Group Title", color=GROUP_COLOR_ROTATION[0], position=0)
    db.session.add(group)

    status_col = Column(board_id=board.id, name="Status", type="status", position=0)
    status_col.settings = {"labels": DEFAULT_STATUS_LABELS}
    person_col = Column(board_id=board.id, name="Person", type="person", position=1)
    date_col = Column(board_id=board.id, name="Date", type="date", position=2)
    db.session.add_all([status_col, person_col, date_col])
    db.session.add(View(board_id=board.id, name="Main table", type="table", position=0))

    db.session.add(ActivityLog(board_id=board.id, user_id=user.id, action="created_board", detail=name))
    db.session.commit()
    return jsonify(board.to_dict())


@app.route("/api/boards/<int:board_id>", methods=["GET", "PATCH", "DELETE"])
def api_board_detail(board_id):
    board = Board.query.get_or_404(board_id)

    if request.method == "DELETE":
        db.session.delete(board)  # cascades to groups/columns/items/views
        db.session.commit()
        socketio.emit("board_deleted", {"id": board_id}, room=f"board_{board_id}")
        return jsonify({"success": True})

    if request.method == "PATCH":
        data = request.get_json(force=True)
        if "name" in data and data["name"].strip():
            board.name = data["name"].strip()
        if "description" in data:
            board.description = data["description"]
        if "icon" in data:
            board.icon = data["icon"]
        if "starred" in data:
            board.starred = bool(data["starred"])
        if "archived" in data:
            board.archived = bool(data["archived"])
        if "folder_id" in data:
            board.folder_id = data["folder_id"]
        db.session.commit()
        payload = board.to_dict()
        socketio.emit("board_updated", payload, room=f"board_{board_id}")
        return jsonify(payload)

    groups = [g.to_dict() for g in board.groups]
    columns = [c.to_dict() for c in board.columns]
    items = [i.to_dict() for i in Item.query.filter_by(board_id=board_id).order_by(Item.position).all()]
    views = [v.to_dict() for v in board.views]
    return jsonify({"board": board.to_dict(), "groups": groups, "columns": columns, "items": items, "views": views})


@app.route("/api/boards/<int:board_id>/duplicate", methods=["POST"])
def api_duplicate_board(board_id):
    src = Board.query.get_or_404(board_id)
    user = current_user()
    dup = Board(name=f"{src.name} (copy)", description=src.description, icon=src.icon,
                created_by=user.id, folder_id=src.folder_id)
    db.session.add(dup)
    db.session.flush()

    col_map = {}
    for col in src.columns:
        new_col = Column(board_id=dup.id, name=col.name, type=col.type, position=col.position,
                          width=col.width, settings_json=col.settings_json)
        db.session.add(new_col)
        db.session.flush()
        col_map[col.id] = new_col.id

    for grp in src.groups:
        new_grp = Group(board_id=dup.id, name=grp.name, color=grp.color, position=grp.position,
                         collapsed=grp.collapsed)
        db.session.add(new_grp)
        db.session.flush()
        for it in grp.items:
            new_item = Item(board_id=dup.id, group_id=new_grp.id, name=it.name, position=it.position,
                             created_by=user.id)
            db.session.add(new_item)
            db.session.flush()
            for cv in it.values:
                if cv.column_id in col_map:
                    db.session.add(ColumnValue(item_id=new_item.id, column_id=col_map[cv.column_id],
                                                value_json=cv.value_json, updated_by=user.id))

    for v in src.views:
        db.session.add(View(board_id=dup.id, name=v.name, type=v.type, position=v.position,
                             settings_json=v.settings_json))

    db.session.add(ActivityLog(board_id=dup.id, user_id=user.id, action="created_board",
                                detail=f"Duplicated from {src.name}"))
    db.session.commit()
    return jsonify(dup.to_dict())


# ── Folders (sidebar grouping for boards) ────────────────────────────────

@app.route("/api/folders", methods=["GET", "POST"])
def api_folders():
    if request.method == "GET":
        return jsonify([f.to_dict() for f in Folder.query.order_by(Folder.position).all()])
    data = request.get_json(force=True)
    name = (data.get("name") or "New Folder").strip()
    position = Folder.query.count()
    folder = Folder(name=name, position=position)
    db.session.add(folder)
    db.session.commit()
    return jsonify(folder.to_dict())


@app.route("/api/folders/<int:folder_id>", methods=["PATCH", "DELETE"])
def api_folder_detail(folder_id):
    folder = Folder.query.get_or_404(folder_id)
    if request.method == "DELETE":
        Board.query.filter_by(folder_id=folder_id).update({"folder_id": None})
        db.session.delete(folder)
        db.session.commit()
        return jsonify({"success": True})
    data = request.get_json(force=True)
    if "name" in data and data["name"].strip():
        folder.name = data["name"].strip()
    db.session.commit()
    return jsonify(folder.to_dict())


# ── Views (table / kanban / … over the same board) ───────────────────────

@app.route("/api/boards/<int:board_id>/views", methods=["POST"])
def api_create_view(board_id):
    board = Board.query.get_or_404(board_id)
    data = request.get_json(force=True)
    vtype = data.get("type") or "table"
    if vtype not in VIEW_TYPES:
        return jsonify({"error": f"Unknown view type: {vtype}"}), 400
    position = len(board.views)
    view = View(board_id=board_id, name=data.get("name") or VIEW_TYPES[vtype]["label"],
                type=vtype, position=position)
    db.session.add(view)
    db.session.commit()
    payload = view.to_dict()
    socketio.emit("view_created", payload, room=f"board_{board_id}")
    return jsonify(payload)


@app.route("/api/views/<int:view_id>", methods=["PATCH", "DELETE"])
def api_view_detail(view_id):
    view = View.query.get_or_404(view_id)
    board_id = view.board_id
    if request.method == "DELETE":
        db.session.delete(view)
        db.session.commit()
        socketio.emit("view_deleted", {"id": view_id}, room=f"board_{board_id}")
        return jsonify({"success": True})
    data = request.get_json(force=True)
    if "name" in data and data["name"].strip():
        view.name = data["name"].strip()
    if "settings" in data:
        view.settings = data["settings"]
    db.session.commit()
    payload = view.to_dict()
    socketio.emit("view_updated", payload, room=f"board_{board_id}")
    return jsonify(payload)


@app.route("/api/boards/<int:board_id>/groups", methods=["POST"])
def api_create_group(board_id):
    board = Board.query.get_or_404(board_id)
    data = request.get_json(force=True)
    position = len(board.groups)
    color = GROUP_COLOR_ROTATION[position % len(GROUP_COLOR_ROTATION)]
    group = Group(board_id=board_id, name=data.get("name") or "New Group", color=color, position=position)
    db.session.add(group)
    db.session.commit()
    payload = group.to_dict()
    socketio.emit("group_created", payload, room=f"board_{board_id}")
    return jsonify(payload)


@app.route("/api/boards/<int:board_id>/columns", methods=["POST"])
def api_create_column(board_id):
    board = Board.query.get_or_404(board_id)
    data = request.get_json(force=True)
    col_type = data.get("type") or "text"
    if col_type not in COLUMN_TYPES:
        return jsonify({"error": f"Unknown column type: {col_type}"}), 400
    position = len(board.columns)
    column = Column(board_id=board_id, name=data.get("name") or COLUMN_TYPES[col_type]["label"],
                     type=col_type, position=position)
    if col_type == "status":
        column.settings = {"labels": DEFAULT_STATUS_LABELS}
    elif col_type == "priority":
        column.settings = {"labels": DEFAULT_PRIORITY_LABELS}
    elif col_type == "dropdown":
        column.settings = {"options": []}
    db.session.add(column)
    user = current_user()
    db.session.add(ActivityLog(board_id=board_id, user_id=user.id, action="created_column", detail=column.name))
    db.session.commit()
    payload = column.to_dict()
    socketio.emit("column_created", payload, room=f"board_{board_id}")
    return jsonify(payload)


@app.route("/api/columns/<int:column_id>", methods=["PATCH"])
def api_update_column(column_id):
    """Rename a column or change its settings (e.g. append a new dropdown
    option, or a new status label) — a board-level config change, so it's
    broadcast the same way a new column/group is, not treated as a
    per-item cell edit."""
    column = Column.query.get_or_404(column_id)
    data = request.get_json(force=True)
    if "name" in data and data["name"].strip():
        column.name = data["name"].strip()
    if "settings" in data:
        column.settings = data["settings"]
    db.session.commit()
    payload = column.to_dict()
    socketio.emit("column_updated", payload, room=f"board_{column.board_id}")
    return jsonify(payload)


@app.route("/api/columns/<int:column_id>", methods=["DELETE"])
def api_delete_column(column_id):
    column = Column.query.get_or_404(column_id)
    board_id = column.board_id
    user = current_user()
    db.session.add(ActivityLog(board_id=board_id, user_id=user.id, action="deleted_column", detail=column.name))
    ColumnValue.query.filter_by(column_id=column_id).delete()  # no ORM-level cascade from Column -> ColumnValue
    db.session.delete(column)
    db.session.commit()
    socketio.emit("column_deleted", {"id": column_id}, room=f"board_{board_id}")
    return jsonify({"success": True})


@app.route("/api/columns/<int:column_id>/duplicate", methods=["POST"])
def api_duplicate_column(column_id):
    column = Column.query.get_or_404(column_id)
    board_id = column.board_id
    position = len(Column.query.filter_by(board_id=board_id).all())
    dup = Column(board_id=board_id, name=f"{column.name} (copy)", type=column.type,
                 position=position, width=column.width, settings_json=column.settings_json)
    db.session.add(dup)
    db.session.flush()
    copied_values = []
    for cv in ColumnValue.query.filter_by(column_id=column_id).all():
        new_cv = ColumnValue(item_id=cv.item_id, column_id=dup.id, value_json=cv.value_json)
        db.session.add(new_cv)
        copied_values.append((cv.item_id, cv.value))
    db.session.commit()
    payload = dup.to_dict()
    socketio.emit("column_created", payload, room=f"board_{board_id}")
    # Connected clients already hold every item in memory but only learn about
    # cell values via value_updated broadcasts — without this, a duplicated
    # column would render empty for anyone who doesn't reload the page.
    for item_id, value in copied_values:
        socketio.emit("value_updated", {"item_id": item_id, "column_id": dup.id, "value": value},
                       room=f"board_{board_id}")
    return jsonify(payload)


@app.route("/api/groups/<int:group_id>/items", methods=["POST"])
def api_create_item(group_id):
    group = Group.query.get_or_404(group_id)
    data = request.get_json(force=True)
    user = current_user()
    position = Item.query.filter_by(group_id=group_id).count()
    item = Item(board_id=group.board_id, group_id=group_id, name=data.get("name") or "New Item",
                position=position, created_by=user.id)
    db.session.add(item)
    db.session.add(ActivityLog(board_id=group.board_id, user_id=user.id, action="created_item", detail=item.name))
    db.session.commit()
    payload = item.to_dict()
    socketio.emit("item_created", payload, room=f"board_{group.board_id}")
    return jsonify(payload)


@app.route("/api/items/<int:item_id>", methods=["PATCH", "DELETE"])
def api_item(item_id):
    item = Item.query.get_or_404(item_id)
    board_id = item.board_id
    user = current_user()

    if request.method == "DELETE":
        db.session.add(ActivityLog(board_id=board_id, user_id=user.id, action="deleted_item", detail=item.name))
        db.session.delete(item)
        db.session.commit()
        socketio.emit("item_deleted", {"id": item_id}, room=f"board_{board_id}")
        return jsonify({"success": True})

    data = request.get_json(force=True)
    if "name" in data:
        item.name = data["name"]
    if "group_id" in data:
        item.group_id = data["group_id"]
    if "position" in data:
        item.position = data["position"]
    db.session.commit()
    payload = item.to_dict()
    socketio.emit("item_updated", payload, room=f"board_{board_id}")
    return jsonify(payload)


@app.route("/api/items/<int:item_id>/duplicate", methods=["POST"])
def api_duplicate_item(item_id):
    item = Item.query.get_or_404(item_id)
    user = current_user()
    position = Item.query.filter_by(group_id=item.group_id).count()
    dup = Item(board_id=item.board_id, group_id=item.group_id, name=f"{item.name} (copy)",
               position=position, created_by=user.id)
    db.session.add(dup)
    db.session.flush()
    for cv in item.values:
        db.session.add(ColumnValue(item_id=dup.id, column_id=cv.column_id, value_json=cv.value_json))
    db.session.add(ActivityLog(board_id=item.board_id, user_id=user.id, action="created_item", detail=dup.name))
    db.session.commit()
    payload = dup.to_dict()
    socketio.emit("item_created", payload, room=f"board_{item.board_id}")
    return jsonify(payload)


@app.route("/api/items/<int:item_id>/values/<int:column_id>", methods=["PUT"])
def api_set_value(item_id, column_id):
    """The single most-used endpoint — every cell edit on the board goes
    through here. Upserts the (item, column) value and broadcasts it to
    every other client currently viewing the board."""
    item = Item.query.get_or_404(item_id)
    column = Column.query.get_or_404(column_id)
    if column.board_id != item.board_id:
        return jsonify({"error": "Column does not belong to this item's board"}), 400
    user = current_user()
    data = request.get_json(force=True)
    new_value = data.get("value", {})

    cv = ColumnValue.query.filter_by(item_id=item_id, column_id=column_id).first()
    if cv is None:
        cv = ColumnValue(item_id=item_id, column_id=column_id)
        db.session.add(cv)
    cv.value = new_value
    cv.updated_by = user.id
    db.session.add(ActivityLog(board_id=item.board_id, item_id=item.id, user_id=user.id,
                                action="changed_value", detail=f"{column.name} on {item.name}"))
    db.session.commit()

    payload = {"item_id": item_id, "column_id": column_id, "value": new_value, "updated_by": user.to_dict()}
    socketio.emit("value_updated", payload, room=f"board_{item.board_id}")
    return jsonify(payload)


@app.route("/api/items/<int:item_id>/updates", methods=["GET", "POST"])
def api_item_updates(item_id):
    item = Item.query.get_or_404(item_id)
    if request.method == "GET":
        return jsonify([u.to_dict() for u in item.updates])
    data = request.get_json(force=True)
    user = current_user()
    upd = Update(item_id=item_id, user_id=user.id, body=data.get("body") or "")
    db.session.add(upd)
    db.session.commit()
    payload = upd.to_dict()
    payload["user"] = user.to_dict()
    socketio.emit("update_posted", payload, room=f"board_{item.board_id}")
    return jsonify(payload)


# ── Activity feed / notifications ────────────────────────────────────────

@app.route("/api/activity")
def api_activity():
    limit = min(int(request.args.get("limit", 30)), 100)
    rows = ActivityLog.query.order_by(ActivityLog.created_at.desc()).limit(limit).all()
    board_names = {b.id: b.name for b in Board.query.all()}
    user_names = {u.id: u.name for u in User.query.all()}
    out = []
    for r in rows:
        d = r.to_dict()
        d["board_name"] = board_names.get(r.board_id, "Unknown board")
        d["user_name"] = user_names.get(r.user_id, "Someone")
        out.append(d)
    return jsonify(out)


# ── Global search (boards + items, across the whole workspace) ──────────

@app.route("/api/search")
def api_search():
    q = (request.args.get("q") or "").strip()
    if not q:
        return jsonify({"boards": [], "items": []})
    boards = Board.query.filter(Board.archived.is_(False), Board.name.ilike(f"%{q}%")).limit(10).all()
    items = Item.query.filter(Item.name.ilike(f"%{q}%")).limit(20).all()
    board_names = {b.id: b.name for b in Board.query.all()}
    return jsonify({
        "boards": [b.to_dict() for b in boards],
        "items": [dict(i.to_dict(), board_name=board_names.get(i.board_id, "")) for i in items],
    })


# ── Real-time presence/room management ──────────────────────────────────

@socketio.on("join_board")
def on_join_board(data):
    board_id = data.get("board_id")
    if board_id:
        join_room(f"board_{board_id}")


if __name__ == "__main__":
    port = int(os.getenv("PORT", 8788))
    socketio.run(app, host="0.0.0.0" if os.getenv("PORT") else "127.0.0.1", port=port, debug=False)
