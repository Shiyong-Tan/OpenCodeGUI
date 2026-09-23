import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
const {compact, assertPrivateBoundary, PRIVATE_CORE_FIELDS} = require('../../scripts/compact-webview');
const root = process.cwd();
const declaration = fs.readFileSync(path.join(root, 'node_modules/@tanstack/virtual-core/dist/esm/index.d.ts'), 'utf8');
function execute(source: string) {
    const sandbox: any = {window: {}, console, setTimeout, clearTimeout, performance};
    vm.runInNewContext(source, sandbox);
    return sandbox;
}
describe('production bundle compaction preserves public boundaries', () => {
    test('retains observable getters, errors and public property names', () => {
        const source = `var calls=[]; var x={get value(){calls.push('read');return 1;}};x.value;
            try { var z=null; z.value; } catch(e) { calls.push('throw'); }
            window.result={calls,supervisorRound:'round',messageId:'msg_1',getScrollOffset:()=>500,scrollAdjustments:20};`;
        const actual = execute(compact(source, true)).window.result;
        expect(actual.calls).toEqual(['read', 'throw']);
        expect(actual.supervisorRound).toBe('round');expect(actual.messageId).toBe('msg_1');
        expect(actual.getScrollOffset()).toBe(500);expect(actual.scrollAdjustments).toBe(20);
    });
    test('fails closed when an allowlisted field becomes public or reaches a consumer', () => {
        expect(() => assertPrivateBoundary(declaration, [])).not.toThrow();
        expect(() => assertPrivateBoundary(declaration.replace('private scrollState;', 'scrollState: unknown;'), [])).toThrow('no longer private');
        expect(() => assertPrivateBoundary(declaration, [['consumer.ts', 'record["scrollState"]']])).toThrow('escaped');
        expect(PRIVATE_CORE_FIELDS).not.toContain('getScrollOffset');
        expect(PRIVATE_CORE_FIELDS).not.toContain('scrollAdjustments');
    });
    test('preserves installed real virtual-core ranges through the compiled facade', () => {
        const esbuild = require('esbuild');
        const original = esbuild.buildSync({entryPoints: [path.join(root, 'webview-src/rendering/index.ts')],
            bundle: true, format: 'iife', platform: 'browser', target: ['es2020'], minify: true,
            legalComments: 'none', charset: 'utf8', write: false, logLevel: 'silent'}).outputFiles[0].text;
        const compiled = fs.readFileSync(path.join(root, 'media/rendering.bundle.js'), 'utf8');
        const a = execute(original).window.__ocRendering, b = execute(compiled).window.__ocRendering;
        expect(Object.getOwnPropertyNames(b)).toEqual(Object.getOwnPropertyNames(a));
        for (const key of Object.getOwnPropertyNames(a)) {
            const x=Object.getOwnPropertyDescriptor(a,key)!, y=Object.getOwnPropertyDescriptor(b,key)!;
            expect([y.enumerable,y.configurable,y.writable]).toEqual([x.enumerable,x.configurable,x.writable]);
        }
        for (const offset of [0, 200, 1500]) {
            const options = {count: 100, getScrollElement: () => null, estimateSize: () => 20,
                initialRect: {width: 500, height: 300}, initialOffset: offset, overscan: 2,
                scrollToFn: () => undefined, observeElementRect: () => () => undefined,
                observeElementOffset: () => () => undefined};
            const before=a.createTanStackVirtualAdapter(options), after=b.createTanStackVirtualAdapter(options);
            const actual=after.getRange();
            expect(actual).toEqual(before.getRange());
            expect(actual.totalSize).toBe(2000);expect(actual.items.length).toBeGreaterThan(0);
            expect(actual.items.map((item: any)=>item.index)).toContain(Math.floor(offset/20));
            before.destroy();after.destroy();
        }
    });
});
