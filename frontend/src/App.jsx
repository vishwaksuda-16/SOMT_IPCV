import React, { useState, useEffect, useRef, useCallback } from 'react';
import { BrowserRouter, Routes, Route, NavLink, useLocation } from 'react-router-dom';
import axios from 'axios';
import {
  Mic, Search, Camera, Shield, ShieldAlert, History,
  Activity, Trash2, Play, Square, Save, ToggleLeft, ToggleRight,
  Clock, Eye, X, Cpu, CheckCircle, Wifi, WifiOff, BookMarked, UserX, User
} from 'lucide-react';

const BACKEND_URL = '/api';

// ═══════════════════════════════════════════════════════════════
// Toast notification system
// ═══════════════════════════════════════════════════════════════
let _addToast = null;

function ToastContainer() {
  const [toasts, setToasts] = useState([]);

  _addToast = useCallback((msg, type = 'info') => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, msg, type }]);
    setTimeout(() => {
      setToasts(prev => prev.map(t => t.id === id ? { ...t, exiting: true } : t));
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 350);
    }, 3400);
  }, []);

  return (
    <div className="toast-container" aria-live="polite">
      {toasts.map(t => (
        <div key={t.id} className={`toast ${t.type}${t.exiting ? ' exiting' : ''}`}>
          <span className="toast-icon">
            {t.type === 'success' ? <CheckCircle size={14} /> : t.type === 'error' ? '✕' : '●'}
          </span>
          <span>{t.msg}</span>
        </div>
      ))}
    </div>
  );
}

function toast(msg, type = 'info') { _addToast?.(msg, type); }

// ═══════════════════════════════════════════════════════════════
// Confidence badge
// ═══════════════════════════════════════════════════════════════
function ConfBadge({ conf }) {
  const pct = Math.round((conf || 0) * 100);
  const color = pct >= 75 ? '#10b981' : pct >= 55 ? '#f59e0b' : '#f43f5e';
  return (
    <span style={{ color, fontSize: 10, fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>
      {pct}%
    </span>
  );
}

// ═══════════════════════════════════════════════════════════════
// Main App Content
// ═══════════════════════════════════════════════════════════════
function AppContent() {
  // ── State ────────────────────────────────────────────────────
  const [cameraId]    = useState(`cam-${Math.random().toString(36).substring(2, 7)}`);
  const [privacyMode, setPrivacyMode] = useState(false);
  const [autoMode,    setAutoMode]    = useState(true);
  const [detectPersons, setDetectPersons] = useState(true);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);

  const [detectedObjects, setDetectedObjects] = useState([]);  // [{label, conf, box}]
  const [trackingProgress, setTrackingProgress] = useState({}); // {label: 0-100}
  const [history,  setHistory]  = useState([]);
  const [searchQuery,   setSearchQuery]   = useState('');
  const [searchResults, setSearchResults] = useState(null); // null = no search yet
  const [searchFocused, setSearchFocused] = useState(false);
  const [evidenceModal, setEvidenceModal] = useState(null);
  const [backendOnline, setBackendOnline] = useState(null); // null|true|false
  const [frameCount,    setFrameCount]    = useState(0);
  const [videoNative,   setVideoNative]   = useState(null); // {w, h}

  // ── Refs ─────────────────────────────────────────────────────
  const videoRef    = useRef(null);
  const canvasRef   = useRef(null);
  const streamRef   = useRef(null);
  // Key fix: keep a ref of isStreaming so interval callback never reads stale state
  const isStreamingRef = useRef(false);
  useEffect(() => { isStreamingRef.current = isStreaming; }, [isStreaming]);

  // ── Init ─────────────────────────────────────────────────────
  useEffect(() => {
    fetchSettings();
    fetchHistory();
    const id = setInterval(fetchHistory, 3500);
    return () => clearInterval(id);
  }, []);

  // Reattach stream if returning to camera page
  useEffect(() => {
    if (isStreaming && videoRef.current && videoRef.current.srcObject !== streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
  });

  // ── Settings ─────────────────────────────────────────────────
  const fetchSettings = async () => {
    try {
      const [rP, rA, rD] = await Promise.all([
        axios.get(`${BACKEND_URL}/toggle-privacy`),
        axios.get(`${BACKEND_URL}/toggle-auto`),
        axios.get(`${BACKEND_URL}/toggle-detect-persons`),
      ]);
      setPrivacyMode(rP.data.privacy_mode);
      setAutoMode(rA.data.auto_mode);
      setDetectPersons(rD.data.detect_persons);
      setBackendOnline(true);
    } catch {
      setBackendOnline(false);
      toast('Backend offline — start the Python server', 'error');
    }
  };

  const togglePrivacyMode = async () => {
    const next = !privacyMode;
    try {
      await axios.post(`${BACKEND_URL}/toggle-privacy`, { privacy_mode: next });
      setPrivacyMode(next);
      toast(
        next
          ? '🔒 Privacy mode ON — persons will not be captured or saved'
          : 'Privacy mode disabled',
        next ? 'success' : 'info'
      );
    } catch { toast('Backend unreachable', 'error'); }
  };

  const toggleAutoMode = async () => {
    const next = !autoMode;
    try {
      await axios.post(`${BACKEND_URL}/toggle-auto`, { auto_mode: next });
      setAutoMode(next);
      toast(`Auto-save ${next ? 'on' : 'off'}`, next ? 'success' : 'info');
    } catch { toast('Backend unreachable', 'error'); }
  };

  const toggleDetectPersons = async () => {
    const next = !detectPersons;
    try {
      await axios.post(`${BACKEND_URL}/toggle-detect-persons`, { detect_persons: next });
      setDetectPersons(next);
      toast(
        next ? '👤 Person detection enabled' : '🚫 Person detection disabled',
        next ? 'success' : 'info'
      );
    } catch { toast('Backend unreachable', 'error'); }
  };

  // ── Camera ───────────────────────────────────────────────────
  const toggleCamera = async () => {
    if (isStreaming) {
      streamRef.current?.getTracks().forEach(t => t.stop());
      setIsStreaming(false);
      setDetectedObjects([]);
      setTrackingProgress({});
      setVideoNative(null);
      setFrameCount(0);
      toast('Camera stopped', 'info');
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
        });
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          video.onloadedmetadata = () => {
            setVideoNative({ w: video.videoWidth, h: video.videoHeight });
            setIsStreaming(true);
            toast('Camera active — detection started', 'success');
          };
        }
      } catch (err) {
        toast('Camera access denied or unavailable', 'error');
        console.error(err);
      }
    }
  };

  // ── Frame Processing (ref-based, no stale closures) ──────────
  const sendFrameRef = useRef(null);

  const sendFrame = useCallback(async () => {
    if (!isStreamingRef.current) return;
    const video  = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.videoWidth === 0 || video.readyState < 2) return;

    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);

    canvas.toBlob(async (blob) => {
      if (!blob) return;
      const fd = new FormData();
      fd.append('camera_id', cameraId);
      fd.append('file', blob, 'frame.jpg');
      try {
        const res = await axios.post(`${BACKEND_URL}/process-frame`, fd);
        setBackendOnline(true);
        // Always replace detected list (empty array clears stale boxes)
        setDetectedObjects(res.data.detected ?? []);
        setTrackingProgress(res.data.tracking ?? {});
        setFrameCount(n => n + 1);
        res.data.archived?.forEach(obj =>
          toast(`📦 Saved: ${obj.label} @ ${obj.time}`, 'success')
        );
      } catch (err) {
        setBackendOnline(false);
        // Don't spam toasts on every frame failure
        console.error('Frame error:', err?.message);
      }
    }, 'image/jpeg', 0.9);
  }, [cameraId]);

  useEffect(() => { sendFrameRef.current = sendFrame; }, [sendFrame]);

  useEffect(() => {
    if (!isStreaming) return;
    const id = setInterval(() => sendFrameRef.current?.(), 700);
    return () => clearInterval(id);
  }, [isStreaming]);

  // ── Manual Save ──────────────────────────────────────────────
  const handleManualSave = useCallback(async () => {
    const video  = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || video.videoWidth === 0 || video.readyState < 2) {
      toast('No live feed to capture', 'error'); return;
    }
    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    canvas.toBlob(async (blob) => {
      if (!blob) return;
      const fd = new FormData();
      fd.append('camera_id', cameraId);
      fd.append('file', blob, 'frame.jpg');
      try {
        const res = await axios.post(`${BACKEND_URL}/manual-save`, fd);
        if (res.data.status === 'saved') {
          const labels = (res.data.saved || []).map(s => s.label).join(', ');
          toast(`Saved: ${labels || res.data.label}`, 'success');
          fetchHistory();
        } else {
          toast(res.data.error || 'No objects detected in frame', 'error');
        }
      } catch { toast('Save failed — backend unreachable', 'error'); }
    }, 'image/jpeg', 0.92);
  }, [cameraId]);

  // ── History ──────────────────────────────────────────────────
  const fetchHistory = async () => {
    try {
      const res = await axios.get(`${BACKEND_URL}/history`);
      if (res.data.history) setHistory(res.data.history);
    } catch {}
  };

  const clearHistory = async () => {
    if (!window.confirm('Clear all memory logs and photos?')) return;
    try {
      await axios.delete(`${BACKEND_URL}/history`);
      setHistory([]);
      toast('Memory cleared', 'info');
    } catch { toast('Failed to clear', 'error'); }
  };

  // ── Search ───────────────────────────────────────────────────
  const extractKeywords = (text) => {
    const stops = new Set(["where","is","my","the","a","an","find","search","for","are","look","i","put","did","see","can","you","have","it","in","on","at","of"]);
    return text.toLowerCase().replace(/[^a-z ]/g,'').split(' ').filter(w => w && !stops.has(w)).join(' ') || text;
  };

  const handleSearch = async (q) => {
    // If q is an event, we don't want to use it as a string
    const rawQuery = typeof q === 'string' ? q : searchQuery;
    if (!rawQuery.trim()) return;
    
    // Extract keywords to improve match rate for phrases like "where is my bottle"
    const query = extractKeywords(rawQuery);
    try {
      const res = await axios.get(`${BACKEND_URL}/search`, { params: { query } });
      const matches = res.data.matches || [];
      setSearchResults(matches);
      if (matches.length === 0) {
        toast(`"${query}" not found in memory`, 'error');
      } else {
        toast(`Found ${matches.length} result${matches.length > 1 ? 's' : ''}`, 'success');
        // Instantly display the last seen image via the evidence modal
        setEvidenceModal(matches[0]);
      }
    } catch { toast('Search failed — backend unreachable', 'error'); }
  };

  // ── Voice Search ─────────────────────────────────────────────
  const handleVoiceSearch = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      toast('Voice search not supported in this browser', 'error'); return;
    }
    const r = new SpeechRecognition();
    r.lang = 'en-US'; r.interimResults = false; r.maxAlternatives = 1;
    r.onstart  = () => setIsRecordingVoice(true);
    r.onresult = (e) => {
      const text = e.results[0][0].transcript;
      setSearchQuery(text);
      handleSearch(text);
    };
    r.onerror = () => { setIsRecordingVoice(false); toast('Voice error', 'error'); };
    r.onend   = () => setIsRecordingVoice(false);
    r.start();
  };

  // ── Bounding box: % of native video resolution ───────────────
  const boxStyle = useCallback((box) => {
    if (!videoNative?.w) return null;
    return {
      left:   `${(box[0] / videoNative.w) * 100}%`,
      top:    `${(box[1] / videoNative.h) * 100}%`,
      width:  `${(box[2] / videoNative.w) * 100}%`,
      height: `${(box[3] / videoNative.h) * 100}%`,
    };
  }, [videoNative]);

  // ═══════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════
  return (
    <div className="app-root">
      <ToastContainer />

      {/* ── HEADER ─────────────────────────────────────────── */}
      <header className="app-header">
        {/* Logo */}
        <NavLink to="/" className="logo-mark" style={{ cursor: 'pointer', textDecoration: 'none' }}>
          <div className="logo-icon"><Cpu size={17} color="white" /></div>
          <div>
            <div className="logo-title" style={{color: 'white'}}>VisualRAG</div>
            <div className="logo-subtitle" style={{color: 'rgba(255,255,255,0.7)'}}>Object Memory</div>
          </div>
        </NavLink>

        {/* Navigation Tabs (now React Router Links) */}
        <div className="nav-tabs">
          <NavLink to="/" className={({isActive}) => `nav-tab ${isActive ? 'active' : ''}`}>
            <Camera size={14} /> Live Camera
          </NavLink>
          <NavLink to="/memory" className={({isActive}) => `nav-tab ${isActive ? 'active' : ''}`}>
            <BookMarked size={14} /> Memory & Search
          </NavLink>
        </div>

        {/* Controls */}
        <div className="header-controls">
          <div className={`backend-pill${backendOnline === false ? ' offline' : backendOnline === true ? ' online' : ''}`}>
            {backendOnline === false ? <WifiOff size={12} /> : <Wifi size={12} />}
            <span>{backendOnline === false ? 'Offline' : backendOnline === true ? 'Connected' : '…'}</span>
          </div>
          <button className={`toggle-pill${autoMode ? ' active-auto' : ''}`} onClick={toggleAutoMode}>
            {autoMode ? <ToggleRight size={14} /> : <ToggleLeft size={14} />}
            <span>Auto</span>
          </button>
          {/* Detect Persons toggle — only visible when NOT in privacy mode */}
          {!privacyMode && (
            <button
              id="toggle-detect-persons"
              className={`toggle-pill${detectPersons ? ' active-auto' : ''}`}
              onClick={toggleDetectPersons}
              title={detectPersons ? 'Click to disable person detection' : 'Click to enable person detection'}
            >
              {detectPersons ? <User size={14} /> : <UserX size={14} />}
              <span>Persons</span>
            </button>
          )}
          <button className={`toggle-pill${privacyMode ? ' active-privacy' : ''}`} onClick={togglePrivacyMode}>
            {privacyMode ? <Shield size={14} /> : <ShieldAlert size={14} />}
            <span>Privacy</span>
          </button>
        </div>
      </header>

      {/* ── MAIN ───────────────────────────────────────────── */}
      <main className="app-main">
        <Routes>
          <Route path="/" element={
            <div className="content-grid" style={{ gridTemplateColumns: '1fr', maxWidth: '900px', margin: '0 auto' }}>
              {/* ── CAMERA ─────────────────────────────────────── */}
              <section className="camera-section">
                <div className="section-header">
                  <span className="section-title">
                    <Camera size={14} />Live Feed
                    {isStreaming && <span className="frame-badge">Frame #{frameCount}</span>}
                  </span>
                  <div className="cam-actions">
                    <button className="btn-icon-sm" onClick={handleManualSave} disabled={!isStreaming}>
                      <Save size={12} /> Save Now
                    </button>
                    <button
                      className={`btn-icon-sm ${isStreaming ? 'btn-stop' : 'btn-start'}`}
                      onClick={toggleCamera}
                    >
                      {isStreaming ? <><Square size={12} /> Stop</> : <><Play size={12} /> Start</>}
                    </button>
                  </div>
                </div>

                {/* Video viewport */}
                <div className="camera-viewport">
                  <video ref={videoRef} className="camera-video" autoPlay playsInline muted />
                  <canvas ref={canvasRef} style={{ display: 'none' }} />

                  {isStreaming && <div className="cam-badge live-badge"><span className="live-dot" />LIVE</div>}
                  {isStreaming && <div className="scan-line" />}

                  {/* Bounding boxes */}
                  {isStreaming && videoNative && detectedObjects
                    .filter(obj => obj.label !== 'person' || (detectPersons && !privacyMode))
                    .map((obj, i) => {
                    const s = boxStyle(obj.box);
                    if (!s) return null;
                    return (
                      <div key={`${obj.label}-${i}`} className="det-box" style={s}>
                        <span className="det-label">
                          {obj.label}
                          {obj.conf ? <ConfBadge conf={obj.conf} /> : null}
                        </span>
                        <span className="det-corner tl" /><span className="det-corner tr" />
                        <span className="det-corner bl" /><span className="det-corner br" />
                      </div>
                    );
                  })}

                  {/* Camera off placeholder */}
                  {!isStreaming && (
                    <div className="cam-placeholder">
                      <Camera size={44} />
                      <p>Press <strong>Start</strong> to enable camera</p>
                      <p className="cam-hint">Objects are automatically archived when they leave the frame</p>
                    </div>
                  )}

                  {/* Privacy mode overlay banner */}
                  {isStreaming && privacyMode && (
                    <div style={{
                      position: 'absolute', bottom: 10, left: '50%', transform: 'translateX(-50%)',
                      background: 'rgba(99,102,241,0.85)', color: '#fff',
                      borderRadius: 20, padding: '5px 14px', fontSize: 11, fontWeight: 600,
                      display: 'flex', alignItems: 'center', gap: 6, backdropFilter: 'blur(4px)',
                      border: '1px solid rgba(255,255,255,0.2)', pointerEvents: 'none', zIndex: 30
                    }}>
                      <Shield size={11} /> Privacy Mode — persons not captured
                    </div>
                  )}
                </div>

                {/* Live detection tags + tracking progress */}
                <div className="det-status-area">
                  {isStreaming && detectedObjects.length === 0 && (
                    <span className="det-scanning">Scanning… (conf ≥ 45%)</span>
                  )}
                  <div className="det-tags-row">
                    {detectedObjects.map((obj, i) => (
                      <span key={`tag-${i}`} className="det-tag">
                        <span className="det-dot" />{obj.label}
                        {obj.conf && <ConfBadge conf={obj.conf} />}
                      </span>
                    ))}
                  </div>

                  {/* Auto-save countdown bars for objects that have left frame */}
                  {autoMode && Object.entries(trackingProgress).filter(([lbl]) =>
                    !detectedObjects.find(d => d.label === lbl) && trackingProgress[lbl] > 0
                  ).map(([lbl, pct]) => (
                    <div key={lbl} className="tracking-row">
                      <span className="tracking-label"><BookMarked size={10} /> saving {lbl}…</span>
                      <div className="tracking-bar-wrap">
                        <div className="tracking-bar" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="tracking-pct">{pct}%</span>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          } />
          <Route path="/memory" element={
            <div className="content-grid" style={{ gridTemplateColumns: '1fr', maxWidth: '1000px', margin: '0 auto', gap: '30px' }}>
              {/* ── MEMORY & SEARCH ────────────────────────────── */}
              
              {/* Search Input Section */}
              <section className="search-input-section" style={{ background: 'var(--bg-glass)', padding: '20px', borderRadius: 'var(--radius-l)', border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                  <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '600', color: 'var(--text-1)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Search size={18} color="var(--accent)" /> Object Search
                  </h3>
                  <div className={`header-search${searchFocused ? ' focused' : ''}`} style={{ maxWidth: '100%', height: '44px', padding: '0 12px 0 16px' }}>
                    <Search size={16} className="hs-icon" />
                    <input
                      className="hs-input"
                      style={{ fontSize: '15px' }}
                      type="text"
                      value={searchQuery}
                      placeholder="Search memory (e.g., 'where is my bottle?')"
                      onFocus={() => setSearchFocused(true)}
                      onBlur={() => setSearchFocused(false)}
                      onChange={e => { setSearchQuery(e.target.value); if (!e.target.value) setSearchResults(null); }}
                      onKeyDown={e => e.key === 'Enter' && handleSearch()}
                    />
                    {searchQuery && (
                      <button className="hs-clear" onClick={() => { setSearchQuery(''); setSearchResults(null); }}>
                        <X size={15} />
                      </button>
                    )}
                    <button className={`hs-voice${isRecordingVoice ? ' recording' : ''}`} onClick={handleVoiceSearch} title="Voice search" style={{ width: '32px', height: '32px' }}>
                      <Mic size={16} />
                    </button>
                    <button className="hs-btn" onClick={() => handleSearch()} style={{ padding: '8px 18px', fontSize: '13px' }}>Search</button>
                  </div>
                </div>
              </section>

              {/* Search results panel */}
              {searchResults !== null && (
                <section className="results-section">
                  <div className="results-bar">
                    <span className="section-title"><Eye size={14} />{searchResults.length} result{searchResults.length !== 1 ? 's' : ''}</span>
                    <button className="btn-icon-sm" onClick={() => { setSearchResults(null); setSearchQuery(''); }}>
                      <X size={13} /> Clear
                    </button>
                  </div>
                  {searchResults.length > 0 ? (
                    <div className="results-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
                      {searchResults.map((item, i) => (
                        <div key={i} className="result-card" onClick={() => setEvidenceModal(item)}>
                          <img src={`${BACKEND_URL}/${item.img}`} alt={item.label} className="result-thumb" />
                          <div className="result-info">
                            <div className="result-label" style={{ fontSize: '14px' }}>{item.label}</div>
                            <div className="result-time" style={{ fontSize: '11px' }}><Clock size={12} />{item.time}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="results-empty">Nothing in memory matching that query.</div>
                  )}
                </section>
              )}

              {/* Memory Log Full View */}
              <section className="history-full-view" style={{ background: 'var(--bg-glass)', border: '1px solid var(--border)', borderRadius: 'var(--radius-l)', overflow: 'hidden' }}>
                <div className="history-header" style={{ padding: '18px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span className="section-title" style={{ fontSize: '13px' }}>
                    <History size={16} />Saved Memory
                    <span className="history-count-badge" style={{ fontSize: '12px', padding: '2px 8px' }}>{history.length}</span>
                  </span>
                  <button className="btn-danger-sm" onClick={clearHistory} title="Clear all" style={{ width: 'auto', padding: '0 12px', display: 'flex', gap: '6px' }}>
                    <Trash2 size={14} /> Clear Log
                  </button>
                </div>
                <div style={{ padding: '20px' }}>
                  {history.length === 0 ? (
                    <div className="history-empty" style={{ padding: '60px 20px', textAlign: 'center', color: 'var(--text-3)' }}>
                      <Activity size={40} style={{ opacity: 0.2, margin: '0 auto 10px' }} />
                      <p style={{ fontSize: '14px' }}>No objects saved yet.<br />Objects are archived when they leave the camera frame.</p>
                    </div>
                  ) : (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '15px' }}>
                      {history.map((item, i) => (
                        <div key={i} className="history-item" onClick={() => setEvidenceModal(item)} style={{ flexDirection: 'column', padding: '0', background: 'var(--bg-surface)' }}>
                          <img src={`${BACKEND_URL}/${item.img}`} alt={item.label} style={{ width: '100%', height: '140px', objectFit: 'cover', borderRadius: 'calc(var(--radius-m) - 2px) calc(var(--radius-m) - 2px) 0 0', borderBottom: '1px solid var(--border)' }} />
                          <div className="history-info" style={{ padding: '12px' }}>
                            <div className="history-label" style={{ fontSize: '14px' }}>{item.label}</div>
                            <div className="history-meta" style={{ fontSize: '11px', marginTop: '6px' }}><Clock size={12} />{item.time}</div>
                            <div className="history-meta" style={{ fontSize: '11px', marginTop: '4px' }}><Camera size={12} />{item.camera_id}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>
            </div>
          } />
        </Routes>
      </main>

      {/* ── EVIDENCE MODAL ─────────────────────────────────── */}
      {evidenceModal && (
        <div className="modal-backdrop" onClick={() => setEvidenceModal(null)}>
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <div className="modal-title">{evidenceModal.label}</div>
                <div className="modal-meta"><Clock size={12} />Last seen: {evidenceModal.time}</div>
              </div>
              <button className="modal-close" onClick={() => setEvidenceModal(null)}><X size={15} /></button>
            </div>
            <div className="modal-img-wrap">
              <img src={`${BACKEND_URL}/${evidenceModal.img}`} alt="Evidence" className="modal-img" />
              <div className="modal-cam-tag">📷 {evidenceModal.camera_id}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
}

export default App;
