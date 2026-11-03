# LeRobot 101 OS · Classroom

**台大「虛擬人與遙現」2026 第九週：不用實體手臂，也能學 Leader / Follower。**

這是 [dAAAb/LeRobot-101-OS](https://github.com/dAAAb/LeRobot-101-OS) 的公開課堂衍生版。保留雙臂 URDF 檢視器與原版模擬流程，增加 **webcam → 右手臂／手掌 → SO-101 關節** 的實驗入口。

上游為私人專案，本版採**獨立、乾淨 Git 歷史**，只帶入必要的前端與開源模型，不帶入原始歷史、硬體連接後端、校正檔、內網位址、訓練帳號或錄影。因此不是 GitHub 原生 fork 關係；同學可以直接 fork 這個公開 repo。

## 啟動（不用硬體、不用 API Key）

需要 Python 3.10+、近期 Chrome／Chromium 與 WebGL。Mac、Windows、Linux 都可使用瀏覽器版；目前實測環境為 Apple Silicon Mac + Chrome。

```sh
python3 scripts/setup_assets.py
python3 server.py
```

Windows 可將 `python3` 改成 `python`。開啟終端機顯示的 `http://127.0.0.1:8099`。
第一次下載約 60 MB 的固定版本 MediaPipe Tasks Vision 1.2.0 WASM 與官方 face/pose/hand 模型；每個檔案以 SHA-256 驗證。下載完成後，不需雲端推論，斷網也可使用。Python 的網路伺服器只用標準函式庫。

1. 按 **合成範例**：先確認顯示、映射與停止功能。這是人工座標，不是真人影像。
2. 按 **開啟攝影機**，允許本機網站使用相機。此時仍是 STOP。
3. 確認橘色標記在自己的右手腕；讓肩膀、手肘和手腕入鏡。光線足、背景單純時較穩定。
4. 按 **接手／繼續**。畫面看不到手、信心不足或相機中斷時，不產生新手部目標。
5. 按 **停止（Space）** 清掉所有排程；再次接手才恢復。切到背景分頁也會停止。
6. 結束請按 **關閉鏡頭**，或關閉分頁；終端機 Ctrl+C 關閉伺服器。

如果不開鏡頭，手動滑桿與合成範例都不需先下載辨識模型。模型下載不是啟動伺服器的必要條件。

## 延遲實驗（8–10 分鐘）

固定同一個手勢，依序比較 0 / 150 / 400 ms 指令延遲，再加 ±100 ms 抖動或 20% 丟包。觀察目標、Follower 與自己的動作是否同步。選 100% 丟包，確認 HOLD；按停止，確認之前排隊的命令不會在稍後突然出現。

記錄三件事：主觀難度、命令年齡、停止是否可靠。畫面上的「命令年齡」從本機送出目標起算，**不等於完整攝影機到馬達延遲**；也不包含實體視訊回傳。辨識耗時只量測當次 MediaPipe 呼叫。

匯出紀錄只含相對時間、模式、狀態、目標套用角度與命令年齡，最多保留 6,000 筆。沒有影像、聲音、姓名或人體關鍵點。

## 控制迴路

```text
Camera → MediaPipe landmarks → retarget / normalize
       → confidence gate → bounded target → delayed channel
       → timestamp ordering → rate limit + EMA → simulated body
                                                    ↓
                                    visible feedback to human
```

角度使用 degree；實際渲染／IK 邊界才換成 radian。EMA 時間常數 90 ms、前端速度上限 120°/s，命令超過 350 ms 沒有到達就 HOLD（保持姿勢）。這些是課堂實驗值，不是硬體安全規格。若改接實體機器人，需要重新設計硬體急停、制動、碰撞、限位與 watchdog；本版本沒有這種連線功能。

## 程式入口

- `web/control-core.js`：可單獨測試的映射與控制器。
- `web/vision.js`：本機 MediaPipe；相機資料不離開瀏覽器。
- `web/lab.js`：輸入來源、畫面、延遲實驗與本機紀錄。
- `server.py`：只服務 `web/`；不提供檔案上傳或任意檔案讀取。
- `assets-manifest.json`：下載來源、版本、大小、SHA-256。

```sh
node --test tests/*.test.mjs
```

測試涵蓋左右映射、失去關鍵點、NaN、角度與速度上限、封包亂序、逾時、停止後不重播舊命令。人工座標測試不代表所有真人、相機或姿勢都辨識可靠。

## 隱私與公開範圍

本專案沒有 API Key、登入、遙測、雲端影像上傳、實體機器人探索，也不讀取任何個人設定。相機只開 video，不開麥克風。安裝時的模型下載會連到 Google 與 jsDelivr；執行時的應用資源都來自 localhost。不要把伺服器公開到網際網路，也不要用 tunnel 直接暴露；本版沒有帳號權限層。

請勿把 `.env`、錄影、個人相機畫面、校正檔或帳號資料 commit 上來。`SECURITY.md` 說明公開前的檢查方式。原始範例與第三方授權見 `NOTICE`、`LICENSES/`。

## 手臂如何對應

| 人體觀測 | SO-101 目標 |
|---|---|
| 右肩到右肘的水平分量 | shoulder_pan（±80°） |
| 右上臂抬起方向 | shoulder_lift（±80°） |
| 肩–肘–腕夾角 | elbow_flex（±90°） |
| 前臂與手掌延伸方向 | wrist_flex（±80°） |
| 掌根橫向的傾斜 | wrist_roll（±120°） |
| 拇指–食指距離 / 掌寬 | gripper（0–80°） |

**這是比例映射／retargeting，不是人體與機械手臂一對一的解剖等價，也不是末端位置 IK。** 單眼深度、手腕轉向和遮擋都有歧義。橘色 Leader 模型顯示未經延遲通道的目標，藍色 Follower 顯示延遲、平滑、限速後的命令；兩個 URDF 的夾具外形不同。渲染器另有視覺插值，因此畫面還有少量顯示延遲。

手掌先依 Right 標記選擇，再以到右手腕的空間距離優先配對；請在啟動時檢查橘色右腕標記。手掌消失但手臂仍在時，腕部回到教學預設角度，夾爪回到 40°；整條右臂消失則 HOLD。這種缺失資料策略適用於本課模擬，**不可直接套用到夾持物品的實機**。

## 原版 OS 模擬流程

頁底「開啟原版 OS 模擬流程」會開啟 `os.html?devmock=1`，體驗連線、校正、滑桿與示範資料流程。此公開版強制 `DEVMOCK=true`，移除實體後端；原介面中的訓練／雲端控制項沒有真實服務可用。不要將它當成實機控制面板。

同時開啟 Reachy 專案時，請用不同 port：

```sh
python3 server.py --port 8100
```

本頁是 Three.js 的運動學視覺化，**不含碰撞、重力、力矩或抓取物理**。URDF 無法載入時會標示 2D 備援；不應把備援當成真實模型驗證。

## 同學可改的實驗

1. 比較關節直接映射與「手掌位置 → 末端 IK」。
2. 將握拳設為 clutch（離合），放開手時凍結目標。
3. 增加左右手選擇、每位使用者的校正與量測誤差。
4. 保存合成示範角度，將同一串動作送進不同模擬器比較。

## 來源與授權

- 教師原始 UI：[dAAAb/LeRobot-101-OS](https://github.com/dAAAb/LeRobot-101-OS)（原始 repo 權限可能受限）。
- 機械模型：[TheRobotStudio/SO-ARM100](https://github.com/TheRobotStudio/SO-ARM100)（SO-101 在此 repo；Apache-2.0）。
- [LeRobot](https://github.com/huggingface/lerobot) 與 [官方 SO-101 文件](https://huggingface.co/docs/lerobot/so101)。
- Three.js、urdf-loader：MIT；MediaPipe Tasks：Apache-2.0。

本專案不是 Hugging Face 或 The Robot Studio 官方發行版本。
