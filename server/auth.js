'use strict';

/**
 * Accounts and sessions (replaces WordPress users, logins and nonces).
 *
 *  - Passwords: scrypt with a per-user salt (Node built-in crypto).
 *  - Sessions: random id in an httpOnly cookie, stored in SQLite.
 *  - CSRF: every session carries a token; state-changing requests must send it
 *    back as the X-CSRF-Token header (API) or a _csrf form field (HTML forms).
 *
 * Want SSO or your existing dHL membership system instead? Replace
 * findUserForLogin()/createUser() and keep the session helpers.
 */

const crypto = require('crypto');
const { db, nowIso } = require('./db');

const COOKIE_NAME = 'ldai_sid';
const USER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GUEST_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/* ---- passwords ---------------------------------------------------------- */

function hashPassword(password) {
	const salt = crypto.randomBytes(16);
	const hash = crypto.scryptSync(String(password), salt, 64);
	return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
}

function verifyPassword(password, stored) {
	const [scheme, saltHex, hashHex] = String(stored || '').split('$');
	if (scheme !== 'scrypt' || !saltHex || !hashHex) {
		return false;
	}
	const expected = Buffer.from(hashHex, 'hex');
	const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
	return crypto.timingSafeEqual(expected, actual);
}

/* ---- users ------------------------------------------------------------- */

function publicUser(row) {
	if (!row) {
		return null;
	}
	return {
		id: row.id,
		email: row.email,
		name: row.name,
		role: row.role,
		isAdmin: row.role === 'admin',
		hasAccess: row.role === 'admin' || !!row.has_access,
		hasGeminiKey: !!(row.gemini_api_key && row.gemini_api_key.trim()),
		createdAt: row.created_at
	};
}

function getUserRow(id) {
	return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function findUserForLogin(email, password) {
	const row = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim());
	if (!row || !verifyPassword(password, row.password_hash)) {
		return null;
	}
	return row;
}

function createUser({ email, name, password, role = 'teacher', hasAccess = false }) {
	const cleanEmail = String(email || '').trim().toLowerCase();
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
		throw new Error('Enter a valid email address.');
	}
	if (String(password || '').length < 8) {
		throw new Error('Use a password with at least 8 characters.');
	}
	if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(cleanEmail)) {
		throw new Error('An account with that email already exists.');
	}
	const result = db.prepare('INSERT INTO users (email, name, password_hash, role, has_access, created_at) VALUES (?, ?, ?, ?, ?, ?)')
		.run(cleanEmail, String(name || '').trim().slice(0, 120), hashPassword(password), role === 'admin' ? 'admin' : 'teacher', hasAccess ? 1 : 0, nowIso());
	return getUserRow(Number(result.lastInsertRowid));
}

function setPassword(userId, password) {
	if (String(password || '').length < 8) {
		throw new Error('Use a password with at least 8 characters.');
	}
	db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), userId);
}

/* ---- sessions ---------------------------------------------------------- */

function parseCookies(header) {
	const output = {};
	String(header || '').split(';').forEach((part) => {
		const index = part.indexOf('=');
		if (index > -1) {
			const key = part.slice(0, index).trim();
			try {
				output[key] = decodeURIComponent(part.slice(index + 1).trim());
			} catch (error) {
				output[key] = '';
			}
		}
	});
	return output;
}

function setSessionCookie(req, res, sessionId, ttlMs) {
	res.cookie(COOKIE_NAME, sessionId, {
		httpOnly: true,
		sameSite: 'lax',
		secure: req.secure,
		maxAge: ttlMs,
		path: '/'
	});
}

function createSession(req, res, userId) {
	const id = crypto.randomBytes(32).toString('hex');
	const csrf = crypto.randomBytes(24).toString('hex');
	const ttl = userId ? USER_SESSION_TTL_MS : GUEST_SESSION_TTL_MS;
	db.prepare('INSERT INTO sessions (id, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)').run(id, userId || null, csrf, Date.now() + ttl);
	setSessionCookie(req, res, id, ttl);
	return { id, user_id: userId || null, csrf_token: csrf };
}

function destroySession(req, res) {
	if (req.session) {
		db.prepare('DELETE FROM sessions WHERE id = ?').run(req.session.id);
	}
	res.clearCookie(COOKIE_NAME, { path: '/' });
}

/** Attaches req.session, req.user (public shape) and req.userRow. */
function sessionMiddleware(req, res, next) {
	const cookies = parseCookies(req.headers.cookie);
	const sessionId = cookies[COOKIE_NAME];
	let session = null;
	if (sessionId && /^[a-f0-9]{64}$/.test(sessionId)) {
		session = db.prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > ?').get(sessionId, Date.now());
	}
	req.session = session;
	req.userRow = session && session.user_id ? getUserRow(session.user_id) : null;
	req.user = publicUser(req.userRow);
	next();
}

/** HTML pages need a session (even for guests) so the page can carry a CSRF token. */
function ensureSession(req, res, next) {
	if (!req.session) {
		req.session = createSession(req, res, null);
	}
	next();
}

function login(req, res, userRow) {
	destroySession(req, res);
	req.session = createSession(req, res, userRow.id);
	req.userRow = userRow;
	req.user = publicUser(userRow);
}

function csrfToken(req) {
	return req.session ? req.session.csrf_token : '';
}

function verifyCsrf(req) {
	const sent = req.get('x-csrf-token') || (req.body && req.body._csrf) || '';
	const expected = csrfToken(req);
	if (!sent || !expected || sent.length !== expected.length) {
		return false;
	}
	return crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
}

function requireCsrf(req, res, next) {
	if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
		return next();
	}
	if (!verifyCsrf(req)) {
		if (req.path.startsWith('/api/') || req.originalUrl.startsWith('/api/')) {
			return res.status(403).json({ success: false, data: { message: 'Your session expired. Refresh the page and try again.' } });
		}
		return res.status(403).send('Your session expired. Go back, refresh the page, and try again.');
	}
	return next();
}

function requireAdmin(req, res, next) {
	if (!req.user) {
		return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
	}
	if (!req.user.isAdmin) {
		return res.status(403).render('message', { title: 'Admins only', message: 'You need an administrator account to open this page.' });
	}
	return next();
}

module.exports = {
	hashPassword,
	verifyPassword,
	publicUser,
	getUserRow,
	findUserForLogin,
	createUser,
	setPassword,
	sessionMiddleware,
	ensureSession,
	login,
	destroySession,
	csrfToken,
	requireCsrf,
	requireAdmin
};
