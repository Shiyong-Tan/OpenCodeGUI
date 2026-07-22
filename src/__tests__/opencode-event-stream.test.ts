import { OpenCodeEventStream, SseDataLineBuffer } from '../transport/OpenCodeEventStream';

describe('OpenCode event stream transport', () => {
    test('extracts only complete, non-empty data lines across chunks', () => {
        const buffer = new SseDataLineBuffer();
        expect(buffer.push('event: update\ndata: {"a":1}\ndata: par')).toEqual(['{"a":1}']);
        expect(buffer.push('tial\n:\n\ndata:   {"b":2}  \n')).toEqual(['partial', '{"b":2}']);
    });

    test('opens once while active and routes payloads in stream order', async () => {
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
        const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
        const open = jest.fn(async () => new Response(body, { status: 200 }));
        const payloads: string[] = [];
        const onOpen = jest.fn();
        const onClosed = jest.fn();
        const stream = new OpenCodeEventStream({
            open,
            onPayload: (payload) => payloads.push(payload),
            onOpen,
            onClosed,
            onError: () => undefined,
            onRepeatedFailure: () => undefined,
        });
        stream.connect();
        stream.connect();
        await Promise.resolve();
        controller!.enqueue(new TextEncoder().encode('data: first\ndata: second\n'));
        controller!.close();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(open).toHaveBeenCalledTimes(1);
        expect(onOpen).toHaveBeenCalledTimes(1);
        expect(payloads).toEqual(['first', 'second']);
        expect(onClosed).toHaveBeenCalledTimes(1);
        stream.stop();
    });
});
