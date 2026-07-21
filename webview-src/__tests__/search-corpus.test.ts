import { collectLoadedTextSearchKeys, collectSmartSearchMessages, visitLoadedChatSearchChunks } from '../features/search/search-corpus';

describe('search corpus projection', () => {
  it('indexes only safe visible message and subagent presentation fields', () => {
    const chunks: string[] = [];
    visitLoadedChatSearchChunks(null, { kind: 'message', value: { message: {
      text: 'answer',
      meta: { subagents: [{ title: 'Inspect (@secret)', mode: 'explore', latestText: 'result', payload: 'DO-NOT-INDEX' }] },
    } } }, (value) => { chunks.push(value); });
    const corpus = chunks.join('').replace(/\s+/g, ' ');
    expect(corpus).toContain('Inspect explore result');
    expect(corpus).not.toContain('secret');
    expect(corpus).not.toContain('DO-NOT-INDEX');
  });

  it('uses canonical projected rows and excludes hidden fallback messages', () => {
    const session = {
      timeline: ['visible', 'hidden'],
      messagesById: new Map([
        ['visible', { text: 'history reload', role: 'user' }],
        ['hidden', { text: 'history reload hidden', role: 'assistant' }],
      ]),
      hiddenSet: new Set(['hidden']),
    };
    expect(collectLoadedTextSearchKeys({ query: 'reload', session })).toEqual(['visible']);
    expect(collectLoadedTextSearchKeys({ query: 'anything', session, projectedRows: [{ id: 'projected' }] })).toEqual(['projected']);
    expect(collectSmartSearchMessages({ session })).toEqual([{ id: 'visible', role: 'user', text: 'history reload' }]);
  });

  it('includes append items through an explicit dependency', () => {
    const session = {
      timeline: ['root'],
      messagesById: new Map([['root', { text: 'root', role: 'user' }]]),
      hiddenSet: new Set<string>(),
    };
    expect(collectLoadedTextSearchKeys({
      query: 'append-only',
      session,
      getAppendItems: () => [{ text: 'append-only text', role: 'user' }],
    })).toEqual(['root']);
  });
});
