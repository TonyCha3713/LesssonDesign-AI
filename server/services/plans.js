'use strict';

/**
 * Lesson plan model: defaults, option lists, sanitizing, and per-teacher
 * storage (port of LDAI_Plan_Service + sanitize_plan_state + the plan AJAX
 * handlers).
 *
 * Field data is identical to the WordPress build, so plan JSON exported from
 * the old site imports here unchanged.
 */

const { db, nowIso } = require('../db');
const curriculum = require('./curriculum');
const resources = require('./resources');
const {
	isScalar, asObject, sanitizeText, sanitizeKey, sanitizeTextValue,
	sanitizeEnumList, sanitizeKnownIdList, getAllowedIds, findById
} = require('../util');

const PLAN_ID_MAX_LENGTH = 80;
const PLAN_TITLE_MAX_LENGTH = 180;
const PLAN_STATE_MAX_BYTES = 131072;
const MAX_PLANS_PER_USER = 100;

const TRANSFERABLE_SKILL_OPTIONS = [
	'Critical Thinking & Problem Solving',
	'Communication',
	'Collaboration',
	'Creativity & Innovation',
	'Self-awareness & Responsibility',
	'Global Citizenship'
];

const CRRP_OPTIONS = [
	'Reflects diverse identities, perspectives, and experiences',
	"Connects learning to students' backgrounds and lived experiences",
	'Promotes a sense of belonging for all learners',
	'Provides multiple ways for students to participate and demonstrate learning',
	'Encourages respectful dialogue and diverse viewpoints'
];

/** Character limits shared by plan saving, AI context, and AI patches. */
const FIELD_LIMITS = {
	foundation: {
		title: { max: 180, multiline: false },
		prompt: { max: 220, multiline: false },
		overview: { max: 1500, multiline: true },
		learnerContext: { max: 1200, multiline: true },
		learningGoals: { max: 1500, multiline: true },
		successCriteria: { max: 1500, multiline: true },
		formativeAssessment: { max: 1200, multiline: true },
		summativeAssessment: { max: 1200, multiline: true }
	},
	design: {
		learningActivities: { max: 2200, multiline: true },
		materials: { max: 1500, multiline: true },
		technology: { max: 1200, multiline: true },
		differentiation: { max: 1500, multiline: true },
		teacherNotes: { max: 1500, multiline: true }
	}
};

function defaultState() {
	return {
		foundation: {
			title: '',
			prompt: '',
			overview: '',
			learnerContext: '',
			learningGoals: '',
			successCriteria: '',
			formativeAssessment: '',
			summativeAssessment: ''
		},
		curriculum: {
			country: 'CA',
			track: '',
			tracks: [],
			jurisdiction: 'ca-ab',
			framework: 'ca-ab-curriculum',
			program: 'en-core',
			grade: '',
			subjectArea: '',
			subject: '',
			note: ''
		},
		connections: {
			mode: 'guided',
			note: ''
		},
		design: {
			learningActivities: '',
			materials: '',
			technology: '',
			differentiation: '',
			transferableSkills: [],
			crrpChecks: [],
			teacherNotes: ''
		},
		selectedStandards: [],
		selectedResources: [],
		meta: {
			lastSaved: '',
			serverId: ''
		}
	};
}

function sanitizePlanId(value) {
	if (!isScalar(value)) {
		return '';
	}
	const id = sanitizeText(String(value)).slice(0, PLAN_ID_MAX_LENGTH);
	return /^[A-Za-z0-9_-]+$/.test(id) ? id : '';
}

function isAlbertaTrack(track) {
	return !!track && track.country === 'CA' && track.jurisdictionId === 'ca-ab' && track.frameworkId === 'ca-ab-curriculum' && track.programId === 'en-core';
}

/** Port of LDAI_Plugin::sanitize_plan_state(). Returns null for invalid input. */
function sanitizePlanState(state) {
	if (!state || typeof state !== 'object' || Array.isArray(state)) {
		return null;
	}
	const sources = curriculum.getSources();
	const allowedTracks = getAllowedIds(sources.curriculumTracks);
	const allowedGrades = getAllowedIds(sources.gradeLevels);
	const output = defaultState();
	const foundation = asObject(state.foundation);
	const cur = asObject(state.curriculum);
	const connections = asObject(state.connections);
	const design = asObject(state.design);
	const meta = asObject(state.meta);

	for (const [field, rules] of Object.entries(FIELD_LIMITS.foundation)) {
		output.foundation[field] = sanitizeTextValue(foundation[field] || '', rules.max, rules.multiline);
	}

	const track = isScalar(cur.track) ? sanitizeText(String(cur.track)) : '';
	const tracks = Array.isArray(cur.tracks) ? cur.tracks.slice() : [];
	if (track) {
		tracks.unshift(track);
	}
	const grade = isScalar(cur.grade) ? sanitizeText(String(cur.grade)) : '';

	const out = output.curriculum;
	out.track = allowedTracks.includes(track) ? track : '';
	out.tracks = sanitizeKnownIdList(tracks, allowedTracks, 6).filter((id) => isAlbertaTrack(findById(sources.curriculumTracks, id)));
	out.grade = ['7', '8', '9'].includes(grade) && allowedGrades.includes(grade) ? grade : '';
	out.note = sanitizeTextValue(cur.note || '', 500, true);
	out.subjectArea = getAllowedIds(sources.subjectAreas).includes(cur.subjectArea) ? cur.subjectArea : '';
	out.subject = getAllowedIds(sources.subjects).includes(cur.subject) ? cur.subject : '';

	if (!out.track && out.tracks.length) {
		out.track = out.tracks[0];
	}
	if (!out.track) {
		out.track = curriculum.inferTrackId(out);
	}
	if (out.track && !out.tracks.includes(out.track)) {
		out.tracks.unshift(out.track);
	}
	out.tracks = Array.from(new Set(out.tracks)).slice(0, 6);

	const trackRecord = findById(sources.curriculumTracks, out.track);
	if (trackRecord) {
		if (!isAlbertaTrack(trackRecord)) {
			out.track = '';
			out.tracks = [];
		} else {
			out.subjectArea = String(trackRecord.subjectAreaId || '');
			out.subject = String(trackRecord.subject || '');
		}
	}

	output.connections.mode = sanitizeKey(connections.mode) === 'browse' ? 'browse' : 'guided';
	output.connections.note = sanitizeTextValue(connections.note || '', 500, true);

	for (const [field, rules] of Object.entries(FIELD_LIMITS.design)) {
		output.design[field] = sanitizeTextValue(design[field] || '', rules.max, rules.multiline);
	}
	output.design.transferableSkills = sanitizeEnumList(design.transferableSkills, TRANSFERABLE_SKILL_OPTIONS, 6);
	output.design.crrpChecks = sanitizeEnumList(design.crrpChecks, CRRP_OPTIONS, 5);

	const { standards, aliases } = curriculum.loadStandardsForCurriculum(out);
	const allowedStandards = new Set(getAllowedIds(standards));
	const contextual = curriculum.getContextualStandardIds(standards, out).filter((id) => allowedStandards.has(id));
	const expanded = curriculum.expandStandardIds(standards, state.selectedStandards || [], aliases);
	output.selectedStandards = sanitizeKnownIdList(expanded, contextual, 40);
	output.selectedResources = sanitizeKnownIdList(state.selectedResources || [], resources.getAllowedResourceIds(), 20);
	output.meta.lastSaved = sanitizeTextValue(meta.lastSaved || '', 40, false);
	output.meta.serverId = sanitizePlanId(meta.serverId || '');

	return output;
}

/* ---- storage ------------------------------------------------------------ */

function rowToPlan(row) {
	let state;
	try {
		state = JSON.parse(row.state);
	} catch (error) {
		state = defaultState();
	}
	return { id: row.id, title: row.title, lastSaved: row.last_saved, state };
}

function listPlans(userId) {
	return db.prepare('SELECT id, title, last_saved FROM plans WHERE user_id = ? ORDER BY last_saved DESC')
		.all(userId)
		.map((row) => ({ id: row.id, title: row.title, lastSaved: row.last_saved }));
}

function getPlan(userId, planId) {
	const row = db.prepare('SELECT * FROM plans WHERE user_id = ? AND id = ?').get(userId, planId);
	return row ? rowToPlan(row) : null;
}

function savePlan(userId, planId, title, rawState) {
	const state = sanitizePlanState(rawState);
	if (!state) {
		throw Object.assign(new Error('Invalid plan state.'), { status: 400 });
	}
	const now = nowIso();
	state.meta.serverId = planId;
	state.meta.lastSaved = now;
	const cleanTitle = sanitizeTextValue(title || '', PLAN_TITLE_MAX_LENGTH, false) || state.foundation.title || 'Untitled Lesson';

	db.prepare(`INSERT INTO plans (id, user_id, title, state, last_saved) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(user_id, id) DO UPDATE SET title = excluded.title, state = excluded.state, last_saved = excluded.last_saved`)
		.run(planId, userId, cleanTitle, JSON.stringify(state), now);

	// Keep the most recent plans only (WordPress kept 20; raise as needed).
	db.prepare(`DELETE FROM plans WHERE user_id = ? AND id NOT IN (
		SELECT id FROM plans WHERE user_id = ? ORDER BY last_saved DESC LIMIT ?)`).run(userId, userId, MAX_PLANS_PER_USER);

	return { id: planId, lastSaved: now };
}

function deletePlan(userId, planId) {
	db.prepare('DELETE FROM plans WHERE user_id = ? AND id = ?').run(userId, planId);
}

module.exports = {
	PLAN_STATE_MAX_BYTES,
	PLAN_TITLE_MAX_LENGTH,
	TRANSFERABLE_SKILL_OPTIONS,
	CRRP_OPTIONS,
	FIELD_LIMITS,
	defaultState,
	sanitizePlanId,
	sanitizePlanState,
	listPlans,
	getPlan,
	savePlan,
	deletePlan
};
