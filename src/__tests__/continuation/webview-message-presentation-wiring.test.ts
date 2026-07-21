import * as fs from 'fs';
import * as path from 'path';

const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');

describe('message presentation controller browser wiring', () => {
    it('owns the controller in the same DOM lifecycle scope as its injected helpers', () => {
        const domReadyStart = source.indexOf("document.addEventListener('DOMContentLoaded', () => {");
        const controllerStart = source.indexOf('function getMessagePresentationController()', domReadyStart);
        const stripAttachmentStart = source.indexOf('function stripAttachmentManifest(', controllerStart);
        const stripSystemStart = source.indexOf('function stripSystemInjections(', controllerStart);
        const appendItemsStart = source.indexOf('function getAppendItems(', controllerStart);

        expect(domReadyStart).toBeGreaterThanOrEqual(0);
        expect(controllerStart).toBeGreaterThan(domReadyStart);
        expect(stripAttachmentStart).toBeGreaterThan(controllerStart);
        expect(stripSystemStart).toBeGreaterThan(controllerStart);
        expect(appendItemsStart).toBeGreaterThan(controllerStart);
        expect(source.slice(0, domReadyStart)).not.toContain('function getMessagePresentationController()');
    });
});
