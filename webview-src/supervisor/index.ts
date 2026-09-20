import { mountSupervisorPanel } from './panel';
mountSupervisorPanel(document, handler => window.addEventListener('message', event => handler(event.data)));
