# Local Candidate Import：显式、可恢复的本地交付

> 状态：v0.11.39 已实现。它仅落地一份已经审核的本地交付包；不下载、不覆盖、不启用也不执行。

`craft_wiki_candidate_local_import` 只接收处于 `prepared` 状态、明确要求人工导入且没有执行权的 Publication Package。操作者必须提供 `confirmed: true`、评审者身份、目标根目录和根目录内的相对 Markdown 路径。

导入会拒绝路径逃逸、非 Markdown 文件和已有文件，并用独占创建写入内容；因此不会静默覆盖宿主 Skill、配置或用户文件。写入完成后，Craft 保存 Package 精确版本、内容摘要、目标路径和评审者的 Import Receipt，且固定 `enabled: false`、`execution_authority: false`。

```text
Reviewed portable package
       │ explicit human confirmation
       ▼
descendant-only one-file write ──> Local Import Receipt
                                      │
                                      └── enabled: false; no Host execution
```

宿主如何发现、启用或授权该文件仍是独立动作；未来 Adapter 必须另行记录启用与执行证据，不能把“文件已写入”冒充为“能力已安全安装”。
