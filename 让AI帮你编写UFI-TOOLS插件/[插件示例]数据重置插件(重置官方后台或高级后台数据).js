//<script>
(async () => {
  const checkAdvanceFunc = async () => {
    const res = await runShellWithRoot('whoami')
    if (res.content) {
      if (res.content.includes('root')) {
        return true
      }
    }
    return false
  }

  const create5ConfirmHandler = (actionName, realHandler, needCount = 5, resetMs = 6000) => {
    let count = 0
    let timer = null

    return async () => {
      count++
      timer && clearTimeout(timer)
      if(UFI_DATA.app_ver < "3.9.0" ) return createToast("高级后台版本需要在3.9.0及以上才可使用", 'pink')
      if (!(await checkAdvanceFunc())) return createToast("请启用高级功能", 'pink')

      const left = needCount - count

      if (left > 0) {
        createToast(`【${actionName}】危险操作！还需再点击 ${left} 次确认`, "pink")
        timer = setTimeout(() => {
          count = 0
        }, resetMs)
        return
      }

      count = 0
      timer = null
      return realHandler()
    }
  }

  // 主入口按钮
  const mainBtn = document.createElement('button');
  mainBtn.textContent = "后台数据重置";
  mainBtn.onclick = async () => {
    const { id, el } = createModal({
      name: "data_cleaner",
      title: '后台数据重置',
      maxWidth: "420px",
      onClose: () => true,
      onConfirm: () => true,
      content: `
        <div style="display:flex;gap:10px;flex-direction: column">
          <div class="title" style="font-size: .8rem">一键操作</div>
          <div style="display:flex;gap:10px;flex-wrap: wrap" class="clean_inner"></div>
        </div>
      `
    });

    const inner = el.querySelector('.clean_inner');
    if (inner) {
      inner.appendChild(btnClearZteWeb);
      inner.appendChild(btnClearSelf);
      inner.appendChild(btnClearBoth);
    }

    showModal(id);
  };

  // 防抖/冷却
  let cooling = false;
  const withCooldown = async (fn) => {
    if (cooling) return createToast("冷却中，请勿重复点击", "pink");
    cooling = true;
    try {
      await fn();
    } finally {
      setTimeout(() => (cooling = false), 3000);
    }
  };

  // 1) 一键清空官方后台数据
  const btnClearZteWeb = document.createElement('button');
  btnClearZteWeb.textContent = "一键清空官方后台数据";

  btnClearZteWeb.onclick = create5ConfirmHandler(
    "清空中兴后台数据",
    () => withCooldown(async () => {
      try {
        createToast("正在清空 中兴后台 数据…", "");
        await runShellWithRoot('pm clear com.zte.web && sleep 3 && reboot');
        createToast("清除数据成功，自动重启中...", "green");
      } catch (e) {
        createToast("操作异常：" + (e?.message || e), "pink");
      }
    })
  );

  // 2) 一键清空UFI-TOOLS数据
  const btnClearSelf = document.createElement('button');
  btnClearSelf.textContent = "一键清空UFI-TOOLS数据";

  btnClearSelf.onclick = create5ConfirmHandler(
    "清空UFI-TOOLS数据",
    () => withCooldown(async () => {
      try {
        createToast("正在重置UFI-TOOLS数据…", "");
        await runShellWithRoot("sh -c 'am force-stop com.minikano.f50_sms;pm clear com.minikano.f50_sms; sleep 3; reboot' >/dev/null 2>&1 &");
        createToast("清除数据成功，自动重启中...", "green");
      } catch (e) {
        createToast("操作异常：" + (e?.message || e), "pink");
      }
    })
  );

  // 3) 一键清空二者全部数据
  const btnClearBoth = document.createElement('button');
  btnClearBoth.textContent = "一键清空二者全部数据";

  btnClearBoth.onclick = create5ConfirmHandler(
    "清空二者全部数据",
    () => withCooldown(async () => {
      try {
        createToast("正在清空二者全部数据…", "");
        await runShellWithRoot("sh -c 'pm clear com.zte.web;am force-stop com.minikano.f50_sms; pm clear com.minikano.f50_sms; sync; sleep 3; reboot' >/dev/null 2>&1 &");
        createToast("清除数据成功，自动重启中...", "green");
      } catch (e) {
        createToast("操作异常：" + (e?.message || e), "pink");
      }
    })
  );

  // 挂到页面按钮区
  document.querySelector('.actions-buttons')?.appendChild(mainBtn);

})();
//</script>