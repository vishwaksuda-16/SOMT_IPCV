import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { Mic, Search, Camera, Shield, ShieldAlert, History, Activity, Zap, Info, Trash2, Play, Square, Save, ToggleLeft, ToggleRight } from 'lucide-react';

const BACKEND_URL = 'http://127.0.0.1:8000';

function App() {
  const [cameraId] = useState(`cam-${Math.random().toString(36).substring(2, 9)}`);
  const [privacyMode, setPrivacyMode] = useState(false);
  const [autoMode, setAutoMode] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [history, setHistory] = useState([]);
  const [detectedObjects, setDetectedObjects] = useState([]);
  const [evidenceModal, setEvidenceModal] = useState(null);
  const [videoDimensions, setVideoDimensions] = useState(null);
  
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  const streamRef = useRef(null);

  useEffect(() => {
    fetchSettings();
    fetchHistory();
    const intervalId = setInterval(fetchHistory, 3000);
    return () => clearInterval(intervalId);
  }, []);

  const fetchSettings = async () => {
    try {
      const resP = await axios.get(`${BACKEND_URL}/toggle-privacy`);
      setPrivacyMode(resP.data.privacy_mode);
      const resA = await axios.get(`${BACKEND_URL}/toggle-auto`);
      setAutoMode(resA.data.auto_mode);
    } catch (e) {
      console.error(e);
    }
  };

  const toggleCamera = async () => {
    if (isStreaming) {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
      setIsStreaming(false);
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          setIsStreaming(true);
        }
      } catch (err) {
        console.error("Camera access denied or unavailable", err);
      }
    }
  };

  const togglePrivacyMode = async () => {
    try {
      const newMode = !privacyMode;
      await axios.post(`${BACKEND_URL}/toggle-privacy`, { privacy_mode: newMode });
      setPrivacyMode(newMode);
    } catch (e) {
      console.error(e);
    }
  };

  const toggleAutoMode = async () => {
    try {
      const newMode = !autoMode;
      await axios.post(`${BACKEND_URL}/toggle-auto`, { auto_mode: newMode });
      setAutoMode(newMode);
    } catch (e) {
      console.error(e);
    }
  };

  const clearHistory = async () => {
    if (!window.confirm("Are you sure you want to clear all logs?")) return;
    try {
      await axios.delete(`${BACKEND_URL}/history`);
      setHistory([]);
    } catch (e) {
      console.error(e);
    }
  }

  const fetchHistory = async () => {
    try {
      const res = await axios.get(`${BACKEND_URL}/history`);
      if (res.data.history) {
        setHistory(res.data.history);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleManualSave = async () => {
    if (!videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (video.videoWidth === 0 || video.videoHeight === 0) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    canvas.toBlob(async (blob) => {
      if (!blob) return;
      const formData = new FormData();
      formData.append('camera_id', cameraId);
      formData.append('file', blob, 'frame.jpg');

      try {
        const res = await axios.post(`${BACKEND_URL}/manual-save`, formData);
        if (res.data.status === 'saved') {
          alert(`Saved manually: ${res.data.label}`);
          fetchHistory();
        } else {
          alert("No objects found to save.");
        }
      } catch (err) {
        console.error("Manual save failed", err);
      }
    }, 'image/jpeg', 0.8);
  };

  // Frame processing loop
  useEffect(() => {
    let processInterval;
    if (isStreaming) {
      processInterval = setInterval(sendFrame, 500); 
    }
    return () => clearInterval(processInterval);
  }, [isStreaming]);

  const sendFrame = async () => {
    if (!videoRef.current || !canvasRef.current || !isStreaming) return;
    
    const video = videoRef.current;
    if (video.videoWidth === 0 || video.videoHeight === 0) return;
    
    // Update dimensions state once
    if (!videoDimensions || videoDimensions.w !== video.videoWidth) {
       setVideoDimensions({ w: video.videoWidth, h: video.videoHeight });
    }

    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    canvas.toBlob(async (blob) => {
      if (!blob) return;
      const formData = new FormData();
      formData.append('camera_id', cameraId);
      formData.append('file', blob, 'frame.jpg');

      try {
        const res = await axios.post(`${BACKEND_URL}/process-frame`, formData);
        if (res.data.detected) {
          setDetectedObjects(res.data.detected);
        }
      } catch (err) {}
    }, 'image/jpeg', 0.8);
  };

  const handleSearch = async (queryParam) => {
    const query = queryParam || searchQuery;
    if (!query) return;
    try {
      const res = await axios.get(`${BACKEND_URL}/search`, { params: { query } });
      setSearchResults(res.data.matches || []);
      if (res.data.matches && res.data.matches.length > 0) {
        setEvidenceModal(res.data.matches[0]);
      } else {
        alert("Object not found!");
      }
    } catch (e) {
      console.error("Search failed", e);
    }
  };

  const handleVoiceSearch = () => {
    if (!('webkitSpeechRecognition' in window)) {
      alert("Voice search is not supported in this browser.");
      return;
    }
    const recognition = new window.webkitSpeechRecognition();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => setIsRecordingVoice(true);
    
    recognition.onresult = (event) => {
      let speechResult = event.results[0][0].transcript.toLowerCase();
      const stopwords = ["where", "is", "my", "the", "a", "an", "find", "search", "for", "are", "look"];
      const words = speechResult.replace(/[^a-z ]/g, "").split(" ");
      const keyword = words.filter(w => !stopwords.includes(w)).pop() || speechResult;
      setSearchQuery(keyword);
      handleSearch(keyword);
    };

    recognition.onerror = () => setIsRecordingVoice(false);
    recognition.onend = () => setIsRecordingVoice(false);
    recognition.start();
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      
      {/* Header */}
      <header className="px-6 py-4 border-b border-white/5 bg-slate-900/50 backdrop-blur-xl sticky top-0 z-10 flex justify-between items-center flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-indigo-500/10 rounded-xl border border-indigo-500/20">
            <Activity className="w-6 h-6 text-indigo-400" />
          </div>
          <h1 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent">
            VisualRAG
          </h1>
        </div>
        
        <div className="flex gap-3">
          <button 
            onClick={toggleAutoMode}
            className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all ${
              autoMode 
                ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20 shadow-[0_0_15px_rgba(59,130,246,0.1)]'
                : 'bg-slate-800 text-slate-400 border border-slate-700 hover:bg-slate-700'
            }`}
          >
            {autoMode ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
            Auto
          </button>

          <button 
            onClick={togglePrivacyMode}
            className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all ${
              privacyMode 
                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shadow-[0_0_15px_rgba(16,185,129,0.1)]'
                : 'bg-slate-800 text-slate-400 border border-slate-700 hover:bg-slate-700'
            }`}
          >
            {privacyMode ? <Shield className="w-4 h-4" /> : <ShieldAlert className="w-4 h-4" />}
            Privacy
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto p-4 lg:p-8 flex flex-col gap-6">
        
        {/* Search Bar */}
        <section className="relative">
          <div className="relative group">
            <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
              <Search className="w-5 h-5 text-slate-500 group-focus-within:text-blue-400 transition-colors" />
            </div>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder="E.g. 'Where is my bottle?'"
              className="w-full bg-slate-900/50 border border-slate-800 rounded-2xl py-4 pl-12 pr-16 text-lg focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50 transition-all placeholder:text-slate-600 shadow-inner"
            />
            <button
              onClick={handleVoiceSearch}
              className={`absolute inset-y-2 right-2 p-2 rounded-xl transition-all ${
                isRecordingVoice 
                  ? 'bg-red-500/20 text-red-400 animate-pulse' 
                  : 'bg-indigo-500/20 text-indigo-400 hover:bg-indigo-500/30'
              }`}
            >
              <Mic className="w-5 h-5" />
            </button>
          </div>
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 lg:gap-8">
          {/* Main Feed */}
          <section className="lg:col-span-2 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold flex items-center gap-2 text-slate-300">
                <Camera className="w-5 h-5 text-indigo-400" />
                Live Feed
              </h2>
              <div className="flex gap-2">
                <button
                   onClick={handleManualSave}
                   className="flex items-center gap-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 px-3 py-1.5 rounded-lg border border-slate-700 transition"
                >
                  <Save className="w-3.5 h-3.5" /> Save
                </button>
                <button
                   onClick={toggleCamera}
                   className={`flex items-center gap-2 text-xs font-medium px-3 py-1.5 rounded-lg border transition ${isStreaming ? 'bg-red-500/10 text-red-400 border-red-500/20 hover:bg-red-500/20' : 'bg-green-500/10 text-green-400 border-green-500/20 hover:bg-green-500/20'}`}
                >
                  {isStreaming ? <><Square className="w-3.5 h-3.5" /> Stop</> : <><Play className="w-3.5 h-3.5" /> Start</>}
                </button>
              </div>
            </div>
            
            <div className="w-full flex justify-center">
              <div className="relative bg-slate-900 rounded-3xl overflow-hidden border border-slate-800 shadow-2xl flex items-center justify-center inline-block max-w-full">
                <video 
                  ref={videoRef} 
                  className="w-full max-w-full block"
                  autoPlay 
                  playsInline 
                  muted
                />
                
                {/* Visual Bounding Boxes Overlay */}
                {isStreaming && videoDimensions && detectedObjects.map((obj, idx) => {
                  const left = (obj.box[0] / videoDimensions.w) * 100;
                  const top = (obj.box[1] / videoDimensions.h) * 100;
                  const width = (obj.box[2] / videoDimensions.w) * 100;
                  const height = (obj.box[3] / videoDimensions.h) * 100;
                  
                  const isPerson = obj.label === 'person';
                  const isPrivate = privacyMode && isPerson;

                  return (
                    <div 
                      key={idx}
                      className={`absolute rounded pointer-events-none transition-all duration-300 ${isPrivate ? 'backdrop-blur-3xl bg-black/60 border-none' : 'border focus-ring-indigo border-indigo-500/80 bg-indigo-500/10'}`}
                      style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}
                    >
                      {!isPrivate && (
                        <span className="absolute -top-5 left-0 bg-indigo-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded shadow">
                          {obj.label}
                        </span>
                      )}
                    </div>
                  )
                })}

                <canvas ref={canvasRef} className="hidden" />
                
                {!isStreaming && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-500 p-12">
                    <Camera className="w-12 h-12 mb-3 opacity-20" />
                    <p>Camera is stopped</p>
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* History Sidebar */}
          <section className="bg-slate-900/40 rounded-3xl border border-slate-800/60 p-5 flex flex-col h-[500px] lg:h-auto overflow-hidden">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold flex items-center gap-2 text-slate-300">
                <History className="w-5 h-5 text-indigo-400" />
                Recent Logs
              </h2>
              <button 
                onClick={clearHistory}
                className="text-slate-500 hover:text-red-400 p-1.5 hover:bg-slate-800 rounded-lg transition"
                title="Clear Logs"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto pr-2 space-y-3 custom-scrollbar">
              {history.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-48 text-slate-500 text-center">
                  <Info className="w-8 h-8 mb-2 opacity-20" />
                  <p className="text-sm">No objects saved yet.</p>
                </div>
              ) : (
                history.map((item, idx) => (
                  <div 
                    key={idx} 
                    onClick={() => setEvidenceModal(item)}
                    className="group flex gap-4 p-3 rounded-2xl bg-slate-900 hover:bg-slate-800 border border-slate-800 hover:border-indigo-500/30 transition-all cursor-pointer shadow-sm relative overflow-hidden"
                  >
                    <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-indigo-500 to-blue-500 opacity-0 group-hover:opacity-100 transition-opacity"></div>
                    <img 
                      src={`${BACKEND_URL}/${item.img}?t=${Math.random()}`} 
                      alt={item.label}
                      className="w-16 h-16 object-cover rounded-xl border border-slate-700/50"
                    />
                    <div className="flex-1 flex flex-col justify-center">
                      <h4 className="font-medium text-slate-200 capitalize">{item.label}</h4>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs text-slate-500 flex items-center gap-1">
                          <History className="w-3 h-3" /> {item.time}
                        </span>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </main>

      {/* Evidence Modal */}
      {evidenceModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
          <div className="bg-slate-900 rounded-3xl border border-slate-800 w-full max-w-2xl overflow-hidden shadow-[0_0_40px_rgba(0,0,0,0.5)] transform animate-in fade-in zoom-in-95 duration-200">
            <div className="flex justify-between items-center p-5 border-b border-slate-800">
              <div>
                <h3 className="text-xl font-semibold capitalize text-slate-100">{evidenceModal.label}</h3>
                <p className="text-sm text-slate-400 mt-1 flex items-center gap-1">
                  <History className="w-3.5 h-3.5" /> Last seen: {evidenceModal.time}
                </p>
              </div>
              <button 
                onClick={() => setEvidenceModal(null)}
                className="p-2 hover:bg-slate-800 rounded-full transition-colors text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>
            <div className="bg-black relative">
              <img 
                src={`${BACKEND_URL}/${evidenceModal.img}`} 
                alt="Evidence" 
                className="w-full max-h-[60vh] object-contain"
              />
              <div className="absolute bottom-4 right-4 bg-black/60 backdrop-blur px-3 py-1.5 rounded-lg border border-white/10 text-xs font-mono text-slate-300">
                CAM: {evidenceModal.camera_id}
              </div>
            </div>
          </div>
        </div>
      )}
      
      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background-color: #334155;
          border-radius: 20px;
        }
        .no-scrollbar::-webkit-scrollbar {
          display: none;
        }
      `}</style>
    </div>
  );
}

export default App;
