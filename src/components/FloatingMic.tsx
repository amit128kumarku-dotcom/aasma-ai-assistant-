import React from 'react';
import { motion } from 'motion/react';
import { Mic, MicOff, Loader2 } from 'lucide-react';
import { SessionState } from '../lib/live-session';

interface FloatingMicProps {
  sessionState: SessionState;
  volume: number;
  onToggle: () => void;
}

export const FloatingMic: React.FC<FloatingMicProps> = ({ sessionState, volume, onToggle }) => {
  const isConnected = sessionState === 'listening' || sessionState === 'speaking';
  const isConnecting = sessionState === 'connecting';
  const isListening = sessionState === 'listening';
  const isSpeaking = sessionState === 'speaking';

  let statusText = "Disconnected";
  if (isConnecting) statusText = "Connecting...";
  else if (isListening) statusText = "Listening...";
  else if (isSpeaking) statusText = "Active";

  return (
    <motion.div
      drag
      dragMomentum={false}
      initial={{ x: window.innerWidth - 150, y: window.innerHeight - 100 }}
      className="fixed z-50 cursor-grab active:cursor-grabbing flex items-center gap-3 bg-zinc-900/80 backdrop-blur-md p-2 rounded-full border border-white/10 shadow-2xl"
      style={{ touchAction: 'none' }}
    >
      <div className="relative group">
        {/* Glow effect when active */}
        {isConnected && (
          <div 
            className="absolute -inset-4 bg-fuchsia-500/30 rounded-full blur-xl transition-all duration-100"
            style={{ 
              transform: `scale(${1 + volume * 2})`,
              opacity: 0.5 + volume
            }}
          />
        )}
        
        <button
          onClick={onToggle}
          className={`relative flex items-center justify-center w-12 h-12 rounded-full shadow-2xl transition-all duration-300 border border-white/10 ${
            isConnected 
              ? 'bg-gradient-to-br from-fuchsia-500 to-indigo-600 text-white' 
              : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
          }`}
        >
          {isConnecting ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : isConnected ? (
            <Mic className="w-5 h-5" />
          ) : (
            <MicOff className="w-5 h-5" />
          )}
        </button>
      </div>
      
      <div className="pr-4 flex flex-col justify-center">
        <span className="text-xs font-semibold text-white tracking-wider uppercase">
          {statusText}
        </span>
        {isConnected && (
          <span className="text-[10px] text-zinc-400">
            {isListening ? "Aasma is listening" : "Aasma is speaking"}
          </span>
        )}
      </div>
    </motion.div>
  );
};
