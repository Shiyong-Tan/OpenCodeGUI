import * as fs from 'fs';
import * as path from 'path';

const mainSource = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');

describe('virtualized chat outer recovery lifecycle', () => {
    it('owns an initialized emergency state before normal render completion reads it', () => {
        const declaration = mainSource.indexOf('let chatWindowEmergencyState = Object.freeze({');
        const completion = mainSource.indexOf('function completeChatWindowOuterRecovery(owner)');

        expect(declaration).toBeGreaterThanOrEqual(0);
        expect(completion).toBeGreaterThan(declaration);
        expect(mainSource.slice(declaration, completion)).toContain("status: 'idle'");
    });

    it('includes the real exception in outer recovery diagnostics', () => {
        const recorderStart = mainSource.indexOf('function recordChatWindowOuterRecovery(');
        const recorderEnd = mainSource.indexOf('function completeChatWindowOuterRecovery(', recorderStart);
        const recorder = mainSource.slice(recorderStart, recorderEnd);
        const renderCatch = mainSource.slice(
            mainSource.indexOf('function renderFromState()'),
            mainSource.indexOf('function renderFromStateLegacy()'),
        );

        expect(recorder).toContain('error = null');
        expect(recorder).toContain("String(error?.stack || error?.message || error)");
        expect(recorder).toContain('`error=${errorText || \'none\'}`');
        expect(renderCatch).toContain('recordChatWindowOuterRecovery(owner, reason, null, error)');
    });
});
