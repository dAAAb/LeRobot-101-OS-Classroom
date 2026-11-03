// No remote inference. WASM and .task files are fetched from this same local server.
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
  let right=null,rightWorld=null;
  if(h?.landmarks?.length&&p.landmarks[0]?.[16]?.visibility>.55){
   const wrist=p.landmarks[0][16];let best=.12;
   h.landmarks.forEach((hand,i)=>{const d=Math.hypot(hand[0].x-wrist.x,hand[0].y-wrist.y);if(d<best){best=d;right=hand;rightWorld=h.worldLandmarks[i];}});
  }
  return {pose:p.landmarks[0]??null,world:p.worldLandmarks[0]??null,hand:right,handWorld:rightWorld,matrix:f?.facialTransformationMatrixes[0]?.data??null};
 },close(){pose.close();face?.close();hands?.close();}};
}
