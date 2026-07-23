import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

export function loadAppendSuccessorProtocolHarness() {
    const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');
    const start = source.indexOf('function replaceKeyEverywhere');
    const end = source.indexOf('function ensureThinkingUnique');
    const transitionStart = source.indexOf('function applyAppendSuccessorProtocolTransition');
    const transitionEnd = source.indexOf("window.addEventListener('message'");
    if (start < 0 || end <= start || transitionStart < 0 || transitionEnd <= transitionStart) throw new Error('media/main.js protocol extraction unavailable');
    const posts: any[] = [];
    const sessions = new Map<string, any>();
    const context: any = {
        Map, Set, Array, Object, console, activeSessionId: 'ses_f8',
        getSessionState: (sessionId: string) => sessions.get(sessionId),
        vscode: { postMessage: (message: any) => posts.push(message) },
        sessionSearch: { rekey: () => undefined },
        subagentTextExpandedByKey: new Map(),
        logTimelineSnapshot: () => undefined,
        syncAppendSnapshotMetadata: () => undefined,
    };
    vm.createContext(context);
    vm.runInContext(`${source.slice(start, end)}\n${source.slice(transitionStart, transitionEnd)}\nthis.replaceKeyEverywhere = replaceKeyEverywhere; this.applyAppendSuccessorProtocolTransition = applyAppendSuccessorProtocolTransition;`, context);
    return { context, sessions, posts };
}
