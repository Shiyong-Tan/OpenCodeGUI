import { StartupRedactor } from '../transport/StartupRedactor';

describe('startup output redaction', () => {
    test('records complete diagnostic lines without waiting for service exit', () => {
        expect(new StartupRedactor([]).push('plugin failed\n')).toBe('plugin failed\n');
    });
    test('hides a credential split across output chunks', () => {
        const redact = new StartupRedactor(['private-credential']);
        const output = redact.push('password=private-') + redact.push('credential\n') + redact.flush();
        expect(output).toBe('password=******************\n');
    });
    test('hides credentials and bearer values in final output', () => {
        const redact = new StartupRedactor(['fixture-secret']);
        expect(redact.push('fixture-secret Bearer token.value\n') + redact.flush()).not.toMatch(/fixture-secret|token.value/);
    });
});
