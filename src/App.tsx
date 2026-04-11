import { useState, useEffect, useRef } from 'react';
import { Mic, MicOff, Loader2, AlertCircle, LogIn, LogOut, FileText, User as UserIcon, X, Download, ChevronRight, MoreVertical, Edit2, Trash2, Save, Share, Copy, Plus, Sparkles, MessageSquare } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { LiveSession, SessionState } from './lib/live-session';
import { AudioStreamer } from './lib/audio-streamer';
import { AuthProvider, useAuth } from './context/AuthContext';
import { FloatingMic } from './components/FloatingMic';
import { db } from './firebase';
import { collection, addDoc, query, onSnapshot, orderBy, deleteDoc, doc, updateDoc, getDoc } from 'firebase/firestore';
import { handleFirestoreError, OperationType } from './lib/firestore-errors';
import { GoogleGenAI } from '@google/genai';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';

function MainApp() {
  const { user, login, logout } = useAuth();
  const [sessionState, setSessionState] = useState<SessionState>('disconnected');
  const [volume, setVolume] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);
  
  const [notes, setNotes] = useState<any[]>([]);
  const [tempNotes, setTempNotes] = useState<any[]>([]); // For non-logged in users
  const notesRef = useRef<any[]>([]);
  const tempNotesRef = useRef<any[]>([]);

  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);

  useEffect(() => {
    tempNotesRef.current = tempNotes;
  }, [tempNotes]);

  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [selectedNote, setSelectedNote] = useState<any | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  
  const [isEditingNote, setIsEditingNote] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [showNoteMenu, setShowNoteMenu] = useState(false);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  
  const [showCreateNoteModal, setShowCreateNoteModal] = useState(false);
  const [newNoteTitle, setNewNoteTitle] = useState('');
  
  const [showAnalyzeModal, setShowAnalyzeModal] = useState(false);
  const [analyzePrompt, setAnalyzePrompt] = useState('');
  const [analyzeInstruction, setAnalyzeInstruction] = useState('');
  const [analyzeImage, setAnalyzeImage] = useState<File | null>(null);
  const [analyzeImagePreview, setAnalyzeImagePreview] = useState<string | null>(null);
  const [analyzeResult, setAnalyzeResult] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  
  const sessionRef = useRef<LiveSession | null>(null);
  const audioRef = useRef<AudioStreamer | null>(null);
  const startSessionRef = useRef<() => void>(() => {});
  const isManuallyDisconnected = useRef<boolean>(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const noteContentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (user) {
      const q = query(collection(db, `users/${user.uid}/notes`), orderBy('createdAt', 'desc'));
      const unsubscribe = onSnapshot(q, (snapshot) => {
        setNotes(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
      }, (error) => {
        handleFirestoreError(error, OperationType.LIST, `users/${user.uid}/notes`);
      });
      return () => unsubscribe();
    } else {
      setNotes([]);
    }
  }, [user]);

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const sharedUserId = urlParams.get('userId');
    const sharedNoteId = urlParams.get('noteId');

    if (sharedUserId && sharedNoteId) {
      const fetchSharedNote = async () => {
        try {
          const docRef = doc(db, `users/${sharedUserId}/notes/${sharedNoteId}`);
          const docSnap = await getDoc(docRef);
          if (docSnap.exists() && docSnap.data().isShared) {
            setSelectedNote({ id: docSnap.id, ...docSnap.data(), isSharedView: true });
          } else {
            alert("This note is not available or not shared.");
          }
        } catch (e) {
          console.error("Error fetching shared note:", e);
          alert("Failed to load shared note.");
        }
      };
      fetchSharedNote();
    }
  }, []);

  useEffect(() => {
    return () => {
      isManuallyDisconnected.current = true;
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (sessionRef.current) sessionRef.current.disconnect();
      if (audioRef.current) {
        audioRef.current.stopRecording();
        audioRef.current.stopPlayback();
      }
    };
  }, []);

  const startSession = async () => {
    if (sessionState !== 'disconnected') return;

    isManuallyDisconnected.current = false;
    if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      alert("GEMINI_API_KEY is missing!");
      return;
    }

    setMicError(null);
    setSessionState('connecting');

    audioRef.current = new AudioStreamer();
    sessionRef.current = new LiveSession(apiKey);

    sessionRef.current.onStateChange = (newState) => {
      setSessionState(newState);
      if (newState === 'disconnected' && !isManuallyDisconnected.current) {
        // Auto-reconnect
        if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = setTimeout(() => {
          startSessionRef.current();
        }, 1000); // Try to reconnect after 1 second
      }
    };
    
    sessionRef.current.onAudioOutput = (base64Audio) => {
      audioRef.current?.playAudioChunk(base64Audio);
    };

    sessionRef.current.onInterrupted = () => {
      audioRef.current?.stopPlayback();
    };

    audioRef.current.onAudioData = (base64Data) => {
      sessionRef.current?.sendAudio(base64Data);
    };

    audioRef.current.onVolumeChange = (vol) => {
      setVolume(vol);
    };

    sessionRef.current.onSaveNote = async (title, content) => {
      const newNote = {
        title: title || 'Untitled Note',
        content,
        createdAt: new Date().toISOString()
      };
      
      if (user) {
        try {
          const docRef = await addDoc(collection(db, `users/${user.uid}/notes`), {
            uid: user.uid,
            ...newNote
          });
          setIsDrawerOpen(false);
          setSelectedNote({ id: docRef.id, ...newNote });
        } catch (e) {
          handleFirestoreError(e, OperationType.CREATE, `users/${user.uid}/notes`);
        }
      } else {
        // Save temporary note
        const tempNote = { id: Date.now().toString(), ...newNote };
        setTempNotes(prev => [tempNote, ...prev]);
        setIsDrawerOpen(false);
        setSelectedNote(tempNote);
      }
    };

    sessionRef.current.onUpdateNote = async (title, contentToAppend) => {
      const currentNotes = user ? notesRef.current : tempNotesRef.current;
      const existingNote = currentNotes.find(n => n.title.toLowerCase() === title.toLowerCase());
      
      if (existingNote) {
        const newContent = existingNote.content + '\n\n' + contentToAppend;
        
        const updatedNote = { ...existingNote, content: newContent };
        setSelectedNote(updatedNote);
        setIsDrawerOpen(false);
        
        if (user) {
          try {
            await updateDoc(doc(db, `users/${user.uid}/notes`, existingNote.id), {
              content: newContent
            });
          } catch (e) {
            handleFirestoreError(e, OperationType.UPDATE, `users/${user.uid}/notes/${existingNote.id}`);
          }
        } else {
          setTempNotes(prev => prev.map(n => n.id === existingNote.id ? { ...n, content: newContent } : n));
        }
      } else {
        // If note not found, create a new one
        if (sessionRef.current?.onSaveNote) {
          sessionRef.current.onSaveNote(title, contentToAppend);
        }
      }
    };

    sessionRef.current.onOpenUrl = (url) => {
      const newWindow = window.open(url, '_blank');
      if (!newWindow) {
        // If popup is blocked, show UI to user
        setPendingUrl(url);
      }
    };

    try {
      await audioRef.current.startRecording();
      await sessionRef.current.connect();
    } catch (err: any) {
      const isPermissionError = err === 'Permission denied' || err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError' || (err.message && err.message.includes('Permission'));
      
      if (!isPermissionError) {
        console.error("Failed to start session:", err);
      }
      
      setSessionState('disconnected');
      
      if (sessionRef.current) sessionRef.current.disconnect();
      if (audioRef.current) {
        audioRef.current.stopRecording();
        audioRef.current.stopPlayback();
      }

      if (isPermissionError) {
        setMicError("Please allow microphone access to talk to Aasma.");
        
        try {
          navigator.permissions.query({ name: 'microphone' as PermissionName }).then((permissionStatus) => {
            permissionStatus.onchange = () => {
              if (permissionStatus.state === 'granted') {
                setMicError(null);
                startSessionRef.current();
              }
            };
          });
        } catch (e) {
          // Ignore if Permissions API is not supported
        }
      } else {
        setMicError("Could not connect. Please try again.");
      }
    }
  };

  useEffect(() => {
    startSessionRef.current = startSession;
  });

  const stopSession = () => {
    isManuallyDisconnected.current = true;
    if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    if (sessionRef.current) sessionRef.current.disconnect();
    if (audioRef.current) {
      audioRef.current.stopRecording();
      audioRef.current.stopPlayback();
    }
    setSessionState('disconnected');
    setVolume(0);
  };

  const toggleSession = async () => {
    if (sessionState === 'disconnected') {
      startSession();
    } else {
      stopSession();
    }
  };

  const isConnected = sessionState !== 'disconnected';
  const isConnecting = sessionState === 'connecting';
  const isSpeaking = sessionState === 'speaking';
  
  const scale = 1 + Math.min(volume * 8, 0.8);
  
  const downloadPDF = async (note: any) => {
    // Instead of html2canvas which fails on modern CSS colors like oklch,
    // we use the native print dialog which works perfectly and allows saving as PDF.
    window.print();
  };

  const handleShare = async () => {
    if (!selectedNote) return;
    
    let shareUrl = window.location.href;
    
    if (user && !selectedNote.isShared) {
      try {
        await updateDoc(doc(db, `users/${user.uid}/notes`, selectedNote.id), {
          isShared: true
        });
        setSelectedNote({ ...selectedNote, isShared: true });
      } catch (e) {
        console.error("Failed to share note:", e);
        return;
      }
    }
    
    if (user) {
      shareUrl = `${window.location.origin}?userId=${user.uid}&noteId=${selectedNote.id}`;
    }

    try {
      if (navigator.share) {
        await navigator.share({
          title: selectedNote.title,
          text: "Check out this note!",
          url: shareUrl,
        });
      } else {
        await navigator.clipboard.writeText(shareUrl);
        alert("Share link copied to clipboard!");
      }
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        console.error("Share failed:", error);
      }
    }
  };

  const handleDeleteNote = async (noteId: string) => {
    if (user) {
      try {
        await deleteDoc(doc(db, `users/${user.uid}/notes`, noteId));
      } catch (e) {
        handleFirestoreError(e, OperationType.DELETE, `users/${user.uid}/notes/${noteId}`);
      }
    } else {
      setTempNotes(prev => prev.filter(n => n.id !== noteId));
    }
    setSelectedNote(null);
    setShowNoteMenu(false);
  };

  const handleUpdateNote = async () => {
    if (!selectedNote) return;
    if (user) {
      try {
        await updateDoc(doc(db, `users/${user.uid}/notes`, selectedNote.id), {
          title: editTitle,
          content: editContent
        });
        setSelectedNote({ ...selectedNote, title: editTitle, content: editContent });
      } catch (e) {
        handleFirestoreError(e, OperationType.UPDATE, `users/${user.uid}/notes/${selectedNote.id}`);
      }
    } else {
      setTempNotes(prev => prev.map(n => n.id === selectedNote.id ? { ...n, title: editTitle, content: editContent } : n));
      setSelectedNote({ ...selectedNote, title: editTitle, content: editContent });
    }
    setIsEditingNote(false);
  };

  const startEditing = () => {
    setEditTitle(selectedNote.title || '');
    setEditContent(selectedNote.content || '');
    setIsEditingNote(true);
    setShowNoteMenu(false);
  };

  const handleCreateEmptyNote = async () => {
    if (!newNoteTitle.trim()) return;
    const newNote = {
      title: newNoteTitle.trim(),
      content: '',
      createdAt: new Date().toISOString()
    };
    
    if (user) {
      const tempId = 'temp-' + Date.now();
      const optimisticNote = { id: tempId, ...newNote };
      setSelectedNote(optimisticNote);
      try {
        const docRef = await addDoc(collection(db, `users/${user.uid}/notes`), {
          uid: user.uid,
          ...newNote
        });
        setSelectedNote({ id: docRef.id, ...newNote });
      } catch (e) {
        handleFirestoreError(e, OperationType.CREATE, `users/${user.uid}/notes`);
        setSelectedNote(null);
      }
    } else {
      const tempNote = { id: Date.now().toString(), ...newNote };
      setTempNotes(prev => [tempNote, ...prev]);
      setSelectedNote(tempNote);
    }
    setShowCreateNoteModal(false);
    setNewNoteTitle('');
    setIsDrawerOpen(false);
  };

  const handleCopyNote = async () => {
    if (!selectedNote) return;
    try {
      await navigator.clipboard.writeText(`${selectedNote.title}\n\n${selectedNote.content}`);
    } catch (err) {
      console.error('Failed to copy', err);
    }
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setAnalyzeImage(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setAnalyzeImagePreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleAnalyzeNote = async () => {
    if (!selectedNote) return;
    setIsAnalyzing(true);
    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("GEMINI_API_KEY is missing");
      
      const ai = new GoogleGenAI({ apiKey });
      
      let imagePart = null;
      if (analyzeImagePreview && analyzeImage) {
        const base64Data = analyzeImagePreview.split(',')[1];
        imagePart = {
          inlineData: {
            data: base64Data,
            mimeType: analyzeImage.type
          }
        };
      }

      const promptText = `You are an AI assistant analyzing a note.
      Note Title: ${selectedNote.title}
      Note Content: ${selectedNote.content}
      
      User Topic: ${analyzePrompt}
      User Instruction: ${analyzeInstruction}
      
      Instructions:
      - Analyze deeply based on the request and any provided image.
      - If an image is provided, describe it and use it in the note generation.
      - Generate a structured note (Headings, Sub-points, Highlight important lines with bold/italic).
      - Detect the language of the user instruction and respond in the SAME language.
      - Return ONLY the generated markdown content.`;

      const contents = imagePart ? [promptText, imagePart] : [promptText];

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: contents
      });
      
      const aiText = response.text || '';
      setAnalyzeResult(aiText);
      
    } catch (e) {
      console.error("Analysis failed", e);
      alert("Failed to analyze note. Please try again.");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const applyAnalyzeResult = async (mode: 'replace' | 'append') => {
    if (!selectedNote || !analyzeResult) return;
    
    let newContent = '';
    if (mode === 'replace') {
      newContent = analyzeResult;
    } else {
      newContent = selectedNote.content + '\n\n---\n**AI Analysis:**\n\n' + analyzeResult;
    }

    const updatedNote = { ...selectedNote, content: newContent };
    setSelectedNote(updatedNote);
    
    if (user) {
      try {
        await updateDoc(doc(db, `users/${user.uid}/notes`, selectedNote.id), {
          content: newContent
        });
      } catch (e) {
        handleFirestoreError(e, OperationType.UPDATE, `users/${user.uid}/notes/${selectedNote.id}`);
      }
    } else {
      setTempNotes(prev => prev.map(n => n.id === selectedNote.id ? { ...n, content: newContent } : n));
    }
    
    setShowAnalyzeModal(false);
    setAnalyzeResult(null);
    setAnalyzePrompt('');
    setAnalyzeInstruction('');
    setAnalyzeImage(null);
    setAnalyzeImagePreview(null);
  };

  const allNotes = user ? notes : tempNotes;

  return (
    <div className="min-h-screen bg-neutral-950 text-white flex flex-col items-center justify-center overflow-hidden relative font-sans">
      <FloatingMic sessionState={sessionState} volume={volume} onToggle={toggleSession} />
      
      {/* Top Bar for Auth & Profile */}
      <div className="absolute top-0 w-full p-4 flex justify-between items-center z-40">
        <div className="flex items-center gap-4">
          {user ? (
            <button 
              onClick={() => setIsDrawerOpen(true)}
              className="flex items-center justify-center w-10 h-10 bg-zinc-900 hover:bg-zinc-800 rounded-full transition-colors border border-white/10 overflow-hidden"
            >
              {user.photoURL ? (
                <img src={user.photoURL} alt="Profile" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
              ) : (
                <UserIcon className="w-5 h-5 text-zinc-400" />
              )}
            </button>
          ) : (
            <button 
              onClick={() => setIsDrawerOpen(true)}
              className="flex items-center justify-center w-10 h-10 bg-zinc-900 hover:bg-zinc-800 rounded-full transition-colors border border-white/10"
            >
              <UserIcon className="w-5 h-5 text-zinc-400" />
            </button>
          )}
        </div>
        <div>
          {!user && (
            <button 
              onClick={login}
              className="flex items-center gap-2 px-4 py-2 bg-white text-black hover:bg-zinc-200 rounded-full text-sm font-medium transition-colors"
            >
              <LogIn className="w-4 h-4" />
              Sign in with Google
            </button>
          )}
        </div>
      </div>

      {/* Sliding Drawer */}
      <AnimatePresence>
        {isDrawerOpen && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsDrawerOpen(false)}
              className="fixed inset-0 bg-black/60 z-40 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ x: -350 }}
              animate={{ x: 0 }}
              exit={{ x: -350 }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="fixed left-0 top-0 bottom-0 w-80 bg-zinc-950 border-r border-white/10 z-50 flex flex-col shadow-2xl"
            >
              <div className="p-6 border-b border-white/10 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {user?.photoURL ? (
                    <img src={user.photoURL} alt="Profile" className="w-10 h-10 rounded-full" referrerPolicy="no-referrer" />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center">
                      <UserIcon className="w-5 h-5 text-zinc-400" />
                    </div>
                  )}
                  <div className="flex flex-col">
                    <span className="font-medium text-sm">{user ? user.displayName : 'Guest User'}</span>
                    <span className="text-xs text-zinc-500">{user ? user.email : 'Temporary Session'}</span>
                  </div>
                </div>
                <button onClick={() => setIsDrawerOpen(false)} className="p-2 hover:bg-zinc-800 rounded-full transition-colors">
                  <X className="w-5 h-5 text-zinc-400" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-4">
                <div className="flex items-center justify-between mb-4 px-2">
                  <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Your Notes</h3>
                  <button 
                    onClick={() => setShowCreateNoteModal(true)}
                    className="p-1 hover:bg-zinc-800 rounded text-zinc-400 hover:text-white transition-colors"
                    title="Create Note"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
                <div className="flex flex-col gap-2">
                  {allNotes.map(note => (
                    <button 
                      key={note.id} 
                      onClick={() => setSelectedNote(note)}
                      className="flex items-center justify-between p-3 rounded-xl hover:bg-zinc-900 transition-colors text-left group"
                    >
                      <div className="flex flex-col overflow-hidden">
                        <span className="text-sm font-medium text-zinc-200 truncate">{note.title || 'Untitled Note'}</span>
                        <span className="text-xs text-zinc-500">{new Date(note.createdAt).toLocaleDateString()}</span>
                      </div>
                      <ChevronRight className="w-4 h-4 text-zinc-600 group-hover:text-zinc-300 transition-colors" />
                    </button>
                  ))}
                  {allNotes.length === 0 && (
                    <div className="px-2 py-4 text-sm text-zinc-500 italic">
                      No notes yet. Ask Aasma to "Create a note about..."
                    </div>
                  )}
                </div>
              </div>

              {user && (
                <div className="p-4 border-t border-white/10">
                  <button 
                    onClick={() => {
                      logout();
                      setIsDrawerOpen(false);
                    }}
                    className="flex items-center gap-2 w-full px-4 py-3 text-red-400 hover:bg-red-400/10 rounded-xl transition-colors text-sm font-medium"
                  >
                    <LogOut className="w-4 h-4" />
                    Logout
                  </button>
                </div>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Note Detail Modal */}
      <AnimatePresence>
        {selectedNote && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelectedNote(null)}
              className="fixed inset-0 bg-black/80 z-[60] backdrop-blur-sm flex items-center justify-center p-4 md:p-8"
            >
              <motion.div 
                initial={{ opacity: 0, scale: 0.95, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 20 }}
                onClick={(e) => e.stopPropagation()}
                className="bg-zinc-950 md:border border-white/10 md:rounded-2xl w-full h-full md:h-[90vh] max-w-5xl flex flex-col shadow-2xl overflow-hidden"
              >
                <div className="p-4 md:p-6 border-b border-white/10 flex items-center justify-between bg-zinc-900/50 backdrop-blur-md">
                  {isEditingNote ? (
                    <input 
                      value={editTitle}
                      onChange={e => setEditTitle(e.target.value)}
                      className="bg-zinc-800 text-white px-3 py-1.5 rounded-lg border border-white/10 w-full max-w-sm mr-4 focus:outline-none focus:ring-2 focus:ring-fuchsia-500/50"
                    />
                  ) : (
                    <h2 className="text-xl font-semibold text-white truncate pr-4">{selectedNote.title || 'Note'}</h2>
                  )}
                  
                  <div className="flex items-center gap-1 md:gap-2 shrink-0 relative">
                    {isEditingNote ? (
                      <>
                        <button onClick={handleUpdateNote} className="flex items-center gap-2 px-3 py-1.5 bg-green-500/10 text-green-400 hover:bg-green-500/20 rounded-lg text-sm font-medium transition-colors">
                          <Save className="w-4 h-4" /> <span className="hidden sm:inline">Save</span>
                        </button>
                        <button onClick={() => setIsEditingNote(false)} className="flex items-center gap-2 px-3 py-1.5 bg-zinc-800 text-zinc-300 hover:bg-zinc-700 rounded-lg text-sm font-medium transition-colors">
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <div className="relative">
                          <button onClick={() => setShowNoteMenu(!showNoteMenu)} className="p-2 hover:bg-zinc-800 rounded-lg transition-colors text-zinc-400">
                            <MoreVertical className="w-5 h-5" />
                          </button>
                          {showNoteMenu && (
                            <div className="absolute right-0 mt-2 w-48 bg-zinc-800 border border-white/10 rounded-xl shadow-xl overflow-hidden z-50">
                              <button onClick={() => { downloadPDF(selectedNote); setShowNoteMenu(false); }} className="w-full text-left px-4 py-3 text-sm text-zinc-300 hover:bg-zinc-700 flex items-center gap-2 transition-colors">
                                <Download className="w-4 h-4" /> Download PDF
                              </button>
                              <button onClick={() => { handleCopyNote(); setShowNoteMenu(false); }} className="w-full text-left px-4 py-3 text-sm text-zinc-300 hover:bg-zinc-700 flex items-center gap-2 transition-colors">
                                <Copy className="w-4 h-4" /> Copy Content
                              </button>
                              
                              {!selectedNote.isSharedView && (
                                <>
                                  <button onClick={() => { handleShare(); setShowNoteMenu(false); }} className="w-full text-left px-4 py-3 text-sm text-zinc-300 hover:bg-zinc-700 flex items-center gap-2 transition-colors">
                                    <Share className="w-4 h-4" /> Share Link
                                  </button>
                                  <button onClick={() => { startEditing(); setShowNoteMenu(false); }} className="w-full text-left px-4 py-3 text-sm text-zinc-300 hover:bg-zinc-700 flex items-center gap-2 transition-colors">
                                    <Edit2 className="w-4 h-4" /> Edit Note
                                  </button>
                                  <button onClick={() => { setShowAnalyzeModal(true); setShowNoteMenu(false); }} className="w-full text-left px-4 py-3 text-sm text-fuchsia-400 hover:bg-zinc-700 flex items-center gap-2 transition-colors">
                                    <Sparkles className="w-4 h-4" /> AI Analyze
                                  </button>
                                  <div className="h-px bg-white/10 my-1"></div>
                                  <button onClick={() => { handleDeleteNote(selectedNote.id); setShowNoteMenu(false); }} className="w-full text-left px-4 py-3 text-sm text-red-400 hover:bg-zinc-700 flex items-center gap-2 transition-colors">
                                    <Trash2 className="w-4 h-4" /> Delete Note
                                  </button>
                                </>
                              )}
                            </div>
                          )}
                        </div>

                        <button onClick={() => { setSelectedNote(null); setIsEditingNote(false); setShowNoteMenu(false); }} className="p-2 hover:bg-zinc-800 rounded-lg transition-colors ml-2 bg-zinc-800/50">
                          <X className="w-5 h-5 text-white" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <div className="p-6 md:p-8 overflow-y-auto bg-zinc-900 flex-1 print-content" ref={noteContentRef}>
                  {isEditingNote ? (
                    <textarea
                      value={editContent}
                      onChange={e => setEditContent(e.target.value)}
                      className="w-full h-full min-h-[300px] bg-zinc-800 text-white p-4 rounded-xl border border-white/10 resize-none focus:outline-none focus:ring-2 focus:ring-fuchsia-500/50"
                    />
                  ) : (
                    <div className="prose prose-invert prose-fuchsia max-w-none">
                      <Markdown remarkPlugins={[remarkGfm]}>{selectedNote.content}</Markdown>
                    </div>
                  )}
                  {!isEditingNote && (
                    <div className="mt-8 pt-4 border-t border-white/5 text-xs text-zinc-500">
                      Created on {new Date(selectedNote.createdAt).toLocaleString()}
                    </div>
                  )}
                </div>
              </motion.div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <motion.div 
        className="absolute inset-0 bg-gradient-to-br from-fuchsia-900/20 via-neutral-950 to-cyan-900/20"
        animate={{
          opacity: isConnected ? 1 : 0.5,
        }}
        transition={{ duration: 2 }}
      />

      <div className="z-10 flex flex-col items-center gap-16">
        <div className="text-center space-y-4 flex flex-col items-center">
          <div className="relative flex justify-center items-center">
            <h1 className="text-6xl md:text-7xl font-light tracking-[0.3em] text-transparent bg-clip-text bg-gradient-to-r from-fuchsia-400 via-indigo-400 to-cyan-400 relative z-10 pl-[0.3em]">
              AASMA
            </h1>
            <div className="absolute inset-0 text-6xl md:text-7xl font-light tracking-[0.3em] text-transparent bg-clip-text bg-gradient-to-r from-fuchsia-400 via-indigo-400 to-cyan-400 blur-xl opacity-60 pl-[0.3em]" aria-hidden="true">
              AASMA
            </div>
          </div>
          <p className="text-neutral-400 text-xs tracking-[0.3em] uppercase">
            {sessionState}
          </p>
        </div>

        {micError && (
          <motion.div 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-center gap-2 text-sm text-fuchsia-400 bg-fuchsia-400/10 px-6 py-3 rounded-full border border-fuchsia-400/20 shadow-lg"
          >
            <AlertCircle className="w-5 h-5" />
            {micError}
          </motion.div>
        )}

        {pendingUrl && (
          <motion.div 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center gap-3 bg-zinc-900/80 backdrop-blur-md px-6 py-4 rounded-2xl border border-white/10 shadow-2xl z-50"
          >
            <p className="text-sm text-zinc-300">Aasma wants to open a link:</p>
            <button 
              onClick={() => {
                window.open(pendingUrl, '_blank');
                setPendingUrl(null);
              }}
              className="bg-white text-black px-6 py-2 rounded-full text-sm font-medium hover:bg-zinc-200 transition-colors"
            >
              Click to Open
            </button>
          </motion.div>
        )}

        <div className="relative flex items-center justify-center w-72 h-72">
          {isConnected && (
            <>
              <motion.div
                className="absolute inset-0 rounded-full border border-fuchsia-500/20"
                animate={{
                  scale: isSpeaking ? [1, 1.2, 1] : [1, 1.05, 1],
                  opacity: isSpeaking ? [0.3, 0.8, 0.3] : [0.2, 0.5, 0.2],
                }}
                transition={{
                  duration: isSpeaking ? 1.5 : 3,
                  repeat: Infinity,
                  ease: "easeInOut",
                }}
              />
              <motion.div
                className="absolute inset-8 rounded-full border border-cyan-500/20"
                animate={{
                  scale: isSpeaking ? [1, 1.4, 1] : scale,
                  opacity: isSpeaking ? [0.2, 0.6, 0.2] : [0.1, 0.4, 0.1],
                }}
                transition={{
                  duration: isSpeaking ? 2 : 0.1,
                  repeat: isSpeaking ? Infinity : 0,
                  ease: "easeInOut",
                }}
              />
              <motion.div
                className="absolute inset-16 rounded-full bg-gradient-to-tr from-fuchsia-500/10 to-cyan-500/10 blur-xl"
                animate={{
                  scale: isSpeaking ? [1, 1.5, 1] : scale,
                  opacity: isSpeaking ? [0.5, 1, 0.5] : [0.3, 0.6, 0.3],
                }}
                transition={{
                  duration: isSpeaking ? 1 : 0.1,
                  repeat: isSpeaking ? Infinity : 0,
                  ease: "easeInOut",
                }}
              />
            </>
          )}

          <motion.button
            onClick={toggleSession}
            disabled={isConnecting}
            className={`relative z-10 w-28 h-28 rounded-full flex items-center justify-center transition-all duration-500 ${
              isConnected 
                ? 'bg-gradient-to-br from-fuchsia-600 to-cyan-600 shadow-[0_0_60px_rgba(192,38,211,0.5)]' 
                : 'bg-neutral-900 border border-neutral-800 hover:bg-neutral-800 shadow-2xl'
            }`}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            {isConnecting ? (
              <Loader2 className="w-10 h-10 text-white animate-spin" />
            ) : isConnected ? (
              <Mic className="w-10 h-10 text-white" />
            ) : (
              <MicOff className="w-10 h-10 text-neutral-500" />
            )}
          </motion.button>
        </div>
      </div>

      <AnimatePresence>
        {showCreateNoteModal && (
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/80 z-[70] backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.div 
              initial={{ scale: 0.95 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }}
              className="bg-zinc-900 border border-white/10 rounded-2xl w-full max-w-md p-6 shadow-2xl"
            >
              <h2 className="text-xl font-semibold text-white mb-4">Create New Note</h2>
              <input 
                autoFocus
                value={newNoteTitle}
                onChange={e => setNewNoteTitle(e.target.value)}
                placeholder="Note Title..."
                className="w-full bg-zinc-800 text-white px-4 py-3 rounded-xl border border-white/10 focus:outline-none focus:ring-2 focus:ring-fuchsia-500/50 mb-6"
                onKeyDown={e => e.key === 'Enter' && handleCreateEmptyNote()}
              />
              <div className="flex justify-end gap-3">
                <button onClick={() => setShowCreateNoteModal(false)} className="px-4 py-2 text-zinc-400 hover:text-white transition-colors">Cancel</button>
                <button onClick={handleCreateEmptyNote} className="px-4 py-2 bg-fuchsia-600 hover:bg-fuchsia-500 text-white rounded-xl font-medium transition-colors">Save Note</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showAnalyzeModal && (
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/80 z-[70] backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.div 
              initial={{ scale: 0.95 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }}
              className="bg-zinc-900 border border-white/10 rounded-2xl w-full max-w-lg p-6 shadow-2xl max-h-[90vh] overflow-y-auto"
            >
              <div className="flex items-center gap-2 mb-4">
                <Sparkles className="w-5 h-5 text-fuchsia-400" />
                <h2 className="text-xl font-semibold text-white">AI Analyze</h2>
              </div>
              
              {!analyzeResult ? (
                <>
                  <p className="text-sm text-zinc-400 mb-4">Ask Aasma to summarize, extract points, or translate this note.</p>
                  
                  <div className="space-y-4 mb-6">
                    <div>
                      <label className="block text-xs font-medium text-zinc-500 mb-1">Topic / Request</label>
                      <input 
                        autoFocus
                        value={analyzePrompt}
                        onChange={e => setAnalyzePrompt(e.target.value)}
                        placeholder="e.g., Summarize this note"
                        className="w-full bg-zinc-800 text-white px-4 py-3 rounded-xl border border-white/10 focus:outline-none focus:ring-2 focus:ring-fuchsia-500/50"
                      />
                    </div>
                    
                    <div>
                      <label className="block text-xs font-medium text-zinc-500 mb-1">Special Instructions (Optional)</label>
                      <input 
                        value={analyzeInstruction}
                        onChange={e => setAnalyzeInstruction(e.target.value)}
                        placeholder="e.g., Make it colorful, add images, explain in Hindi"
                        className="w-full bg-zinc-800 text-white px-4 py-3 rounded-xl border border-white/10 focus:outline-none focus:ring-2 focus:ring-fuchsia-500/50"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-zinc-500 mb-1">Upload Image (Optional)</label>
                      <input 
                        type="file"
                        accept="image/*"
                        onChange={handleImageUpload}
                        className="w-full text-sm text-zinc-400 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-fuchsia-500/10 file:text-fuchsia-400 hover:file:bg-fuchsia-500/20"
                      />
                      {analyzeImagePreview && (
                        <div className="mt-2 relative inline-block">
                          <img src={analyzeImagePreview} alt="Preview" className="h-20 rounded-lg border border-white/10" />
                          <button onClick={() => { setAnalyzeImage(null); setAnalyzeImagePreview(null); }} className="absolute -top-2 -right-2 bg-zinc-800 rounded-full p-1 border border-white/10 hover:bg-zinc-700">
                            <X className="w-3 h-3 text-white" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex justify-end gap-3">
                    <button onClick={() => setShowAnalyzeModal(false)} className="px-4 py-2 text-zinc-400 hover:text-white transition-colors" disabled={isAnalyzing}>Cancel</button>
                    <button onClick={handleAnalyzeNote} disabled={isAnalyzing || !analyzePrompt.trim()} className="flex items-center gap-2 px-4 py-2 bg-fuchsia-600 hover:bg-fuchsia-500 disabled:opacity-50 text-white rounded-xl font-medium transition-colors">
                      {isAnalyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                      {isAnalyzing ? 'Analyzing...' : 'Analyze'}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="mb-6 max-h-60 overflow-y-auto bg-zinc-950 p-4 rounded-xl border border-white/10 prose prose-invert prose-sm prose-fuchsia">
                    <Markdown remarkPlugins={[remarkGfm]}>{analyzeResult}</Markdown>
                  </div>
                  <div className="flex flex-col sm:flex-row justify-end gap-3">
                    <button onClick={() => { setAnalyzeResult(null); setShowAnalyzeModal(false); }} className="px-4 py-2 text-zinc-400 hover:text-white transition-colors">Cancel</button>
                    <button onClick={() => applyAnalyzeResult('append')} className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl font-medium transition-colors border border-white/10">Add Below</button>
                    <button onClick={() => applyAnalyzeResult('replace')} className="px-4 py-2 bg-fuchsia-600 hover:bg-fuchsia-500 text-white rounded-xl font-medium transition-colors">Replace Content</button>
                  </div>
                </>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <MainApp />
    </AuthProvider>
  );
}
