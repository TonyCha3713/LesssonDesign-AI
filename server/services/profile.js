'use strict';

/**
 * Teaching Profile: how each teacher teaches, what their class is like, and
 * how they want AI drafts written. It is stored on the user account and sent
 * with every AI Assist request (server-side, so it can't be spoofed), which is
 * what makes two teachers' drafts of the same lesson come out differently.
 *
 * Add or rename options here — the Account page and the AI prompt pick them up
 * automatically.
 */

const { db } = require('../db');
const { sanitizeTextValue, sanitizeEnumList, isPlainObject } = require('../util');

const OPTIONS = {
	teachingStyles: [
		'Inquiry-based',
		'Project-based',
		'Hands-on / experiential',
		'Collaborative group work',
		'Direct instruction',
		'Game-based',
		'Land-based / outdoor learning',
		'Flipped classroom',
		'Discussion and debate'
	],
	assessmentPreferences: [
		'Exit tickets',
		'Observation checklists',
		'Rubrics',
		'Self and peer assessment',
		'Portfolios',
		'Quizzes',
		'Performance tasks',
		'Student conferences',
		'Oral presentations'
	],
	tone: [
		'Practical and concise',
		'Warm and encouraging',
		'Detailed and structured',
		'Creative and playful'
	],
	detailLevel: [
		'Brief outline',
		'Balanced',
		'Step-by-step detail'
	],
	techAccess: [
		'1:1 devices',
		'Shared devices / laptop cart',
		'Projector or smartboard only',
		'Low-tech or no-tech'
	],
	lessonLength: [
		'30 minutes',
		'45 minutes',
		'60 minutes',
		'75 minutes',
		'90 minutes',
		'Multi-day (2–3 classes)',
		'Unit (1–2 weeks)'
	]
};

function emptyProfile() {
	return {
		gradesTaught: '',
		subjectsTaught: '',
		teachingStyles: [],
		assessmentPreferences: [],
		tone: '',
		detailLevel: '',
		techAccess: '',
		lessonLength: '',
		classProfile: '',
		goals: '',
		aboutMe: '',
		updatedAt: ''
	};
}

function pickOne(value, options) {
	return options.includes(value) ? value : '';
}

function sanitizeProfile(input) {
	const source = isPlainObject(input) ? input : {};
	const asList = (value) => (Array.isArray(value) ? value : (value ? [value] : []));
	return {
		gradesTaught: sanitizeTextValue(source.gradesTaught || '', 120, false),
		subjectsTaught: sanitizeTextValue(source.subjectsTaught || '', 200, false),
		teachingStyles: sanitizeEnumList(asList(source.teachingStyles), OPTIONS.teachingStyles, 9),
		assessmentPreferences: sanitizeEnumList(asList(source.assessmentPreferences), OPTIONS.assessmentPreferences, 9),
		tone: pickOne(source.tone, OPTIONS.tone),
		detailLevel: pickOne(source.detailLevel, OPTIONS.detailLevel),
		techAccess: pickOne(source.techAccess, OPTIONS.techAccess),
		lessonLength: pickOne(source.lessonLength, OPTIONS.lessonLength),
		classProfile: sanitizeTextValue(source.classProfile || '', 1200, true),
		goals: sanitizeTextValue(source.goals || '', 800, true),
		aboutMe: sanitizeTextValue(source.aboutMe || '', 800, true),
		updatedAt: sanitizeTextValue(source.updatedAt || '', 40, false)
	};
}

function getProfile(userRow) {
	if (!userRow) {
		return emptyProfile();
	}
	try {
		return Object.assign(emptyProfile(), sanitizeProfile(JSON.parse(userRow.teaching_profile || '{}')));
	} catch (error) {
		return emptyProfile();
	}
}

function saveProfile(userId, input) {
	const profile = sanitizeProfile(input);
	profile.updatedAt = new Date().toISOString();
	db.prepare('UPDATE users SET teaching_profile = ? WHERE id = ?').run(JSON.stringify(profile), userId);
	return profile;
}

function isProfileStarted(profile) {
	return Object.entries(profile).some(([key, value]) => key !== 'updatedAt' && (Array.isArray(value) ? value.length : !!value));
}

module.exports = {
	OPTIONS,
	emptyProfile,
	sanitizeProfile,
	getProfile,
	saveProfile,
	isProfileStarted
};
