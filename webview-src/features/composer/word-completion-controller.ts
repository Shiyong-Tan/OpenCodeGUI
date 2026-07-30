export type CompletionSource = 'common' | 'workspace' | 'session';

type CompletionEntry = {
  display: string;
  common: number;
  workspace: number;
  sessions: Map<string, number>;
};

const COMMON_WORDS = `
about above accept access action active add after again against agent allow already also always
another answer any apply approach argument around available avoid back because become before begin
between both build call cancel change check choose class clear close code command complete completion
component configuration context continue controller correct create current data debug default define
delete description different directory display document during each editor effect enable end ensure
error event example existing expected explain export extension failure feature file final find first
fix folder follow function general generate get give good handle help history how however identify
implementation improve include index input instead issue item keep language last latest learn line
list load local logic long make message method model more most move name need never new next normal
only open operation option output package path performance please position preserve previous process
project prompt provide question quick read reason recent record reduce refresh related reload remove
render replace request require reset resolve response result restore return review right risk run
save search select send separate session setting should show simple snapshot source start state status
still stop store stream string structure suggest support switch system test text than that their then
there these they this through time tool track turn type undo update use user value version view visible
wait want when where which while window with without word work workspace write
assistant automatic autocomplete background behavior bubble candidate chat click content draft English
finalize hydration identifier incremental initialize interaction keyboard lexicon mention metadata
module prefix ranking recommendation reference reliable replacement selection subagent suggestion
temporary timeline virtualization virtualized
`.trim().split(/\s+/);

const MAX_WORKSPACE_WORDS = 8_000;
const MAX_SESSION_WORDS = 2_000;
const MAX_SESSION_MESSAGES_PER_REFRESH = 400;
const MAX_LEARNED_TEXT_LENGTH = 240_000;

function normalizeWord(word: string): string {
  return word.toLocaleLowerCase();
}

function splitIdentifier(value: string): string[] {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ');
  return normalized.split(/\s+/).filter(Boolean);
}

export function extractCompletionWords(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/[A-Za-z][A-Za-z0-9_-]{2,63}/g) || [];
  const words = new Set<string>();
  for (const raw of matches) {
    if (/^(?:https?|file|data)$/i.test(raw)) continue;
    if (/\d{6,}/.test(raw) || /^[a-f0-9]{20,}$/i.test(raw)) continue;
    for (const candidate of [raw, ...splitIdentifier(raw)]) {
      if (candidate.length < 3 || candidate.length > 48) continue;
      if (!/[A-Za-z]/.test(candidate)) continue;
      words.add(candidate);
    }
  }
  return [...words];
}

export function findCompletionPrefix(
  value: string,
  selectionStart: number,
  selectionEnd: number,
): { prefix: string; start: number; end: number } | null {
  if (selectionStart !== selectionEnd || selectionEnd !== value.length) return null;
  const match = value.slice(0, selectionStart).match(/[A-Za-z][A-Za-z0-9_-]{2,47}$/);
  if (!match) return null;
  const prefix = match[0];
  const start = selectionStart - prefix.length;
  const preceding = start > 0 ? value[start - 1] : '';
  if (preceding && /[A-Za-z0-9_@./\\:$-]/.test(preceding)) return null;
  return { prefix, start, end: selectionEnd };
}

export function createWordCompletionController(options: {
  input: HTMLTextAreaElement;
  ghost: HTMLElement;
  ghostPrefix: HTMLElement;
  ghostSuffix: HTMLElement;
  window: Window;
  getSessionId(): string;
  onAccepted?(value: string): void;
  delayMs?: number;
  enabled?: boolean;
}) {
  const entries = new Map<string, CompletionEntry>();
  const prefixBuckets = new Map<string, Set<string>>();
  const learnedMessageIdsBySession = new Map<string, Set<string>>();
  const sessionWordKeys = new Map<string, Set<string>>();
  let workspaceWordKeys = new Set<string>();
  let suggestion: { prefix: string; completion: string; suffix: string } | null = null;
  let timer: number | null = null;
  let composing = false;
  let enabled = options.enabled !== false;

  const bucketKey = (word: string) => word.slice(0, Math.min(3, word.length));
  const addToBucket = (key: string) => {
    const bucket = bucketKey(key);
    if (!prefixBuckets.has(bucket)) prefixBuckets.set(bucket, new Set());
    prefixBuckets.get(bucket)?.add(key);
  };
  const addWord = (word: string, source: CompletionSource, sessionId = '', weight = 1) => {
    const clean = word.trim();
    if (clean.length < 3 || clean.length > 48) return;
    const key = normalizeWord(clean);
    let entry = entries.get(key);
    if (!entry) {
      entry = { display: clean, common: 0, workspace: 0, sessions: new Map() };
      entries.set(key, entry);
      addToBucket(key);
    } else if (/[A-Z_]/.test(clean) && !/[A-Z_]/.test(entry.display)) {
      entry.display = clean;
    }
    if (source === 'common') entry.common += weight;
    if (source === 'workspace') entry.workspace += weight;
    if (source === 'session' && sessionId) {
      entry.sessions.set(sessionId, (entry.sessions.get(sessionId) || 0) + weight);
      if (!sessionWordKeys.has(sessionId)) sessionWordKeys.set(sessionId, new Set());
      sessionWordKeys.get(sessionId)?.add(key);
    }
  };

  for (const word of COMMON_WORDS) addWord(word, 'common');

  const clear = () => {
    suggestion = null;
    options.ghostPrefix.textContent = '';
    options.ghostSuffix.textContent = '';
    options.ghost.classList.add('hidden');
  };

  const score = (entry: CompletionEntry, prefix: string, sessionId: string): number => {
    const sessionCount = entry.sessions.get(sessionId) || 0;
    const exactCasePrefix = entry.display.startsWith(prefix) ? 12 : 0;
    const lengthPenalty = Math.max(0, entry.display.length - prefix.length) * 0.15;
    return sessionCount * 120 + entry.workspace * 12 + entry.common * 8 + exactCasePrefix - lengthPenalty;
  };

  const pick = (prefix: string, sessionId: string): string | null => {
    const normalizedPrefix = normalizeWord(prefix);
    const bucket = prefixBuckets.get(bucketKey(normalizedPrefix));
    if (!bucket) return null;
    let best: CompletionEntry | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const key of bucket) {
      if (key === normalizedPrefix || !key.startsWith(normalizedPrefix)) continue;
      const entry = entries.get(key);
      if (!entry) continue;
      if (entry.common === 0 && entry.workspace === 0 && !entry.sessions.has(sessionId)) continue;
      const candidateScore = score(entry, prefix, sessionId);
      if (candidateScore > bestScore
        || (candidateScore === bestScore && best && entry.display.length < best.display.length)) {
        best = entry;
        bestScore = candidateScore;
      }
    }
    return best?.display || null;
  };

  const syncScroll = () => {
    options.ghost.scrollTop = options.input.scrollTop;
    options.ghost.scrollLeft = options.input.scrollLeft;
  };

  const refresh = () => {
    if (!enabled || composing) {
      clear();
      return;
    }
    const active = findCompletionPrefix(
      options.input.value,
      options.input.selectionStart,
      options.input.selectionEnd,
    );
    if (!active) {
      clear();
      return;
    }
    const completion = pick(active.prefix, options.getSessionId());
    if (!completion || normalizeWord(completion) === normalizeWord(active.prefix)) {
      clear();
      return;
    }
    const suffix = completion.slice(active.prefix.length);
    if (!suffix) {
      clear();
      return;
    }
    suggestion = { prefix: active.prefix, completion, suffix };
    options.ghostPrefix.textContent = options.input.value;
    options.ghostSuffix.textContent = suffix;
    options.ghost.classList.remove('hidden');
    syncScroll();
  };

  const schedule = () => {
    if (!enabled) {
      clear();
      return;
    }
    if (timer !== null) options.window.clearTimeout(timer);
    timer = options.window.setTimeout(() => {
      timer = null;
      refresh();
    }, options.delayMs ?? 70);
  };

  const accept = (): boolean => {
    if (!suggestion) return false;
    const active = findCompletionPrefix(
      options.input.value,
      options.input.selectionStart,
      options.input.selectionEnd,
    );
    if (!active || active.prefix !== suggestion.prefix) {
      clear();
      return false;
    }
    options.input.value = `${options.input.value}${suggestion.suffix}`;
    options.input.selectionStart = options.input.value.length;
    options.input.selectionEnd = options.input.value.length;
    addWord(suggestion.completion, 'session', options.getSessionId());
    clear();
    options.onAccepted?.(options.input.value);
    return true;
  };

  const handleKeydown = (event: KeyboardEvent): boolean => {
    if (!suggestion) return false;
    if (event.key === 'Tab') {
      event.preventDefault();
      accept();
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      clear();
      return true;
    }
    return false;
  };

  const setWorkspaceWords = (words: unknown[]) => {
    workspaceWordKeys = new Set();
    for (const [index, value] of words.slice(0, MAX_WORKSPACE_WORDS).entries()) {
      if (typeof value !== 'string') continue;
      const rankWeight = Math.max(1, 8 - Math.floor(index / 1_000));
      for (const word of extractCompletionWords(value)) {
        addWord(word, 'workspace', '', rankWeight);
        workspaceWordKeys.add(normalizeWord(word));
      }
    }
    schedule();
  };

  const learnText = (sessionId: string, text: string) => {
    if (!sessionId || !text) return;
    const existing = sessionWordKeys.get(sessionId);
    if (existing && existing.size >= MAX_SESSION_WORDS) return;
    for (const word of extractCompletionWords(text.slice(0, MAX_LEARNED_TEXT_LENGTH))) {
      addWord(word, 'session', sessionId);
      if ((sessionWordKeys.get(sessionId)?.size || 0) >= MAX_SESSION_WORDS) break;
    }
  };

  const learnSessionMessages = (
    sessionId: string,
    messages: Array<{ id?: unknown; text?: unknown }>,
  ) => {
    if (!sessionId || !Array.isArray(messages)) return;
    if (!learnedMessageIdsBySession.has(sessionId)) {
      learnedMessageIdsBySession.set(sessionId, new Set());
    }
    const seen = learnedMessageIdsBySession.get(sessionId)!;
    for (const message of messages.slice(-MAX_SESSION_MESSAGES_PER_REFRESH)) {
      const id = typeof message?.id === 'string' ? message.id : '';
      const text = typeof message?.text === 'string' ? message.text : '';
      if (!id || !text || seen.has(id)) continue;
      seen.add(id);
      learnText(sessionId, text);
    }
    schedule();
  };

  const onCompositionStart = () => {
    composing = true;
    clear();
  };
  const onCompositionEnd = () => {
    composing = false;
    schedule();
  };
  const setEnabled = (next: boolean) => {
    enabled = next;
    if (!enabled) clear();
    else schedule();
  };

  return Object.freeze({
    clear,
    schedule,
    refresh,
    accept,
    handleKeydown,
    setWorkspaceWords,
    learnText,
    learnSessionMessages,
    onCompositionStart,
    onCompositionEnd,
    setEnabled,
    syncScroll,
    getSuggestion: () => suggestion ? { ...suggestion } : null,
    getStats: () => ({
      entries: entries.size,
      workspaceWords: workspaceWordKeys.size,
      sessionWords: sessionWordKeys.get(options.getSessionId())?.size || 0,
    }),
  });
}
