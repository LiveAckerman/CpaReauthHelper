// background/message-router.js — 侧栏 ↔ background 消息路由总入口

(function attachCpaMessageRouter(root) {
  if (root.__CPA_REAUTH_MSG_ROUTER_BOOTED) return;
  root.__CPA_REAUTH_MSG_ROUTER_BOOTED = true;

  const {
    CPA_MSG,
    CpaReauthState,
    CpaReauthApi,
    CpaReauthBatchRunner,
  } = root;

  async function handle(message) {
    if (!message || typeof message.type !== 'string') {
      return { error: 'invalid message' };
    }

    switch (message.type) {
      case CPA_MSG.GET_STATE: {
        return CpaReauthState.getFullStateForSidebar();
      }

      case CPA_MSG.UPDATE_SETTINGS: {
        const next = await CpaReauthState.setSettings(message.payload || {});
        await CpaReauthState.broadcastStateUpdated();
        return { ok: true, settings: next };
      }

      case CPA_MSG.FETCH_UNAVAILABLE_EMAILS: {
        // 探活 + 拉列表 + 逐个调 wham/usage 探测 + seed 真正需要重授权的
        try {
          const ping = await CpaReauthApi.pingCpa(await CpaReauthState.getSettings());
          if (!ping.ok) {
            return { ok: false, error: ping.error };
          }
          const probeAll = message.payload?.probeAll === true;
          const result = await CpaReauthBatchRunner.fetchUnavailableAndSeed({ probeAll });
          return { ok: true, ...result, ping };
        } catch (error) {
          return { ok: false, error: String(error?.message || error) };
        }
      }

      case 'CPA_SEED_MANUAL_EMAILS': {
        // 侧栏手动模式按钮：把 textarea 里的邮箱 seed 到 progress
        try {
          const result = await CpaReauthBatchRunner.seedManualEmails(message.payload?.text || '');
          return { ok: true, ...result };
        } catch (error) {
          return { ok: false, error: String(error?.message || error) };
        }
      }

      case CPA_MSG.START_BATCH: {
        try {
          // fire-and-forget；用户后续看 broadcast 拿状态
          CpaReauthBatchRunner.startBatch().catch(() => {});
          return { ok: true };
        } catch (error) {
          return { ok: false, error: String(error?.message || error) };
        }
      }

      case CPA_MSG.STOP_BATCH: {
        const wasRunning = CpaReauthBatchRunner.isBatchRunning();
        CpaReauthBatchRunner.requestStop();
        if (!wasRunning) {
          // runner 早已退出（被 SW 重启杀掉 / 之前异常结束），但 chrome.storage.session
          // 里 isRunning 还停在 true。直接强制清零，让 btn-start 立刻恢复可点。
          await CpaReauthState.clearRunning();
          await CpaReauthState.appendLog('未检测到正在运行的批量任务，已强制重置运行状态。', 'warn');
        } else {
          await CpaReauthState.appendLog('用户请求停止批量任务（当前邮箱跑完后退出）', 'warn');
        }
        await CpaReauthState.broadcastStateUpdated();
        return { ok: true };
      }

      case CPA_MSG.RETRY_FAILED: {
        await CpaReauthBatchRunner.retryFailed();
        return { ok: true };
      }

      case CPA_MSG.REMOVE_EMAIL_ENTRY: {
        // 侧栏邮箱列表里点了某行的「删除」按钮 —— 单条移除
        const email = String(message.payload?.email || '').trim().toLowerCase();
        const result = await CpaReauthState.removeEntry(email);
        if (result.ok) {
          await CpaReauthState.appendLog(`已从列表移除邮箱：${email}（剩余 ${result.remaining}）`);
          await CpaReauthState.broadcastStateUpdated();
          return { ok: true, removed: result.removed, remaining: result.remaining };
        }
        if (result.reason === 'running') {
          await CpaReauthState.appendLog(`拒绝移除正在处理中的邮箱：${email}（请先停止批量任务）`, 'warn');
        }
        return { ok: false, error: result.reason || 'unknown', email };
      }

      case CPA_MSG.CLEAR_PROGRESS: {
        // 清进度时同步把 running 状态清掉，否则上一次没正常收尾的运行标志会卡住按钮。
        await CpaReauthState.clearProgress();
        await CpaReauthState.clearRunning();
        await CpaReauthState.broadcastStateUpdated();
        return { ok: true };
      }

      case 'CPA_FORCE_RESET_RUNNING': {
        // 给侧栏「强制解锁」按钮用的逃生口。
        await CpaReauthState.clearRunning();
        await CpaReauthState.appendLog('已强制重置运行状态。', 'warn');
        await CpaReauthState.broadcastStateUpdated();
        return { ok: true };
      }

      case 'CPA_PING_CPA': {
        try {
          const ping = await CpaReauthApi.pingCpa(await CpaReauthState.getSettings());
          return { ok: ping.ok, ...ping };
        } catch (error) {
          return { ok: false, error: String(error?.message || error) };
        }
      }

      default:
        return { ignored: true };
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string' || !message.type.startsWith('CPA_')) {
      return;
    }
    // 内容脚本回包消息不走这里：内容脚本只 onMessage / sendResponse，不会调
    // chrome.runtime.sendMessage 主动发；如果有跨方向消息，也按 type 黑名单跳过。
    if ([
      CPA_MSG.EXECUTE_FILL_EMAIL,
      CPA_MSG.EXECUTE_FILL_PASSWORD,
      CPA_MSG.EXECUTE_CONFIRM_OAUTH,
      CPA_MSG.INSPECT_AUTH_PAGE,
      CPA_MSG.STATE_UPDATED,
      CPA_MSG.LOG_APPEND,
    ].includes(message.type)) {
      return;
    }
    handle(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ error: String(error?.message || error) }));
    return true;
  });

  root.CpaReauthMessageRouter = { handle };
})(typeof self !== 'undefined' ? self : globalThis);
