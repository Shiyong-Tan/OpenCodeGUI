/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function read(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function assert(condition, label) {
  if (!condition) throw new Error(`Chat render baseline contract check failed: ${label}`);
}

function assertContains(source, needle, label) {
  assert(source.includes(needle), label);
}

function count(source, needle) {
  return source.split(needle).length - 1;
}

function extractFunction(source, marker) {
  const start = source.indexOf(marker);
  assert(start >= 0, `function marker exists: ${marker}`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Chat render baseline contract check failed: unclosed function ${marker}`);
}

function sourceHash(value) {
  return crypto.createHash('sha256').update(value.replace(/\r\n/g, '\n')).digest('hex');
}

function assertFunctionHash(source, marker, expected) {
  assert(sourceHash(extractFunction(source, marker)) === expected, `${marker} immutable source hash`);
}

function runA211DeferredInitialOwnerGuards(mainSource, adapterSource) {
  assertContains(adapterSource, "readonly initialOwnerMode?: 'active' | 'deferred-transaction';",
    'A2.11 exposes only the typed opt-in deferred initial-owner mode');
  assertContains(adapterSource, "const deferredInitialOwner = options.initialOwnerMode === 'deferred-transaction';",
    'A2.11 defaults every omitted/active option to the eager owner path');
  assertContains(adapterSource, 'let active: SingleAdapter | null = deferredInitialOwner ? null : createSingleAdapter(options, VirtualizerClass);',
    'deferred factory return creates no initial SingleAdapter');
  assertContains(adapterSource, "getInitialOwnerState(): 'deferred' | 'active-pending-completion' | 'active' | 'destroyed';",
    'typed adapter exposes side-effect-free initial-owner state');
  const activeSeedCapture = adapterSource.indexOf('const activeSeed = active?._exportState();');
  const candidateCreation = adapterSource.indexOf('entry.candidate = createSingleAdapter({ ...options, ...entry.update }, VirtualizerClass, {');
  const replacementSeed = adapterSource.indexOf('seed: activeSeed ? { ...activeSeed, initialTailPending: false } : undefined,');
  assert(activeSeedCapture >= 0 && candidateCreation > activeSeedCapture && replacementSeed > candidateCreation,
    'initial null old owner is supported while a live owner seed is captured and cloned for replacement');
  assert(count(adapterSource, 'const activeSeed = active?._exportState();') === 1
    && count(adapterSource, 'seed: activeSeed ? { ...activeSeed, initialTailPending: false } : undefined,') === 1
    && !adapterSource.includes('activeSeed.initialTailPending ='),
    'live active seed is captured once, cloned without mutation, and replacement initial tail is disabled');
  for (const policyGuard of [
    'rangePolicy: update.rangePolicy === undefined ? undefined : cloneRangePolicy(update.rangePolicy),',
    'readonly rangePolicy: ResolvedRangePolicy;',
    'const inheritedPolicy = control.seed?.rangePolicy;',
    'const selectedPolicy = current.rangePolicy;',
    'rangePolicy,'
  ]) assertContains(adapterSource, policyGuard, `staged immutable range policy ownership retained: ${policyGuard}`);
  assertContains(adapterSource, 'getRange: () => active?.getRange() || emptySnapshot(),',
    'candidate policy remains invisible through the public live range before the owner barrier');
  const abortStart = adapterSource.indexOf('abort() {');
  const abortOrder = [
    'entry.candidate?.destroy();', "entry.phase = 'aborted';", 'open = null;', 'for (const intent of entry.conflicts) {'
  ].map((needle) => adapterSource.indexOf(needle, abortStart));
  assert(abortStart >= 0 && abortOrder.every((index) => index >= 0)
    && abortOrder.every((index, offset) => offset === 0 || index > abortOrder[offset - 1])
    && !adapterSource.slice(abortOrder[0], abortOrder.at(-1)).includes('active = entry.candidate;'),
    'prebarrier abort disposes only the candidate and retains the exact active policy owner before replay');
  assert(count(adapterSource, 'active = entry.candidate;') === 1,
    'range policy crosses exactly the sole aggregate active-owner barrier with no second barrier');
  assertContains(adapterSource, "if (entry.phase !== 'finalized' || !entry.candidate || !entry.snapshot) return false;",
    'finalization completion permits the initial null old owner');
  assertContains(adapterSource, 'detachOld: initialAttempt, attachNew: false, releaseOld: initialAttempt,',
    'initial null-old detach/release completion is pre-satisfied');
  const barrier = [
    'entry.old = active;', 'entry.old?._setCallbacksSuppressed(true);', 'active = entry.candidate;',
    "entry.phase = 'finalized';", 'open = null;', 'completeFinalization(entry);'
  ].map((needle) => adapterSource.indexOf(needle));
  assert(barrier.every((index) => index >= 0) && barrier.every((index, offset) => offset === 0 || index > barrier[offset - 1]),
    'A2.11 retains one ordered nonthrowing active-owner barrier before contained completion');
  assertContains(adapterSource, 'let observer: ResizeObserverLike | null = null;', 'candidate observer ownership starts lazy');
  const observerFactory = adapterSource.indexOf('observer = new ResizeObserverClass(');
  const activation = adapterSource.indexOf('const measurementObserver = ensureObserver();');
  assert(observerFactory > activation && count(adapterSource, 'new ResizeObserverClass(') === 1,
    'ResizeObserver construction is singular and reachable only from activation');
  assertContains(mainSource, "initialOwnerMode: 'deferred-transaction',",
    'main requests deferred mode only for its unpublished candidate');
  assertContains(mainSource, "getInitialOwnerState.call(candidateAdapter) !== 'deferred'",
    'main validates deferred shell state before the one begin');
  assertContains(mainSource, 'unpublishedChatWindowCandidateAcceptedStates.set(candidateAdapter, candidateAcceptedState);',
    'main journals reversible shell reservation from prepublication C0');
  assert(count(mainSource, 'beginTransaction.call(candidateAdapter, adapterUpdate)') === 1,
    'A2.11 preserves A2.10 one actual begin/handle ownership');
}

function runA15ImmutablePolicyGuards(source) {
  const frozenFunctions = new Map([
    ['function disableChatWindowForSession(', 'b0cd6aa7ee2b4b185b7662bb8c4bb1160262f1067d155ddb43c8ca62926090da'],
    ['function ensureChatWindowAdapter(', 'ae56a270577c3d327a551f9c9c02285a8d3fb3a0e7016ad944d2bec59410fba7'],
    ['function emitChatRenderMetricsSummary()', '0a83631cea8bc6d3fb274efb289fe413fea400761b192416ff3e91002ab07c5f'],
    ['function scheduleRenderFromState(', 'b2977c0a62af34a61c73fa241bfe685c3efdb8823718665e5c040e6dd44d8ded'],
    ['function noteFullRenderRequest(', 'a71bab2243fadd3aa6282053598225d5a9ce58dc016dba0e6bad4b79eceb1f8b']
  ]);
  for (const [marker, expected] of frozenFunctions) assertFunctionHash(source, marker, expected);

  for (const declaration of [
    'const CHAT_WINDOW_INITIAL_TAIL = 80;',
    'const CHAT_WINDOW_OVERSCAN = 20;',
    'const CHAT_WINDOW_MOUNT_LIMIT = 140;',
    'const CHAT_WINDOW_DIRECT_CHILD_LIMIT = 146;',
    'const CHAT_RENDER_DESCENDANT_WARNING_THRESHOLD = 4000;',
    'const CHAT_RENDER_METRICS_SUMMARY_INTERVAL_MS = 30000;'
  ]) {
    assert(count(source, declaration) === 1, `frozen declaration occurs exactly once: ${declaration}`);
  }
  const descendantThresholds = [...source.matchAll(/const\s+CHAT_RENDER_[A-Z0-9_]*DESCENDANT[A-Z0-9_]*\s*=\s*(\d+)\s*;/g)];
  assert(descendantThresholds.length >= 1, 'at least one named descendant warning threshold exists');
  assert(descendantThresholds.every((match) => Number(match[1]) === 4000), 'every named descendant warning threshold remains 4000');

  const budget = extractFunction(source, 'function assertChatWindowDomBudget(');
  assertContains(budget, 'window.__ocChatWindowDomBudgetAudit = Object.freeze({', 'budget pressure publishes one immutable audit record');
  assertContains(budget, 'mountedUnits: bounded(budget.mountedUnits)', 'mounted pressure is recorded as a bounded scalar');
  assertContains(budget, 'directChildren: bounded(budget.directChildren)', 'direct-child pressure is recorded as a bounded scalar');
  assertContains(budget, 'descendants: bounded(budget.descendants)', 'descendant pressure is recorded as a bounded scalar');
  assertContains(budget, 'mountedExceeded: budget.mountedUnits > CHAT_WINDOW_MOUNT_LIMIT', 'mounted cap is a nonthrow audit flag');
  assertContains(budget, 'directChildrenExceeded: budget.directChildren > CHAT_WINDOW_DIRECT_CHILD_LIMIT', 'direct-child cap is a nonthrow audit flag');
  assertContains(budget, 'if (budget.descendants > 4000) descendantsAdvisory = true;', 'descendants above 4000 remain advisory');
  assertContains(budget, 'descendantsAdvisory', 'descendant advisory state is included in the audit');
  assertContains(budget, 'return budget;', 'budget audit returns without pressure fallback');
  assert(!budget.includes('throw '), 'mounted/direct/descendant pressure audit never throws');
  assert(!budget.includes('activeSessionId') && !budget.includes('sessionId'), 'budget audit contains no session identifiers');
  for (const forbidden of [
    'disableChatWindowForSession', 'destroyChatWindowAdapter', 'failedSessionId',
    'applyChatWindowOrWave2', 'applyWindowedKeyedChatReconciliation', 'applyKeyedChatReconciliation',
    'renderFromState(', 'renderFromStateLegacy', 'full-history'
  ]) {
    assert(!budget.includes(forbidden), `budget pressure audit has no ${forbidden} side effect`);
  }

  const install = extractFunction(source, 'function installChatRenderMetrics(');
  const mutationStart = install.indexOf('new MutationObserver');
  const mutationEnd = install.indexOf('.observe(chatContainer', mutationStart);
  const mutationCallback = install.slice(mutationStart, mutationEnd);
  assertContains(mutationCallback, 'chatRenderMetricsDirty = true', 'mutation callback only marks diagnostics dirty');
  assert(!mutationCallback.includes('sampleChatRenderDom') && !mutationCallback.includes('querySelectorAll'), 'mutation callback performs no attribution/subtree scan');
  assertContains(install, "supportedEntryTypes.includes('longtask')", 'PerformanceObserver long-task gate remains');
  assertContains(install, "observer.observe({ type: 'longtask', buffered: true });", 'PerformanceObserver accounting remains buffered');
  assertContains(install, 'chatRenderMetricsSummaryTimer = setInterval(emitChatRenderMetricsSummary, CHAT_RENDER_METRICS_SUMMARY_INTERVAL_MS);', 'summary timer/cadence remains frozen');
  const observerStart = source.indexOf('const supportedEntryTypes');
  const observerEnd = source.indexOf('chatRenderMetricsSummaryTimer = setInterval', observerStart);
  assert(sourceHash(source.slice(observerStart, observerEnd)) === '5a72c3ac0e54b4ee23a3ebc4a3c04719995442e253c26cc1b1759a3160c12fd1', 'PerformanceObserver long-task accounting immutable source hash');

  const attribution = extractFunction(source, 'function recordChatWindowPressureAttribution(');
  assertContains(attribution, 'if (!isChatRenderMetricsEnabled()) return;', 'attribution remains metrics-gated');
  assertContains(attribution, '.slice(0, CHAT_WINDOW_MOUNT_LIMIT)', 'attribution model input remains bounded to mounted cap');
  assertContains(attribution, 'model.topContributors.slice(0, 8)', 'top contributors remain bounded to eight');
  assert(count(attribution, "root.querySelectorAll('*')") === 1, 'each mounted attribution root has one bounded descendant scan site');
  assert(!attribution.includes('__ocChatWindowDescendantAcceptanceBlocker') && !attribution.includes('...'), 'attribution constructs fresh fields without blocker forwarding or spreads');
  const lifecycle = extractFunction(source, 'function publishChatWindowPressureLifecycle(');
  assertContains(lifecycle, 'chatWindowPressureLifecycle.closures.slice(-8)', 'published lifecycle history remains bounded to eight');
  assertContains(source, 'chatWindowPressureLifecycle.closures = chatWindowPressureLifecycle.closures.slice(-8);', 'retained lifecycle history remains bounded to eight');

  const coordinator = extractFunction(source, 'function applyChatWindowOrWave2(');
  for (const forbidden of [
    'disableChatWindowForSession', 'destroyChatWindowAdapter', 'failedSessionId',
    'renderFromStateLegacy', 'applyKeyedChatReconciliation(session, units)', 'full-history'
  ]) {
    assert(!coordinator.includes(forbidden), `A2.4 coordinator has no ${forbidden} fail-open route`);
  }
  assertContains(coordinator, 'const boundedUnits = units.slice(-CHAT_WINDOW_INITIAL_TAIL);', 'unavailable baseline/bootstrap input is hard capped');
  assertContains(coordinator, 'const acceptedUnits = plan.acceptedKeys.map((key) => unitByKey.get(key)).filter(Boolean);', 'only planner-accepted units reach keyed apply');
  assertContains(coordinator, 'applyAcceptedOuterTransactionalBootstrap(session, acceptedUnits, shellRequests, plan);', 'bounded outer bootstrap delegates accepted units and selections transactionally');
  assertContains(coordinator, 'if (keyedRoots().length > 0)', 'adapter unavailability detects an existing bounded window');
  assertContains(coordinator, "return 'window-unavailable-retained';", 'adapter unavailability retains the last bounded window');
  assertContains(coordinator, 'const result = planAcceptedOuterTransactionalBootstrap(true);', 'empty adapter state uses safe capped transactional bootstrap');
  assertContains(coordinator, 'const acceptedSafeShellFamilies = new Set([', 'truthful retry is restricted to the accepted shell-family set');
  for (const family of [
    'message-user', 'message-assistant', 'message-tool-meta', 'message-subagent',
    'change-list', 'segment', 'conflict', 'message-image', 'message-code',
    'message-diff', 'message-table', 'message-markdown'
  ]) assertContains(coordinator, `'${family}'`, `truthful retry permits exact family ${family}`);
  assertContains(coordinator, "return candidates.length === 1 && acceptedSafeShellFamilies.has(candidates[0]) ? candidates[0] : '';", 'ambiguous/composite family selection stops without guessing');
  assertContains(coordinator, 'applyTransactionalWindow([shellRequest])', 'exception recovery starts one new transaction with one exact shell request');
  assert(count(coordinator, 'applyTransactionalWindow([shellRequest])') === 1, 'coordinator has exactly one truthful retry call site');
  assertContains(coordinator, 'acceptedPlanOverride: control.correctedPlan', 'A2.3 correction uses the committed correction plan in a separate transaction');
  assertContains(coordinator, 'skipCorrection: true', 'correction transaction cannot nest another correction');
  assertContains(coordinator, "return 'window-correction-retained';", 'correction failure retains committed C1');
  assertContains(coordinator, "publishRecovery('empty', 'bootstrap-transaction-failed', false, true);", 'transactional bootstrap failure remains empty and pending');
  assertContains(coordinator, "publishRecovery('retained', family ? 'retry-failed' : 'no-truthful-family', Boolean(family), true);", 'retry failure retains bounded state with pending diagnostics');
  assertContains(coordinator, "return 'outer-virtualized-baseline';", 'feature switch off uses the accepted outer-virtualized baseline');
  assertContains(coordinator, 'const containmentPolicyEnabled = typeof CHAT_WINDOW_CONTAINMENT_POLICY_ENABLED', 'containment switch uses an independent default-on gate');
  assertContains(coordinator, "return 'containment-policy-disabled-virtualized';", 'containment switch off routes to a virtualized baseline');
  assertContains(coordinator, 'const recoveryEnabled = typeof CHAT_WINDOW_RECOVERY_ENABLED', 'recovery switch uses an independent default-on gate');
  assertContains(coordinator, "return 'window-recovery-disabled-retained';", 'recovery switch off retains bounded state');
  assertContains(coordinator, "if (transactionMode === 'corruption-emergency')", 'emergency is an explicit bounded transaction mode');
  assert(!coordinator.includes(' 160') && !coordinator.includes('= 160'), 'coordinator has no 160-root hard path');

  const windowed = extractFunction(source, 'function applyWindowedKeyedChatReconciliation(');
  const keyed = extractFunction(source, 'function applyKeyedChatReconciliation(');
  const applyAcceptedPlan = windowed.indexOf('const applyAcceptedPlan = (acceptedPlan) =>');
  const planned = windowed.indexOf('const planned = stagedAttempt?.acceptedPlan ||');
  const transactionalKeyedApply = windowed.indexOf('applyKeyedChatReconciliation(session, acceptedUnits, acceptedPlan.shellSelections, journal);');
  assert(planned >= 0 && applyAcceptedPlan > planned && transactionalKeyedApply > applyAcceptedPlan,
    'transactional keyed apply is ordered after immutable containment planning');
  const outerPlanner = coordinator.indexOf('const plan = planContainment({');
  const outerTransactionalBootstrap = coordinator.indexOf('applyAcceptedOuterTransactionalBootstrap(session, acceptedUnits, shellRequests, plan);');
  assert(outerPlanner >= 0 && outerTransactionalBootstrap > outerPlanner,
    'outer bounded bootstrap delegates only after immutable containment planning');
  assert(count(source, 'applyKeyedChatReconciliation(session, legacyUnits)') === 0 && count(windowed, 'legacyUnits') === 0,
    'nontransactional legacyUnits keyed apply call-site count is zero');
  assertContains(source, "const CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT = Object.freeze({\n        ok: false,\n        status: 'window-transaction-unavailable',\n        reason: 'missing-begin-transaction'\n    });",
    'missing transaction capability uses one exact frozen sentinel');
  assertContains(source, "const CHAT_WINDOW_CANDIDATE_STALE_RESULT = Object.freeze({\n        ok: false,\n        status: 'window-candidate-stale',\n        reason: 'candidate-owner-stale'\n    });",
    'stale candidate ownership uses one exact frozen sentinel');
  const capabilityGate = windowed.indexOf("if (existingAdapter && typeof existingAdapter.beginTransaction !== 'function')");
  const capabilityReturn = windowed.indexOf('return CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT;', capabilityGate);
  const journalBegin = windowed.indexOf('beginChatPresentationJournal(');
  const preflight = windowed.slice(0, capabilityReturn + 'return CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT;'.length);
  assert(capabilityGate >= 0 && capabilityReturn > capabilityGate && capabilityReturn < journalBegin,
    'missing beginTransaction returns the exact sentinel before journal creation');
  for (const forbidden of [
    'applyKeyedChatReconciliation(', 'captureChatWindowAnchor(', 'resolveChatLocalHistoryWindow(',
    'reserveChatWindowStructuralRoots(', 'adapter.update(', 'getRange(', 'throw ', 'vscode.postMessage('
  ]) assert(!preflight.includes(forbidden), `missing transaction preflight has no ${forbidden} side effect`);
  assertContains(source, 'beginTransaction(adapterUpdate)', 'the product adapter path supplies transactional planning ownership');
  const planCap = windowed.indexOf('acceptedPlan.mountedCount > CHAT_WINDOW_MOUNT_LIMIT');
  const transactionBegin = windowed.indexOf('adapter.beginTransaction(adapterUpdate)');
  assert(transactionBegin >= 0 && journalBegin >= 0 && planned > transactionBegin
    && planCap > planned && transactionalKeyedApply > planCap && transactionalKeyedApply > journalBegin,
  'windowed keyed apply has transaction, journal, accepted planner, and 140/146 cap provenance');
  const outerBound = coordinator.indexOf('const boundedUnits = units.slice(-CHAT_WINDOW_INITIAL_TAIL);');
  assert(outerBound >= 0 && outerPlanner > outerBound && outerTransactionalBootstrap > outerPlanner,
    'outer bootstrap has capped accepted planner provenance');
  const bootstrap = extractFunction(source, 'function applyAcceptedOuterTransactionalBootstrap(');
  assertContains(bootstrap, 'applyWindowedKeyedChatReconciliation(session, acceptedUnits, shellRequests, {', 'bootstrap delegates to the accepted windowed transaction');
  assertContains(bootstrap, 'acceptedPlanOverride: acceptedPlan', 'bootstrap delegates the accepted immutable plan');
  assertContains(bootstrap, 'skipCorrection: true', 'bootstrap cannot enter correction recursion');
  for (const forbidden of ['applyChatWindowOrWave2(', 'applyKeyedChatReconciliation(', 'beginChatPresentationJournal(', 'renderFromStateLegacy']) {
    assert(!bootstrap.includes(forbidden), `bootstrap has no ${forbidden} ownership`);
  }
  assert(count(windowed, 'applyKeyedChatReconciliation(') === 1 && count(coordinator, 'applyKeyedChatReconciliation(') === 0,
    'the sole keyed apply call site is the accepted windowed transaction');
  assert(windowed.indexOf('beginChatPresentationJournal(') < windowed.indexOf('captureChatWindowAnchor();'), 'window transaction checkpoint precedes live mutation');
  assertContains(windowed, 'abortChatPresentationJournal(journal);', 'window transaction failures abort the exact attempt journal');
  assertContains(keyed, "Object.defineProperty(error, '__ocChatReconcileFailure'", 'attempted failure ownership survives exact C0 rollback without global leakage');
  for (const ordered of [
    ['adapterTransaction.prepareCommit()', transactionalKeyedApply],
    ['adapterTransaction.commit()', windowed.indexOf('adapterTransaction.commit()')],
    ["runChatPresentationFailureSeam('adapter-sealed-pre-finalize'", windowed.indexOf("runChatPresentationFailureSeam('adapter-sealed-pre-finalize'")],
    ['adapterTransaction.finalizeCommit()', windowed.indexOf('adapterTransaction.finalizeCommit()')],
    ['finalizeChatPresentationJournal(journal)', windowed.indexOf('finalizeChatPresentationJournal(journal)')]
  ]) assert(ordered[1] >= 0, `transaction stage exists: ${ordered[0]}`);
  assert(windowed.indexOf('adapterTransaction.prepareCommit()') < transactionalKeyedApply
    && transactionalKeyedApply < windowed.indexOf('adapterTransaction.commit()')
    && windowed.indexOf('adapterTransaction.commit()') < windowed.indexOf("runChatPresentationFailureSeam('adapter-sealed-pre-finalize'")
    && windowed.indexOf("runChatPresentationFailureSeam('adapter-sealed-pre-finalize'") < windowed.indexOf('adapterTransaction.finalizeCommit()')
    && windowed.indexOf('adapterTransaction.finalizeCommit()') < windowed.indexOf('finalizeChatPresentationJournal(journal)'),
  'transaction prepare/apply/seal/finalize barriers remain ordered');

  const prepareCandidate = extractFunction(source, 'function prepareUnpublishedChatWindowTransaction(');
  const candidateCleanup = extractFunction(source, 'function disposeUnpublishedChatWindowAdapterCandidate(');
  const candidatePlan = prepareCandidate.indexOf('planContainment({');
  const candidateUpdate = prepareCandidate.indexOf('const adapterUpdate = Object.freeze({');
  const candidateFactory = prepareCandidate.indexOf('rendering.createTanStackVirtualAdapter({');
  const candidateBegin = prepareCandidate.indexOf('beginTransaction.call(candidateAdapter, adapterUpdate)');
  const candidateOwnerCheck = prepareCandidate.indexOf("if ((activeSessionId || '__no_session__') !== capturedActiveSessionId");
  const candidatePublish = prepareCandidate.indexOf('chatWindowState.adapter = candidateAdapter;');
  assert(candidatePlan >= 0 && candidateUpdate > candidatePlan && candidateFactory > candidateUpdate
    && candidateBegin > candidateFactory && candidateOwnerCheck > candidateBegin && candidatePublish > candidateOwnerCheck,
  'candidate pure plan/exact update/factory/one begin/owner validation precede live publication');
  assert(count(prepareCandidate, 'beginTransaction.call(candidateAdapter, adapterUpdate)') === 1,
    'unpublished candidate opens exactly one actual accepted transaction');
  for (const method of [
    'getRange', 'update', 'observeElement', 'unobserveElement', 'invalidateMeasurement',
    'setPresentationRevision', 'migrateKey', 'prepareCommit', 'commit', 'finalizeCommit',
    'retryCompletion', 'isFinalized', 'isDegraded', 'hasPendingCompletion', 'abort'
  ]) assertContains(source, `'${method}'`, `candidate validates required transaction method ${method}`);
  assertContains(prepareCandidate, 'if (!published) return;', 'candidate callbacks remain gated before publication');
  assertContains(prepareCandidate, 'abortCandidateTransaction();', 'candidate rejection best-effort aborts its one handle');
  assertContains(prepareCandidate, 'disposeUnpublishedChatWindowAdapterCandidate(candidateAdapter);', 'candidate rejection uses candidate-only cleanup');
  assertContains(candidateCleanup, 'candidateAdapter.destroy', 'candidate-only cleanup invokes optional candidate destroy');
  assert(!candidateCleanup.includes('destroyChatWindowAdapter') && !candidateCleanup.includes('chatWindowState'),
    'candidate-only cleanup cannot reach live adapter ownership');
  assertContains(windowed, 'transactionControl?.stagedAttempt', 'windowed path accepts only the closed staged attempt field');
  assertContains(windowed, 'adapterTransaction = stagedAttempt?.adapterTransaction || adapter.beginTransaction(adapterUpdate);',
    'windowed path reuses the staged handle and begins only for an existing compatible adapter');
  assertContains(windowed, 'const localWindow = stagedAttempt?.localWindow || (() => {',
    'windowed path reuses staged pure local-window identity');

  const correction = extractFunction(source, 'function scheduleChatWindowPlanCorrection(');
  assertContains(correction, 'chatWindowPlanCorrection.planRevision === planRevision', 'correction is deduplicated by owner generation and plan revision');
  assertContains(correction, 'return reduced ? correctedPlan : null;', 'only a reducing correction plan can be scheduled');
  assert(!correction.includes('throw '), 'mounted/direct correction scheduling is nonthrowing');
  assert(!correction.includes('disableChatWindowForSession') && !correction.includes('renderFromStateLegacy'), 'correction has no disable or legacy route');

  const consumeIntegrity = extractFunction(source, 'function consumeChatWindowIntegrityAudit(');
  assertContains(consumeIntegrity, 'if (samples.length !== 1 || typeof classify !== \'function\') return false;', 'emergency requires exactly one raw integrity sample');
  assertContains(consumeIntegrity, 'classifications.length !== 1', 'emergency requires exactly one closed classification');
  assertContains(consumeIntegrity, 'classification.code === samples[index]?.code', 'emergency classification must correspond to the raw closed code');
  assertContains(consumeIntegrity, '!CHAT_WINDOW_EMERGENCY_ENABLED', 'emergency switch independently retains classified pending evidence');
  assert(!consumeIntegrity.includes('renderFromStateLegacy') && !consumeIntegrity.includes('disableChatWindowForSession'), 'integrity consumption has no legacy or disable route');
  const enterEmergency = extractFunction(source, 'function enterChatWindowEmergency(');
  const recordOuterRecovery = extractFunction(source, 'function recordChatWindowOuterRecovery(');
  for (const [recoveryBlock, label] of [[enterEmergency, 'emergency entry'], [recordOuterRecovery, 'outer pending recovery']]) {
    assert(!recoveryBlock.includes('renderFromStateLegacy') && !recoveryBlock.includes('disableChatWindowForSession'),
      `${label} has zero legacy and session-disable call sites`);
  }
  const ensureAdapter = extractFunction(source, 'function ensureChatWindowAdapter(');
  assertContains(ensureAdapter, 'prepareUnpublishedChatWindowTransaction(', 'no-owner ensure delegates to the closed candidate staging helper');
  assert(!ensureAdapter.includes('rendering.createTanStackVirtualAdapter({'), 'ensure never publishes a factory result directly');
  assert(count(prepareCandidate, 'rendering.createTanStackVirtualAdapter({') === 1,
    'the transactional product candidate factory is singular');
  assert(!budget.includes('160') && !windowed.includes('160') && !coordinator.includes('160'),
    'containment, audit, and recovery paths contain no 160 hard-cap route');

  for (const declaration of [
    'const CHAT_WINDOW_CONTAINMENT_POLICY_ENABLED = window.__ocChatWindowContainmentPolicyEnabled !== false;',
    'const CHAT_WINDOW_RECOVERY_ENABLED = window.__ocChatWindowRecoveryEnabled !== false;',
    'const CHAT_WINDOW_EMERGENCY_ENABLED = window.__ocChatWindowEmergencyEnabled !== false;'
  ]) assert(count(source, declaration) === 1, `virtualized switch declaration occurs exactly once: ${declaration}`);

  const outer = extractFunction(source, 'function renderFromState()');
  const legacy = extractFunction(source, 'function renderFromStateLegacy()');
  for (const forbidden of [
    'renderFromStateLegacy', "chatContainer.innerHTML = ''", 'destroyChatWindowAdapter',
    'applyKeyedChatReconciliation(session, units)', 'keyedChatReconcileState = { sessionId:'
  ]) assert(!outer.includes(forbidden), `A2.5 outer gate/catch has no automatic ${forbidden} route`);
  assertContains(outer, 'recordChatWindowOuterRecovery(owner,', 'outer exceptions retain generation-owned pending evidence');
  assertContains(outer, 'captureChatWindowRawIntegrityAudit()', 'outer path records raw integrity evidence before classifier wiring');
  assert(!outer.includes('classifyChatWindowIntegrity') && !outer.includes('emergency'), 'A2.5R outer path has no classifier or emergency wiring');
  assert(!coordinator.includes('disableChatWindowForSession') && !outer.includes('disableChatWindowForSession'),
    'recovery coordinator and outer gate have zero session-disable call sites');
  assertContains(legacy, "chatContainer.innerHTML = '';", 'historical legacy renderer definition retains its full-clear diagnostic contract');
  assert(count(source, 'renderFromStateLegacy();') === 0, 'automatic legacy fallback call-site count is zero');
  assert(count(source, 'const chatWindowRoute = applyChatWindowOrWave2(session, units);') === 1,
    'window coordinator route is captured exactly once');
  assert(count(source, 'if (!CHAT_WINDOW_RAW_AUDIT_ACCEPTED_ROUTES.has(chatWindowRoute)) {') === 1,
    'raw integrity audit is gated by the closed accepted-route set');
  assert(count(source, "destroyChatWindowAdapter('window-unavailable')") === 0, 'window-unavailable destroy route remains removed');
  assert(count(source, "destroyChatWindowAdapter('keyed-reconcile-failure')") === 0, 'outer exception adapter-destroy call-site count is zero');
  assert(count(source, "destroyChatWindowAdapter('session-switch')") === 1, 'session-switch destroy ownership remains singular at the explicit owner gate');
  assert(count(source, 'rendering.createTanStackVirtualAdapter({') === 1, 'adapter creation ownership remains singular');

  return {
    environment: 'node-synthetic',
    syntheticNotBrowserTiming: true,
    frozenFunctionHashes: frozenFunctions.size,
    namedDescendantThresholds: descendantThresholds.length,
    fallbackCallSites: { legacy: 0, coordinator: 0 },
    bounds: { mounted: 140, directChildren: 146, descendants: 4000, initialTail: 80, overscan: 20, topK: 8, history: 8 }
  };
}

function runB3DormantAdaptiveShadowGuards(source) {
  assert(count(source, 'const CHAT_WINDOW_ADAPTIVE_SHADOW_CONFIG = Object.freeze({') === 1,
    'B3 has one production adaptive-shadow configuration');
  assertContains(source, "const CHAT_WINDOW_ADAPTIVE_RANGE_ENABLED = window.__ocChatWindowAdaptiveRangeEnabled !== false;",
    'adaptive range has one independent boot-time rollback switch');
  assertContains(source, 'enabled: CHAT_WINDOW_ADAPTIVE_RANGE_ENABLED,\n        revision: 2,',
    'production adaptive configuration is the reviewed revision 2');
  const observe = extractFunction(source, 'function observeChatWindowAdaptiveShadow(');
  assertContains(observe, 'window.__ocRendering?.decideChatWindowAdaptivePolicy',
    'B3 calls only the reviewed hidden pure facade method');
  assertContains(observe, 'syntheticEnvironment: window.__ocChatWindowAdaptiveShadowTestConfig?.syntheticEnvironment === true',
    'B3 test-only configuration is explicit and synthetic');
  for (const forbidden of [
    'adapterUpdate', 'rangePolicy', 'planChatWindowContainment', 'applyKeyedChatReconciliation',
    'scrollToBottom', 'scheduleRenderFromState', 'restoreChatWindowAnchor',
    'enterChatWindowEmergency', 'applyChatWindowOrWave2'
  ]) assert(!observe.includes(forbidden), `B3 policy result has no ${forbidden} side effect`);
  const publish = extractFunction(source, 'function publishChatWindowAdaptiveShadowTelemetry(');
  for (const forbidden of ['sessionId', 'unitKey', 'content', 'searchText', 'path', 'html', 'payload']) {
    assert(!publish.includes(forbidden), `B3 closed telemetry has no ${forbidden}`);
  }
  const candidate = extractFunction(source, 'function prepareUnpublishedChatWindowTransaction(');
  assertContains(candidate, 'overscan: CHAT_WINDOW_OVERSCAN,', 'B3 adapter creation retains active overscan 20 literal owner');
  assertContains(candidate, 'initialTailCount: CHAT_WINDOW_INITIAL_TAIL,', 'B3 adapter creation retains active tail 80 literal owner');
  assertContains(candidate, "typeof consumeChatWindowSyntheticEvidenceRequest === 'function'",
    'B4-BT candidate policy is gated by the one-shot synthetic request');
  assertContains(candidate, "}) : typeof resolveChatWindowAdaptiveRangePolicy === 'function'",
    'normal candidate transactions consume only committed adaptive state');
  assertContains(candidate, '...(rangePolicy ? { rangePolicy } : {})',
    'B4-BT candidate stages policy only when the synthetic request is accepted');
  assert(count(candidate, "kind: 'self', decisionGeneration:") === 2,
    'B3 real range and measurement callbacks each use committed self provenance');
  assert(count(candidate, 'observeChatWindowAdaptiveShadow(') === 2,
    'B3 real adapter callbacks own exactly two dormant shadow observation callsites');
  const selfBranchStart = observe.indexOf('if (selfObservation) {');
  const selfRetainStart = observe.indexOf('chatWindowAdaptiveShadow = Object.freeze({', selfBranchStart + 1);
  const externalCommitStart = observe.indexOf('chatWindowAdaptiveShadow = Object.freeze({', selfRetainStart + 1);
  const selfBranch = observe.slice(selfBranchStart, externalCommitStart);
  assert(selfBranchStart >= 0 && selfRetainStart > selfBranchStart && externalCommitStart > selfRetainStart,
    'B3 observer has an explicit self result branch before external commit');
  assertContains(selfBranch, 'state: chatWindowAdaptiveShadow.state,',
    'B3 self result retains the exact committed policy state');
  assert(!selfBranch.includes('publishChatWindowAdaptiveShadowTelemetry'),
    'B3 self result cannot publish committed-success telemetry');
  const windowed = extractFunction(source, 'function applyWindowedKeyedChatReconciliation(');
  assertContains(windowed, "kind: 'external', decisionGeneration:",
    'B3 post-apply DOM budget observation remains externally attributable');
  assert(windowed.indexOf('observeChatWindowAdaptiveShadow(applied.adaptiveObservations')
    > windowed.indexOf('finalizeChatPresentationJournal(journal)'),
  'adaptive external observation commits only after adapter and DOM journal finalization');
  const resolver = extractFunction(source, 'function resolveChatWindowAdaptiveRangePolicy(');
  assertContains(resolver, 'chatWindowAdaptiveShadow.ownerSessionId !== ownerSessionId',
    'runtime policy rejects stale session ownership');
  assertContains(resolver, 'chatWindowAdaptiveShadow.ownerGeneration !== boundedChatAdaptiveCount(chatWindowGeneration)',
    'runtime policy rejects stale generation ownership');
  for (const forbidden of ['scheduleRenderFromState', 'applyKeyedChatReconciliation', 'adapterUpdate', 'scrollToBottom']) {
    assert(!selfBranch.includes(forbidden), `B3 self result has no ${forbidden} edge`);
  }
  const destroy = extractFunction(source, 'function destroyChatWindowAdapter(');
  assertContains(destroy, 'resetChatWindowAdaptiveShadow(reason, destroyedGeneration);',
    'B3 adapter destruction resets exact generation-owned shadow state');
  assertContains(extractFunction(source, 'function enterChatWindowEmergency('),
    "resetChatWindowAdaptiveShadow('emergency-entry');", 'B3 emergency entry resets shadow state');
  assertContains(extractFunction(source, 'function retryChatWindowEmergency('),
    "resetChatWindowAdaptiveShadow('emergency-retry');", 'B3 emergency retry resets shadow state');
  const accepted = extractFunction(source, 'function captureChatWindowAcceptedState(');
  assert(!accepted.includes('chatWindowAdaptiveShadow'), 'B3 shadow state is absent from canonical transaction snapshots');
}

function runB4AInertSyntheticCapabilityGuards(source) {
  assert(count(source, 'const B4_SYNTHETIC_EVIDENCE_BOOT_ACCEPTED =') === 1,
    'B4-A captures the accepted synthetic environment exactly once at boot');
  assertContains(source,
    'const B4_SYNTHETIC_EVIDENCE_BOOT_ACCEPTED = window.__ocChatWindowAdaptiveShadowTestConfig?.syntheticEnvironment === true;',
    'B4-A reuses only the accepted B3 synthetic condition');
  const tableStart = source.indexOf('const B4_SYNTHETIC_EVIDENCE_OPTIONS = Object.freeze([');
  const tableEnd = source.indexOf('let chatWindowSyntheticEvidenceRequest = null;', tableStart);
  assert(tableStart >= 0 && tableEnd > tableStart, 'B4-A closed option table is bounded');
  const table = source.slice(tableStart, tableEnd);
  assert((table.match(/Object\.freeze\(\{ optionIndex: [0-8], overscanTier: (20|10|4), initialTail: (80|40|24), forwardReserve: \d+, backwardReserve: \d+ \}\)/g) || []).length === 9,
    'B4-A owns exactly nine frozen closed options');
  const seam = [
    extractFunction(source, 'function clearChatWindowSyntheticEvidenceRequest()'),
    extractFunction(source, 'function armChatWindowSyntheticEvidenceRequest('),
    extractFunction(source, 'function consumeChatWindowSyntheticEvidenceRequest(')
  ].join('\n');
  for (const forbidden of [
    'rangePolicy', 'adapterUpdate', 'beginTransaction', 'planContainment', 'applyKeyedChatReconciliation',
    'scheduleRenderFromState', 'decideChatWindowAdaptivePolicy', 'observeChatWindowAdaptiveShadow',
    'publishChatWindowAdaptiveShadowTelemetry', 'localStorage', 'sessionStorage', 'snapshot', 'hydrate'
  ]) assert(!seam.includes(forbidden), `B4-A inert seam has no ${forbidden} edge`);
  assert(count(source, 'function armChatWindowSyntheticEvidenceRequest(optionIndex)') === 1,
    'B4-A has one lexical arm owner');
  assert(count(source, 'function consumeChatWindowSyntheticEvidenceRequest(token)') === 1,
    'B4-A has one lexical consume owner');
  assert(count(source, 'consumeChatWindowSyntheticEvidenceRequest(token)') === 1,
    'B4-A retains one consume owner');
  assertContains(source, "Object.defineProperty(window, '__ocChatWindowAdaptiveEvidence', {",
    'B4-A exposes only one fixed synthetic hook property');
  assertContains(extractFunction(source, 'function destroyChatWindowAdapter('),
    'clearChatWindowSyntheticEvidenceRequest();', 'B4-A destroys armed inert state with adapter ownership');
  const prepare = extractFunction(source, 'function prepareUnpublishedChatWindowTransaction(');
  const windowed = extractFunction(source, 'function applyWindowedKeyedChatReconciliation(');
  for (const [name, body] of [['prepare', prepare], ['windowed', windowed]]) {
    assert(count(body, 'consumeChatWindowSyntheticEvidenceRequest(') === 1,
      `B4-BT ${name} path has one consume edge`);
    assertContains(body, 'syntheticEvidenceToken', `B4-BT ${name} consume is transaction-control owned`);
    assertContains(body, 'syntheticEvidenceDirection', `B4-BT ${name} direction is transaction-control owned`);
    assertContains(body, 'const rangePolicy = syntheticEvidenceRequest ? Object.freeze({',
      `B4-BT ${name} freezes the exact staged range policy`);
    for (const field of ['overscanTier:', 'beforeReserve:', 'afterReserve:', 'initialTail:']) {
      assertContains(body, field, `B4-BT ${name} policy owns ${field}`);
    }
    assertContains(body, '...(rangePolicy ? { rangePolicy } : {})',
      `B4-BT ${name} passes policy through the adapter transaction update only when armed`);
  }
  assert(source.indexOf('consumeChatWindowSyntheticEvidenceRequest(transactionControl?.syntheticEvidenceToken)', source.indexOf('function prepareUnpublishedChatWindowTransaction('))
    < source.indexOf('const adapterUpdate = Object.freeze({', source.indexOf('function prepareUnpublishedChatWindowTransaction(')),
  'B4-BT prepare consumes before constructing adapterUpdate');
  assert(source.indexOf('consumeChatWindowSyntheticEvidenceRequest(transactionControl?.syntheticEvidenceToken)', source.indexOf('function applyWindowedKeyedChatReconciliation('))
    < source.indexOf('const adapterUpdate = stagedAttempt?.adapterUpdate || {', source.indexOf('function applyWindowedKeyedChatReconciliation(')),
  'B4-BT windowed path consumes before constructing adapterUpdate');
  assertContains(windowed, "const transactionOwnerSessionId = activeSessionId || '__no_session__';",
    'B4-C freezes the post-staging transaction session owner');
  assertContains(windowed, 'const transactionOwnerGeneration = chatWindowGeneration;',
    'B4-C freezes the post-staging transaction generation owner');
  assertContains(windowed, 'const transactionOwnerAdapter = chatWindowState.adapter;',
    'B4-C freezes the post-staging adapter owner');
  const staleOwnerCheck = windowed.indexOf("if ((activeSessionId || '__no_session__') !== transactionOwnerSessionId");
  const keyedApply = windowed.indexOf('applyKeyedChatReconciliation(session, acceptedUnits, acceptedPlan.shellSelections, journal);');
  const barrier = windowed.indexOf('adapterTransaction.finalizeCommit()');
  assert(staleOwnerCheck >= 0 && staleOwnerCheck < keyedApply && keyedApply < barrier,
    'B4-C rejects stale transaction ownership before keyed apply and the owner barrier');
  assertContains(windowed.slice(staleOwnerCheck, keyedApply), 'abortChatPresentationJournal(journal);',
    'B4-C stale-owner rejection restores the accepted journal state');
  assert(count(source, 'if (B4_SYNTHETIC_EVIDENCE_BOOT_ACCEPTED) {') === 1,
    'B4-E synthetic hook installation has one boot-only gate');
  assert(count(windowed, 'adapterTransaction = stagedAttempt?.adapterTransaction || adapter.beginTransaction(adapterUpdate);') === 1,
    'B4-E window path has one exact range-policy-bearing transaction handle');
  assert(count(windowed, "journal = typeof beginChatPresentationJournal === 'function'") === 1,
    'B4-E window path begins one presentation journal');
  assert(count(windowed, "const planContainment = stagedAttempt ? null : renderingFacade?.planChatWindowContainment;") === 1,
    'B4-E window path owns one candidate planner handle');
  const syntheticRangeBlock = windowed.slice(
    windowed.indexOf('const syntheticEvidenceRequest ='),
    windowed.indexOf('const transactionOwnerSessionId ='),
  );
  for (const forbidden of ['scheduleRenderFromState', 'recordChatWindowOuterRecovery',
    'publishChatWindowAdaptiveShadowTelemetry', 'observeChatWindowAdaptiveShadow']) {
    assert(!syntheticRangeBlock.includes(forbidden), `B4-E synthetic range seam leaves ${forbidden} unchanged`);
  }
}

function runB4BTConsumerGuards(synthetic, helper) {
  assertContains(synthetic, "require('./chat-window-adaptive-range-harness.js')",
    'B4-BT CLI consumes the accepted shared harness');
  assertContains(synthetic, 'createRealTransactionHarness({ execute: executeCurrentMainFunctions })',
    'B4-BT CLI executes extracted production through the shared harness');
  assertContains(synthetic, 'if (require.main === module) main();', 'B4-BT CLI is inert on import');
  assert(!synthetic.includes('function optionEvidence()'), 'B4-BT removes the local option producer');
  assert(!synthetic.includes('before + 12 + after'), 'B4-BT removes substitute range arithmetic');
  assert(!synthetic.includes('harness.adapter.beginTransaction({'), 'B4-BT has no direct adapter-only evidence transaction');
  assert(count(synthetic, 'functionHashes: Object.fromEntries([') === 1,
    'B4-BT writes five normalized production hashes once at top-level authenticity');
  assert(!/independentSpyEvents|callCounts/.test(synthetic), 'B4-BT records contain no local self-attestation');
  assert(count(helper, 'function createRealTransactionHarness(') === 1,
    'B4-BT retains one shared harness owner');
  assert(count(synthetic, 'function rawFailureEvidence()') === 1,
    'B4-E owns one raw failure-evidence producer');
  assert(count(synthetic, 'function reduceFinalSummary({ options, failures, workflows, traces, smoke })') === 1,
    'B4-E owns one final raw A-D reducer');
  assertContains(synthetic, 'const summary = reduceFinalSummary({ options, failures, workflows, traces, smoke });',
    'B4-E final summary consumes every raw A-D record group');
  assertContains(synthetic, 'failures,\n    workflows,\n    traces,\n    smoke,\n    summary,',
    'B4-E publishes raw groups before the single reduced summary');
  for (const obsolete of ['optionSummary', 'reviewerDecision']) {
    assert(!synthetic.includes(obsolete), `B4-E removes obsolete ${obsolete} evidence`);
  }
  for (const rawType of ['transaction-begin', 'planner', 'journal-begin', 'geometry-pre', 'geometry-post',
    'failure-after', 'owner-call', 'patch']) {
    assertContains(synthetic, `type === '${rawType}'`, `B4-E summary reduces raw ${rawType} records`);
  }
}

function run() {
  assert(typeof runA15ImmutablePolicyGuards === 'function', 'A1.5 immutable policy guards must exist');
  const source = read('media/main.js');
  const b4Synthetic = read('scripts/chat-window-adaptive-range-synthetic.js');
  const b4Helper = read('scripts/chat-window-adaptive-range-harness.js');
  const recoveredSource = read('.opencode/attachments/2026-07-16-wave-b4s-recovered-reviewed/media-main.js');
  const adapterSource = read('webview-src/rendering/tanstack-virtual-adapter.ts');
  const a15 = runA15ImmutablePolicyGuards(source);
  runA211DeferredInitialOwnerGuards(source, adapterSource);
  runB3DormantAdaptiveShadowGuards(source);
  runB4AInertSyntheticCapabilityGuards(source);
  runB4BTConsumerGuards(b4Synthetic, b4Helper);

  for (const field of [
    'projection', 'fullRender', 'richEnhancement', 'appendFastPath', 'streamPatch',
    'directChildren', 'descendants', 'renderReasons', 'pinnedState',
    'timelineCount', 'renderedCount', 'longTasks'
  ]) {
    assertContains(source, field, `aggregate metrics field ${field} exists`);
  }

  assertContains(source, "localStorage.getItem('oc_chat_render_metrics') === '1'", 'metrics are developer guarded');
  assertContains(source, "supportedEntryTypes.includes('longtask')", 'long-task support is checked');
  assertContains(source, "observer.observe({ type: 'longtask', buffered: true });", 'long-task observer is guarded and buffered');
  assertContains(source, 'chatRenderLongTaskObserver?.disconnect();', 'long-task observer is disposable');
  assertContains(source, 'CHAT_RENDER_DIRECT_CHILD_WARNING_THRESHOLD = 160', 'direct-child warning threshold is exactly 160');
  assertContains(source, 'CHAT_RENDER_DESCENDANT_WARNING_THRESHOLD = 4000', 'descendant warning threshold is exactly 4000');
  assertContains(source, 'CHAT_RENDER_METRICS_SUMMARY_INTERVAL_MS = 30000', 'summary frequency is low-volume');
  assertContains(source, 'CHAT_RENDER_WARNING_INTERVAL_MS = 30000', 'warnings are rate limited');
  assertContains(source, "['50', '200', '1000+']", 'static synthetic scenario bands are recorded');

  const metricsBlockStart = source.indexOf('const CHAT_RENDER_METRICS_SCHEMA_VERSION');
  const metricsBlockEnd = source.indexOf('function getUnclearAnchorCircuitBreakerKey', metricsBlockStart);
  assert(metricsBlockStart >= 0 && metricsBlockEnd > metricsBlockStart, 'bounded metrics implementation block exists');
  const metricsBlock = source.slice(metricsBlockStart, metricsBlockEnd);
  for (const forbidden of ['message.text', 'message.content', 'msg.text', 'content.textContent', 'innerHTML']) {
    assert(!metricsBlock.includes(forbidden), `metrics do not capture message content via ${forbidden}`);
  }
  for (const forbidden of ['requestAnimationFrame(', 'requestIdleCallback(', '.appendChild(', '.remove(', '.innerHTML =', '.replaceChildren(']) {
    assert(!metricsBlock.includes(forbidden), `instrumentation does not schedule rendering or mutate DOM via ${forbidden}`);
  }

  assert(count(source, 'renderFromStateLegacy();') === 0, 'no automatic legacy renderer call site exists');
  assert(count(source, 'const CHAT_WINDOW_MOUNT_LIMIT = 140;') === 1, 'hard mounted cap is exactly 140');
  assert(count(source, 'const CHAT_WINDOW_DIRECT_CHILD_LIMIT = 146;') === 1, 'hard direct-child cap is exactly 146');
  assertContains(source, 'renderMessageElement(message, renderedSet);', 'append fast path still delegates to the existing renderer');
  assertContains(source, 'renderAssistantMarkdown(content, message);', 'stream patch still uses the existing markdown renderer');
  assertContains(source, 'appendChatRenderRoot(messageElement);', 'message factories route structural insertion through the keyed capture seam');
  assertContains(source, 'chatContainer.insertBefore(root, currentAtIndex);', 'keyed reconciler owns root ordering');
  assertContains(source, 'chatContainer.insertBefore(root, chatWindowState.bottomSpacer);', 'window append ownership stays before the bottom spacer');
  assertContains(source, 'function renderFromStateLegacy()', 'historical legacy full-render definition remains available for diagnostics');
  assertContains(source, "INIT_NO_MODELS_STRUCTURAL_KEY = 'surface:error:no-model'", 'init no-model writer has stable structural ownership');
  assertContains(source, "CHAT_STRUCTURAL_SURFACE_LIMIT = 6", 'structural root count remains bounded');
  assertContains(source, 'acknowledgeKeyedStreamPatch(session, targetId)', 'successful stream path synchronizes guarded keyed presentation identity');
  assertContains(source, 'scrollToBottom(true);', 'existing pinned scroll operation remains');

  const recoveredAnonymousOwnerGuards = [
      {
        label: 'primary-send anonymous click ownership/no delegation',
        accepted: !recoveredSource.includes('function handlePrimarySendClick() {')
          && count(recoveredSource, 'handlePrimarySendClick();') === 0
          && count(recoveredSource, "sendBtn.addEventListener('click', () => {\n        if (appendInputMode) {") === 1
      },
      {
        label: 'chat-scroll passive anonymous ownership/no delegation',
        accepted: !recoveredSource.includes('function handleChatContainerScroll() {')
          && count(recoveredSource, 'handleChatContainerScroll();') === 0
          && count(recoveredSource, "chatContainer.addEventListener('scroll', () => {\n            if (!chatWindowState.programmaticScroll) {") === 1
          && count(recoveredSource, '}, { passive: true });') >= 1
      },
      {
        label: 'sessionId inline case ownership/no delegation',
        accepted: !recoveredSource.includes('function handleSessionIdMessage(message) {')
          && count(recoveredSource, 'handleSessionIdMessage(message);') === 0
          && count(recoveredSource, "case 'sessionId': {\n                const route = resolveEventSessionId(message, 'sessionId');") === 1
      },
      {
        label: 'alias assigned-lambda ownership/no delegation',
        accepted: !recoveredSource.includes('function applyKeyedChatPresentationAliasMigration(oldKey, newKey, sessionId) {')
          && count(recoveredSource, 'applyKeyedChatPresentationAliasMigration(oldKey, newKey, sessionId);') === 0
          && count(recoveredSource, 'rekeyKeyedChatPresentation = (oldKey, newKey, sessionId) => {\n        if (!KEYED_CHAT_RECONCILE_ENABLED') === 1
      }
    ];
  const failedRecoveredAnonymousOwnerGuards = recoveredAnonymousOwnerGuards.filter((guard) => !guard.accepted);
  assert(failedRecoveredAnonymousOwnerGuards.length === 0,
    `B4S recovered oracle guards (${failedRecoveredAnonymousOwnerGuards.length}/4): ${failedRecoveredAnonymousOwnerGuards.map((guard) => guard.label).join('; ')}`);
  assertFunctionHash(recoveredSource, "sendBtn.addEventListener('click', () =>", '018472c1273dbff9a4840ce20070125a5b0d7eb906910d8aadefa82a659edf9c');
  assertFunctionHash(recoveredSource, "chatContainer.addEventListener('scroll', () =>", '59a0fc74715e1dd12af71ff36fc24a411967b9b08f7dc62620fa008353d7e163');
  assertFunctionHash(recoveredSource, "case 'sessionId':", '351876861f7dfcd8e32bee1a1412b224ad057d3ef1488383af93362d24c29e31');
  assertFunctionHash(recoveredSource, 'rekeyKeyedChatPresentation = (oldKey, newKey, sessionId) =>', '091cfc9cdfd26c13527c4aeaef6b6e0aa60205d29592479aee99c0f641fcc9c3');
  assertFunctionHash(source, 'function handlePrimarySendClick()', 'a0bb89397aa6485dd33161caf3ff4ca6de14b3a616f03b6259683fb4143c05c7');
  assertFunctionHash(source, 'function handleChatContainerScroll()', '1f0f8b57e4dd9c38d549b10ae98ed9341f0c8b2cae99ee2077914eecf0bbda4f');
  const sessionHandler = extractFunction(source, 'function handleSessionIdMessage(');
  const sessionOwnerTransition = extractFunction(source, 'function transitionActiveSessionPresentationOwner(');
  assert(sessionOwnerTransition.includes("destroyChatWindowAdapter('session-switch')"),
    'session presentation owner transition owns the singular teardown');
  assert(sessionHandler.includes('transitionActiveSessionPresentationOwner(prevSessionId, sessionId);'),
    'sessionId activation crosses the presentation owner boundary');
  assert(count(source, 'transitionActiveSessionPresentationOwner(activeSessionId, incomingSessionId') === 2,
    'init and reset activation cross the presentation owner boundary');
  assert(count(source, 'transitionActiveSessionPresentationOwner(activeSessionId, sessionId);') === 1,
    'activating sessionData repairs presentation ownership before hydration');
  assertFunctionHash(source, 'function applyKeyedChatPresentationAliasMigration(', '88cf3b9f39f17f1c4df3caa8c37b11a1d956ee7e01ac2e962fff2e62f51e3d86');
  assert(count(source, 'handlePrimarySendClick();') === 1, 'B4S primary-send delegation occurs exactly once');
  assert(count(source, 'handleChatContainerScroll();') === 1, 'B4S chat-scroll delegation occurs exactly once');
  assert(count(source, 'handleSessionIdMessage(message);') === 1, 'B4S sessionId delegation occurs exactly once');
  assert(count(source, 'applyKeyedChatPresentationAliasMigration(oldKey, newKey, sessionId);') === 1,
    'B4S alias delegation occurs exactly once');

  console.log('Chat render baseline contract: PASS (schema, immutable policy, privacy, planner, transaction, recovery, bounds)');
  console.log(`Frozen functions/descendant thresholds: ${a15.frozenFunctionHashes}/${a15.namedDescendantThresholds}`);
  console.log(`Fallback call sites: ${JSON.stringify(a15.fallbackCallSites)}`);
  console.log('Evidence environment: node-synthetic; syntheticNotBrowserTiming=true');
}

run();
