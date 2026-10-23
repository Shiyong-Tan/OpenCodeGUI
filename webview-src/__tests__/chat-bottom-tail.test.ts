import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const source = fs.readFileSync(path.join(process.cwd(), 'media/main.js'), 'utf8');
function extract(name: string): string {
    const start = source.indexOf(`function ${name}(`);
    const brace = source.indexOf('{', start);
    let depth = 0;
    for (let i = brace; i < source.length; i++) {
        if (source[i] === '{') depth++;
        if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    throw Error('Missing scroll function');
}
function harness(keys: string[], pinned = true) {
    const calls: string[] = [], frames: Array<() => void> = [];
    const state = { sessionId: 'ses_A', allUnits: keys.map(key => ({ key })),
        adapter: { scrollToKey: (key: string) => { calls.push(key); return true; } },
        fineAnchorRestoreToken: 0, imageAnchorRestoreToken: 0 };
    const context = vm.createContext({ activeSessionId: 'ses_A', chatWindowState: state,
        autoScrollPinnedToBottom: pinned, scrollToBottomGeneration: 0,
        chatContainer: { scrollTop: 0, scrollHeight: 9000 },
        getSessionState: () => ({ currentTurnAssistantKey: 'assistant', currentTurnAssistantMsgId: 'assistant', thinkingId: 'assistant' }),
        requestAnimationFrame: (callback: () => void) => frames.push(callback), updateChatJumpBottomButton: () => undefined });
    vm.runInContext(`${extract('scrollVirtualizedChatToBottom')}
${extract('scrollToBottom')}
globalThis.scroll = scrollToBottom;`, context);
    return { context, state, calls, flush: () => { while (frames.length) frames.shift()!(); }, scroll: (force = false) => (context as any).scroll(force) };
}

test('repeated final/list measurements align the actual trailing changelist, not its assistant anchor', () => {
    const h = harness(['history', 'assistant', 'change-list']);
    for (let i = 0; i < 3; i++) { h.scroll(); h.flush(); }
    expect(h.calls).toEqual(Array(6).fill('change-list'));
});

test('a late changelist becomes the bottom target after final', () => {
    const h = harness(['history', 'assistant']);
    h.scroll(); h.flush(); expect(h.calls).toEqual(['assistant', 'assistant']);
    h.state.allUnits.push({ key: 'change-list' });
    h.scroll(); h.flush(); expect(h.calls.slice(2)).toEqual(['change-list', 'change-list']);
});

test('reading above the tail prevents ordinary follow; explicit bottom navigation reaches the list', () => {
    const h = harness(['assistant', 'change-list'], false);
    h.scroll(); h.flush(); expect(h.calls).toEqual([]);
    h.scroll(true); h.flush(); expect(h.calls).toEqual(['change-list', 'change-list']);
});

test('a different session cannot use the old virtual list to scroll', () => {
    const h = harness(['assistant', 'change-list']); h.state.sessionId = 'ses_B';
    h.scroll(); h.flush(); expect(h.calls).toEqual([]);
});
