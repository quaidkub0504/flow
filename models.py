# Copyright (c) 2026 AJ Danboise Son Inc. All rights reserved.
"""
Danboise Flow — data model.

Mirrors monday.com's real structure deliberately, since the goal is a
faithful in-house replacement, not a loose inspiration:

  Board -> Group (a colored section within a board, e.g. "This Week")
        -> Column (a board-level field definition: type + settings)
        -> Item (a row) -> ColumnValue (one cell: this item x this column)
                         -> Update (a comment/activity post on that item,
                                    matches monday's per-item "Updates" tab)

ColumnValue.value is a JSON blob whose shape depends on the column's type
(see COLUMN_TYPES) rather than a fixed schema per type — this is exactly
how monday.com itself stores cell data, and it's what makes adding a new
column to a board an instant, no-migration operation instead of a schema
change.
"""

import json
from datetime import datetime, timezone

from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash

db = SQLAlchemy()


def _now():
    return datetime.now(timezone.utc)


# Column types supported so far — each has a defined shape for both
# `column.settings` (board-level config) and `column_value.value` (the
# per-item cell data). Extending this dict is how a new column type gets
# added; the frontend's cell renderer switches on `type` the same way.
COLUMN_TYPES = {
    "text":     {"label": "Text"},
    "long_text": {"label": "Long Text"},
    "status":   {"label": "Status"},       # settings.labels = [{"id","text","color"}], value = {"label_id": ...}
    "person":   {"label": "Person"},       # value = {"user_ids": [...]}
    "date":     {"label": "Date"},         # value = {"date": "YYYY-MM-DD", "time": "HH:MM" or null}
    "timeline": {"label": "Timeline"},     # value = {"start": "YYYY-MM-DD", "end": "YYYY-MM-DD"}
    "number":   {"label": "Number"},
    "dropdown": {"label": "Dropdown"},     # settings.options = [{"id","text"}], value = {"option_ids": [...]}
    "checkbox": {"label": "Checkbox"},     # value = {"checked": bool}
    "link":     {"label": "Link"},         # value = {"url": "...", "text": "..."}
    "priority": {"label": "Priority"},     # same shape as status, distinct color palette convention
    "progress": {"label": "Progress"},     # value = {"number": 0-100}, rendered as a filled bar
    "files":    {"label": "Files"},        # value = {"files": [{"id","name","url"}]}
    "rating":   {"label": "Rating"},       # value = {"stars": 0-5}
    "time_tracking": {"label": "Time Tracking"},  # value = {"running": bool, "started_at": iso|None, "total_seconds": int}
}

# Starter column/group sets offered in the "New Board" modal — the same
# seed logic monday.com itself uses (a brand-new board isn't just an empty
# grid, it's pre-shaped for a job).
BOARD_TEMPLATES = {
    "blank": {
        "label": "Blank board",
        "group": "Group Title",
        "columns": [("Status", "status"), ("Person", "person"), ("Date", "date")],
    },
    "service_call": {
        "label": "Service Call Tracker",
        "group": "Scheduled Jobs",
        "columns": [("Status", "status"), ("Priority", "priority"), ("Technician", "person"),
                    ("Scheduled Date", "date"), ("Address", "text"),
                    ("Job Type", "dropdown"), ("Estimated Cost", "number")],
    },
    "crm": {
        "label": "CRM / Leads",
        "group": "Leads",
        "columns": [("Status", "status"), ("Owner", "person"), ("Priority", "priority"),
                    ("Follow-up Date", "date"), ("Company", "text"), ("Website", "link")],
    },
    "tasks": {
        "label": "Task List",
        "group": "To Do",
        "columns": [("Status", "status"), ("Assignee", "person"), ("Due Date", "date"), ("Priority", "priority")],
    },
}
JOB_TYPE_OPTIONS = [
    {"id": "1", "text": "Plumbing"}, {"id": "2", "text": "Heating"},
    {"id": "3", "text": "Cooling"}, {"id": "4", "text": "Electrical"},
]

# Board view types — a board can have several views over the same items,
# the same way monday.com lets you look at one board as a table, a
# kanban board, etc.
VIEW_TYPES = {
    "table":     {"label": "Table"},
    "kanban":    {"label": "Kanban"},
    "calendar":  {"label": "Calendar"},
    "dashboard": {"label": "Dashboard"},
}

# Default status/priority label palettes — every new "status"/"priority"
# column starts with these, matching monday.com's own defaults closely
# enough to feel immediately familiar.
DEFAULT_STATUS_LABELS = [
    {"id": "1", "text": "Not Started", "color": "#c4c4c4"},
    {"id": "2", "text": "Working on it", "color": "#fdab3d"},
    {"id": "3", "text": "Stuck", "color": "#e2445c"},
    {"id": "4", "text": "Done", "color": "#00c875"},
]
DEFAULT_PRIORITY_LABELS = [
    {"id": "1", "text": "Critical", "color": "#333333"},
    {"id": "2", "text": "High", "color": "#e2445c"},
    {"id": "3", "text": "Medium", "color": "#fdab3d"},
    {"id": "4", "text": "Low", "color": "#579bfc"},
]

# A fixed hue rotation for new boards/groups — same rationale as the
# dataviz skill's categorical palette: assigned in order, never re-picked
# per click, so the same board always looks the same color to everyone.
GROUP_COLOR_ROTATION = ["#579bfc", "#00c875", "#fdab3d", "#e2445c", "#a25ddc", "#66ccff", "#ff642e", "#037f4c"]


class User(db.Model):
    __tablename__ = "users"
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), nullable=False)
    email = db.Column(db.String(200), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    color = db.Column(db.String(20), nullable=False, default="#579bfc")  # avatar color
    is_admin = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime(timezone=True), default=_now)

    def set_password(self, raw):
        self.password_hash = generate_password_hash(raw)

    def check_password(self, raw):
        return check_password_hash(self.password_hash, raw)

    def to_dict(self):
        return {"id": self.id, "name": self.name, "email": self.email, "color": self.color, "is_admin": self.is_admin}


class Folder(db.Model):
    """A sidebar grouping for boards — matches monday.com's workspace
    folders (e.g. the reference screenshot's "Content" > "AJ" tree)."""
    __tablename__ = "folders"
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(200), nullable=False)
    position = db.Column(db.Integer, nullable=False, default=0)
    created_at = db.Column(db.DateTime(timezone=True), default=_now)

    def to_dict(self):
        return {"id": self.id, "name": self.name, "position": self.position}


class Board(db.Model):
    __tablename__ = "boards"
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(200), nullable=False)
    description = db.Column(db.String(500), default="")
    icon = db.Column(db.String(10), default="📋")
    created_by = db.Column(db.Integer, db.ForeignKey("users.id"))
    created_at = db.Column(db.DateTime(timezone=True), default=_now)
    archived = db.Column(db.Boolean, default=False)
    starred = db.Column(db.Boolean, default=False)
    folder_id = db.Column(db.Integer, db.ForeignKey("folders.id"), nullable=True)

    groups = db.relationship("Group", backref="board", order_by="Group.position", cascade="all, delete-orphan")
    columns = db.relationship("Column", backref="board", order_by="Column.position", cascade="all, delete-orphan")
    items = db.relationship("Item", backref="board", cascade="all, delete-orphan")
    views = db.relationship("View", backref="board", order_by="View.position", cascade="all, delete-orphan")
    automations = db.relationship("Automation", backref="board", cascade="all, delete-orphan")

    def to_dict(self):
        return {
            "id": self.id, "name": self.name, "description": self.description,
            "icon": self.icon, "created_at": self.created_at.isoformat() if self.created_at else None,
            "archived": self.archived, "starred": self.starred, "folder_id": self.folder_id,
        }


class View(db.Model):
    """One way of looking at a board's items — table, kanban, etc. Every
    board always has at least one (seeded "Main table" on creation)."""
    __tablename__ = "views"
    id = db.Column(db.Integer, primary_key=True)
    board_id = db.Column(db.Integer, db.ForeignKey("boards.id"), nullable=False)
    name = db.Column(db.String(200), nullable=False)
    type = db.Column(db.String(20), nullable=False, default="table")
    position = db.Column(db.Integer, nullable=False, default=0)
    settings_json = db.Column(db.Text, default="{}")

    @property
    def settings(self):
        try:
            return json.loads(self.settings_json or "{}")
        except Exception:
            return {}

    @settings.setter
    def settings(self, value):
        self.settings_json = json.dumps(value)

    def to_dict(self):
        return {"id": self.id, "board_id": self.board_id, "name": self.name, "type": self.type,
                "position": self.position, "settings": self.settings}


class Group(db.Model):
    """A colored section within a board (monday calls these "groups" —
    e.g. "This Week" / "Next Week" / "Done")."""
    __tablename__ = "groups"
    id = db.Column(db.Integer, primary_key=True)
    board_id = db.Column(db.Integer, db.ForeignKey("boards.id"), nullable=False)
    name = db.Column(db.String(200), nullable=False)
    color = db.Column(db.String(20), nullable=False)
    position = db.Column(db.Integer, nullable=False, default=0)
    collapsed = db.Column(db.Boolean, default=False)

    items = db.relationship("Item", backref="group", order_by="Item.position", cascade="all, delete-orphan")

    def to_dict(self):
        return {"id": self.id, "board_id": self.board_id, "name": self.name,
                "color": self.color, "position": self.position, "collapsed": self.collapsed}


class Column(db.Model):
    __tablename__ = "columns"
    id = db.Column(db.Integer, primary_key=True)
    board_id = db.Column(db.Integer, db.ForeignKey("boards.id"), nullable=False)
    name = db.Column(db.String(200), nullable=False)
    type = db.Column(db.String(30), nullable=False)
    position = db.Column(db.Integer, nullable=False, default=0)
    width = db.Column(db.Integer, default=150)
    settings_json = db.Column(db.Text, default="{}")  # e.g. status labels, dropdown options

    @property
    def settings(self):
        try:
            return json.loads(self.settings_json or "{}")
        except Exception:
            return {}

    @settings.setter
    def settings(self, value):
        self.settings_json = json.dumps(value)

    def to_dict(self):
        return {"id": self.id, "board_id": self.board_id, "name": self.name, "type": self.type,
                "position": self.position, "width": self.width, "settings": self.settings}


class Item(db.Model):
    """A single row on a board — or a subitem, when parent_id is set (a
    subitem is just an Item whose parent is another Item, matching
    monday.com's own simplified subitem model)."""
    __tablename__ = "items"
    id = db.Column(db.Integer, primary_key=True)
    board_id = db.Column(db.Integer, db.ForeignKey("boards.id"), nullable=False)
    group_id = db.Column(db.Integer, db.ForeignKey("groups.id"), nullable=False)
    parent_id = db.Column(db.Integer, db.ForeignKey("items.id"), nullable=True)
    name = db.Column(db.String(500), nullable=False)
    position = db.Column(db.Integer, nullable=False, default=0)
    created_by = db.Column(db.Integer, db.ForeignKey("users.id"))
    created_at = db.Column(db.DateTime(timezone=True), default=_now)

    values = db.relationship("ColumnValue", backref="item", cascade="all, delete-orphan")
    updates = db.relationship("Update", backref="item", order_by="Update.created_at", cascade="all, delete-orphan")
    children = db.relationship("Item", backref=db.backref("parent", remote_side=[id]),
                                cascade="all, delete-orphan")

    def to_dict(self):
        return {
            "id": self.id, "board_id": self.board_id, "group_id": self.group_id, "parent_id": self.parent_id,
            "name": self.name, "position": self.position,
            "values": {v.column_id: v.value for v in self.values},
        }


class ColumnValue(db.Model):
    """One cell: this item x this column. `value` shape depends on the
    column's type — see COLUMN_TYPES."""
    __tablename__ = "column_values"
    id = db.Column(db.Integer, primary_key=True)
    item_id = db.Column(db.Integer, db.ForeignKey("items.id"), nullable=False)
    column_id = db.Column(db.Integer, db.ForeignKey("columns.id"), nullable=False)
    value_json = db.Column(db.Text, default="{}")
    updated_by = db.Column(db.Integer, db.ForeignKey("users.id"))
    updated_at = db.Column(db.DateTime(timezone=True), default=_now, onupdate=_now)

    __table_args__ = (db.UniqueConstraint("item_id", "column_id", name="uq_item_column"),)

    @property
    def value(self):
        try:
            return json.loads(self.value_json or "{}")
        except Exception:
            return {}

    @value.setter
    def value(self, v):
        self.value_json = json.dumps(v)


class Update(db.Model):
    """A comment/post on an item — matches monday's per-item "Updates" tab."""
    __tablename__ = "updates"
    id = db.Column(db.Integer, primary_key=True)
    item_id = db.Column(db.Integer, db.ForeignKey("items.id"), nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"))
    body = db.Column(db.Text, nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), default=_now)

    def to_dict(self):
        return {"id": self.id, "item_id": self.item_id, "user_id": self.user_id,
                "body": self.body, "created_at": self.created_at.isoformat() if self.created_at else None}


class ActivityLog(db.Model):
    """Board-level audit trail — who changed what, when. Matches monday's
    board Activity Log."""
    __tablename__ = "activity_log"
    id = db.Column(db.Integer, primary_key=True)
    board_id = db.Column(db.Integer, db.ForeignKey("boards.id"), nullable=False)
    item_id = db.Column(db.Integer, db.ForeignKey("items.id"), nullable=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"))
    action = db.Column(db.String(50), nullable=False)  # e.g. "created_item", "changed_value", "created_column"
    detail = db.Column(db.Text, default="")
    created_at = db.Column(db.DateTime(timezone=True), default=_now)

    def to_dict(self):
        return {"id": self.id, "board_id": self.board_id, "item_id": self.item_id, "user_id": self.user_id,
                "action": self.action, "detail": self.detail,
                "created_at": self.created_at.isoformat() if self.created_at else None}


AUTOMATION_ACTIONS = {
    "move_to_group": {"label": "Move item to group"},
    "notify_person": {"label": "Notify a person"},
}


class Automation(db.Model):
    """A simple "when status changes to X, do Y" recipe — matches monday's
    Automate feature (deliberately scoped to one trigger shape: a status/
    priority-type column landing on a specific label)."""
    __tablename__ = "automations"
    id = db.Column(db.Integer, primary_key=True)
    board_id = db.Column(db.Integer, db.ForeignKey("boards.id"), nullable=False)
    column_id = db.Column(db.Integer, db.ForeignKey("columns.id"), nullable=False)
    trigger_label_id = db.Column(db.String(20), nullable=False)
    action_type = db.Column(db.String(30), nullable=False)  # see AUTOMATION_ACTIONS
    target_group_id = db.Column(db.Integer, db.ForeignKey("groups.id"), nullable=True)
    target_user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True)
    created_at = db.Column(db.DateTime(timezone=True), default=_now)

    def to_dict(self):
        return {"id": self.id, "board_id": self.board_id, "column_id": self.column_id,
                "trigger_label_id": self.trigger_label_id, "action_type": self.action_type,
                "target_group_id": self.target_group_id, "target_user_id": self.target_user_id}
