你的任务是在当前目录已有插件的基础上，写一个新的“xxx插件”。

目标：
1. 插件功能是“xxxxxx”。
2. 插件需要支持以下核心能力：
   - xxxx
   - xxxxxxx
   - xxxxxxxxxxxx
   - xxxxxxxxxxxxxxx
3. 插件的 UI 布局、交互方式、整体代码风格，请优先参考当前目录下的 `插件示例`
4. 插件核心实现逻辑，请参考当前目录下的 `xxxxx`

补充要求：
> `utils.js` 中的函数是全局注册的，不需要导入，也不要重复造轮子
> 跑 Shell 命令请使用 `runShellWithRoot` 异步函数
> 如果需要回显文件内容，请勿使用 `cat`，请使用 `timeout 2s awk`