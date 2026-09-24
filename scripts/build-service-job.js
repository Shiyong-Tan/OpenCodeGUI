const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
if (process.platform === 'win32') {
    const root = path.resolve(__dirname, '..');
    const output = path.join(root, 'out', 'native');
    fs.mkdirSync(output, { recursive: true });
    const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    execFileSync(compiler, ['/nologo', '/r:System.Web.Extensions.dll', '/out:' + path.join(output, 'ServiceJob.exe'),
        path.join(root, 'native', 'ServiceJob.cs')], { windowsHide: true, stdio: 'inherit' });
}
