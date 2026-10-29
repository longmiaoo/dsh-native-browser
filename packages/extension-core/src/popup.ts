async function update(command: string) {
  const target = document.getElementById('status')!;
  try {
    const result = await chrome.runtime.sendMessage({ command });
    target.textContent = `${result.status} · 当前标签页${result.controlled ? '正在受控' : result.tabAllowed ? '已允许（会话内可跨网站）' : '未授权'}`;
  } catch (error) { target.textContent = String(error); }
}
async function allow(): Promise<void> {
  await update('allow');
}
async function allowHttpPointer(): Promise<void> {
  try {
    const granted = await chrome.permissions.request({ origins: ['http://*/*'] });
    document.getElementById('status')!.textContent = granted
      ? '已允许 HTTP 页面的虚拟指针（可选）；浏览器控制仍受租约和 Stop 约束'
      : '未授予 HTTP 指针权限；浏览器控制仍可使用';
  } catch (error) {
    document.getElementById('status')!.textContent = String(error);
  }
}
document.getElementById('allow')!.addEventListener('click', () => void allow());
document.getElementById('allow-http')!.addEventListener('click', () => void allowHttpPointer());
document.getElementById('stop')!.addEventListener('click', () => void update('stop'));
void update('status');
