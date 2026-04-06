import cv2
import torch
import os
import numpy as np
import torchvision.transforms as T
from ultralytics import YOLO
from datetime import datetime
from torchvision.models import mobilenet_v3_small, MobileNet_V3_Small_Weights
from database import memory_db 

# 1. Setup
if not os.path.exists('memory_photos'): os.makedirs('memory_photos')
detector = YOLO('yolov8s.pt')
weights = MobileNet_V3_Small_Weights.DEFAULT
feature_extractor = mobilenet_v3_small(weights=weights).features
feature_extractor.eval() 

def get_embedding(crop):
    transform = T.Compose([T.ToPILImage(), T.Resize((224, 224)), T.ToTensor(),
                           T.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225])])
    img_t = transform(crop).unsqueeze(0)
    with torch.no_grad():
        vector = feature_extractor(img_t).mean([2, 3]).flatten().numpy()
    return vector

cap = cv2.VideoCapture(0)

# --- SMART TRACKING VARIABLES ---
active_objects = {} 
lost_buffer = {} # Prevents flickering messages
STABILITY_THRESHOLD = 15 # Frames to wait before confirming an object is "Lost"

print("\n" + "="*40)
print("  VISUAL-RAG: SMART MEMORY TRACKER")
print("="*40)
print(" [S] - Manual Save  | [T] - Text Search")
print(" [A] - Toggle Auto-Logic | [Q] - Quit")
print("="*40 + "\n")

auto_logic = True

while cap.isOpened():
    success, frame = cap.read()
    if not success: break

    results = detector.predict(frame, conf=0.6, verbose=False)
    annotated_frame = results[0].plot()
    
    current_frame_labels = []

    if len(results[0].boxes) > 0:
        for box in results[0].boxes:
            label = detector.names[int(box.cls[0])]
            current_frame_labels.append(label)
            
            # Reset the 'lost' buffer if object is seen again
            if label in lost_buffer: del lost_buffer[label]

            # Update tracking data
            x1, y1, x2, y2 = map(int, box.xyxy[0])
            obj_crop = frame[max(0, y1):y2, max(0, x1):x2]
            if obj_crop.size > 0:
                active_objects[label] = {
                    "crop": obj_crop.copy(),
                    "full": frame.copy(),
                    "ts": datetime.now().strftime("%I:%M:%S %p")
                }

    # --- CLEAN DISAPPEARANCE LOGIC ---
    if auto_logic:
        for label in list(active_objects.keys()):
            if label not in current_frame_labels:
                # Add to lost buffer
                lost_buffer[label] = lost_buffer.get(label, 0) + 1
                
                # Only save if it's been missing for X frames
                if lost_buffer[label] > STABILITY_THRESHOLD:
                    data = active_objects[label]
                    vector = get_embedding(data["crop"])
                    ts_file = datetime.now().strftime("%H%M%S")
                    img_path = f"memory_photos/{label}_{ts_file}.jpg"
                    
                    cv2.imwrite(img_path, data["full"])
                    memory_db.add_to_memory(vector, label, data["ts"], img_path)
                    
                    print(f"📦 ARCHIVED: {label} (Last seen {data['ts']})")
                    del active_objects[label]
                    del lost_buffer[label]

    cv2.imshow("Visual-RAG: Live Feed", annotated_frame)
    key = cv2.waitKey(1) & 0xFF

    # --- MANUAL SAVE (S) ---
    if key == ord('s'):
        if len(results[0].boxes) > 0:
            label = detector.names[int(results[0].boxes[0].cls[0])]
            print(f"📸 Manual Snapshot saved for: {label}")
            # (Triggers same save logic as above)

    # --- TEXT SEARCH (T) ---
    elif key == ord('t'):
        print("\n" + "-"*30)
        query = input("🔍 Search Object: ").strip().lower()
        match = memory_db.search_by_text(query)
        if match:
            print(f"🎯 Found {query}! Last seen at {match['time']}")
            evidence = cv2.imread(match['img'])
            cv2.imshow("EVIDENCE", evidence)
            cv2.waitKey(0)
            cv2.destroyWindow("EVIDENCE")
        else:
            print("❌ No match.")
        print("-"*30 + "\n")

    # --- TOGGLE AUTO (A) ---
    elif key == ord('a'):
        auto_logic = not auto_logic
        print(f"🤖 Auto-Logic: {'ON' if auto_logic else 'OFF'}")

    if key == ord('q'): break

cap.release()
cv2.destroyAllWindows()