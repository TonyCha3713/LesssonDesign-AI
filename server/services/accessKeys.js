'use strict';

/**
 * School / subscription access keys (port of the WordPress access-key flow).
 * Keys look like LDAI-XXXX-XXXX-XXXX-XXXX-XXXX. Only a SHA-256 hash is stored,
 * so the plaintext is shown to the admin exactly once.
 */

const crypto = require('crypto');
const { db, nowIso, getCounter, incrementCounter, resetCounter } = require('../db');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const REDEEM_RATE_LIMIT = 10;
const REDEEM_WINDOW_MS = 10 * 60 * 1000;

function normalize(value) {
	return String(value || '').replace(/\s+/g, '').trim().toUpperCase();
}

function hash(plaintext) {
	return crypto.createHash('sha256').update(normalize(plaintext)).digest('hex');
}

function generatePlaintext() {
	const groups = [];
	for (let group = 0; group < 5; group += 1) {
		let chunk = '';
		for (let index = 0; index < 4; index += 1) {
			chunk += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
		}
		groups.push(chunk);
	}
	return 'LDAI-' + groups.join('-');
}

function generate(label, createdBy) {
	const plaintext = generatePlaintext();
	db.prepare('INSERT INTO access_keys (id, key_hash, label, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
		.run(crypto.randomUUID(), hash(plaintext), String(label || '').trim().slice(0, 100), nowIso(), createdBy || null);
	return plaintext;
}

function list() {
	return db.prepare(`SELECT k.*, u.email AS redeemed_email FROM access_keys k
		LEFT JOIN users u ON u.id = k.redeemed_by ORDER BY k.created_at DESC`).all();
}

function revoke(id) {
	const key = db.prepare('SELECT * FROM access_keys WHERE id = ?').get(id);
	if (!key) {
		return;
	}
	db.prepare('UPDATE access_keys SET revoked = 1 WHERE id = ?').run(id);
	// Revoking a key immediately cuts off the account it was redeemed by.
	if (key.redeemed_by) {
		db.prepare("UPDATE users SET has_access = 0 WHERE id = ? AND role <> 'admin'").run(key.redeemed_by);
	}
}

/** Returns { ok, status, message }. */
function redeem(userId, submitted) {
	const value = normalize(submitted);
	if (!value) {
		return { ok: false, status: 400, message: 'Enter an access key.' };
	}
	const throttleKey = 'key_redeem:' + userId;
	if (getCounter(throttleKey) >= REDEEM_RATE_LIMIT) {
		return { ok: false, status: 429, message: 'Too many attempts. Please try again in a few minutes.' };
	}
	incrementCounter(throttleKey, REDEEM_WINDOW_MS);

	const key = db.prepare('SELECT * FROM access_keys WHERE key_hash = ?').get(hash(value));
	if (!key) {
		return { ok: false, status: 404, message: 'That access key was not recognized.' };
	}
	if (key.revoked) {
		return { ok: false, status: 403, message: 'That access key has been revoked.' };
	}
	if (key.redeemed_by && key.redeemed_by !== userId) {
		return { ok: false, status: 409, message: 'That access key is already in use on another account.' };
	}
	db.prepare('UPDATE access_keys SET redeemed_by = ?, redeemed_at = ? WHERE id = ?').run(userId, nowIso(), key.id);
	db.prepare('UPDATE users SET has_access = 1 WHERE id = ?').run(userId);
	resetCounter(throttleKey);
	return { ok: true, status: 200, message: 'Access key accepted. Your account now has full LessonDesign access.' };
}

module.exports = { generate, list, revoke, redeem, normalize };
