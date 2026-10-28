'use strict';

/**
 * JSON API used by public/js/lesson-design-ai.js.
 * Every response is { success: boolean, data: ... } (same shape as the old
 * WordPress admin-ajax handlers, so the front-end error handling is unchanged).
 */

const crypto = require('crypto');
const express = require('express');
const { db, getCounter, incrementCounter } = require('../db');
const { requireCsrf } = require('../auth');
const settings = require('../services/settings');
const resources = require('../services/resources');
const plans = require('../services/plans');
const ai = require('../services/ai');
const accessKeys = require('../services/accessKeys');
const profileService = require('../services/profile');
const { sanitizeKey, sanitizeText, isPlainObject } = require('../util');

const router = express.Router();
const DAY_MS = 24 * 60 * 60 * 1000;

function ok(res, data) {
	res.json({ success: true, data: data === undefined ? null : data });
}

function fail(res, status, message) {
	res.status(status).json({ success: false, data: { message } });
}

function requireLogin(req, res, next) {
	if (!req.user) {
		return fail(res, 401, 'Log in to continue.');
	}
	return next();
}

function requireAccountAccess(req, res, next) {
	if (!req.user) {
		return fail(res, 401, 'Log in to save plans to your account.');
	}
	if (!req.user.hasAccess) {
		return fail(res, 403, 'Your account needs an active LessonDesign subscription before saving or managing lesson plans.');
	}
	return next();
}

router.use(requireCsrf);

/* ---- Learning Connections --------------------------------------------- */

router.get('/resources', (req, res) => {
	res.json(resources.getFilteredPayload(req.query));
});

/* ---- AI Assist ---------------------------------------------------------- */

function rateLimitKey(req) {
	if (req.user) {
		return 'ai:user:' + req.user.id;
	}
	return 'ai:guest:' + crypto.createHash('md5').update(String(req.ip || 'unknown')).digest('hex');
}

router.post('/ai-assist', async (req, res) => {
	const aiSettings = settings.getAiSettings(!!req.user);
	const userKey = req.userRow ? String(req.userRow.gemini_api_key || '').trim() : '';

	if (!req.user) {
		return fail(res, 401, 'Log in to use AI Assist.');
	}
	if (!aiSettings.enabled) {
		return fail(res, 403, 'AI Assist is disabled on this site.');
	}
	if (!aiSettings.available && !userKey) {
		return fail(res, 503, 'AI Assist is not configured on this site yet. Sign in and add your own Gemini API key on the Welcome step to use it with your own account.');
	}
	if (req.user && !req.user.hasAccess) {
		return fail(res, 403, 'Your account needs an active LessonDesign subscription before using AI Assist.');
	}

	const section = sanitizeKey(req.body.section);
	const action = sanitizeKey(req.body.assist_action);
	const state = req.body.state;

	if (!ai.SECTIONS.includes(section)) {
		return fail(res, 400, 'AI Assist is available on Foundation, Learning Targets & Assessment, and Design.');
	}
	if (!ai.ACTIONS.includes(action)) {
		return fail(res, 400, 'Unknown AI assist action.');
	}
	if (!isPlainObject(state)) {
		return fail(res, 400, 'Planner state is required for AI assistance.');
	}
	if (Buffer.byteLength(JSON.stringify(state)) > ai.AI_STATE_MAX_BYTES) {
		return fail(res, 413, 'Planner state is too large for AI assistance.');
	}

	// A teacher using their own Gemini key draws on their own quota, so the
	// site's shared daily cap does not apply to them.
	let limitKey = '';
	if (!userKey) {
		const limit = aiSettings.userDailyLimit;
		if (limit < 1) {
			return fail(res, 403, 'AI Assist is currently unavailable. An administrator can raise the daily limit in Admin > Settings.');
		}
		limitKey = rateLimitKey(req);
		if (getCounter(limitKey) >= limit) {
			return fail(res, 429, 'AI Assist has reached its daily request limit. Please try again later.');
		}
	}

	try {
		const teacherRequest = typeof req.body.instructions === 'string' ? req.body.instructions : '';
		const context = ai.buildContext(section, action, state, profileService.getProfile(req.userRow), teacherRequest);
		if (limitKey) {
			incrementCounter(limitKey, DAY_MS);
		}
		const raw = await ai.generate(section, action, context, { userGeminiKey: userKey, isLoggedIn: !!req.user });
		return ok(res, ai.validateResponse(raw, section));
	} catch (error) {
		if (error instanceof ai.AiError) {
			return fail(res, error.status, error.message);
		}
		console.error('[ai-assist]', error);
		return fail(res, 500, 'AI Assist ran into a problem. Please try again in a moment.');
	}
});

router.post('/user/gemini-key', requireLogin, (req, res) => {
	const raw = typeof req.body.gemini_api_key === 'string' ? req.body.gemini_api_key.trim() : '';
	const key = raw === '__clear__' ? '' : sanitizeText(raw).slice(0, 200);
	db.prepare('UPDATE users SET gemini_api_key = ? WHERE id = ?').run(key, req.user.id);
	if (!key) {
		return ok(res, { hasKey: false, message: "Personal Gemini key removed. AI Assist will use this site's shared key, if one is configured." });
	}
	return ok(res, { hasKey: true, message: "Personal Gemini key saved. Your AI Assist requests now use your own key and are not limited by this site's daily cap." });
});

/* ---- Access keys ------------------------------------------------------ */

router.post('/access-key/redeem', (req, res) => {
	if (!req.user) {
		return fail(res, 401, 'Log in to redeem an access key.');
	}
	const result = accessKeys.redeem(req.user.id, req.body.access_key);
	if (!result.ok) {
		return fail(res, result.status, result.message);
	}
	return ok(res, { message: result.message });
});

/* ---- Saved plans -------------------------------------------------------- */

router.get('/plans', requireAccountAccess, (req, res) => {
	ok(res, plans.listPlans(req.user.id));
});

router.get('/plans/:id', requireAccountAccess, (req, res) => {
	const planId = plans.sanitizePlanId(req.params.id);
	const plan = planId ? plans.getPlan(req.user.id, planId) : null;
	if (!plan) {
		return fail(res, 404, 'Plan not found.');
	}
	return ok(res, plan);
});

router.put('/plans/:id', requireAccountAccess, (req, res) => {
	const planId = plans.sanitizePlanId(req.params.id);
	if (!planId || !isPlainObject(req.body.state)) {
		return fail(res, 400, 'Missing required fields.');
	}
	if (Buffer.byteLength(JSON.stringify(req.body.state)) > plans.PLAN_STATE_MAX_BYTES) {
		return fail(res, 413, 'Plan state is too large.');
	}
	try {
		return ok(res, plans.savePlan(req.user.id, planId, req.body.title, req.body.state));
	} catch (error) {
		return fail(res, error.status || 500, error.message || 'Could not save the plan.');
	}
});

router.delete('/plans/:id', requireAccountAccess, (req, res) => {
	const planId = plans.sanitizePlanId(req.params.id);
	if (!planId) {
		return fail(res, 400, 'Missing plan id.');
	}
	plans.deletePlan(req.user.id, planId);
	return ok(res, null);
});

router.use((req, res) => fail(res, 404, 'Unknown API endpoint.'));

module.exports = router;
