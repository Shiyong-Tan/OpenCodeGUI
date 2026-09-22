import { startSupervisorRoundPresentation, updateSupervisorRoundPresentation, resumeSupervisorRoundPresentation } from './round-presentation';
import { mountSupervisorPanel } from './panel';
mountSupervisorPanel(document, handler => window.addEventListener('message', event => handler(event.data)));

Object.assign(window, { __ocSupervisorRounds: { start: startSupervisorRoundPresentation, update: updateSupervisorRoundPresentation, resume: resumeSupervisorRoundPresentation } });
