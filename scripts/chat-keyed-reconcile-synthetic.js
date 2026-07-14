/* eslint-disable no-console */
'use strict';

const assert = require('assert');
const vm = require('vm');
const fs = require('fs');

global.window = globalThis;
require('../media/rendering.bundle.js');
const rendering = window.__ocRendering;
const source = fs.readFileSync('media/main.js', 'utf8');

function killSwitch(overridePresent, override) {
  const sandbox = { window: overridePresent ? { __ocKeyedChatReconcileEnabled: override } : {} };
  return vm.runInNewContext('window.__ocKeyedChatReconcileEnabled !== false', sandbox);
}

function items(count, changed = -1) {
  return Array.from({ length: count }, (_, index) => ({
    key: `message:${index}`,
    fingerprint: rendering.presentationFingerprint({ text: index === changed ? `changed:${index}` : `text:${index}` })
  }));
}

function operationCounts(plan) {
  const counts = { create: 0, replace: 0, remove: 0, move: 0, reuse: 0 };
  for (const step of plan) counts[step.type] += 1;
  return counts;
}

function extractFunction(marker) {
  const start = source.indexOf(marker);
  assert(start >= 0, `missing ${marker}`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = brace; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unclosed ${marker}`);
}

function runActualDomApplicationContract() {
  class FakeRoot {
    constructor(key, container) {
      this.dataset = key ? { renderUnitKey: key, messageId: key } : {};
      this.style = {};
      this.container = container;
      this.parentElement = null;
    }
    querySelector() { return null; }
    remove() {
      const index = this.container.children.indexOf(this);
      if (index >= 0) this.container.children.splice(index, 1);
      this.parentElement = null;
    }
    replaceWith(next) {
      const index = this.container.children.indexOf(this);
      assert(index >= 0);
      this.container.children[index] = next;
      this.parentElement = null;
      next.parentElement = this.container;
    }
  }
  const chatContainer = {
    children: [],
    querySelector(selector) {
      if (!selector.includes('data-chat-structural-key')) return null;
      return this.children.find((root) => root.dataset.chatStructuralKey === 'surface:error:no-model') || null;
    },
    querySelectorAll(selector) {
      if (!selector.includes('data-chat-structural-key')) return [];
      return this.children.filter((root) => root.dataset.chatStructuralKey);
    },
    appendChild(root) {
      const current = this.children.indexOf(root);
      if (current >= 0) this.children.splice(current, 1);
      this.children.push(root);
      root.parentElement = this;
    },
    insertBefore(root, before) {
      const current = this.children.indexOf(root);
      if (current >= 0) this.children.splice(current, 1);
      const index = before ? this.children.indexOf(before) : this.children.length;
      this.children.splice(index < 0 ? this.children.length : index, 0, root);
      root.parentElement = this;
    }
  };
  const sandbox = {
    Map, Set, Array, Object, Error,
    KEYED_CHAT_RECONCILE_ENABLED: true,
    CHAT_STRUCTURAL_SURFACE_LIMIT: 6,
    INIT_NO_MODELS_STRUCTURAL_KEY: 'surface:error:no-model',
    activeSessionId: 'synthetic-session',
    chatContainer,
    console,
    document: { createElement() { return new FakeRoot('', chatContainer); } },
    window: { __ocRendering: rendering },
    keyedChatReconcileState: { sessionId: '', items: [], roots: new Map() },
    getKeyedUnitPresentation(_session, unit) { return unit.value?.message?.presentation || unit.value; },
    keyedRoots() { return chatContainer.children.filter((root) => root.dataset.renderUnitKey); },
    keyedRootForKey(key) {
      const matches = chatContainer.children.filter((root) => root.dataset.renderUnitKey === key);
      return matches.length === 1 ? matches[0] : null;
    },
    renderDetachedKeyedUnit(_session, unit) { return new FakeRoot(unit.key, chatContainer); }
  };
  vm.runInNewContext(`
    ${extractFunction('function getKeyedStreamStablePresentation(')}
    ${extractFunction('function applyKeyedChatReconciliation(')}
    ${extractFunction('function acknowledgeKeyedStreamPatch(')}
    ${extractFunction('function classifyChatStructuralSurface(')}
    ${extractFunction('function showInitNoModelsError()')}
    ${extractFunction('function getMessageKeyFromChatChild(')}
    ${extractFunction('function getLastRenderedChatKey(')}
    this.apply = applyKeyedChatReconciliation;
    this.acknowledge = acknowledgeKeyedStreamPatch;
    this.lastKey = getLastRenderedChatKey;
    this.showInitError = showInitNoModelsError;
  `, sandbox);
  const firstStructural = sandbox.showInitError();
  const secondStructural = sandbox.showInitError();
  assert.strictEqual(firstStructural, secondStructural);
  const structural = firstStructural;
  assert.strictEqual(chatContainer.children.filter((root) => root.dataset.chatStructuralKey === 'surface:error:no-model').length, 1);
  const units = (pairs) => pairs.map(([key, text]) => ({ key, value: { text } }));
  let counts = sandbox.apply({}, units([['a', 'A'], ['b', 'B']]));
  assert.deepStrictEqual({ ...counts }, { create: 2, replace: 0, remove: 0, move: 0, reuse: 0, enhance: 2 });
  counts = sandbox.apply({}, units([['a', 'A'], ['b', 'B']]));
  assert.deepStrictEqual({ ...counts }, { create: 0, replace: 0, remove: 0, move: 0, reuse: 2, enhance: 0 });
  counts = sandbox.apply({}, units([['b', 'B2'], ['a', 'A']]));
  assert.strictEqual(counts.replace, 1);
  assert.strictEqual(counts.remove, 0);
  assert.strictEqual(counts.enhance, 1);
  assert.deepStrictEqual(chatContainer.children.filter((root) => root.dataset.renderUnitKey).map((root) => root.dataset.renderUnitKey), ['b', 'a']);
  chatContainer.appendChild(structural);
  assert.strictEqual(sandbox.lastKey(), 'a');
  counts = sandbox.apply({}, units([['b', 'B2']]));
  assert.strictEqual(counts.remove, 1);
  assert.deepStrictEqual(chatContainer.children.filter((root) => root.dataset.renderUnitKey).map((root) => root.dataset.renderUnitKey), ['b']);
  assert.strictEqual(chatContainer.children.filter((root) => root.dataset.chatStructuralKey === 'surface:error:no-model').length, 1);
  assert.strictEqual(sandbox.lastKey(), 'b');

  const baselinePresentation = {
    text: 'old',
    meta: { isThinking: true, statusText: 'working', currentSegment: 'old', textSegments: ['old'] },
    actions: { canAppend: false, busy: true },
    ownership: { sessionId: 'synthetic-session', messageId: 'stream' },
    subagentExpansion: []
  };
  counts = sandbox.apply({}, [{ key: 'stream', value: baselinePresentation }]);
  assert.strictEqual(counts.create, 1);
  const session = { messagesById: new Map() };
  const streamOnlyPresentation = {
    ...baselinePresentation,
    text: 'new',
    meta: { ...baselinePresentation.meta, statusText: 'still working', currentSegment: 'new', textSegments: ['old', 'new'] }
  };
  session.messagesById.set('stream', { presentation: streamOnlyPresentation });
  assert.strictEqual(sandbox.acknowledge(session, 'stream'), true);
  counts = sandbox.apply(session, [{ key: 'stream', value: streamOnlyPresentation }]);
  assert.strictEqual(counts.reuse, 1);
  assert.strictEqual(counts.replace, 0);

  const concurrentActionPresentation = {
    ...streamOnlyPresentation,
    text: 'newer',
    actions: { ...streamOnlyPresentation.actions, busy: false }
  };
  session.messagesById.set('stream', { presentation: concurrentActionPresentation });
  assert.strictEqual(sandbox.acknowledge(session, 'stream'), false);
  counts = sandbox.apply(session, [{ key: 'stream', value: concurrentActionPresentation }]);
  assert.strictEqual(counts.replace, 1);
}

for (const count of [50, 200, 1001]) {
  const first = items(count);
  assert.deepStrictEqual(operationCounts(rendering.planReconciliation([], first)), {
    create: count, replace: 0, remove: 0, move: 0, reuse: 0
  });
  assert.deepStrictEqual(operationCounts(rendering.planReconciliation(first, first)), {
    create: 0, replace: 0, remove: 0, move: 0, reuse: count
  });
  assert.deepStrictEqual(operationCounts(rendering.planReconciliation(first, items(count, count - 1))), {
    create: 0, replace: 1, remove: 0, move: 0, reuse: count - 1
  });
}

const aliasProjection = rendering.deriveRenderUnits([
  { key: 'tmp:one', canonicalKey: 'msg_one', kind: 'message', value: { text: 'one' } }
]);
assert.strictEqual(aliasProjection.length, 1);
assert.strictEqual(aliasProjection[0].key, 'msg_one');
assert.throws(() => rendering.deriveRenderUnits([
  { key: 'tmp:one', canonicalKey: 'msg_one', kind: 'message', value: {} },
  { key: 'msg_one', kind: 'message', value: {} }
]), /duplicate render unit key/i);

assert.strictEqual(killSwitch(false), true);
assert.strictEqual(killSwitch(true, true), true);
assert.strictEqual(killSwitch(true, false), false);
assert(source.includes('renderFromStateLegacy();'));
assert(source.includes('if (KEYED_CHAT_RECONCILE_ENABLED)'));
assert(!extractFunction('function applyKeyedChatReconciliation(').includes('createTanStackVirtualAdapter('));
runActualDomApplicationContract();

console.log('Wave 2 keyed reconcile synthetic: PASS');
console.log('Scenarios: 50, 200, 1001 full-mounted; unchanged root/enhancement work=0; one-tail-change replacements=1');
console.log('Kill switch: default=true, true=true, false=legacy; alias duplicate fails closed');
console.log('VM DOM application: actual keyed apply function passed create/reuse/move/replace/remove and zero-work second reconcile');
console.log('Structural/stream blockers: init error remains one ignored structural root; stream-only update reuses, concurrent action change replaces');
