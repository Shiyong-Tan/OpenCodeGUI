import * as fs from 'fs';
import * as path from 'path';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'SidebarProvider.ts'), 'utf8');
const turnControllerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'controllers', 'TurnCommandController.ts'), 'utf8');
const utilityControllerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'controllers', 'UtilityCommandController.ts'), 'utf8');

describe('SidebarProvider attachment storage integration', () => {
  it('constructs one service with workspace, storage, and logging dependencies', () => {
    expect(source).toContain('private readonly attachmentStorage: AttachmentStorageService;');
    expect(source).toContain('this.attachmentStorage = new AttachmentStorageService({');
    expect(source).toContain('globalStoragePath: this._context.globalStoragePath');
    expect(source).toContain('getWorkspaceRootPath: () => this.getWorkspaceRootPath()');
  });

  it('routes storage, MIME, manifest, cleanup, and disposal through the service', () => {
    expect(turnControllerSource).toContain('host.attachments.saveAttachment(targetSessionId, attachment, reqId)');
    expect(utilityControllerSource).toContain('this.host.saveClipboardImage(data.dataUrl, data.mime)');
    expect(source).toContain('saveClipboardImage: (dataUrl, mime) => this.attachmentStorage.saveClipboardImage(dataUrl, mime)');
    expect(turnControllerSource).toContain('host.attachments.buildAttachmentManifest(savedAttachments)');
    expect(source).toContain("this.attachmentStorage.scheduleCleanup('activate');");
    expect(source).toContain('this.attachmentStorage.startCleanupTimer();');
    expect(source).toContain('this.attachmentStorage.dispose();');
  });

  it('does not retain parallel cleanup timer or in-flight state', () => {
    expect(source).not.toContain('private attachmentCleanupTimer?:');
    expect(source).not.toContain('private attachmentCleanupInFlight =');
  });

  it('does not retain legacy attachment storage implementations', () => {
    expect(source).not.toContain('private async saveClipboardImage(');
    expect(source).not.toContain('private async saveAttachment(');
    expect(source).not.toContain('private getMimeFromName(');
    expect(source).not.toContain('private buildAttachmentManifest(');
    expect(source).not.toContain('private async runAttachmentCleanup(');
  });
});
