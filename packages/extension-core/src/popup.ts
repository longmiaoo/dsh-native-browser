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
document.getElementById('allow')!.addEventListener('click', () => void allow());
document.getElementById('stop')!.addEventListener('click', () => void update('stop'));
void update('status');
