'use strict';

/**
 * Site settings. Values can come from (highest priority first):
 *   1. environment variables / .env   (recommended for API keys)
 *   2. the admin panel (stored in the settings table)
 *   3. the defaults below
 * This mirrors get_config_value() in the WordPress plugin (constants → env → options).
 */

const { getSetting, setSetting } = require('../db');

const PROVIDER_GEMINI = 'gemini';
const PROVIDER_AZURE = 'azure_openai';
const SUPPORTED_PROVIDERS = [PROVIDER_AZURE, PROVIDER_GEMINI];
const PROVIDER_LABELS = {
	[PROVIDER_AZURE]: 'Microsoft Azure OpenAI',
	[PROVIDER_GEMINI]: 'Google Gemini'
};
const PROVIDER_ORDER_OPTIONS = {
	'azure_openai,gemini': 'Azure first, Gemini fallback',
	'gemini,azure_openai': 'Gemini first, Azure fallback',
	azure_openai: 'Azure only',
	gemini: 'Gemini only'
};

/** key → { env: [...names], def: default, secret?: bool } */
const DEFINITIONS = {
	ai_enabled: { env: ['LDAI_AI_ENABLED'], def: '1' },
	ai_provider_order_guest: { env: ['LDAI_AI_PROVIDER_ORDER_GUEST'], def: 'gemini,azure_openai' },
	ai_provider_order_user: { env: ['LDAI_AI_PROVIDER_ORDER_USER'], def: 'gemini,azure_openai' },
	ai_daily_limit_guest: { env: ['LDAI_AI_DAILY_LIMIT_GUEST'], def: '0' },
	ai_daily_limit_user: { env: ['LDAI_AI_DAILY_LIMIT_USER'], def: '20' },
	gemini_model: { env: ['LDAI_GEMINI_MODEL', 'GEMINI_MODEL'], def: 'gemini-3.5-flash' },
	gemini_api_key: { env: ['LDAI_GEMINI_API_KEY', 'GEMINI_API_KEY'], def: '', secret: true },
	azure_openai_endpoint: { env: ['LDAI_AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_ENDPOINT'], def: '' },
	azure_openai_deployment: { env: ['LDAI_AZURE_OPENAI_DEPLOYMENT', 'AZURE_OPENAI_DEPLOYMENT'], def: '' },
	azure_openai_api_version: { env: ['LDAI_AZURE_OPENAI_API_VERSION', 'AZURE_OPENAI_API_VERSION'], def: '2024-10-21' },
	azure_openai_api_key: { env: ['LDAI_AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY'], def: '', secret: true },
	registration_enabled: { env: ['LDAI_REGISTRATION_ENABLED'], def: '1' },
	guest_ai_requires_login: { env: [], def: '0' }
};

function envValue(key) {
	const definition = DEFINITIONS[key];
	for (const name of (definition && definition.env) || []) {
		const value = process.env[name];
		if (typeof value === 'string' && value.trim() !== '') {
			return value.trim();
		}
	}
	return '';
}

function get(key) {
	const fromEnv = envValue(key);
	if (fromEnv) {
		return fromEnv;
	}
	const stored = getSetting(key, '');
	if (stored.trim() !== '') {
		return stored.trim();
	}
	return DEFINITIONS[key] ? DEFINITIONS[key].def : '';
}

function isFromEnv(key) {
	return envValue(key) !== '';
}

function set(key, value) {
	if (!DEFINITIONS[key]) {
		return;
	}
	setSetting(key, value);
}

function getBool(key) {
	return ['1', 'true', 'yes', 'on'].includes(String(get(key)).toLowerCase());
}

function getInt(key) {
	return Math.max(0, parseInt(get(key), 10) || 0);
}

function normalizeProviderOrder(value) {
	const raw = Array.isArray(value) ? value : String(value || '').split(/[,|]+/);
	const providers = [];
	for (const item of raw) {
		const provider = String(item || '').trim().toLowerCase();
		if (SUPPORTED_PROVIDERS.includes(provider) && !providers.includes(provider)) {
			providers.push(provider);
		}
	}
	return providers.length ? providers : [PROVIDER_AZURE];
}

function normalizeAzureEndpoint(value) {
	const text = String(value || '').trim().replace(/\/+$/, '');
	return /^https:\/\//i.test(text) ? text : '';
}

function normalizeAzureApiVersion(value) {
	const text = String(value || '').trim();
	return /^\d{4}-\d{2}-\d{2}(?:-preview)?$/.test(text) ? text : '2024-10-21';
}

function getGeminiModel() {
	return get('gemini_model').replace(/^models\//, '');
}

function getAzureConfig() {
	return {
		endpoint: normalizeAzureEndpoint(get('azure_openai_endpoint')),
		deployment: get('azure_openai_deployment'),
		apiVersion: normalizeAzureApiVersion(get('azure_openai_api_version')),
		apiKey: get('azure_openai_api_key')
	};
}

function hasProviderConfig(provider) {
	if (provider === PROVIDER_GEMINI) {
		return !!getGeminiModel() && !!get('gemini_api_key');
	}
	if (provider === PROVIDER_AZURE) {
		const azure = getAzureConfig();
		return !!azure.endpoint && !!azure.deployment && !!azure.apiKey;
	}
	return false;
}

function getProviderOrder(isLoggedIn) {
	return normalizeProviderOrder(get(isLoggedIn ? 'ai_provider_order_user' : 'ai_provider_order_guest'));
}

function getAiSettings(isLoggedIn) {
	const order = getProviderOrder(isLoggedIn);
	const configured = order.filter(hasProviderConfig);
	const provider = order[0] || PROVIDER_AZURE;
	const enabled = getBool('ai_enabled');
	return {
		enabled,
		available: enabled && configured.length > 0,
		provider,
		providerOrder: order,
		providerOrderLabel: order.map((id) => PROVIDER_LABELS[id]).join(' -> '),
		configuredProviders: configured,
		model: provider === PROVIDER_GEMINI ? getGeminiModel() : getAzureConfig().deployment,
		guestDailyLimit: getInt('ai_daily_limit_guest'),
		userDailyLimit: getInt('ai_daily_limit_user')
	};
}

module.exports = {
	PROVIDER_GEMINI,
	PROVIDER_AZURE,
	PROVIDER_LABELS,
	PROVIDER_ORDER_OPTIONS,
	DEFINITIONS,
	get,
	set,
	getBool,
	getInt,
	isFromEnv,
	normalizeProviderOrder,
	normalizeAzureEndpoint,
	normalizeAzureApiVersion,
	getGeminiModel,
	getAzureConfig,
	hasProviderConfig,
	getProviderOrder,
	getAiSettings
};
