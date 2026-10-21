# claude-mods

Claude Code 的兩個 mod（hooks-module plugin），都會在對話旁邊開一個常駐 panel。

## session-manager

列出這台機器上所有的 Claude Code session，依資料夾分組，可以用滑鼠點選。

- 搜尋：打字即時篩選 title／資料夾／prompt，按 Enter 搜所有對話內文
- 點一個 session 展開詳細資料：
  - 已開著的 → **跳過去**（Terminal、iTerm 會直接切到那個分頁；Warp 只能叫出 app）
  - 已關閉的 → **Resume**，在新視窗開（Warp／iTerm／Terminal，按 `a` 切換）
  - **改名**（寫入跟 `/rename` 一樣的記錄）、**複製指令**、**刪除**（移到垃圾桶，可救回）
- **+ 新增**：選資料夾開新 session
- 指令：`/sessions`

需求：macOS、系統內建的 `python3`（用來讀超過 4MB 的 transcript）。

## agent-zoo

每個 sub-agent 都是一隻會動的 ASCII 小人：執行中會走動，等待時打瞌睡，完成 `(^_^)b`，失敗 `(x_x)`。旁邊顯示類型、跑了多久、用了幾次工具、現在在做什麼；超過 60 秒沒動靜會標 idle。

指令：`/agent-zoo` 打開 panel，`/agent-zoo clear` 清掉已完成的。

## 安裝

這是 private repo：你要先被邀請進這個 repo，而且電腦上的 git 要能讀 github.com（SSH key，或 `gh auth login` 後再 `gh auth setup-git`），安裝時不會詢問帳密。

在 Claude Code 的輸入框：

```
/plugin install session-manager --marketplace chacharoot/claude-mods
/plugin install agent-zoo --marketplace chacharoot/claude-mods
```

第一次會問 `Add marketplace?`，按 `y`；再選 scope，直接 Enter 選 user。裝好就會在這個 session 生效，之後每個新 session 都會載入。

從 shell 安裝：

```
claude plugin install session-manager --marketplace chacharoot/claude-mods
claude plugin install agent-zoo --marketplace chacharoot/claude-mods
```

Desktop app 裡 `/plugin` 不能用：點輸入框旁的 **+** → **Plugins** → **Add marketplace** 填 `chacharoot/claude-mods` → **Add plugin**。
