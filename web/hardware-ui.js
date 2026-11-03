import {HardwareFollower,SerialBus,JOINTS} from './feetech-serial.js';
export function mountHardware({stopSimulation,setPose}){
 const panel=document.createElement('section');panel.className='panel controls';
 panel.innerHTML=`<h2>04　USB 實體 Follower（選配）</h2>
 <p>Chrome／Edge 桌面版 · Web Serial · STS3215 / ID 1–6 / 1 Mbps。連線時只讀取，保留馬達內的校正資料。</p>
 <div class="row"><button id="usbConnect">選擇 USB／讀取手臂</button><button id="usbDisconnect" disabled>中斷 USB</button><label>匯入既有校正 JSON <input id="usbCalibration" type="file" accept=".json,application/json" disabled></label></div>
 <p id="usbStatus" role="status">未連線；目前只有模擬。實體傳輸尚待接手臂驗證。</p>
 <label><input id="usbConfirm" type="checkbox">我選的是 Follower，已確認畫面姿勢與實體一致、手臂周圍無障礙</label>
 <div class="row"><button id="usbArm" class="primary" disabled>啟用實體控制</button><button id="usbHold" class="danger" disabled>停止實體追蹤</button></div>
 <p class="note">停止會保持目前姿勢，不會讓手臂突然失去支撐。這是軟體停止，不能取代硬體斷電急停；瀏覽器當機或拔 USB 時，馬達仍可能保有扭力。從小角度、無負載開始測試。</p>
 <details><summary>EEPROM 與實際角度（只顯示於此頁，不上傳）</summary><pre id="usbValues" class="log"></pre></details>`;
 document.querySelector('main').insertBefore(panel,document.querySelector('.footer'));
 const $=id=>document.getElementById(id);let hw=null,busy=false,connecting=false;
 function msg(text){$('usbStatus').textContent=text;}
 function update(){
  const connected=!!hw?.connected;
  $('usbConnect').disabled=connecting||connected||!('serial'in navigator);
  $('usbDisconnect').disabled=!hw;$('usbCalibration').disabled=!connected||!!hw?.armed;
  $('usbArm').disabled=!connected||!!hw.issues.length||!!hw.armed;
  $('usbHold').disabled=!connected||!hw.hasControl;
  for(const id of ['delay','jitter','drop']){$(id).disabled=!!hw?.armed;if(hw?.armed)$(id).value='0';}
  $('usbValues').textContent=JSON.stringify({state:hw?.armed?'ARMED':'READ ONLY',calibration:hw?.calibration,issues:hw?.issues,measuredURDFDegrees:hw?.actual},null,2);
 }
 if(!('serial'in navigator))msg('這個瀏覽器沒有 Web Serial；請用桌面 Chrome／Edge 開啟 localhost 或 HTTPS。模擬仍可使用。');
 $('usbConnect').onclick=async()=>{
  connecting=true;stopSimulation();update();
  try{
   const port=await navigator.serial.requestPort(); // always a visible, user-initiated chooser
   hw=new HardwareFollower(new SerialBus(port),{onState:msg});
   await hw.connect();setPose(hw.actual);
   msg(hw.issues.length?'已讀取，但保持唯讀：'+hw.issues.join('；'):'已讀取六顆馬達及 EEPROM 校正。請先比對藍色模型和實體姿勢，再啟用控制。');
  }catch(e){msg('連線未完成：'+e.message);if(hw){await hw.bus.close();hw=null;}}
  finally{connecting=false;update();}
 };
 $('usbCalibration').onchange=async e=>{
  try{const file=e.target.files[0];if(!file)return;if(file.size>16384)throw new Error('校正檔過大');hw.importCalibration(JSON.parse(await file.text()));msg('JSON 與 EEPROM 一致；已套用軟體方向設定。未覆寫馬達。');}
  catch(e){msg(e.message);}finally{e.target.value='';update();}
 };
 $('usbArm').onclick=async()=>{
  stopSimulation();$('usbArm').disabled=true;
  try{await hw.arm($('usbConfirm').checked);setPose(hw.actual);msg('實體已啟用，目標從目前位置開始。按上方「接手／繼續」後才追蹤。');}
  catch(e){msg('未啟用：'+e.message);}finally{update();}
 };
 $('usbHold').onclick=()=>{stopSimulation();hw?.stop();update();};
 $('usbDisconnect').onclick=async()=>{stopSimulation();await hw?.disconnect();hw=null;$('usbConfirm').checked=false;update();};
 navigator.serial?.addEventListener('disconnect',()=>{stopSimulation();if(hw){hw.armed=false;hw.connected=false;hw.epoch++;hw.bus.close();msg('USB 已拔除；不會自動重新啟用。');update();}});
 document.addEventListener('visibilitychange',()=>{if(document.hidden)hw?.stop();});
 window.addEventListener('pagehide',()=>hw?.stop());
 update();
 return {
  get actual(){return hw?.connected?hw.actual:null;},
  stop(){return hw?.stop();},
  tick(value,active){
   // A just-armed device may wait for the explicit simulation resume without disarming.
   if(hw?.armed&&active)hw.submit(value,true);
   if(!hw?.connected||busy)return;busy=true;
   hw.step().catch(e=>msg('USB 故障：'+e.message)).finally(()=>{busy=false;update();});
  },
 };
}
