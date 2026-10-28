'use strict';

/**
 * Learning Connections (dHL experts + virtual tours).
 *
 * Resources added in the admin panel (stored in SQLite) are searched first;
 * the bundled sample in data/resources.json is used as a fallback, exactly like
 * the WordPress "LessonDesign Resources" post type + bundled library did.
 */

const { db, nowIso } = require('../db');
const curriculum = require('./curriculum');
const { isScalar, sanitizeText, sanitizeKey, sanitizeTextValue, sanitizeUrl, sanitizeStringList } = require('../util');

const DEFAULT_PER_PAGE = 8;
const MAX_PER_PAGE = 24;
const SELECTED_LIMIT = 20;
const SITE_ID_PREFIX = 'site-resource-';

/**
 * Maps a curriculum subject area to the subject vocabulary used on dHL
 * resources, so guided suggestions can match even when the names differ.
 * Edit freely as the resource library grows.
 */
const SUBJECT_AREA_RESOURCE_SUBJECTS = {
	'science-technology': ['Science and Technology', 'Science'],
	mathematics: ['Mathematics'],
	'language-arts-english': ['Language'],
	'language-arts-francais': ['Language', 'French'],
	'language-arts-french-immersion': ['Language', 'French'],
	'career-technology': ['Career and Technology', 'Technological Education', 'Science and Technology'],
	'fine-arts': ['The Arts', 'Arts'],
	'health-life-skills': ['Health and Physical Education', 'Health'],
	'social-studies': ['Social Studies', 'History', 'Geography'],
	'physical-education': ['Health and Physical Education', 'Physical Education'],
	'environmental-outdoor-education': ['Science and Technology', 'Environment']
};

let bundledCache = null;

/* ---- normalizers ------------------------------------------------------- */

function normalizeKind(kind) {
	const value = sanitizeKey(kind);
	return ['expert', 'experts', 'speaker', 'guest-speaker'].includes(value) ? 'expert' : 'tour';
}

function normalizeBundled(resource) {
	const item = resource && typeof resource === 'object' ? resource : {};
	return {
		id: sanitizeText(String(item.id || '')),
		source: 'bundled',
		kind: normalizeKind(item.kind),
		title: sanitizeTextValue(item.title || '', 180, false),
		summary: sanitizeTextValue(item.summary || '', 420),
		subjects: sanitizeStringList(item.subjects, 8, 80),
		gradeBands: sanitizeStringList(item.gradeBands, 6, 40),
		format: sanitizeTextValue(item.format || '', 80, false),
		duration: sanitizeTextValue(item.duration || '', 80, false),
		cost: sanitizeTextValue(item.cost || '', 80, false),
		tags: sanitizeStringList(item.tags, 16, 80),
		url: sanitizeUrl(item.url || ''),
		sourceId: sanitizeText(String(item.sourceId || ''))
	};
}

function parseList(json) {
	try {
		const value = JSON.parse(json || '[]');
		return Array.isArray(value) ? value : [];
	} catch (error) {
		return [];
	}
}

function rowToResource(row) {
	return {
		id: SITE_ID_PREFIX + row.id,
		dbId: row.id,
		source: 'site',
		kind: normalizeKind(row.kind),
		title: row.title,
		summary: row.summary,
		subjects: parseList(row.subjects),
		gradeBands: parseList(row.grade_bands),
		format: row.format,
		duration: row.duration,
		cost: row.cost,
		tags: parseList(row.tags),
		url: row.url,
		sourceId: row.source_id,
		published: !!row.published,
		updatedAt: row.updated_at
	};
}

function getBundled() {
	if (!bundledCache) {
		const payload = curriculum.loadJsonFile('resources.json');
		bundledCache = []
			.concat(payload.experts || [], payload.tours || [])
			.map(normalizeBundled)
			.filter((item) => item.id);
	}
	return bundledCache;
}

function getSiteResources() {
	return db.prepare('SELECT * FROM resources WHERE published = 1 ORDER BY updated_at DESC LIMIT 500').all().map(rowToResource);
}

function getIndex() {
	const index = new Map();
	for (const item of getSiteResources().concat(getBundled())) {
		index.set(item.id, item);
	}
	return index;
}

function getAllowedResourceIds() {
	return new Set(getIndex().keys());
}

/* ---- search + ranking -------------------------------------------------- */

function normalizeSearchText(value) {
	return sanitizeText(isScalar(value) ? String(value) : '')
		.toLowerCase()
		.replace(/[^a-z0-9\s]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function tokenize(text) {
	if (!text) {
		return [];
	}
	return Array.from(new Set(text.split(' '))).filter((token) => token.length > 1);
}

function resourceSearchText(resource) {
	return normalizeSearchText([
		resource.title,
		resource.summary,
		(resource.subjects || []).join(' '),
		(resource.gradeBands || []).join(' '),
		(resource.tags || []).join(' '),
		resource.format,
		resource.duration
	].join(' '));
}

function gradeToBand(grade) {
	if (!grade) {
		return '';
	}
	if (String(grade).toLowerCase() === 'k') {
		return 'Primary';
	}
	const number = parseInt(grade, 10) || 0;
	if (number <= 3) {
		return 'Primary';
	}
	if (number <= 6) {
		return 'Junior';
	}
	return number >= 9 ? 'Senior' : 'Intermediate';
}

function getTrackContext(trackId) {
	const sources = curriculum.getSources();
	const track = curriculum.getTrack(trackId);
	if (!track) {
		return { subjectLabel: '', subjectVocabulary: [] };
	}
	const subjectLabel = curriculum.labelFor(sources.subjects || [], track.subject);
	const vocabulary = [subjectLabel].concat(SUBJECT_AREA_RESOURCE_SUBJECTS[track.subjectAreaId] || []).filter(Boolean);
	return { subjectLabel, subjectVocabulary: Array.from(new Set(vocabulary.map(normalizeSearchText))) };
}

function normalizeQuery(args) {
	const type = sanitizeKey(args.type || 'all');
	let perPage = parseInt(args.per_page, 10) || DEFAULT_PER_PAGE;
	perPage = Math.min(MAX_PER_PAGE, Math.max(1, perPage));
	let selected = args.selected_ids;
	if (typeof selected === 'string') {
		try {
			selected = JSON.parse(selected);
		} catch (error) {
			selected = selected.split(',');
		}
	}
	let keywords = args.keywords;
	if (typeof keywords === 'string') {
		keywords = keywords.split(/[\s,]+/);
	}
	return {
		mode: sanitizeKey(args.mode) === 'browse' ? 'browse' : 'guided',
		query: normalizeSearchText(args.query || ''),
		type: ['all', 'expert', 'tour'].includes(type) ? type : 'all',
		track: sanitizeText(args.track || ''),
		grade: sanitizeText(args.grade || ''),
		page: Math.max(1, parseInt(args.page, 10) || 1),
		perPage,
		selectedIds: Array.from(new Set((Array.isArray(selected) ? selected : []).filter(isScalar).map((id) => sanitizeText(String(id))).filter(Boolean))).slice(0, SELECTED_LIMIT),
		// Lesson-draft keywords (title, prompt, goals, success criteria, selected
		// curriculum). Guided mode uses them so Connections benefits from what the
		// teacher already wrote in Foundation and Learning Targets.
		keywords: Array.from(new Set((Array.isArray(keywords) ? keywords : []).filter(isScalar).map((word) => normalizeSearchText(String(word))).filter((word) => word.length > 3))).slice(0, 40)
	};
}

function rank(resources, query, sourcePriority) {
	const { subjectLabel, subjectVocabulary } = getTrackContext(query.track);
	const gradeBand = gradeToBand(query.grade);
	const queryTokens = tokenize(query.query);
	const ranked = [];

	for (const resource of resources) {
		if (!resource || !resource.id) {
			continue;
		}
		if (query.type !== 'all' && resource.kind !== query.type) {
			continue;
		}
		const haystack = resourceSearchText(resource);
		if (queryTokens.length && !queryTokens.some((token) => haystack.includes(token))) {
			continue;
		}
		let score = 0;
		const reasons = [];
		const resourceSubjects = (resource.subjects || []).map(normalizeSearchText);

		if (subjectVocabulary.length && resourceSubjects.some((subject) => subjectVocabulary.includes(subject))) {
			score += 4;
			reasons.push(subjectLabel || 'Subject');
		}
		if (gradeBand && (resource.gradeBands || []).some((band) => normalizeSearchText(band) === normalizeSearchText(gradeBand))) {
			score += 2;
			reasons.push(gradeBand + ' Learners');
		}
		const keywordMatches = queryTokens.filter((token) => haystack.includes(token)).length;
		if (keywordMatches) {
			score += Math.min(3, keywordMatches);
		}
		if (query.mode === 'guided' && query.keywords.length) {
			const draftMatches = query.keywords.filter((word) => haystack.includes(word));
			if (draftMatches.length) {
				score += Math.min(3, draftMatches.length);
				reasons.push('Lesson keywords: ' + draftMatches.slice(0, 3).join(', '));
			}
		}
		if (query.mode === 'guided' && !query.query && score < 1) {
			continue;
		}
		ranked.push({ resource, score, keywordMatches, reasons: Array.from(new Set(reasons)), sourcePriority });
	}
	return ranked;
}

function formatCard(resource) {
	return {
		id: resource.id,
		source: resource.source,
		kind: resource.kind,
		title: resource.title,
		summary: resource.summary,
		subjects: (resource.subjects || []).slice(0, 8),
		gradeBands: (resource.gradeBands || []).slice(0, 6),
		format: resource.format,
		duration: resource.duration,
		cost: resource.cost,
		url: resource.url,
		sourceId: resource.sourceId
	};
}

function getFilteredPayload(args) {
	const query = normalizeQuery(args);
	const site = getSiteResources();
	const offset = (query.page - 1) * query.perPage;
	let combined = rank(site, query, 0);
	let bundledLoaded = false;
	const siteIds = new Set(site.map((item) => item.id));

	if (combined.length < offset + query.perPage || query.selectedIds.some((id) => !siteIds.has(id))) {
		bundledLoaded = true;
		combined = combined.concat(rank(getBundled(), query, 1));
	}

	combined.sort((left, right) => {
		if (query.mode === 'guided' && right.score !== left.score) {
			return right.score - left.score;
		}
		if (left.sourcePriority !== right.sourcePriority) {
			return left.sourcePriority - right.sourcePriority;
		}
		return String(left.resource.title).localeCompare(String(right.resource.title), undefined, { sensitivity: 'base' });
	});

	const results = combined.slice(offset, offset + query.perPage);
	return {
		results: results.map((entry) => Object.assign(formatCard(entry.resource), {
			matchScore: entry.score,
			matchKeywordMatches: entry.keywordMatches,
			matchReasons: entry.reasons
		})),
		selected: getCardsByIds(query.selectedIds, SELECTED_LIMIT),
		total: combined.length,
		hasMore: offset + results.length < combined.length,
		metadata: {
			mode: query.mode,
			query: query.query,
			type: query.type,
			track: query.track,
			grade: query.grade,
			page: query.page,
			perPage: query.perPage,
			siteCount: site.length,
			bundledLoaded,
			selectedCount: query.selectedIds.length,
			updated: nowIso()
		}
	};
}

function getCardsByIds(ids, limit) {
	const index = getIndex();
	const output = [];
	for (const id of ids) {
		const item = index.get(id);
		if (item) {
			output.push(formatCard(item));
		}
		if (output.length >= limit) {
			break;
		}
	}
	return output;
}

/** Compact records for the AI prompt (port of get_resources_by_ids). */
function getResourcesByIds(ids, limit = 6) {
	const index = getIndex();
	const output = [];
	for (const raw of Array.isArray(ids) ? ids : []) {
		if (!isScalar(raw)) {
			continue;
		}
		const item = index.get(sanitizeText(String(raw)));
		if (item) {
			output.push(item);
		}
		if (output.length >= limit) {
			break;
		}
	}
	return output;
}

/* ---- admin CRUD ------------------------------------------------------- */

function listAll() {
	return db.prepare('SELECT * FROM resources ORDER BY updated_at DESC').all().map(rowToResource);
}

function getById(dbId) {
	const row = db.prepare('SELECT * FROM resources WHERE id = ?').get(dbId);
	return row ? rowToResource(row) : null;
}

function splitList(value, limit, maxLength) {
	const items = Array.isArray(value) ? value : String(value || '').split(/[,\n]+/);
	return sanitizeStringList(items.map((item) => String(item).trim()), limit, maxLength);
}

function sanitizeInput(input) {
	return {
		kind: normalizeKind(input.kind),
		title: sanitizeTextValue(input.title || '', 180, false),
		summary: sanitizeTextValue(input.summary || '', 420),
		subjects: JSON.stringify(splitList(input.subjects, 8, 80)),
		grade_bands: JSON.stringify(splitList(input.gradeBands, 6, 40)),
		tags: JSON.stringify(splitList(input.tags, 16, 80)),
		format: sanitizeTextValue(input.format || '', 80, false),
		duration: sanitizeTextValue(input.duration || '', 80, false),
		cost: sanitizeTextValue(input.cost || '', 80, false),
		url: sanitizeUrl(input.url || ''),
		source_id: sanitizeText(input.sourceId || ''),
		published: input.published ? 1 : 0
	};
}

function save(dbId, input) {
	const data = sanitizeInput(input);
	if (!data.title) {
		throw new Error('A title is required.');
	}
	if (dbId) {
		db.prepare(`UPDATE resources SET kind=@kind, title=@title, summary=@summary, subjects=@subjects, grade_bands=@grade_bands,
			tags=@tags, format=@format, duration=@duration, cost=@cost, url=@url, source_id=@source_id, published=@published,
			updated_at=@updated_at WHERE id=@id`).run(Object.assign(data, { id: dbId, updated_at: nowIso() }));
		return dbId;
	}
	const result = db.prepare(`INSERT INTO resources (kind, title, summary, subjects, grade_bands, tags, format, duration, cost, url, source_id, published, updated_at)
		VALUES (@kind, @title, @summary, @subjects, @grade_bands, @tags, @format, @duration, @cost, @url, @source_id, @published, @updated_at)`)
		.run(Object.assign(data, { updated_at: nowIso() }));
	return Number(result.lastInsertRowid);
}

function remove(dbId) {
	db.prepare('DELETE FROM resources WHERE id = ?').run(dbId);
}

module.exports = {
	DEFAULT_PER_PAGE,
	getFilteredPayload,
	getAllowedResourceIds,
	getResourcesByIds,
	getBundled,
	listAll,
	getById,
	save,
	remove
};
