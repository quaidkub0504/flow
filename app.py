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

from models import (
    db, User, Board, Group, Column, Item, ColumnValue, Update, ActivityLog,
    COLUMN_TYPES, DEFAULT_STATUS_LABELS, DEFAULT_PRIORITY_LABELS, GROUP_COLOR_ROTATION,
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


with app.app_context():
    db.create_all()


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
        boards = Board.query.filter_by(archived=False).order_by(Board.created_at.desc()).all()
        return jsonify([b.to_dict() for b in boards])

    data = request.get_json(force=True)
    name = (data.get("name") or "New Board").strip()
    user = current_user()
    board = Board(name=name, icon=data.get("icon") or "📋", created_by=user.id)
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

    db.session.add(ActivityLog(board_id=board.id, user_id=user.id, action="created_board", detail=name))
    db.session.commit()
    return jsonify(board.to_dict())


@app.route("/api/boards/<int:board_id>", methods=["GET", "PATCH"])
def api_board_detail(board_id):
    if request.method == "PATCH":
        board = Board.query.get_or_404(board_id)
        data = request.get_json(force=True)
        if "name" in data and data["name"].strip():
            board.name = data["name"].strip()
        if "description" in data:
            board.description = data["description"]
        db.session.commit()
        payload = board.to_dict()
        socketio.emit("board_updated", payload, room=f"board_{board_id}")
        return jsonify(payload)
    board = Board.query.get_or_404(board_id)
    groups = [g.to_dict() for g in board.groups]
    columns = [c.to_dict() for c in board.columns]
    items = [i.to_dict() for i in Item.query.filter_by(board_id=board_id).order_by(Item.position).all()]
    return jsonify({"board": board.to_dict(), "groups": groups, "columns": columns, "items": items})


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


# ── Real-time presence/room management ──────────────────────────────────

@socketio.on("join_board")
def on_join_board(data):
    board_id = data.get("board_id")
    if board_id:
        join_room(f"board_{board_id}")


if __name__ == "__main__":
    port = int(os.getenv("PORT", 8788))
    socketio.run(app, host="0.0.0.0" if os.getenv("PORT") else "127.0.0.1", port=port, debug=False)
