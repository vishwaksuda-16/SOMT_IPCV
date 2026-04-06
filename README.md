# Visual RAG Smart Tracker PWA

A Progressive Web App that tracks and remembers the last seen location of objects using YOLOv8, MobileNet, FAISS, and React.

## Directory Structure
- `backend/`: FastAPI server processing frames and tracking logic.
- `frontend/`: React + Vite progressive web app with Tailwind CSS.

## Setup Instructions

### 1. Backend Service
1. Navigate to the backend directory:
   ```bash
   cd backend
   ```
2. Create and activate a Python virtual environment (recommended):
   ```bash
   python -m venv venv
   # On Windows:
   venv\Scripts\activate
   # On macOS/Linux:
   source venv/bin/activate
   ```
3. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
4. Run the FastAPI server:
   ```bash
   python main.py
   ```
   *The server will start on `http://localhost:8000`.*

### 2. Frontend PWA
1. Open a new terminal and navigate to the frontend directory:
   ```bash
   cd frontend
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run the Vite development server:
   ```bash
   npm run dev
   ```
   *The frontend will run on `http://localhost:5173`. You can access this via mobile on the same network to use it as a PWA.*

## Features
- **Smart Archiving**: The backend stores missing objects automatically into FAISS when they leave the frame for a certain duration.
- **Privacy Mode**: Toggle "Privacy Mode" to automatically detect persons and blur them in archived snapshots before saving.
- **Voice-to-Query**: Click the purple microphone icon and say "Where is my bottle" to automatically extract the keyword and search the timeline.
- **Progressive Web App**: Access the frontend on your phone on the local network (e.g. `http://<YOUR_IP>:5173`) and use "Add to Home Screen".
