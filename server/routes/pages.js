'use strict';

/** Server-rendered pages: planner, sign in / sign up, My Lesson Plans, account. */

const express = require('express');
const auth = require('../auth');
const settings = require('../services/settings');
const plans = require('../services/plans');
const curriculum = require('../services/curriculum');
const ai = require('../services/ai');
const profileService = require('../services/profile');
const { setPassword, verifyPassword } = auth;
const { db } = require('../db');

const router = express.Router();
const PKG_VERSION = require('../../package.json').version;

function safeRedirect(target) {
	const value = String(target || '');
	return value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

/** Equivalent of wp_localize_script(..., 'LessonDesignAIData', ...). */
function buildPlannerData(req) {
	const user = req.user;
	const aiSettings = settings.getAiSettings(!!user);
	const hasUserKey = !!(user && user.hasGeminiKey);
	// AI Assist is for signed-in teachers only.
	const siteAvailable = !!user && aiSettings.available && aiSettings.userDailyLimit > 0;
	const dataVersion = curriculum.getDataVersion();
	let aiUnavailable = 'AI Assist is not configured on this site yet.';
	if (!user) {
		aiUnavailable = 'Log in to use AI Assist.';
	} else if (!aiSettings.enabled) {
		aiUnavailable = 'AI Assist is turned off on this site.';
	}

	return {
		defaults: plans.defaultState(),
		storageKey: 'lessondesign_ai_state_v1',
		stepStorageKey: 'lessondesign_ai_step_v2',
		isLoggedIn: !!user,
		hasAccountAccess: !!(user && user.hasAccess),
		csrfToken: auth.csrfToken(req),
		apiBase: '/api',
		dataUrls: {
			curriculumSources: '/data/curriculum-sources.json?ver=' + dataVersion,
			curriculumManifest: '/data/curriculum-manifest.json?ver=' + dataVersion,
			resources: '/api/resources'
		},
		plannerPageUrl: '/',
		plansPageUrl: '/plans',
		loginPageUrl: '/login?redirect=%2F',
		registerPageUrl: '/register',
		ai: {
			enabled: aiSettings.enabled,
			available: !!user && ((aiSettings.enabled && siteAvailable) || (aiSettings.enabled && hasUserKey)),
			siteAvailable: aiSettings.enabled && siteAvailable,
			// Changes when the Teaching Profile is saved, so cached AI drafts aren't reused.
			profileVersion: user ? profileService.getProfile(req.userRow).updatedAt : '',
			provider: aiSettings.provider,
			model: aiSettings.model,
			hasUserGeminiKey: hasUserKey,
			fieldPaths: ai.getFieldPaths()
		},
		strings: {
			plannerSaved: 'Draft saved locally in this browser.',
			plannerReset: 'Planner reset. You are back to a fresh draft.',
			summaryDownloaded: 'Lesson PDF downloaded.',
			jsonDownloaded: 'Planner data downloaded.',
			jsonImported: 'Planner data imported into this browser.',
			jsonImportFailed: 'That file could not be imported. Use a LessonDesign AI JSON export and try again.',
			noExpectations: 'Choose your grade and subject to see curriculum focus areas.',
			noResources: 'No resources matched the current search. Try a broader term or switch the resource type filter.',
			noSelections: 'Nothing selected yet.',
			previewFallback: 'Start the planner to generate a lesson summary.',
			selectedResources: 'Selected Resources',
			guidedResources: '',
			browseResources: 'Browse mode keeps results neutral so you can search and filter manually.',
			noGuidedMatches: 'Choose your grade and subject, or add a search term, to sharpen the suggestions.',
			recommendedLabel: 'Suggested From This Draft',
			lastSavedPrefix: 'Last saved:',
			planSaved: 'Saved to your account.',
			planLoaded: 'Lesson plan opened from your account.',
			planLoadFailed: 'That saved lesson plan could not be opened.',
			loginRequired: 'Log in to save plans to your account.',
			subscriptionRequired: 'Your account needs an active LessonDesign subscription before saving, previewing, or exporting plans.',
			aiUnavailable,
			dataLoading: 'Loading LessonDesign AI...',
			dataLoadFailed: 'LessonDesign AI could not load its planner data. Refresh the page, then contact an administrator if the problem continues.',
			noStandards: 'Choose your grade and subject to see curriculum focus areas.',
			aiWorking: 'AI Assist is drafting ideas for this section...',
			aiSuggestionReady: 'AI suggestion ready. Review it before you apply anything.',
			aiApplied: 'AI suggestion applied to this section.',
			aiFieldApplied: 'AI suggestion applied to that field.',
			aiDiscarded: 'AI suggestion discarded.',
			aiNoSuggestion: 'AI Assist did not return a usable suggestion. Please try again.',
			aiRequestFailed: 'AI Assist ran into a problem. Please try again in a moment.',
			aiNetworkFailed: 'AI Assist could not reach the LessonDesign server. Check your connection and try again.',
			aiApplyAll: 'Apply All',
			aiDiscard: 'Discard',
			aiWarningsTitle: 'Things to keep in mind',
			aiRationaleTitle: 'Why this draft was suggested',
			aiSuggestionTitle: 'Suggested edits',
			aiApplyField: 'Apply Field'
		}
	};
}

router.use(auth.ensureSession);

router.use((req, res, next) => {
	res.locals.user = req.user;
	res.locals.csrfToken = auth.csrfToken(req);
	res.locals.currentPath = req.path;
	res.locals.version = PKG_VERSION;
	next();
});

router.get('/', (req, res) => {
	res.render('planner', {
		title: 'Lesson Planner',
		plannerData: buildPlannerData(req),
		transferableSkills: plans.TRANSFERABLE_SKILL_OPTIONS,
		crrpOptions: plans.CRRP_OPTIONS,
		profileOptions: profileService.OPTIONS,
		profileStarted: req.user ? profileService.isProfileStarted(profileService.getProfile(req.userRow)) : false
	});
});

/* ---- sign in / sign up ------------------------------------------------ */

router.get('/login', (req, res) => {
	if (req.user) {
		return res.redirect(safeRedirect(req.query.redirect));
	}
	return res.render('login', { title: 'Log In', error: '', email: '', redirect: safeRedirect(req.query.redirect), registrationEnabled: settings.getBool('registration_enabled') });
});

router.post('/login', auth.requireCsrf, (req, res) => {
	const redirect = safeRedirect(req.body.redirect);
	const row = auth.findUserForLogin(req.body.email, req.body.password);
	if (!row) {
		return res.status(401).render('login', { title: 'Log In', error: 'That email and password combination was not recognized.', email: req.body.email || '', redirect, registrationEnabled: settings.getBool('registration_enabled') });
	}
	auth.login(req, res, row);
	return res.redirect(redirect);
});

router.get('/register', (req, res) => {
	if (req.user) {
		return res.redirect('/');
	}
	return res.render('register', { title: 'Create Account', error: '', values: {}, registrationEnabled: settings.getBool('registration_enabled') });
});

router.post('/register', auth.requireCsrf, (req, res) => {
	const enabled = settings.getBool('registration_enabled');
	const values = { name: req.body.name || '', email: req.body.email || '' };
	if (!enabled) {
		return res.status(403).render('register', { title: 'Create Account', error: 'New account sign-up is closed. Contact your administrator.', values, registrationEnabled: false });
	}
	if (req.body.password !== req.body.password_confirm) {
		return res.status(400).render('register', { title: 'Create Account', error: 'The two passwords do not match.', values, registrationEnabled: true });
	}
	try {
		const row = auth.createUser({ email: req.body.email, name: req.body.name, password: req.body.password });
		auth.login(req, res, row);
		return res.redirect('/');
	} catch (error) {
		return res.status(400).render('register', { title: 'Create Account', error: error.message, values, registrationEnabled: true });
	}
});

router.post('/logout', auth.requireCsrf, (req, res) => {
	auth.destroySession(req, res);
	res.redirect('/');
});

/* ---- My Lesson Plans ---------------------------------------------------- */

router.get('/plans', (req, res) => {
	if (!req.user) {
		return res.redirect('/login?redirect=%2Fplans');
	}
	return res.render('plans', {
		title: 'My Lesson Plans',
		plans: req.user.hasAccess ? plans.listPlans(req.user.id) : [],
		plannerData: { csrfToken: auth.csrfToken(req), storageKey: 'lessondesign_ai_state_v1', stepStorageKey: 'lessondesign_ai_step_v2' }
	});
});

/* ---- Account ------------------------------------------------------------ */

router.get('/account', (req, res) => {
	if (!req.user) {
		return res.redirect('/login?redirect=%2Faccount');
	}
	return res.render('account', accountView(req, { notice: req.query.notice || '' }));
});

function accountView(req, extra) {
	return Object.assign({
		title: 'Account',
		notice: '',
		error: '',
		profile: profileService.getProfile(req.userRow),
		profileOptions: profileService.OPTIONS
	}, extra);
}

router.post('/account/profile', auth.requireCsrf, (req, res) => {
	if (!req.user) {
		return res.redirect('/login?redirect=%2Faccount');
	}
	profileService.saveProfile(req.user.id, req.body);
	const back = safeRedirect(req.body.return_to || '');
	if (back !== '/') {
		return res.redirect(back);
	}
	return res.redirect('/account?notice=' + encodeURIComponent('Teaching Profile saved. AI drafts will now follow it.') + '#teaching-profile');
});

router.post('/account', auth.requireCsrf, (req, res) => {
	if (!req.user) {
		return res.redirect('/login?redirect=%2Faccount');
	}
	try {
		if (typeof req.body.name === 'string') {
			db.prepare('UPDATE users SET name = ? WHERE id = ?').run(req.body.name.trim().slice(0, 120), req.user.id);
		}
		if (req.body.new_password) {
			if (!verifyPassword(req.body.current_password || '', req.userRow.password_hash)) {
				throw new Error('Your current password was not correct.');
			}
			if (req.body.new_password !== req.body.new_password_confirm) {
				throw new Error('The two new passwords do not match.');
			}
			setPassword(req.user.id, req.body.new_password);
		}
		return res.redirect('/account?notice=' + encodeURIComponent('Account updated.'));
	} catch (error) {
		return res.status(400).render('account', accountView(req, { error: error.message }));
	}
});

module.exports = router;
module.exports.buildPlannerData = buildPlannerData;
