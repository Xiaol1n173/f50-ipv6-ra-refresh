//<script>
(async () => {
  const MODAL_NAME = 'wifi_channel_switch_modal';
  const CHANNEL_FILE = '/data/kano_ap_channel.cfg';
  const MODULE_FILE = '/data/adb/modules/apex-bind-replace/apx/com.android.wifi/javalib/service-wifi.jar';

  const getCurrentChannel = async () => {
    const res = await runShellWithRoot(`timeout 2s awk '{print}' ${CHANNEL_FILE}`);
    const value = (res?.content || '').trim();
    if (!value) return '36';
    return value;
  };

  const checkModuleInstalled = async () => {
    const res = await runShellWithRoot(`ls ${MODULE_FILE}`);
    return Boolean(res?.success && (res?.content || '').includes('service-wifi.jar'));
  };

  const refreshModalState = async () => {
    const channelEl = document.querySelector('#wifi_channel_current');
    const moduleEl = document.querySelector('#wifi_channel_module_status');
    const tipEl = document.querySelector('#wifi_channel_module_tip');
    const btn36 = document.querySelector('#wifi_channel_btn_36');
    const btn149 = document.querySelector('#wifi_channel_btn_149');

    if (!channelEl || !moduleEl || !tipEl || !btn36 || !btn149) return;

    channelEl.textContent = '读取中...';
    moduleEl.textContent = '检测中...';
    tipEl.style.display = 'none';
    btn36.disabled = true;
    btn149.disabled = true;

    const [channel, installed] = await Promise.all([
      getCurrentChannel(),
      checkModuleInstalled(),
    ]);

    channelEl.textContent = channel;
    moduleEl.textContent = installed ? '已安装支持模块' : '未安装支持模块';
    moduleEl.style.color = installed ? 'var(--dark-btn-color-active)' : '#ff6b6b';
    tipEl.style.display = installed ? 'none' : 'block';
    btn36.disabled = !installed;
    btn149.disabled = !installed;
    btn36.style.background = channel === '36' ? 'var(--dark-btn-color-active)' : '';
    btn149.style.background = channel === '149' ? 'var(--dark-btn-color-active)' : '';
  };

  const switchChannel = async (channel) => {
    const btn36 = document.querySelector('#wifi_channel_btn_36');
    const btn149 = document.querySelector('#wifi_channel_btn_149');
    if (!btn36 || !btn149) return;

    btn36.disabled = true;
    btn149.disabled = true;
    createToast(`正在切换到 5G 信道 ${channel}...`, 'pink');

    const writeRes = await runShellWithRoot(
      `sh -c 'echo "${channel}" > ${CHANNEL_FILE} && chmod 777 ${CHANNEL_FILE}'`
    );
    if (!writeRes?.success) {
      createToast('写入信道失败', 'red');
      await refreshModalState();
      return;
    }

    const verifyRes = await runShellWithRoot(`timeout 2s awk '{print}' ${CHANNEL_FILE}`);
    const finalChannel = (verifyRes?.content || '').trim() || '36';
    if (finalChannel !== String(channel)) {
      createToast(`校验失败，当前读取为 ${finalChannel}`, 'red', 5000);
      await refreshModalState();
      return;
    }

    createToast(`已切换到 5G 信道 ${finalChannel} 重启生效`, 'pink');
    await refreshModalState();
  };

  const openModal = async () => {
    document.querySelector(`#${MODAL_NAME}`)?.remove();

    const { id, el } = createModal({
      name: MODAL_NAME,
      title: '5G WiFi 信道切换',
      maxWidth: '420px',
      showConfirm: false,
      onClose: () => true,
      content: `
        <div style="display:flex;flex-direction:column;gap:12px;">
          <div style="padding:10px;border-radius:10px;background:rgba(255,255,255,.04);">
            <div class="title" style="font-size:.78rem;margin-bottom:6px;">当前状态</div>
            <div style="font-size:.72rem;line-height:1.8;">
              <div>当前 5G 信道：<span id="wifi_channel_current">--</span></div>
              <div>模块状态：<span id="wifi_channel_module_status">--</span></div>
            </div>
            <div id="wifi_channel_module_tip" style="display:none;margin-top:8px;font-size:.68rem;color:#ff6b6b;">
              未检测到锁信道+解除热点限制的 Magisk 模块，请先安装对应模块后再使用。
            </div>
          </div>
          <div>
            <div class="title" style="font-size:.78rem;margin-bottom:8px;">切换信道</div>
            <div style="display:flex;gap:10px;flex-wrap:wrap;">
              <button id="wifi_channel_btn_36">切换到 5G 信道 36</button>
              <button id="wifi_channel_btn_149">切换到 5G 信道 149</button>
            </div>
          </div>
        </div>
      `,
    });

    const btn36 = el.querySelector('#wifi_channel_btn_36');
    const btn149 = el.querySelector('#wifi_channel_btn_149');

    btn36.onclick = async () => {
      await switchChannel(36);
    };
    btn149.onclick = async () => {
      await switchChannel(149);
    };

    showModal(id);
    await refreshModalState();
  };

  const mainBtn = document.createElement('button');
  mainBtn.textContent = 'WiFi信道切换';
  mainBtn.onclick = async () => {
    if (!(await checkAdvancedFunc())) {
      createToast('请先启用高级功能', 'pink');
      return;
    }
    await openModal();
  };

  document.querySelector('.actions-buttons')?.appendChild(mainBtn);
})();
//</script>
