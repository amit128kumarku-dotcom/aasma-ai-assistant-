import { useState, useEffect, useRef } from 'react';
import { Mic, MicOff, Loader2 } from 'lucide-react';
import { motion } from 'motion/react';
import { LiveSession, SessionState } from './lib/live-session';
import { AudioStreamer } from './lib/audio-streamer';

export default function App() {
  const [sessionState, setSessionState] = useState<SessionState>('disconnected');
  const [volume, setVolume] = useState(0);
  
  const sessionRef = useRef<LiveSession | null>(null);
  const audioRef = useRef<AudioStreamer | null>(null);

  useEffect(() => {
    return () => {
      if (sessionRef.current) sessionRef.current.disconnect();
      if (audioRef.current) {
        audioRef.current.stopRecording();
        audioRef.current.stopPlayback();
      }
    };
  }, []);

  const toggleSession = async () => {
    if (sessionState === 'disconnected') {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        alert("GEMINI_API_KEY is missing!");
        return;
      }

      audioRef.current = new AudioStreamer();
      sessionRef.current = new LiveSession(apiKey);

      sessionRef.current.onStateChange = setSessionState;
      
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

      try {
        await audioRef.current.startRecording();
        await sessionRef.current.connect();
      } catch (err) {
        console.error("Failed to start session:", err);
        setSessionState('disconnected');
      }

    } else {
      if (sessionRef.current) sessionRef.current.disconnect();
      if (audioRef.current) {
        audioRef.current.stopRecording();
        audioRef.current.stopPlayback();
      }
      setSessionState('disconnected');
      setVolume(0);
    }
  };

  const isConnected = sessionState !== 'disconnected';
  const isConnecting = sessionState === 'connecting';
  const isSpeaking = sessionState === 'speaking';
  
  const scale = 1 + Math.min(volume * 8, 0.8);
  
  return (
    <div className="min-h-screen bg-neutral-950 text-white flex flex-col items-center justify-center overflow-hidden relative font-sans">
      <motion.div 
        className="absolute inset-0 bg-gradient-to-br from-fuchsia-900/20 via-neutral-950 to-cyan-900/20"
        animate={{
          opacity: isConnected ? 1 : 0.5,
        }}
        transition={{ duration: 2 }}
      />

      <div className="z-10 flex flex-col items-center gap-16">
        <div className="text-center space-y-3">
          <h1 className="text-5xl font-light tracking-[0.2em] text-transparent bg-clip-text bg-gradient-to-r from-fuchsia-400 to-cyan-400">
            AASMA
          </h1>
          <p className="text-neutral-400 text-xs tracking-[0.3em] uppercase">
            {sessionState}
          </p>
        </div>

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
    </div>
  );
}
