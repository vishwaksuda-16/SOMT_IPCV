import faiss
import numpy as np

class ObjectMemory:
    def __init__(self, dimension=576): 
        self.index = faiss.IndexFlatL2(dimension)
        self.metadata = [] 

    def add_to_memory(self, vector, label, timestamp, img_path):
        vector = np.array([vector]).astype('float32')
        self.index.add(vector)
        # We now save the image path in metadata
        self.metadata.append({"label": label, "time": timestamp, "img": img_path})

    def search_by_text(self, query_label):
        """Finds the LATEST entry for a specific text label"""
        # Search backwards through metadata to find the most recent
        for item in reversed(self.metadata):
            if item['label'].lower() == query_label.lower():
                return item
        return None

    def search_memory(self, query_vector, target_label=None):
        query_vector = np.array([query_vector]).astype('float32')
        k = min(5, len(self.metadata))
        if k == 0: return None
        distances, indices = self.index.search(query_vector, k)
        for idx in indices[0]:
            if idx < len(self.metadata):
                match = self.metadata[idx]
                if target_label and match['label'] != target_label: continue
                return match
        return None

memory_db = ObjectMemory()