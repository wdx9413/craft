# Desktop 与控制能力的当前边界

版本保持 0.12.37。Workbench 是共享 Web 界面，Desktop 是 Tauri 宿主，两者不是替代产品。

## 安装、构建和数据

Workbench/Tauri 展示层现属于同级 `craft-workbench/`，桌面 staging 位于该项目的 `dist/runtime/app`，运行包只复制核心代码与依赖，页面由 Tauri 单独打包。核心 workspace 不含 desktop。这里的 Windows UIA/OCR 自动化仍保留在核心。详见 [展示层拆分说明](presentation-separation.md)。

桌面主界面加载 bundled index，通过 workbench_request 访问子进程返回的固定 loopback 地址；JavaScript 不持有运行时认证 token。桥接只接受固定 HTTP 方法、/api/ 路径和有界请求。外部网页不获得主界面权限。启动超时会终止子进程，日志管道持续消费。

Desktop 不再强制使用另一套数据目录；由 Node 的 CRAFT_DATA_DIR、设置及默认 ~/.craft_data 顺序解析。旧应用目录不会自动迁移或覆盖。

## 已有浏览器能力

内嵌 Webview 目前仍是人工查看窗口，不是完成的 Agent 控制桥。受管浏览器启动目前仍是原有 Windows Edge 实现。

外部 CDP CLI 必须显式指定 --port 和 --target；只连接对应 loopback WebSocket，不选择第一个标签页。导航失败、连接丢失和超时不返回成功；不确定 effect 必须先复核。旧 human_release 参数不是新 Task-bound Host 批准凭证，也不能被当作独立插件执行授权。

新的 adapters/browser-control.ts 是独立 Adapter，不替代旧 CLI 的批准协议，也不自动挂载。它复用固定 loopback target 的 CDP transport，每次复查 target 与主 frame，在命名 isolated world 中生成有界交互元素引用。固定脚本在同一 JavaScript task 内复查 DOM 状态后执行 fill/click/submit；navigate 复核后调用 Page.navigate。不会接受调用方 JavaScript、CSS selector 或 human_release；取消关闭 transport，不自动重连。账本不存输入值、页面正文或 cookies。isolated world 只隔离 JavaScript bookkeeping，不是安全沙箱，也不是站点网络拦截器。

当前只处理主 frame、最多 100 个交互元素，无跨 frame、截图、视觉定位或受管 Chromium 启动产品接口。授权站点的脚本仍能发起网络请求，重定向由终态观察检测并交接，不宣称已经实现全请求级网络阻断。Adapter 必须经 Control Host 使用，不能直接暴露为绕过审批的 MCP 工具。

本机显式烟测：node --experimental-strip-types scripts/smoke/browser-control-live.ts /absolute/path/to/installed/chromium。脚本只启动全新临时 profile 与 loopback 测试页，连接固定 target，用真实 Store 授权链完成观察、fixture 审批、填入和点击，再以独立 DOM 断言验收；结束终止子进程并删除临时数据。不下载浏览器、不读取默认 profile，也不证明审批 UI、原生控制或 Windows 支持。CDP 方法依据 [Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/) 与 [Runtime](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/) 的协议定义。

## 尚未完成的计划项

共享 Control Host、macOS 应用 Adapter、内嵌 Webview 操作桥、视觉动作复验，以及 craft-browser/craft-computer 的六工具独立插件尚未交付。当前外发产品仍是 Knowledge、Memory、Experience、Codebase；不提前发布缺少执行链路的控制插件。

Control Session 协议机制现位于 capability/control-session.ts，不进入默认启动链或改变 Craft 通用内核。Session 固定可信 Host 提供的 Task/Activation/Policy/目标指纹；客户端只有 open、observe、prepare、execute、close，approvalPacket/approve 只交给宿主控制面。控制面读取只存在于内存的不可变动作审阅包，并提交其精确 digest 与认证 principal；工具参数中的 approved/human_release 不构成批准。执行前 CAS 保留 Session，复核最新观察与当前授权；执行前持久化 effect_unknown，执行后由 Adapter 独立再观察，Outcome 仍未验收。

超时与取消传播 AbortSignal；Adapter 必须遵守该取消契约。发生无法确认的 effect、权限漂移或终态观察失败，Session 交接且禁止重放。临时动作正文只保存在有界内存中，失败、撤销或关闭时清除；账本只有摘要与引用。Host 重启后的 prepared 正文不能恢复，更不能从历史摘要重建批准。独立测试使用真实本地 Store 和受控 Adapter，证明协议机制，不证明平台控制或 Host 已可信挂载。

application/control-authority.ts 提供真实账本授权解析器：显式 Host 绑定与 Task contract、Activation Profile、Kit 均需独立允许 external_write；Task 必须启用人工审批，contract 必须要求独立验收，Kit 必须声明 execute.adapter 并通过 Conformance。Host 初始化固定整套记录摘要，每次决策重新读取；项目、版本、状态、关联、依赖或策略漂移立即拒绝。推荐 Profile 本身不是执行权，principal 也不是调用参数凭证，仍需可信 Host 传输认证和逐次动作批准。解析器不挂到默认启动链，不创建权限。共享 Host、审批 UI 和平台 Adapter 仍需接入后验收。

原生 bridge 已有 Rust 单元测试，但必须在有 Rust 工具链的环境编译运行。Windows/macOS 安装、权限、接管和控制闭环需要分别进行真实平台验证。Node 测试、源码契约测试和编译图 smoke 都不能替代这些证据。

## 本轮验证与未满足的门禁

Node 覆盖率门禁由 tests/coverage-gates.json 维护；中立动作绑定、认知写入、页面交互、产物图和导入审计新增行、函数、分支均要求 100%。门禁通过不代表所有修改文件（尤其 app.js、CLI、打包脚本及 Rust）的增量覆盖率均为 100%；不能据此宣布完整计划完成。

已从 staging 复制到独立临时目录，在该目录通过随包 Node 启动编译后的 CLI 和 Workbench 页面，使用独立数据目录；该检查暴露并修复了符号链接安装路径导致 CLI 静默退出的问题。页面读取成功只证明打包运行时启动，不证明 Tauri 安装或应用控制。

分层审计覆盖实际源模块，无导入豁免；type-only 命名导入解析真实符号来源，runtime 导入检查全部再导出求值链。Workbench 与内部 Host 直接消费应用动作表，不依赖 MCP 构造副作用。旧 UI 已退休，项目查询、Memory/Workflow 页面和最新请求归属由独立模块实现；其他复杂编辑器仍保留在 app.js。

模型配置的状态机与保存逻辑已迁入 workbench/model-setup.js：首跑有确定的初始步骤；编辑保留服务地址、协议与环境变量名称；双击不会重复保存，另一向导打开后迟到结果不再切换页面。页面不再收集或将粘贴的 API Key 放入全局状态，只登记模型元数据。

本机没有 Rust 工具链，也没有 Windows 执行环境，因此原生编译和两平台集成尚无通过证据。新增控制插件不进入发布契约；现有四插件可在本地同步、校验，不提交、不推送。
