import { AttachmentStorageService } from '../attachments/AttachmentStorageService';

describe('AttachmentStorageService', () => {
  const service = new AttachmentStorageService({
    globalStoragePath: 'C:/storage',
    getWorkspaceRootPath: () => 'C:/workspace',
    log: jest.fn(),
  });

  it('preserves image and general MIME inference', () => {
    expect(service.isImageFileName('IMAGE-test')).toBe(true);
    expect(service.isImageFileName('photo.TIFF')).toBe(true);
    expect(service.isImageFileName('notes.txt')).toBe(false);
    expect(service.getImageMimeFromName('photo.jpeg')).toBe('image/jpeg');
    expect(service.getMimeFromName('component.tsx')).toBe('text/plain');
    expect(service.getMimeFromName('data.json')).toBe('application/json');
    expect(service.getMimeFromName('archive.zip')).toBe('application/octet-stream');
  });

  it('preserves extension and filename sanitization rules', () => {
    expect(service.getExtFromMime('image/svg+xml')).toBe('svg');
    expect(service.getExtFromMime('unknown/type')).toBe('bin');
    expect(service.sanitizeFilename('../bad file?.txt')).toBe('bad-file-.txt');
    expect(service.sanitizeFilename('..')).toBe('attachment');
  });

  it('preserves the attachment authorization manifest protocol', () => {
    const manifest = service.buildAttachmentManifest([{
      token: 'token', filename: 'notes.txt', mime: 'text/plain', sizeBytes: 12, relPath: '.opencode/attachments/s/token/notes.txt',
    }]);
    expect(manifest).toContain('Attachments (workspace files; read from disk; DO NOT use any URL):');
    expect(manifest).toContain('- notes.txt | mime=text/plain | size=12 | path=.opencode/attachments/s/token/notes.txt');
    expect(manifest).toContain('- Access is READ-ONLY.');
    expect(service.buildAttachmentManifest([])).toBe('');
  });
});
