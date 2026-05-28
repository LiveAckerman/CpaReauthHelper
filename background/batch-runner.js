// background/batch-runner.js — 批量循环 + 串行调度 + 失败列表管理
//
// 一次 batch 内的循环逻辑：
//   - 遍历 progress.entries 里 status=pending 的邮箱
//   - 每个邮箱：先把 status 置 running、广播；跑完根据结果置 success/failed
//   - 任意时刻 stop 标记被 set，就在当前邮箱跑完后退出（不强杀）
//   - 跑完后清 running、广播终态
// 失败列表重试 = 把 status=failed 的邮箱回退到 pending 后再次 run。

(function attachCpaBatchRunner(root) {
  if (root.__CPA_REAUTH_BATCH_BOOTED) return;
  root.__CPA_REAUTH_BATCH_BOOTED = true;

  const {
    CpaReauthState,
    CpaReauthApi,
    CpaReauthAuthFlow,
    CPA_EMAIL_STATUS,
    CPA_BETWEEN_EMAILS_DELAY_MS,
  } = root;

  let runningPromise = null;
  let stopRequested = false;

  function isBatchRunning() {
    return Boolean(runningPromise);
  }

  function requestStop() {
    stopRequested = true;
  }

  function shouldStop() {
    return stopRequested;
  }

  async function startBatch() {
    if (runningPromise) {
      throw new Error('已经有一个批量任务在跑了，请先停止后再启动。');
    }
    stopRequested = false;
    runningPromise = runBatchInner()
      .catch(async (error) => {
        await CpaReauthState.appendLog(`批量任务异常退出：${error?.message || error}`, 'error');
      })
      .finally(async () => {
        runningPromise = null;
        stopRequested = false;
        await CpaReauthState.setRunning({ isRunning: false, currentEmail: '', currentStep: '' });
        await CpaReauthState.broadcastStateUpdated();
      });
    return runningPromise;
  }

  async function runBatchInner() {
    const settings = await CpaReauthState.getSettings();
    if (!settings.baseUrl) throw new Error('CPA 地址未填写。');
    if (!settings.managementKey) throw new Error('CPA 管理密钥未填写。');
    if (!settings.sharedPassword) throw new Error('账号统一密码未填写。');

    await CpaReauthState.setRunning({
      isRunning: true,
      currentEmail: '',
      currentStep: 'initializing',
      sessionId: Date.now(),
    });
    await CpaReauthState.appendLog('批量任务开始', 'ok');
    await CpaReauthState.broadcastStateUpdated();

    let progress = await CpaReauthState.getProgress();
    const pendingEmails = (progress.entries || [])
      .filter((e) => e?.status === CPA_EMAIL_STATUS.PENDING)
      .map((e) => e.email);

    if (pendingEmails.length === 0) {
      await CpaReauthState.appendLog('没有待处理邮箱（全部已成功 / 失败 / 跳过）。', 'warn');
      return;
    }

    await CpaReauthState.appendLog(`本次将处理 ${pendingEmails.length} 个邮箱`);

    for (const email of pendingEmails) {
      if (shouldStop()) {
        await CpaReauthState.appendLog('已收到停止请求，结束批量任务。', 'warn');
        break;
      }
      // 重新校验 progress，可能其他动作改过
      const cur = await CpaReauthState.getProgress();
      const entry = (cur.entries || []).find((e) => e?.email === email);
      if (!entry || entry.status !== CPA_EMAIL_STATUS.PENDING) continue;

      await CpaReauthState.updateEntry(email, {
        status: CPA_EMAIL_STATUS.RUNNING,
        attempts: (entry.attempts || 0) + 1,
        lastError: '',
      });
      await CpaReauthState.setRunning({ currentEmail: email, currentStep: 'starting' });
      await CpaReauthState.broadcastStateUpdated();

      const result = await CpaReauthAuthFlow.reauthSingleEmail({
        settings,
        email,
        shouldStop,
      });

      if (result.ok) {
        await CpaReauthState.updateEntry(email, {
          status: CPA_EMAIL_STATUS.SUCCESS,
          lastError: '',
        });
        await CpaReauthState.appendLog(`✅ ${email} 重新授权成功`, 'ok');
      } else {
        await CpaReauthState.updateEntry(email, {
          status: CPA_EMAIL_STATUS.FAILED,
          lastError: result.error || '未知错误',
        });
        await CpaReauthState.appendLog(`❌ ${email} 重新授权失败：${result.error}`, 'error');
      }
      await CpaReauthState.broadcastStateUpdated();

      // 冷却
      if (!shouldStop()) {
        await new Promise((r) => setTimeout(r, CPA_BETWEEN_EMAILS_DELAY_MS));
      }
    }

    await CpaReauthAuthFlow.closeAuthTab();
    const final = await CpaReauthState.getProgress();
    const summary = CpaReauthState.summarizeProgress(final);
    await CpaReauthState.setProgress({ ...final, finishedAt: Date.now() });
    await CpaReauthState.appendLog(
      `批量任务结束：成功 ${summary.success}、失败 ${summary.failed}、跳过 ${summary.skipped}、未处理 ${summary.pending}`,
      'ok'
    );
  }

  /**
   * 把所有 failed 邮箱回退到 pending，等下次 startBatch 再跑。
   */
  async function retryFailed() {
    const progress = await CpaReauthState.getProgress();
    const entries = (progress.entries || []).map((e) => {
      if (e?.status === CPA_EMAIL_STATUS.FAILED) {
        return { ...e, status: CPA_EMAIL_STATUS.PENDING, lastError: '' };
      }
      return e;
    });
    const next = await CpaReauthState.setProgress({ ...progress, entries });
    await CpaReauthState.appendLog('已把所有失败邮箱回滚到 pending，准备重试');
    await CpaReauthState.broadcastStateUpdated();
    return next;
  }

  /**
   * 自动模式：从 CPA 拉所有 codex 账号 → 实地探测每个账号（POST api-call 调用 wham/usage）→
   * 只把「确认失效」的账号 seed 到 progress。
   *
   * 流程（与用户口径对齐）：
   *   1. listAuthFiles 拿全量 codex
   *   2. **候选 = unavailable=true 的（缓存视图，先窄一下，省得对全量都探一遍）**
   *      —— 如果用户传 probeAll=true，则对所有 codex 都探一遍（更彻底）
   *   3. probeAllCodexCandidates：每个候选都调 wham/usage
   *      - 2xx → healthy（缓存可能 stale，跳过，不拉进列表）
   *      - 429 / 配额相关正文 → quota_exceeded（不算异常，跳过）
   *      - 401/403/其他非配额错误 → needs_reauth（拉进列表）
   *      - api-call 本身报「auth token refresh failed」→ 也算 needs_reauth（token 已死）
   *   4. seedEntries 只填入 needs_reauth 的邮箱
   */
  async function fetchUnavailableAndSeed(options = {}) {
    const probeAll = options.probeAll === true;
    const concurrency = Math.max(1, Math.min(8, Number(options.concurrency) || 4));

    const settings = await CpaReauthState.getSettings();
    const files = await CpaReauthApi.listAuthFiles(settings);
    const allCodex = CpaReauthApi.pickCodexCandidatesForProbing(files);
    const candidates = probeAll ? allCodex : allCodex.filter((c) => c.unavailable === true);

    await CpaReauthState.appendLog(
      `已从 CPA 拉到 ${files.length} 个 auth-file（codex ${allCodex.length} 个，本次将探测 ${candidates.length} 个${probeAll ? '（全量）' : '（仅缓存里 unavailable=true）'}）`,
    );

    if (candidates.length === 0) {
      await CpaReauthState.seedEntries([], { source: 'auto' });
      await CpaReauthState.appendLog('没有需要探测的 codex 账号。', 'warn');
      await CpaReauthState.broadcastStateUpdated();
      return { count: 0, emails: [], summary: { healthy: 0, quotaExceeded: 0, needsReauth: 0, unknown: 0 } };
    }

    const startMs = Date.now();
    const { results, summary } = await CpaReauthApi.probeAllCodexCandidates(settings, candidates, {
      concurrency,
      shouldStop,
      onProgress: async ({ index, total, cand, result }) => {
        const cls = result.classification;
        const tag = cls.status === 'needs_reauth' ? '⚠️异常'
          : cls.status === 'quota_exceeded' ? '🟡额度超'
          : cls.status === 'healthy' ? '✅正常'
          : '❓未知';
        const detail = result.error ? `（${result.error}）` : `（HTTP ${result.statusCode}，${cls.reason}）`;
        const level = cls.status === 'needs_reauth' ? 'warn' : cls.status === 'unknown' ? 'warn' : 'info';
        await CpaReauthState.appendLog(`[${index + 1}/${total}] ${cand.email} → ${tag}${detail}`, level);
      },
    });

    const needsReauthEmails = results
      .filter((r) => r?.classification?.status === 'needs_reauth')
      .map((r) => r.cand.email);

    await CpaReauthState.seedEntries(needsReauthEmails, { source: 'auto' });

    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    await CpaReauthState.appendLog(
      `探测完成（${elapsed}s）：待重授权 ${summary.needsReauth} / 额度超 ${summary.quotaExceeded} / 正常 ${summary.healthy} / 未知 ${summary.unknown}`,
      'ok',
    );
    await CpaReauthState.broadcastStateUpdated();
    return {
      count: needsReauthEmails.length,
      emails: needsReauthEmails,
      summary,
      probedTotal: candidates.length,
      codexTotal: allCodex.length,
    };
  }

  /**
   * 手动模式：用户在 textarea 输入若干行邮箱，按换行切，seed 到 progress
   */
  async function seedManualEmails(rawText) {
    const emails = String(rawText || '')
      .split(/[\r\n,;]+/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    await CpaReauthState.seedEntries(emails, { source: 'manual' });
    await CpaReauthState.appendLog(`已从手动输入解析 ${emails.length} 个邮箱`, 'ok');
    await CpaReauthState.broadcastStateUpdated();
    return { count: emails.length, emails };
  }

  root.CpaReauthBatchRunner = {
    startBatch,
    requestStop,
    isBatchRunning,
    retryFailed,
    fetchUnavailableAndSeed,
    seedManualEmails,
  };
})(typeof self !== 'undefined' ? self : globalThis);
