#!/usr/bin/env python3
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse


ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("SPLITMONEY_DATA_DIR", ROOT / "data"))
DB_PATH = Path(os.environ.get("SPLITMONEY_DB", DATA_DIR / "splitmoney.sqlite3"))
PORT = int(os.environ.get("PORT", "8080"))
MAX_BODY_BYTES = 1_000_000
GROUP_ID_RE = re.compile(r"^g[a-zA-Z0-9_-]{14,48}$")
STATIC_FILES = {"app.js", "index.html", "styles.css"}
DAY_MS = 24 * 60 * 60 * 1000
DEFAULT_EXPIRY_MS = 28 * DAY_MS
EXTENSION_MS = 7 * DAY_MS
EXTENSION_WINDOW_MS = 7 * DAY_MS


def now_ms():
  return int(time.time() * 1000)


def empty_state(group_id):
  timestamp = now_ms()
  return {
    "version": 2,
    "id": group_id,
    "title": "Abend",
    "currency": "EUR",
    "participants": {},
    "expenses": {},
    "createdAt": timestamp,
    "updatedAt": timestamp,
    "expiresAt": timestamp + DEFAULT_EXPIRY_MS,
  }


def make_group_id():
  return "g" + secrets.token_urlsafe(18)


def normalize_state(raw_state, group_id):
  state = raw_state if isinstance(raw_state, dict) else {}
  fallback = empty_state(group_id)
  participants = state.get("participants") if isinstance(state.get("participants"), dict) else {}
  expenses = state.get("expenses") if isinstance(state.get("expenses"), dict) else {}
  timestamp = now_ms()
  created_at = int(state.get("createdAt") or fallback["createdAt"])
  expires_at = int(state.get("expiresAt") or created_at + DEFAULT_EXPIRY_MS)

  return {
    **fallback,
    **state,
    "id": group_id,
    "title": str(state.get("title") or fallback["title"])[:80],
    "currency": sanitize_currency(state.get("currency") or fallback["currency"]),
    "participants": participants,
    "expenses": expenses,
    "createdAt": created_at,
    "updatedAt": timestamp,
    "expiresAt": expires_at,
  }


def is_expired(state):
  return int(state.get("expiresAt") or 0) <= now_ms()


def can_extend(state):
  expires_at = int(state.get("expiresAt") or 0)
  return expires_at > now_ms() and expires_at - now_ms() <= EXTENSION_WINDOW_MS


def extend_state(state):
  extended = dict(state)
  extended["expiresAt"] = int(state.get("expiresAt") or now_ms()) + EXTENSION_MS
  return extended


def sanitize_currency(value):
  currency = str(value or "EUR").strip().upper()
  return currency if re.match(r"^[A-Z]{3}$", currency) else "EUR"


def clean_name(value):
  return re.sub(r"\s+", " ", str(value or "").strip())


def normalized_name(value):
  return clean_name(value).casefold()


def validate_state(state):
  participants = state.get("participants") if isinstance(state, dict) else {}
  if not isinstance(participants, dict):
    return None

  seen_names = set()
  for participant in participants.values():
    if not isinstance(participant, dict):
      continue
    name = normalized_name(participant.get("name"))
    if not name:
      return "Alle Personen brauchen einen Namen."
    if name in seen_names:
      return "Jeder Name darf nur einmal vorkommen."
    seen_names.add(name)

  return None


def get_connection():
  DATA_DIR.mkdir(parents=True, exist_ok=True)
  connection = sqlite3.connect(DB_PATH)
  connection.execute(
    """
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
    """
  )
  connection.commit()
  return connection


def read_group(group_id):
  with get_connection() as connection:
    row = connection.execute("SELECT state_json FROM groups WHERE id = ?", (group_id,)).fetchone()
  if not row:
    return None
  return json.loads(row[0])


def write_group(group_id, state):
  normalized = normalize_state(state, group_id)
  state_json = json.dumps(normalized, ensure_ascii=False, separators=(",", ":"))
  with get_connection() as connection:
    connection.execute(
      """
      INSERT INTO groups (id, state_json, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
      """,
      (group_id, state_json, normalized["createdAt"], normalized["updatedAt"]),
    )
    connection.commit()
  return normalized


class SplitMoneyHandler(BaseHTTPRequestHandler):
  server_version = "SplitMoney/1.0"

  def do_GET(self):
    parsed = urlparse(self.path)
    path = parsed.path.rstrip("/") or "/"

    if path == "/api/health":
      self.send_json({"ok": True})
      return

    group_match = re.match(r"^/api/groups/([^/]+)$", path)
    if group_match:
      self.handle_get_group(unquote(group_match.group(1)))
      return

    self.serve_static_or_app(path)

  def do_POST(self):
    parsed = urlparse(self.path)
    path = parsed.path.rstrip("/")
    if path == "/api/groups":
      self.handle_create_group()
      return
    extend_match = re.match(r"^/api/groups/([^/]+)/extend$", path)
    if extend_match:
      self.handle_extend_group(unquote(extend_match.group(1)))
      return
    self.send_json({"error": "Nicht gefunden."}, HTTPStatus.NOT_FOUND)

  def do_PUT(self):
    parsed = urlparse(self.path)
    group_match = re.match(r"^/api/groups/([^/]+)$", parsed.path.rstrip("/"))
    if group_match:
      self.handle_update_group(unquote(group_match.group(1)))
      return
    self.send_json({"error": "Nicht gefunden."}, HTTPStatus.NOT_FOUND)

  def handle_get_group(self, group_id):
    if not GROUP_ID_RE.match(group_id):
      self.send_json({"error": "Ungültiger Gruppenlink."}, HTTPStatus.BAD_REQUEST)
      return

    state = read_group(group_id)
    if state is None:
      self.send_json({"error": "Runde nicht gefunden."}, HTTPStatus.NOT_FOUND)
      return
    if is_expired(state):
      self.send_json({"error": "Dieser Link ist abgelaufen."}, HTTPStatus.GONE)
      return

    self.send_json({"state": state})

  def handle_create_group(self):
    payload = self.read_json_body()
    if payload is None:
      return

    group_id = make_group_id()
    proposed_state = payload.get("state") or empty_state(group_id)
    validation_error = validate_state(proposed_state)
    if validation_error:
      self.send_json({"error": validation_error}, HTTPStatus.BAD_REQUEST)
      return

    state = write_group(group_id, proposed_state)
    self.send_json({"state": state}, HTTPStatus.CREATED)

  def handle_update_group(self, group_id):
    if not GROUP_ID_RE.match(group_id):
      self.send_json({"error": "Ungültiger Gruppenlink."}, HTTPStatus.BAD_REQUEST)
      return

    current_state = read_group(group_id)
    if current_state is None:
      self.send_json({"error": "Runde nicht gefunden."}, HTTPStatus.NOT_FOUND)
      return
    if is_expired(current_state):
      self.send_json({"error": "Dieser Link ist abgelaufen."}, HTTPStatus.GONE)
      return

    payload = self.read_json_body()
    if payload is None:
      return

    proposed_state = payload.get("state") or empty_state(group_id)
    if isinstance(proposed_state, dict):
      proposed_state["expiresAt"] = current_state.get("expiresAt")
    validation_error = validate_state(proposed_state)
    if validation_error:
      self.send_json({"error": validation_error}, HTTPStatus.BAD_REQUEST)
      return

    state = write_group(group_id, proposed_state)
    self.send_json({"state": state})

  def handle_extend_group(self, group_id):
    if not GROUP_ID_RE.match(group_id):
      self.send_json({"error": "Ungültiger Gruppenlink."}, HTTPStatus.BAD_REQUEST)
      return

    current_state = read_group(group_id)
    if current_state is None:
      self.send_json({"error": "Runde nicht gefunden."}, HTTPStatus.NOT_FOUND)
      return
    if is_expired(current_state):
      self.send_json({"error": "Dieser Link ist abgelaufen."}, HTTPStatus.GONE)
      return
    if not can_extend(current_state):
      self.send_json(
        {"error": "Der Link kann erst innerhalb der letzten 7 Tage verlängert werden."},
        HTTPStatus.BAD_REQUEST,
      )
      return

    state = write_group(group_id, extend_state(current_state))
    self.send_json({"state": state})

  def read_json_body(self):
    length = int(self.headers.get("Content-Length", "0") or "0")
    if length > MAX_BODY_BYTES:
      self.send_json({"error": "Anfrage ist zu groß."}, HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
      return None

    raw_body = self.rfile.read(length) if length else b"{}"
    try:
      payload = json.loads(raw_body.decode("utf-8"))
    except json.JSONDecodeError:
      self.send_json({"error": "Ungültiges JSON."}, HTTPStatus.BAD_REQUEST)
      return None

    if not isinstance(payload, dict):
      self.send_json({"error": "Ungültige Anfrage."}, HTTPStatus.BAD_REQUEST)
      return None

    return payload

  def serve_static_or_app(self, path):
    if path == "/" or re.match(r"^/g/[^/]+$", path):
      self.send_file(ROOT / "index.html")
      return

    requested = (ROOT / path.lstrip("/")).resolve()
    if requested.parent != ROOT or requested.name not in STATIC_FILES:
      self.send_json({"error": "Nicht gefunden."}, HTTPStatus.NOT_FOUND)
      return

    if requested.is_file():
      self.send_file(requested)
      return

    self.send_json({"error": "Nicht gefunden."}, HTTPStatus.NOT_FOUND)

  def send_file(self, path):
    content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    body = path.read_bytes()
    self.send_response(HTTPStatus.OK)
    self.send_header("Content-Type", content_type)
    self.send_header("Content-Length", str(len(body)))
    self.send_header("Cache-Control", "no-cache")
    self.end_headers()
    self.wfile.write(body)

  def send_json(self, payload, status=HTTPStatus.OK):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    self.send_response(status)
    self.send_header("Content-Type", "application/json; charset=utf-8")
    self.send_header("Content-Length", str(len(body)))
    self.send_header("Cache-Control", "no-store")
    self.end_headers()
    self.wfile.write(body)

  def log_message(self, format, *args):
    print("%s - %s" % (self.address_string(), format % args))


def main():
  DATA_DIR.mkdir(parents=True, exist_ok=True)
  server = ThreadingHTTPServer(("0.0.0.0", PORT), SplitMoneyHandler)
  print(f"SplitMoney läuft auf Port {PORT}, SQLite: {DB_PATH}", flush=True)
  server.serve_forever()


if __name__ == "__main__":
  main()
