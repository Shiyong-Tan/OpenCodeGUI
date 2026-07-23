import * as fs from 'fs';
import * as path from 'path';
import * as childProcess from 'child_process';
import * as vm from 'vm';

export function inspectAppendSuccessorDispatcherScope() {
    const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');
    const domStart = source.indexOf("document.addEventListener('DOMContentLoaded', () => {");
    const dispatcherStart = source.indexOf("window.addEventListener('message', (event) => {");
    const turnCase = source.indexOf("case 'turnInFlight':", dispatcherStart);
    const metaCase = source.indexOf("case 'assistantMessageMeta':", dispatcherStart);
    const domEnd = source.lastIndexOf('});');
    return { source, domStart, dispatcherStart, turnCase, metaCase, domEnd };
}

export function reconstructDefectiveHelperRed() {
    const source = childProcess.execFileSync('git', ['show', '8576f1c:media/main.js'], { encoding: 'utf8' });
    const start = source.indexOf('function applyAppendSuccessorProtocolTransition');
    const end = source.indexOf('function ensureThinkingUnique', start);
    const helper = source.slice(start, end);
    const run = (message: any) => {
        const context: any = {
            getEventSessionId: () => 'ses_f8', getSessionState: () => ({}), resolveContentEventRoute: () => ({ sessionId: 'ses_f8', shouldRender: false }), retainAgentLaneParentAssociation: () => undefined, updateSendGate: () => undefined, vscode: { postMessage: () => undefined }, activeSessionId: 'ses_f8',
        };
        vm.createContext(context); vm.runInContext(helper, context);
        try { context.applyAppendSuccessorProtocolTransition(message); return null; } catch (error: any) { return error.message; }
    };
    return { start, end, domStart: source.indexOf("document.addEventListener('DOMContentLoaded', () => {"), dispatcherStart: source.indexOf("window.addEventListener('message', (event) => {"), assistantMessageMetaError: run({ type: 'assistantMessageMeta', sessionId: 'ses_f8' }), turnInFlightError: run({ type: 'turnInFlight', sessionId: 'ses_f8', inFlight: false }) };
}
