# LeRobot 101 OS · Classroom

台大「虛擬人與遙現」2026 第九週：**右手臂 → SO-101 Follower**。

這是從教師 LeRobot-101-OS 的前端建立的乾淨公開課堂衍生版；不是私人 repo 的歷史鏡像。使用真正的 SO-101 URDF/STL。橘色是命令目標，藍色是模擬回應；選配 USB 後，藍色改顯示馬達回報位置。此 3D 視圖是運動學視覺化，不是碰撞／力學模擬。

## 本機啟動

```sh
python3 scripts/setup_assets.py
python3 server.py --port 8100
```

用桌面 Chrome 開啟 http://127.0.0.1:8100 。首次下載約 60 MB 的固定版本 MediaPipe WASM/模型，逐檔驗 SHA-256；之後可離線使用。不需雲端 API Key。只有測試工具需要 Node.js。

1. 按「合成範例」，確認顯示與停止。這不是錄影。
2. 「開啟攝影機」後，讓雙肩、髖部、右手肘、右手腕入鏡。橘色標記必須在**你的右手**。
3. 按「接手／繼續」。需要對齊起始手勢時，可按「以目前手勢為基準」；這只改人體映射，不動馬達校正。
4. 用「單軸」按鈕逐一觀察方向，再按接手。停止會清掉待送命令；分頁進背景也會停止。
5. 0 / 150 / 400 ms 延遲、抖動與丟包供**模擬實驗**。實體控制啟用時，這些人工網路干擾會關閉。

## USB：沿用已存在的校正，不重新校正

標準 SO-101 Follower：六顆 **Feetech STS3215，ID 1–6，1 Mbps，位置控制模式**。使用 Web Serial，而不是 Ledger 常用的 WebHID。桌面 Chrome／Edge 在 HTTPS 或 localhost 可用；Safari／Firefox 不提供這條路線。機械手臂仍需要合適的外接電源；USB 不是馬達電源。

1. 關閉其他佔用同一 USB 序列埠的程式。
2. 按「選擇 USB／讀取手臂」，在瀏覽器選取 **Follower 的匯流排轉接器**。本專案不靠電壓猜 Leader/Follower，也不會自動選取裝置。
3. 此時**完全唯讀**：讀型號、ID、位置模式、Homing Offset、Min/Max Position Limit 與目前位置，不寫 EEPROM、不改 ID、不改鮑率。
4. 若已有有效校正，直接沿用。標準 LeRobot 的馬達 EEPROM 含 offset 與行程，但不是一份完整 JSON 檔；`drive_mode` 反向資訊可能只存在電腦 JSON。
5. 若曾使用軟體反向，可匯入自己的既有 LeRobot `MotorCalibration` JSON。只有 ID、offset、min/max **全部與當前硬體一致**才接受；不會把不相符的檔案寫回馬達。檔案留在瀏覽器記憶體，不上傳。
6. 比對藍色模型與實體姿勢，確認是 Follower，再勾選確認、按「啟用實體控制」。先將 Goal Position 設為**實際量測的位置**，再開扭力。最後按「接手／繼續」。
7. 若校正仍是出廠全行程、ID/型號不符、位置超出校正範圍，維持唯讀。不要填入假校正去繞過檢查。

**測試狀態：Web Serial 封包與失效處理已用模擬匯流排測試；此版發佈時沒有接實體 SO-101，因此尚未完成 USB 驅動及六軸實機驗證。** 不能把程式測試通過稱為實機驗收。第一次請以固定底座、無負載、小角度逐軸確認。

停止會鎖住控制狀態，嘗試把目標設為目前量測姿勢；不會直接關扭力使手臂掉落。背景分頁、輸入逾時、USB 錯誤不會自動重新啟用。每筆命令最多領先量測位置 4°，軟體限速 20°/s，並套用 EEPROM 行程內縮限制。USB 拔除／瀏覽器當機時無法保證再送停止命令，這不是硬體急停或安全認證系統；保留可立即斷電的實體操作方式。

## 這一版修正了什麼座標問題

- 使用 MediaPipe **world landmarks（公尺）**，不再混合不同影像寬高尺度的 normalized x/y/z。
- 由雙肩與髖部建立人的右、上、前座標，避免身體平移、遠近或畫面傾斜直接變成馬達角度。
- SO-101 的正 `elbow_flex` 會壓低前臂，因此人的手肘彎起要**減少**機器人的角度。先前符號已修正。
- 右手掌用「最靠近右手腕」關聯，避免左右手分類錯時控制到另一隻手；手掌消失時保持手腕與夾爪。
- 攝影機預覽的 CSS 鏡像不會修改辨識資料。
- 人臂的自由度與 SO-101 不同，這是具明確規則的 **retargeting**，不是每個人體關節直接接到同名馬達，也不是完整 IK。

### 角度契約

視圖和硬體 adapter 共用 `so101_new_calib` 的半圈歸中座標：`q = (Present_Position − 2047) × 360 / 4096`。韌體已套用 Homing Offset，**不能再減一次**。這個 q 不是 LeRobot 以行程中點計算的 `DEGREES`，也不是 `[-100,100]` 正規化值。夾爪在此為 URDF 角度，不是百分比。匯入 JSON 的 `drive_mode` 會在軟體正反轉；若你的硬體不是這套標準歸中方式，保持唯讀，使用自己的 adapter。

## 程式與測試

- `web/control-core.js`：純映射、時序、限速、HOLD。
- `web/vision.js`：本機影像辨識與右手關聯。
- `web/feetech-serial.js`：協定封包、校驗、唯讀探測、校正復用與有限步進。
- `web/hardware-ui.js`：可選 USB 連線與人工啟用。
- `web/viewer3d.js`：同一 Follower URDF 的目標／量測視圖。
- `os.html?devmock=1`：原 OS 教學介面，強制 mock。其訓練、雲端等舊介面不是已接通的服務。

```sh
node --test tests/*.test.mjs
python3 scripts/audit_public.py
```

27 個測試涵蓋人體座標、符號、封包碎片、checksum、逾時後不誤收舊回覆、出廠校正拒絕、讀取不寫入、停止競態、限速與起始姿勢。測試結果不能替代實體碰撞或負載測試。

## 隱私與授權

影片只在瀏覽器辨識；不開麥克風，不上傳關鍵點。USB 權限由瀏覽器授予當前來源；校正 JSON 不儲存到 repo。匯出僅時間、角度、狀態。不要 commit `.env`、校正檔、錄影、設備序號或帳號資料。

來源與授權見 `NOTICE`、`LICENSES/`、`SECURITY.md`。

- [LeRobot SO-101 官方說明](https://huggingface.co/docs/lerobot/so101)
- [Feetech 校正讀取實作](https://github.com/huggingface/lerobot/blob/v0.4.4/src/lerobot/motors/feetech/feetech.py)
- [Feetech 官方 Python 協定](https://github.com/ftservo/FTServo_Python)
- [Chrome Web Serial](https://developer.chrome.com/docs/capabilities/serial)

### 追蹤離開畫面

畫面邊界會額外檢查，不能只相信模型的 visibility。整隻手臂看不到就保持，回到框內連續三幀穩定後，模擬器以平滑和限速接續；只有手掌看不到時，肩肘繼續，手腕與夾爪保持。實體控制失去有效輸入後鎖住 HOLD，必須明確重新啟用，避免重新入鏡突然動作。


### OS 滑桿、錄製與回放（第九週 v2）

開啟 `http://127.0.0.1:8100/os.html?devmock=1`，按「開始」並等待自動模擬校準完成。這是純前端教學流程，不會搜尋或驅動 USB。

1. 進「③ 遙操作」，展開左下「模擬人手」，選 **Leader**。拖動滑桿會接管自動示範，Follower 平順跟隨。
2. 在③按「停止」，再進「④ 錄製」。錄製按鈕只在 idle 可用。
3. 填名稱、任務描述，按「開始錄製」。用 Leader 滑桿做 3–5 秒動作，再按「存這集」。可丟棄不滿意的一集。
4. 按「完成收檔」，進「⑤ 回放」，選集數（0 是第一集），按「播放」並確認。
5. 回放使用本次記錄的關節與時間，先接到起始姿勢；停止或完成後保持姿勢。

這裡只在分頁記憶體保存關節軌跡，**重新整理會清空**；單集最長兩分鐘。它不是包含影像的 LeRobotDataset，也沒有接上「智慧／雲端訓練」服務。請用螢幕錄影保留課堂成果。正式資料蒐集需使用完整本機後端或官方 LeRobot 工具。

v2 修正自動動作覆蓋滑桿、回放使用示意正弦而非儲存軌跡的問題；新增三項行為測試，總共 30 項通過。
