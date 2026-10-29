import { build } from 'esbuild';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
// Stable public key for the unpacked developer-preview extension. This pins the
// unpacked extension ID so setup can register the Native Messaging host before
// the user manually inspects chrome://extensions.
const developmentExtensionKey = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvbIvsTXjude4KS5WJOeI1wxvKpPx/07YYbCMGOSQufpFyMdaBP6o4SdJ2l2h4LmzZCXFq0QQkQ+MyCF6ZJjD6cx6QLHIvlYA/ndTS1ogkY1MEojMHSczXBRl/C6dJiNksQ+DQkSfBFeZ+zLYAao6UWLfTG+qv/s4kmkapQcKz0JAibkVFDpniTjKXEBToU/5UnME/Gs71lNDsoQv/gbINnbblxhZ2mqQCIWS8OByD2YCIACRkqtydn/xHUz7nd7VpJWb0HNepbXPeNfAa4w1di+UPI6JmXOR3ajwnpQ0RPN1f41HcivX38l0xsVK7NNrM8yKx0M+cEj1r7jsJi3VFwIDAQAB';
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
    name: 'DSH Native Browser (Developer Preview)', version: '0.1.0.6', minimum_chrome_version: '125',
    key: developmentExtensionKey,
    description: 'User-authorized browser control for DeepSeek Harness. Development preview.',
    permissions: ['debugger', 'nativeMessaging', 'activeTab', 'scripting', 'downloads'],
    host_permissions: ['http://*/*', 'https://*/*'],
    content_scripts: [{ matches: ['http://*/*', 'https://*/*'], js: ['pointer.js'], run_at: 'document_start', all_frames: false }],
    background: { service_worker: 'background.js', type: 'module' },
    action: { default_popup: 'popup.html' } }, null, 2) + '\n');
}
