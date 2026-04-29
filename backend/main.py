import os
import cv2
import torch
import numpy as np
from fastapi import FastAPI, File, UploadFile, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
import torchvision.transforms as T
from ultralytics import YOLO
from datetime import datetime
from torchvision.models import mobilenet_v3_small, MobileNet_V3_Small_Weights
from pydantic import BaseModel

from database import memory_db, camera_tracker

# ── Model Setup ───────────────────────────────────────────────────────────────
detector = YOLO('../yolov8s.pt')
weights = MobileNet_V3_Small_Weights.DEFAULT
feature_extractor = mobilenet_v3_small(weights=weights).features
feature_extractor.eval()

# ── Storage ───────────────────────────────────────────────────────────────────
PHOTOS_DIR = os.path.join(os.path.dirname(__file__), 'memory_photos')
os.makedirs(PHOTOS_DIR, exist_ok=True)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/memory_photos", StaticFiles(directory=PHOTOS_DIR), name="memory_photos")

# ── Global Settings ───────────────────────────────────────────────────────────
settings = {
    "privacy_mode": False,
    "auto_mode": True
}

# How many consecutive missed frames before object is considered gone and saved.
# At 700 ms/frame, 12 frames ≈ 8.4 s — enough to be deliberate but not annoying.
STABILITY_THRESHOLD = 12

# Detection confidence: 0.45 catches most everyday objects reliably.
# The original 0.6 was too strict and silently rejected real detections.
CONF_THRESHOLD = 0.45

# ── Embedding ─────────────────────────────────────────────────────────────────
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

def _blur_people(frame, conf=CONF_THRESHOLD):
    """Blur all detected persons in a frame (privacy mode)."""
    res = detector.predict(frame, conf=conf, verbose=False)
    for b in res[0].boxes:
        if detector.names[int(b.cls[0])] == 'person':
            px1, py1, px2, py2 = map(int, b.xyxy[0])
            roi = frame[max(0, py1):py2, max(0, px1):px2]
            if roi.size > 0:
                frame[max(0, py1):py2, max(0, px1):px2] = cv2.GaussianBlur(roi, (99, 99), 30)
    return frame

# ── Models ────────────────────────────────────────────────────────────────────
class SettingsUpdate(BaseModel):
    privacy_mode: bool = None
    auto_mode: bool = None

# ── Settings Endpoints ────────────────────────────────────────────────────────
@app.post("/toggle-privacy")
async def toggle_privacy(update: SettingsUpdate):
    if update.privacy_mode is not None:
        settings["privacy_mode"] = update.privacy_mode
    return {"privacy_mode": settings["privacy_mode"]}

@app.get("/toggle-privacy")
async def get_privacy():
    return {"privacy_mode": settings["privacy_mode"]}

@app.post("/toggle-auto")
async def toggle_auto(update: SettingsUpdate):
    if update.auto_mode is not None:
        settings["auto_mode"] = update.auto_mode
    return {"auto_mode": settings["auto_mode"]}

@app.get("/toggle-auto")
async def get_auto():
    return {"auto_mode": settings["auto_mode"]}

@app.get("/status")
async def get_status():
    """Returns live tracking state: which objects are being watched per camera,
    and how close each is to being auto-archived (as a 0–100 progress %)."""
    tracking = {}
    for cam_id, active in camera_tracker.active_objects.items():
        lost = camera_tracker.lost_buffer.get(cam_id, {})
        tracking[cam_id] = {
            label: {
                "missing_frames": lost.get(label, 0),
                "progress": round(lost.get(label, 0) / STABILITY_THRESHOLD * 100)
            }
            for label in active
        }
    return {
        "tracking": tracking,
        "total_saved": len(memory_db.metadata),
        "stability_threshold": STABILITY_THRESHOLD,
    }

# ── Clear History ─────────────────────────────────────────────────────────────
@app.delete("/history")
async def clear_history():
    memory_db.clear_memory()
    for cam_id in list(camera_tracker.active_objects.keys()):
        camera_tracker.active_objects[cam_id].clear()
    for cam_id in list(camera_tracker.lost_buffer.keys()):
        camera_tracker.lost_buffer[cam_id].clear()

    import glob
    for f in glob.glob(os.path.join(PHOTOS_DIR, "*")):
        if os.path.isfile(f):
            os.remove(f)

    return {"status": "cleared"}

# ── Main Frame Processor ──────────────────────────────────────────────────────
@app.post("/process-frame")
async def process_frame(
    camera_id: str = Form(...),
    file: UploadFile = File(...)
):
    contents = await file.read()
    nparr = np.frombuffer(contents, np.uint8)
    frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if frame is None:
        return JSONResponse(status_code=400, content={"error": "Invalid image"})

    # Run YOLO detection with lowered threshold for better real-world recall
    results = detector.predict(frame, conf=CONF_THRESHOLD, verbose=False)

    current_frame_labels = []
    active_objects = camera_tracker.get_active(camera_id)
    lost_buffer    = camera_tracker.get_lost(camera_id)

    if len(results[0].boxes) > 0:
        for box in results[0].boxes:
            label = detector.names[int(box.cls[0])]
            conf  = float(box.conf[0])
            x1, y1, x2, y2 = map(int, box.xyxy[0])

            current_frame_labels.append({
                "label": label,
                "conf":  round(conf, 2),
                "box":   [x1, y1, x2 - x1, y2 - y1]  # x, y, w, h
            })

            # Object is back — reset its disappearance counter
            if label in lost_buffer:
                del lost_buffer[label]

            obj_crop = frame[max(0, y1):y2, max(0, x1):x2]
            if obj_crop.size > 0:
                active_objects[label] = {
                    "crop": obj_crop.copy(),
                    "full": frame.copy(),
                    "ts":   datetime.now().strftime("%I:%M:%S %p"),
                    "box":  (x1, y1, x2, y2),
                    "conf": conf,
                }

    archived = []

    # ── Disappearance / Auto-Save Logic ───────────────────────────────────────
    if settings["auto_mode"]:
        current_labels_set = {item["label"] for item in current_frame_labels}

        for label in list(active_objects.keys()):
            if label not in current_labels_set:
                # Object missing this frame — increment counter
                lost_buffer[label] = lost_buffer.get(label, 0) + 1

                # FIX: Only trigger archive when object is CONFIRMED gone
                # (threshold check lives INSIDE the "not in current" branch)
                if lost_buffer[label] >= STABILITY_THRESHOLD:
                    data = active_objects[label]
                    vector = get_embedding(data["crop"])
                    ts_file = datetime.now().strftime("%H%M%S%f")[:12]

                    save_frame = data["full"].copy()
                    if settings["privacy_mode"]:
                        save_frame = _blur_people(save_frame)

                    img_path = os.path.join(
                        "memory_photos",
                        f"{camera_id}_{label}_{ts_file}.jpg"
                    )
                    abs_path = os.path.join(PHOTOS_DIR, f"{camera_id}_{label}_{ts_file}.jpg")
                    cv2.imwrite(abs_path, save_frame)

                    memory_db.add_to_memory(vector, label, data["ts"], img_path, camera_id)
                    archived.append({
                        "label":     label,
                        "time":      data["ts"],
                        "camera_id": camera_id,
                        "conf":      data.get("conf", 0),
                    })

                    del active_objects[label]
                    del lost_buffer[label]
            # else: object still visible → no countdown, and lost_buffer
            # was already cleared above in the detection loop.

    return {
        "status":   "success",
        "detected": current_frame_labels,
        "archived": archived,
        # Include live tracking progress so frontend can show countdown bars
        "tracking": {
            label: round(lost_buffer.get(label, 0) / STABILITY_THRESHOLD * 100)
            for label in active_objects
        }
    }

# ── Search ────────────────────────────────────────────────────────────────────
@app.get("/search")
async def search(query: str):
    matches = memory_db.search_by_text(query)
    return {"matches": matches}

@app.get("/history")
async def history():
    return {"history": memory_db.get_all_history()}

# ── Manual Save ───────────────────────────────────────────────────────────────
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

    results = detector.predict(frame, conf=CONF_THRESHOLD, verbose=False)
    if not results[0].boxes:
        return {"error": "No objects detected — try pointing at a clear object in good lighting"}

    # Save ALL detected objects (not just the first one)
    saved = []
    ts = datetime.now()
    ts_str  = ts.strftime("%I:%M:%S %p")
    ts_file = ts.strftime("%H%M%S%f")[:12]

    save_frame = frame.copy()
    if settings["privacy_mode"]:
        save_frame = _blur_people(save_frame)

    for box in results[0].boxes:
        label = detector.names[int(box.cls[0])]
        conf  = float(box.conf[0])
        x1, y1, x2, y2 = map(int, box.xyxy[0])

        obj_crop = frame[max(0, y1):y2, max(0, x1):x2]
        if obj_crop.size == 0:
            continue

        vector   = get_embedding(obj_crop)
        img_path = os.path.join("memory_photos", f"{camera_id}_{label}_manual_{ts_file}.jpg")
        abs_path = os.path.join(PHOTOS_DIR, f"{camera_id}_{label}_manual_{ts_file}.jpg")
        cv2.imwrite(abs_path, save_frame)
        memory_db.add_to_memory(vector, label, ts_str, img_path, camera_id)
        saved.append({"label": label, "conf": round(conf, 2), "time": ts_str, "img": img_path})

    if saved:
        return {"status": "saved", "saved": saved, "label": saved[0]["label"], "time": ts_str}

    return {"error": "No valid object crops found"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
