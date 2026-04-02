const packager = require('electron-packager');
const archiver = require('archiver');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

async function run() {
  console.log('→ Packaging with electron-packager...');
  const [appPath] = await packager({
    dir: ROOT,
    name: 'Validador WhatsApp',
    platform: 'win32',
    arch: 'x64',
    out: DIST,
    overwrite: true,
    icon: path.join(__dirname, 'icon.ico'),
    ignore: [
      /^\/dist/,
      /^\/build/,
      /^\/\.git/,
      /^\/phone_cache\.json/
    ],
    prune: true,
    asar: true
  });

  console.log('✓ Packaged to:', appPath);

  // Zip the output folder
  const zipPath = path.join(DIST, 'Validador-WhatsApp-win-x64.zip');
  console.log('→ Creating ZIP:', zipPath);

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(appPath, 'Validador WhatsApp');
    archive.finalize();
  });

  console.log('✓ ZIP created:', zipPath);
  console.log('  Size:', (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1), 'MB');
}

run().catch(err => { console.error('✗', err.message || err); process.exit(1); });
