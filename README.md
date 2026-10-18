# BitoPro 反向委託流程診斷版

此版本支援由 `.env` 控制自動策略模式。`LIVE_TRADING=false` 時只預覽反向委託；`LIVE_TRADING=true` 且 API 憑證有效時，完整成交後會嘗試向 BitoPro 建立反向限價委託。實際接受與否以交易所回應及掛單列表為準。

## 執行
1. 安裝 Node.js 18 或更新版本。
2. 在此資料夾執行 `npm install`。
3. 複製 `.env.example` 為 `.env`。不要把真實 API 金鑰放進壓縮檔或傳給他人。
4. 執行 `npm start`，開啟 `http://localhost:3000`。

## 這版針對反向委託做了什麼
- 完整成交後計算反向方向與目標價格。
- 將 `amount`、`price` 明確整理成字串，記錄預期的 `POST /v3/orders/{pair}` body。
- 記錄結果明確標示 `dry_run`，不會誤報為交易所已接受委託。
- `LIVE_TRADING` 從 `.env` 讀取，不再在程式內固定為 `false`。設定為 `true` 會啟用自動反向委託；設定為 `false` 則只記錄預覽。

## 限制
這是診斷版本，不會建立實盤反向委託。`requestPreview` 只供檢查格式，不能視為交易所回應或成功掛單。需另以官方 API 文件和不會產生真實交易的方式驗證簽章與請求格式。


## 交易所真實掛單管理

此版本新增「交易所真實掛單管理」：讀取 BitoPro 真實未成交掛單、手動建立限價單、撤銷掛單，以及以「撤銷舊單後建立新單」方式修改價格/數量。按下確認後會呼叫真實 API，請先確認交易對、方向、價格、數量及 API 權限。

`.env` 必須設定 `BITOPRO_API_KEY`、`BITOPRO_API_SECRET`、`BITOPRO_EMAIL`。API Key 需具備讀取、交易、撤單權限。此區是真實交易所操作；自動策略是否送出反向委託由 `.env` 的 `LIVE_TRADING` 控制。設為 `true` 前，請先核對交易對、價差、下單數量、帳戶餘額與 API 權限。

修改掛單不是交易所原子修改：程式先撤銷舊單，再建立新單；若建立新單失敗，舊單仍可能已撤銷。撤單及建立結果均應以交易所掛單列表為準。


## 成交紀錄與 BITO/TWD 行情

- 啟動時使用私人 API `GET /v3/orders/trades/{pair}` 補登歷史成交，依成交 ID 去重並寫入 `data/journal.json`。
- 即時成交使用 BitoPro User Trade Stream；每筆新成交只請求一次 BITO/TWD ticker，並保存成交數量、手續費、手續費幣別、BITO/TWD 價格與台幣成本。
- 歷史補登不會把目前的 BITO/TWD 價格錯配到過去成交，也不會觸發反向下單。
- 已移除 BITO/TWD 每 5 秒定時取價；前端使用 WebSocket 接收更新，不再每 5 秒輪詢 `/api/state`。


### 歷史成交自動回補
服務啟動後會自動執行一次唯讀的當日成交回補，不必先啟動 Bot。請查看「即時事件」確認回補成功或 API 錯誤訊息。API 憑證必須有讀取委託/成交紀錄的權限。

### 每筆成交依成交時間查 BITO/TWD
- 每筆 `filled_trade` 會優先使用交易所實際成交時間，查詢 BitoPro 公開 `GET /v3/trading-history/bito_twd` 的 1 分鐘 OHLC 歷史 K 線。
- 手續費台幣成本以該筆成交所在分鐘 K 線的 `close` 計算；這是分鐘級歷史報價，不是逐秒逐筆成交價。若 API 查不到，不會套用目前行情或其他成交價格，會保留待補。
- 啟動時歷史成交回補會重新檢查已有的 `filled_trade`；只有原本缺價格／台幣成本的紀錄會補上，已存在的價格與成本會保留。
