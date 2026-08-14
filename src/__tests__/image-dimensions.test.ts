import { parseImageDimensions } from '../images/ImageDimensions';

describe('image dimension parsing', () => {
    test('reads PNG dimensions without decoding the image', () => {
        const buffer = Buffer.alloc(24);
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer);
        buffer.writeUInt32BE(1600, 16);
        buffer.writeUInt32BE(900, 20);
        expect(parseImageDimensions(buffer, '.png')).toEqual({ width: 1600, height: 900 });
    });

    test('uses an SVG viewBox when explicit dimensions are absent', () => {
        const buffer = Buffer.from('<svg viewBox="0 0 1200 800"></svg>');
        expect(parseImageDimensions(buffer, '.svg')).toEqual({ width: 1200, height: 800 });
    });

    test('rejects malformed and empty dimensions', () => {
        expect(parseImageDimensions(Buffer.from('not an image'), '.png')).toBeUndefined();
        expect(parseImageDimensions(Buffer.from('<svg width="0" height="0"></svg>'), '.svg')).toBeUndefined();
    });
});
