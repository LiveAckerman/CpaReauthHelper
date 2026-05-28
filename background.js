// background.js — Service Worker 入口
//
// 装载顺序：shared 常量 → state → cpa-api → auth-flow → batch → message-router
// 各模块用 IIFE + idempotent guard 自己挂在 self 上，互相通过 self.X 访问。

try {
  importScripts(
    'shared/constants.js',
    'background/state.js',
    'background/cpa-api.js',
    'background/cookie-cleanup.js',
    'background/auth-flow-runner.js',
    'background/batch-runner.js',
    'background/message-router.js'
  );
} catch (error) {
  console.error('[CpaReauth:background] importScripts failed:', error);
  throw error;
}

console.log('[CpaReauth:background] service worker booted');

// Service Worker 启动 / 重启意味着上一次的 runBatchInner 一定已经死了，
// 所以 chrome.storage.session.cpa_batch_running.isRunning 不管之前是什么状态，
// 都得强制设回 false，否则侧栏一打开就看到 btn-start 被禁用、btn-stop 也用不了。
(async () => {
  try {
    if (self.CpaReauthState?.clearRunning) {
      await self.CpaReauthState.clearRunning();
    }
  } catch (err) {
    console.warn('[CpaReauth:background] failed to clear stale running flag on boot:', err);
  }
})();

// 点扩展图标 → 打开侧栏
chrome.action?.onClicked?.addListener?.(async (tab) => {
  try {
    if (tab?.windowId != null && chrome.sidePanel?.open) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } catch (err) {
    console.warn('[CpaReauth:background] open side panel failed:', err);
  }
});

// 默认让 sidePanel 在所有 tab 上可用
chrome.sidePanel
  ?.setPanelBehavior?.({ openPanelOnActionClick: true })
  .catch(() => {});
