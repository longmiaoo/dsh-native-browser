import { build } from 'esbuild';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
for (const brand of ['chrome', 'edge']) {
  const out = path.join(root, 'dist', 'extension', brand);
  await mkdir(out, { recursive: true });
  await build({ entryPoints: [path.join(root, 'packages/extension-core/src/background.ts')],
    outfile: path.join(out, 'background.js'), bundle: true, format: 'esm', platform: 'browser',
    define: { __BROWSER_BRAND__: JSON.stringify(brand) } });
  await build({ entryPoints: [path.join(root, 'packages/extension-core/src/popup.ts')],
    outfile: path.join(out, 'popup.js'), bundle: true, platform: 'browser' });
  await build({ entryPoints: [path.join(root, 'packages/extension-core/src/pointer.ts')],
    outfile: path.join(out, 'pointer.js'), bundle: true, platform: 'browser' });
  await copyFile(path.join(root, 'packages/extension-core/popup.html'), path.join(out, 'popup.html'));
  await writeFile(path.join(out, 'manifest.json'), JSON.stringify({ manifest_version: 3,
    name: 'DSH Native Browser (Developer Preview)', version: '0.1.0', minimum_chrome_version: '125',
    description: 'User-authorized browser control for DeepSeek Harness. Development preview.',
    permissions: ['debugger', 'nativeMessaging', 'activeTab', 'scripting'],
    host_permissions: ['http://*/*', 'https://*/*'],
    content_scripts: [{ matches: ['http://*/*', 'https://*/*'], js: ['pointer.js'], run_at: 'document_start', all_frames: false }],
    background: { service_worker: 'background.js', type: 'module' },
    action: { default_popup: 'popup.html' } }, null, 2) + '\n');
}
