# 可部署的远程组件模板

交付状态：本地 HTTPS 启动、认证拒绝、租户隔离已由测试验证；未上线。Docker 守护进程未运行，因此本轮未构建容器镜像。

1. 将 `config.example.json` 复制为 `config.json`，填入真实 issuer、audience、HTTPS token introspection URL 和 subject 路由。`routes` 的 key 是 `sha256:` 加经认证的 subject 的 SHA-256，value 是服务器控制的租户目录名。空映射会拒绝启动。
2. 配置证书、私钥以及 introspection 服务端认证文件。文件中只放给身份服务使用的完整 Authorization 值。通过 Compose 的必填环境变量指定 secrets 文件与 Node 用户可写的数据目录。
3. 从本目录运行 `docker compose up --build`，或在安装生产依赖的源码仓库运行 `node deploy/components/server.ts /absolute/config.json`。每个实例只开放一个产品，支持 `context`、`knowledge`、`memory`、`experience`、`codebase`。
4. 配置 `CRAFT_REMOTE_URL`、`CRAFT_REMOTE_PRODUCT`、`CRAFT_REMOTE_TOKEN` 后运行 `node deploy/components/acceptance.mjs`；脚本不打印 token/正文。私有 CA 使用受控的 Node CA 配置，不能关闭 TLS 校验。

服务直接终止 TLS，复用 RemoteMcpAccessPolicy 校验 issuer、单一字符串 audience、scope `craft.invoke`、expiry 和请求速率。Introspection 必须返回 active、sub、iss、aud、exp、scope；不同 IdP 的响应格式需在接入时适配，不能把未验证 JWT payload 当 principal。

路由仅使用授权 receipt；请求参数、MCP scope 或客户端自报 tenant 不能选择别人的数据库。对声明身份参数的读取工具，服务端绑定 `principal_id` 为 `sha256(subject)`、`principal_ids` 为该摘要的单元素数组、`tenant_id` 为路由配置值；客户端传入不同值会被明确拒绝。Source/Memory 的私有受众采用同一摘要身份，客户端通常省略这些参数。不同租户独立数据库及内容目录。

**一个租户是一个共同信任的数据空间**：虽然读取策略现在使用真实认证身份，模板仍没有完整的逐用户写入授权与管理员权限模型。不要把多人映射同一租户当作不互信用户间的隔离；个人私密数据应映射到不同租户。这个模板不是完整企业身份平台，也不实现交互式 OAuth 登录发现。

`context` 和 `codebase` 会读取服务端仓库，因此强制一个部署只服务一个租户；多人可以映射到同一个租户。不同租户使用隔离容器及数据卷，仅读挂载属于该租户的仓库，不能用数据库分目录代替文件系统隔离。请求中的仓库路径是容器内路径，服务不会读取客户端电脑。默认 Compose 不挂载任何业务仓库，需要按实际环境增加只读挂载。

默认 Compose 仅绑定本机 8787，使用只读容器文件系统、独立数据卷与 secrets。开放外网入口、配置真实 IdP、备份和轮换证书属于部署环境验收，本次不执行。Node 23+ 必需，模板固定 Node 24。

本机隔离验证：`node --test tests/component-remote-deployment.test.ts tests/remote-mcp-access.test.ts`。验收包含 CLI 启停、HTTPS、匿名/失效/错误 audience/缺 scope/未配置路由拒绝、相同 project scope 的跨租户隔离。真实 IdP、容器和目标客户端仍需部署时测试。
