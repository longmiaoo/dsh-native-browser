async function update(command: string) {
  const target = document.getElementById('status')!;
  try {
    const result = await chrome.runtime.sendMessage({ command });
    target.textContent = `${result.status} · 当前页${result.controlled ? '正在受控' : result.tabAllowed ? '已允许' : '未授权'}`;
  } catch (error) { target.textContent = String(error); }
}
document.getElementById('allow')!.addEventListener('click', () => void update('allow'));
document.getElementById('stop')!.addEventListener('click', () => void update('stop'));
void update('status');
