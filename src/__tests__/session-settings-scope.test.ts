import { resolveSessionSettingsScope } from '../session-runtime/session-settings-scope';

describe('resolveSessionSettingsScope', () => {
    test('empty session id is a global (new-session draft) slot, never the visible session', () => {
        expect(resolveSessionSettingsScope('', 'session-a')).toEqual({ kind: 'global' });
        expect(resolveSessionSettingsScope('', undefined)).toEqual({ kind: 'global' });
        expect(resolveSessionSettingsScope(undefined, 'session-a')).toEqual({ kind: 'global' });
    });

    test('a real session id targets that session only and reports whether it is current', () => {
        expect(resolveSessionSettingsScope('session-a', 'session-a')).toEqual({
            kind: 'session',
            sessionId: 'session-a',
            isCurrent: true,
        });
        expect(resolveSessionSettingsScope('session-b', 'session-a')).toEqual({
            kind: 'session',
            sessionId: 'session-b',
            isCurrent: false,
        });
    });

    test('background sessions never fall back to the visible session', () => {
        const scope = resolveSessionSettingsScope('session-b', 'session-a');
        expect(scope.kind).toBe('session');
        if (scope.kind === 'session') {
            expect(scope.sessionId).toBe('session-b');
            expect(scope.isCurrent).toBe(false);
        }
    });
});