'use strict';

/**
 * SQLite storage. One file (storage/lessondesign.db by default) holds users,
 * sessions, saved plans, admin settings, access keys, resources and rate-limit
 * counters. Swap this module out if you later move to Postgres/MySQL — every
 * other module goes through the small helpers exported here.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const dbFile = path.resolve(ROOT, process.env.DATABASE_FILE || 'storage/lessondesign.db');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
	id            INTEGER PRIMARY KEY AUTOINCREMENT,
	email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
	name          TEXT NOT NULL DEFAULT '',
	password_hash TEXT NOT NULL,
	role          TEXT NOT NULL DEFAULT 'teacher',      -- 'teacher' | 'admin'
	has_access    INTEGER NOT NULL DEFAULT 0,           -- active LessonDesign subscription / school access
	gemini_api_key TEXT NOT NULL DEFAULT '',            -- teacher's own optional Gemini key
	created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
	id         TEXT PRIMARY KEY,
	user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
	csrf_token TEXT NOT NULL,
	expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
	id         TEXT NOT NULL,
	user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	title      TEXT NOT NULL DEFAULT 'Untitled Lesson',
	state      TEXT NOT NULL,
	last_saved TEXT NOT NULL,
	PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS settings (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS access_keys (
	id          TEXT PRIMARY KEY,
	key_hash    TEXT NOT NULL UNIQUE,
	label       TEXT NOT NULL DEFAULT '',
	created_at  TEXT NOT NULL,
	created_by  INTEGER,
	redeemed_by INTEGER,
	redeemed_at TEXT NOT NULL DEFAULT '',
	revoked     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS resources (
	id          INTEGER PRIMARY KEY AUTOINCREMENT,
	kind        TEXT NOT NULL DEFAULT 'tour',          -- 'expert' | 'tour'
	title       TEXT NOT NULL,
	summary     TEXT NOT NULL DEFAULT '',
	subjects    TEXT NOT NULL DEFAULT '[]',            -- JSON arrays
	grade_bands TEXT NOT NULL DEFAULT '[]',
	tags        TEXT NOT NULL DEFAULT '[]',
	format      TEXT NOT NULL DEFAULT '',
	duration    TEXT NOT NULL DEFAULT '',
	cost        TEXT NOT NULL DEFAULT '',
	url         TEXT NOT NULL DEFAULT '',
	source_id   TEXT NOT NULL DEFAULT '',
	published   INTEGER NOT NULL DEFAULT 1,
	updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS rate_limits (
	key        TEXT PRIMARY KEY,
	count      INTEGER NOT NULL DEFAULT 0,
	expires_at INTEGER NOT NULL
);
`);

// Lightweight migrations for databases created by earlier versions.
const userColumns = db.prepare('PRAGMA table_info(users)').all().map((column) => column.name);
if (!userColumns.includes('teaching_profile')) {
	db.exec("ALTER TABLE users ADD COLUMN teaching_profile TEXT NOT NULL DEFAULT '{}'");
}

function nowIso() {
	return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/* ---- settings ---------------------------------------------------------- */

const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
const deleteSettingStmt = db.prepare('DELETE FROM settings WHERE key = ?');

function getSetting(key, fallback = '') {
	const row = getSettingStmt.get(key);
	return row ? row.value : fallback;
}

function setSetting(key, value) {
	if (value === null || value === undefined) {
		deleteSettingStmt.run(key);
		return;
	}
	setSettingStmt.run(key, String(value));
}

/* ---- rate limits (replaces WordPress transients) ----------------------- */

function getCounter(key) {
	const row = db.prepare('SELECT count, expires_at FROM rate_limits WHERE key = ?').get(key);
	if (!row) {
		return 0;
	}
	if (row.expires_at <= Date.now()) {
		db.prepare('DELETE FROM rate_limits WHERE key = ?').run(key);
		return 0;
	}
	return row.count;
}

function incrementCounter(key, ttlMs) {
	const current = getCounter(key);
	if (current === 0) {
		db.prepare('INSERT OR REPLACE INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?)').run(key, Date.now() + ttlMs);
		return 1;
	}
	db.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').run(key);
	return current + 1;
}

function resetCounter(key) {
	db.prepare('DELETE FROM rate_limits WHERE key = ?').run(key);
}

function purgeExpired() {
	const now = Date.now();
	db.prepare('DELETE FROM rate_limits WHERE expires_at <= ?').run(now);
	db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
}

module.exports = {
	db,
	dbFile,
	nowIso,
	getSetting,
	setSetting,
	getCounter,
	incrementCounter,
	resetCounter,
	purgeExpired,
	ROOT
};
