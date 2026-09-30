import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS inquiries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,              -- facebook | instagram | www | email | telefon | inne
  sender_id     TEXT,                       -- ID nadawcy w źródle (np. PSID z Messengera)
  sender_name   TEXT,
  contact       TEXT,                       -- telefon / e-mail, jeśli podany
  message       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'nowe', -- nowe | odpowiedziane | do_mnie | zamkniete
  ai_category   TEXT,                       -- pytanie | zamowienie | reklamacja | inne
  ai_decision   TEXT,                       -- odpowiedz | do_wlasciciela
  ai_reason     TEXT,
  ai_reply      TEXT,                       -- propozycja odpowiedzi od AI
  final_reply   TEXT,                       -- faktycznie wysłana odpowiedź
  replied_at    TEXT,
  order_id      INTEGER,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_name     TEXT,
  phone             TEXT,
  product           TEXT,
  details           TEXT,
  due_at            TEXT,                   -- termin odbioru / dostawy (ISO)
  fulfillment       TEXT NOT NULL DEFAULT 'odbior', -- odbior | dostawa
  address           TEXT,
  status            TEXT NOT NULL DEFAULT 'nowe',
  callback_reason   TEXT,                   -- co trzeba doprecyzować
  notes             TEXT,
  source            TEXT,
  inquiry_id        INTEGER,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  approved_at       TEXT,
  ready_at          TEXT,
  delivery_eta      TEXT,
  delivered_at      TEXT,
  picked_up_at      TEXT,
  reminder_sent_at  TEXT
);

CREATE TABLE IF NOT EXISTS sms_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     INTEGER,
  kind         TEXT,                        -- gotowe | termin_dostawy | dostarczone | gotowe_odbior | przypomnienie | wlasciciel
  phone        TEXT,
  body         TEXT,
  status       TEXT,                        -- wyslany | blad | symulacja
  provider_id  TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_inquiries_status ON inquiries(status);
`;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

// Wygodne pomocniki: wszystkie daty trzymamy jako ISO (UTC).
export const nowIso = (d = new Date()) => d.toISOString();

export function insert(db, table, row) {
  const keys = Object.keys(row).filter((k) => row[k] !== undefined);
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  const res = db.prepare(sql).run(...keys.map((k) => row[k]));
  return Number(res.lastInsertRowid);
}

export function update(db, table, id, fields) {
  const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
  if (!keys.length) return;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...keys.map((k) => fields[k]), id);
}

export const getById = (db, table, id) => db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
