# Changelog

## session-manager 0.3.1
- **修正（Windows）**：PowerShell 版 scanner 會把「只有一段文字」的訊息丟掉（PowerShell 會把只有一個元素的陣列自動拆開）。結果是：搜尋內文只找得到你說的話、找不到 Claude 的回覆；「預覽對話」把整段對話併成一則；部分 prompt 沒被算到。這個問題從 0.2.1 的 PowerShell 版就存在。

## session-manager 0.3.0
- **預覽對話**：搜尋內文後，每個 session 列出每一處命中（前 20 處，先顯示 5 處），標出是你還是 Claude 說的、什麼時候。點一處就在卡片裡展開它前後的對話，命中的那則標「◀ 命中」、關鍵字標亮；`j`／`k` 換下一處／上一處，`m` 多看幾則，`z` 收起。
- 沒有搜尋時，卡片的「預覽對話」（`p`）顯示這個 session 最後幾則對話，用來分辨長得像的候選。
- Claude 一次回覆中間穿插工具呼叫時，預覽會把它合成一則，對話依「你／Claude」交替顯示。
- Python 和 PowerShell 兩個 scanner 都加了 `context` 模式，`search` 也回傳每一處命中的位置。

## session-manager 0.2.5
- **修正**：和 session-monitor 這類也用 `/sessions` 的 mod 一起裝時，指令撞名會讓 session-manager 整個啟動失敗、panel 不出現。現在一律註冊 `/session-manager`，`/sessions` 只在沒被佔用時才註冊，也不會攔截別人的 `/sessions`。
- panel 分頁標題改成「Session Manager」，跟其他 session 類 mod 分得開。

## todo-history（測試）
- 測試用的 Windows 路徑在 macOS 上會被當成相對路徑，6 個測試失敗；改成兩邊都能跑。程式本身沒有改。

## session-manager 0.2.4
- **修正**：「打開」背景 session 時用了完整的 session id，`claude attach` 只認 8 碼的短 id（`claude agents` 列出的那個），所以會顯示 `No job matching`。現在改用 session 檔裡記的短 id。

## session-manager 0.2.3
- **打開背景 session**：`/fork` 或 `--bg` 開出來的背景 session 沒有自己的視窗，原本按「跳過去」沒反應。現在按鈕顯示「打開」，會在新的 Windows Terminal 分頁執行 `claude attach`，直接進到那個對話；在空白輸入框按 ← 離開，它會繼續在背景。

## todo-history 0.4.0
- **分成兩頁**：「目前清單」（按 `1`）顯示現在的清單和完成進度，點一項可以單獨撤銷；「歷程」（按 `2`）是每一步的紀錄、還原和 agent 事件。
- **輸入框上方常駐一行**：還有工作沒做完時，顯示進行中的 task 和完成數（`▶ 加上飲料區  ✓ 1/3`），全部完成就不顯示。
- 清單被 rewind 清空時會說明原因，並可以一鍵「恢復最後一份清單」。
- 紀錄跟著 session：新 session 從空的開始；`claude -c`／`--resume` 接續舊 session 時，清單和歷程會回來。

## todo-history 0.3.0
- **撤銷單一 task**：點「現在」清單裡的一項，看它進行時改了哪些檔案，按「撤銷這個 task」只還原它的修改，保留其他 task 的成果。之後又被別的工作改過的檔案不硬蓋，改成把這個 task 的 diff 交給 Claude，請它只拿掉那部分。
- **跟著 rewind**：用 Claude Code 的 rewind（按兩下 Esc）回到之前的訊息時，清單會自動回到那時候的樣子，歷程記一筆 `↶ rewind`。只在對話變短而且前面的訊息完全相同時才算，`/compact` 不會被誤認。
- **agent 和 fork 進歷程**：sub-agent、fork 的開始和結果（🤖／⑂）列在主對話的歷程裡。
- 「清單＋檔案一起還原」改名為「整段回到這一步」，和撤銷單一 task 區分。

## todo-history 0.2.1
- **修正**：自帶的 `todo` 工具回傳了物件，Claude Code 只接受文字，呼叫會顯示錯誤（清單其實有記下）。

## todo-history 0.2.0
- **自帶 todo 工具**：Claude Code 沒有提供內建的 `TodoWrite`／`TaskCreate` 時，todo-history 會註冊自己的 `todo` 工具給 Claude 用，用法跟 TodoWrite 一樣；清單由 todo-history 保管，還原時直接套用。

## todo-history 0.1.2
- **修正**：0.1.0 存下的檔案備份沒有步驟編號，0.1.1 會把它們當成「每一步之後」的修改，還原任何一步都會把那些檔案寫回舊內容。現在載入時把它們視為發生在第一步之前，不會被還原。

## todo-history 0.1.1
- **修正**：同時有好幾個 Edit 時，備份檔會撞號，還原時把 A 檔寫成 B 的內容。現在所有寫入排隊進行，備份檔名也不會重複。
- **還原可以反悔**：「清單＋檔案一起還原」前會先記一步「📌 回到 #n 之前的狀態」，並備份要被覆寫的檔案；回到那一步就能撤銷這次還原。
- **修正**：還原期間其他 agent 改的檔案不會被備份。現在只略過還原自己發出的工具呼叫。
- **修正**：修改和某一步發生在同一毫秒時，還原會漏掉那次修改。現在用步驟順序判斷，不看時間。
- **修正**：歷程檔可能同時被寫入而損壞；Windows 上刪除已經不在的檔案會誤報失敗；`//server/share` 路徑會用到 Windows 沒有的 `rm`。

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
