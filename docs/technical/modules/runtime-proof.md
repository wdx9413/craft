# Runtime Proof

`RuntimeProofKernel` 是执行适配器的统一证明投影：先登记 `manifest`，再记录 `probe`，通过全部边界检查后形成 `conformance`，最后把环境摘要、Profile 版本和有效期绑定到 Run 的 `attestation`。恢复使用 `rehydrate` 比较 Checkpoint 的环境摘要；不一致只返回 `needs_replan`。

它只保存摘要、检查结果和 Evidence 引用，不保存凭据、提示词或业务正文。Windows 没有受验证隔离器时，`adapter_id=none` 会失败关闭；外部 Credential Broker 仍是部署方责任。
