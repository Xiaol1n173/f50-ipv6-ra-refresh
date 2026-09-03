//<script>
(function () {
    let count_down = 100
    let interval = null
    const toolBox = document.createElement('div');
    toolBox.innerHTML = `
            <div class="modal" id="pluginToolsModal" style="width: 77%;max-width: 500px;display: none;z-index: 99999999;">
                <div class="title">插件收纳箱 <span class="countDown" style="font-size:.64rem;opacity:.8"></span></div>
                <style>
                .kano_cjsnx {
                    display: grid;
                    grid-template-columns: repeat(4, 1fr); /* PC 默认 4 列 */
                    max-height: 350px;
                    padding: 10px 0px 10px 0px;
                    gap: 10px;
                }
                .kano_cjsnx button {
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                @media (max-width: 360px) {
                    .kano_cjsnx {
                        grid-template-columns: repeat(1, 1fr);
                    }
                }
                @media (min-width: 361px) and (max-width: 480px) {
                    .kano_cjsnx {
                        grid-template-columns: repeat(2, 1fr);
                    }
                }
                @media (min-width: 481px) and (max-width: 767px) {
                    .kano_cjsnx {
                        grid-template-columns: repeat(3, 1fr);
                    }
                }
                @media (min-width: 768px) {
                    .kano_cjsnx {
                        grid-template-columns: repeat(4, 1fr);
                    }
                }</style>
                <div class="content kano_cjsnx">
                </div>
                <div class="btn" style="text-align: right;">
                    <button onclick="closeModal('#pluginToolsModal')">关闭</button>
                </div>
            </div>
        `;

    const menuSection = document.body;
    menuSection.appendChild(toolBox);

    const resetInterval = () => {
        interval && interval()
        count_down = 100
        let el = document.querySelector("#pluginToolsModal .countDown")
        if (el) {
            el.textContent = ``
        }
    }

    const btn = document.createElement("button")
    btn.innerHTML = "插件收纳箱"
    btn.onclick = () => {
        resetInterval()
        showModal("#pluginToolsModal")
    }
    document.querySelector(".functions-container .actions-buttons").appendChild(btn)
    const countDownEl = document.querySelector("#pluginToolsModal .countDown")

    document.querySelector('#pluginToolsModal .content').onclick = (e) => {
        const target = e.target;
        if (target == e.currentTarget) return;
        resetInterval()
        interval = requestInterval(() => {
            count_down--
            if (count_down <= 0) {
                count_down = 10
                if (countDownEl) {
                    countDownEl.textContent = ``
                }
                closeModal('#pluginToolsModal');
                resetInterval()
            } else {
                if (countDownEl) {
                    countDownEl.textContent = `自动关闭：${count_down}S`
                }
            }
        }, 1000)
    }


    // 重定向按钮添加到正确容器
    const originalAppendChild = HTMLElement.prototype.appendChild;
    HTMLElement.prototype.appendChild = function (element) {
        if (this === collapseBtn_menu?.nextElementSibling?.querySelector('.collapse_box') &&
            element.tagName === 'BUTTON') {
            return document.querySelector('#pluginToolsModal .content').appendChild(element);
        }
        return originalAppendChild.call(this, element);
    };


    const originalCloseModal = closeModal;
    //检测到插件有唤起modal时，关闭收纳箱modal
    closeModal = (...args) => {
        let res = originalCloseModal(...args);
        if (args[0] !== '#pluginToolsModal') {
            resetInterval()
        }
        return res
    }

    const HOOK_SKIP = new Set(['#pluginToolsModal', '#PluginModal', '#plugin_store']);

    (function hookShowModalOnce() {
        if (showModal.__hooked__) return;
        const original = showModal;

        showModal = function (...args) {
            const target = args[0];
            if (!HOOK_SKIP.has(target)) {
                resetInterval();
                closeModal('#pluginToolsModal');
            }
            return original.apply(this, args);
        };

        showModal.__hooked__ = true;
    })();
})();
//</script >
