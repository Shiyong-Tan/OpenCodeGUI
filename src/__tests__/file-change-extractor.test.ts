import * as path from 'path';
import {
    buildChangeSpecs,
    extractDeletedPathsFromCommand,
    extractFilesFromToolPart,
    extractWrittenPathsFromBashCommand,
    mergeChangeSpecs,
    normalizeIncomingFileSnapshots,
} from '../changes/FileChangeExtractor';

describe('file change extractor', () => {
    test('preserves apply_patch create and delete semantics', () => {
        const files = extractFilesFromToolPart({
            tool: 'apply_patch',
            state: { status: 'completed', metadata: { files: [
                { filePath: 'new.ts', type: 'create', diff: 'new diff' },
                { filePath: 'old.ts', type: 'delete', patch: 'old diff' },
            ] } },
        });
        expect(files).toEqual([
            expect.objectContaining({ filePath: 'new.ts', type: 'create', existsBefore: false, existsAfter: true, patch: 'new diff' }),
            expect.objectContaining({ filePath: 'old.ts', type: 'delete', existsBefore: true, existsAfter: false, patch: 'old diff' }),
        ]);
        expect(buildChangeSpecs(files)).toEqual([
            { type: 'create', path: 'new.ts' },
            { type: 'delete', path: 'old.ts' },
        ]);
    });

    test('normalizes alternate path and patch fields', () => {
        expect(normalizeIncomingFileSnapshots([{ path: 'src/a.ts', changes: 'patch', from: 'a', to: 'b' }]))
            .toEqual([expect.objectContaining({ filePath: 'src/a.ts', diff: 'patch', patch: 'patch', before: 'a', after: 'b' })]);
    });

    test('rejects wildcard delete paths while retaining concrete and bracketed paths', () => {
        const root = path.resolve('workspace');
        expect(extractDeletedPathsFromCommand('Remove-Item -Path "tests/*" -Force', root)).toEqual([]);
        expect(extractDeletedPathsFromCommand('Remove-Item -Path "tests/test0.txt" -Force', root))
            .toEqual([path.join(root, 'tests/test0.txt')]);
        expect(extractDeletedPathsFromCommand('Remove-Item -LiteralPath "app/users/[id].tsx" -Force', root))
            .toEqual([path.join(root, 'app/users/[id].tsx')]);
    });

    test('detects explicit script and redirect writes', () => {
        const root = path.resolve('workspace');
        expect(extractWrittenPathsFromBashCommand("Path('a.txt').write_text('x'); open('b.txt', 'w'); echo x > c.txt", root))
            .toEqual([path.join(root, 'a.txt'), path.join(root, 'b.txt'), path.join(root, 'c.txt')]);
    });

    test('flattens multi specs and keeps the latest change for each path', () => {
        expect(mergeChangeSpecs([
            { type: 'update', path: 'a.ts' },
            { type: 'multi', items: [{ type: 'delete', path: 'a.ts' }, { type: 'create', path: 'b.ts' }] },
        ])).toEqual([{ type: 'delete', path: 'a.ts' }, { type: 'create', path: 'b.ts' }]);
    });
});
