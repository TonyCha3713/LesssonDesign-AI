'use strict';

/**
 * Small text helpers that mirror the WordPress sanitizers the original plugin
 * relied on (sanitize_text_field, sanitize_textarea_field, sanitize_key, ...),
 * so stored data keeps the same shape it had in WordPress.
 */

function isScalar(value) {
	return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function stripTags(value) {
	return String(value)
		.replace(/<(script|style)[^>]*?>[\s\S]*?<\/\1>/gi, '')
		.replace(/<[^>]*>/g, '');
}

function cleanBase(value, keepNewlines) {
	let text = String(value);
	// Invalid UTF-8 can't reach us as a JS string; strip control chars instead.
	text = text.replace(/\r\n?/g, '\n');
	text = stripTags(text);
	text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
	if (keepNewlines) {
		text = text.split('\n').map((line) => line.replace(/[\t ]+/g, ' ').trim()).join('\n');
	} else {
		text = text.replace(/[\r\n\t ]+/g, ' ');
	}
	// Percent-encoded octets are stripped by WordPress' sanitize_text_field.
	text = text.replace(/%[a-f0-9]{2}/gi, '');
	return text.trim();
}

function sanitizeText(value) {
	if (!isScalar(value)) {
		return '';
	}
	return cleanBase(value, false);
}

function sanitizeTextarea(value) {
	if (!isScalar(value)) {
		return '';
	}
	return cleanBase(value, true);
}

function sanitizeKey(value) {
	if (!isScalar(value)) {
		return '';
	}
	return String(value).toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

/** Port of LDAI_Plugin::sanitize_ai_text_value(). */
function sanitizeTextValue(value, maxLength = 1000, multiline = true) {
	if (!isScalar(value)) {
		return '';
	}
	let text = multiline ? sanitizeTextarea(value) : sanitizeText(String(value).replace(/\s+/g, ' '));
	if (!text) {
		return '';
	}
	text = Array.from(text).slice(0, maxLength).join('');
	return text.trim();
}

function sanitizeUrl(value) {
	if (!isScalar(value)) {
		return '';
	}
	const text = String(value).trim();
	if (!text) {
		return '';
	}
	try {
		const url = new URL(text);
		return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
	} catch (error) {
		return '';
	}
}

function sanitizeStringList(items, limit, maxLength) {
	const output = [];
	for (const item of Array.isArray(items) ? items : []) {
		if (!isScalar(item)) {
			continue;
		}
		const value = sanitizeTextValue(String(item), maxLength, false);
		if (value && !output.includes(value)) {
			output.push(value);
		}
		if (output.length >= limit) {
			break;
		}
	}
	return output;
}

function sanitizeEnumList(items, allowedValues, limit) {
	const output = [];
	for (const item of Array.isArray(items) ? items : []) {
		if (!isScalar(item)) {
			continue;
		}
		const value = sanitizeText(String(item));
		if (!value || !allowedValues.includes(value) || output.includes(value)) {
			continue;
		}
		output.push(value);
		if (output.length >= limit) {
			break;
		}
	}
	return output;
}

function sanitizeKnownIdList(items, allowedIds, limit) {
	const allowed = allowedIds instanceof Set ? allowedIds : new Set(allowedIds);
	const output = [];
	for (const item of Array.isArray(items) ? items : []) {
		if (!isScalar(item)) {
			continue;
		}
		const id = sanitizeText(String(item));
		if (!id || !allowed.has(id) || output.includes(id)) {
			continue;
		}
		output.push(id);
		if (output.length >= limit) {
			break;
		}
	}
	return output;
}

function getAllowedIds(items) {
	const ids = [];
	for (const item of Array.isArray(items) ? items : []) {
		if (item && isScalar(item.id)) {
			const id = sanitizeText(String(item.id));
			if (id && !ids.includes(id)) {
				ids.push(id);
			}
		}
	}
	return ids;
}

function findById(items, id) {
	if (!id) {
		return null;
	}
	for (const item of Array.isArray(items) ? items : []) {
		if (item && isScalar(item.id) && String(item.id) === String(id)) {
			return item;
		}
	}
	return null;
}

function pruneEmpty(value) {
	if (Array.isArray(value)) {
		return value.map(pruneEmpty).filter((item) => !(item === '' || item === null || item === undefined || (Array.isArray(item) && !item.length) || (isPlainObject(item) && !Object.keys(item).length)));
	}
	if (isPlainObject(value)) {
		const output = {};
		for (const [key, item] of Object.entries(value)) {
			const pruned = pruneEmpty(item);
			if (pruned === '' || pruned === null || pruned === undefined) {
				continue;
			}
			if (Array.isArray(pruned) && !pruned.length) {
				continue;
			}
			if (isPlainObject(pruned) && !Object.keys(pruned).length) {
				continue;
			}
			output[key] = pruned;
		}
		return output;
	}
	return value;
}

function isPlainObject(value) {
	return Object.prototype.toString.call(value) === '[object Object]';
}

function asObject(value) {
	return isPlainObject(value) ? value : {};
}

module.exports = {
	isScalar,
	isPlainObject,
	asObject,
	sanitizeText,
	sanitizeTextarea,
	sanitizeKey,
	sanitizeTextValue,
	sanitizeUrl,
	sanitizeStringList,
	sanitizeEnumList,
	sanitizeKnownIdList,
	getAllowedIds,
	findById,
	pruneEmpty
};
