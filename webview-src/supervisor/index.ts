import { startSupervisorRoundPresentation, updateSupervisorRoundPresentation, resumeSupervisorRoundPresentation } from './round-presentation';
import { mountSupervisorPanel } from './panel';
// main.js owns the single acquireVsCodeApi() instance in the shared script scope.
declare const vscode: { postMessage(value: unknown): void };
mountSupervisorPanel(document, handler => window.addEventListener('message', event => handler(event.data)), value => vscode.postMessage(value));

Object.assign(window, { __ocSupervisorRounds: { start: startSupervisorRoundPresentation, update: updateSupervisorRoundPresentation, resume: resumeSupervisorRoundPresentation } });
