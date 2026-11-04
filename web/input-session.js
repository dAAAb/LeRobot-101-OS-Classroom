// Input selection and measured-pose synchronization are different operations.
// Selecting a new input stops hardware; reading its pose must preserve the input.
export class InputSession {
 constructor(controller,{hardware=()=>null,onMode=()=>{},onManual=()=>{}}={}){
  this.controller=controller;this.hardware=hardware;this.onMode=onMode;this.onManual=onManual;
  this.mode='manual';this.manual={...controller.value};
 }
 selectMode(mode){
  if(!['manual','camera','replay'].includes(mode))throw new Error('未知輸入模式');
  this.hardware()?.stop('已切換輸入模式，請重新啟用實體控制');
  this.controller.stop();this.mode=mode;this.onMode(mode);
 }
 setManualJoint(name,value){
  if(!Object.hasOwn(this.manual,name)||!Number.isFinite(value))throw new Error('無效關節目標');
  if(this.mode!=='manual')this.selectMode('manual');
  this.manual[name]=value;this.onManual(this.manual);
 }
 seedPose(pose){
  if(!Object.keys(this.manual).every(name=>Number.isFinite(pose[name])))throw new Error('實測姿勢不完整');
  this.controller.stop();
  for(const name of Object.keys(this.manual)){this.manual[name]=pose[name];this.controller.value[name]=pose[name];}
  this.onManual(this.manual);
 }
 resume(){this.controller.resume();}
 stop(reason){this.controller.stop();return this.hardware()?.stop(reason);}
}
