'use strict';

/**
 * Admin panel (replaces Tools > LessonDesign AI, the LessonDesign Resources
 * post type, and the WordPress Users screen).
 */

const express = require('express');
const auth = require('../auth');
const { db } = require('../db');
const settings = require('../services/settings');
const accessKeys = require('../services/accessKeys');
const resources = require('../services/resources');
const curriculum = require('../services/curriculum');
const ai = require('../services/ai');

const router = express.Router();

router.use(auth.ensureSession, auth.requireAdmin, auth.requireCsrf);

router.use((req, res, next) => {
	res.locals.user = req.user;
	res.locals.csrfToken = auth.csrfToken(req);
	res.locals.currentPath = req.path;
	res.locals.adminSection = req.path.split('/')[1] || 'settings';
	res.locals.notice = typeof req.query.notice === 'string' ? req.query.notice : '';
	res.locals.error = typeof req.query.error === 'string' ? req.query.error : '';
	next();
});

function back(res, path, notice, isError) {
	res.redirect(path + '?' + (isError ? 'error=' : 'notice=') + encodeURIComponent(notice));
}

/* ---- settings ------------------------------------------------------------ */

function settingsView(extra = {}) {
	const keys = Object.keys(settings.DEFINITIONS);
	const values = {};
	const fromEnv = {};
	for (const key of keys) {
		const definition = settings.DEFINITIONS[key];
		fromEnv[key] = settings.isFromEnv(key);
		values[key] = definition.secret ? '' : settings.get(key);
	}
	return Object.assign({
		title: 'Admin · Settings',
		values,
		fromEnv,
		hasGeminiKey: !!settings.get('gemini_api_key'),
		hasAzureKey: !!settings.get('azure_openai_api_key'),
		providerOrderOptions: settings.PROVIDER_ORDER_OPTIONS,
		guestAi: settings.getAiSettings(false),
		userAi: settings.getAiSettings(true),
		data: curriculum.getDataDiagnostics(),
		instructions: ai.getInstructionDiagnostics(),
		testResult: null
	}, extra);
}

router.get(['/', '/settings'], (req, res) => {
	res.render('admin/settings', settingsView());
});

router.post('/settings', (req, res) => {
	const body = req.body;
	const setIfNotEnv = (key, value) => {
		if (!settings.isFromEnv(key)) {
			settings.set(key, value);
		}
	};
	setIfNotEnv('ai_enabled', body.ai_enabled ? '1' : '0');
	setIfNotEnv('registration_enabled', body.registration_enabled ? '1' : '0');
	setIfNotEnv('ai_provider_order_user', settings.normalizeProviderOrder(body.ai_provider_order_user).join(','));
	setIfNotEnv('ai_daily_limit_user', String(Math.max(0, parseInt(body.ai_daily_limit_user, 10) || 0)));
	setIfNotEnv('gemini_model', String(body.gemini_model || '').trim().replace(/^models\//, ''));
	setIfNotEnv('azure_openai_endpoint', settings.normalizeAzureEndpoint(body.azure_openai_endpoint));
	setIfNotEnv('azure_openai_deployment', String(body.azure_openai_deployment || '').trim());
	setIfNotEnv('azure_openai_api_version', settings.normalizeAzureApiVersion(body.azure_openai_api_version));
	// Secret fields: blank keeps the saved value, "__clear__" or the clear checkbox removes it.
	for (const key of ['gemini_api_key', 'azure_openai_api_key']) {
		const value = String(body[key] || '').trim();
		if (body[key + '_clear'] || value === '__clear__') {
			setIfNotEnv(key, '');
		} else if (value) {
			setIfNotEnv(key, value);
		}
	}
	back(res, '/admin/settings', 'Settings saved.');
});

router.post('/test-ai', async (req, res) => {
	const aiSettings = settings.getAiSettings(true);
	let testResult;
	if (!aiSettings.configuredProviders.length) {
		testResult = { ok: false, message: 'AI Assist is not configured yet. Save provider settings, then test again.' };
	} else {
		try {
			const context = { test: true, section: 'foundation', currentLessonIdea: { title: 'Connection test', prompt: 'Draft a short lesson-planning note.' } };
			const raw = await ai.generate('foundation', 'draft_section', context, { isLoggedIn: true, forceSiteConfig: true });
			ai.validateResponse(raw, 'foundation');
			testResult = { ok: true, message: aiSettings.providerOrderLabel + ' connection test succeeded. AI Assist can reach the configured provider.' };
		} catch (error) {
			testResult = { ok: false, message: aiSettings.providerOrderLabel + ' connection test failed: ' + error.message };
		}
	}
	res.render('admin/settings', settingsView({ testResult }));
});

/* ---- access keys --------------------------------------------------------- */

router.get('/keys', (req, res) => {
	res.render('admin/keys', { title: 'Admin · Access Keys', keys: accessKeys.list(), newKey: '' });
});

router.post('/keys', (req, res) => {
	const newKey = accessKeys.generate(req.body.label, req.user.id);
	// One-time reveal: only the hash is stored.
	res.render('admin/keys', { title: 'Admin · Access Keys', keys: accessKeys.list(), newKey });
});

router.post('/keys/:id/revoke', (req, res) => {
	accessKeys.revoke(req.params.id);
	back(res, '/admin/keys', 'Access key revoked. The account that used it no longer has access.');
});

/* ---- resources ---------------------------------------------------------- */

router.get('/resources', (req, res) => {
	res.render('admin/resources', { title: 'Admin · Learning Connections', items: resources.listAll(), bundledCount: resources.getBundled().length });
});

router.get('/resources/new', (req, res) => {
	res.render('admin/resource-form', { title: 'Admin · New Resource', item: { kind: 'expert', published: true, subjects: [], gradeBands: [], tags: [] }, formError: '' });
});

router.get('/resources/:id', (req, res) => {
	const item = resources.getById(parseInt(req.params.id, 10));
	if (!item) {
		return back(res, '/admin/resources', 'Resource not found.', true);
	}
	return res.render('admin/resource-form', { title: 'Admin · Edit Resource', item, formError: '' });
});

router.post(['/resources/new', '/resources/:id'], (req, res) => {
	const dbId = req.params.id ? parseInt(req.params.id, 10) : 0;
	const input = Object.assign({}, req.body, { published: !!req.body.published });
	try {
		resources.save(dbId, input);
		return back(res, '/admin/resources', 'Resource saved.');
	} catch (error) {
		return res.status(400).render('admin/resource-form', {
			title: 'Admin · Resource',
			item: Object.assign({ dbId }, input, {
				subjects: String(input.subjects || '').split(','),
				gradeBands: String(input.gradeBands || '').split(','),
				tags: String(input.tags || '').split(',')
			}),
			formError: error.message
		});
	}
});

router.post('/resources/:id/delete', (req, res) => {
	resources.remove(parseInt(req.params.id, 10));
	back(res, '/admin/resources', 'Resource deleted.');
});

/* ---- users ---------------------------------------------------------- */

router.get('/users', (req, res) => {
	const users = db.prepare(`SELECT u.id, u.email, u.name, u.role, u.has_access, u.created_at,
		(SELECT COUNT(*) FROM plans p WHERE p.user_id = u.id) AS plan_count
		FROM users u ORDER BY u.created_at DESC`).all();
	res.render('admin/users', { title: 'Admin · Users', users });
});

router.post('/users', (req, res) => {
	try {
		auth.createUser({
			email: req.body.email,
			name: req.body.name,
			password: req.body.password,
			role: req.body.role,
			hasAccess: !!req.body.has_access
		});
		back(res, '/admin/users', 'User created.');
	} catch (error) {
		back(res, '/admin/users', error.message, true);
	}
});

router.post('/users/:id', (req, res) => {
	const userId = parseInt(req.params.id, 10);
	const target = auth.getUserRow(userId);
	if (!target) {
		return back(res, '/admin/users', 'User not found.', true);
	}
	const action = req.body.action;
	if (action === 'grant') {
		db.prepare('UPDATE users SET has_access = 1 WHERE id = ?').run(userId);
	} else if (action === 'revoke') {
		db.prepare('UPDATE users SET has_access = 0 WHERE id = ?').run(userId);
	} else if (action === 'make-admin') {
		db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(userId);
	} else if (action === 'make-teacher') {
		if (userId === req.user.id) {
			return back(res, '/admin/users', 'You cannot remove your own admin role.', true);
		}
		db.prepare("UPDATE users SET role = 'teacher' WHERE id = ?").run(userId);
	} else if (action === 'reset-password') {
		try {
			auth.setPassword(userId, req.body.password);
		} catch (error) {
			return back(res, '/admin/users', error.message, true);
		}
	} else if (action === 'delete') {
		if (userId === req.user.id) {
			return back(res, '/admin/users', 'You cannot delete your own account.', true);
		}
		db.prepare('DELETE FROM users WHERE id = ?').run(userId);
	}
	return back(res, '/admin/users', 'User updated.');
});

module.exports = router;
