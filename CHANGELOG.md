# Changelog

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
