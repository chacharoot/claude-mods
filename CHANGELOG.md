# Changelog

## agent-zoo 0.3.1
- 小機器人縮小：預設 10×5 格（原本 18×9），眼睛和嘴巴有小尺寸專用的畫法；旁邊的文字精簡成 5 行，一個畫面放得下更多 agent。
- `/agent-zoo big` 換回原本的大隻，`/agent-zoo small` 換回小的，選擇會記住。

## agent-zoo 0.3.0、todo-history 0.1.0

### agent-zoo
- **看 agent 的即時進度**：點「▸ 看進度」展開那個 agent 的任務、說的話、工具呼叫和結果，執行中每秒更新；「主畫面看完整對話」把主畫面切到它的完整 transcript。
- **清單模式**（`l` 或 `/agent-zoo compact`）：一個 agent 一行，依誰叫起誰縮排成樹，agent teams 依團隊分組。
- **Agent teams**：teammate 一輪做完顯示 waiting、收到訊息再變回 running，不會被當成 done；顯示 teammate 的名字。重新載入後會從 `agent.list` 把還在跑的 agent 補回來。

### todo-history（新）
- 記錄 todo 和 task 的每一步，主對話、sub-agent、共用 task 清單分開記。
- 回到任一步：只還原清單，或連同之後用 Edit／Write 改過的檔案一起還原；還原後下一則訊息會告訴 Claude。

## 0.2.2

### session-manager
- **顯示剩餘額度**：標題區下方每個額度（5 小時、7 天）一行，顯示剩下的百分比、進度條，以及多久後重置；剩不到 50% 變黃、不到 20% 變紅。數字跟 status line 同一個來源，每次回應後更新。不是訂閱帳號時不會有額度數據。

## 0.2.1

### session-manager
- **Windows 不用裝 Python**：找不到可用的 Python 時（常見的是只有 Microsoft Store 的捷徑），改用 PowerShell 版的 scanner（`hooks/scanner.ps1`）。列表、搜尋、改名、刪除、Resume、新增、瀏覽都能用。
- **修正**：「開始」「瀏覽…」「Resume」「改名」「刪除」失敗時不再沒有反應，狀態列會顯示原因。
- **修正**：新 session 的資料夾欄位不再自動搶走鍵盤焦點，`s` 開始、`b` 瀏覽、`q` 取消可以直接按；要打字時用 Tab 或點欄位。
- 「瀏覽…」的資料夾視窗固定在最上層，不會開在終端機後面。

## 0.2.0

### session-manager
- **Windows 支援**：Windows Terminal 新分頁 resume／新增、資源回收筒、資料夾選擇視窗、PowerShell 複製指令；Python 依序試 `python3`、`python`、`py -3`。
- **修正**：檢查 session 是否開著的方式在 Windows 上會終止該程序（`os.kill(pid, 0)`），改用 `OpenProcess` 查詢。**Windows 使用者請務必更新。**
- 排版重做：有框的標題區、每個資料夾一個框、欄位對齊、卡片改成欄位表格。
- 輸出一律 ASCII，不受 Windows 主控台編碼影響。

### agent-zoo
- 小人改成有光影的 3D 像素機器人（18×18，半格方塊），顏色代表類型，表情代表狀態。
- **修正**：已完成的 agent 收到晚到的工具事件時，不再被改回執行中。
- 執行中的 agent 排在前面，超出畫面顯示 `+N more`；超過 60 秒沒動作會標示可能卡住。
- 降低重繪頻率：狀態沒變就不寫入，`agent.list` 每 2 秒查一次。

## 0.1.0
- 第一版。
