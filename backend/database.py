import faiss
import numpy as np

class ObjectMemory:
    def __init__(self, dimension=576):
        self.index = faiss.IndexFlatL2(dimension)
        self.metadata = []

    def add_to_memory(self, vector, label, timestamp, img_path, camera_id):
        vector = np.array([vector]).astype('float32')
        self.index.add(vector)
        self.metadata.append({
            "label": label, 
            "time": timestamp, 
            "img": img_path,
            "camera_id": camera_id
        })

    def search_by_text(self, query_label):
        """Finds the LATEST entry for a specific text label"""
        results = []
        for item in reversed(self.metadata):
            if query_label.lower() in item['label'].lower():
                results.append(item)
        return results

    def get_all_history(self):
        return list(reversed(self.metadata))

    def clear_memory(self):
        self.metadata = []
        self.index = faiss.IndexFlatL2(576)

memory_db = ObjectMemory()

# Provide state tracking for cameras
class CameraTracker:
    def __init__(self):
        # camera_id -> dict of label -> tracking data
        self.active_objects = {}
        # camera_id -> dict of label -> missed frame count
        self.lost_buffer = {}

    def get_active(self, camera_id):
        if camera_id not in self.active_objects:
            self.active_objects[camera_id] = {}
        return self.active_objects[camera_id]

    def get_lost(self, camera_id):
        if camera_id not in self.lost_buffer:
            self.lost_buffer[camera_id] = {}
        return self.lost_buffer[camera_id]

camera_tracker = CameraTracker()
