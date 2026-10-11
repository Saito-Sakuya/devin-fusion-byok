'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const stageRoot = fs.realpathSync(os.tmpdir());
const stage = fs.mkdtempSync(path.join(stageRoot, 'devin-fusion-vsix-'));
const output = path.join(root, pkg.name + '-' + pkg.version + '.vsix');
try {
const extension = path.join(stage, 'extension');
fs.mkdirSync(extension);
for (const name of ['package.json', 'src', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) fs.cpSync(path.join(root, name), path.join(extension, name), { recursive: true });
fs.writeFileSync(path.join(stage, '[Content_Types].xml'), '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="cjs" ContentType="application/javascript"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="vsixmanifest" ContentType="text/xml"/><Default Extension="" ContentType="text/plain"/></Types>');
fs.writeFileSync(path.join(stage, 'extension.vsixmanifest'), `<?xml version="1.0"?><PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Language="en-US" Id="${pkg.name}" Version="${pkg.version}" Publisher="${pkg.publisher}"/><DisplayName>${pkg.displayName}</DisplayName><Description xml:space="preserve">${pkg.description}</Description><Tags>byok,fusion,devin</Tags><Categories>Other</Categories><GalleryFlags>Public</GalleryFlags><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.100.0"/><Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value=""/><Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value=""/><Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui"/></Properties></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets></PackageManifest>`);
if (process.platform === 'win32') {
  const archive = path.join(stage, 'package.zip');
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const inputs = ['extension', '[Content_Types].xml', 'extension.vsixmanifest'].map(name => quote(path.join(stage, name))).join(',');
  const command = `$ErrorActionPreference = 'Stop'; Compress-Archive -LiteralPath ${inputs} -DestinationPath ${quote(archive)} -CompressionLevel Optimal`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, timeout: 120000, stdio: 'pipe' });
  fs.rmSync(output, { force: true });
  fs.copyFileSync(archive, output);
} else {
  fs.rmSync(output, { force: true });
  execFileSync('/usr/bin/zip', ['-qr', output, '.'], { cwd: stage });
}
console.log(output);
} finally {
  const relative = path.relative(stageRoot, stage);
  if (!relative.startsWith('devin-fusion-vsix-') || relative.includes(path.sep) || path.isAbsolute(relative)) throw new Error('unsafe_staging_path');
  fs.rmSync(stage, { recursive: true, force: true });
}
