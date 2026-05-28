// sidepanel/sidepanel.js — 侧栏 UI 逻辑

(function bootSidepanel() {
  const CPA_MSG = self.CPA_MSG;
  const CPA_EMAIL_STATUS = self.CPA_EMAIL_STATUS;

  const $ = (id) => document.getElementById(id);
  const inputBaseUrl = $('input-base-url');
  const inputMgmtKey = $('input-management-key');
  const inputPassword = $('input-shared-password');
  const selectCallbackMode = $('select-callback-mode');
  const btnToggleMgmtKey = $('btn-toggle-mgmt-key');
  const btnTogglePassword = $('btn-toggle-password');
  const btnSaveSettings = $('btn-save-settings');
  const btnPingCpa = $('btn-ping-cpa');
  const pingStatus = $('ping-status');
  const fetchStatus = $('fetch-status');
  const btnFetchUnavailable = $('btn-fetch-unavailable');
  const textareaManualEmails = $('textarea-manual-emails');
  const btnSeedManual = $('btn-seed-manual');
  const blockAuto = $('block-auto');
  const blockManual = $('block-manual');
  const btnStart = $('btn-start');
  const btnStop = $('btn-stop');
  const btnRetryFailed = $('btn-retry-failed');
  const btnClear = $('btn-clear');
  const btnForceReset = $('btn-force-reset');
  const summaryEl = $('summary');
  const currentEmailEl = $('current-email');
  const currentStepEl = $('current-step');
  const entriesTbody = $('entries-tbody');
  const logsEl = $('logs');
  const btnCollapseSettings = $('btn-collapse-settings');
  const settingsPanel = $('settings-panel');

  function send(type, payload) {
    return chrome.runtime.sendMessage({ type, payload });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---------- 设置 ----------

  function fillSettings(settings) {
    if (!settings) return;
    inputBaseUrl.value = settings.baseUrl || '';
    inputMgmtKey.value = settings.managementKey || '';
    inputPassword.value = settings.sharedPassword || '';
    selectCallbackMode.value = settings.callbackMode || 'local';
    if (textareaManualEmails && settings.manualEmailsText && !textareaManualEmails.value) {
      textareaManualEmails.value = settings.manualEmailsText;
    }
    const source = settings.emailSource || 'auto';
    document.querySelectorAll('input[name="source"]').forEach((r) => {
      r.checked = r.value === source;
    });
    blockAuto.style.display = source === 'auto' ? '' : 'none';
    blockManual.style.display = source === 'manual' ? '' : 'none';
  }

  function collectSettings() {
    return {
      baseUrl: inputBaseUrl.value.trim(),
      managementKey: inputMgmtKey.value.trim(),
      sharedPassword: inputPassword.value,
      callbackMode: selectCallbackMode.value || 'local',
      emailSource: document.querySelector('input[name="source"]:checked')?.value || 'auto',
      manualEmailsText: textareaManualEmails ? textareaManualEmails.value : '',
    };
  }

  async function saveSettings(opts = {}) {
    const payload = collectSettings();
    const resp = await send(CPA_MSG.UPDATE_SETTINGS, payload);
    if (opts.silent !== true) {
      pingStatus.textContent = '已保存';
      setTimeout(() => { pingStatus.textContent = ''; }, 1500);
    }
    return resp;
  }

  // ---------- 渲染 ----------

  const STATUS_LABEL = {
    pending: '待处理',
    running: '处理中',
    success: '成功',
    failed: '失败',
    skipped: '跳过',
  };

  function renderSummary(summary) {
    if (!summary) {
      summaryEl.innerHTML = '';
      return;
    }
    summaryEl.innerHTML = `
      <div class="item"><div class="num">${summary.total}</div><div class="lbl">总数</div></div>
      <div class="item pending"><div class="num">${summary.pending}</div><div class="lbl">待处理</div></div>
      <div class="item running"><div class="num">${summary.running}</div><div class="lbl">处理中</div></div>
      <div class="item success"><div class="num">${summary.success}</div><div class="lbl">成功</div></div>
      <div class="item failed"><div class="num">${summary.failed}</div><div class="lbl">失败</div></div>
    `;
  }

  function renderEntries(entries) {
    const rows = (entries || []).map((entry, i) => {
      const status = entry.status || 'pending';
      const isRunning = status === 'running';
      // 正在跑的那行不允许删除（避免在脚下抽地毯，先停批量任务）
      const removeBtn = isRunning
        ? `<button class="ghost icon" type="button" disabled title="正在处理中，请先停止批量任务再删除">🗑</button>`
        : `<button class="ghost icon btn-remove-entry" type="button" data-email="${escapeHtml(entry.email)}" title="从列表中移除该邮箱">🗑</button>`;
      return `<tr>
        <td>${i + 1}</td>
        <td class="email">${escapeHtml(entry.email)}</td>
        <td class="status status-${escapeHtml(status)}">${escapeHtml(STATUS_LABEL[status] || status)}</td>
        <td>${entry.attempts || 0}</td>
        <td>${entry.source === 'manual' ? '手动' : '自动'}</td>
        <td class="error">${escapeHtml((entry.lastError || '').slice(0, 80))}</td>
        <td class="actions">${removeBtn}</td>
      </tr>`;
    });
    entriesTbody.innerHTML = rows.join('') || '<tr><td colspan="7" class="muted" style="text-align:center;">暂无邮箱</td></tr>';
  }

  function renderRunning(running) {
    currentEmailEl.textContent = running.isRunning ? (running.currentEmail || '(准备中)') : '(空闲)';
    currentStepEl.textContent = running.currentStep ? `步骤: ${running.currentStep}` : '';
    btnStart.disabled = Boolean(running.isRunning);
    btnStop.disabled = !running.isRunning;
  }

  function renderLogs(logs) {
    const arr = Array.isArray(logs) ? logs.slice(-100) : [];
    logsEl.innerHTML = arr.map((line) => {
      const ts = new Date(line.timestamp || 0).toLocaleTimeString();
      const lvl = line.level || 'info';
      return `<div class="line ${escapeHtml(lvl)}"><span class="ts">${escapeHtml(ts)}</span>${escapeHtml(line.message || '')}</div>`;
    }).join('');
    logsEl.scrollTop = logsEl.scrollHeight;
  }

  function appendLogLine(line) {
    if (!line) return;
    const ts = new Date(line.timestamp || Date.now()).toLocaleTimeString();
    const lvl = line.level || 'info';
    const div = document.createElement('div');
    div.className = `line ${lvl}`;
    div.innerHTML = `<span class="ts">${escapeHtml(ts)}</span>${escapeHtml(line.message || '')}`;
    logsEl.appendChild(div);
    while (logsEl.children.length > 200) logsEl.removeChild(logsEl.firstChild);
    logsEl.scrollTop = logsEl.scrollHeight;
  }

  function renderState(state) {
    if (!state) return;
    fillSettings(state.settings);
    renderSummary(state.summary);
    renderEntries(state.progress?.entries || []);
    renderRunning(state.running || {});
    renderLogs(state.running?.logs || []);
  }

  // ---------- 事件 ----------

  function togglePasswordInput(input) {
    input.type = input.type === 'password' ? 'text' : 'password';
  }

  btnToggleMgmtKey.addEventListener('click', () => togglePasswordInput(inputMgmtKey));
  btnTogglePassword.addEventListener('click', () => togglePasswordInput(inputPassword));

  btnSaveSettings.addEventListener('click', () => saveSettings());

  btnPingCpa.addEventListener('click', async () => {
    pingStatus.textContent = '探测中…';
    pingStatus.style.color = '#888';
    await saveSettings({ silent: true });
    const r = await send('CPA_PING_CPA');
    if (r?.ok) {
      pingStatus.textContent = `✓ 连通，共 ${r.totalAccounts || 0} 账号 / codex ${r.codexCount || 0} / 待重授权 ${r.codexUnavailable || 0}`;
      pingStatus.style.color = '#080';
    } else {
      pingStatus.textContent = `✗ ${r?.error || '失败'}`;
      pingStatus.style.color = '#c00';
    }
  });

  document.querySelectorAll('input[name="source"]').forEach((r) => {
    r.addEventListener('change', async () => {
      blockAuto.style.display = r.value === 'auto' && r.checked ? '' : 'none';
      blockManual.style.display = r.value === 'manual' && r.checked ? '' : 'none';
      await saveSettings({ silent: true });
    });
  });

  btnFetchUnavailable.addEventListener('click', async () => {
    fetchStatus.textContent = '拉取中…';
    fetchStatus.style.color = '#888';
    await saveSettings({ silent: true });
    const r = await send(CPA_MSG.FETCH_UNAVAILABLE_EMAILS);
    if (r?.ok) {
      fetchStatus.textContent = `✓ 已载入 ${r.count} 个待重新授权邮箱`;
      fetchStatus.style.color = '#080';
    } else {
      fetchStatus.textContent = `✗ ${r?.error || '失败'}`;
      fetchStatus.style.color = '#c00';
    }
  });

  btnSeedManual.addEventListener('click', async () => {
    await saveSettings({ silent: true });
    const text = textareaManualEmails.value || '';
    const r = await send('CPA_SEED_MANUAL_EMAILS', { text });
    if (r?.ok) {
      fetchStatus.textContent = `✓ 已载入 ${r.count} 个邮箱`;
      fetchStatus.style.color = '#080';
    } else {
      fetchStatus.textContent = `✗ ${r?.error || '失败'}`;
      fetchStatus.style.color = '#c00';
    }
  });

  btnStart.addEventListener('click', async () => {
    await saveSettings({ silent: true });
    const r = await send(CPA_MSG.START_BATCH);
    if (r?.error) {
      alert(`启动失败：${r.error}`);
    }
  });

  btnStop.addEventListener('click', async () => {
    await send(CPA_MSG.STOP_BATCH);
  });

  btnRetryFailed.addEventListener('click', async () => {
    await send(CPA_MSG.RETRY_FAILED);
  });

  btnClear.addEventListener('click', async () => {
    if (!confirm('确定清空所有邮箱进度？已保存的设置不会被清。')) return;
    await send(CPA_MSG.CLEAR_PROGRESS);
  });

  btnForceReset?.addEventListener('click', async () => {
    await send('CPA_FORCE_RESET_RUNNING');
  });

  // 邮箱列表的「🗑 移除」按钮 —— 用事件委托，因为整张表会被 renderEntries 整片重建
  entriesTbody.addEventListener('click', async (ev) => {
    const btn = ev.target instanceof Element ? ev.target.closest('.btn-remove-entry') : null;
    if (!btn) return;
    const email = btn.getAttribute('data-email') || '';
    if (!email) return;
    if (!confirm(`确定从列表中移除邮箱 ${email}？\n该邮箱的进度记录会被清除，但 CPA 上的账号不受影响。`)) return;
    btn.disabled = true;
    const r = await send(CPA_MSG.REMOVE_EMAIL_ENTRY, { email });
    if (!r?.ok) {
      btn.disabled = false;
      if (r?.error === 'running') {
        alert('该邮箱正在处理中，请先点「停止」再移除。');
      } else if (r?.error === 'not-found') {
        alert('该邮箱已不在列表里。');
      } else {
        alert(`移除失败：${r?.error || '未知错误'}`);
      }
    }
    // 成功时 background 会广播 STATE_UPDATED，整张表会自动重渲，不用本地手动 splice
  });

  btnCollapseSettings.addEventListener('click', () => {
    const hidden = settingsPanel.style.display === 'none';
    settingsPanel.style.display = hidden ? '' : 'none';
    btnCollapseSettings.textContent = hidden ? '收起设置' : '展开设置';
  });

  // ---------- 后台 broadcast ----------

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === CPA_MSG.STATE_UPDATED) {
      renderState(message.payload);
    } else if (message.type === CPA_MSG.LOG_APPEND) {
      appendLogLine(message.payload);
    }
  });

  // ---------- 初始加载 ----------

  send(CPA_MSG.GET_STATE).then(renderState).catch(() => {});
})();
