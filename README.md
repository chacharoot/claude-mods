# claude-mods

Claude Code 的三個 mod（hooks-module plugin），都會在對話旁邊開一個常駐 panel。

## session-manager

列出這台機器上所有的 Claude Code session，依資料夾分組，可以用滑鼠點選。

- 搜尋：打字即時篩選 title／資料夾／prompt，按 Enter 搜所有對話內文
- 點一個 session 展開詳細資料：
  - 已開著的 → **跳過去**（Terminal、iTerm 會直接切到那個分頁；Warp 只能叫出 app）
  - 已關閉的 → **Resume**，在新視窗開（Warp／iTerm／Terminal，按 `a` 切換）
  - **改名**（寫入跟 `/rename` 一樣的記錄）、**複製指令**、**刪除**（移到垃圾桶，可救回）
- **+ 新增**：選資料夾開新 session
- 標題區下方顯示剩餘額度（5 小時、7 天）和多久後重置
- 指令：`/sessions`

需求：Python 3（用來讀超過 4MB 的 transcript；依序試 `python3`、`python`、`py -3`）。Windows 沒有 Python 時改用內建的 PowerShell 跑同樣的功能，不用另外安裝。

| | macOS | Windows |
| --- | --- | --- |
| 列表、搜尋、改名 | ✓ | ✓ |
| Resume／新增 | Warp、iTerm、Terminal | Windows Terminal 新分頁（沒有 `wt` 時開 cmd 視窗） |
| 跳到已開著的 session | Terminal、iTerm 直接切分頁；Warp 只叫出 app | 只提示它在哪（Windows Terminal 不讓外部選分頁） |
| 刪除 | 移到垃圾桶 | 移到資源回收筒 |
| 複製指令 | shell 語法 | PowerShell 語法 |

## agent-zoo

每個 sub-agent 都是一顆有光影的 3D 小機器人（終端機半格像素，Windows Terminal、Warp、iTerm 都能顯示），顏色代表類型：執行中會跳、眼睛左右看，等待時閉眼，完成時笑，失敗時打叉。旁邊顯示類型、跑了多久、用了幾次工具、現在在做什麼；超過 60 秒沒動靜會標 idle。

**點「▸ 看進度」**（清單模式點一整列）展開那個 agent 的即時進度：它收到的任務、說了什麼、呼叫了哪些工具和結果，跑的時候會自己更新；**主畫面看完整對話**直接把主畫面切到它的完整 transcript。按 `l` 切換成**清單模式**：一個 agent 一行、依「誰叫起誰」縮排成樹，agent teams 的 teammate 依團隊分組，agent 多的時候也放得下。Teammate 一輪做完會顯示 waiting（等下一則訊息），不會被當成 done。

小機器人預設是 10×5 格；想要原本 18×9 的大隻，用 `/agent-zoo big`（`/agent-zoo small` 換回來，會記住）。

指令：`/agent-zoo` 打開 panel，`/agent-zoo compact` 切換清單模式，`/agent-zoo big`／`small` 切換機器人大小，`/agent-zoo clear` 清掉已完成的。

## todo-history

Claude 的 todo（`TodoWrite`）和 task（`TaskCreate`／`TaskUpdate`）每變一次就記一步，主對話、各個 sub-agent、共用 task 清單分開記。panel 上方是現在的清單，下面是歷程：`▶ 開始`、`✓ 完成`、`+ 新增`、`− 移除`。

點任一步展開：那時候的清單，以及**之後被改過的檔案**。可以：

- **只還原清單**：清單回到那一步。
- **清單＋檔案一起還原**：清單回到那一步，之後用 Edit／Write 改過的檔案也還原成那時的內容（那之後才新增的檔案會刪掉）。要撤銷一個 task，就回到它「▶ 開始」那一步。

還原前會先列出要動的檔案讓你確認；還原後，你下一則訊息會自動告訴 Claude 現在的清單和哪些檔案被還原。用 Bash／PowerShell 改的檔案不會被記錄。歷程和檔案備份存在 `~/.claude/todo-history/<session id>/`。

指令：`/todos` 打開 panel，`/todos clear` 清掉這個 session 的歷程。

## 安裝

這是 private repo：你要先被邀請進這個 repo，而且電腦上的 git 要能讀 github.com（SSH key，或 `gh auth login` 後再 `gh auth setup-git`），安裝時不會詢問帳密。

在 Claude Code 的輸入框：

```
/plugin install session-manager --marketplace chacharoot/claude-mods
/plugin install agent-zoo --marketplace chacharoot/claude-mods
/plugin install todo-history --marketplace chacharoot/claude-mods
```

第一次會問 `Add marketplace?`，按 `y`；再選 scope，直接 Enter 選 user。裝好就會在這個 session 生效，之後每個新 session 都會載入。

從 shell 安裝：

```
claude plugin install session-manager --marketplace chacharoot/claude-mods
claude plugin install agent-zoo --marketplace chacharoot/claude-mods
claude plugin install todo-history --marketplace chacharoot/claude-mods
```

Desktop app 裡 `/plugin` 不能用：點輸入框旁的 **+** → **Plugins** → **Add marketplace** 填 `chacharoot/claude-mods` → **Add plugin**。

## 更新

```
claude plugin update session-manager@claude-mods
claude plugin update agent-zoo@claude-mods
claude plugin update todo-history@claude-mods
```

再在 Claude Code 裡打 `/reload-plugins`。改了什麼見 [CHANGELOG.md](CHANGELOG.md)。
