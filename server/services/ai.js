'use strict';

/**
 * AI Assist ("Draft This Section" / "Improve What I Wrote").
 *
 * Port of the WordPress plugin's AI pipeline: build a compact planner context,
 * send it to Gemini and/or Azure OpenAI with a JSON schema, then validate and
 * sanitize the returned patch before it ever reaches the browser.
 *
 * Prompts live in /instructions/ai/*.md so they can be edited without code.
 *
 * AI-enabled steps (keyed by wizard step id):
 *   foundation – Core Lesson Idea (title, big idea, overview, learner context)
 *   targets    – Learning Goals, Success Criteria, Formative/Summative, Transferable Skills
 *   design     – Support Every Learner + learning experience fields
 */

const fs = require('fs');
const path = require('path');
const { ROOT } = require('../db');
const settings = require('./settings');
const curriculum = require('./curriculum');
const resources = require('./resources');
const plans = require('./plans');
const profileService = require('./profile');
const { asObject, sanitizeText, sanitizeKey, sanitizeTextValue, sanitizeEnumList, sanitizeKnownIdList, getAllowedIds, pruneEmpty, isScalar } = require('../util');

const SECTIONS = ['foundation', 'targets', 'design'];
const ACTIONS = ['draft_section', 'improve_existing'];
const AI_STATE_MAX_BYTES = 65536;
const CURRICULUM_CONTEXT_LIMIT = 12;
const RESOURCE_CONTEXT_LIMIT = 4;
const LIGHT_RESOURCE_CONTEXT_LIMIT = 2;
const REQUEST_TIMEOUT_MS = 45000;
const MAX_TEACHER_REQUEST = 600;

/**
 * Patch fields per AI section. `path` is where the field lives in the plan
 * state (Transferable Skills are edited in step 3 but stored on design).
 */
const SECTION_FIELDS = {
	foundation: {
		title: { path: 'foundation.title', ...plans.FIELD_LIMITS.foundation.title },
		prompt: { path: 'foundation.prompt', ...plans.FIELD_LIMITS.foundation.prompt },
		overview: { path: 'foundation.overview', ...plans.FIELD_LIMITS.foundation.overview },
		learnerContext: { path: 'foundation.learnerContext', ...plans.FIELD_LIMITS.foundation.learnerContext }
	},
	targets: {
		learningGoals: { path: 'foundation.learningGoals', ...plans.FIELD_LIMITS.foundation.learningGoals },
		successCriteria: { path: 'foundation.successCriteria', ...plans.FIELD_LIMITS.foundation.successCriteria },
		formativeAssessment: { path: 'foundation.formativeAssessment', ...plans.FIELD_LIMITS.foundation.formativeAssessment },
		summativeAssessment: { path: 'foundation.summativeAssessment', ...plans.FIELD_LIMITS.foundation.summativeAssessment },
		transferableSkills: { path: 'design.transferableSkills', enumOf: plans.TRANSFERABLE_SKILL_OPTIONS, limit: 6, optional: true }
	},
	design: {
		differentiation: { path: 'design.differentiation', ...plans.FIELD_LIMITS.design.differentiation },
		crrpChecks: { path: 'design.crrpChecks', enumOf: plans.CRRP_OPTIONS, limit: 5, optional: true },
		learningActivities: { path: 'design.learningActivities', ...plans.FIELD_LIMITS.design.learningActivities },
		materials: { path: 'design.materials', ...plans.FIELD_LIMITS.design.materials },
		technology: { path: 'design.technology', ...plans.FIELD_LIMITS.design.technology },
		teacherNotes: { path: 'design.teacherNotes', ...plans.FIELD_LIMITS.design.teacherNotes }
	}
};

class AiError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}

	get status() {
		switch (this.code) {
			case 'limit_disabled':
			case 'disabled':
			case 'no_access':
				return 403;
			case 'rate_limited':
				return 429;
			case 'bad_request':
				return 400;
			case 'too_large':
				return 413;
			case 'missing_key':
			case 'transport_error':
			case 'api_overloaded':
			case 'api_configuration_error':
				return 503;
			case 'api_error':
			case 'invalid_api_response':
			case 'empty_response':
			case 'invalid_json':
			case 'invalid_status':
			case 'invalid_section':
			case 'empty_patch':
				return 502;
			default:
				return 500;
		}
	}
}

/* ---- prompt files --------------------------------------------------------- */

const INSTRUCTION_FILES = {
	system: 'instructions/ai/system-guardrails.md',
	action_draft_section: 'instructions/ai/actions/draft_section.md',
	action_improve_existing: 'instructions/ai/actions/improve_existing.md',
	section_foundation: 'instructions/ai/sections/foundation.md',
	section_targets: 'instructions/ai/sections/targets.md',
	section_design: 'instructions/ai/sections/design.md',
	personalization: 'instructions/ai/personalization.md'
};

const FALLBACK_INSTRUCTIONS = {
	system: [
		'You are LessonDesign AI, a lesson-planning drafting assistant for teachers.',
		'Return structured JSON only.',
		'Help the teacher with the requested planner section and do not write outside that section.',
		'Use only the curriculum pieces provided in the input. Do not quote or invent official curriculum text.',
		'Keep the writing practical, classroom-ready, and easy for a teacher to edit.',
		'For multiline fields, return plain newline-separated lines without bullets or numbering.'
	].join('\n'),
	action_draft_section: 'Draft the requested section based on the available context and keep all suggestions grounded and modest.',
	action_improve_existing: 'Improve and tighten what the teacher already wrote while keeping the original intent intact.',
	section_foundation: '',
	section_targets: '',
	section_design: 'For design patches, use only the exact CRRP option values provided in the planner context when you return that array.',
	personalization: 'Adapt every draft to teacherProfile and lessonPreferences when they are provided: match the teacher\'s style, tone, detail level, class needs, technology, lesson length, and goals.'
};

function readInstruction(key) {
	// Read on every call so prompt edits apply without a restart (files are tiny).
	try {
		const text = fs.readFileSync(path.join(ROOT, INSTRUCTION_FILES[key]), 'utf8').trim();
		if (text) {
			return text;
		}
	} catch (error) {
		// fall through to fallback
	}
	return FALLBACK_INSTRUCTIONS[key] || '';
}

function buildSystemInstructions(section, action) {
	return [
		readInstruction('system'),
		'Requested section: ' + section + '.',
		readInstruction(action === 'improve_existing' ? 'action_improve_existing' : 'action_draft_section'),
		readInstruction('section_' + section),
		readInstruction('personalization')
	].map((line) => String(line || '').trim()).filter(Boolean).join('\n');
}

function getInstructionDiagnostics() {
	return Object.entries(INSTRUCTION_FILES).map(([key, relative]) => {
		let ok = false;
		try {
			ok = fs.readFileSync(path.join(ROOT, relative), 'utf8').trim() !== '';
		} catch (error) {
			ok = false;
		}
		return { key, path: relative, ok };
	});
}

/* ---- context ---------------------------------------------------------- */

function compactCurriculumPieces(standards) {
	const priority = [];
	const other = [];
	for (const standard of standards) {
		const piece = {
			id: standard.id,
			code: standard.standardCode || standard.code || '',
			moduleLabel: standard.moduleLabel || '',
			summary: sanitizeTextValue(standard.officialOutcomeText || standard.summaryText || standard.text || '', 500),
			courseCode: standard.courseCode || '',
			courseLabel: standard.courseLabel || ''
		};
		if (!piece.id) {
			continue;
		}
		(['Learning focus', 'Practice and evidence'].includes(piece.moduleLabel) ? priority : other).push(piece);
	}
	return priority.concat(other).slice(0, CURRICULUM_CONTEXT_LIMIT);
}

function compactResources(items, lightweight) {
	return items.slice(0, lightweight ? LIGHT_RESOURCE_CONTEXT_LIMIT : RESOURCE_CONTEXT_LIMIT).map((item) => {
		const out = { id: item.id, title: sanitizeTextValue(item.title, 180, false), kind: item.kind };
		if (!lightweight) {
			out.summary = sanitizeTextValue(item.summary, 300);
			out.format = sanitizeTextValue(item.format, 60, false);
			out.duration = sanitizeTextValue(item.duration, 60, false);
		}
		return out;
	});
}

function text(value, max, multiline = true) {
	return sanitizeTextValue(value || '', max, multiline);
}

/**
 * Personalization for the prompt:
 *  - teacherRequest: what the teacher typed in the prompt box for this draft
 *  - teacherProfile: their saved Teaching Profile (read from the account on the
 *    server, never from the browser)
 */
function buildPersonalization(teacherProfile, teacherRequest) {
	const profile = teacherProfile || profileService.emptyProfile();
	return {
		teacherRequest: sanitizeTextValue(teacherRequest || '', MAX_TEACHER_REQUEST, true),
		teacherProfile: pruneEmpty({
			gradesTaught: profile.gradesTaught,
			subjectsTaught: profile.subjectsTaught,
			teachingStyles: profile.teachingStyles,
			preferredAssessment: profile.assessmentPreferences,
			writingTone: profile.tone,
			detailLevel: profile.detailLevel,
			technologyAccess: profile.techAccess,
			typicalLessonLength: profile.lessonLength,
			classProfile: profile.classProfile,
			teachingGoals: profile.goals,
			aboutTheTeacher: profile.aboutMe
		})
	};
}

function buildContext(section, action, state, teacherProfile = null, teacherRequest = '') {
	const cur = asObject(state.curriculum);
	const foundation = asObject(state.foundation);
	const design = asObject(state.design);
	const connections = asObject(state.connections);
	const sources = curriculum.getSources();
	const allowedTracks = getAllowedIds(sources.curriculumTracks);

	let trackId = sanitizeText(cur.track || '');
	const trackIds = sanitizeKnownIdList([].concat(Array.isArray(cur.tracks) ? cur.tracks : [], [trackId]), allowedTracks, 6);
	if (!trackId) {
		trackId = trackIds[0] || '';
	}
	const curriculumState = { track: trackId, tracks: trackIds, grade: sanitizeText(cur.grade || '') };
	const { standards, aliases } = curriculum.loadStandardsForCurriculum(curriculumState);
	const selectedIds = (Array.isArray(state.selectedStandards) ? state.selectedStandards : []).filter(isScalar).map(String);
	const selectedStandards = curriculum.getStandardsByIds(standards, selectedIds, aliases);
	const trackLabels = trackIds.map((id) => curriculum.labelFor(sources.curriculumTracks, id)).filter(Boolean);
	const selectedResources = resources.getResourcesByIds(state.selectedResources || [], RESOURCE_CONTEXT_LIMIT);

	const lessonIdea = {
		title: text(foundation.title, 180, false),
		prompt: text(foundation.prompt, 220, false),
		overview: text(foundation.overview, section === 'foundation' ? 1200 : 500),
		learnerContext: text(foundation.learnerContext, section === 'foundation' ? 900 : 500)
	};
	const targets = {
		learningGoals: text(foundation.learningGoals, section === 'targets' ? 1200 : 600),
		successCriteria: text(foundation.successCriteria, section === 'targets' ? 1200 : 600),
		formativeAssessment: text(foundation.formativeAssessment, section === 'targets' ? 900 : 400),
		summativeAssessment: text(foundation.summativeAssessment, section === 'targets' ? 900 : 400),
		transferableSkills: sanitizeEnumList(design.transferableSkills, plans.TRANSFERABLE_SKILL_OPTIONS, 6)
	};

	const context = {
		section,
		action,
		curriculumTrack: trackLabels.join(', ') || trackId,
		grade: curriculum.labelFor(sources.gradeLevels, curriculumState.grade) || curriculumState.grade,
		selectedCurriculumPieces: compactCurriculumPieces(selectedStandards)
	};

	if (section === 'foundation') {
		context.currentLessonIdea = lessonIdea;
		context.existingTargets = { learningGoals: targets.learningGoals, successCriteria: targets.successCriteria };
		context.selectedResources = compactResources(selectedResources, true);
	} else if (section === 'targets') {
		context.lessonIdea = lessonIdea;
		context.currentTargets = targets;
		context.selectedResources = compactResources(selectedResources, true);
		context.allowedTargetOptions = { transferableSkills: plans.TRANSFERABLE_SKILL_OPTIONS };
	} else {
		context.lessonIdea = lessonIdea;
		context.lessonTargets = targets;
		context.currentDesign = {
			differentiation: text(design.differentiation, 1200),
			crrpChecks: sanitizeEnumList(design.crrpChecks, plans.CRRP_OPTIONS, 5),
			learningActivities: text(design.learningActivities, 2200),
			materials: text(design.materials, 1200),
			technology: text(design.technology, 900),
			teacherNotes: text(design.teacherNotes, 1000)
		};
		context.connections = { note: text(connections.note, 400) };
		context.selectedResources = compactResources(selectedResources, false);
		context.allowedDesignOptions = { crrpChecks: plans.CRRP_OPTIONS };
	}

	Object.assign(context, buildPersonalization(teacherProfile, teacherRequest));

	return pruneEmpty(context);
}

/* ---- schema ------------------------------------------------------------- */

function getResponseSchema(section) {
	const fields = SECTION_FIELDS[section];
	const properties = {};
	const required = [];
	for (const [field, rules] of Object.entries(fields)) {
		if (rules.enumOf) {
			properties[field] = { type: 'array', uniqueItems: true, items: { type: 'string', enum: rules.enumOf } };
		} else {
			properties[field] = { type: 'string' };
		}
		// Every free-text field is required so the model can't satisfy the
		// schema by returning a subset; enum arrays may legitimately be empty.
		if (!rules.optional) {
			required.push(field);
		}
	}
	return {
		type: 'object',
		additionalProperties: false,
		required: ['status', 'section', 'patch'],
		properties: {
			status: { type: 'string', enum: ['ready', 'refused'] },
			section: { type: 'string', enum: [section] },
			patch: {
				type: 'object',
				additionalProperties: false,
				properties: {
					[section]: { type: 'object', additionalProperties: false, required, properties }
				}
			},
			rationale: { type: 'array', items: { type: 'string' } },
			warnings: { type: 'array', items: { type: 'string' } }
		}
	};
}

function stripGeminiUnsupported(schema) {
	if (Array.isArray(schema)) {
		return schema.map(stripGeminiUnsupported);
	}
	if (schema && typeof schema === 'object') {
		const out = {};
		for (const [key, value] of Object.entries(schema)) {
			if (key === 'additionalProperties') {
				continue;
			}
			out[key] = stripGeminiUnsupported(value);
		}
		return out;
	}
	return schema;
}

/** Drafts vary more between teachers and retries; "Improve" stays close to the teacher's own words. */
function temperatureFor(action) {
	return action === 'improve_existing' ? 0.3 : 0.7;
}

function maxOutputTokens(section, action) {
	if (action === 'test_connection') {
		return 300;
	}
	// Thinking models spend a context-dependent number of hidden tokens before
	// writing visible output, so leave generous headroom or JSON gets truncated.
	if (section === 'design') {
		return action === 'improve_existing' ? 3500 : 4500;
	}
	return action === 'improve_existing' ? 3000 : 4000;
}

/* ---- providers ---------------------------------------------------------- */

function isRetriable(status, message) {
	const lower = String(message || '').toLowerCase();
	if ([408, 409, 429].includes(status) || status >= 500) {
		return true;
	}
	return ['high demand', 'temporarily unavailable', 'try again later', 'overloaded', 'unavailable'].some((needle) => lower.includes(needle));
}

function apiError(status, message, providerLabel) {
	if (isRetriable(status, message)) {
		return new AiError('api_overloaded', (providerLabel || 'The AI provider') + ' is busy right now. Please try again in a moment.');
	}
	if ([400, 401, 403].includes(status)) {
		return new AiError('api_configuration_error', 'AI Assist is not configured correctly on this site yet.' + (message ? ' (' + String(message).slice(0, 160) + ')' : ''));
	}
	return new AiError('api_error', message || 'AI Assist is unavailable right now. Please try again in a moment.');
}

async function postJson(url, headers, body) {
	let response;
	try {
		response = await fetch(url, {
			method: 'POST',
			headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		});
	} catch (error) {
		throw new AiError('transport_error', 'AI Assist could not reach the AI provider. Please try again in a moment.');
	}
	const raw = await response.text();
	let decoded = null;
	try {
		decoded = JSON.parse(raw);
	} catch (error) {
		decoded = null;
	}
	return { status: response.status, decoded };
}

/**
 * Shared bounded-retry loop: attempt 1 uses the JSON schema, later attempts
 * drop it. Content-quality failures (truncated/non-JSON text) retry; genuine
 * HTTP/auth/config errors fail fast.
 */
async function callWithRetries({ label, request, extractText, schemaErrorNeedles }) {
	const attempts = [true, false, false];
	let lastError = null;
	for (let index = 0; index < attempts.length; index += 1) {
		const useSchema = attempts[index];
		const isLast = index === attempts.length - 1;
		const { status, decoded } = await request(useSchema);

		if (status < 200 || status >= 300) {
			const message = decoded && decoded.error && typeof decoded.error.message === 'string' ? decoded.error.message.trim() : '';
			if (useSchema && status === 400 && schemaErrorNeedles.some((needle) => message.toLowerCase().includes(needle))) {
				continue;
			}
			throw apiError(status, message, label);
		}
		if (!decoded || typeof decoded !== 'object') {
			lastError = new AiError('invalid_api_response', 'AI Assist returned an unreadable response. Please try again.');
			if (!isLast) continue;
			throw lastError;
		}
		const responseText = extractText(decoded);
		if (!responseText) {
			lastError = new AiError('empty_response', 'AI Assist did not return a usable suggestion. Please try again.');
			if (!isLast) continue;
			throw lastError;
		}
		let parsed = null;
		try {
			parsed = JSON.parse(stripCodeFence(responseText));
		} catch (error) {
			parsed = null;
		}
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			lastError = new AiError('invalid_json', 'AI Assist returned a malformed suggestion. Please try again.');
			if (!isLast) continue;
			throw lastError;
		}
		return parsed;
	}
	throw lastError || new AiError('api_error', 'AI Assist is unavailable right now. Please try again in a moment.');
}

function stripCodeFence(value) {
	return String(value).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}

async function callGemini(section, action, context, apiKeyOverride = '') {
	const apiKey = apiKeyOverride || settings.get('gemini_api_key');
	const model = settings.getGeminiModel();
	if (!apiKey || !model) {
		throw new AiError('missing_key', 'AI Assist is not configured on this site yet.');
	}
	// LDAI_GEMINI_BASE_URL lets you route through a proxy/gateway (or a mock in tests).
	const baseUrl = (process.env.LDAI_GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
	const url = baseUrl + '/models/' + encodeURIComponent(model) + ':generateContent';
	const contextJson = JSON.stringify(context);

	return callWithRetries({
		label: 'Google Gemini',
		schemaErrorNeedles: ['response_schema', 'schema', 'generationconfig'],
		request: (useSchema) => {
			const generationConfig = {
				temperature: temperatureFor(action),
				maxOutputTokens: maxOutputTokens(section, action),
				response_mime_type: 'application/json'
			};
			if (useSchema) {
				generationConfig.response_schema = stripGeminiUnsupported(getResponseSchema(section));
			}
			return postJson(url, { 'x-goog-api-key': apiKey }, {
				system_instruction: { parts: [{ text: buildSystemInstructions(section, action) }] },
				contents: [{ role: 'user', parts: [{ text: 'Planner context:\n' + contextJson }] }],
				generationConfig
			});
		},
		extractText: (response) => {
			for (const candidate of Array.isArray(response.candidates) ? response.candidates : []) {
				const parts = candidate && candidate.content && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
				const joined = parts.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('').trim();
				if (joined) {
					return joined;
				}
			}
			return '';
		}
	});
}

async function callAzure(section, action, context) {
	const azure = settings.getAzureConfig();
	if (!azure.apiKey || !azure.endpoint || !azure.deployment) {
		throw new AiError('missing_key', 'AI Assist is not configured on this site yet.');
	}
	const url = azure.endpoint + '/openai/deployments/' + encodeURIComponent(azure.deployment) + '/chat/completions?api-version=' + encodeURIComponent(azure.apiVersion);
	const contextJson = JSON.stringify(context);

	return callWithRetries({
		label: 'Microsoft Azure OpenAI',
		schemaErrorNeedles: ['response_format', 'json_schema', 'structured output'],
		request: (useSchema) => postJson(url, { 'api-key': azure.apiKey }, {
			messages: [
				{ role: 'system', content: buildSystemInstructions(section, action) },
				{ role: 'user', content: 'Planner context:\n' + contextJson }
			],
			temperature: temperatureFor(action),
			max_tokens: maxOutputTokens(section, action),
			response_format: useSchema
				? { type: 'json_schema', json_schema: { name: 'lesson_design_ai_response', strict: true, schema: getResponseSchema(section) } }
				: { type: 'json_object' }
		}),
		extractText: (response) => {
			for (const choice of Array.isArray(response.choices) ? response.choices : []) {
				const content = choice && choice.message ? choice.message.content : null;
				if (typeof content === 'string' && content.trim()) {
					return content.trim();
				}
				if (Array.isArray(content)) {
					const joined = content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('').trim();
					if (joined) {
						return joined;
					}
				}
			}
			return '';
		}
	});
}

/**
 * Provider routing. A teacher's own Gemini key always wins; otherwise walk the
 * site's provider order and fall back to the next configured provider.
 */
async function generate(section, action, context, { userGeminiKey = '', isLoggedIn = false, forceSiteConfig = false } = {}) {
	if (!forceSiteConfig && userGeminiKey) {
		return callGemini(section, action, context, userGeminiKey);
	}
	let lastError = null;
	for (const provider of settings.getProviderOrder(isLoggedIn)) {
		if (!settings.hasProviderConfig(provider)) {
			continue;
		}
		try {
			return provider === settings.PROVIDER_GEMINI
				? await callGemini(section, action, context)
				: await callAzure(section, action, context);
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError || new AiError('missing_key', 'AI Assist is not configured on this site yet.');
}

/* ---- validation ------------------------------------------------------- */

function normalizeBareResponse(response, section) {
	if (response.status && response.section) {
		return response;
	}
	if (response.patch && typeof response.patch === 'object') {
		return Object.assign({ status: 'ready', section }, response);
	}
	const known = Object.keys(SECTION_FIELDS[section]);
	if (!known.some((field) => Object.prototype.hasOwnProperty.call(response, field))) {
		return response;
	}
	return { status: 'ready', section, patch: { [section]: response }, rationale: [], warnings: [] };
}

function sanitizeStringList(items, limit, maxLength) {
	const output = [];
	for (const item of Array.isArray(items) ? items : []) {
		const value = sanitizeTextValue(item, maxLength, false);
		if (value) {
			output.push(value);
		}
		if (output.length >= limit) {
			break;
		}
	}
	return output;
}

function sanitizePatch(section, patch) {
	const output = {};
	for (const [field, rules] of Object.entries(SECTION_FIELDS[section])) {
		if (!Object.prototype.hasOwnProperty.call(patch, field)) {
			continue;
		}
		if (rules.enumOf) {
			const values = sanitizeEnumList(patch[field], rules.enumOf, rules.limit);
			if (values.length) {
				output[field] = values;
			}
		} else {
			const value = sanitizeTextValue(patch[field], rules.max, rules.multiline);
			if (value) {
				output[field] = value;
			}
		}
	}
	return output;
}

function validateResponse(rawResponse, section) {
	const response = normalizeBareResponse(rawResponse, section);
	const status = sanitizeKey(response.status || '');
	const returnedSection = sanitizeKey(response.section || '');
	if (!['ready', 'refused'].includes(status)) {
		throw new AiError('invalid_status', 'AI Assist returned an invalid status.');
	}
	if (returnedSection !== section) {
		throw new AiError('invalid_section', 'AI Assist returned a suggestion for the wrong planner section.');
	}
	const patchSource = response.patch && response.patch[section] && typeof response.patch[section] === 'object' ? response.patch[section] : {};
	const patch = sanitizePatch(section, patchSource);
	const validated = {
		status,
		section,
		patch: Object.keys(patch).length ? { [section]: patch } : {},
		rationale: sanitizeStringList(response.rationale, 4, 220),
		warnings: sanitizeStringList(response.warnings, 4, 220)
	};
	if (status === 'ready' && !Object.keys(validated.patch).length) {
		throw new AiError('empty_patch', 'AI Assist did not return any edits to apply.');
	}
	return validated;
}

/** Field → state path map, shared with the browser. */
function getFieldPaths() {
	const output = {};
	for (const [section, fields] of Object.entries(SECTION_FIELDS)) {
		output[section] = {};
		for (const [field, rules] of Object.entries(fields)) {
			output[section][field] = rules.path;
		}
	}
	return output;
}

module.exports = {
	MAX_TEACHER_REQUEST,
	SECTIONS,
	ACTIONS,
	AI_STATE_MAX_BYTES,
	AiError,
	buildContext,
	buildSystemInstructions,
	getResponseSchema,
	generate,
	validateResponse,
	getFieldPaths,
	getInstructionDiagnostics
};
