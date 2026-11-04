// No remote inference. WASM and .task files are fetched from this same local server.
import {selectRightHand} from './gripper-gesture.js';
export async function createVision(kind){
 const {FilesetResolver,FaceLandmarker,PoseLandmarker,HandLandmarker}=await import('./vendor/mediapipe/vision_bundle.mjs');
 const files=await FilesetResolver.forVisionTasks('./vendor/mediapipe/wasm');
 const options=path=>({baseOptions:{modelAssetPath:path,delegate:'CPU'},runningMode:'VIDEO'});
 const pose=await PoseLandmarker.createFromOptions(files,{...options('./models/pose_landmarker_lite.task'),numPoses:1,minPoseDetectionConfidence:.6,minTrackingConfidence:.6});
 const face=kind==='reachy'?await FaceLandmarker.createFromOptions(files,{...options('./models/face_landmarker.task'),numFaces:1,outputFacialTransformationMatrixes:true}):null;
 const hands=kind==='arm'?await HandLandmarker.createFromOptions(files,{...options('./models/hand_landmarker.task'),numHands:2}):null;
 return {detect(video,now){
  const p=pose.detectForVideo(video,now),f=face?.detectForVideo(video,now),h=hands?.detectForVideo(video,now);
  // Anatomical right: input is unmirrored camera data. CSS mirrors only the preview.
  // Confirm with the highlighted wrist during setup; selfie cameras may differ.
  const right=selectRightHand(p.landmarks[0],h,{inputMirrored:false});
  return {pose:p.landmarks[0]??null,world:p.worldLandmarks[0]??null,...right,matrix:f?.facialTransformationMatrixes[0]?.data??null};
 },close(){pose.close();face?.close();hands?.close();}};
}
