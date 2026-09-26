/** Use existing transport ownership. POSIX setup may start/reuse, never stop a service. */
export async function activateSupervisorService(platform: NodeJS.Platform, host: {
    ensure(): Promise<void>;
    operate(action: 'start' | 'restart'): Promise<string>;
    checkWorkspace(): void;
}): Promise<void> {
    if (platform !== 'win32') {
        await host.ensure(); host.checkWorkspace(); return;
    }
    const started = await host.operate('start'); host.checkWorkspace();
    if (started === 'already_running') await host.operate('restart');
    host.checkWorkspace();
}
