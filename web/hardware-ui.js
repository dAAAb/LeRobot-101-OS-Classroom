import {HardwareFollower,SerialBus,JOINTS} from './feetech-serial.js';
export function mountHardware({stopSimulation,setPose,shouldAlign=()=>false}){
 const panel=document.createElement('section');panel.className='panel controls';
 panel.innerHTML=`<h2>04　USB 實體 Follower（選配）</h2>
 <p>Chrome／Edge 桌面版 · Web Serial · STS3215 / ID 1–6 / 1 Mbps。連線時只讀取，保留馬達內的校正資料。</p>
 <div class="row"><button id="usbConnect">選擇 USB／讀取手臂</button><button id="usbDisconnect" disabled>中斷 USB</button><label>匯入既有校正 JSON <input id="usbCalibration" type="file" accept=".json,application/json" disabled></label></div>
 <p id="usbStatus" role="status">未連線；目前只有模擬。選擇 Follower 的 USB 後會先讀取既有校正與位置。</p>
 <label><input id="usbConfirm" type="checkbox">我選的是 Follower，已確認畫面姿勢與實體一致、手臂周圍無障礙</label>
 <div class="row"><label><input id="usbAlign" type="checkbox" checked>攝影機整臂控制：先對齊起始姿勢，再追蹤</label></div>
 <p><small>按「接手／繼續」後先保持手勢約半秒，等對齊完成再動。對齊途中夾爪保持原位；只控制夾爪與手動滑桿會略過這一步。</small></p>
 <div class="row"><button id="usbArm" class="primary" disabled>啟用實體控制</button><button id="usbHold" class="danger" disabled>停止實體追蹤</button></div>
 <div id="usbAlignPanel" hidden><label for="usbAlignProgress">起始姿勢對齊進度</label><progress id="usbAlignProgress" max="100" value="0"></progress><p id="usbAlignInfo"></p></div>
 <p class="note">停止會保持目前姿勢，不會讓手臂突然失去支撐。這是軟體停止，不能取代硬體斷電急停；瀏覽器當機或拔 USB 時，馬達仍可能保有扭力。從小角度、無負載開始測試。</p>
 <details><summary>EEPROM 與實際角度（只顯示於此頁，不上傳）</summary><pre id="usbValues" class="log"></pre></details>`;
 document.querySelector('main').insertBefore(panel,document.querySelector('.footer'));
 const $=id=>document.getElementById(id);let hw=null,busy=false,connecting=false,arming=false;
 const events=[];
 function msg(text){$('usbStatus').textContent=text;events.push({time:new Date().toLocaleTimeString(),message:text});if(events.length>12)events.shift();}
 function update(){
  const connected=!!hw?.connected;
  $('usbConnect').disabled=connecting||connected||!('serial'in navigator);
  $('usbDisconnect').disabled=!hw||arming;$('usbCalibration').disabled=!connected||!!hw?.armed||arming;
  $('usbArm').disabled=!connected||!!hw.issues.length||!!hw.armed||arming||!$('usbConfirm').checked;
  $('usbHold').disabled=!connected||!hw.hasControl;
  $('usbAlign').disabled=!!hw?.armed||arming;
  const alignment=hw?.alignmentStatus??{phase:'off',progress:0};
  $('usbAlignPanel').hidden=!hw?.armed||alignment.phase==='off';
  $('usbAlignProgress').value=Math.round(alignment.progress*100);
  const phases={ready:'已準備好。按上方「接手／繼續」，再保持起始手勢。',waiting:'等待穩定手勢：請維持約半秒。',aligning:'平滑對齊中：'+Math.round(alignment.progress*100)+'% · 請保持手勢，隨時可按停止。',settling:'路徑已走完，等待馬達實際到位。',following:'對齊完成，現在可以移動右手讓手臂跟隨。'};
  $('usbAlignInfo').textContent=phases[alignment.phase]??'';
  for(const id of ['delay','jitter','drop']){$(id).disabled=!!hw?.armed;if(hw?.armed)$(id).value='0';}
  $('usbValues').textContent=JSON.stringify({state:!connected?'DISCONNECTED':hw.armed?'ARMED':hw.hasControl?'HOLD':'READ ONLY',alignment,calibration:hw?.calibration,issues:hw?.issues,measuredURDFDegrees:hw?.actual,recentEvents:events},null,2);
 }
 if(!('serial'in navigator))msg('這個瀏覽器沒有 Web Serial；請用桌面 Chrome／Edge 開啟 localhost 或 HTTPS。模擬仍可使用。');
 $('usbConnect').onclick=async()=>{
  connecting=true;$('usbConfirm').checked=false;stopSimulation();update();
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
  if(arming)return;arming=true;stopSimulation();update();
  try{await hw.arm($('usbConfirm').checked,{alignOnStart:$('usbAlign').checked&&shouldAlign()});if(hw.armed){setPose(hw.actual);msg(hw.needsAlignment?'實體已啟用。按上方「接手／繼續」，先對齊起始姿勢，再開始跟隨。':'實體已啟用，已保留目前輸入模式。按上方「接手／繼續」後才追蹤。');}else msg('啟用已被停止；請確認此分頁在前景，再重新啟用。');}
  catch(e){msg('未啟用：'+e.message);}finally{arming=false;update();}
 };
 $('usbConfirm').onchange=update;
 $('usbHold').onclick=()=>{stopSimulation();hw?.stop();update();};
 $('usbDisconnect').onclick=async()=>{stopSimulation();await hw?.disconnect();hw=null;$('usbConfirm').checked=false;update();};
 navigator.serial?.addEventListener('disconnect',()=>{stopSimulation();if(hw){hw.armed=false;hw.connected=false;hw.epoch++;hw.bus.close();msg('USB 已拔除；不會自動重新啟用。');update();}});
 // lab.js handles visibility changes and records the specific HOLD reason.
 window.addEventListener('pagehide',()=>hw?.stop());
 update();
 return {
  get connected(){return !!hw?.connected;},
  get armed(){return !!hw?.armed;},
  get alignment(){return hw?.alignmentStatus??{phase:'off',progress:0};},
  get alignmentGoal(){return hw?.alignment?.goal??hw?.alignmentGoal??null;},
  get actual(){return hw?.connected?hw.actual:null;},
  stop(reason){return hw?.stop(reason);},
  tick(value,active,requestedTarget=value){
   // A just-armed device may wait for the explicit simulation resume without disarming.
   if(hw?.armed&&active&&requestedTarget)hw.submit(value,true,{alignmentTarget:requestedTarget});
   if(!hw?.connected||busy)return;busy=true;
   hw.step().catch(e=>msg('USB 故障：'+e.message)).finally(()=>{busy=false;update();});
  },
 };
}
