# Copyright (c) 2026 AJ Danboise Son Inc. All rights reserved.
"""
Danboise Flow — an in-house, AJ-Danboise-branded replacement for monday.com.

Real per-user accounts (not a single shared password) since collaboration
features (assigning a Person column, showing who changed what) fundamentally
need to identify individual users. Real-time board sync via Socket.IO: every
mutation (cell edit, new item, new column, new group) is broadcast to every
other browser currently viewing that board, the same way monday.com itself
updates live for everyone looking at a board at once.
"""

import os
import sys
import csv
import io
import uuid
import smtplib
import threading
from datetime import timedelta
from email.mime.text import MIMEText
from email.utils import formataddr
from werkzeug.utils import secure_filename

# Windows redirects stdout to a non-UTF-8 codepage by default, which crashes
# any print() containing an emoji (e.g. the startup warnings below) the
# moment stdout isn't a real console — piped to a file, a process manager,
# etc. Force UTF-8 so those prints (present and future) can't take the app
# down before it even starts serving.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from flask import Flask, request, jsonify, render_template, session, redirect, Response, send_from_directory
from flask_socketio import SocketIO, join_room, emit
from dotenv import load_dotenv

from sqlalchemy import inspect, text

from models import (
    db, User, Board, Group, Column, Item, ColumnValue, Update, ActivityLog, Folder, View, Automation,
    COLUMN_TYPES, DEFAULT_STATUS_LABELS, DEFAULT_PRIORITY_LABELS, GROUP_COLOR_ROTATION, VIEW_TYPES,
    AUTOMATION_ACTIONS, BOARD_TEMPLATES, JOB_TYPE_OPTIONS,
)

load_dotenv()

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = "/data" if os.path.isdir("/data") else os.path.join(APP_DIR, "data")
os.makedirs(DATA_DIR, exist_ok=True)
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

app = Flask(__name__, template_folder="templates", static_folder="static")
app.config["SQLALCHEMY_DATABASE_URI"] = os.getenv("DATABASE_URL") or f"sqlite:///{os.path.join(DATA_DIR, 'ajdwork.db')}"
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024  # 25MB per uploaded file — job photos/PDFs, not video

# A fresh value every process start (i.e. every deploy) — templates append it
# to static asset URLs (?v=...) so a browser that cached last deploy's JS/CSS
# is forced to fetch the new copy instead of silently running stale code.
ASSET_VERSION = os.getenv("RAILWAY_DEPLOYMENT_ID") or uuid.uuid4().hex[:10]
app.jinja_env.globals["ASSET_VERSION"] = ASSET_VERSION

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

# ── Outbound email (assignment / completion notifications) ──────────────
# Uses plain SMTP so it works with any provider (Gmail app password,
# Office365, SendGrid/Mailgun SMTP relay, etc.) without a new dependency.
# Absent config, sends are logged and skipped rather than erroring, so the
# app runs fine in dev — the feature just switches on the moment real SMTP
# env vars are set.
SMTP_HOST = os.getenv("SMTP_HOST")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD")
SMTP_FROM = os.getenv("SMTP_FROM") or SMTP_USER
SMTP_USE_TLS = os.getenv("SMTP_USE_TLS", "1") != "0"
APP_BASE_URL = (os.getenv("APP_BASE_URL") or "http://localhost:8788").rstrip("/")
if not (SMTP_HOST and SMTP_USER and SMTP_PASSWORD):
    print("⚠️  SMTP_HOST/SMTP_USER/SMTP_PASSWORD not set — email notifications are disabled "
          "(assignment/completion emails will be logged, not sent). Set them in the environment "
          "to turn email on.", flush=True)


def send_email(to_email, subject, body_text):
    """Blocking send — call via send_email_async from request handlers so a
    slow or unreachable SMTP server never holds up the HTTP response."""
    if not (SMTP_HOST and SMTP_USER and SMTP_PASSWORD):
        print(f"[email disabled] would send to {to_email}: {subject}", flush=True)
        return False
    try:
        msg = MIMEText(body_text)
        msg["Subject"] = subject
        msg["From"] = formataddr(("Danboise Flow", SMTP_FROM))
        msg["To"] = to_email
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=10) as server:
            if SMTP_USE_TLS:
                server.starttls()
            server.login(SMTP_USER, SMTP_PASSWORD)
            server.sendmail(SMTP_FROM, [to_email], msg.as_string())
        return True
    except Exception as e:
        print(f"[email error] failed to send to {to_email}: {e}", flush=True)
        return False


def send_email_async(to_email, subject, body_text):
    threading.Thread(target=send_email, args=(to_email, subject, body_text), daemon=True).start()

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
    existing_item_cols = {c["name"] for c in insp.get_columns("items")}
    with db.engine.begin() as conn:
        if "folder_id" not in existing_board_cols:
            conn.execute(text("ALTER TABLE boards ADD COLUMN folder_id INTEGER"))
        if "starred" not in existing_board_cols:
            conn.execute(text("ALTER TABLE boards ADD COLUMN starred BOOLEAN DEFAULT 0"))
        if "parent_id" not in existing_item_cols:
            conn.execute(text("ALTER TABLE items ADD COLUMN parent_id INTEGER"))
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
    uid = session.get("user_id")
    # Also reject a session pointing at a user that no longer exists — e.g. an
    # admin removed this person as a teammate while they were still logged in
    # elsewhere. Without this check they'd hit a 500 (current_user() -> None)
    # on their very next request instead of a clean redirect to login.
    if not uid or not User.query.get(uid):
        session.clear()
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


@app.route("/my-work")
def my_work_page():
    return render_template("my_work.html", user=current_user().to_dict())


@app.route("/team")
def team_page():
    return render_template("team.html", user=current_user().to_dict())


@app.route("/api/my_work")
def api_my_work():
    """Everything assigned to the current user (via any Person column),
    across every board — the daily-use "what do I need to do" view real
    monday.com calls My Work."""
    user = current_user()
    out = []
    for board in Board.query.filter_by(archived=False).all():
        person_cols = [c for c in board.columns if c.type == "person"]
        if not person_cols:
            continue
        status_col = next((c for c in board.columns if c.type == "status"), None)
        date_col = next((c for c in board.columns if c.type == "date"), None)
        for item in Item.query.filter_by(board_id=board.id).all():
            values = {v.column_id: v.value for v in item.values}
            assigned = any(user.id in (values.get(pc.id, {}).get("user_ids") or []) for pc in person_cols)
            if not assigned:
                continue
            status = None
            if status_col:
                label_id = values.get(status_col.id, {}).get("label_id")
                status = next((l for l in status_col.settings.get("labels", []) if l["id"] == label_id), None)
            out.append({
                "item_id": item.id, "item_name": item.name, "board_id": board.id, "board_name": board.name,
                "status": status, "due_date": values.get(date_col.id, {}).get("date") if date_col else None,
            })
    out.sort(key=lambda x: (x["due_date"] is None, x["due_date"] or ""))
    return jsonify(out)


# ── Board / item / column APIs ──────────────────────────────────────────

@app.route("/api/users", methods=["GET", "POST"])
def api_users():
    if request.method == "GET":
        return jsonify([u.to_dict() for u in User.query.all()])

    user = current_user()
    if not user.is_admin:
        return jsonify({"error": "Only admins can add teammates"}), 403
    data = request.get_json(force=True)
    name = (data.get("name") or "").strip()
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    if not name or not email or len(password) < 8:
        return jsonify({"error": "Name, email, and an 8+ character password are required"}), 400
    if User.query.filter_by(email=email).first():
        return jsonify({"error": "That email is already in use"}), 400
    color = GROUP_COLOR_ROTATION[User.query.count() % len(GROUP_COLOR_ROTATION)]
    new_user = User(name=name, email=email, is_admin=bool(data.get("is_admin")), color=color)
    new_user.set_password(password)
    db.session.add(new_user)
    db.session.commit()
    return jsonify(new_user.to_dict())


@app.route("/api/users/<int:user_id>", methods=["PATCH", "DELETE"])
def api_user_detail(user_id):
    user = current_user()
    target = User.query.get_or_404(user_id)
    is_self = target.id == user.id

    if request.method == "DELETE":
        if not user.is_admin:
            return jsonify({"error": "Only admins can remove teammates"}), 403
        if is_self:
            return jsonify({"error": "You can't remove your own account"}), 400
        db.session.delete(target)
        db.session.commit()
        return jsonify({"success": True})

    if not is_self and not user.is_admin:
        return jsonify({"error": "Not authorized"}), 403
    data = request.get_json(force=True)
    if "name" in data and data["name"].strip():
        target.name = data["name"].strip()
    if "color" in data:
        target.color = data["color"]
    if "password" in data and data["password"]:
        if len(data["password"]) < 8:
            return jsonify({"error": "Password must be at least 8 characters"}), 400
        target.set_password(data["password"])
    if "is_admin" in data and user.is_admin and not is_self:
        target.is_admin = bool(data["is_admin"])
    db.session.commit()
    return jsonify(target.to_dict())


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

    # Every new board starts pre-shaped for a job, not an empty grid —
    # matches what monday.com itself does with its own template gallery.
    tmpl_key = data.get("template") if data.get("template") in BOARD_TEMPLATES else "blank"
    tmpl = BOARD_TEMPLATES[tmpl_key]
    group = Group(board_id=board.id, name=tmpl["group"], color=GROUP_COLOR_ROTATION[0], position=0)
    db.session.add(group)

    for idx, (col_name, col_type) in enumerate(tmpl["columns"]):
        column = Column(board_id=board.id, name=col_name, type=col_type, position=idx)
        if col_type == "status":
            column.settings = {"labels": DEFAULT_STATUS_LABELS}
        elif col_type == "priority":
            column.settings = {"labels": DEFAULT_PRIORITY_LABELS}
        elif col_type == "dropdown":
            column.settings = {"options": JOB_TYPE_OPTIONS if tmpl_key == "service_call" else []}
        db.session.add(column)
    db.session.add(View(board_id=board.id, name="Main table", type="table", position=0))

    db.session.add(ActivityLog(board_id=board.id, user_id=user.id, action="created_board", detail=name))
    db.session.commit()
    return jsonify(board.to_dict())


@app.route("/api/board_templates")
def api_board_templates():
    return jsonify([{"key": k, "label": v["label"]} for k, v in BOARD_TEMPLATES.items()])


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


# ── CSV export / import ──────────────────────────────────────────────────

def _cell_text(column, value, user_names):
    t = column.type
    if t in ("status", "priority"):
        labels = {l["id"]: l["text"] for l in column.settings.get("labels", [])}
        return labels.get(value.get("label_id"), "")
    if t == "person":
        return ", ".join(user_names.get(uid, "") for uid in value.get("user_ids", []))
    if t == "dropdown":
        opts = {o["id"]: o["text"] for o in column.settings.get("options", [])}
        return ", ".join(opts.get(oid, "") for oid in value.get("option_ids", []))
    if t == "date":
        return value.get("date") or ""
    if t == "timeline":
        return f"{value.get('start','')} - {value.get('end','')}" if value.get("start") else ""
    if t == "number":
        return "" if value.get("number") is None else str(value["number"])
    if t == "progress":
        return "" if value.get("number") is None else f"{value['number']}%"
    if t == "rating":
        return "" if not value.get("stars") else str(value["stars"])
    if t == "checkbox":
        return "Yes" if value.get("checked") else "No"
    if t == "files":
        return "; ".join(f.get("url", "") for f in value.get("files", []))
    if t == "link":
        return value.get("url") or ""
    if t == "time_tracking":
        secs = int(value.get("total_seconds") or 0)
        return f"{secs // 3600}:{(secs % 3600) // 60:02d}:{secs % 60:02d}"
    return value.get("text") or ""


@app.route("/api/boards/<int:board_id>/export.csv")
def api_export_csv(board_id):
    board = Board.query.get_or_404(board_id)
    columns = board.columns
    items = Item.query.filter_by(board_id=board_id).order_by(Item.position).all()
    user_names = {u.id: u.name for u in User.query.all()}

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["Item"] + [c.name for c in columns])
    for item in items:
        values = {v.column_id: v.value for v in item.values}
        writer.writerow([item.name] + [_cell_text(c, values.get(c.id, {}), user_names) for c in columns])

    safe_name = "".join(ch if ch.isalnum() or ch in " _-" else "_" for ch in board.name).strip() or "board"
    return Response(buf.getvalue(), mimetype="text/csv",
                     headers={"Content-Disposition": f'attachment; filename="{safe_name}.csv"'})


def _coerce_csv_value(column, raw):
    t = column.type
    if t in ("status", "priority"):
        match = next((l for l in column.settings.get("labels", []) if l["text"].strip().lower() == raw.lower()), None)
        return {"label_id": match["id"]} if match else None
    if t == "dropdown":
        match = next((o for o in column.settings.get("options", []) if o["text"].strip().lower() == raw.lower()), None)
        return {"option_ids": [match["id"]]} if match else None
    if t == "checkbox":
        return {"checked": raw.strip().lower() in ("yes", "true", "1", "y")}
    if t in ("number", "progress"):
        try:
            return {"number": float(raw)}
        except ValueError:
            return None
    if t == "rating":
        try:
            return {"stars": max(0, min(5, int(float(raw))))}
        except ValueError:
            return None
    if t == "date":
        return {"date": raw.strip()}
    if t == "link":
        return {"url": raw.strip()}
    if t in ("files", "time_tracking"):
        return None  # not meaningfully coercible from a single CSV cell
    return {"text": raw}


@app.route("/api/uploads", methods=["POST"])
def api_upload_file():
    """Backs the Files column's actual upload button (job photos, invoices, etc).
    Stored under a random name on disk — the original filename is kept only in
    the ColumnValue JSON for display, so nothing here ever trusts user input
    as a filesystem path."""
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"error": "No file provided"}), 400
    original_name = secure_filename(f.filename) or "file"
    ext = os.path.splitext(original_name)[1][:16]
    stored_name = f"{uuid.uuid4().hex}{ext}"
    f.save(os.path.join(UPLOAD_DIR, stored_name))
    return jsonify({"name": original_name, "url": f"/uploads/{stored_name}"})


@app.route("/uploads/<path:stored_name>")
def serve_upload(stored_name):
    # stored_name is always one of our own uuid-based names (see api_upload_file),
    # so there's no user-controlled path component to worry about traversing.
    if "/" in stored_name or "\\" in stored_name:
        return jsonify({"error": "Not found"}), 404
    return send_from_directory(UPLOAD_DIR, stored_name)


@app.route("/api/uploads/<path:stored_name>", methods=["DELETE"])
def delete_upload(stored_name):
    # Best-effort cleanup when a file chip is removed from a Files column —
    # not deleting the row still leaves the app fully correct, just an orphan
    # file on disk, so failures here are never worth surfacing to the user.
    if "/" in stored_name or "\\" in stored_name:
        return jsonify({"error": "Not found"}), 404
    path = os.path.join(UPLOAD_DIR, stored_name)
    if os.path.isfile(path):
        os.remove(path)
    return jsonify({"success": True})


@app.route("/api/boards/<int:board_id>/import_csv", methods=["POST"])
def api_import_csv(board_id):
    board = Board.query.get_or_404(board_id)
    user = current_user()
    data = request.get_json(force=True)
    rows = list(csv.reader(io.StringIO(data.get("csv") or "")))
    if len(rows) < 2:
        return jsonify({"error": "CSV needs a header row and at least one data row"}), 400
    header, data_rows = rows[0], rows[1:]
    if len(data_rows) > 2000:
        return jsonify({"error": "That's more than 2000 rows — split it up and import in batches"}), 400

    existing_by_name = {c.name.strip().lower(): c for c in board.columns}
    new_cols = []
    col_for_header = []
    position = len(board.columns)
    for h in header[1:]:
        key = h.strip().lower()
        col = existing_by_name.get(key)
        if not col:
            col = Column(board_id=board_id, name=h.strip() or "Column", type="text", position=position)
            position += 1
            db.session.add(col)
            db.session.flush()
            existing_by_name[key] = col
            new_cols.append(col)
        col_for_header.append(col)

    group = board.groups[0] if board.groups else None
    is_new_group = group is None
    if is_new_group:
        group = Group(board_id=board_id, name="Imported", color=GROUP_COLOR_ROTATION[0], position=0)
        db.session.add(group)
        db.session.flush()

    start_pos = Item.query.filter_by(group_id=group.id).count()
    created = 0
    for row in data_rows:
        if not row or not any(cell.strip() for cell in row):
            continue
        item = Item(board_id=board_id, group_id=group.id, name=(row[0].strip() or "Untitled"),
                     position=start_pos + created, created_by=user.id)
        db.session.add(item)
        db.session.flush()
        for i, col in enumerate(col_for_header):
            raw = row[i + 1].strip() if i + 1 < len(row) else ""
            if not raw:
                continue
            value = _coerce_csv_value(col, raw)
            if value is not None:
                cv = ColumnValue(item_id=item.id, column_id=col.id)
                cv.value = value
                db.session.add(cv)
        created += 1

    db.session.add(ActivityLog(board_id=board_id, user_id=user.id, action="created_item",
                                detail=f"Imported {created} items from CSV"))
    db.session.commit()

    for c in new_cols:
        socketio.emit("column_created", c.to_dict(), room=f"board_{board_id}")
    if is_new_group:
        socketio.emit("group_created", group.to_dict(), room=f"board_{board_id}")
    return jsonify({"success": True, "created": created})


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


@app.route("/api/groups/<int:group_id>", methods=["PATCH", "DELETE"])
def api_group_detail(group_id):
    group = Group.query.get_or_404(group_id)
    board_id = group.board_id
    if request.method == "DELETE":
        db.session.delete(group)  # cascades to items -> values/updates
        db.session.commit()
        socketio.emit("group_deleted", {"id": group_id}, room=f"board_{board_id}")
        return jsonify({"success": True})
    data = request.get_json(force=True)
    if "name" in data and data["name"].strip():
        group.name = data["name"].strip()
    if "color" in data:
        group.color = data["color"]
    if "collapsed" in data:
        group.collapsed = bool(data["collapsed"])
    db.session.commit()
    payload = group.to_dict()
    socketio.emit("group_updated", payload, room=f"board_{board_id}")
    return jsonify(payload)


@app.route("/api/groups/<int:group_id>/duplicate", methods=["POST"])
def api_duplicate_group(group_id):
    group = Group.query.get_or_404(group_id)
    board_id = group.board_id
    user = current_user()
    position = len(Group.query.filter_by(board_id=board_id).all())
    new_grp = Group(board_id=board_id, name=f"{group.name} (copy)", color=group.color, position=position)
    db.session.add(new_grp)
    db.session.flush()
    new_items = []
    for it in group.items:
        new_item = Item(board_id=board_id, group_id=new_grp.id, name=it.name, position=it.position,
                         created_by=user.id)
        db.session.add(new_item)
        db.session.flush()
        for cv in it.values:
            db.session.add(ColumnValue(item_id=new_item.id, column_id=cv.column_id, value_json=cv.value_json))
        new_items.append(new_item)
    db.session.commit()
    payload = new_grp.to_dict()
    socketio.emit("group_created", payload, room=f"board_{board_id}")
    for it in new_items:
        socketio.emit("item_created", it.to_dict(), room=f"board_{board_id}")
    return jsonify(payload)


@app.route("/api/boards/<int:board_id>/reorder_groups", methods=["POST"])
def api_reorder_groups(board_id):
    data = request.get_json(force=True)
    for idx, gid in enumerate(data.get("group_ids", [])):
        Group.query.filter_by(id=gid, board_id=board_id).update({"position": idx})
    db.session.commit()
    groups = [g.to_dict() for g in Group.query.filter_by(board_id=board_id).order_by(Group.position).all()]
    socketio.emit("groups_reordered", groups, room=f"board_{board_id}")
    return jsonify({"success": True})


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
    position = Item.query.filter_by(group_id=item.group_id, parent_id=item.parent_id).count()
    dup = Item(board_id=item.board_id, group_id=item.group_id, parent_id=item.parent_id,
               name=f"{item.name} (copy)", position=position, created_by=user.id)
    db.session.add(dup)
    db.session.flush()
    for cv in item.values:
        db.session.add(ColumnValue(item_id=dup.id, column_id=cv.column_id, value_json=cv.value_json))
    db.session.add(ActivityLog(board_id=item.board_id, user_id=user.id, action="created_item", detail=dup.name))
    db.session.commit()
    payload = dup.to_dict()
    socketio.emit("item_created", payload, room=f"board_{item.board_id}")
    return jsonify(payload)


@app.route("/api/items/<int:item_id>/subitems", methods=["POST"])
def api_create_subitem(item_id):
    parent = Item.query.get_or_404(item_id)
    data = request.get_json(force=True)
    user = current_user()
    position = Item.query.filter_by(parent_id=parent.id).count()
    child = Item(board_id=parent.board_id, group_id=parent.group_id, parent_id=parent.id,
                 name=data.get("name") or "Subitem", position=position, created_by=user.id)
    db.session.add(child)
    db.session.add(ActivityLog(board_id=parent.board_id, user_id=user.id, action="created_item", detail=child.name))
    db.session.commit()
    payload = child.to_dict()
    socketio.emit("item_created", payload, room=f"board_{parent.board_id}")
    return jsonify(payload)


@app.route("/api/items/reorder", methods=["POST"])
def api_reorder_items():
    """Bulk position (and optionally group) update after a drag-and-drop
    reorder — one broadcast for the whole drop instead of one per row."""
    data = request.get_json(force=True)
    board_id = None
    changed = []
    for u in data.get("items", []):
        item = Item.query.get(u["id"])
        if not item:
            continue
        board_id = item.board_id
        if "group_id" in u:
            item.group_id = u["group_id"]
        item.position = u["position"]
        changed.append(item)
    db.session.commit()
    if board_id:
        socketio.emit("items_reordered", [i.to_dict() for i in changed], room=f"board_{board_id}")
    return jsonify({"success": True})


@app.route("/api/items/bulk_delete", methods=["POST"])
def api_bulk_delete_items():
    data = request.get_json(force=True)
    ids = data.get("ids", [])
    user = current_user()
    board_id = None
    for iid in ids:
        item = Item.query.get(iid)
        if item:
            board_id = item.board_id
            db.session.add(ActivityLog(board_id=board_id, user_id=user.id, action="deleted_item", detail=item.name))
            db.session.delete(item)
    db.session.commit()
    if board_id:
        socketio.emit("items_bulk_deleted", {"ids": ids}, room=f"board_{board_id}")
    return jsonify({"success": True})


@app.route("/api/items/bulk_duplicate", methods=["POST"])
def api_bulk_duplicate_items():
    data = request.get_json(force=True)
    ids = data.get("ids", [])
    user = current_user()
    board_id = None
    created = []
    for iid in ids:
        item = Item.query.get(iid)
        if not item:
            continue
        board_id = item.board_id
        position = Item.query.filter_by(group_id=item.group_id, parent_id=item.parent_id).count()
        dup = Item(board_id=item.board_id, group_id=item.group_id, parent_id=item.parent_id,
                   name=f"{item.name} (copy)", position=position, created_by=user.id)
        db.session.add(dup)
        db.session.flush()
        for cv in item.values:
            db.session.add(ColumnValue(item_id=dup.id, column_id=cv.column_id, value_json=cv.value_json))
        created.append(dup)
    db.session.commit()
    if board_id:
        for it in created:
            socketio.emit("item_created", it.to_dict(), room=f"board_{board_id}")
    return jsonify({"success": True})


@app.route("/api/items/bulk_set_value", methods=["POST"])
def api_bulk_set_value():
    data = request.get_json(force=True)
    ids = data.get("ids", [])
    column_id = data.get("column_id")
    value = data.get("value", {})
    user = current_user()
    column = Column.query.get_or_404(column_id)
    board_id = column.board_id
    for iid in ids:
        item = Item.query.get(iid)
        if not item or item.board_id != board_id:
            continue
        cv = ColumnValue.query.filter_by(item_id=iid, column_id=column_id).first()
        previous_value = cv.value if cv else {}
        if cv is None:
            cv = ColumnValue(item_id=iid, column_id=column_id)
            db.session.add(cv)
        cv.value = value
        cv.updated_by = user.id
        socketio.emit("value_updated",
                      {"item_id": iid, "column_id": column_id, "value": value, "updated_by": user.to_dict()},
                      room=f"board_{board_id}")
        _notify_by_email(item, column, previous_value, value, user)
    db.session.add(ActivityLog(board_id=board_id, user_id=user.id, action="changed_value",
                                detail=f"Bulk-updated {column.name} on {len(ids)} items"))
    db.session.commit()
    return jsonify({"success": True})


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
    previous_value = cv.value if cv else {}
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
    _run_automations(item, column, new_value)
    _notify_by_email(item, column, previous_value, new_value, user)
    return jsonify(payload)


def _notify_by_email(item, column, previous_value, new_value, actor):
    """Email people on the two events the business actually cares about:
    getting handed a new job, and someone finishing one. Deliberately not
    wired into CSV import (bulk-loading old jobs shouldn't spam anyone)."""
    board = Board.query.get(item.board_id)
    link = f"{APP_BASE_URL}/board/{item.board_id}"

    if column.type == "person":
        newly_assigned = set(new_value.get("user_ids") or []) - set(previous_value.get("user_ids") or [])
        for uid in newly_assigned:
            u = User.query.get(uid)
            if u and u.id != actor.id:
                send_email_async(
                    u.email, f"You were assigned: {item.name}",
                    f"{actor.name} assigned you to \"{item.name}\" on the \"{board.name}\" board.\n\n"
                    f"View it here: {link}",
                )

    if column.type in ("status", "priority"):
        labels = column.settings.get("labels", [])
        before_label = next((l for l in labels if l["id"] == previous_value.get("label_id")), None)
        after_label = next((l for l in labels if l["id"] == new_value.get("label_id")), None)
        before_done = bool(before_label) and before_label["text"].strip().lower() == "done"
        after_done = bool(after_label) and after_label["text"].strip().lower() == "done"
        if after_done and not before_done:
            for u in User.query.filter_by(is_admin=True).all():
                if u.id == actor.id:
                    continue
                send_email_async(
                    u.email, f"Completed: {item.name}",
                    f"{actor.name} marked \"{item.name}\" as Done on the \"{board.name}\" board.\n\n"
                    f"View it here: {link}",
                )


def _run_automations(item, column, value):
    """Evaluate "when status changes to X" recipes after a status/priority
    cell edit. Kept deliberately to one trigger shape (a specific label on
    a specific column) — matches monday's own simplest automation recipes."""
    if column.type not in ("status", "priority"):
        return
    label_id = value.get("label_id")
    if not label_id:
        return
    rules = Automation.query.filter_by(board_id=item.board_id, column_id=column.id,
                                        trigger_label_id=str(label_id)).all()
    if not rules:
        return
    for rule in rules:
        if rule.action_type == "move_to_group" and rule.target_group_id:
            target = Group.query.get(rule.target_group_id)
            if target and target.board_id == item.board_id and target.id != item.group_id:
                item.group_id = target.id
                item.position = Item.query.filter_by(group_id=target.id).count()
                socketio.emit("item_updated", item.to_dict(), room=f"board_{item.board_id}")
        elif rule.action_type == "notify_person" and rule.target_user_id:
            notified = User.query.get(rule.target_user_id)
            if notified:
                note = Update(item_id=item.id, user_id=None,
                               body=f"🤖 Automation notified {notified.name} — {column.name} changed.")
                db.session.add(note)
                db.session.flush()
                update_payload = note.to_dict()
                update_payload["user"] = {"id": None, "name": "Automation", "color": "#a25ddc"}
                socketio.emit("update_posted", update_payload, room=f"board_{item.board_id}")
                db.session.add(ActivityLog(board_id=item.board_id, item_id=item.id, user_id=notified.id,
                                            action="automation_notify",
                                            detail=f"notified via automation on {column.name}"))
                board = Board.query.get(item.board_id)
                send_email_async(
                    notified.email, f"Automation: {item.name}",
                    f"An automation on \"{board.name}\" notified you about \"{item.name}\" — {column.name} changed.\n\n"
                    f"View it here: {APP_BASE_URL}/board/{item.board_id}",
                )
    db.session.commit()


# ── Automations ("when status changes to X, do Y") ──────────────────────

@app.route("/api/boards/<int:board_id>/automations", methods=["GET", "POST"])
def api_automations(board_id):
    if request.method == "GET":
        return jsonify([a.to_dict() for a in Automation.query.filter_by(board_id=board_id).all()])
    data = request.get_json(force=True)
    action_type = data.get("action_type")
    if action_type not in AUTOMATION_ACTIONS:
        return jsonify({"error": f"Unknown action: {action_type}"}), 400
    automation = Automation(
        board_id=board_id, column_id=data["column_id"], trigger_label_id=str(data["trigger_label_id"]),
        action_type=action_type, target_group_id=data.get("target_group_id"),
        target_user_id=data.get("target_user_id"),
    )
    db.session.add(automation)
    db.session.commit()
    return jsonify(automation.to_dict())


@app.route("/api/automations/<int:automation_id>", methods=["DELETE"])
def api_delete_automation(automation_id):
    automation = Automation.query.get_or_404(automation_id)
    db.session.delete(automation)
    db.session.commit()
    return jsonify({"success": True})


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
