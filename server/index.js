'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const { db, purgeExpired, ROOT } = require('./db');
const auth = require('./auth');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

if (process.env.TRUST_PROXY) {
	// Set when running behind a reverse proxy / load balancer (Render, Nginx, etc.)
	app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? true : process.env.TRUST_PROXY);
}

app.set('view engine', 'ejs');
app.set('views', path.join(ROOT, 'views'));
app.disable('x-powered-by');

/* ---- security headers ------------------------------------------------- */
app.use((req, res, next) => {
	res.setHeader('X-Content-Type-Options', 'nosniff');
	res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
	res.setHeader('X-Frame-Options', 'SAMEORIGIN');
	res.setHeader('Content-Security-Policy', [
		"default-src 'self'",
		"script-src 'self'",
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob:",
		"connect-src 'self'",
		"font-src 'self' data:",
		"frame-ancestors 'self'",
		"form-action 'self'",
		"base-uri 'self'"
	].join('; '));
	next();
});

/* ---- static assets ------------------------------------------------------ */
app.use('/assets', express.static(path.join(ROOT, 'public'), { maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
// Curriculum JSON is fetched by the planner (lazy-loaded shards). URLs carry ?ver= so long caching is safe.
app.use('/data', express.static(path.join(ROOT, 'data'), { maxAge: '7d', index: false }));

app.use(express.json({ limit: '300kb' }));
app.use(express.urlencoded({ extended: false, limit: '300kb' }));
app.use(auth.sessionMiddleware);

/* ---- routes ------------------------------------------------------------- */
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use('/api', require('./routes/api'));
app.use('/admin', require('./routes/admin'));
app.use('/', require('./routes/pages'));

app.use((req, res) => {
	res.status(404).render('message', { title: 'Page not found', message: 'That page does not exist.', user: req.user, csrfToken: auth.csrfToken(req), currentPath: req.path });
});

// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
	console.error(error);
	if (req.originalUrl.startsWith('/api/')) {
		const status = error.type === 'entity.too.large' ? 413 : (error.status || 500);
		return res.status(status).json({ success: false, data: { message: status === 413 ? 'Request is too large.' : 'Something went wrong on the server.' } });
	}
	return res.status(500).render('message', { title: 'Something went wrong', message: 'The server ran into a problem. Please try again.', user: req.user, csrfToken: auth.csrfToken(req), currentPath: req.path });
});

/* ---- first admin bootstrap -------------------------------------------- */
// Demo login used when ADMIN_EMAIL / ADMIN_PASSWORD are not set. Change for any real deployment.
const DEMO_ADMIN_EMAIL = 'admin@lessondesign.test';
const DEMO_ADMIN_PASSWORD = 'LessonDesign123!';

function bootstrapAdmin() {
	const email = (process.env.ADMIN_EMAIL || DEMO_ADMIN_EMAIL).trim();
	const password = process.env.ADMIN_PASSWORD || DEMO_ADMIN_PASSWORD;
	const adminCount = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
	if (adminCount > 0) {
		return;
	}
	try {
		auth.createUser({ email, password, name: 'Administrator', role: 'admin', hasAccess: true });
		console.log('[setup] Created admin account for ' + email);
	} catch (error) {
		console.error('[setup] Could not create admin account: ' + error.message);
	}
}

if (require.main === module) {
	bootstrapAdmin();
	purgeExpired();
	setInterval(purgeExpired, 60 * 60 * 1000).unref();
	app.listen(PORT, HOST, () => {
		console.log('LessonDesign AI running at http://localhost:' + PORT);
	});
}

module.exports = { app, bootstrapAdmin };
