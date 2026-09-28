import { EventEmitter } from 'events';
import * as https from 'https';
import { defaultRequestJson } from '../models/ModelQuotaService';

jest.mock('https', () => ({ request: jest.fn() }));

describe('quota request deadline', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => { jest.useRealTimers(); jest.clearAllMocks(); });

    function transport() {
        const request = Object.assign(new EventEmitter(), { destroy: jest.fn(), end: jest.fn(), write: jest.fn() });
        let receive!: (response: EventEmitter) => void;
        (https.request as jest.Mock).mockImplementation((_url, _options, callback) => {
            receive = callback;
            return request;
        });
        return { request, receive: (response: EventEmitter) => receive(response) };
    }

    test('bounds even a connection which never produces headers', async () => {
        const t = transport();
        const result = defaultRequestJson('https://example.invalid/quota');
        const rejected = expect(result).rejects.toThrow('timed out');
        jest.advanceTimersByTime(10_000);
        await rejected;
        expect(t.request.destroy).toHaveBeenCalledTimes(1);
    });

    test('successful responses cancel the deadline', async () => {
        const t = transport();
        const result = defaultRequestJson('https://example.invalid/quota');
        const response = Object.assign(new EventEmitter(), { statusCode: 200 });
        t.receive(response);
        response.emit('data', '{}');
        response.emit('end');
        await expect(result).resolves.toEqual({});
        jest.advanceTimersByTime(10_000);
        expect(t.request.destroy).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
    });

    test('partial response errors reject and cancel the deadline', async () => {
        const t = transport();
        const result = defaultRequestJson('https://example.invalid/quota');
        const response = new EventEmitter();
        t.receive(response);
        response.emit('error', new Error('interrupted'));
        await expect(result).rejects.toThrow('interrupted');
        expect(jest.getTimerCount()).toBe(0);
    });
});
