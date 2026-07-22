import { ChangeListEmitter } from '../changes/ChangeListEmitter';

describe('ChangeListEmitter facade', () => {
    test('forwards the exact identity and target to the legacy implementation', async () => {
        const legacy = jest.fn().mockResolvedValue(undefined);
        const emitter = new ChangeListEmitter(legacy);
        const identity = { sessionId: 'session-a', assistantMessageId: 'msg_assistant' };
        const target = { postMessage: jest.fn() };
        await emitter.emit(identity, target);
        expect(legacy).toHaveBeenCalledTimes(1);
        expect(legacy).toHaveBeenCalledWith(identity, target);
    });
});
