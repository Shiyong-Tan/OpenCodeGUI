import * as fs from 'fs';
import * as path from 'path';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'SidebarProvider.ts'), 'utf8');

describe('SidebarProvider attachment storage integration', () => {
  it('constructs one service with workspace, storage, and logging dependencies', () => {
    expect(source).toContain('private readonly attachmentStorage: AttachmentStorageService;');
    expect(source).toContain('this.attachmentStorage = new AttachmentStorageService({');
    expect(source).toContain('globalStoragePath: this._context.globalStoragePath');
    expect(source).toContain('getWorkspaceRootPath: () => this.getWorkspaceRootPath()');
  });

  it('routes storage, MIME, manifest, cleanup, and disposal through the service', () => {
    expect(source).toContain('this.attachmentStorage.saveAttachment(targetSessionId, attachment, reqId)');
    expect(source).toContain('this.attachmentStorage.saveClipboardImage(data.dataUrl, data.mime)');
    expect(source).toContain('this.attachmentStorage.buildAttachmentManifest(savedAttachments)');
    expect(source).toContain("this.attachmentStorage.scheduleCleanup('activate');");
    expect(source).toContain('this.attachmentStorage.startCleanupTimer();');
    expect(source).toContain('this.attachmentStorage.dispose();');
  });

  it('does not retain parallel cleanup timer or in-flight state', () => {
    expect(source).not.toContain('private attachmentCleanupTimer?:');
    expect(source).not.toContain('private attachmentCleanupInFlight =');
  });
});
