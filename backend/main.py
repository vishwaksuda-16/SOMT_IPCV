import os
import cv2
import torch
import numpy as np
from fastapi import FastAPI, File, UploadFile, Form, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
import torchvision.transforms as T
from ultralytics import YOLO
from datetime import datetime
from torchvision.models import mobilenet_v3_small, MobileNet_V3_Small_Weights
from pydantic import BaseModel

from database import memory_db, camera_tracker

# 1. Setup Models
detector = YOLO('../yolov8s.pt') # Using existing model at root or downloading if missing
weights = MobileNet_V3_Small_Weights.DEFAULT
feature_extractor = mobilenet_v3_small(weights=weights).features
feature_extractor.eval()

# Configure storage
os.makedirs('memory_photos', exist_ok=True)

app = FastAPI()

# Enable CORS for the React Frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # Allow all for local dev
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve memory_photos as static files
app.mount("/memory_photos", StaticFiles(directory="memory_photos"), name="memory_photos")

# Global Settings
settings = {
    "privacy_mode": False,
    "auto_mode": True
}

STABILITY_THRESHOLD = 15

def get_embedding(crop):
    transform = T.Compose([
        T.ToPILImage(), 
        T.Resize((224, 224)), 
        T.ToTensor(),
        T.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225])
    ])
    img_t = transform(crop).unsqueeze(0)
    with torch.no_grad():
        vector = feature_extractor(img_t).mean([2, 3]).flatten().numpy()
    return vector

class SettingsUpdate(BaseModel):
    privacy_mode: bool = None
    auto_mode: bool = None

@app.post("/toggle-privacy")
async def toggle_privacy(update: SettingsUpdate):
    if update.privacy_mode is not None:
        settings["privacy_mode"] = update.privacy_mode
    return {"message": "Privacy mode updated", "privacy_mode": settings["privacy_mode"]}

@app.get("/toggle-privacy")
async def get_privacy():
    return {"privacy_mode": settings["privacy_mode"]}

@app.post("/toggle-auto")
async def toggle_auto(update: SettingsUpdate):
    if update.auto_mode is not None:
        settings["auto_mode"] = update.auto_mode
    return {"message": "Auto mode updated", "auto_mode": settings["auto_mode"]}

@app.get("/toggle-auto")
async def get_auto():
    return {"auto_mode": settings["auto_mode"]}

@app.delete("/history")
async def clear_history():
    memory_db.clear_memory()
    for cam_id in list(camera_tracker.active_objects.keys()):
        camera_tracker.active_objects[cam_id].clear()
    for cam_id in list(camera_tracker.lost_buffer.keys()):
        camera_tracker.lost_buffer[cam_id].clear()
    
    import glob
    for f in glob.glob("memory_photos/*"):
        if os.path.isfile(f):
            os.remove(f)
            
    return {"status": "cleared"}

@app.post("/process-frame")
async def process_frame(
    camera_id: str = Form(...),
    file: UploadFile = File(...)
):
    # Read the image file
    contents = await file.read()
    nparr = np.frombuffer(contents, np.uint8)
    frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if frame is None:
        return JSONResponse(status_code=400, content={"error": "Invalid image"})

    # Run detection
    results = detector.predict(frame, conf=0.6, verbose=False)
    
    current_frame_labels = []
    
    active_objects = camera_tracker.get_active(camera_id)
    lost_buffer = camera_tracker.get_lost(camera_id)

    if len(results[0].boxes) > 0:
        for box in results[0].boxes:
            label = detector.names[int(box.cls[0])]
            x1, y1, x2, y2 = map(int, box.xyxy[0])
            
            # Send box back to frontend
            current_frame_labels.append({
                "label": label,
                "box": [x1, y1, x2 - x1, y2 - y1] # x, y, width, height
            })
            
            if label in lost_buffer: 
                del lost_buffer[label]

            x1, y1, x2, y2 = map(int, box.xyxy[0])
            obj_crop = frame[max(0, y1):y2, max(0, x1):x2]
            
            if obj_crop.size > 0:
                active_objects[label] = {
                    "crop": obj_crop.copy(),
                    "full": frame.copy(),
                    "ts": datetime.now().strftime("%I:%M:%S %p"),
                    "box": (x1, y1, x2, y2)
                }

    disappeared = []

    # Check for disappearance
    if settings["auto_mode"]:
        current_labels_only = [item["label"] for item in current_frame_labels]
        for label in list(active_objects.keys()):
            if label not in current_labels_only:
                lost_buffer[label] = lost_buffer.get(label, 0) + 1
            
            if lost_buffer.get(label, 0) > STABILITY_THRESHOLD:
                data = active_objects[label]
                vector = get_embedding(data["crop"])
                ts_file = datetime.now().strftime("%H%M%S")
                
                # Apply privacy logic
                save_frame = data["full"].copy()
                if settings["privacy_mode"]:
                    # Redetect person to blur in the saved frame
                    res_p = detector.predict(save_frame, conf=0.6, verbose=False)
                    for b in res_p[0].boxes:
                        if detector.names[int(b.cls[0])] == 'person':
                            px1, py1, px2, py2 = map(int, b.xyxy[0])
                            roi = save_frame[max(0, py1):py2, max(0, px1):px2]
                            if roi.size > 0:
                                blur = cv2.GaussianBlur(roi, (99, 99), 30)
                                save_frame[max(0, py1):py2, max(0, px1):px2] = blur
                                
                img_path = f"memory_photos/{camera_id}_{label}_{ts_file}.jpg"
                cv2.imwrite(img_path, save_frame)
                
                memory_db.add_to_memory(vector, label, data["ts"], img_path, camera_id)
                disappeared.append({"label": label, "time": data["ts"], "camera_id": camera_id})
                
                del active_objects[label]
                del lost_buffer[label]

    # Return something to the frontend (like the found objects, missing objects, etc.)
    return {
        "status": "success",
        "detected": current_frame_labels,
        "archived": disappeared
    }

@app.get("/search")
async def search(query: str):
    matches = memory_db.search_by_text(query)
    # prepend host path to image for easy loading in frontend
    return {"matches": matches}

@app.get("/history")
async def history():
    return {"history": memory_db.get_all_history()}

@app.post("/manual-save")
async def manual_save(
    camera_id: str = Form(...),
    file: UploadFile = File(...)
):
    contents = await file.read()
    nparr = np.frombuffer(contents, np.uint8)
    frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    
    if frame is None:
        return {"error": "Invalid image"}
        
    results = detector.predict(frame, conf=0.6, verbose=False)
    if len(results[0].boxes) > 0:
        box = results[0].boxes[0]
        label = detector.names[int(box.cls[0])]
        x1, y1, x2, y2 = map(int, box.xyxy[0])
        
        obj_crop = frame[max(0, y1):y2, max(0, x1):x2]
        if obj_crop.size > 0:
            vector = get_embedding(obj_crop)
            ts = datetime.now()
            ts_str = ts.strftime("%I:%M:%S %p")
            ts_file = ts.strftime("%H%M%S")
            
            save_frame = frame.copy()
            if settings["privacy_mode"]:
                res_p = detector.predict(save_frame, conf=0.6, verbose=False)
                for b in res_p[0].boxes:
                    if detector.names[int(b.cls[0])] == 'person':
                        px1, py1, px2, py2 = map(int, b.xyxy[0])
                        roi = save_frame[max(0, py1):py2, max(0, px1):px2]
                        if roi.size > 0:
                            blur = cv2.GaussianBlur(roi, (99, 99), 30)
                            save_frame[max(0, py1):py2, max(0, px1):px2] = blur
            
            img_path = f"memory_photos/{camera_id}_{label}_manual_{ts_file}.jpg"
            cv2.imwrite(img_path, save_frame)
            memory_db.add_to_memory(vector, label, ts_str, img_path, camera_id)
            return {"status": "saved", "label": label, "time": ts_str, "img": img_path}
            
    return {"error": "No objects found to save"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
