/*
 * Small helpers for the non-planner pages (My Lesson Plans, Account, Admin).
 * The planner itself lives in lesson-design-ai.js.
 */
(function () {
	'use strict';

	var pageData = {};
	try {
		var dataNode = document.getElementById('ldai-data');
		pageData = dataNode ? JSON.parse(dataNode.textContent || '{}') : {};
	} catch (error) {
		pageData = {};
	}

	function api(method, url, body) {
		return fetch(url, {
			method: method,
			credentials: 'same-origin',
			headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': pageData.csrfToken || '' },
			body: body ? JSON.stringify(body) : undefined
		}).then(function (response) {
			return response.json().catch(function () {
				return { success: false, data: { message: 'The server returned an unexpected response.' } };
			});
		});
	}

	function message(result, fallback) {
		return (result && result.data && result.data.message) || fallback;
	}

	// Local, human-friendly timestamps.
	document.querySelectorAll('[data-local-time]').forEach(function (node) {
		var value = node.getAttribute('datetime');
		var date = value ? new Date(value) : null;
		if (date && !isNaN(date.getTime())) {
			node.textContent = date.toLocaleString();
		}
	});

	// Confirmation before destructive admin actions (inline onsubmit is blocked by CSP).
	document.querySelectorAll('form[data-confirm]').forEach(function (form) {
		form.addEventListener('submit', function (event) {
			if (!window.confirm(form.getAttribute('data-confirm'))) {
				event.preventDefault();
			}
		});
	});

	// Click-to-copy for the one-time access key reveal.
	document.querySelectorAll('[data-copy-text]').forEach(function (node) {
		node.setAttribute('title', 'Click to copy');
		node.addEventListener('click', function () {
			if (navigator.clipboard) {
				navigator.clipboard.writeText(node.textContent.trim()).then(function () {
					node.classList.add('is-copied');
				});
			}
		});
	});

	// My Lesson Plans: delete.
	var plansStatus = document.querySelector('[data-plans-status]');
	document.querySelectorAll('[data-plan-delete]').forEach(function (button) {
		button.addEventListener('click', function () {
			var planId = button.getAttribute('data-plan-delete');
			if (!window.confirm('Delete this lesson plan? This cannot be undone.')) {
				return;
			}
			button.disabled = true;
			api('DELETE', '/api/plans/' + encodeURIComponent(planId)).then(function (result) {
				if (result && result.success) {
					var row = document.querySelector('[data-plan-row="' + planId.replace(/"/g, '') + '"]');
					if (row) {
						row.parentNode.removeChild(row);
					}
					// If the deleted plan is the draft open in this browser, detach it so it isn't re-created.
					try {
						var key = pageData.storageKey || 'lessondesign_ai_state_v1';
						var local = JSON.parse(window.localStorage.getItem(key) || '{}');
						if (local && local.meta && local.meta.serverId === planId) {
							local.meta.serverId = '';
							window.localStorage.setItem(key, JSON.stringify(local));
						}
					} catch (error) {
						// ignore storage errors
					}
					if (plansStatus) {
						plansStatus.textContent = 'Lesson plan deleted.';
					}
				} else {
					button.disabled = false;
					if (plansStatus) {
						plansStatus.textContent = message(result, 'The plan could not be deleted.');
					}
				}
			}).catch(function () {
				button.disabled = false;
				if (plansStatus) {
					plansStatus.textContent = 'Could not reach the server. Please try again.';
				}
			});
		});
	});

	// Account page: redeem access key.
	document.querySelectorAll('[data-ldai-account] [data-access-key-form]').forEach(function (form) {
		var input = form.querySelector('[data-access-key-input]');
		var button = form.querySelector('[data-access-key-redeem]');
		var status = form.querySelector('[data-access-key-status]');
		if (!button) {
			return;
		}
		button.addEventListener('click', function () {
			var key = input ? input.value.trim() : '';
			if (!key) {
				status.textContent = 'Enter an access key first.';
				return;
			}
			button.disabled = true;
			status.textContent = 'Checking key...';
			api('POST', '/api/access-key/redeem', { access_key: key }).then(function (result) {
				if (result && result.success) {
					status.textContent = message(result, 'Access key accepted.') + ' Reloading...';
					window.setTimeout(function () { window.location.reload(); }, 1000);
				} else {
					button.disabled = false;
					status.textContent = message(result, 'That access key could not be redeemed.');
				}
			}).catch(function () {
				button.disabled = false;
				status.textContent = 'Could not reach the server. Please try again.';
			});
		});
	});
})();
