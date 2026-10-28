(function () {
	'use strict';

	// Page configuration is rendered by the server into <script type="application/json" id="ldai-data">
	// (see views/planner.ejs and buildPlannerData() in server/routes/pages.js).
	var appData = readAppData();
	var defaults = appData.defaults || {};
	var storageKey = appData.storageKey || 'lessondesign_ai_state_v1';
	var strings = appData.strings || {};
	var aiConfig = appData.ai || {};
	var curriculumSourcesData = {};
	var curriculumManifestData = {};
	var curriculumStandardsData = {};
	var curriculumData = {};
	var resourceData = {};
	var dataLoadError = '';
	var loadedCurriculumShards = {};
	var loadingCurriculumShards = {};
	var resourcesLoaded = false;
	var resourcesLoading = false;
	var resourcesLoadPromise = null;
	var resourceActiveQueryKey = '';
	var resourcePagesByKey = {};
	var resourceRemoteResults = [];
	var resourceRemoteSelected = [];
	var resourceRemoteTotal = 0;
	var resourceRequestSerial = 0;
	var resourceLoadErrors = {};
	var standardById = {};
	var curriculumTrackById = {};
	var resourceById = {};
	var labelCache = {};
	var matchingStandardsCache = {};
	var aiResponseCache = [];
	var ALBERTA_COUNTRY_ID = 'CA';
	var ALBERTA_JURISDICTION_ID = 'ca-ab';
	var ALBERTA_FRAMEWORK_ID = 'ca-ab-curriculum';
	var ALBERTA_PROGRAM_ID = 'en-core';
	var ALBERTA_GRADE_IDS = ['7', '8', '9'];
	var RESOURCE_INITIAL_LIMIT = 8;
	var RESOURCE_LIMIT_INCREMENT = 8;
	var RESOURCE_MAX_VISIBLE = 24;
	var AI_CACHE_TTL_MS = 10 * 60 * 1000;
	var AI_CACHE_MAX_ENTRIES = 6;
	var plannerScrollFrame = null;
	var stopWords = [
		'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'will',
		'have', 'about', 'them', 'they', 'what', 'when', 'where', 'which', 'their',
		'lesson', 'students', 'student', 'teacher', 'using'
	];
	var stepDefinitions = [
		{ id: 'welcome', label: 'Welcome' },
		{ id: 'foundation', label: 'Foundation' },
		{ id: 'targets', label: 'Learning Targets & Assessment' },
		{ id: 'connections', label: 'Connections' },
		{ id: 'design', label: 'Design' },
		{ id: 'ready', label: 'Ready' }
	];
	var aiFieldLabels = {
		foundation: {
			title: 'Lesson Title',
			prompt: 'Big Idea Or Prompt',
			overview: 'Lesson Overview',
			learnerContext: 'Learner Context'
		},
		targets: {
			learningGoals: 'Learning Goals',
			successCriteria: 'Success Criteria',
			formativeAssessment: 'Formative Assessment',
			summativeAssessment: 'Summative Assessment',
			transferableSkills: 'Transferable Skills'
		},
		design: {
			differentiation: 'Differentiation And Accessibility',
			crrpChecks: 'Culturally Relevant And Responsive Pedagogy (CRRP)',
			learningActivities: 'Learning Activities & Instructional Strategies',
			materials: 'Materials',
			technology: 'Technology',
			teacherNotes: 'Additional Notes'
		}
	};

	var aiFieldPaths = aiConfig.fieldPaths || {
		foundation: { title: 'foundation.title', prompt: 'foundation.prompt', overview: 'foundation.overview', learnerContext: 'foundation.learnerContext' },
		targets: { learningGoals: 'foundation.learningGoals', successCriteria: 'foundation.successCriteria', formativeAssessment: 'foundation.formativeAssessment', summativeAssessment: 'foundation.summativeAssessment', transferableSkills: 'design.transferableSkills' },
		design: { differentiation: 'design.differentiation', crrpChecks: 'design.crrpChecks', learningActivities: 'design.learningActivities', materials: 'design.materials', technology: 'design.technology', teacherNotes: 'design.teacherNotes' }
	};

	/*
	 * Section registry. Each editable block in the wizard has a stable
	 * data-section id in the markup. Review checklist "Fix" links resolve a
	 * section to whichever step currently contains it (by looking it up in the
	 * DOM), so reordering steps never requires renumbering links.
	 */
	var SECTION_IDS = {
		lessonIdea: 'lesson-idea',
		curriculum: 'curriculum',
		learningObjectives: 'learning-objectives',
		assessment: 'assessment',
		transferableSkills: 'transferable-skills',
		connections: 'connections',
		learnerSupport: 'learner-support',
		learningSequence: 'learning-sequence',
		reviewExport: 'review-export'
	};

	/*
	 * Draft step-pointer migration. Builds before the reorder used this step
	 * order (index = position). A pointer saved by such a build is mapped to the
	 * step that now owns that content; anything unknown reopens at Foundation.
	 */
	var LEGACY_STEP_ORDER = ['welcome', 'foundation', 'curriculum', 'connections', 'design', 'ready'];

	function readAppData() {
		var node = document.getElementById('ldai-data');
		if (node) {
			try {
				return JSON.parse(node.textContent || '{}');
			} catch (error) {
				return {};
			}
		}
		return window.LessonDesignAIData || {};
	}

	/**
	 * JSON request to the LessonDesign server. Resolves with the parsed
	 * { success, data } body (also for HTTP errors) and rejects only when the
	 * server can't be reached at all, with error.isNetworkError = true.
	 */
	function apiRequest(method, path, body) {
		var url = (appData.apiBase || '/api') + path;
		return fetch(url, {
			method: method,
			credentials: 'same-origin',
			headers: {
				'Content-Type': 'application/json',
				'X-CSRF-Token': appData.csrfToken || ''
			},
			body: body === undefined ? undefined : JSON.stringify(body)
		}).catch(function () {
			var error = new Error(strings.aiNetworkFailed || 'Could not reach the LessonDesign server. Check your connection and try again.');
			error.isNetworkError = true;
			throw error;
		}).then(function (response) {
			return response.text().then(function (text) {
				var parsed = null;
				try {
					parsed = text ? JSON.parse(text) : null;
				} catch (error) {
					parsed = null;
				}
				if (!parsed || typeof parsed !== 'object') {
					parsed = { success: false, data: { message: 'The server returned an unexpected response (HTTP ' + response.status + ').' } };
				}
				parsed.httpStatus = response.status;
				return parsed;
			});
		});
	}

	function hasAccountAccess() {
		return !!appData.isLoggedIn && appData.hasAccountAccess !== false;
	}

	applyPlannerData(appData.curriculumSources || {}, appData.curriculumStandards || {}, appData.curriculum || {}, appData.resources || {}, appData.curriculumManifest || {});

	document.addEventListener('DOMContentLoaded', function () {
		var plannerRoots = Array.prototype.slice.call(document.querySelectorAll('[data-ldai-root]'));

		if (!plannerRoots.length) {
			return;
		}

		setPlannerDataStatus(plannerRoots, strings.dataLoading || 'Loading LessonDesign AI...', true);
		loadPlannerData()
			.catch(function () {
				dataLoadError = strings.dataLoadFailed || 'LessonDesign AI could not load its planner data. Refresh the page, then contact an administrator if the problem continues.';
				applyPlannerData({}, {}, {}, {});
			})
			.then(function () {
				plannerRoots.forEach(function (root) {
					root.classList.remove('is-data-loading');
					root.classList.toggle('is-data-error', !!dataLoadError);
					initPlanner(root);
				});
			});
	});

	function loadPlannerData() {
		var urls = appData.dataUrls || {};

		if (!urls.curriculumSources || !(urls.curriculumManifest || urls.curriculumStandards)) {
			return Promise.resolve();
		}

		return Promise.all([
			fetchPlannerJson(urls.curriculumSources),
			urls.curriculumManifest ? fetchPlannerJson(urls.curriculumManifest) : fetchPlannerJson(urls.curriculumStandards)
		]).then(function (responses) {
			var manifestMode = !!urls.curriculumManifest;
			applyPlannerData(responses[0], manifestMode ? {} : responses[1], {}, {}, manifestMode ? responses[1] : {});
			dataLoadError = '';
		});
	}

	function fetchPlannerJson(url) {
		return fetch(url, { credentials: 'same-origin' }).then(function (response) {
			if (!response.ok) {
				throw new Error('Data request failed.');
			}
			return response.json();
		});
	}

	function applyPlannerData(sources, standards, fallbackCurriculum, resources, manifest) {
		curriculumSourcesData = sources && typeof sources === 'object' ? sources : {};
		curriculumManifestData = manifest && typeof manifest === 'object' ? manifest : {};
		curriculumStandardsData = standards && typeof standards === 'object' ? standards : {};
		curriculumData = fallbackCurriculum && typeof fallbackCurriculum === 'object' ? fallbackCurriculum : {};
		labelCache = {};
		applyResourceData(resources);
		rebuildCurriculumIndexes();
	}

	function applyResourceData(resources) {
		resourceData = resources && typeof resources === 'object' ? resources : {};
		resourceById = {};
		[]
			.concat(resourceData.experts || [])
			.concat(resourceData.tours || [])
			.forEach(function (item) {
			addResourceToIndex(item);
		});
		resourcesLoaded = Object.keys(resourceById).length > 0;
	}

	function addResourceToIndex(item) {
		if (!item || !item.id) {
			return;
		}
		resourceById[item.id] = item;
	}

	function buildResourceQuery(rootState, page, perPage, queryValue, typeValue) {
		var curriculum = rootState.curriculum || {};
		var connections = rootState.connections || {};
		var mode = connections.mode || 'guided';

		return {
			mode: mode,
			// Guided mode ranks with the draft's own words (lesson idea, goals,
			// success criteria, selected curriculum) so Connections benefits from
			// everything written in Foundation and Learning Targets.
			keywords: mode === 'guided' ? buildKeywordSet(rootState).slice(0, 30) : [],
			query: queryValue || '',
			type: typeValue || 'all',
			track: curriculum.track || '',
			grade: curriculum.grade || '',
			selected_ids: (rootState.selectedResources || []).slice(0, 20),
			page: page || 1,
			per_page: perPage || RESOURCE_INITIAL_LIMIT
		};
	}

	function getResourceBaseQueryKey(query) {
		return [
			query.mode,
			normalizeText(query.query),
			query.type,
			query.track,
			query.grade,
			query.per_page,
			(query.selected_ids || []).join(','),
			(query.keywords || []).join(',')
		].join('|');
	}

	function applyResourcePage(query, payload) {
		var baseKey = getResourceBaseQueryKey(query);
		var pages;

		if (!payload || typeof payload !== 'object') {
			return;
		}

		resourcePagesByKey[baseKey] = resourcePagesByKey[baseKey] || {};
		resourcePagesByKey[baseKey][query.page] = payload;
		resourceActiveQueryKey = baseKey;
		pages = resourcePagesByKey[baseKey];
		resourceRemoteResults = Object.keys(pages).map(Number).sort(function (left, right) {
			return left - right;
		}).reduce(function (items, pageNumber) {
			return items.concat(pages[pageNumber].results || []);
		}, []);
		resourceRemoteSelected = payload.selected || resourceRemoteSelected || [];
		resourceRemoteTotal = Number(payload.total || resourceRemoteResults.length || 0);
		resourcesLoaded = true;

		resourceRemoteResults.concat(resourceRemoteSelected || []).forEach(addResourceToIndex);
	}

	function fetchResourcePage(query, onLoaded) {
		var urls = appData.dataUrls || {};
		var baseKey = getResourceBaseQueryKey(query);
		var cached = resourcePagesByKey[baseKey] && resourcePagesByKey[baseKey][query.page];
		var serial;
		var params;

		if (cached) {
			applyResourcePage(query, cached);
			if (typeof onLoaded === 'function') {
				window.setTimeout(onLoaded, 0);
			}
			return false;
		}

		if (!urls.resources) {
			return false;
		}

		serial = ++resourceRequestSerial;
		params = new URLSearchParams({
			mode: query.mode,
			query: query.query,
			type: query.type,
			track: query.track,
			grade: query.grade,
			page: String(query.page),
			per_page: String(query.per_page),
			selected_ids: JSON.stringify(query.selected_ids || []),
			keywords: (query.keywords || []).join(' ')
		});

		resourcesLoading = true;
		resourcesLoadPromise = fetch(urls.resources + '?' + params.toString(), {
			method: 'GET',
			credentials: 'same-origin'
		})
			.then(function (response) {
				if (!response.ok) {
					throw new Error('Resource request failed.');
				}
				return response.json();
			})
			.then(function (payload) {
				if (serial === resourceRequestSerial) {
					applyResourcePage(query, payload);
				}
				resourcesLoading = false;
			})
			.catch(function () {
				resourcesLoading = false;
				resourceLoadErrors[baseKey] = true;
				dataLoadError = strings.dataLoadFailed || 'LessonDesign AI could not load its planner data. Refresh the page, then contact an administrator if the problem continues.';
			});

		if (typeof onLoaded === 'function') {
			resourcesLoadPromise.then(onLoaded);
		}

		return true;
	}

	function rebuildCurriculumIndexes() {
		standardById = indexArrayById(curriculumStandardsData.standards || []);
		curriculumTrackById = indexArrayById(curriculumSourcesData.curriculumTracks || []);
		matchingStandardsCache = {};
	}

	function indexArrayById(items) {
		return (items || []).reduce(function (index, item) {
			if (item && item.id) {
				index[item.id] = item;
			}
			return index;
		}, {});
	}

	function setPlannerDataStatus(roots, message, isLoading) {
		roots.forEach(function (root) {
			var statusNode = root.querySelector('[data-status-message]');
			root.classList.toggle('is-data-loading', !!isLoading);
			if (statusNode) {
				statusNode.textContent = message;
			}
		});
	}

	function initPlanner(root) {
		var state = createInitialState();
		var currentStep = 'welcome';
		var statusNode = root.querySelector('[data-status-message]');
		var authPromptNodes = Array.prototype.slice.call(root.querySelectorAll('[data-auth-prompt]'));
		var expectationListNode = root.querySelector('[data-expectation-list]');
		var expectationSummaryNode = root.querySelector('[data-expectation-summary]');
		var readinessNode = root.querySelector('[data-readiness-panel]');
		var resourcesNode = root.querySelector('[data-resource-results]');
		var resourceSummaryNode = root.querySelector('[data-resource-summary]');
		var resourceToggleNode = root.querySelector('[data-resource-toggle]');
		var selectedResourcesNode = root.querySelector('[data-selected-resources]');
		var previewNode = root.querySelector('[data-preview]');
		var searchInput = root.querySelector('[data-resource-search]');
		var typeInput = root.querySelector('[data-resource-type]');
		var form = root.querySelector('[data-ldai-form]');
		var resourceGuidanceNode = root.querySelector('[data-resource-guidance]');
		var lastSavedNode = root.querySelector('[data-last-saved]');
		var aiPanels = {};
		var aiDrafts = {};
		var aiBusySections = {};
		var sectionCoachNodes = {};
		var resourceVisibleLimit = RESOURCE_INITIAL_LIMIT;
		var resourceRenderTimeout = null;
		var renderFrame = null;
		var dirtyRenderSections = {};
		var saveFrame = null;

		function scheduleRenderAll() {
			scheduleRenderSections([
				'auth',
				'chrome',
				'curriculum',
				'resources',
				'selectedResources',
				'readiness',
				'preview',
				'lastSaved',
				'ai'
			]);
		}

		function scheduleRenderSections(sections) {
			(sections || []).forEach(function (section) {
				dirtyRenderSections[section] = true;
			});

			if (renderFrame) {
				return;
			}

			renderFrame = window.requestAnimationFrame(function () {
				var dirty = dirtyRenderSections;
				dirtyRenderSections = {};
				renderFrame = null;
				renderSections(dirty);
			});
		}

		function renderSections(dirty) {
			dirty = dirty || {};
			renderOutline();

			if (dirty.auth) {
				renderAuthPrompt();
			}
			if (dirty.chrome) {
				renderSectionCoaches();
			}
			if (dirty.curriculum && currentStep === 'foundation') {
				renderExpectations();
			}
			if ((dirty.curriculum || dirty.targetsCurriculum || dirty.chrome) && currentStep === 'targets') {
				renderTargetsCurriculum();
			}
			if (dirty.resources && currentStep === 'connections') {
				renderResources();
			}
			if (dirty.selectedResources && currentStep === 'connections') {
				renderSelectedResources();
			}
			if (dirty.readiness && currentStep === 'ready') {
				renderReadiness();
			}
			if (dirty.preview && currentStep === 'ready') {
				renderPreview();
			}
			if (dirty.lastSaved && currentStep === 'ready') {
				renderLastSavedMeta();
			}
			if (dirty.ai) {
				renderCurrentAIDrafts();
			}
		}

		function scheduleLocalSave() {
			if (saveFrame) {
				window.clearTimeout(saveFrame);
			}
			saveFrame = window.setTimeout(function () {
				saveFrame = null;
				saveState(state);
				renderOutline();
			}, 250);
		}

		root.querySelectorAll('[data-ai-panel]').forEach(function (panel) {
			var section = panel.getAttribute('data-ai-panel');
			if (!section) {
				return;
			}

			aiPanels[section] = {
				section: section,
				panelNode: panel,
				statusNode: panel.querySelector('[data-ai-status]'),
				responseNode: panel.querySelector('[data-ai-response-panel]'),
				actionButtons: Array.prototype.slice.call(panel.querySelectorAll('[data-ai-action]'))
			};
			aiDrafts[section] = null;
			aiBusySections[section] = false;
		});

		root.querySelectorAll('[data-section-coach]').forEach(function (node) {
			var section = node.getAttribute('data-section-coach');
			if (section) {
				sectionCoachNodes[section] = node;
			}
		});

		root.classList.remove('is-preview-visible');

		populateSelects(root, state);
		applyStateToForm(root, state);

		bindFieldUpdates(root, state, function (bindPath) {
			if (bindPath === 'connections.mode' || bindPath === 'connections.note' || bindPath.indexOf('foundation.') === 0 || bindPath.indexOf('curriculum.') === 0) {
				resetResourcePagination();
			}
			markSaved(state);
			scheduleLocalSave();
			scheduleRenderSections(getDirtySectionsForBindPath(bindPath));
			if (hasAccountAccess()) {
				scheduleSyncToServer(state, setStatus);
			} else {
				setStatus(strings.plannerSaved || 'Draft saved locally in this browser.');
			}
		});

		bindStepNavigation(root, goToStep);

		bindUtilityActions();
		bindAIActions();
		bindUserAiKeyActions();
		bindAccessKeyActions();
		bindDelegatedListActions();

		if (searchInput) {
			searchInput.addEventListener('input', function () {
				resetResourcePagination();
				scheduleRenderResources();
			});
		}

		if (typeInput) {
			typeInput.addEventListener('change', function () {
				resetResourcePagination();
				scheduleRenderSections(['resources']);
			});
		}

		if (resourceToggleNode) {
			resourceToggleNode.addEventListener('click', function () {
				if (resourceToggleNode.disabled) {
					return;
				}
				resourceVisibleLimit = Math.min(resourceVisibleLimit + RESOURCE_LIMIT_INCREMENT, RESOURCE_MAX_VISIBLE);
				scheduleRenderSections(['resources']);
			});
		}

		if (form) {
			form.addEventListener('submit', function (event) {
				event.preventDefault();
			});
		}

		handleEntryParams(state, function (entryMessage) {
			loadFromServer(state, function (serverMessage) {
				populateSelects(root, state);
				applyStateToForm(root, state);
				currentStep = resolveInitialStep(state, entryMessage === 'new');
				updateStepView(root, currentStep);
				renderCurrentStep();
				renderResumeButton();
				setStatus(dataLoadError || serverMessage || (entryMessage && entryMessage !== 'new' ? entryMessage : ''));
				// Load curriculum for the saved selection up front, so steps that
				// read it (Learning Targets, Review) are accurate after a reload.
				ensureCurriculumShardsFor(state.curriculum, function () {
					scheduleRenderSections(['curriculum', 'targetsCurriculum', 'readiness', 'preview', 'resources', 'chrome']);
				});
			});
		});

		function renderResumeButton() {
			var resumeButton = root.querySelector('[data-resume-draft]');
			var startButton = root.querySelector('[data-start-label]');
			var hasDraft = hasMeaningfulDraftContent(state);
			if (resumeButton) {
				resumeButton.hidden = !hasDraft;
			}
			if (startButton) {
				startButton.innerHTML = hasDraft ? 'Start A Fresh Lesson Plan &rarr;' : 'Start New Lesson Plan &rarr;';
				startButton.setAttribute('data-fresh-start', hasDraft ? '1' : '');
			}
		}

		(function bindWelcomeActions() {
			var resumeButton = root.querySelector('[data-resume-draft]');
			var startButton = root.querySelector('[data-start-label]');
			if (resumeButton) {
				resumeButton.addEventListener('click', function () {
					goToStep(resolveResumeStep(state));
				});
			}
			if (startButton) {
				// Runs before the generic data-next-step handler moves to Foundation.
				startButton.addEventListener('click', function (event) {
					if (startButton.getAttribute('data-fresh-start') !== '1') {
						return;
					}
					if (!window.confirm('Start a fresh lesson plan? Your current draft ' + (hasAccountAccess() ? 'stays saved in My Lesson Plans.' : 'in this browser will be cleared.'))) {
						event.stopImmediatePropagation();
						return;
					}
					startFreshDraft();
				}, true);
			}
		})();

		function startFreshDraft() {
			replaceState(state, normalizeState(clone(defaults)));
			aiDrafts = {};
			Object.keys(aiPanels).forEach(function (section) {
				aiDrafts[section] = null;
			});
			root.classList.remove('is-preview-visible');
			applyStateToForm(root, state);
			populateSelects(root, state);
			if (searchInput) {
				searchInput.value = '';
			}
			if (typeInput) {
				typeInput.value = 'all';
			}
			saveState(state);
			renderResumeButton();
		}

		function goToStep(nextStep) {
			if (!root.querySelector('[data-step-panel="' + nextStep + '"]')) {
				return;
			}
			currentStep = nextStep;
			saveCurrentStep(currentStep);
			updateStepView(root, currentStep);
			renderCurrentStep();
			scrollStepIntoView(root, currentStep);
		}

		/**
		 * Opens whichever step currently contains the section (looked up in the
		 * DOM by data-section id), then scrolls to and highlights it.
		 */
		function goToSection(sectionId) {
			var sectionNode = sectionId ? root.querySelector('[data-section="' + sectionId + '"]') : null;
			var panel = sectionNode && sectionNode.closest ? sectionNode.closest('[data-step-panel]') : null;
			var stepId = panel ? panel.getAttribute('data-step-panel') : '';
			var focusTarget;

			if (!stepId) {
				return;
			}

			goToStep(stepId);

			if (!sectionNode || sectionNode.hidden) {
				return;
			}

			window.requestAnimationFrame(function () {
				scrollNodeIntoPlannerView(root, sectionNode);
				sectionNode.classList.remove('is-deep-linked');
				// Restart the highlight animation.
				void sectionNode.offsetWidth;
				sectionNode.classList.add('is-deep-linked');
				focusTarget = sectionNode.querySelector('input:not([type="hidden"]), textarea, select, button');
				try {
					(focusTarget || sectionNode).focus({ preventScroll: true });
				} catch (error) {
					(focusTarget || sectionNode).focus();
				}
			});
		}

		function renderCurrentStep() {
			renderSections(getDirtySectionsForStep(currentStep).reduce(function (dirty, section) {
				dirty[section] = true;
				return dirty;
			}, {}));
		}

		function renderAll() {
			renderSections({
				auth: true,
				chrome: true,
				curriculum: true,
				resources: true,
				selectedResources: true,
				readiness: true,
				preview: true,
				lastSaved: true,
				ai: true
			});
		}

		function countLines(value) {
			return String(value || '').split('\n').filter(function (line) { return line.trim(); }).length;
		}

		/** Live lesson outline in the sidebar (wide screens). Click an item to jump to it. */
		function renderOutline() {
			var node = root.querySelector('[data-lesson-outline]');
			var foundation = state.foundation || {};
			var design = state.design || {};
			var gradeLabel;
			var meta;
			var curriculumCount;
			var items;
			if (!node) {
				return;
			}
			gradeLabel = getLabelFromSource(curriculumSourcesData.gradeLevels || [], state.curriculum.grade);
			meta = [gradeLabel, getCurriculumTrackDisplaySummary(state.curriculum)].filter(Boolean).join(' · ');
			curriculumCount = (state.selectedStandards || []).length;
			items = [
				{ section: SECTION_IDS.lessonIdea, label: 'Lesson idea', done: hasNonEmptyText(foundation.title) && (hasNonEmptyText(foundation.prompt) || hasNonEmptyText(foundation.overview)) },
				{ section: SECTION_IDS.curriculum, label: 'Curriculum', done: curriculumCount > 0, count: curriculumCount ? curriculumCount + ' selected' : '' },
				{ section: SECTION_IDS.learningObjectives, label: 'Goals & criteria', done: hasNonEmptyText(foundation.learningGoals) && hasNonEmptyText(foundation.successCriteria), count: countLines(foundation.learningGoals) ? countLines(foundation.learningGoals) + ' goals' : '' },
				{ section: SECTION_IDS.assessment, label: 'Assessment', done: hasNonEmptyText(foundation.formativeAssessment) || hasNonEmptyText(foundation.summativeAssessment) },
				{ section: SECTION_IDS.connections, label: 'Learning connection', done: (state.selectedResources || []).length > 0 || hasNonEmptyText(state.connections.note), count: (state.selectedResources || []).length ? (state.selectedResources || []).length + ' added' : '' },
				{ section: SECTION_IDS.learnerSupport, label: 'Learner support', done: hasNonEmptyText(design.differentiation) || (design.crrpChecks || []).length > 0 },
				{ section: SECTION_IDS.learningSequence, label: 'Activities', done: hasNonEmptyText(design.learningActivities), count: countLines(design.learningActivities) ? countLines(design.learningActivities) + ' steps' : '' }
			];
			node.innerHTML =
				'<p class="ldai-outline__eyebrow">Your lesson</p>' +
				'<p class="ldai-outline__title">' + escapeHtml(foundation.title || 'Untitled lesson') + '</p>' +
				'<p class="ldai-outline__meta">' + escapeHtml(meta || 'Choose a grade and subject') + '</p>' +
				'<ul class="ldai-outline__list">' + items.map(function (item) {
					return '<li><button type="button" class="ldai-outline__item' + (item.done ? ' is-done' : '') + '" data-goto-section="' + item.section + '">' +
						'<span class="ldai-outline__check" aria-hidden="true"></span>' +
						'<span>' + escapeHtml(item.label) + '<span class="screen-reader-text">' + (item.done ? ' (done)' : ' (to do)') + '</span></span>' +
						'<span class="ldai-outline__count">' + escapeHtml(item.count || '') + '</span>' +
					'</button></li>';
				}).join('') + '</ul>' +
				'<p class="ldai-outline__saved" data-outline-saved></p>';
			renderOutlineSaved();
		}

		function renderOutlineSaved() {
			var node = root.querySelector('[data-outline-saved]');
			var saved = state.meta && state.meta.lastSaved ? new Date(state.meta.lastSaved) : null;
			if (!node) {
				return;
			}
			node.textContent = saved && !isNaN(saved.getTime())
				? (hasAccountAccess() ? 'Saved to your account · ' : 'Saved in this browser · ') + saved.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
				: 'Not saved yet';
		}

		function renderTargetsCurriculum() {
			var node = root.querySelector('[data-targets-curriculum]');
			var pieces;
			var trackSummary;
			if (!node) {
				return;
			}
			if (!getCurriculumTrackIds(state.curriculum).length || !state.curriculum.grade) {
				node.hidden = false;
				node.innerHTML = '<h5>Curriculum</h5><p>Choose a grade and subject in Foundation so your goals and assessment can be written against visible expectations.</p>' +
					'<button class="lessondesign-ai__button" type="button" data-goto-section="' + SECTION_IDS.curriculum + '">Choose Grade &amp; Subject</button>';
				return;
			}
			if (ensureCurriculumShardsFor(state.curriculum, function () {
				scheduleRenderSections(['targetsCurriculum']);
			})) {
				node.hidden = false;
				node.innerHTML = '<h5>Curriculum</h5><p>Loading selected curriculum...</p>';
				return;
			}
			pieces = getSelectedCurriculumPieces(state);
			trackSummary = [getLabelFromSource(curriculumSourcesData.gradeLevels || [], state.curriculum.grade), getCurriculumTrackDisplaySummary(state.curriculum)].filter(Boolean).join(' · ');
			node.hidden = false;
			node.innerHTML = '<h5>Writing against: ' + escapeHtml(trackSummary) + '</h5>' +
				(pieces.length
					? '<ul>' + pieces.slice(0, 8).map(function (item) {
						return '<li>' + escapeHtml(formatStandardLine(item)) + '</li>';
					}).join('') + '</ul>' + (pieces.length > 8 ? '<p>+ ' + (pieces.length - 8) + ' more selected in Foundation.</p>' : '')
					: '<p>No curriculum pieces selected yet. Selecting one or two gives the goals and AI drafts a clear anchor.</p>' +
						'<button class="lessondesign-ai__button" type="button" data-goto-section="' + SECTION_IDS.curriculum + '">Select Curriculum Pieces</button>');
		}

		root.addEventListener('click', function (event) {
			var link = event.target && event.target.closest ? event.target.closest('[data-goto-section]') : null;
			if (link) {
				goToSection(link.getAttribute('data-goto-section'));
			}
		});

		function getDirtySectionsForStep(step) {
			var sections = ['auth', 'chrome', 'ai'];
			if (step === 'foundation') {
				sections.push('curriculum');
			}
			if (step === 'targets') {
				sections.push('targetsCurriculum');
			}
			if (step === 'connections') {
				sections.push('resources', 'selectedResources');
			}
			if (step === 'ready') {
				sections.push('readiness', 'preview', 'lastSaved');
			}
			return sections;
		}

		function getDirtySectionsForBindPath(bindPath) {
			if (bindPath.indexOf('curriculum.') === 0) {
				return ['chrome', 'curriculum', 'resources', 'selectedResources', 'readiness', 'preview', 'ai'];
			}
			if (bindPath.indexOf('connections.') === 0) {
				return ['chrome', 'resources', 'selectedResources', 'readiness', 'preview', 'ai'];
			}
			if (bindPath.indexOf('foundation.') === 0) {
				return ['chrome', 'resources', 'readiness', 'preview', 'ai'];
			}
			if (bindPath.indexOf('design.') === 0) {
				return ['chrome', 'readiness', 'preview', 'ai'];
			}
			return ['chrome', 'readiness', 'preview', 'lastSaved', 'ai'];
		}

		function resetResourcePagination() {
			resourceVisibleLimit = getResourcePageSize(state.connections && state.connections.mode ? state.connections.mode : 'guided');
		}

		function renderCurrentAIDrafts() {
			Object.keys(aiPanels).forEach(function (section) {
				if (section === currentStep) {
					renderAIDraft(section);
				}
			});
		}

		function bindDelegatedListActions() {
			if (expectationListNode) {
				expectationListNode.addEventListener('change', function (event) {
					var checkbox = event.target && event.target.closest ? event.target.closest('[data-expectation-id]') : null;
					if (!checkbox) {
						return;
					}
					var expectationId = checkbox.getAttribute('data-expectation-id');
					state.selectedStandards = Array.isArray(state.selectedStandards) ? state.selectedStandards : [];
					if (checkbox.checked) {
						if (state.selectedStandards.indexOf(expectationId) === -1) {
							state.selectedStandards.push(expectationId);
						}
					} else {
						state.selectedStandards = state.selectedStandards.filter(function (item) {
							return item !== expectationId;
						});
					}
					state.selectedStandards = uniqueArray(state.selectedStandards);
					markSaved(state);
					scheduleLocalSave();
					var card = checkbox.closest ? checkbox.closest('.lessondesign-ai__expectation') : null;
					if (card) {
						card.classList.toggle('is-selected', checkbox.checked);
					}
					renderExpectationSummary();
					setStatus(strings.plannerSaved || 'Draft saved locally in this browser.');
					if (hasAccountAccess()) {
						scheduleSyncToServer(state, setStatus);
					}
				});
			}
			if (expectationSummaryNode) {
				expectationSummaryNode.addEventListener('click', function (event) {
					var button = event.target && event.target.closest ? event.target.closest('[data-selected-standard-remove]') : null;
					if (!button) {
						return;
					}
					var standardId = button.getAttribute('data-selected-standard-remove');
					state.selectedStandards = uniqueArray((state.selectedStandards || []).filter(function (item) {
						return item !== standardId;
					}));
					markSaved(state);
					scheduleLocalSave();
					renderExpectations();
					setStatus(strings.plannerSaved || 'Draft saved locally in this browser.');
					if (hasAccountAccess()) {
						scheduleSyncToServer(state, setStatus);
					}
				});
			}

			if (resourcesNode) {
				resourcesNode.addEventListener('click', function (event) {
					var retryButton = event.target && event.target.closest ? event.target.closest('[data-resource-retry]') : null;
					var button = event.target && event.target.closest ? event.target.closest('[data-resource-id]') : null;
					if (retryButton) {
						delete resourceLoadErrors[retryButton.getAttribute('data-resource-retry')];
						dataLoadError = '';
						setStatus('');
						renderResources();
						return;
					}
					if (!button) {
						return;
					}
					var resourceId = button.getAttribute('data-resource-id');
					var isSelected = state.selectedResources.indexOf(resourceId) > -1;

					if (isSelected) {
						state.selectedResources = state.selectedResources.filter(function (item) {
							return item !== resourceId;
						});
					} else {
						state.selectedResources.push(resourceId);
					}

					state.selectedResources = uniqueArray(state.selectedResources);
					markSaved(state);
					saveState(state);
					updateResourceCardSelection(button, !isSelected);
					scheduleRenderSections(['selectedResources', 'readiness', 'preview', 'ai']);
					setStatus(strings.plannerSaved || 'Draft saved locally in this browser.');
					if (hasAccountAccess()) {
						scheduleSyncToServer(state, setStatus);
					}
				});
			}
		}

		function renderExpectations() {
			if (!expectationListNode || !expectationSummaryNode) {
				return;
			}

			var curriculum = state.curriculum || {};

			if (!getCurriculumTrackIds(curriculum).length || !curriculum.grade) {
				expectationListNode.innerHTML = '<p class="lessondesign-ai__empty">' + escapeHtml(strings.noStandards || strings.noExpectations || 'Choose your grade and subject to see curriculum focus areas.') + '</p>';
				expectationSummaryNode.innerHTML = '';
				return;
			}

			if (ensureCurriculumShardsFor(curriculum, function () {
				scheduleRenderSections(['curriculum', 'resources', 'ai']);
			})) {
				expectationListNode.innerHTML = '<p class="lessondesign-ai__empty">Loading curriculum focus areas for this selection...</p>';
				expectationSummaryNode.innerHTML = '';
				return;
			}

			var standards = getMatchingStandards(state);

			if (!standards.length) {
				expectationListNode.innerHTML = '<p class="lessondesign-ai__empty">No curriculum pieces match this Alberta selection yet.</p>';
				expectationSummaryNode.innerHTML = '';
				return;
			}

			var selectedIdLookup = getSelectedStandardIds(state).reduce(function (lookup, id) {
				lookup[id] = true;
				return lookup;
			}, {});
			var grouped = groupCurriculumStandards(standards, selectedIdLookup);

			expectationListNode.innerHTML = (
				standards.length
					? grouped.map(function (subjectGroup) {
						return renderCurriculumSubjectGroup(subjectGroup, grouped.length > 1, selectedIdLookup);
					}).join('')
					: '<p class="lessondesign-ai__empty">No curriculum pieces match this selection yet.</p>'
			);

			renderExpectationSummary();
		}

		function renderExpectationSummary() {
			if (!expectationSummaryNode) {
				return;
			}

			var selectedItems = getSelectedStandards(state);

			expectationSummaryNode.innerHTML = selectedItems.length
				? '<div class="lessondesign-ai__selection-summary-head"><strong>Selected Curriculum</strong><span>' + escapeHtml(String(selectedItems.length)) + '</span></div>' +
					'<div class="lessondesign-ai__selected-curriculum-list">' + selectedItems.map(function (item) {
						return renderSelectedCurriculumItem(item);
					}).join('') + '</div>'
				: '<div class="lessondesign-ai__selection-summary-head"><strong>Selected Curriculum</strong><span>0</span></div><p class="lessondesign-ai__empty">Select one or more curriculum pieces to anchor the lesson.</p>';
		}

		function groupCurriculumStandards(standards, selectedIdLookup) {
			var subjectGroups = [];
			var subjectByKey = {};
			var orderedSubjectKeys = getCurriculumTracks(state.curriculum).reduce(function (keys, track) {
				var key = getCurriculumSubjectGroupKey(track);
				if (key && keys.indexOf(key) === -1) {
					keys.push(key);
				}
				return keys;
			}, []);

			(standards || []).forEach(function (item) {
				var subjectKey = getCurriculumSubjectGroupKey(item);
				var subjectLabel = getStandardSubjectLabel(item);
				var unitLabel = getStandardGroupUnitLabel(item);
				var unitKey = normalizeText(unitLabel) || 'curriculum';

				if (!subjectByKey[subjectKey]) {
					subjectByKey[subjectKey] = {
						label: subjectLabel,
						items: [],
						sections: [],
						sectionByKey: {},
						selectedCount: 0
					};
					if (orderedSubjectKeys.indexOf(subjectKey) === -1) {
						orderedSubjectKeys.push(subjectKey);
					}
				}

				if (!subjectByKey[subjectKey].sectionByKey[unitKey]) {
					subjectByKey[subjectKey].sectionByKey[unitKey] = {
						label: unitLabel,
						items: [],
						types: [],
						typeByKey: {},
						selectedCount: 0
					};
					subjectByKey[subjectKey].sections.push(subjectByKey[subjectKey].sectionByKey[unitKey]);
				}

				subjectByKey[subjectKey].items.push(item);
				subjectByKey[subjectKey].sectionByKey[unitKey].items.push(item);
				if (shouldSeparateCurriculumSubsections(item)) {
					addCurriculumSubsectionItem(subjectByKey[subjectKey].sectionByKey[unitKey], item, selectedIdLookup);
				}
				if (selectedIdLookup[item.id]) {
					subjectByKey[subjectKey].selectedCount += 1;
					subjectByKey[subjectKey].sectionByKey[unitKey].selectedCount += 1;
				}
			});

			orderedSubjectKeys.forEach(function (key) {
				if (subjectByKey[key]) {
					subjectGroups.push(subjectByKey[key]);
				}
			});
			return subjectGroups;
		}

		function renderCurriculumSubjectGroup(subjectGroup, showSubjectHeading, selectedIdLookup) {
			var subjectHeading = showSubjectHeading
				? '<div class="lessondesign-ai__curriculum-subject-head">' +
					'<h3>' + escapeHtml(subjectGroup.label || 'Curriculum') + '</h3>' +
					'<small>' + escapeHtml(formatCurriculumCount(subjectGroup.items.length, subjectGroup.selectedCount)) + '</small>' +
				'</div>'
				: '';
			return (
				'<section class="lessondesign-ai__curriculum-subject">' +
					subjectHeading +
					subjectGroup.sections.map(function (sectionGroup) {
						return renderCurriculumSection(sectionGroup, selectedIdLookup);
					}).join('') +
				'</section>'
			);
		}

		function addCurriculumSubsectionItem(sectionGroup, item, selectedIdLookup) {
			var typeLabel = getStandardTypeLabel(item);
			var typeKey = normalizeText(typeLabel) || 'curriculum-piece';
			if (!sectionGroup.typeByKey[typeKey]) {
				sectionGroup.typeByKey[typeKey] = {
					label: typeLabel,
					className: getStandardTypeClass(item),
					items: [],
					selectedCount: 0
				};
				sectionGroup.types.push(sectionGroup.typeByKey[typeKey]);
			}
			sectionGroup.typeByKey[typeKey].items.push(item);
			if (selectedIdLookup[item.id]) {
				sectionGroup.typeByKey[typeKey].selectedCount += 1;
			}
		}

		function renderCurriculumSection(sectionGroup, selectedIdLookup) {
			var shouldOpen = sectionGroup.selectedCount > 0;
			return (
				'<details class="lessondesign-ai__curriculum-section"' + (shouldOpen ? ' open' : '') + '>' +
					'<summary class="lessondesign-ai__curriculum-section-head">' +
						'<h4>' + escapeHtml(sectionGroup.label || 'Curriculum Pieces') + '</h4>' +
						'<small>' + escapeHtml(formatCurriculumCount(sectionGroup.items.length, sectionGroup.selectedCount)) + '</small>' +
					'</summary>' +
					'<div class="lessondesign-ai__curriculum-section-list">' +
						renderCurriculumSectionItems(sectionGroup, selectedIdLookup) +
					'</div>' +
				'</details>'
			);
		}

		function renderCurriculumSectionItems(sectionGroup, selectedIdLookup) {
			if (sectionGroup.items && sectionGroup.items.length && isDramaItem(sectionGroup.items[0])) {
				return renderDramaSectionItems(sectionGroup, selectedIdLookup);
			}
			if (sectionGroup.types && sectionGroup.types.length) {
				if (
					sectionGroup.types.length === 1 &&
					normalizeText(sectionGroup.types[0].label) === normalizeText(sectionGroup.label)
				) {
					return sectionGroup.types[0].items.map(function (item) {
						return renderCurriculumStandardCard(item, !!selectedIdLookup[item.id]);
					}).join('');
				}
				return sectionGroup.types.map(function (typeGroup) {
					return renderCurriculumSubsection(typeGroup, selectedIdLookup);
				}).join('');
			}
			return sectionGroup.items.map(function (item) {
				return renderCurriculumStandardCard(item, !!selectedIdLookup[item.id]);
			}).join('');
		}

		function renderDramaSectionItems(sectionGroup, selectedIdLookup) {
			var componentGroups = [];
			var componentByKey = {};

			(sectionGroup.items || []).forEach(function (item) {
				var componentLabel = getStandardTypeLabel(item);
				var componentKey = normalizeText(componentLabel) || 'drama-component';
				if (!componentByKey[componentKey]) {
					componentByKey[componentKey] = {
						label: componentLabel,
						items: [],
						selectedCount: 0
					};
					componentGroups.push(componentByKey[componentKey]);
				}
				componentByKey[componentKey].items.push(item);
				if (selectedIdLookup[item.id]) {
					componentByKey[componentKey].selectedCount += 1;
				}
			});

			return componentGroups.map(function (componentGroup) {
				return (
					'<div class="lessondesign-ai__curriculum-static-group">' +
						'<div class="lessondesign-ai__curriculum-static-head">' +
							'<h5>' + escapeHtml(componentGroup.label || 'Drama') + '</h5>' +
							'<small>' + escapeHtml(formatCurriculumCount(componentGroup.items.length, componentGroup.selectedCount)) + '</small>' +
						'</div>' +
						componentGroup.items.map(function (item) {
							return renderCurriculumStandardCard(item, !!selectedIdLookup[item.id]);
						}).join('') +
					'</div>'
				);
			}).join('');
		}

		function renderCurriculumSubsection(typeGroup, selectedIdLookup) {
			var shouldOpen = typeGroup.selectedCount > 0;
			return (
				'<details class="lessondesign-ai__curriculum-subsection lessondesign-ai__curriculum-subsection--' + escapeHtml(typeGroup.className) + '"' + (shouldOpen ? ' open' : '') + '>' +
					'<summary class="lessondesign-ai__curriculum-subsection-head">' +
						'<h5>' + escapeHtml(typeGroup.label) + '</h5>' +
						'<small>' + escapeHtml(formatCurriculumCount(typeGroup.items.length, typeGroup.selectedCount)) + '</small>' +
					'</summary>' +
					'<div class="lessondesign-ai__curriculum-subsection-body">' +
						typeGroup.items.map(function (item) {
							return renderCurriculumStandardCard(item, !!selectedIdLookup[item.id]);
						}).join('') +
					'</div>' +
				'</details>'
			);
		}

		function shouldSeparateCurriculumSubsections(item) {
			return /^science/i.test(String(item && item.subject || '')) || isLanguageArtsItem(item) || isCtsKnowledgeEmployabilityItem(item) || isSocialStudiesItem(item) || isEnvironmentalOutdoorItem(item) || isHealthItem(item) || (isFineArtsItem(item) && !isDramaItem(item) && !isMusicItem(item));
		}

		function formatCurriculumCount(count, selectedCount) {
			return count + ' piece' + (count === 1 ? '' : 's') + (selectedCount ? ' | ' + selectedCount + ' selected' : '');
		}

		function getCurriculumSubjectGroupKey(item) {
			return [
				item && (item.subject || item.id),
				item && item.subjectAreaId,
				item && item.frameworkId,
				item && item.programId
			].filter(Boolean).join('|') || 'curriculum';
		}

		function renderCurriculumStandardCard(item, isSelected) {
			var checked = isSelected ? ' checked' : '';
			var cardClass = 'lessondesign-ai__expectation' + (isSelected ? ' is-selected' : '');
			var statusLabel = getStandardStatusLabel(item);
			var code = item.standardCode || item.code || '';
			var officialTextMarkup = renderCurriculumOutcomeDisplayText(item);
			var statusMarkup = statusLabel
				? '<span class="lessondesign-ai__expectation-status">' + escapeHtml(statusLabel) + '</span>'
				: '';
			var pieceTitle = getCurriculumPieceDisplayTitle(item);
			var sourceLink = item.sourceUrl
				? '<a class="lessondesign-ai__expectation-source" href="' + escapeHtml(item.sourceUrl) + '" target="_blank" rel="noopener noreferrer">Official Source</a>'
				: '';
			var sourceMeta = sourceLink || code
				? '<span class="lessondesign-ai__expectation-source-row">' + sourceLink + (code ? '<span class="lessondesign-ai__expectation-code' + (sourceLink ? '' : ' is-solo') + '">' + escapeHtml(code) + '</span>' : '') + '</span>'
				: '';
			return (
				'<label class="' + escapeHtml(cardClass) + '">' +
					'<input type="checkbox" data-expectation-id="' + escapeHtml(item.id) + '"' + checked + '>' +
					'<span>' +
						'<strong class="lessondesign-ai__expectation-title">' + escapeHtml(pieceTitle) + '</strong>' +
						officialTextMarkup +
						statusMarkup +
						sourceMeta +
					'</span>' +
				'</label>'
			);
		}

		function renderSelectedCurriculumItem(item) {
			var unitLabel = getStandardGroupUnitLabel(item);
			return (
				'<div class="lessondesign-ai__selected-curriculum-item">' +
					'<button type="button" data-selected-standard-remove="' + escapeHtml(item.id) + '" aria-label="Remove ' + escapeHtml(getCurriculumPieceDisplayTitle(item)) + '">&times;</button>' +
					'<span>' +
						'<strong>' + escapeHtml(getCurriculumPieceDisplayTitle(item)) + '</strong>' +
						(unitLabel ? '<small>' + escapeHtml(unitLabel) + '</small>' : '') +
					'</span>' +
				'</div>'
			);
		}

		function getStandardGroupUnitLabel(item) {
			return formatCurriculumSectionLabel(getStandardUnitLabel(item));
		}

		function formatCurriculumSectionLabel(label) {
			return String(label || '').replace(/^Strand:\s*/i, '').trim();
		}

		function getStandardSubjectLabel(item) {
			var track = getAlbertaSubjectTracks().find(function (candidate) {
				return item &&
					candidate.subject === item.subject &&
					candidate.subjectAreaId === item.subjectAreaId &&
					candidate.frameworkId === item.frameworkId &&
					candidate.programId === item.programId;
			});
			return track ? getAlbertaSubjectTrackLabel(track) : getLabelFromSource(curriculumSourcesData.subjects || [], item && item.subject);
		}

		function getStandardUnitLabel(item) {
			var locator = item.sourceLocator || '';
			if (item.unit) {
				return item.unit;
			}
			if (item.strand) {
				return item.strand;
			}
			if (locator && locator.indexOf('>') > -1) {
				return locator.split('>')[0].trim();
			}
			if (item.courseCode || item.courseLabel) {
				return [item.courseCode, item.courseLabel].filter(Boolean).join(' - ');
			}
			return item.gradeBand || item.gradeLabel || 'Curriculum Pieces';
		}

		function getStandardTypeLabel(item) {
			var text = [item.generalOutcome || '', item.moduleLabel || '', item.moduleType || '', item.standardCode || item.code || ''].join(' ');
			if (isSocialStudiesItem(item)) {
				var socialFamilyLabel = getSocialStudiesFamilyLabel(item);
				if (socialFamilyLabel) {
					return socialFamilyLabel;
				}
			}
			if (isPhysicalEducationItem(item)) {
				return item.moduleLabel || item.generalOutcome || 'Specific Outcomes';
			}
			if (isEnvironmentalOutdoorItem(item)) {
				return item.moduleLabel || item.generalOutcome || 'Specific Outcomes';
			}
			if (isFineArtsItem(item)) {
				return item.moduleLabel || item.generalOutcome || 'Curriculum focus';
			}
			if (isHealthItem(item)) {
				return item.moduleLabel || item.generalOutcome || 'Health and Life Skills';
			}
			if (isCtsKnowledgeEmployabilityItem(item)) {
				return item.moduleLabel || item.generalOutcome || 'Competencies';
			}
			if (/attitude|disposition|ATT-/i.test(text)) {
				return 'Learning dispositions';
			}
			if (/skill|practice|evidence|SKILL-/i.test(text)) {
				return 'Skills';
			}
			if (/science, technology and society|STS-K|knowledge|learning-focus/i.test(text)) {
				return 'Understandings';
			}
			return item.moduleLabel || 'Curriculum focus';
		}

		function getStandardTypeClass(item) {
			var label = getStandardTypeLabel(item);
			if (label === 'Learning dispositions') {
				return 'disposition';
			}
			if (label === 'Skills') {
				return 'skill';
			}
			if (label === 'Understandings') {
				return 'understanding';
			}
			return 'focus';
		}

		function renderResources() {
			if (!resourcesNode) {
				return;
			}
			if (currentStep !== 'connections') {
				return;
			}

			var queryValue = searchInput ? searchInput.value.trim() : '';
			var type = typeInput ? typeInput.value : 'all';
			var mode = state.connections.mode || 'guided';
			var pageSize = getResourcePageSize(mode);
			var pagesNeeded;
			var query;
			var baseKey;
			var pages;
			var pageNumber;
			var visibleLimit;
			var visibleEntries;
			var emptyMessage = strings.noResources || 'No resources matched the current search. Try a broader term or switch the resource type filter.';

			resourceVisibleLimit = Math.max(resourceVisibleLimit || pageSize, pageSize);
			pagesNeeded = Math.max(1, Math.ceil(Math.min(resourceVisibleLimit, RESOURCE_MAX_VISIBLE) / pageSize));
			query = buildResourceQuery(state, 1, pageSize, queryValue, type);
			baseKey = getResourceBaseQueryKey(query);
			pages = resourcePagesByKey[baseKey] || {};

			for (pageNumber = 1; pageNumber <= pagesNeeded; pageNumber += 1) {
				if (!pages[pageNumber]) {
					if (resourceLoadErrors[baseKey]) {
						resourcesNode.innerHTML = '<div class="lessondesign-ai__empty"><p>Learning Connections could not be loaded right now.</p><button class="lessondesign-ai__button" type="button" data-resource-retry="' + escapeHtml(baseKey) + '">Try Again</button></div>';
						updateResourceSummary(0, 0, mode, queryValue, type);
						updateResourceToggle(0, 0, mode);
						return;
					}
					query = buildResourceQuery(state, pageNumber, pageSize, queryValue, type);
					fetchResourcePage(query, renderResources);
					if (resourceActiveQueryKey !== baseKey || !resourceRemoteResults.length) {
						resourcesNode.innerHTML = '<p class="lessondesign-ai__empty">Loading Learning Connections...</p>';
						updateResourceSummary(0, 0, mode, queryValue, type);
						updateResourceToggle(0, 0, mode);
						return;
					}
					break;
				}
			}

			visibleLimit = Math.min(resourceRemoteResults.length, resourceVisibleLimit, RESOURCE_MAX_VISIBLE);
			visibleEntries = resourceRemoteResults.slice(0, visibleLimit).map(function (item) {
				return {
					item: item,
					score: Number(item.matchScore || 0),
					keywordMatches: Number(item.matchKeywordMatches || 0),
					reasons: item.matchReasons || []
				};
			});

			updateResourceGuidance(visibleEntries);

			if (!visibleEntries.length) {
				if (mode === 'guided') {
					emptyMessage = strings.noGuidedMatches || 'No strong guided matches yet. Add a clearer subject, goal, or keyword, or switch to browse mode.';
				}
				resourcesNode.innerHTML = '<p class="lessondesign-ai__empty">' + escapeHtml(emptyMessage) + '</p>';
				updateResourceSummary(0, resourceRemoteTotal, mode, queryValue, type);
				updateResourceToggle(0, 0, mode);
				return;
			}

			resourcesNode.innerHTML = visibleEntries.map(function (entry) {
				var item = entry.item;
				var isSelected = state.selectedResources.indexOf(item.id) > -1;
				var metaPills = getResourceMetaPills(item);
				var cardClass = 'lessondesign-ai__resource-card' + (isSelected ? ' is-selected' : '');
				var buttonClass = 'lessondesign-ai__button lessondesign-ai__resource-action' + (isSelected ? '' : ' lessondesign-ai__button--primary');
				var recommendation = '';
				if (mode === 'guided' && entry.score > 0) {
					recommendation =
						'<div class="lessondesign-ai__resource-match">' +
							'<span>' + escapeHtml(strings.recommendedLabel || 'Suggested Fit') + '</span>' +
							' ' +
							'<strong>' + escapeHtml(entry.reasons.join(', ')) + '</strong>' +
						'</div>';
				}
				return (
					'<article class="' + escapeHtml(cardClass) + '">' +
						'<div class="lessondesign-ai__resource-card-top">' +
							'<div class="lessondesign-ai__resource-title-group">' +
								'<div class="lessondesign-ai__resource-meta">' +
									metaPills.map(function (label) {
										return '<span class="lessondesign-ai__pill">' + escapeHtml(label) + '</span>';
									}).join('') +
								'</div>' +
								'<div class="lessondesign-ai__resource-heading-row">' +
								'<h4>' + escapeHtml(item.title) + '</h4>' +
									'<button class="' + escapeHtml(buttonClass) + '" type="button" data-resource-id="' + escapeHtml(item.id) + '">' +
										escapeHtml(isSelected ? 'Remove' : 'Add to plan') +
									'</button>' +
								'</div>' +
							'</div>' +
						'</div>' +
						recommendation +
						'<p class="lessondesign-ai__resource-summary-text">' + escapeHtml(item.summary) + '</p>' +
						'<ul class="lessondesign-ai__tag-list">' +
							(item.subjects || []).map(function (subject) {
								return '<li>' + escapeHtml(subject) + '</li>';
							}).join('') +
						'</ul>' +
					'</article>'
				);
			}).join('');

			updateResourceSummary(visibleEntries.length, resourceRemoteTotal, mode, queryValue, type);
			updateResourceToggle(visibleEntries.length, resourceRemoteTotal, mode);
		}

		function updateResourceCardSelection(button, isSelected) {
			var card = button && button.closest ? button.closest('.lessondesign-ai__resource-card') : null;
			if (card) {
				card.classList.toggle('is-selected', isSelected);
			}
			if (button) {
				button.classList.toggle('lessondesign-ai__button--primary', !isSelected);
				button.textContent = isSelected ? 'Remove' : 'Add to plan';
			}
		}

		function getResourceMetaPills(item) {
			var kindLabel = item && item.kind === 'expert' ? 'Expert' : 'Virtual Tour';
			var formatLabel = item && item.format ? toDisplayTitleCase(item.format) : 'Digital Connection';
			var labels = [kindLabel];

			if (normalizeText(formatLabel) && normalizeText(formatLabel) !== normalizeText(kindLabel)) {
				labels.push(formatLabel);
			}

			return labels;
		}

		function toDisplayTitleCase(label) {
			return String(label || '').replace(/\S+/g, function (word) {
				return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
			});
		}

		function scheduleRenderResources() {
			if (resourceRenderTimeout) {
				window.clearTimeout(resourceRenderTimeout);
			}
			resourceRenderTimeout = window.setTimeout(function () {
				resourceRenderTimeout = null;
				renderResources();
			}, 150);
		}

		function ensureSelectedResourcesHydrated(onLoaded) {
			var missingSelected = (state.selectedResources || []).some(function (id) {
				return !getResourceById(id);
			});
			var mode = state.connections && state.connections.mode ? state.connections.mode : 'guided';
			var queryValue = searchInput ? searchInput.value.trim() : '';
			var type = typeInput ? typeInput.value : 'all';

			if (!missingSelected) {
				return false;
			}

			return fetchResourcePage(buildResourceQuery(state, 1, getResourcePageSize(mode), queryValue, type), onLoaded);
		}

		function renderSelectedResources() {
			if (!selectedResourcesNode) {
				return;
			}
			if (currentStep !== 'connections') {
				return;
			}

			if (Array.isArray(state.selectedResources) && state.selectedResources.length && ensureSelectedResourcesHydrated(function () {
				scheduleRenderSections(['selectedResources', 'preview', 'ai']);
			})) {
				selectedResourcesNode.innerHTML = '<p class="lessondesign-ai__empty">Loading Selected Resources...</p>';
				return;
			}

			var selectedItems = getSelectedResources(state);

			if (!selectedItems.length) {
				selectedResourcesNode.innerHTML =
					'<h4>' + escapeHtml(strings.selectedResources || 'Selected Resources') + '</h4>' +
					'<p class="lessondesign-ai__empty">' + escapeHtml(strings.noSelections || 'Nothing selected yet.') + '</p>';
				return;
			}

			selectedResourcesNode.innerHTML =
				'<h4>' + escapeHtml(strings.selectedResources || 'Selected Resources') + '</h4>' +
				'<ul class="lessondesign-ai__selected-list">' +
				selectedItems.map(function (item) {
					return (
						'<li>' +
							'<strong>' + escapeHtml(item.title) + '</strong>' +
							'<span>' + escapeHtml(item.kind === 'expert' ? 'Expert' : 'Virtual Tour') + '</span>' +
						'</li>'
					);
				}).join('') +
				'</ul>';
		}

		function renderPreview() {
			if (previewNode && currentStep === 'ready' && root.classList.contains('is-preview-visible')) {
				if (Array.isArray(state.selectedResources) && state.selectedResources.length && ensureSelectedResourcesHydrated(function () {
					scheduleRenderSections(['preview']);
				})) {
					previewNode.innerHTML = '<p class="lessondesign-ai__empty">Loading Selected Resources...</p>';
					return;
				}
				previewNode.innerHTML = buildPreviewHtml(state);
			}
		}

		function renderLastSavedMeta() {
			if (!lastSavedNode) {
				return;
			}

			var savedText = state.meta && state.meta.lastSaved ? formatDateTime(state.meta.lastSaved) : 'Not saved yet in this browser';
			lastSavedNode.textContent = (strings.lastSavedPrefix || 'Last saved:') + ' ' + savedText;
		}

		function renderReadiness() {
			if (!readinessNode) {
				return;
			}

			var items = buildReadinessItems(state);
			var needsAttention = items.filter(function (item) {
				return item.status !== 'complete';
			});
			var heading = 'Review Lesson Plan';
			var body = needsAttention.length
				? 'Your lesson plan is saved, but these sections may require your attention before sharing your plan.'
				: (hasAccountAccess()
					? 'The major planning pieces are present. Review the lesson below and make any final edits.'
					: 'The major planning pieces are present. Make any final edits before you wrap up.');

			var completed = items.filter(function (item) {
				return item.status === 'complete';
			});
			var percent = Math.round((completed.length / items.length) * 100);

			// Items keep document order; only the grouping changes.
			readinessNode.innerHTML =
				'<div class="ldai-review-head">' +
					'<div class="ldai-review-ring" style="--ldai-progress:' + percent + '" data-label="' + completed.length + '/' + items.length + '" role="img" aria-label="' + completed.length + ' of ' + items.length + ' sections complete"></div>' +
					'<div>' +
						'<h4>' + escapeHtml(heading) + '</h4>' +
						'<p>' + escapeHtml(needsAttention.length ? needsAttention.length + ' section' + (needsAttention.length === 1 ? '' : 's') + ' could use a look before you share this plan.' : body) + '</p>' +
					'</div>' +
				'</div>' +
				(needsAttention.length
					? '<p class="ldai-review-label">Needs attention</p><ul class="lessondesign-ai__readiness-list">' + needsAttention.map(renderReadinessItem).join('') + '</ul>'
					: '') +
				(completed.length
					? '<details class="ldai-review-done"' + (needsAttention.length ? '' : ' open') + '><summary>Completed (' + completed.length + ')</summary><ul class="lessondesign-ai__readiness-list">' + completed.map(renderReadinessItem).join('') + '</ul></details>'
					: '');

			readinessNode.querySelectorAll('[data-readiness-section]').forEach(function (button) {
				button.addEventListener('click', function () {
					goToSection(button.getAttribute('data-readiness-section'));
				});
			});
		}

		function renderSectionCoaches() {
			Object.keys(sectionCoachNodes).forEach(function (section) {
				var node = sectionCoachNodes[section];

				if (!node) {
					return;
				}

				if (section !== currentStep) {
					return;
				}

				var suggestion = getSectionSuggestion(section, state);

				if (!suggestion) {
					node.innerHTML = '';
					node.hidden = true;
					return;
				}

				node.hidden = false;
				node.innerHTML = buildSectionSuggestionMarkup(suggestion);

				node.querySelectorAll('[data-suggestion-apply]').forEach(function (button) {
					button.addEventListener('click', function () {
						applySectionSuggestion(suggestion);
					});
				});
			});
		}

		function applySectionSuggestion(suggestion) {
			if (!suggestion || !suggestion.apply) {
				return;
			}

			applySuggestionPatch(state, suggestion.apply);
			markSaved(state);
			saveState(state);
			applyStateToForm(root, state);
			renderSections({
				chrome: true,
				curriculum: true,
				resources: true,
				selectedResources: true,
				readiness: true,
				preview: true,
				ai: true
			});
			focusSuggestionTarget(root, suggestion);
			setStatus(suggestion.appliedMessage || 'Suggested fill applied.');

			if (hasAccountAccess()) {
				scheduleSyncToServer(state, setStatus);
			}
		}

		function updateResourceGuidance(matches) {
			if (!resourceGuidanceNode) {
				return;
			}

			var mode = state.connections.mode || 'guided';
			if (mode === 'browse') {
				resourceGuidanceNode.hidden = false;
				resourceGuidanceNode.textContent = strings.browseResources || 'Browse mode keeps results neutral so you can search and filter manually.';
				return;
			}

			var hasScoredMatch = matches.some(function (entry) {
				return entry.score > 0;
			});

			var guidedText = hasScoredMatch
				? (strings.guidedResources || '')
				: (strings.noGuidedMatches || 'Choose your grade and subject, or add a search term, to sharpen the suggestions.');
			resourceGuidanceNode.hidden = guidedText === '';
			resourceGuidanceNode.textContent = guidedText;
		}

		function updateResourceSummary(visibleCount, totalCount, mode, query, type) {
			if (!resourceSummaryNode) {
				return;
			}

			if (!totalCount) {
				resourceSummaryNode.textContent = mode === 'guided'
					? 'Guided mode only shows strong matches from this lesson draft.'
					: 'Browse mode is ready when you want to explore the full library.';
				return;
			}

			var typeLabel = type && type !== 'all' ? (type === 'expert' ? 'experts' : 'virtual tours') : 'matches';
			var summary = mode === 'guided'
				? 'Showing ' + visibleCount + ' of ' + totalCount + ' guided ' + typeLabel + '.'
				: 'Showing ' + visibleCount + ' of ' + totalCount + ' browse ' + typeLabel + '.';

			if (query && searchInput) {
				summary += ' Search: "' + searchInput.value + '".';
			}

			if (totalCount > visibleCount && visibleCount >= RESOURCE_MAX_VISIBLE) {
				summary += ' Narrow the search or filters to inspect more specific matches.';
			}

			resourceSummaryNode.textContent = summary;
		}

		function updateResourceToggle(visibleCount, totalCount, mode) {
			if (!resourceToggleNode) {
				return;
			}

			if (totalCount <= visibleCount) {
				resourceToggleNode.hidden = true;
				resourceToggleNode.disabled = false;
				resourceToggleNode.textContent = '';
				return;
			}

			resourceToggleNode.hidden = false;
			if (visibleCount >= RESOURCE_MAX_VISIBLE) {
				resourceToggleNode.disabled = true;
				resourceToggleNode.textContent = 'Refine Search For More';
				return;
			}
			resourceToggleNode.disabled = false;
			resourceToggleNode.textContent = 'Show ' + String(Math.min(RESOURCE_LIMIT_INCREMENT, totalCount - visibleCount)) + ' More ' + (mode === 'guided' ? 'Matches' : 'Results');
		}

		function getResourcePageSize(mode) {
			return RESOURCE_INITIAL_LIMIT;
		}

		function bindUtilityActions() {
			var viewButton = root.querySelector('[data-view-preview]');
			var summaryDownloadButton = root.querySelector('[data-download-summary]');
			var jsonDownloadButton = root.querySelector('[data-download-json]');
			var loadJsonButton = root.querySelector('[data-load-json]');
			var importInput = root.querySelector('[data-import-json]');
			var resetButton = root.querySelector('[data-reset-planner]');

			if (viewButton) {
				viewButton.addEventListener('click', function () {
					if (!hasAccountAccess()) {
						setStatus(appData.isLoggedIn ? (strings.subscriptionRequired || 'Your account needs an active LessonDesign subscription before previewing this lesson plan.') : 'Login or create an account before previewing this lesson plan.');
						return;
					}

					var isVisible = root.classList.toggle('is-preview-visible');
					updatePreviewToggleText(root);
					if (previewNode && isVisible) {
						renderPreview();
						scrollNodeIntoPlannerView(root, previewNode);
						setStatus('Lesson plan preview updated.');
					} else if (!isVisible) {
						setStatus('Lesson plan preview hidden.');
					}
				});
			}

			if (summaryDownloadButton) {
				summaryDownloadButton.addEventListener('click', function () {
					if (!hasAccountAccess()) {
						setStatus(appData.isLoggedIn ? (strings.subscriptionRequired || 'Your account needs an active LessonDesign subscription before downloading this lesson plan.') : 'Login or create an account before downloading this lesson plan.');
						return;
					}

					downloadFile(slugify(state.foundation.title || 'lessondesign-ai-lesson') + '.pdf', buildLessonPlanPdf(state), 'application/pdf');
					setStatus(strings.summaryDownloaded || 'Lesson PDF downloaded.');
				});
			}

			if (jsonDownloadButton) {
				jsonDownloadButton.addEventListener('click', function () {
					if (!hasAccountAccess()) {
						setStatus(appData.isLoggedIn ? (strings.subscriptionRequired || 'Your account needs an active LessonDesign subscription before downloading planner data.') : 'Login or create an account before downloading planner data.');
						return;
					}

					downloadFile(slugify(state.foundation.title || 'lessondesign-ai-lesson') + '.json', JSON.stringify(state, null, 2), 'application/json;charset=utf-8');
					setStatus(strings.jsonDownloaded || 'Planner data downloaded.');
				});
			}

			if (loadJsonButton && importInput) {
				loadJsonButton.addEventListener('click', function () {
					importInput.click();
				});

				importInput.addEventListener('change', function () {
					var file = importInput.files && importInput.files[0];
					if (!file) {
						return;
					}

					var reader = new FileReader();
					reader.onload = function (event) {
						try {
							var imported = JSON.parse(String(event.target && event.target.result ? event.target.result : '{}'));
							replaceState(state, normalizeState(mergeState(defaults, imported)));
							aiDrafts = {};
							Object.keys(aiPanels).forEach(function (section) {
								aiDrafts[section] = null;
							});
							markSaved(state);
							applyStateToForm(root, state);
							saveState(state);
							renderCurrentStep();
							setStatus(strings.jsonImported || 'Planner data imported into this browser.');
							if (hasAccountAccess()) {
								scheduleSyncToServer(state, setStatus);
							}
						} catch (error) {
							setStatus(strings.jsonImportFailed || 'That file could not be imported. Use a LessonDesign AI JSON export and try again.');
						} finally {
							importInput.value = '';
						}
					};
					reader.readAsText(file);
				});
			}

			if (resetButton) {
				resetButton.addEventListener('click', function () {
					replaceState(state, createInitialState());
					aiDrafts = {};
					Object.keys(aiPanels).forEach(function (section) {
						aiDrafts[section] = null;
					});
					root.classList.remove('is-preview-visible');
					applyStateToForm(root, state);
					if (searchInput) {
						searchInput.value = '';
					}
					if (typeInput) {
						typeInput.value = 'all';
					}
					saveState(state);
					currentStep = 'welcome';
					saveCurrentStep(currentStep);
					renderResumeButton();
					renderCurrentStep();
					updateStepView(root, currentStep);
					scrollStepIntoView(root, currentStep);
					setStatus(strings.plannerReset || 'Planner reset. You are back to a fresh draft.');
					if (hasAccountAccess()) {
						scheduleSyncToServer(state, setStatus);
					}
				});
			}
		}

		/** The teacher's own prompt for this step ("What lesson do you have in mind?"). */
		function getAIInstructions(section) {
			var field = aiPanels[section] && aiPanels[section].panelNode.querySelector('[data-ai-instructions]');
			return field ? field.value.trim().slice(0, 600) : '';
		}

		function bindAIActions() {
			Object.keys(aiPanels).forEach(function (section) {
				var promptField = aiPanels[section].panelNode.querySelector('[data-ai-instructions]');
				var promptKey = 'lessondesign_ai_prompt_' + section;
				if (promptField) {
					// Keep what the teacher typed across reloads (this browser only).
					try {
						promptField.value = window.localStorage.getItem(promptKey) || '';
					} catch (error) {
						// ignore storage errors
					}
					promptField.addEventListener('input', function () {
						try {
							window.localStorage.setItem(promptKey, promptField.value);
						} catch (error) {
							// ignore storage errors
						}
					});
					// Ctrl/Cmd + Enter drafts straight from the prompt box.
					promptField.addEventListener('keydown', function (event) {
						if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !aiBusySections[section]) {
							event.preventDefault();
							requestAIAssist(section, 'draft_section');
						}
					});
				}
				aiPanels[section].panelNode.querySelectorAll('[data-ai-chip]').forEach(function (chip) {
					chip.addEventListener('click', function () {
						var text = chip.getAttribute('data-ai-chip');
						if (!promptField || promptField.disabled) {
							return;
						}
						if (promptField.value.indexOf(text) === -1) {
							promptField.value = (promptField.value.trim() ? promptField.value.trim().replace(/[.]?$/, '. ') : '') + text + '.';
							promptField.dispatchEvent(new Event('input'));
						}
						promptField.focus();
					});
				});
				aiPanels[section].actionButtons.forEach(function (button) {
					button.addEventListener('click', function () {
						var assistAction = button.getAttribute('data-ai-action');
						if (!assistAction || aiBusySections[section]) {
							return;
						}

						requestAIAssist(section, assistAction);
					});
				});
				if (aiPanels[section].responseNode) {
					aiPanels[section].responseNode.addEventListener('click', function (event) {
						var applyAllButton = event.target && event.target.closest ? event.target.closest('[data-ai-apply-all]') : null;
						var discardButton = event.target && event.target.closest ? event.target.closest('[data-ai-discard]') : null;
						var applyFieldButton = event.target && event.target.closest ? event.target.closest('[data-ai-apply-field]') : null;

						if (applyAllButton) {
							applyAIPatchFields(section, Object.keys(getAIPatchForSection(aiDrafts[section], section)));
							return;
						}

						if (discardButton) {
							aiDrafts[section] = null;
							renderAIDraft(section);
							setAIStatus(section, strings.aiDiscarded || 'AI suggestion discarded.');
							return;
						}

						if (applyFieldButton) {
							applyAIPatchFields(section, [applyFieldButton.getAttribute('data-ai-apply-field')]);
						}
					});
				}
			});

		}

		function bindUserAiKeyActions() {
			var panel = root.querySelector('[data-user-ai-key-panel]');
			if (!panel) {
				return;
			}

			var input = panel.querySelector('[data-user-gemini-key-input]');
			var saveButton = panel.querySelector('[data-user-gemini-key-save]');
			var clearButton = panel.querySelector('[data-user-gemini-key-clear]');
			var statusNode = panel.querySelector('[data-user-gemini-key-status]');

			function setKeyStatus(message) {
				if (statusNode) {
					statusNode.textContent = message;
				}
			}

			function refreshAiAvailability() {
				aiConfig.available = !!(aiConfig.enabled && (aiConfig.siteAvailable || aiConfig.hasUserGeminiKey));
				Object.keys(aiPanels).forEach(function (section) {
					renderAIDraft(section);
				});
			}

			function submitKey(value, busyButton) {
				if (busyButton) {
					busyButton.disabled = true;
				}

				apiRequest('POST', '/user/gemini-key', { gemini_api_key: value }).then(function (result) {
					if (busyButton) {
						busyButton.disabled = false;
					}
					if (result && result.success) {
						aiConfig.hasUserGeminiKey = !!(result.data && result.data.hasKey);
						if (input) {
							input.value = '';
						}
						setKeyStatus((result.data && result.data.message) || 'Saved.');
						refreshAiAvailability();
					} else {
						setKeyStatus(getAjaxErrorMessage(result));
					}
				}).catch(function () {
					if (busyButton) {
						busyButton.disabled = false;
					}
					setKeyStatus('Could not reach the server. Please try again.');
				});
			}

			if (saveButton) {
				saveButton.addEventListener('click', function () {
					var key = input ? input.value.trim() : '';
					if (!key) {
						setKeyStatus('Paste a Gemini API key first, or use Remove Key to clear a saved one.');
						return;
					}
					submitKey(key, saveButton);
				});
			}

			if (clearButton) {
				clearButton.addEventListener('click', function () {
					submitKey('__clear__', clearButton);
				});
			}

			setKeyStatus(aiConfig.hasUserGeminiKey
				? 'A personal Gemini key is saved for your account.'
				: 'No personal key saved yet. AI Assist will use this site\'s shared key, if one is configured.');
		}

		function bindAccessKeyActions() {
			// The subscription prompt (and this form) can render multiple times
			// per page load, once per gated panel, so wire every instance.
			root.querySelectorAll('[data-access-key-form]').forEach(function (form) {
				var input = form.querySelector('[data-access-key-input]');
				var button = form.querySelector('[data-access-key-redeem]');
				var statusNode = form.querySelector('[data-access-key-status]');

				function setFormStatus(message) {
					if (statusNode) {
						statusNode.textContent = message;
					}
				}

				if (!button) {
					return;
				}

				button.addEventListener('click', function () {
					var key = input ? input.value.trim() : '';
					if (!key) {
						setFormStatus('Enter an access key first.');
						return;
					}

					button.disabled = true;
					setFormStatus('Checking key...');

					apiRequest('POST', '/access-key/redeem', { access_key: key }).then(function (result) {
						if (result && result.success) {
							setFormStatus((result.data && result.data.message) || 'Access key accepted. Reloading...');
							window.setTimeout(function () {
								window.location.reload();
							}, 1200);
						} else {
							button.disabled = false;
							setFormStatus(getAjaxErrorMessage(result));
						}
					}).catch(function () {
						button.disabled = false;
						setFormStatus('Could not reach the server. Please try again.');
					});
				});
			});
		}

		function buildAIRequestState(section) {
			var curriculum = state.curriculum || {};
			var foundation = state.foundation || {};
			var design = state.design || {};
			var connections = state.connections || {};
			var payload = {
				curriculum: {
					track: curriculum.track || '',
					tracks: getCurriculumTrackIds(curriculum),
					grade: curriculum.grade || ''
				},
				selectedStandards: (state.selectedStandards || []).slice(),
				selectedResources: (state.selectedResources || []).slice()
			};

			// Every AI step gets the lesson identity plus grade/subject/curriculum,
			// so "Draft This Section" always has real detail to anchor to.
			payload.foundation = {
				title: foundation.title || '',
				prompt: foundation.prompt || '',
				overview: foundation.overview || '',
				learnerContext: foundation.learnerContext || '',
				learningGoals: foundation.learningGoals || '',
				successCriteria: foundation.successCriteria || ''
			};

			if (section === 'targets' || section === 'design') {
				payload.foundation.formativeAssessment = foundation.formativeAssessment || '';
				payload.foundation.summativeAssessment = foundation.summativeAssessment || '';
				payload.design = {
					transferableSkills: (design.transferableSkills || []).slice()
				};
			}

			if (section === 'design') {
				payload.design = {
					learningActivities: design.learningActivities || '',
					materials: design.materials || '',
					technology: design.technology || '',
					differentiation: design.differentiation || '',
					transferableSkills: (design.transferableSkills || []).slice(),
					crrpChecks: (design.crrpChecks || []).slice(),
					teacherNotes: design.teacherNotes || ''
				};
				payload.connections = {
					note: connections.note || ''
				};
			}

			return pruneAIRequestCachePayload(payload);
		}

		function buildAIRequestCachePayload(section, assistAction, requestState) {
			var payload = Object.assign({
				provider: [
					aiConfig.provider || '',
					aiConfig.model || '',
					aiConfig.enabled ? '1' : '0',
					aiConfig.available ? '1' : '0'
				].join('|'),
				section: section,
				action: assistAction
			}, requestState || buildAIRequestState(section));

			return pruneAIRequestCachePayload(payload);
		}

		function pruneAIRequestCachePayload(value) {
			var pruned;

			if (Array.isArray(value)) {
				pruned = value
					.map(pruneAIRequestCachePayload)
					.filter(function (item) {
						return item !== '' && item !== null && !(Array.isArray(item) && !item.length);
					});
				return pruned;
			}

			if (value && typeof value === 'object') {
				pruned = {};
				Object.keys(value).sort().forEach(function (key) {
					var item = pruneAIRequestCachePayload(value[key]);
					if (item === '' || item === null) {
						return;
					}
					if (Array.isArray(item) && !item.length) {
						return;
					}
					if (item && typeof item === 'object' && !Array.isArray(item) && !Object.keys(item).length) {
						return;
					}
					pruned[key] = item;
				});
				return pruned;
			}

			return value;
		}

		function stableStringify(value) {
			if (Array.isArray(value)) {
				return '[' + value.map(stableStringify).join(',') + ']';
			}

			if (value && typeof value === 'object') {
				return '{' + Object.keys(value).sort().map(function (key) {
					return JSON.stringify(key) + ':' + stableStringify(value[key]);
				}).join(',') + '}';
			}

			return JSON.stringify(value);
		}

		function hashAIRequestPayload(payload) {
			var text = stableStringify(payload);
			var encoder;

			if (window.crypto && window.crypto.subtle && window.TextEncoder) {
				encoder = new TextEncoder();
				return window.crypto.subtle.digest('SHA-256', encoder.encode(text)).then(function (buffer) {
					return Array.prototype.map.call(new Uint8Array(buffer), function (byte) {
						return byte.toString(16).padStart(2, '0');
					}).join('');
				});
			}

			return Promise.resolve(simpleHash(text));
		}

		function simpleHash(text) {
			var hash = 0;
			var index;

			for (index = 0; index < text.length; index += 1) {
				hash = ((hash << 5) - hash) + text.charCodeAt(index);
				hash |= 0;
			}

			return 'fallback-' + Math.abs(hash).toString(16) + '-' + text.length;
		}

		function getCachedAIResponse(key) {
			var now = Date.now();
			var match = null;

			aiResponseCache = aiResponseCache.filter(function (entry) {
				var fresh = entry && entry.expiresAt > now;
				if (fresh && entry.key === key) {
					match = entry;
				}
				return fresh;
			});

			return match ? cloneJson(match.draft) : null;
		}

		function storeCachedAIResponse(key, draft) {
			if (!draft || draft.status !== 'ready') {
				return;
			}

			aiResponseCache = aiResponseCache.filter(function (entry) {
				return entry.key !== key;
			});
			aiResponseCache.unshift({
				key: key,
				expiresAt: Date.now() + AI_CACHE_TTL_MS,
				draft: cloneJson(draft)
			});
			if (aiResponseCache.length > AI_CACHE_MAX_ENTRIES) {
				aiResponseCache.length = AI_CACHE_MAX_ENTRIES;
			}
		}

		function cloneJson(value) {
			return JSON.parse(JSON.stringify(value));
		}

		function requestAIAssist(section, assistAction) {
			if (!aiPanels[section]) {
				return;
			}

			if (!aiConfig.enabled || !aiConfig.available) {
				setAIStatus(section, strings.aiUnavailable || 'AI Assist is not configured on this site yet.');
				renderAIDraft(section);
				return;
			}

			setAIBusy(section, true);
			aiDrafts[section] = null;
			renderAIDraft(section);
			setAIStatus(section, strings.aiWorking || 'AI Assist is drafting ideas for this section...');

			var requestState = buildAIRequestState(section);
			var instructions = getAIInstructions(section);
			var cachePayload = buildAIRequestCachePayload(section, assistAction, requestState);
			cachePayload.instructions = instructions;
			cachePayload.profileVersion = aiConfig.profileVersion || '';

			hashAIRequestPayload(cachePayload)
				.then(function (cacheKey) {
					var cachedDraft = getCachedAIResponse(cacheKey);
					if (cachedDraft) {
						aiDrafts[section] = cachedDraft;
						renderAIDraft(section);
						setAIStatus(section, strings.aiSuggestionReady || 'AI suggestion ready. Review it before you apply anything.');
						return null;
					}

					return apiRequest('POST', '/ai-assist', {
						section: section,
						assist_action: assistAction,
						instructions: instructions,
						state: requestState
					}).then(function (result) {
						return {
							cacheKey: cacheKey,
							result: result
						};
					});
				})
				.then(function (response) {
					var result;
					if (!response) {
						return;
					}
					result = response.result;
					if (!result || !result.success || !result.data) {
						throw new Error(getAjaxErrorMessage(result));
					}

					aiDrafts[section] = normalizeAIDraft(result.data, section);
					storeCachedAIResponse(response.cacheKey, aiDrafts[section]);
					renderAIDraft(section);

					if (aiDrafts[section].status === 'ready') {
						setAIStatus(section, strings.aiSuggestionReady || 'AI suggestion ready. Review it before you apply anything.');
						return;
					}

					setAIStatus(section, aiDrafts[section].warnings[0] || strings.aiNoSuggestion || 'AI Assist did not return a usable suggestion. Please try again.');
				})
				.catch(function (error) {
					aiDrafts[section] = null;
					renderAIDraft(section);
					setAIStatus(section, error && error.message ? error.message : (strings.aiRequestFailed || 'AI Assist ran into a problem. Please try again in a moment.'));
				})
				.finally(function () {
					setAIBusy(section, false);
				});
		}

		function renderAIDraft(section) {
			var aiPanel = aiPanels[section];
			var aiResponseNode;
			var draft;

			if (!aiPanel) {
				return;
			}

			aiResponseNode = aiPanel.responseNode;
			if (!aiResponseNode) {
				return;
			}

			aiPanel.panelNode.querySelectorAll('[data-ai-instructions], [data-ai-chip]').forEach(function (control) {
				control.disabled = !aiConfig.enabled || !aiConfig.available;
			});

			if (!aiConfig.enabled || !aiConfig.available) {
				aiPanel.actionButtons.forEach(function (button) {
					button.disabled = true;
				});
				if (aiPanel.statusNode && !aiPanel.statusNode.textContent) {
					setAIStatus(section, strings.aiUnavailable || 'AI Assist is not configured on this site yet.');
				}
				aiResponseNode.hidden = true;
				return;
			}

			aiPanel.actionButtons.forEach(function (button) {
				button.disabled = !!aiBusySections[section];
			});

			draft = aiDrafts[section];
			if (!draft) {
				aiResponseNode.innerHTML = '';
				aiResponseNode.hidden = true;
				return;
			}

			aiResponseNode.hidden = false;
			aiResponseNode.innerHTML = buildAIDraftMarkup(draft, section);
		}

		function applyAIPatchFields(section, fields) {
			var sectionPatch = getAIPatchForSection(aiDrafts[section], section);
			var appliedFields = [];

			fields.forEach(function (field) {
				if (!field || !Object.prototype.hasOwnProperty.call(sectionPatch, field)) {
					return;
				}

				// Fields map to plan-state paths (e.g. Transferable Skills are edited
				// in step 3 but stored on design.transferableSkills).
				setValueAtPath(state, (aiFieldPaths[section] && aiFieldPaths[section][field]) || (section + '.' + field), Array.isArray(sectionPatch[field]) ? sectionPatch[field].slice() : sectionPatch[field]);
				delete sectionPatch[field];
				appliedFields.push(field);
			});

			if (!appliedFields.length) {
				return;
			}

			if (!Object.keys(sectionPatch).length) {
				aiDrafts[section] = null;
			}

			markSaved(state);
			saveState(state);
			applyStateToForm(root, state);
			renderSections({
				chrome: true,
				resources: section !== 'design',
				readiness: true,
				preview: true,
				ai: true
			});

			setAIStatus(section, appliedFields.length > 1
				? (strings.aiApplied || 'AI suggestion applied to this section.')
				: (strings.aiFieldApplied || 'AI suggestion applied to that field.'));

			if (hasAccountAccess()) {
				scheduleSyncToServer(state, setStatus);
			}
		}

		function setAIBusy(section, isBusy) {
			aiBusySections[section] = isBusy;
			root.classList.toggle('is-ai-loading', Object.keys(aiBusySections).some(function (key) {
				return !!aiBusySections[key];
			}));
			Object.keys(aiPanels).forEach(function (panelSection) {
				aiPanels[panelSection].actionButtons.forEach(function (button) {
					button.disabled = !!aiBusySections[panelSection] || !aiConfig.enabled || !aiConfig.available;
				});
			});
		}

		function setAIStatus(section, message) {
			if (aiPanels[section] && aiPanels[section].statusNode) {
				aiPanels[section].statusNode.textContent = message;
			}
		}

		var statusTimer = null;

		/** Small toast in the corner; fades out on its own. */
		function setStatus(message) {
			if (!statusNode) {
				return;
			}
			window.clearTimeout(statusTimer);
			statusNode.textContent = message || '';
			statusNode.classList.toggle('is-visible', !!message);
			if (message && !root.classList.contains('is-data-error')) {
				statusTimer = window.setTimeout(function () {
					statusNode.classList.remove('is-visible');
				}, 3500);
			}
			renderOutlineSaved();
		}

		function renderAuthPrompt() {
			var shouldShow = !hasAccountAccess() && (currentStep === 'ready' || hasMeaningfulDraftContent(state));

			authPromptNodes.forEach(function (node) {
				node.hidden = !shouldShow;
			});
		}
	}

	function normalizeAIDraft(data, section) {
		var patch = data && data.patch && typeof data.patch === 'object' ? data.patch : {};
		var sectionPatch = patch[section] && typeof patch[section] === 'object' ? patch[section] : {};
		var normalized = {
			status: data && data.status ? String(data.status) : 'ready',
			section: section,
			patch: {},
			rationale: Array.isArray(data && data.rationale) ? data.rationale.filter(Boolean).map(String) : [],
			warnings: Array.isArray(data && data.warnings) ? data.warnings.filter(Boolean).map(String) : []
		};

		normalized.patch[section] = sectionPatch;

		if (normalized.status === 'refused' && !normalized.warnings.length) {
			normalized.warnings.push(strings.aiNoSuggestion || 'AI Assist did not return a usable suggestion. Please try again.');
		}

		return normalized;
	}

	function getAIPatchForSection(aiDraft, section) {
		if (!aiDraft || !aiDraft.patch || typeof aiDraft.patch !== 'object') {
			return {};
		}

		if (section && aiDraft.patch[section] && typeof aiDraft.patch[section] === 'object') {
			return aiDraft.patch[section];
		}

		return {};
	}

	function buildAIDraftMarkup(aiDraft, section) {
		var sectionPatch = getAIPatchForSection(aiDraft, section);
		var fieldKeys = Object.keys(sectionPatch);
		var hasPatch = fieldKeys.length > 0;
		var actionMarkup =
			'<div class="lessondesign-ai__ai-review-actions">' +
				(hasPatch
					? '<button class="lessondesign-ai__button lessondesign-ai__button--primary" type="button" data-ai-apply-all>' + escapeHtml(strings.aiApplyAll || 'Apply All') + '</button>'
					: '') +
				'<button class="lessondesign-ai__button" type="button" data-ai-discard>' + escapeHtml(strings.aiDiscard || 'Discard') + '</button>' +
			'</div>';

		return (
			'<div class="lessondesign-ai__ai-card">' +
				'<div class="lessondesign-ai__ai-card-header">' +
					'<div>' +
						'<h4>' + escapeHtml(strings.aiSuggestionTitle || 'Suggested edits') + '</h4>' +
						'<p>' + escapeHtml(getAISubtitle(aiDraft.status)) + '</p>' +
					'</div>' +
					actionMarkup +
				'</div>' +
				renderAIListSection(strings.aiWarningsTitle || 'Things to keep in mind', aiDraft.warnings, 'lessondesign-ai__ai-list--warning') +
				(hasPatch ? renderAIFieldCards(sectionPatch, section) : '') +
				renderAIListSection(strings.aiRationaleTitle || 'Why this draft was suggested', aiDraft.rationale, 'lessondesign-ai__ai-list--rationale') +
			'</div>'
		);
	}

	function getAISubtitle(status) {
		if (status === 'refused') {
			return strings.aiNoSuggestion || 'AI Assist did not return a usable suggestion. Please try again.';
		}

		return strings.aiSuggestionReady || 'AI suggestion ready. Review it before you apply anything.';
	}

	function renderAIListSection(title, items, modifierClass) {
		if (!items || !items.length) {
			return '';
		}

		return (
			'<section class="lessondesign-ai__ai-list ' + escapeHtml(modifierClass || '') + '">' +
				'<h5>' + escapeHtml(title) + '</h5>' +
				'<ul>' + items.map(function (item) {
					return '<li>' + escapeHtml(item) + '</li>';
				}).join('') + '</ul>' +
			'</section>'
		);
	}

	function renderAIFieldCards(sectionPatch, section) {
		return (
			'<section class="lessondesign-ai__ai-fields">' +
				Object.keys(sectionPatch).map(function (field) {
					return (
						'<article class="lessondesign-ai__ai-field-card">' +
							'<div class="lessondesign-ai__ai-field-header">' +
								'<h5>' + escapeHtml((aiFieldLabels[section] && aiFieldLabels[section][field]) || field) + '</h5>' +
								'<button class="lessondesign-ai__button" type="button" data-ai-apply-field="' + escapeHtml(field) + '">' +
									escapeHtml(strings.aiApplyField || 'Apply Field') +
								'</button>' +
							'</div>' +
							'<div class="lessondesign-ai__ai-field-value">' + renderAIFieldValue(sectionPatch[field]) + '</div>' +
						'</article>'
					);
				}).join('') +
			'</section>'
		);
	}

	function renderAIFieldValue(value) {
		if (Array.isArray(value)) {
			return value.map(function (item) {
				return escapeHtml(String(item || ''));
			}).join('<br>');
		}

		return escapeHtml(String(value || '')).replace(/\n/g, '<br>');
	}

	function getAjaxErrorMessage(result) {
		if (result && result.data && typeof result.data === 'object' && result.data.message) {
			return String(result.data.message);
		}

		if (result && typeof result.data === 'string') {
			return result.data;
		}

		return strings.aiRequestFailed || 'AI Assist ran into a problem. Please try again in a moment.';
	}

	function populateSelects(root, state) {
		var trackSelect = root.querySelector('[data-bind="curriculum.track"]');
		var gradeSelect = root.querySelector('[data-bind="curriculum.grade"]');
		var current = (state && state.curriculum) || {};
		normalizeCurriculumSelectorDefaults(current);

		if (trackSelect) {
			var tracks = getAlbertaSubjectTracks();
			if (current.track && !isAlbertaSubjectTrack(getCurriculumTrackById(current.track))) {
				clearCurriculumTrackSelection(current);
			}
			setSelectOptions(trackSelect, tracks, 'Choose A Subject', getAlbertaSubjectTrackLabel);
			trackSelect.value = tracks.some(function (track) {
				return track.id === current.track;
			}) ? current.track : '';
		}

		if (gradeSelect) {
			setSelectOptions(
				gradeSelect,
				(curriculumSourcesData.gradeLevels || curriculumData.grades || []).filter(function (item) {
					return ALBERTA_GRADE_IDS.indexOf(item.id) > -1;
				}),
				'Choose A Grade'
			);
		}
	}

	function normalizeCurriculumSelectorDefaults(curriculum) {
		var selectedTrackIds;
		if (!curriculum) {
			return;
		}
		curriculum.country = ALBERTA_COUNTRY_ID;
		curriculum.jurisdiction = ALBERTA_JURISDICTION_ID;
		curriculum.framework = ALBERTA_FRAMEWORK_ID;
		curriculum.program = ALBERTA_PROGRAM_ID;
		if (curriculum.grade && ALBERTA_GRADE_IDS.indexOf(curriculum.grade) === -1) {
			curriculum.grade = '';
		}
		selectedTrackIds = getCurriculumTrackIds(curriculum);
		curriculum.tracks = selectedTrackIds;
		curriculum.track = isAlbertaSubjectTrack(getCurriculumTrackById(curriculum.track)) ? curriculum.track : (selectedTrackIds[0] || '');
		if (!selectedTrackIds.length) {
			clearCurriculumTrackSelection(curriculum);
		} else {
			applyCurriculumTrackToState(curriculum);
		}
	}

	function isAlbertaSubjectTrack(track) {
		return !!track &&
			track.country === ALBERTA_COUNTRY_ID &&
			track.jurisdictionId === ALBERTA_JURISDICTION_ID &&
			track.frameworkId === ALBERTA_FRAMEWORK_ID &&
			track.programId === ALBERTA_PROGRAM_ID;
	}

	function getAlbertaSubjectTrackLabel(track) {
		var subjectLabel = getLabelFromSource(curriculumSourcesData.subjects || [], track.subject);
		return subjectLabel || track.label || track.id;
	}

	function getCurriculumTrackDisplayLabel(trackId) {
		var track = getCurriculumTrackById(trackId);
		if (isAlbertaSubjectTrack(track)) {
			return getAlbertaSubjectTrackLabel(track);
		}
		return getLabelFromSource(curriculumSourcesData.curriculumTracks || [], trackId);
	}

	function getCurriculumTrackDisplaySummary(curriculum) {
		var labels = getCurriculumTracks(curriculum).map(function (track) {
			return getAlbertaSubjectTrackLabel(track);
		}).filter(Boolean);

		if (labels.length) {
			return labels.join(', ');
		}

		return getCurriculumTrackDisplayLabel(curriculum && curriculum.track);
	}

	function getAlbertaSubjectTracks() {
		return (curriculumSourcesData.curriculumTracks || []).filter(function (item) {
			return isAlbertaSubjectTrack(item);
		});
	}

	function getCurriculumTrackIds(curriculum) {
		var ids = [];
		if (curriculum && curriculum.track) {
			ids.push(curriculum.track);
		}
		if (curriculum && Array.isArray(curriculum.tracks)) {
			ids = ids.concat(curriculum.tracks);
		}

		return uniqueArray(ids).filter(function (id) {
			return isAlbertaSubjectTrack(getCurriculumTrackById(id));
		});
	}

	function getCurriculumTracks(curriculum) {
		return getCurriculumTrackIds(curriculum).map(function (id) {
			return getCurriculumTrackById(id);
		}).filter(Boolean);
	}

	function setCurriculumTrackIds(curriculum, ids) {
		curriculum.tracks = uniqueArray(ids || []).filter(function (id) {
			return isAlbertaSubjectTrack(getCurriculumTrackById(id));
		});
		curriculum.track = curriculum.tracks[0] || '';
		if (curriculum.track) {
			applyCurriculumTrackToState(curriculum);
		} else {
			clearCurriculumTrackSelection(curriculum);
		}
	}

	function setSelectOptions(select, items, placeholder, getLabelFn, getDisabledFn) {
		var value = select.value;
		select.innerHTML = '<option value="">' + escapeHtml(placeholder) + '</option>';

		items.forEach(function (item) {
			var option = document.createElement('option');
			option.value = item.id;
			option.textContent = getLabelFn ? getLabelFn(item) : item.label;
			if (getDisabledFn && getDisabledFn(item)) {
				option.disabled = true;
			}
			select.appendChild(option);
		});

		select.value = Array.prototype.some.call(select.options, function (option) {
			return option.value === value && !option.disabled;
		}) ? value : '';
	}

	function getLabelFromSource(items, id, labelKey) {
		items = items || [];
		var key = String(labelKey || 'label') + '|' + String(id || '') + '|' + String(items.length) + '|' + String((items[0] && items[0].id) || '') + '|' + String((items[items.length - 1] && items[items.length - 1].id) || '');
		if (labelCache[key] !== undefined) {
			return labelCache[key];
		}
		var found = items.find(function (item) {
			return item.id === id;
		});

		if (!found) {
			labelCache[key] = '';
			return '';
		}

		labelCache[key] = found[labelKey || 'label'] || found.label || '';
		return labelCache[key];
	}

	function getCurriculumTrackById(id) {
		return curriculumTrackById[id] || null;
	}

	function clearCurriculumTrackSelection(curriculum) {
		curriculum.track = '';
		curriculum.tracks = [];
		curriculum.country = ALBERTA_COUNTRY_ID;
		curriculum.jurisdiction = ALBERTA_JURISDICTION_ID;
		curriculum.framework = ALBERTA_FRAMEWORK_ID;
		curriculum.program = ALBERTA_PROGRAM_ID;
		curriculum.subjectArea = '';
		curriculum.subject = '';
	}

	function applyCurriculumTrackToState(curriculum) {
		var trackIds;
		var track;
		if (!curriculum) {
			return false;
		}

		trackIds = getCurriculumTrackIds(curriculum);
		curriculum.tracks = trackIds;
		curriculum.track = trackIds[0] || '';
		if (!curriculum.track) {
			return false;
		}

		track = getCurriculumTrackById(curriculum.track);
		if (
			!track ||
			!isAlbertaSubjectTrack(track)
		) {
			clearCurriculumTrackSelection(curriculum);
			return false;
		}

		curriculum.country = ALBERTA_COUNTRY_ID;
		curriculum.jurisdiction = ALBERTA_JURISDICTION_ID;
		curriculum.framework = ALBERTA_FRAMEWORK_ID;
		curriculum.program = ALBERTA_PROGRAM_ID;
		curriculum.subjectArea = track.subjectAreaId || '';
		curriculum.subject = track.subject || '';
		return true;
	}

	function inferCurriculumTrackId(curriculum) {
		if (!curriculum) {
			return '';
		}

		if (getCurriculumTrackById(curriculum.track)) {
			return curriculum.track;
		}

		var framework = ALBERTA_FRAMEWORK_ID;
		var subject = curriculum.subject || '';
		var subjectArea = curriculum.subjectArea || '';
		var candidates = (curriculumSourcesData.curriculumTracks || []).filter(function (track) {
			return isAlbertaSubjectTrack(track) &&
				track.frameworkId === framework &&
				(!subjectArea || track.subjectAreaId === subjectArea) &&
				(!subject || track.subject === subject);
		});

		return candidates.length === 1 ? candidates[0].id : '';
	}

	function bindFieldUpdates(root, state, onStateChange) {
		root.querySelectorAll('[data-bind]').forEach(function (field) {
			var bindPath = field.getAttribute('data-bind') || '';

			var handler = function () {
				if (field.type === 'radio' && !field.checked) {
					return;
				}
				updateBoundField(field, state);
				if (bindPath === 'curriculum.track') {
					applyCurriculumTrackToState(state.curriculum);
				}
				if (['curriculum.track', 'curriculum.grade'].indexOf(bindPath) > -1) {
					if (bindPath !== 'curriculum.track') {
						state.selectedStandards = [];
					}
					populateSelects(root, state);
					applyStateToForm(root, state);
				}
				onStateChange(bindPath);
			};
			if (field.tagName === 'SELECT' || field.type === 'radio') {
				field.addEventListener('change', handler);
			} else {
				field.addEventListener('input', handler);
			}
		});

		root.querySelectorAll('[data-array-bind]').forEach(function (field) {
			field.addEventListener('change', function () {
				updateArrayBoundField(field, state);
				onStateChange(field.getAttribute('data-array-bind'));
			});
		});
	}

	function bindStepNavigation(root, onStepChange) {
		root.querySelectorAll('[data-step-target], [data-next-step], [data-prev-step]').forEach(function (button) {
			button.addEventListener('click', function () {
				var nextStep = button.getAttribute('data-step-target') || button.getAttribute('data-next-step') || button.getAttribute('data-prev-step');
				if (nextStep) {
					onStepChange(nextStep);
				}
			});
		});
	}

	function updateStepView(root, currentStep) {
		root.setAttribute('data-current-step', currentStep);
		var currentIndex = stepDefinitions.findIndex(function (definition) {
			return definition.id === currentStep;
		});

		root.querySelectorAll('[data-step-target]').forEach(function (button) {
			var target = button.getAttribute('data-step-target');
			var targetIndex = stepDefinitions.findIndex(function (definition) {
				return definition.id === target;
			});
			var isActive = target === currentStep;
			var isComplete = targetIndex > -1 && currentIndex > -1 && targetIndex < currentIndex;
			var isUpcoming = targetIndex > -1 && currentIndex > -1 && targetIndex > currentIndex;
			button.classList.toggle('is-active', isActive);
			button.classList.toggle('is-complete', isComplete);
			button.classList.toggle('is-upcoming', isUpcoming);
			if (isActive) {
				button.setAttribute('aria-current', 'step');
			} else {
				button.removeAttribute('aria-current');
			}
		});

		root.querySelectorAll('[data-step-panel]').forEach(function (panel) {
			var isActive = panel.getAttribute('data-step-panel') === currentStep;
			panel.classList.toggle('is-active', isActive);
			panel.hidden = !isActive;
		});

		if (currentStep !== 'ready') {
			root.classList.remove('is-preview-visible');
		}
		updatePreviewToggleText(root);
	}

	function scrollStepIntoView(root, currentStep) {
		var panel = root.querySelector('[data-step-panel="' + currentStep + '"]');
		if (!panel) {
			return;
		}

		var target = root.querySelector('.lessondesign-ai__steps') || panel;
		scrollNodeIntoPlannerView(root, target);
	}

	function scrollNodeIntoPlannerView(root, target) {
		if (!target) {
			return;
		}

		var prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		var plannerHeader = root.querySelector('.ldai-header');
		var adminBar = document.getElementById('wpadminbar');
		var headerOffset = plannerHeader ? plannerHeader.getBoundingClientRect().height : 0;
		var adminOffset = adminBar ? adminBar.getBoundingClientRect().height : 0;
		var scrollTop = target.getBoundingClientRect().top + window.pageYOffset - headerOffset - adminOffset - 12;

		scrollPlannerTo(scrollTop, prefersReducedMotion);
	}

	function scrollPlannerTo(scrollTop, immediate) {
		var targetTop = Math.max(0, Math.round(scrollTop));

		if (plannerScrollFrame && window.cancelAnimationFrame) {
			window.cancelAnimationFrame(plannerScrollFrame);
			plannerScrollFrame = null;
		}

		window.scrollTo(0, targetTop);
	}

	function updatePreviewToggleText(root) {
		var viewButton = root.querySelector('[data-view-preview]');
		if (!viewButton) {
			return;
		}

		viewButton.textContent = root.classList.contains('is-preview-visible')
			? 'Hide Lesson Plan Preview'
			: 'View Lesson Plan';
	}

	function updateBoundField(field, state) {
		var path = field.getAttribute('data-bind');
		if (!path) {
			return;
		}
		if (field.type === 'radio') {
			if (field.checked) {
				setValueAtPath(state, path, field.value);
			}
			return;
		}
		setValueAtPath(state, path, field.value);
	}

	function updateArrayBoundField(field, state) {
		var path = field.getAttribute('data-array-bind');
		if (!path) {
			return;
		}

		var current = getValueAtPath(state, path);
		var next = Array.isArray(current) ? current.slice() : [];
		var value = field.value;

		if (field.checked) {
			if (next.indexOf(value) === -1) {
				next.push(value);
			}
		} else {
			next = next.filter(function (item) {
				return item !== value;
			});
		}

		setValueAtPath(state, path, uniqueArray(next));
	}

	function applyStateToForm(root, state) {
		root.querySelectorAll('[data-bind]').forEach(function (field) {
			var value = getValueAtPath(state, field.getAttribute('data-bind'));
			if (field.type === 'radio') {
				field.checked = field.value === value;
				return;
			}
			field.value = typeof value === 'string' ? value : '';
		});

		root.querySelectorAll('[data-array-bind]').forEach(function (field) {
			var values = getValueAtPath(state, field.getAttribute('data-array-bind'));
			field.checked = Array.isArray(values) && values.indexOf(field.value) > -1;
		});
	}

	function createInitialState() {
		return normalizeState(mergeState(defaults, loadState()));
	}

	function hasMeaningfulDraftContent(state) {
		if (!state || !isPlainObject(state)) {
			return false;
		}

		return [
			state.foundation && state.foundation.title,
			state.foundation && state.foundation.prompt,
			state.foundation && state.foundation.overview,
			state.foundation && state.foundation.learnerContext,
			state.foundation && state.foundation.learningGoals,
			state.foundation && state.foundation.successCriteria,
			state.foundation && state.foundation.formativeAssessment,
			state.foundation && state.foundation.summativeAssessment,
			state.curriculum && state.curriculum.grade,
			state.curriculum && state.curriculum.track,
			state.connections && state.connections.note,
			state.design && state.design.learningActivities,
			state.design && state.design.materials,
			state.design && state.design.technology,
			state.design && state.design.differentiation,
			state.design && state.design.teacherNotes
		].some(hasNonEmptyText)
			|| (Array.isArray(state.selectedStandards) && state.selectedStandards.length > 0)
			|| (Array.isArray(state.selectedResources) && state.selectedResources.length > 0)
			|| (state.design && Array.isArray(state.design.transferableSkills) && state.design.transferableSkills.length > 0)
			|| (state.design && Array.isArray(state.design.crrpChecks) && state.design.crrpChecks.length > 0);
	}

	function markSaved(state) {
		if (!state.meta || !isPlainObject(state.meta)) {
			state.meta = {};
		}
		state.meta.lastSaved = new Date().toISOString();
	}

	function saveState(state) {
		try {
			window.localStorage.setItem(storageKey, JSON.stringify(state));
		} catch (error) {
			// Ignore storage failures in private or restricted contexts.
		}
	}

	function loadState() {
		try {
			var raw = window.localStorage.getItem(storageKey);
			return raw ? JSON.parse(raw) : {};
		} catch (error) {
			return {};
		}
	}

	function mergeState(baseState, savedState) {
		var output = clone(baseState);
		Object.keys(savedState || {}).forEach(function (key) {
			if (!Object.prototype.hasOwnProperty.call(output, key)) {
				return;
			}
			if (Array.isArray(output[key])) {
				output[key] = Array.isArray(savedState[key]) ? savedState[key] : output[key];
			} else if (isPlainObject(output[key])) {
				output[key] = Object.assign({}, output[key], savedState[key] || {});
			} else {
				output[key] = savedState[key];
			}
		});
		return output;
	}

	function replaceState(target, nextState) {
		Object.keys(target).forEach(function (key) {
			delete target[key];
		});
		Object.keys(nextState || {}).forEach(function (key) {
			target[key] = nextState[key];
		});
	}

	function normalizeState(state) {
		var output = clone(state);
		if (!output.curriculum || !isPlainObject(output.curriculum)) {
			output.curriculum = {};
		}
		normalizeCurriculumSelectorDefaults(output.curriculum);
		output.curriculum.country = output.curriculum.country || ALBERTA_COUNTRY_ID;
		output.curriculum.track = output.curriculum.track || '';
		output.curriculum.tracks = getCurriculumTrackIds(output.curriculum);
		output.curriculum.jurisdiction = ALBERTA_JURISDICTION_ID;
		output.curriculum.framework = ALBERTA_FRAMEWORK_ID;
		output.curriculum.program = output.curriculum.program || ALBERTA_PROGRAM_ID;
		output.curriculum.subjectArea = output.curriculum.subjectArea || '';
		output.curriculum.subject = output.curriculum.subject || '';
		if (!output.curriculum.tracks.length) {
			output.curriculum.track = inferCurriculumTrackId(output.curriculum);
			output.curriculum.tracks = output.curriculum.track ? [output.curriculum.track] : [];
		}
		if (output.curriculum.track) {
			applyCurriculumTrackToState(output.curriculum);
		}
		output.selectedStandards = expandStandardIds(uniqueArray(Array.isArray(output.selectedStandards) ? output.selectedStandards : [])).filter(function (id) {
			var standard = getStandardById(id);
			return (standard !== null && standardMatchesCurriculum(standard, output.curriculum)) || (!!curriculumManifestData.shards && standard === null);
		});
		output.selectedResources = uniqueArray(Array.isArray(output.selectedResources) ? output.selectedResources : []).filter(function (id) {
			return (!resourcesLoaded && !!(appData.dataUrls || {}).resources) || getResourceById(id) !== null;
		});

		if (!output.connections || !isPlainObject(output.connections)) {
			output.connections = { mode: 'guided', note: '' };
		}

		if (output.connections.mode !== 'browse') {
			output.connections.mode = 'guided';
		}

		if (!output.meta || !isPlainObject(output.meta)) {
			output.meta = { lastSaved: '' };
		}

		if (!output.design || !isPlainObject(output.design)) {
			output.design = {};
		}

		output.design.transferableSkills = uniqueArray(Array.isArray(output.design.transferableSkills) ? output.design.transferableSkills : []);
		output.design.crrpChecks = uniqueArray(Array.isArray(output.design.crrpChecks) ? output.design.crrpChecks : []);

		return output;
	}

	function clone(value) {
		return JSON.parse(JSON.stringify(value));
	}

	function hasNonEmptyText(value) {
		return typeof value === 'string' && value.trim() !== '';
	}

	function buildReadinessItems(state) {
		var selectedCurriculumPieces = getSelectedCurriculumPieces(state);
		var selectedResources = getSelectedResources(state);
		var hasLessonIdea = hasNonEmptyText(state.foundation.title) && (hasNonEmptyText(state.foundation.prompt) || hasNonEmptyText(state.foundation.overview));
		var hasLearningTargets = hasNonEmptyText(state.foundation.learningGoals) && hasNonEmptyText(state.foundation.successCriteria);
		var hasAssessment = hasNonEmptyText(state.foundation.formativeAssessment) || hasNonEmptyText(state.foundation.summativeAssessment);
		var hasCurriculum = hasNonEmptyText(state.curriculum.grade) && getCurriculumTrackIds(state.curriculum).length > 0 && selectedCurriculumPieces.length > 0;
		var hasConnection = selectedResources.length > 0 || hasNonEmptyText(state.connections.note);
		var hasLearningSequence = hasNonEmptyText(state.design.learningActivities);
		var hasLearnerSupport = hasNonEmptyText(state.design.differentiation) || (Array.isArray(state.design.crrpChecks) && state.design.crrpChecks.length > 0);

		return [
			{
				status: hasLessonIdea ? 'complete' : 'attention',
				title: 'Lesson Idea',
				message: hasLessonIdea ? 'Title and central idea are present.' : 'Add a title plus a prompt or overview so the plan has a clear purpose.',
				section: SECTION_IDS.lessonIdea
			},
			{
				status: hasLearningTargets ? 'complete' : 'attention',
				title: 'Learning Objectives',
				message: hasLearningTargets ? 'Learning goals and success criteria are present.' : 'Add learning goals and success criteria before sharing the plan.',
				section: SECTION_IDS.learningObjectives
			},
			{
				status: hasAssessment ? 'complete' : 'attention',
				title: 'Assessment Evidence',
				message: hasAssessment ? 'At least one assessment note is present.' : 'Add formative or summative assessment notes so the evidence of learning is visible.',
				section: SECTION_IDS.assessment
			},
			{
				status: hasCurriculum ? 'complete' : 'attention',
				title: 'Curriculum Pieces',
				message: hasCurriculum ? selectedCurriculumPieces.length + ' curriculum piece' + (selectedCurriculumPieces.length === 1 ? ' is' : 's are') + ' selected.' : 'Choose your grade, at least one subject, and at least one curriculum piece.',
				section: SECTION_IDS.curriculum
			},
			{
				status: hasConnection ? 'complete' : 'attention',
				title: 'Learning Connection',
				message: hasConnection ? 'The plan includes a selected resource or connection note.' : 'Add a Learning Connection or a note explaining the connection you want.',
				section: SECTION_IDS.connections
			},
			{
				status: hasLearningSequence ? 'complete' : 'attention',
				title: 'Learning Sequence',
				message: hasLearningSequence ? 'Learning activities are present.' : 'Add the learning activities or instructional sequence teachers will follow.',
				section: SECTION_IDS.learningSequence
			},
			{
				status: hasLearnerSupport ? 'complete' : 'attention',
				title: 'Learner Support',
				message: hasLearnerSupport ? 'Differentiation or CRRP support is present.' : 'Add differentiation, accessibility, or culturally responsive learning supports.',
				section: SECTION_IDS.learnerSupport
			},
			{
				status: hasAccountAccess() ? 'complete' : 'attention',
				title: 'Save Destination',
				message: hasAccountAccess()
					? 'This draft can sync to the teacher account.'
					: (appData.isLoggedIn
						? 'This draft is saved in this browser until LessonDesign access is active for this account.'
						: 'This draft is saved in this browser only until the teacher signs in.'),
				href: hasAccountAccess() || appData.isLoggedIn ? '' : appData.loginPageUrl,
				action: hasAccountAccess() || appData.isLoggedIn ? '' : 'Login',
				section: hasAccountAccess() ? SECTION_IDS.reviewExport : ''
			}
		];
	}

	function renderReadinessItem(item) {
		var action = '';
		var statusLabel = item.status === 'complete' ? 'Complete' : 'Needs attention';

		if (item.href) {
			action = '<a class="lessondesign-ai__readiness-action" href="' + escapeHtml(item.href) + '">' + escapeHtml(item.action || 'Open') + '</a>';
		} else if (item.section) {
			action = '<button class="lessondesign-ai__readiness-action" type="button" data-readiness-section="' + escapeHtml(item.section) + '">' + escapeHtml(item.status === 'complete' ? 'Edit' : 'Fix') + '</button>';
		}

		return (
			'<li class="lessondesign-ai__readiness-item is-' + escapeHtml(item.status) + '">' +
				'<span class="lessondesign-ai__readiness-dot" aria-hidden="true"></span>' +
				'<div class="lessondesign-ai__readiness-copy">' +
					'<strong>' + escapeHtml(item.title) + '</strong>' +
					'<span>' + escapeHtml(item.message) + '</span>' +
				'</div>' +
				'<span class="screen-reader-text">' + escapeHtml(statusLabel) + '</span>' +
				action +
			'</li>'
		);
	}

	/*
	 * "Suggested next step" cards. Only the two that point at real data are
	 * shown (choose grade/subject + curriculum pieces; add a top-ranked
	 * Learning Connection). Canned text fills were retired in favour of the AI
	 * prompt box; getTargetsSuggestion / getDesignSuggestion remain available.
	 */
	function getSectionSuggestion(section, state) {
		var suggestion;
		if (section === 'foundation') {
			return getCurriculumSuggestion(state);
		}

		if (section === 'connections') {
			suggestion = getConnectionsSuggestion(state);
			return suggestion && suggestion.apply && suggestion.apply.addSelectedResources ? suggestion : null;
		}

		return null;
	}

	function getFoundationSuggestion(state) {
		var foundation = state.foundation || {};

		if (!hasNonEmptyText(foundation.title) && hasNonEmptyText(foundation.prompt)) {
			var title = buildWorkingTitle(foundation.prompt);
			return {
				title: 'Add a working title',
				message: 'A short title helps the rest of the planner stay oriented. You can edit it anytime.',
				applyLabel: 'Use Title',
				apply: { fields: { 'foundation.title': title } },
				focusPath: 'foundation.title',
				appliedMessage: 'Working title added.'
			};
		}

		return getCurriculumSuggestion(state);
	}

	function getTargetsSuggestion(state) {
		var foundation = state.foundation || {};
		var topic = getLessonTopic(state);

		if (!hasNonEmptyText(foundation.learningGoals) && topic) {
			return {
				title: 'Draft learning goals',
				message: 'Use three plain-language goals as a starting point, then tune them to your class.',
				applyLabel: 'Fill Goals',
				apply: { fields: { 'foundation.learningGoals': buildLearningGoals(topic) } },
				focusPath: 'foundation.learningGoals',
				appliedMessage: 'Learning goals filled in.'
			};
		}

		if (!hasNonEmptyText(foundation.successCriteria) && hasNonEmptyText(foundation.learningGoals)) {
			return {
				title: 'Add success criteria',
				message: 'The goals are present. A few student-facing criteria will make the plan easier to teach from.',
				applyLabel: 'Fill Criteria',
				apply: { fields: { 'foundation.successCriteria': buildSuccessCriteria(topic) } },
				focusPath: 'foundation.successCriteria',
				appliedMessage: 'Success criteria filled in.'
			};
		}

		if (
			topic &&
			!hasNonEmptyText(foundation.formativeAssessment) &&
			!hasNonEmptyText(foundation.summativeAssessment)
		) {
			return {
				title: 'Add a quick evidence check',
				message: 'One formative assessment note is enough to keep evidence of learning visible at this stage.',
				applyLabel: 'Fill Assessment',
				apply: {
					fields: {
						'foundation.formativeAssessment': 'Use observation notes, student conferences, or a quick exit ticket to check how students are making sense of ' + topic + '.'
					}
				},
				focusPath: 'foundation.formativeAssessment',
				appliedMessage: 'Assessment note filled in.'
			};
		}

		return null;
	}

	function getCurriculumSuggestion(state) {
		var gradeLabel = getLabelFromSource(curriculumSourcesData.gradeLevels || curriculumData.grades || [], state.curriculum.grade);
		var selectedCurriculumPieces = getSelectedCurriculumPieces(state);

		if (!getCurriculumTrackIds(state.curriculum).length || !state.curriculum.grade) {
			return {
				title: 'Choose Your Grade And Subject',
				message: 'Choose your grade and subject so this section can suggest distinct focus areas.'
			};
		}

		if (!selectedCurriculumPieces.length) {
			var suggestions = getSuggestedCurriculumPieces(state);
			if (suggestions.length) {
				var suggestionCountLabel = suggestions.length === 1 ? 'one curriculum piece' : suggestions.length + ' curriculum pieces';
				var suggestionGradeLabel = gradeLabel ? ' for ' + gradeLabel : '';
				return {
					title: 'Select curriculum pieces',
					message: 'I found ' + suggestionCountLabel + ' that look like useful starting anchors' + suggestionGradeLabel + '. You can adjust them in the curriculum selector.',
					applyLabel: 'Select Pieces',
					apply: { setSelectedStandards: suggestions.map(function (item) { return item.id; }) },
					appliedMessage: 'Curriculum pieces selected.'
				};
			}
		}

		return null;
	}

	function getConnectionsSuggestion(state) {
		var selectedResources = getSelectedResources(state);

		if (!selectedResources.length) {
			var match = getTopSuggestedResource(state);
			if (match) {
				return {
					title: 'Add one likely Learning Connection',
					message: '"' + match.item.title + '" is ranking well from the lesson context. Add it as a starting connection, then adjust if needed.',
					applyLabel: 'Add Match',
					apply: {
						fields: { 'connections.mode': 'guided' },
						addSelectedResources: [match.item.id]
					},
					appliedMessage: 'Suggested Learning Connection added.'
				};
			}

			if (getLessonTopic(state)) {
				return {
					title: 'Narrow the connection',
					message: 'No strong guided match yet. Add a few more keywords, a curriculum prompt, or a search term to sharpen the results.'
				};
			}
		}

		if (selectedResources.length && !hasNonEmptyText(state.connections.note)) {
			return {
				title: 'Explain the connection',
				message: 'A one-sentence note will help teachers remember why this expert or tour belongs in the lesson.',
				applyLabel: 'Fill Note',
				apply: {
					fields: {
						'connections.note': buildConnectionNote(selectedResources)
					}
				},
				focusPath: 'connections.note',
				appliedMessage: 'Connection Notes filled in.'
			};
		}

		return null;
	}

	function getDesignSuggestion(state) {
		var design = state.design || {};
		var topic = getLessonTopic(state);
		var selectedResources = getSelectedResources(state);

		if (!hasNonEmptyText(design.learningActivities) && topic) {
			return {
				title: 'Sketch the lesson flow',
				message: 'Start with a four-part sequence. Keep what fits and replace the rest with your own teaching moves.',
				applyLabel: 'Fill Activities',
				apply: { fields: { 'design.learningActivities': buildLearningSequence(topic, selectedResources) } },
				focusPath: 'design.learningActivities',
				appliedMessage: 'Learning activities filled in.'
			};
		}

		if (!hasNonEmptyText(design.materials) && topic) {
			return {
				title: 'List starter materials',
				message: 'Add a practical materials list so the lesson is easier to prepare.',
				applyLabel: 'Fill Materials',
				apply: { fields: { 'design.materials': buildMaterialsList(selectedResources) } },
				focusPath: 'design.materials',
				appliedMessage: 'Materials filled in.'
			};
		}

		if (!hasNonEmptyText(design.technology) && selectedResources.length) {
			return {
				title: 'Name the required technology',
				message: 'Because this draft includes a Learning Connection, add the basic tech setup teachers may need.',
				applyLabel: 'Fill Technology',
				apply: { fields: { 'design.technology': buildTechnologyList(selectedResources) } },
				focusPath: 'design.technology',
				appliedMessage: 'Technology notes filled in.'
			};
		}

		if (!hasNonEmptyText(design.differentiation) && topic) {
			return {
				title: 'Add learner supports',
				message: 'A few accessibility and choice moves can keep the design usable for a wider range of learners.',
				applyLabel: 'Fill Supports',
				apply: { fields: { 'design.differentiation': buildDifferentiationNotes(topic) } },
				focusPath: 'design.differentiation',
				appliedMessage: 'Learner supports filled in.'
			};
		}

		return null;
	}

	function buildSectionSuggestionMarkup(suggestion) {
		var action = suggestion.apply && suggestion.applyLabel
			? '<button class="lessondesign-ai__coach-action" type="button" data-suggestion-apply>' + escapeHtml(suggestion.applyLabel) + '</button>'
			: '';

		return (
			'<article class="lessondesign-ai__coach-card">' +
				'<div class="lessondesign-ai__coach-copy">' +
					'<span>Suggested next step</span>' +
					'<strong>' + escapeHtml(suggestion.title) + '</strong>' +
					'<p>' + escapeHtml(suggestion.message) + '</p>' +
				'</div>' +
				action +
			'</article>'
		);
	}

	function applySuggestionPatch(state, patch) {
		if (patch.fields) {
			Object.keys(patch.fields).forEach(function (path) {
				setValueAtPath(state, path, patch.fields[path]);
			});
		}

		if (Array.isArray(patch.setSelectedStandards)) {
			state.selectedStandards = expandStandardIds(uniqueArray(patch.setSelectedStandards));
		}

		if (Array.isArray(patch.addSelectedStandards)) {
			state.selectedStandards = expandStandardIds(uniqueArray((state.selectedStandards || []).concat(patch.addSelectedStandards)));
		}

		if (Array.isArray(patch.setSelectedResources)) {
			state.selectedResources = uniqueArray(patch.setSelectedResources);
		}

		if (Array.isArray(patch.addSelectedResources)) {
			state.selectedResources = uniqueArray((state.selectedResources || []).concat(patch.addSelectedResources));
		}
	}

	function focusSuggestionTarget(root, suggestion) {
		var path = suggestion.focusPath || getFirstSuggestionFieldPath(suggestion.apply);
		var field;

		if (!path) {
			return;
		}

		field = root.querySelector('[data-bind="' + path + '"]');
		if (field && typeof field.focus === 'function') {
			try {
				field.focus({ preventScroll: true });
			} catch (error) {
				field.focus();
			}
		}
	}

	function getFirstSuggestionFieldPath(patch) {
		if (!patch || !patch.fields) {
			return '';
		}

		return Object.keys(patch.fields)[0] || '';
	}

	function getLessonTopic(state) {
		var foundation = state.foundation || {};
		var source = foundation.title || foundation.prompt || foundation.overview || foundation.learningGoals || '';
		return compactPhrase(simplifyPrompt(source), 10);
	}

	function buildWorkingTitle(prompt) {
		var phrase = compactPhrase(simplifyPrompt(prompt), 8);
		if (!phrase) {
			return 'New Lesson Plan';
		}
		return toTitleCase(phrase);
	}

	function simplifyPrompt(value) {
		return String(value || '')
			.replace(/^[\s"']+|[\s"'.?!]+$/g, '')
			.replace(/^how (do|does|can|could|might|should|will)\s+/i, '')
			.replace(/^what (is|are|can|could|might|should|will)\s+/i, '')
			.replace(/^why\s+/i, '')
			.replace(/^students (will\s+)?(investigate|explore|examine|learn about|understand|create|design|analyze|analyse|study)\s+/i, '')
			.replace(/\s+/g, ' ')
			.trim();
	}

	function compactPhrase(value, maxWords) {
		var words = String(value || '').split(/\s+/).filter(Boolean);
		if (!words.length) {
			return '';
		}
		return words.slice(0, maxWords).join(' ');
	}

	function toTitleCase(value) {
		var smallWords = ['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with'];
		return String(value || '').toLowerCase().split(/\s+/).map(function (word, index) {
			if (index > 0 && smallWords.indexOf(word) > -1) {
				return word;
			}
			return word.charAt(0).toUpperCase() + word.slice(1);
		}).join(' ');
	}

	function buildLearningGoals(topic) {
		return [
			'Students will investigate ' + topic + ' using evidence, examples, and discussion.',
			'Students will explain key ideas about ' + topic + ' in their own words.',
			'Students will apply their learning about ' + topic + ' through a product, conversation, or reflection.'
		].join('\n');
	}

	function buildSuccessCriteria(topic) {
		var target = topic || 'the lesson topic';
		return [
			'I can describe important ideas about ' + target + ' using clear language.',
			'I can use evidence or examples to support my thinking.',
			'I can share my learning in a way that others can understand.'
		].join('\n');
	}

	function getSuggestedCurriculumPieces(state) {
		var keywords = buildKeywordSet(state);
		return getMatchingExpectations(state).map(function (item) {
			var haystack = normalizeText([item.standardCode || item.code, item.strand, item.officialOutcomeText || item.summaryText || item.text, item.documentTitle, item.region].join(' '));
			var score = keywords.filter(function (keyword) {
				return haystack.indexOf(keyword) > -1;
			}).length;

			return {
				item: item,
				score: score
			};
		}).sort(function (left, right) {
			if (right.score !== left.score) {
				return right.score - left.score;
			}
			return (left.item.standardCode || left.item.code).localeCompare(right.item.standardCode || right.item.code);
		}).slice(0, 2).map(function (entry) {
			return entry.item;
		});
	}

	function getTopSuggestedResource(state) {
		return resourceRemoteResults.map(function (item) {
			return {
				item: item,
				score: Number(item.matchScore || 0)
			};
		}).filter(function (entry) {
			return entry.score > 0 && state.selectedResources.indexOf(entry.item.id) === -1;
		}).sort(function (left, right) {
			if (right.score !== left.score) {
				return right.score - left.score;
			}
			return left.item.title.localeCompare(right.item.title);
		})[0] || null;
	}

	function buildConnectionNote(resources) {
		var firstResource = resources[0];
		var label = firstResource ? firstResource.title : 'the selected Learning Connection';
		return label + ' will extend the lesson by bringing in an outside perspective, expert voice, or virtual experience students can connect back to their learning goals.';
	}

	function buildLearningSequence(topic, resources) {
		var connectionLine = resources.length
			? 'Connect: Use ' + resources[0].title + ' to bring in an expert, tour, or real-world perspective.'
			: 'Explore: Students investigate examples, evidence, or scenarios related to ' + topic + '.';

		return [
			'Minds on: Invite students to share what they notice, wonder, or already know about ' + topic + '.',
			connectionLine,
			'Create or practise: Students work individually or collaboratively to apply the key ideas.',
			'Consolidate: Students share learning, name evidence, and complete a short reflection or exit ticket.'
		].join('\n');
	}

	function buildMaterialsList(resources) {
		var materials = [
			'Teacher notes or slide deck',
			'Student notebooks, journals, or shared digital workspace',
			'Anchor chart or collaborative board',
			'Exit ticket or reflection prompt'
		];

		if (resources.length) {
			materials.splice(2, 0, 'Selected Learning Connection: ' + resources[0].title);
		}

		return materials.join('\n');
	}

	function buildTechnologyList(resources) {
		var technology = [
			'Class display or projector',
			'Teacher device with internet access',
			'Student devices as needed for shared notes, questions, or reflection'
		];

		if (resources.length) {
			technology.splice(1, 0, 'Access details for ' + resources[0].title);
		}

		return technology.join('\n');
	}

	function buildDifferentiationNotes(topic) {
		return [
			'Offer multiple ways to participate, such as speaking, drawing, writing, or using a digital response.',
			'Provide vocabulary, visuals, sentence starters, or examples for students who need additional access points.',
			'Allow choice in how students show their thinking about ' + topic + '.'
		].join('\n');
	}

	function buildPreviewHtml(state) {
		if (!state.foundation.title && !state.foundation.overview) {
			return '<p class="lessondesign-ai__empty">' + escapeHtml(strings.previewFallback || 'Start the planner to generate a lesson summary.') + '</p>';
		}

		var selectedCurriculumPieces = getSelectedCurriculumPieces(state);
		var selectedResources = getSelectedResources(state);
		var trackLabel = getCurriculumTrackDisplaySummary(state.curriculum);
		var gradeLabel = getLabelFromSource(curriculumSourcesData.gradeLevels || curriculumData.grades || [], state.curriculum.grade);

		return [
			renderPreviewSection('Lesson', [
				renderKeyValue('Title', state.foundation.title),
				renderKeyValue('Big Idea Or Prompt', state.foundation.prompt),
				renderKeyValue('Overview', state.foundation.overview),
				renderMultiline('Learner Context', state.foundation.learnerContext)
			]),
			renderPreviewSection('Learning And Assessment', [
				renderMultiline('Learning Goals', state.foundation.learningGoals),
				renderMultiline('Success Criteria', state.foundation.successCriteria),
				renderMultiline('Formative Assessment', state.foundation.formativeAssessment),
				renderMultiline('Summative Assessment', state.foundation.summativeAssessment)
			]),
			renderPreviewSection('Curriculum', [
				renderKeyValue('Jurisdiction', 'Alberta'),
				renderKeyValue('Subjects', trackLabel),
				renderKeyValue('Grade', gradeLabel),
				renderMultiline('Curriculum Pieces', selectedCurriculumPieces.map(function (item) {
					return formatStandardLine(item);
				}).join('\n'))
			]),
			renderPreviewSection('Learning Connections', [
				renderKeyValue('Selection Mode', state.connections.mode === 'browse' ? 'Manual Browse' : 'Guided Suggestions'),
				renderMultiline('Selected Resources', selectedResources.map(function (item) {
					return item.title + ' (' + (item.kind === 'expert' ? 'Expert' : 'Virtual Tour') + ')';
				}).join('\n')),
				renderKeyValue('Connection Notes', state.connections.note)
			]),
			renderPreviewSection('Design', [
				renderMultiline('Learning Activities', state.design.learningActivities),
				renderMultiline('Materials', state.design.materials),
				renderMultiline('Technology', state.design.technology),
				renderMultiline('Differentiation And Accessibility', state.design.differentiation),
				renderMultiline('Transferable Skills', joinLines(state.design.transferableSkills)),
				renderMultiline('CRRP', joinLines(state.design.crrpChecks)),
				renderMultiline('Additional Notes', state.design.teacherNotes)
			])
		].join('');
	}

	function buildSummaryText(state) {
		var selectedCurriculumPieces = getSelectedCurriculumPieces(state);
		var selectedResources = getSelectedResources(state);
		var trackLabel = getCurriculumTrackDisplaySummary(state.curriculum);
		var gradeLabel = getLabelFromSource(curriculumSourcesData.gradeLevels || curriculumData.grades || [], state.curriculum.grade);

		return [
			'LessonDesign AI Lesson Summary',
			'',
			'Lesson',
			'------',
			'Title: ' + fallback(state.foundation.title),
			'Big Idea Or Prompt: ' + fallback(state.foundation.prompt),
			'Overview: ' + fallback(state.foundation.overview),
			formatTextBlock('Learner Context', state.foundation.learnerContext),
			'',
			'Learning And Assessment',
			'-----------------------',
			formatTextBlock('Learning Goals', state.foundation.learningGoals),
			formatTextBlock('Success Criteria', state.foundation.successCriteria),
			formatTextBlock('Formative Assessment', state.foundation.formativeAssessment),
			formatTextBlock('Summative Assessment', state.foundation.summativeAssessment),
			'',
			'Curriculum',
			'----------',
			'Jurisdiction: Alberta',
			'Subjects: ' + fallback(trackLabel),
			'Grade: ' + fallback(gradeLabel),
			formatTextBlock('Curriculum Pieces', selectedCurriculumPieces.map(function (item) {
				return formatStandardExportLine(item);
			}).join('\n')),
			'',
			'Learning Connections',
			'--------------------',
			'Selection Mode: ' + (state.connections.mode === 'browse' ? 'Manual Browse' : 'Guided Suggestions'),
			formatTextBlock('Selected Resources', selectedResources.map(function (item) {
				return item.title + ' (' + (item.kind === 'expert' ? 'Expert' : 'Virtual Tour') + ')';
			}).join('\n')),
			'Connection Notes: ' + fallback(state.connections.note),
			'',
			'Design',
			'------',
			formatTextBlock('Learning Activities', state.design.learningActivities),
			formatTextBlock('Materials', state.design.materials),
			formatTextBlock('Technology', state.design.technology),
			formatTextBlock('Differentiation And Accessibility', state.design.differentiation),
			formatTextBlock('Transferable Skills', joinLines(state.design.transferableSkills)),
			formatTextBlock('CRRP', joinLines(state.design.crrpChecks)),
			formatTextBlock('Additional Notes', state.design.teacherNotes)
		].join('\n');
	}

	function buildLessonPlanPdf(state) {
		var selectedCurriculumPieces = getSelectedCurriculumPieces(state);
		var selectedResources = getSelectedResources(state);
		var trackLabel = getCurriculumTrackDisplaySummary(state.curriculum);
		var gradeLabel = getLabelFromSource(curriculumSourcesData.gradeLevels || curriculumData.grades || [], state.curriculum.grade);
		var writer = createPdfWriter(fallback(state.foundation.title));

		writer.addCover(
			fallback(state.foundation.title),
			[
				['Jurisdiction', 'Alberta'],
				['Subjects', fallback(trackLabel)],
				['Grade', fallback(gradeLabel)]
			]
		);
		writer.addSection('Lesson', [
			{ label: 'Big Idea Or Prompt', value: state.foundation.prompt },
			{ label: 'Overview', value: state.foundation.overview },
			{ label: 'Learner Context', value: state.foundation.learnerContext }
		]);
		writer.addSection('Learning And Assessment', [
			{ label: 'Learning Goals', value: state.foundation.learningGoals },
			{ label: 'Success Criteria', value: state.foundation.successCriteria },
			{ label: 'Formative Assessment', value: state.foundation.formativeAssessment },
			{ label: 'Summative Assessment', value: state.foundation.summativeAssessment }
		]);
		writer.addSection('Curriculum', [
			{ label: 'Curriculum Pieces', value: selectedCurriculumPieces.map(function (item) {
				return formatStandardExportLine(item);
			}).join('\n'), list: true }
		]);
		writer.addSection('Learning Connections', [
			{ label: 'Selection Mode', value: state.connections.mode === 'browse' ? 'Manual Browse' : 'Guided Suggestions' },
			{ label: 'Selected Resources', value: selectedResources.map(function (item) {
				return item.title + ' (' + (item.kind === 'expert' ? 'Expert' : 'Virtual Tour') + ')';
			}).join('\n'), list: true },
			{ label: 'Connection Notes', value: state.connections.note }
		]);
		writer.addSection('Design', [
			{ label: 'Learning Activities', value: state.design.learningActivities, list: true },
			{ label: 'Materials', value: state.design.materials, list: true },
			{ label: 'Technology', value: state.design.technology, list: true },
			{ label: 'Differentiation And Accessibility', value: state.design.differentiation, list: true },
			{ label: 'Transferable Skills', value: joinLines(state.design.transferableSkills), list: true },
			{ label: 'CRRP', value: joinLines(state.design.crrpChecks), list: true },
			{ label: 'Additional Notes', value: state.design.teacherNotes }
		]);

		return writer.finish();
	}

	function createPdfWriter(documentTitle) {
		var pageWidth = 612;
		var pageHeight = 792;
		var margin = 48;
		var footerY = 28;
		var contentWidth = pageWidth - margin * 2;
		var pages = [];
		var commands = [];
		var y = pageHeight - margin;
		var currentSectionColor = [45, 92, 133];

		startPage();

		function startPage() {
			commands = [];
			y = pageHeight - margin;
			if (pages.length > 0) {
				drawText(margin, y, fallback(documentTitle), 'bold', 10, [45, 92, 133]);
				drawLine(margin, y - 10, pageWidth - margin, y - 10, [218, 227, 235], 1);
				y -= 34;
			}
		}

		function finishPage() {
			var pageNumber = pages.length + 1;
			drawLine(margin, footerY + 16, pageWidth - margin, footerY + 16, [218, 227, 235], 1);
			drawText(margin, footerY, 'LessonDesign AI', 'bold', 9, [45, 92, 133]);
			drawText(pageWidth - margin - 46, footerY, 'Page ' + pageNumber, 'regular', 9, [103, 116, 128]);
			pages.push(commands.join('\n'));
		}

		function ensureSpace(height) {
			if (y - height < footerY + 34) {
				finishPage();
				startPage();
			}
		}

		function addCover(title, metadata) {
			var i;
			drawRect(0, pageHeight - 118, pageWidth, 118, [20, 50, 74]);
			drawRect(0, pageHeight - 124, pageWidth, 6, [232, 152, 62]);
			drawText(margin, pageHeight - 62, 'Lesson Plan', 'bold', 13, [255, 255, 255]);
			drawWrappedText(title, margin, pageHeight - 91, contentWidth, 'bold', 24, [255, 255, 255], 28);
			y = pageHeight - 154;

			for (i = 0; i < metadata.length; i += 1) {
				drawText(margin + i * 172, y, metadata[i][0], 'bold', 8, [103, 116, 128]);
				drawText(margin + i * 172, y - 16, metadata[i][1], 'regular', 12, [20, 50, 74]);
			}
			y -= 46;
		}

		function addSection(title, items) {
			var i;
			var visibleItems = (items || []).filter(function (item) {
				return hasNonEmptyText(item.value);
			});
			if (!visibleItems.length) {
				return;
			}

			ensureSpace(44);
			drawRect(margin, y - 24, 4, 24, [232, 152, 62]);
			drawText(margin + 12, y - 18, title, 'bold', 15, currentSectionColor);
			y -= 38;

			for (i = 0; i < visibleItems.length; i += 1) {
				addItem(visibleItems[i]);
			}
			y -= 8;
		}

		function addItem(item) {
			var lines = splitPdfLines(item.value);
			var i;
			var labelHeight = 14;
			if (!lines.length) {
				return;
			}

			ensureSpace(34);
			drawText(margin, y, item.label, 'bold', 9, [20, 50, 74]);
			y -= labelHeight;

			if (item.list) {
				for (i = 0; i < lines.length; i += 1) {
					addBullet(lines[i]);
				}
			} else {
				drawParagraph(lines.join(' '), margin, contentWidth, 'regular', 10.5, [45, 55, 72], 15);
			}
			y -= 8;
		}

		function addBullet(text) {
			var bulletX = margin + 4;
			var textX = margin + 16;
			var wrapped = wrapPdfText(text, contentWidth - 16, 10);
			var i;
			for (i = 0; i < wrapped.length; i += 1) {
				ensureSpace(18);
				if (i === 0) {
					drawText(bulletX, y, '-', 'bold', 10, [232, 152, 62]);
				}
				drawText(textX, y, wrapped[i], 'regular', 10, [45, 55, 72]);
				y -= 14;
			}
			y -= 4;
		}

		function drawParagraph(text, x, width, font, size, color, lineHeight) {
			var wrapped = wrapPdfText(text, width, size);
			var i;
			for (i = 0; i < wrapped.length; i += 1) {
				ensureSpace(lineHeight);
				drawText(x, y, wrapped[i], font, size, color);
				y -= lineHeight;
			}
		}

		function drawWrappedText(text, x, topY, width, font, size, color, lineHeight) {
			var wrapped = wrapPdfText(text, width, size);
			var i;
			for (i = 0; i < wrapped.length; i += 1) {
				drawText(x, topY - i * lineHeight, wrapped[i], font, size, color);
			}
		}

		function drawText(x, textY, text, font, size, color) {
			var fontName = font === 'bold' ? 'F2' : 'F1';
			commands.push(
				'BT ' +
				pdfColor(color) + ' rg ' +
				'/' + fontName + ' ' + formatPdfNumber(size) + ' Tf ' +
				formatPdfNumber(x) + ' ' + formatPdfNumber(textY) + ' Td ' +
				'(' + escapePdfText(text) + ') Tj ET'
			);
		}

		function drawRect(x, rectY, width, height, color) {
			commands.push(
				'q ' +
				pdfColor(color) + ' rg ' +
				formatPdfNumber(x) + ' ' + formatPdfNumber(rectY) + ' ' +
				formatPdfNumber(width) + ' ' + formatPdfNumber(height) + ' re f Q'
			);
		}

		function drawLine(x1, y1, x2, y2, color, width) {
			commands.push(
				'q ' +
				pdfColor(color) + ' RG ' +
				formatPdfNumber(width) + ' w ' +
				formatPdfNumber(x1) + ' ' + formatPdfNumber(y1) + ' m ' +
				formatPdfNumber(x2) + ' ' + formatPdfNumber(y2) + ' l S Q'
			);
		}

		function finish() {
			if (commands.length) {
				finishPage();
			}
			return assemblePdf(pages, pageWidth, pageHeight);
		}

		return {
			addCover: addCover,
			addSection: addSection,
			finish: finish
		};
	}

	function assemblePdf(pageStreams, pageWidth, pageHeight) {
		var objects = [];
		var pageObjectNumbers = [];
		var i;
		var contentObjectNumber;
		var pageObjectNumber;
		var kids;

		objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
		objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
		objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>';

		for (i = 0; i < pageStreams.length; i += 1) {
			pageObjectNumber = 5 + i * 2;
			contentObjectNumber = pageObjectNumber + 1;
			pageObjectNumbers.push(pageObjectNumber + ' 0 R');
			objects[pageObjectNumber] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pageWidth + ' ' + pageHeight + '] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ' + contentObjectNumber + ' 0 R >>';
			objects[contentObjectNumber] = '<< /Length ' + pageStreams[i].length + ' >>\nstream\n' + pageStreams[i] + '\nendstream';
		}

		kids = pageObjectNumbers.join(' ');
		objects[2] = '<< /Type /Pages /Kids [' + kids + '] /Count ' + pageStreams.length + ' >>';

		return serializePdf(objects);
	}

	function serializePdf(objects) {
		var output = '%PDF-1.4\n';
		var offsets = [0];
		var i;
		var xrefStart;
		var paddedOffset;

		for (i = 1; i < objects.length; i += 1) {
			offsets[i] = output.length;
			output += i + ' 0 obj\n' + objects[i] + '\nendobj\n';
		}

		xrefStart = output.length;
		output += 'xref\n0 ' + objects.length + '\n';
		output += '0000000000 65535 f \n';
		for (i = 1; i < objects.length; i += 1) {
			paddedOffset = String(offsets[i]);
			while (paddedOffset.length < 10) {
				paddedOffset = '0' + paddedOffset;
			}
			output += paddedOffset + ' 00000 n \n';
		}
		output += 'trailer\n<< /Size ' + objects.length + ' /Root 1 0 R >>\n';
		output += 'startxref\n' + xrefStart + '\n%%EOF';
		return output;
	}

	function splitPdfLines(value) {
		return String(value || '').split('\n').map(function (line) {
			return line.trim();
		}).filter(Boolean);
	}

	function wrapPdfText(text, maxWidth, fontSize) {
		var clean = normalizePdfText(text);
		var maxChars = Math.max(18, Math.floor(maxWidth / (fontSize * 0.52)));
		var words = clean.split(/\s+/).filter(Boolean);
		var lines = [];
		var current = '';
		var word;
		var i;

		for (i = 0; i < words.length; i += 1) {
			word = words[i];
			if (word.length > maxChars) {
				if (current) {
					lines.push(current);
					current = '';
				}
				while (word.length > maxChars) {
					lines.push(word.slice(0, maxChars - 1));
					word = word.slice(maxChars - 1);
				}
			}
			if (!current) {
				current = word;
			} else if ((current + ' ' + word).length <= maxChars) {
				current += ' ' + word;
			} else {
				lines.push(current);
				current = word;
			}
		}
		if (current) {
			lines.push(current);
		}
		return lines.length ? lines : [''];
	}

	function escapePdfText(text) {
		return normalizePdfText(text)
			.replace(/\\/g, '\\\\')
			.replace(/\(/g, '\\(')
			.replace(/\)/g, '\\)');
	}

	function normalizePdfText(text) {
		return String(text || '')
			.replace(/[\u2018\u2019]/g, "'")
			.replace(/[\u201C\u201D]/g, '"')
			.replace(/[\u2013\u2014]/g, '-')
			.replace(/\u2022/g, '-')
			.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
	}

	function pdfColor(color) {
		return [
			formatPdfNumber((color[0] || 0) / 255),
			formatPdfNumber((color[1] || 0) / 255),
			formatPdfNumber((color[2] || 0) / 255)
		].join(' ');
	}

	function formatPdfNumber(value) {
		var number = Number(value);
		if (!Number.isFinite(number)) {
			return '0';
		}
		return String(Math.round(number * 1000) / 1000);
	}

	function renderPreviewSection(title, items) {
		var filtered = items.filter(Boolean);
		if (!filtered.length) {
			return '';
		}
		return '<section class="lessondesign-ai__preview-section"><h4>' + escapeHtml(title) + '</h4>' + filtered.join('') + '</section>';
	}

	function renderKeyValue(label, value) {
		if (!value) {
			return '';
		}
		return '<div class="lessondesign-ai__preview-item"><strong>' + escapeHtml(label) + ':</strong> <span>' + escapeHtml(value) + '</span></div>';
	}

	function renderMultiline(label, value) {
		if (!value) {
			return '';
		}
		var lines = value.split('\n').map(function (line) { return line.trim(); }).filter(Boolean);
		if (!lines.length) {
			return '';
		}
		return '<div class="lessondesign-ai__preview-item"><strong>' + escapeHtml(label) + ':</strong><ul>' + lines.map(function (line) {
			return '<li>' + escapeHtml(line) + '</li>';
		}).join('') + '</ul></div>';
	}

	function getMatchingExpectations(state) {
		return getMatchingStandards(state);
	}

	function ensureCurriculumShardsFor(curriculum, onLoaded) {
		var shards = getMatchingShardSpecs(curriculum).filter(function (shard) {
			return !loadedCurriculumShards[shard.id] && !loadingCurriculumShards[shard.id];
		});

		if (!shards.length) {
			return false;
		}

		shards.forEach(function (shard) {
			loadingCurriculumShards[shard.id] = true;
		});

		Promise.all(shards.map(function (shard) {
			return fetchPlannerJson(resolveCurriculumShardUrl(shard.path)).then(function (data) {
				data = expandRuntimeCurriculumShard(data || {});
				mergeCurriculumStandards(data && data.standards ? data.standards : [], data && data.aliases ? data.aliases : []);
				loadedCurriculumShards[shard.id] = true;
				loadingCurriculumShards[shard.id] = false;
			}).catch(function () {
				loadingCurriculumShards[shard.id] = false;
				dataLoadError = strings.dataLoadFailed || 'LessonDesign AI could not load its planner data. Refresh the page, then contact an administrator if the problem continues.';
			});
		})).then(function () {
			if (typeof onLoaded === 'function') {
				onLoaded();
			}
		});

		return true;
	}

	function getMatchingShardSpecs(curriculum) {
		var tracks;
		var matchesById = {};
		var matches = [];

		if (!curriculumManifestData || !Array.isArray(curriculumManifestData.shards) || !curriculum || !getCurriculumTrackIds(curriculum).length) {
			return [];
		}

		tracks = getCurriculumTracks(curriculum);

		curriculumManifestData.shards.forEach(function (shard) {
			var filters = shard.filters || {};
			var isMatch = tracks.some(function (track) {
				return filters.country === track.country &&
					arrayIncludes(filters.jurisdictionIds, track.jurisdictionId) &&
					arrayIncludes(filters.frameworkIds, track.frameworkId) &&
					arrayIncludes(filters.programIds, track.programId) &&
					(!Array.isArray(filters.subjectIds) || arrayIncludes(filters.subjectIds, track.subject)) &&
					(!Array.isArray(filters.gradeLevels) || arrayIncludes(filters.gradeLevels, curriculum.grade));
			});
			if (isMatch && !matchesById[shard.id]) {
				matchesById[shard.id] = true;
				matches.push(shard);
			}
		});

		return matches;
	}

	function resolveCurriculumShardUrl(shardPath) {
		var urls = appData.dataUrls || {};
		var manifestUrl = urls.curriculumManifest || '';
		var baseUrl = manifestUrl.split('?')[0].replace(/data\/curriculum-manifest\.json$/, '');
		var version = manifestUrl.indexOf('?') > -1 ? '?' + manifestUrl.split('?').slice(1).join('?') : '';
		return baseUrl + String(shardPath || '').replace(/^data\//, 'data/') + version;
	}

	function expandRuntimeCurriculumShard(data) {
		var defaults = data && data.defaults && typeof data.defaults === 'object' ? data.defaults : {};
		var documents = data && data.documents && typeof data.documents === 'object' ? data.documents : {};

		if (!data || !Array.isArray(data.standards) || (!Object.keys(defaults).length && !Object.keys(documents).length)) {
			return data || {};
		}

		data.standards = data.standards.map(function (standard) {
			var documentId = standard && standard.sourceDocumentId ? standard.sourceDocumentId : '';
			var document = documents[documentId] || {};
			return Object.assign({}, defaults, document, standard);
		});

		return data;
	}

	function mergeCurriculumStandards(standards) {
		curriculumStandardsData.standards = Array.isArray(curriculumStandardsData.standards) ? curriculumStandardsData.standards : [];
		standards.forEach(function (standard) {
			if (!standard || !standard.id || standardById[standard.id]) {
				return;
			}
			curriculumStandardsData.standards.push(standard);
			standardById[standard.id] = standard;
		});
		matchingStandardsCache = {};
	}

	function getMatchingStandards(state) {
		var curriculum = state.curriculum || {};
		var browseCurriculum = Object.assign({}, curriculum, {
			tracks: curriculum.track ? [curriculum.track] : []
		});
		var cacheKey = getCurriculumMatchCacheKey(browseCurriculum);
		if (cacheKey && matchingStandardsCache[cacheKey]) {
			return matchingStandardsCache[cacheKey];
		}
		var standards = (curriculumStandardsData.standards || []).filter(function (item) {
			return standardMatchesCurriculum(item, browseCurriculum);
		});
		standards = sortCurriculumStandards(standards);

		if (standards.length) {
			if (cacheKey) {
				matchingStandardsCache[cacheKey] = standards;
			}
			return standards;
		}

		return [];
	}

	function getCurriculumMatchCacheKey(curriculum) {
		if (!curriculum) {
			return '';
		}
		return [
			getCurriculumTrackIds(curriculum).join(','),
			curriculum.grade || ''
		].join('|');
	}

	function sortCurriculumStandards(standards) {
		return (standards || []).slice().sort(function (left, right) {
			var leftSequence = Number.isFinite(Number(left.moduleSequence)) ? Number(left.moduleSequence) : 999;
			var rightSequence = Number.isFinite(Number(right.moduleSequence)) ? Number(right.moduleSequence) : 999;
			if (leftSequence !== rightSequence) {
				return leftSequence - rightSequence;
			}
			var leftSectionOrder = getMathSectionOrder(left);
			var rightSectionOrder = getMathSectionOrder(right);
			if (leftSectionOrder !== rightSectionOrder) {
				return leftSectionOrder - rightSectionOrder;
			}
			var leftStrand = String(left.strand || left.standardCode || left.code || '');
			var rightStrand = String(right.strand || right.standardCode || right.code || '');
			if (leftStrand !== rightStrand) {
				return leftStrand.localeCompare(rightStrand);
			}
			var leftOutcomeNumber = Number(getCurriculumOutcomeNumber(left.standardCode || left.code || ''));
			var rightOutcomeNumber = Number(getCurriculumOutcomeNumber(right.standardCode || right.code || ''));
			if (Number.isFinite(leftOutcomeNumber) && Number.isFinite(rightOutcomeNumber) && leftOutcomeNumber !== rightOutcomeNumber) {
				return leftOutcomeNumber - rightOutcomeNumber;
			}
			return String(left.standardCode || left.code || '').localeCompare(String(right.standardCode || right.code || ''));
		});
	}

	function getMathSectionOrder(item) {
		var subject = normalizeText(item && item.subject);
		var text = normalizeText([
			item && item.unit,
			item && item.strand,
			item && item.sourceLocator,
			item && item.standardCode,
			item && item.code
		].filter(Boolean).join(' '));

		if (subject.indexOf('mathematics') !== 0) {
			return 999;
		}
		if (/number/.test(text)) {
			return 10;
		}
		if (/patterns and relations.*patterns/.test(text)) {
			return 20;
		}
		if (/patterns and relations.*variables/.test(text)) {
			return 30;
		}
		if (/shape and space.*measurement/.test(text)) {
			return 40;
		}
		if (/shape and space.*3 d.*2 d/.test(text)) {
			return 50;
		}
		if (/shape and space.*transformations/.test(text)) {
			return 60;
		}
		if (/statistics and probability.*(data analysis|collecting and analyzing information)/.test(text)) {
			return 70;
		}
		if (/statistics and probability.*chance/.test(text)) {
			return 80;
		}
		return 900;
	}

	function getSelectedCurriculumPieces(state) {
		return getSelectedStandards(state);
	}

	function getSelectedStandards(state) {
		return getSelectedStandardIds(state).map(function (id) {
			return getStandardById(id);
		}).filter(Boolean);
	}

	function getSelectedStandardIds(state) {
		return expandStandardIds(uniqueArray(Array.isArray(state.selectedStandards) ? state.selectedStandards : []));
	}

	function expandStandardIds(ids) {
		return uniqueArray(ids || []);
	}

	function getSelectedResources(state) {
		return state.selectedResources.map(function (id) {
			return getResourceById(id);
		}).filter(Boolean);
	}

	function buildKeywordSet(state) {
		var text = [
			state.foundation.title,
			state.foundation.prompt,
			state.foundation.overview,
			state.foundation.learnerContext,
			state.foundation.learningGoals,
			state.foundation.successCriteria,
			state.connections.note
		].join(' ');

		getSelectedCurriculumPieces(state).forEach(function (item) {
			text += ' ' + (item.officialOutcomeText || item.summaryText || item.text || '') + ' ' + item.strand + ' ' + (item.standardCode || item.code || '') + ' ' + (item.courseCode || '') + ' ' + (item.courseLabel || '') + ' ' + (item.region || '');
		});

		return uniqueArray(normalizeText(text).split(/\s+/).filter(function (word) {
			return word.length > 2 && stopWords.indexOf(word) === -1;
		}));
	}

	function getExpectationById(id) {
		return getStandardById(id);
	}

	function getStandardById(id) {
		return standardById[id] || null;
	}

	function standardMatchesCurriculum(item, curriculum) {
		var tracks = getCurriculumTracks(curriculum);
		var track = tracks.length === 1 ? tracks[0] : null;
		var country = track ? track.country : (curriculum && curriculum.country);
		var jurisdiction = track ? track.jurisdictionId : (curriculum && curriculum.jurisdiction);
		var framework = track ? track.frameworkId : (curriculum && curriculum.framework);
		var program = track ? track.programId : (curriculum && curriculum.program);
		var subjectArea = track ? track.subjectAreaId : (curriculum && curriculum.subjectArea);
		var subject = track ? track.subject : (curriculum && curriculum.subject);
		if (!item || !curriculum || !curriculum.grade) {
			return false;
		}

		if (tracks.length) {
			return tracks.some(function (candidate) {
				return standardMatchesTrack(item, curriculum, candidate);
			});
		}

		return !!item &&
			!!curriculum &&
			!!country &&
			!!jurisdiction &&
			!!curriculum.grade &&
			!!subject &&
			item.country === country &&
			item.jurisdictionId === jurisdiction &&
			(!framework || item.frameworkId === framework) &&
			(!program || item.programId === program) &&
			(!subjectArea || item.subjectAreaId === subjectArea) &&
			item.subject === subject &&
			gradeMatches(item.gradeLevel, curriculum.grade);
	}

	function standardMatchesTrack(item, curriculum, track) {
		return !!item &&
			!!curriculum &&
			!!track &&
			item.country === track.country &&
			item.jurisdictionId === track.jurisdictionId &&
			item.frameworkId === track.frameworkId &&
			item.programId === track.programId &&
			item.subjectAreaId === track.subjectAreaId &&
			item.subject === track.subject &&
			gradeMatches(item.gradeLevel, curriculum.grade);
	}

	function gradeMatches(standardGrade, selectedGrade) {
		if (!selectedGrade || !standardGrade) {
			return !selectedGrade;
		}

		var recordGrade = String(standardGrade).toLowerCase();
		var grade = String(selectedGrade).toLowerCase();

		if (recordGrade === grade) {
			return true;
		}

		var match = recordGrade.match(/^(k|\d+)-(\d+)$/);
		if (match) {
			var selected = gradeOrdinal(grade);
			return selected >= gradeOrdinal(match[1]) && selected <= Number(match[2]);
		}

		return false;
	}

	function gradeOrdinal(grade) {
		return grade === 'k' ? 0 : Number(grade);
	}

	function formatStandardLine(item) {
		var code = formatCurriculumPieceTitle(item);
		var summary = formatCurriculumOutcomeExportText(item);

		return [code, summary].filter(Boolean).join(': ');
	}

	function formatCurriculumOutcomeExportText(item) {
		var structured = getStructuredCurriculumOutcomeDisplay(item);
		if (!structured) {
			return getCurriculumOutcomeDisplayText(item);
		}
		return structured.lead + '\n  - ' + structured.items.map(capitalizeSentenceStart).join('\n  - ');
	}

	function getCurriculumOutcomeDisplayText(item) {
		var text = capitalizeSentenceStart(item && (item.officialOutcomeText || item.summaryText || item.text || ''));
		if (isSocialStudiesItem(item)) {
			text = formatSocialStudiesOutcomeTextForDisplay(text);
		}
		if (isPhysicalEducationItem(item)) {
			text = formatPhysicalEducationOutcomeTextForDisplay(text);
		}
		return text;
	}

	function formatSocialStudiesOutcomeTextForDisplay(value) {
		return String(value || '')
			.replace(/^Students will\s*:\s*/i, 'Students will ')
			.replace(/^Students will\s+([789]\.(?:S|\d+)\.\d+)\s*-\s*/i, 'Students will ')
			.replace(/\s+([789]\.(?:S|\d+)\.\d+)\s*-\s*/i, ' ')
			.replace(/\*/g, '')
			.replace(/:\s*;/g, ';')
			.replace(/\s+/g, ' ')
			.trim();
	}

	function formatPhysicalEducationOutcomeTextForDisplay(value) {
		return String(value || '')
			.replace(/^Students will\s*:\s*/i, 'Students will ')
			.replace(/^Students will\s+([A-D][789])[-\u2013\u2014](\d+)\s*/i, 'Students will ')
			.replace(/\s+/g, ' ')
			.trim();
	}

	function renderCurriculumOutcomeDisplayText(item) {
		var structured = getStructuredCurriculumOutcomeDisplay(item);
		if (!structured) {
			return '<span class="lessondesign-ai__expectation-text">' + escapeHtml(getCurriculumOutcomeDisplayText(item)) + '</span>';
		}

		return (
			'<span class="lessondesign-ai__expectation-text lessondesign-ai__expectation-text--structured">' +
				'<span class="lessondesign-ai__expectation-lead">' + escapeHtml(structured.lead) + '</span>' +
				renderCurriculumOutcomeStructureList(structured.items, {
					numbered: structured.numbered,
					preserveCase: structured.preserveCase
				}) +
				renderCurriculumOutcomeStructureNotes(structured.notes, structured.preserveCase) +
			'</span>'
		);
	}

	function getStructuredCurriculumOutcomeDisplay(item) {
		var sourceStructure = getSourceOutcomeStructureDisplay(item);
		var text = getCurriculumOutcomeDisplayText(item);
		var semicolonCount = (text.match(/;\s/g) || []).length;
		var isSkillProcess = isSocialStudiesSkillsProcessItem(item);
		var markerMatch;
		var splitIndex;
		var colonIndex;
		var secondColonIndex;
		var lead;
		var rest;
		var entries;

		if (sourceStructure) {
			return sourceStructure;
		}

		if (isDramaItem(item)) {
			return getStructuredDramaOutcomeDisplay(text);
		}
		if (isMusicItem(item)) {
			return getStructuredMusicOutcomeDisplay(text);
		}
		if (isFrenchLanguageArtsItem(item)) {
			return getStructuredFrenchLanguageArtsOutcomeDisplay(text);
		}

		if (!isSocialStudiesItem(item)) {
			return null;
		}
		if (semicolonCount < (isSkillProcess ? 1 : 2) || text.length < (isSkillProcess ? 180 : 260)) {
			return null;
		}

		markerMatch = text.match(/\b(?:by\s+)?exploring and reflecting upon the following questions? and issues:?\s*/i);
		if (markerMatch) {
			splitIndex = markerMatch.index + markerMatch[0].length;
			lead = text.slice(0, splitIndex).trim();
			rest = text.slice(splitIndex).trim();
		} else {
			colonIndex = text.indexOf(':');
			secondColonIndex = colonIndex >= 0 ? text.indexOf(':', colonIndex + 1) : -1;
			if (colonIndex < 0) {
				return null;
			}
			splitIndex = secondColonIndex >= 0 ? secondColonIndex : colonIndex;
			lead = text.slice(0, splitIndex + 1).trim();
			rest = text.slice(splitIndex + 1).trim();
		}

		entries = rest.split(/;\s+(?!e\.g\.,?\s*)/i).map(function (entry) {
			return entry.trim();
		}).filter(Boolean);

		if (entries.length < 2) {
			return null;
		}

		return {
			lead: lead,
			items: entries
		};
	}

	function getStructuredFrenchLanguageArtsOutcomeDisplay(text) {
		var match = String(text || '').match(/^(Pour\s+.+?,\s+l[’']élève\s+(?:devra|pourra|mettra\b[^:]*):)\s*(.+)$/i);
		var entries;

		if (!match) {
			return null;
		}

		entries = match[2].split(/;\s+/).map(function (entry) {
			return entry.trim();
		}).filter(Boolean);

		if (entries.length < 2) {
			return null;
		}

		return {
			lead: match[1],
			items: entries
		};
	}

	function getSourceOutcomeStructureDisplay(item) {
		var structure = item && item.officialOutcomeStructure;
		var items;
		var notes;

		if (!structure || typeof structure !== 'object' || Array.isArray(structure)) {
			return null;
		}

		items = normalizeCurriculumOutcomeStructureItems(structure.items);
		notes = Array.isArray(structure.notes) ? structure.notes.map(function (note) {
			return String(note || '').trim();
		}).filter(Boolean) : [];

		if (!String(structure.lead || '').trim() || !items.length) {
			return null;
		}

		return {
			lead: String(structure.lead || '').trim(),
			items: items,
			notes: notes,
			preserveCase: true
		};
	}

	function normalizeCurriculumOutcomeStructureItems(items) {
		if (!Array.isArray(items)) {
			return [];
		}

		return items.map(function (item) {
			var text;
			var children;

			if (typeof item === 'string') {
				text = item.trim();
				return text ? { text: text } : null;
			}
			if (!item || typeof item !== 'object' || Array.isArray(item)) {
				return null;
			}

			text = String(item.text || '').trim();
			children = normalizeCurriculumOutcomeStructureItems(item.children);
			if (!text) {
				return null;
			}

			return {
				text: text,
				children: children
			};
		}).filter(Boolean);
	}

	function renderCurriculumOutcomeStructureList(items, options) {
		var settings = options || {};
		var nestedClass = settings.nested ? ' lessondesign-ai__expectation-bullets--nested' : '';
		var numberedClass = settings.numbered ? ' lessondesign-ai__expectation-bullets--numbered' : '';

		if (!Array.isArray(items) || !items.length) {
			return '';
		}

		return (
			'<span class="lessondesign-ai__expectation-bullets' + nestedClass + numberedClass + '" role="list">' +
				items.map(function (entry) {
					return renderCurriculumOutcomeStructureItem(entry, settings);
				}).join('') +
			'</span>'
		);
	}

	function renderCurriculumOutcomeStructureItem(entry, options) {
		var settings = options || {};
		var text = typeof entry === 'string' ? entry : String(entry && entry.text || '');
		var children = entry && Array.isArray(entry.children) ? entry.children : [];

		if (!settings.preserveCase) {
			text = capitalizeSentenceStart(text);
		}

		return (
			'<span role="listitem">' +
				'<span class="lessondesign-ai__expectation-item-text">' + escapeHtml(text) + '</span>' +
				renderCurriculumOutcomeStructureList(children, {
					nested: true,
					preserveCase: settings.preserveCase
				}) +
			'</span>'
		);
	}

	function renderCurriculumOutcomeStructureNotes(notes, preserveCase) {
		if (!Array.isArray(notes) || !notes.length) {
			return '';
		}

		return (
			'<span class="lessondesign-ai__expectation-notes" role="list">' +
				notes.map(function (note) {
					var text = preserveCase ? note : capitalizeSentenceStart(note);
					return '<span role="listitem">' + escapeHtml(text) + '</span>';
				}).join('') +
			'</span>'
		);
	}

	function getStructuredDramaOutcomeDisplay(text) {
		var leadMatch = String(text || '').match(/^The student will be able to:\s*/i);
		var matches;
		var entries;

		if (!leadMatch) {
			return null;
		}

		matches = Array.from(text.matchAll(/\s(\d+)\.\s+/g));
		if (matches.length < 2) {
			return null;
		}

		entries = matches.map(function (match, index) {
			var start = match.index + match[0].length;
			var end = matches[index + 1] ? matches[index + 1].index : text.length;
			return match[1] + '. ' + text.slice(start, end).trim();
		}).filter(Boolean);

		if (entries.length < 2) {
			return null;
		}

		return {
			lead: 'The student will be able to:',
			items: entries,
			numbered: true
		};
	}

	function getStructuredMusicOutcomeDisplay(text) {
		var match = String(text || '').match(/^(Modules concentrating on [^:]+ emphasize:)\s*(.+)$/i);
		var entries;

		if (!match) {
			return null;
		}

		entries = match[2].split(/;\s+/).map(function (entry) {
			return entry.trim();
		}).filter(Boolean);

		if (entries.length < 2) {
			return null;
		}

		return {
			lead: match[1],
			items: entries
		};
	}

	function capitalizeSentenceStart(value) {
		var text = String(value || '');
		var index = text.search(/[A-Za-z]/);

		if (index < 0) {
			return text;
		}

		return text.slice(0, index) + text.charAt(index).toUpperCase() + text.slice(index + 1);
	}

	function formatStandardExportLine(item) {
		var line = formatStandardLine(item);

		return line + (item.sourceUrl ? '\nSource: ' + item.sourceUrl : '');
	}

	function formatCurriculumPieceTitle(item) {
		return item.standardCode || item.code || 'Curriculum piece';
	}

	function getCurriculumPieceDisplayTitle(item) {
		var locatorLabel = getCurriculumLocatorLeaf(item);
		var code = getCurriculumPieceCode(item);
		var outcomeNumber = getCurriculumOutcomeNumber(code);
		var familyLabel = getCurriculumOutcomeFamilyLabel(item);

		if (isCtfItem(item) && outcomeNumber) {
			return 'Learning Outcome ' + outcomeNumber;
		}

		if (isSocialStudiesItem(item) && outcomeNumber) {
			return 'Specific Outcome ' + outcomeNumber;
		}

		if (isEnvironmentalOutdoorItem(item)) {
			var environmentalOutdoorTitle = getEnvironmentalOutdoorDisplayTitle(code);
			if (environmentalOutdoorTitle) {
				return environmentalOutdoorTitle;
			}
		}

		if (isFrenchLanguageArtsItem(item) && outcomeNumber) {
			return 'Résultat d’apprentissage spécifique ' + outcomeNumber;
		}

		if (familyLabel && outcomeNumber) {
			return familyLabel + ' Outcome ' + outcomeNumber;
		}

		if (outcomeNumber) {
			return 'Specific Outcome ' + outcomeNumber;
		}

		if (locatorLabel && locatorLabel !== 'Specific Outcome') {
			return locatorLabel;
		}

		return formatCurriculumPieceTitle(item);
	}

	function getCurriculumLocatorLeaf(item) {
		var parts = String(item && item.sourceLocator ? item.sourceLocator : '')
			.split('>')
			.map(function (part) {
				return part.trim();
			})
			.filter(Boolean);

		return parts.length ? parts[parts.length - 1] : '';
	}

	function getCurriculumPieceCode(item) {
		return item && (item.standardCode || item.code || '');
	}

	function isLanguageArtsItem(item) {
		var text = [
			item && item.subject,
			item && item.subjectId,
			item && item.subjectAreaId,
			item && item.courseCode,
			item && item.standardCode,
			item && item.code,
			item && item.sourceLocator
		].filter(Boolean).join(' ');
		return /english-language-arts|francais-langue-premiere|french-language-arts-immersion|language-arts|^ELA|^KAEELA|^FRA|^FLA|LANENG|LANKEE|LANFRA|OLAFLA/i.test(text);
	}

	function isFrenchLanguageArtsItem(item) {
		var text = [
			item && item.subject,
			item && item.subjectId,
			item && item.subjectAreaId,
			item && item.courseCode,
			item && item.standardCode,
			item && item.code,
			item && item.sourceLocator
		].filter(Boolean).join(' ');
		return /francais-langue-premiere|french-language-arts-immersion|^FRA|^FLA|LANFRA|OLAFLA/i.test(text);
	}

	function isSocialStudiesItem(item) {
		var text = [
			item && item.subject,
			item && item.subjectId,
			item && item.subjectAreaId,
			item && item.courseCode,
			item && item.standardCode,
			item && item.code,
			item && item.sourceLocator
		].filter(Boolean).join(' ');
		return /social-studies|SST|SSS/i.test(text);
	}

	function isSocialStudiesSkillsProcessItem(item) {
		return isSocialStudiesItem(item) && /skills?\s*(?:&|and)\s*processes/i.test(String(item && item.unit || item && item.sourceLocator || ''));
	}

		function getCurriculumOutcomeNumber(code) {
		var match = String(code || '').match(/-SO(\d+)$/i) ||
			String(code || '').match(/-LO(\d+)$/i) ||
			String(code || '').match(/^\d+\.(?:S|\d+)\.(\d+)$/i) ||
			String(code || '').match(/^[A-D][789]-(\d+)$/i) ||
			String(code || '').match(/^[WLR]-[789]\.(\d+)$/i);
		return match ? match[1] : '';
	}

	function isCtfItem(item) {
		var text = [
			item && item.subject,
			item && item.subjectId,
			item && item.subjectAreaId,
			item && item.courseCode,
			item && item.standardCode,
			item && item.code,
			item && item.sourceLocator
		].filter(Boolean).join(' ');
		return /career-technology-foundations|Career and Technology Foundations|^CTF/i.test(text);
	}

	function isCtsKnowledgeEmployabilityItem(item) {
		var text = [
			item && item.subject,
			item && item.subjectId,
			item && item.subjectAreaId,
			item && item.courseCode,
			item && item.standardCode,
			item && item.code,
			item && item.sourceLocator
		].filter(Boolean).join(' ');
		return /cts-[a-z-]+-ke|CTSDES_KAE|CTSMEC_KAE|CTSINF_KAE|CTSCON_KAE|CTSFAS_KAE|CTSFOD_KAE|CTSAGR_KAE|CTSCCS_KAE|^KAE(?:DES|MEC|INF|CON|FAS|FOD|AGR|CCS)/i.test(text);
	}

	function isPhysicalEducationItem(item) {
		var text = [
			item && item.subject,
			item && item.subjectId,
			item && item.subjectAreaId,
			item && item.courseCode,
			item && item.standardCode,
			item && item.code,
			item && item.sourceLocator
		].filter(Boolean).join(' ');
		return /physical-education|Physical Education|^PED|PDEPHY/i.test(text);
	}

	function isEnvironmentalOutdoorItem(item) {
		var text = [
			item && item.subject,
			item && item.subjectId,
			item && item.subjectAreaId,
			item && item.courseCode,
			item && item.standardCode,
			item && item.code,
			item && item.sourceLocator
		].filter(Boolean).join(' ');
		return /environmental-outdoor-education|Environmental and Outdoor Education|^ENV/i.test(text);
	}

	function isHealthItem(item) {
		var text = [
			item && item.subject,
			item && item.subjectId,
			item && item.subjectAreaId,
			item && item.courseCode,
			item && item.standardCode,
			item && item.code,
			item && item.sourceLocator
		].filter(Boolean).join(' ');
		return /health-life-skills|Health and Life Skills|^HLS|^[WLR]-[789]\.\d+/i.test(text);
	}

	function isMusicItem(item) {
		var text = [
			item && item.subject,
			item && item.subjectId,
			item && item.subjectAreaId,
			item && item.courseCode,
			item && item.standardCode,
			item && item.code,
			item && item.sourceLocator
		].filter(Boolean).join(' ');
		return /\bmusic\b|^MUS|FARGEN/i.test(text);
	}

	function isFineArtsItem(item) {
		var text = [
			item && item.subject,
			item && item.subjectId,
			item && item.subjectAreaId,
			item && item.courseCode,
			item && item.standardCode,
			item && item.code,
			item && item.sourceLocator
		].filter(Boolean).join(' ');
		return /fine-arts|^art$|^drama$|\bmusic\b|^ART|^DMA|^MUS|FARART|FARDMA|FARGEN/i.test(text);
	}

	function isDramaItem(item) {
		var text = [
			item && item.subject,
			item && item.subjectId,
			item && item.subjectAreaId,
			item && item.courseCode,
			item && item.standardCode,
			item && item.code,
			item && item.sourceLocator
		].filter(Boolean).join(' ');
		return /\bdrama\b|^DMA|FARDMA/i.test(text);
	}

	function getEnvironmentalOutdoorDisplayTitle(code) {
		var match = String(code || '').match(/-GO(\d+)-SO([A-Z])$/i);
		if (!match) {
			return '';
		}
		return 'General Outcome ' + match[1] + ', Specific Outcome ' + match[2].toUpperCase();
	}

	function getCurriculumOutcomeFamilyLabel(item) {
		var text = [
			item && item.sourceLocator,
			item && item.moduleLabel,
			item && item.moduleType,
			item && item.subject,
			item && item.standardCode,
			item && item.code
		].filter(Boolean).join(' ');

		if (isSocialStudiesItem(item)) {
			return getSocialStudiesFamilyLabel(item);
		}

		if (/attitude outcomes|learning dispositions|ATT-/i.test(text)) {
			return 'Attitude';
		}

		if (/skill outcomes|skills|SKILL-/i.test(text)) {
			return 'Skill';
		}

		if (/science, technology and society|STS-K|understandings/i.test(text)) {
			return 'Science, Technology, and Society';
		}

		return '';
	}

	function getSocialStudiesFamilyLabel(item) {
		var text = [
			item && item.moduleLabel,
			item && item.sourceLocator,
			item && item.generalOutcome,
			item && item.standardCode,
			item && item.code
		].filter(Boolean).join(' ');

		if (/values and attitudes/i.test(text)) {
			return 'Values and Attitudes';
		}

		if (/knowledge and understanding/i.test(text)) {
			return 'Knowledge and Understanding';
		}

		if (/dimensions of thinking|SKILLS-DT/i.test(text)) {
			return 'Dimensions of Thinking';
		}

		if (/social participation as a democratic practice|SKILLS-SPDP/i.test(text)) {
			return 'Social Participation';
		}

		if (/research for deliberative inquiry|SKILLS-RDI/i.test(text)) {
			return 'Research';
		}

		if (/communication|SKILLS-COM/i.test(text)) {
			return 'Communication';
		}

		return '';
	}

	function getStandardStatusLabel(item) {
		if (item.sourceStatus === 'prototype') {
			return 'Legacy prototype fallback';
		}

		if (item.sourceStatus === 'source-backed-summary' || item.sourceStatus === 'source-backed-exact-outcome') {
			return '';
		}

		return item.sourceStatus || 'Summary';
	}

	function getResourceById(id) {
		return resourceById[id] || null;
	}

	function getGradeBand(gradeValue) {
		if (!gradeValue) {
			return '';
		}

		if (gradeValue === 'k') {
			return 'Primary';
		}

		var gradeNumber = Number(gradeValue);

		if (gradeNumber <= 3) {
			return 'Primary';
		}

		if (gradeNumber <= 6) {
			return 'Junior';
		}

		return gradeNumber >= 9 ? 'Senior' : 'Intermediate';
	}

	function getLabel(items, value) {
		var match = (items || []).find(function (item) { return item.id === value; });
		return match ? match.label : '';
	}

	function fallback(value) {
		return value ? value : 'Not set yet';
	}

	function formatTextBlock(label, value) {
		var lines = (value || '').split('\n').map(function (line) {
			return line.trim();
		}).filter(Boolean);
		if (!lines.length) {
			return label + ': Not set yet';
		}
		return label + ':\n- ' + lines.join('\n- ');
	}

	function joinLines(value) {
		if (Array.isArray(value)) {
			return value.join('\n');
		}
		return value || '';
	}

	function formatDateTime(isoString) {
		try {
			return new Date(isoString).toLocaleString();
		} catch (error) {
			return isoString;
		}
	}

	function uniqueArray(items) {
		return Array.from(new Set(items || []));
	}

	function arrayIncludes(items, value) {
		return Array.isArray(items) && items.indexOf(value) > -1;
	}

	function normalizeText(value) {
		return String(value || '')
			.toLowerCase()
			.replace(/[^a-z0-9\s]+/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
	}

	function downloadFile(filename, content, mimeType) {
		var blob = new Blob([content], { type: mimeType });
		var url = URL.createObjectURL(blob);
		var link = document.createElement('a');
		link.href = url;
		link.download = filename;
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
		URL.revokeObjectURL(url);
	}

	function setValueAtPath(target, path, value) {
		var segments = path.split('.');
		var pointer = target;
		for (var index = 0; index < segments.length - 1; index += 1) {
			pointer = pointer[segments[index]];
		}
		pointer[segments[segments.length - 1]] = value;
	}

	function getValueAtPath(target, path) {
		return path.split('.').reduce(function (pointer, segment) {
			return pointer && pointer[segment] !== undefined ? pointer[segment] : '';
		}, target);
	}

	function isPlainObject(value) {
		return Object.prototype.toString.call(value) === '[object Object]';
	}

	function escapeHtml(value) {
		return String(value)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#039;');
	}

	function slugify(value) {
		return String(value)
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'lessondesign-ai-lesson';
	}

	// -------------------------------------------------------------------------
	// Server sync
	// -------------------------------------------------------------------------

	var syncTimeout = null;

	function scheduleSyncToServer(state, setStatusFn) {
		clearTimeout(syncTimeout);
		syncTimeout = setTimeout(function () { syncToServer(state, setStatusFn); }, 2000);
	}

	function syncToServer(state, setStatusFn) {
		if (!hasAccountAccess()) {
			return;
		}

		var planId = (state.meta && state.meta.serverId) || generatePlanId();
		if (!state.meta) {
			state.meta = {};
		}
		state.meta.serverId = planId;
		saveState(state);

		apiRequest('PUT', '/plans/' + encodeURIComponent(planId), {
			title: state.foundation.title || 'Untitled Lesson',
			state: state
		}).then(function (res) {
			if (res && res.success && setStatusFn) {
				setStatusFn(strings.planSaved || 'Saved to your account.');
			} else if (res && !res.success && setStatusFn) {
				setStatusFn(getAjaxErrorMessage(res));
			}
		}).catch(function () {
			if (setStatusFn) {
				setStatusFn('Could not reach the server. Your draft is still saved in this browser.');
			}
		});
	}

	function loadFromServer(state, onDone) {
		if (!hasAccountAccess() || !state.meta || !state.meta.serverId) {
			onDone();
			return;
		}

		apiRequest('GET', '/plans/' + encodeURIComponent(state.meta.serverId)).then(function (res) {
			if (res.success && res.data && res.data.state) {
				var serverState = res.data.state;
				var serverTime = new Date((serverState.meta && serverState.meta.lastSaved) || 0);
				var localTime = new Date((state.meta && state.meta.lastSaved) || 0);
				if (serverTime > localTime) {
					replaceState(state, normalizeState(mergeState(defaults, serverState)));
					saveState(state);
				}
			} else if (res.httpStatus === 404) {
				// The plan was deleted elsewhere: keep the local draft, detach it.
				state.meta.serverId = '';
				saveState(state);
			}
			onDone();
		}).catch(function () {
			onDone();
		});
	}

	/**
	 * Handles links from My Lesson Plans: ?plan=<id> opens a saved plan in the
	 * planner, ?new=1 starts a fresh draft. The query string is then removed.
	 */
	function handleEntryParams(state, onDone) {
		var params;
		var planId;
		try {
			params = new URLSearchParams(window.location.search);
		} catch (error) {
			onDone('');
			return;
		}
		planId = params.get('plan');

		function cleanUrl() {
			if (window.history && window.history.replaceState) {
				window.history.replaceState(null, '', window.location.pathname);
			}
		}

		if (params.get('new')) {
			replaceState(state, normalizeState(clone(defaults)));
			saveState(state);
			saveCurrentStep('foundation');
			cleanUrl();
			onDone('new');
			return;
		}

		if (!planId || !hasAccountAccess()) {
			onDone('');
			return;
		}

		apiRequest('GET', '/plans/' + encodeURIComponent(planId)).then(function (res) {
			cleanUrl();
			if (res.success && res.data && res.data.state) {
				replaceState(state, normalizeState(mergeState(defaults, res.data.state)));
				state.meta.serverId = res.data.id;
				saveState(state);
				saveCurrentStep('foundation');
				onDone(strings.planLoaded || 'Lesson plan opened from your account.');
				return;
			}
			onDone(strings.planLoadFailed || 'That saved lesson plan could not be opened.');
		}).catch(function () {
			cleanUrl();
			onDone(strings.planLoadFailed || 'That saved lesson plan could not be opened.');
		});
	}

	/* ---- Step pointer persistence + migration ------------------------------ */

	function getStepStorageKey() {
		return appData.stepStorageKey || 'lessondesign_ai_step_v2';
	}

	function saveCurrentStep(stepId) {
		try {
			window.localStorage.setItem(getStepStorageKey(), JSON.stringify({ step: stepId, schema: 2 }));
		} catch (error) {
			// Ignore storage failures in private or restricted contexts.
		}
	}

	function loadSavedStepPointer() {
		var raw;
		var parsed;
		try {
			raw = window.localStorage.getItem(getStepStorageKey());
			if (raw) {
				parsed = JSON.parse(raw);
				return parsed && typeof parsed === 'object' ? parsed : null;
			}
			// Pre-reorder builds: a bare step id or numeric index under the old key.
			raw = window.localStorage.getItem('lessondesign_ai_current_step');
			if (raw !== null && raw !== '') {
				return { step: raw, schema: 1 };
			}
		} catch (error) {
			return null;
		}
		return null;
	}

	function draftHasTargetsWork(state) {
		var foundation = (state && state.foundation) || {};
		return [foundation.learningGoals, foundation.successCriteria, foundation.formativeAssessment, foundation.summativeAssessment].some(hasNonEmptyText);
	}

	/**
	 * Maps any saved pointer to a current step id. Current ids pass through;
	 * pointers from the old order are migrated: old Curriculum -> Foundation,
	 * old Foundation (which held goals + assessment) -> Learning Targets &
	 * Assessment when those fields have content, else Foundation. Anything
	 * unrecognised falls back to Foundation.
	 */
	function migrateStepPointer(pointer, state) {
		var currentIds = stepDefinitions.map(function (definition) { return definition.id; });
		var step = pointer ? pointer.step : '';
		var legacyId;

		if (pointer && pointer.schema === 2 && currentIds.indexOf(step) > -1) {
			return step;
		}

		legacyId = /^\d+$/.test(String(step)) ? LEGACY_STEP_ORDER[parseInt(step, 10)] : String(step || '');
		switch (legacyId) {
			case 'welcome':
				return 'welcome';
			case 'curriculum':
				return 'foundation';
			case 'foundation':
				return draftHasTargetsWork(state) ? 'targets' : 'foundation';
			case 'connections':
			case 'design':
			case 'ready':
			case 'targets':
				return legacyId;
			default:
				return 'foundation';
		}
	}

	function resolveResumeStep(state) {
		var pointer = loadSavedStepPointer();
		var step = migrateStepPointer(pointer, state);
		return step === 'welcome' ? 'foundation' : step;
	}

	function resolveInitialStep(state, forceFoundation) {
		var pointer;
		var step;
		if (forceFoundation) {
			return 'foundation';
		}
		if (!hasMeaningfulDraftContent(state)) {
			return 'welcome';
		}
		pointer = loadSavedStepPointer();
		if (!pointer) {
			return 'welcome';
		}
		step = migrateStepPointer(pointer, state);
		saveCurrentStep(step);
		return step;
	}

	function generatePlanId() {
		return 'plan_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
	}
})();
