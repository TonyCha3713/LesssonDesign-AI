'use strict';

/**
 * Curriculum data access (port of LDAI_Data_Service + the curriculum helpers
 * in the old plugin). The JSON in /data is the single source of truth: replace
 * or add shards there and update data/curriculum-manifest.json — no code
 * changes are needed.
 */

const fs = require('fs');
const path = require('path');
const { ROOT } = require('../db');
const { isScalar, sanitizeText, sanitizeTextValue, sanitizeUrl, findById } = require('../util');

const DATA_DIR = path.join(ROOT, 'data');
const jsonCache = new Map();

function resolveDataPath(relativePath) {
	const cleaned = String(relativePath || '').replace(/^[/\\]+/, '').replace(/^data[/\\]/, '');
	const resolved = path.resolve(DATA_DIR, cleaned);
	if (!resolved.startsWith(DATA_DIR + path.sep)) {
		return '';
	}
	return resolved;
}

function loadJsonFile(relativePath) {
	const filePath = resolveDataPath(relativePath);
	if (!filePath) {
		return {};
	}
	if (jsonCache.has(filePath)) {
		return jsonCache.get(filePath);
	}
	let decoded = {};
	try {
		decoded = JSON.parse(fs.readFileSync(filePath, 'utf8'));
	} catch (error) {
		decoded = {};
	}
	if (!decoded || typeof decoded !== 'object') {
		decoded = {};
	}
	if (Array.isArray(decoded.standards) && (decoded.defaults || decoded.documents)) {
		decoded = expandCompactShard(decoded);
	}
	jsonCache.set(filePath, decoded);
	return decoded;
}

function expandCompactShard(data) {
	const defaults = data.defaults && typeof data.defaults === 'object' ? data.defaults : {};
	const documents = data.documents && typeof data.documents === 'object' ? data.documents : {};
	return Object.assign({}, data, {
		standards: data.standards
			.filter((standard) => standard && typeof standard === 'object')
			.map((standard) => {
				const documentId = isScalar(standard.sourceDocumentId) ? String(standard.sourceDocumentId) : '';
				const document = documents[documentId] && typeof documents[documentId] === 'object' ? documents[documentId] : {};
				return Object.assign({}, defaults, document, standard);
			})
	});
}

function getSources() {
	return loadJsonFile('curriculum-sources.json');
}

function getManifest() {
	return loadJsonFile('curriculum-manifest.json');
}

function getTrack(trackId) {
	return findById(getSources().curriculumTracks || [], trackId);
}

/** Shards for the selected subject track(s) and grade only (not all 84). */
function getMatchingShards(curriculum) {
	const trackIds = uniq([curriculum.track].concat(Array.isArray(curriculum.tracks) ? curriculum.tracks : []).filter(Boolean));
	const tracks = trackIds.map(getTrack).filter(Boolean);
	if (!tracks.length) {
		return [];
	}
	const grade = String(curriculum.grade || '');
	return (getManifest().shards || []).filter((shard) => {
		const filters = (shard && shard.filters) || {};
		return tracks.some((track) =>
			filters.country === track.country &&
			includes(filters.jurisdictionIds, track.jurisdictionId) &&
			includes(filters.frameworkIds, track.frameworkId) &&
			includes(filters.programIds, track.programId) &&
			(!Array.isArray(filters.subjectIds) || includes(filters.subjectIds, track.subject)) &&
			(!grade || !Array.isArray(filters.gradeLevels) || includes(filters.gradeLevels, grade))
		);
	});
}

function loadStandardsForCurriculum(curriculum) {
	const standards = [];
	const aliases = [];
	for (const shard of getMatchingShards(curriculum)) {
		const data = loadJsonFile(shard.path);
		if (Array.isArray(data.standards)) {
			standards.push(...data.standards);
		}
		if (Array.isArray(data.aliases)) {
			aliases.push(...data.aliases);
		}
	}
	return { standards, aliases };
}

function expandStandardIds(standards, ids, aliases = []) {
	if (!Array.isArray(ids)) {
		return [];
	}
	const aliasMap = new Map();
	const addAlias = (legacyId, canonicalId) => {
		if (!legacyId || !canonicalId || legacyId === canonicalId) {
			return;
		}
		if (!aliasMap.has(legacyId)) {
			aliasMap.set(legacyId, []);
		}
		aliasMap.get(legacyId).push(canonicalId);
	};
	for (const alias of aliases) {
		if (alias && alias.legacyId && alias.canonicalId) {
			addAlias(sanitizeText(String(alias.legacyId)), sanitizeText(String(alias.canonicalId)));
		}
	}
	for (const standard of standards) {
		if (!standard || !isScalar(standard.id)) {
			continue;
		}
		for (const legacyId of Array.isArray(standard.legacyIds) ? standard.legacyIds : []) {
			if (isScalar(legacyId)) {
				addAlias(sanitizeText(String(legacyId)), sanitizeText(String(standard.id)));
			}
		}
	}
	const expanded = [];
	for (const id of ids) {
		if (!isScalar(id)) {
			continue;
		}
		const clean = sanitizeText(String(id));
		if (!clean) {
			continue;
		}
		expanded.push(...(aliasMap.get(clean) || [clean]));
	}
	return uniq(expanded);
}

function getStandardsByIds(standards, ids, aliases = []) {
	const expanded = expandStandardIds(standards, ids, aliases);
	const byId = new Map();
	for (const standard of standards) {
		if (standard && isScalar(standard.id) && String(standard.id)) {
			byId.set(String(standard.id), standard);
		}
	}
	const selected = [];
	for (const id of expanded) {
		const standard = byId.get(id);
		if (standard) {
			selected.push({
				id: sanitizeText(String(standard.id)),
				standardCode: sanitizeText(standard.standardCode || ''),
				moduleLabel: sanitizeText(standard.moduleLabel || ''),
				summaryText: sanitizeTextValue(standard.summaryText || '', 500),
				officialOutcomeText: sanitizeTextValue(standard.officialOutcomeText || standard.summaryText || '', 500),
				curriculumFocus: sanitizeTextValue(standard.curriculumFocus || '', 260),
				gradeLevel: sanitizeText(standard.gradeLevel || ''),
				courseCode: sanitizeText(standard.courseCode || ''),
				courseLabel: sanitizeText(standard.courseLabel || ''),
				documentTitle: sanitizeText(standard.documentTitle || ''),
				documentVersion: sanitizeText(standard.documentVersion || ''),
				sourceUrl: sanitizeUrl(standard.sourceUrl || '')
			});
		}
		if (selected.length >= 40) {
			break;
		}
	}
	return selected;
}

function gradeOrdinal(grade) {
	return String(grade).toLowerCase() === 'k' ? 0 : (parseInt(grade, 10) || 0);
}

function gradeMatches(recordGrade, selectedGrade) {
	if (!recordGrade || !selectedGrade) {
		return false;
	}
	const record = String(recordGrade).toLowerCase();
	const selected = String(selectedGrade).toLowerCase();
	if (record === selected) {
		return true;
	}
	const match = /^(k|\d+)-(\d+)$/.exec(record);
	if (!match) {
		return false;
	}
	const value = gradeOrdinal(selected);
	return value >= gradeOrdinal(match[1]) && value <= parseInt(match[2], 10);
}

function standardMatchesContext(standard, curriculum, trackRecords) {
	if (!gradeMatches(String(standard.gradeLevel || ''), String(curriculum.grade || ''))) {
		return false;
	}
	if (trackRecords.length) {
		return trackRecords.some((track) =>
			String(standard.country || '') === String(track.country || '') &&
			String(standard.jurisdictionId || '') === String(track.jurisdictionId || '') &&
			String(standard.frameworkId || '') === String(track.frameworkId || '') &&
			String(standard.programId || '') === String(track.programId || '') &&
			String(standard.subjectAreaId || '') === String(track.subjectAreaId || '') &&
			String(standard.subject || '') === String(track.subject || '')
		);
	}
	return String(standard.country || '') === String(curriculum.country || '') &&
		String(standard.jurisdictionId || '') === String(curriculum.jurisdiction || '') &&
		(!curriculum.framework || String(standard.frameworkId || '') === curriculum.framework) &&
		(!curriculum.program || String(standard.programId || '') === curriculum.program) &&
		(!curriculum.subjectArea || String(standard.subjectAreaId || '') === curriculum.subjectArea) &&
		String(standard.subject || '') === String(curriculum.subject || '');
}

function getContextualStandardIds(standards, curriculum) {
	const trackIds = uniq([].concat(curriculum.tracks || [], [curriculum.track || '']).filter(Boolean));
	const trackRecords = trackIds.map(getTrack).filter(Boolean);
	if (!curriculum.country || !curriculum.jurisdiction || !curriculum.grade || (!curriculum.subject && !trackRecords.length)) {
		return [];
	}
	return uniq(standards
		.filter((standard) => standard && isScalar(standard.id) && standardMatchesContext(standard, curriculum, trackRecords))
		.map((standard) => sanitizeText(String(standard.id))));
}

function inferTrackId(curriculum) {
	const country = String(curriculum.country || '');
	let jurisdiction = String(curriculum.jurisdiction || '');
	let framework = String(curriculum.framework || '');
	let program = String(curriculum.program || '');
	const subjectArea = String(curriculum.subjectArea || '');
	const subject = String(curriculum.subject || '');
	if (!jurisdiction && country === 'CA') {
		jurisdiction = 'ca-ab';
	}
	if (!framework) {
		framework = jurisdiction === 'ca-ab' ? 'ca-ab-curriculum' : '';
	}
	if (!program) {
		program = country === 'CA' && framework === 'ca-ab-curriculum' ? 'en-core' : '';
	}
	const matches = (getSources().curriculumTracks || []).filter((track) =>
		track && track.id &&
		(!country || track.country === country) &&
		(!jurisdiction || track.jurisdictionId === jurisdiction) &&
		(!framework || track.frameworkId === framework) &&
		(!program || track.programId === program) &&
		(!subjectArea || track.subjectAreaId === subjectArea) &&
		(!subject || track.subject === subject)
	);
	return matches.length === 1 ? String(matches[0].id) : '';
}

function labelFor(items, id) {
	const found = findById(items, id);
	return found ? sanitizeText(found.label || '') : '';
}

function getDataDiagnostics() {
	const files = ['curriculum-sources.json', 'curriculum-manifest.json', 'resources.json'];
	const manifest = getManifest();
	const shards = Array.isArray(manifest.shards) ? manifest.shards : [];
	let missingShards = 0;
	let standardCount = 0;
	for (const shard of shards) {
		standardCount += Number(shard.standardCount || 0);
		const filePath = resolveDataPath(shard.path);
		if (!filePath || !fs.existsSync(filePath)) {
			missingShards += 1;
		}
	}
	return {
		files: files.map((file) => {
			const filePath = resolveDataPath(file);
			const exists = filePath && fs.existsSync(filePath);
			return { path: 'data/' + file, status: exists ? 'readable' : 'missing', bytes: exists ? fs.statSync(filePath).size : 0 };
		}),
		shardCount: shards.length,
		missingShards,
		standardCount
	};
}

function getDataVersion() {
	try {
		return String(Math.floor(fs.statSync(resolveDataPath('curriculum-manifest.json')).mtimeMs));
	} catch (error) {
		return '1';
	}
}

function uniq(items) {
	return Array.from(new Set(items));
}

function includes(list, value) {
	return Array.isArray(list) && list.includes(value);
}

module.exports = {
	DATA_DIR,
	loadJsonFile,
	getSources,
	getManifest,
	getTrack,
	getMatchingShards,
	loadStandardsForCurriculum,
	expandStandardIds,
	getStandardsByIds,
	getContextualStandardIds,
	inferTrackId,
	labelFor,
	gradeMatches,
	getDataDiagnostics,
	getDataVersion
};
