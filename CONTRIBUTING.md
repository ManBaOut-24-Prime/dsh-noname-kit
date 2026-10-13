# 提交前人工检查

私人 AI 交流、交接、工作用技术摘要、审计记录和本地测试资料统一存放在仓库外的专用 `ai-records/` 目录，不提交到插件仓库。公开提交说明只描述客观技术变更。

先查看工作区，再按明确路径暂存本次修改：

```sh
git status --short
git add -- <本次修改的文件路径>
git diff --cached --name-status
git diff --cached --stat
git diff --cached --check
git diff --cached
```

逐个确认暂存文件属于本次变更，没有私人记录、凭据、本机路径或临时产物；图片等二进制文件需要人工打开核对。确认提交说明不包含私人交流或审计过程，再使用普通 `git commit` 提交，并检查 `git show --stat --oneline HEAD`。

发现误暂存时，使用 `git restore --staged -- <文件路径>` 取消暂存，工作区文件会保留。可用 `git check-ignore -v -- <文件路径>` 查询忽略规则；`.gitignore` 不影响已经跟踪的文件，不能替代逐项审核，也不要用 `git add -f` 绕过私人资料排除规则。

产品构建、测试和安全检查仍按变更范围执行；历史重写、远端更新及高风险测试需要单独授权。
