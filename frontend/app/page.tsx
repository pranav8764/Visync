'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import { useStore } from '@/lib/useStore';
import InteractiveGrid from '@/components/InteractiveGrid';
import HeroGraphic from '@/components/HeroGraphic';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function Home() {
  const router = useRouter();
  const [nickname, setNickname] = useState('');
  const [roomName, setRoomName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [activeTab, setActiveTab] = useState<'create' | 'join'>('create');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Extract shared link parameters and pre-populate creative random nickname on mount
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const savedNickname = localStorage.getItem('visync_nickname');
      if (savedNickname) {
        setNickname(savedNickname);
      } else {
        const adjectives = ['Creative', 'Swift', 'Vibrant', 'Artistic', 'Electric', 'Active', 'Dynamic', 'Genius', 'Clever', 'Radiant'];
        const animals = ['Owl', 'Falcon', 'Fox', 'Koala', 'Panda', 'Dolphin', 'Otter', 'Panther', 'Tiger', 'Badger'];
        const randAdj = adjectives[Math.floor(Math.random() * adjectives.length)];
        const randAnim = animals[Math.floor(Math.random() * animals.length)];
        setNickname(`${randAdj} ${randAnim}`);
      }
    }

    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');
      if (code) {
        setRoomCode(code);
        setActiveTab('join');
      }
    }
  }, []);

  const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';

  const handleCreateRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nickname.trim()) {
      setError('Please enter a username or nickname.');
      return;
    }
    if (!roomName.trim()) {
      setError('Please enter a collaboration board name.');
      return;
    }

    setError('');
    setLoading(true);

    try {
      const res = await axios.post(`${apiBaseUrl}/api/rooms`, {
        name: roomName.trim(),
        createdBy: nickname.trim(),
      });

      const room = res.data;
      
      const store = useStore.getState();
      store.setUsername(nickname.trim());
      store.setRoomName(room.name);
      store.setRoomId(room.id);
      localStorage.setItem('visync_nickname', nickname.trim());

      router.push(`/room/${room.id}`);
    } catch (err: any) {
      console.error(err);
      setError(
        err.response?.data?.message || 
        'Failed to connect to the backend server. Make sure it is running on port 8080.'
      );
      setLoading(false);
    }
  };

  const handleJoinRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nickname.trim()) {
      setError('Please enter a username or nickname.');
      return;
    }
    if (!roomCode.trim()) {
      setError('Please enter a collaboration room code.');
      return;
    }

    setError('');
    setLoading(true);

    try {
      const cleanedCode = roomCode.trim();

      const res = await axios.get(`${apiBaseUrl}/api/rooms/${cleanedCode}`);
      const room = res.data;

      const store = useStore.getState();
      store.setUsername(nickname.trim());
      store.setRoomName(room.name);
      store.setRoomId(room.id);
      localStorage.setItem('visync_nickname', nickname.trim());

      router.push(`/room/${room.id}`);
    } catch (err: any) {
      console.error(err);
      setError(
        err.response?.status === 404
          ? 'Room not found. Please verify the room code.'
          : 'Failed to connect to the server. Please verify the code and try again.'
      );
      setLoading(false);
    }
  };

  const isValidUUID = UUID_REGEX.test(roomCode.trim());

  return (
    <div className="min-h-[100dvh] w-full flex flex-col justify-center items-center relative p-4 select-none overflow-x-hidden bg-radial-ambient">
      
      {/* Background Interactive Layer */}
      <InteractiveGrid />

      {/* Visync Logo & Header */}
      <div className="flex flex-col items-center mb-8 text-center z-10 pt-8 sm:pt-0">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: "easeOut" }}
          className="flex items-center gap-3 mb-3"
        >
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-zinc-700 via-zinc-800 to-zinc-950 border border-zinc-600/50 flex items-center justify-center shadow-lg shadow-black/50">
            <svg className="w-7 h-7 text-zinc-200" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="m12 3-1.912 5.886a1 1 0 0 1-.95.69H2.93a1 1 0 0 0-.588 1.8l5.022 3.655a1 1 0 0 1 .363 1.118l-1.913 5.885a1 1 0 0 0 1.54 1.118l5.023-3.654a1 1 0 0 1 1.176 0l5.023 3.654a1 1 0 0 0 1.54-1.118l-1.913-5.885a1 1 0 0 1 .363-1.118l5.022-3.656a1 1 0 0 0-.587-1.8h-6.206a1 1 0 0 1-.951-.69L12 3Z" />
            </svg>
          </div>
          <span className="text-4xl font-extrabold tracking-tight bg-gradient-to-r from-white via-zinc-300 to-zinc-500 bg-clip-text text-transparent">
            Visync
          </span>
        </motion.div>
        <motion.p 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3, duration: 0.6 }}
          className="text-zinc-400 text-sm max-w-sm tracking-wide"
        >
          Realtime Collaborative Whiteboard & Instant Drawing Workspace
        </motion.p>
      </div>

      <HeroGraphic />

      {/* Main Glass Form Card */}
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ delay: 0.2, duration: 0.5, ease: "easeOut" }}
        className="w-full max-w-md glass-panel rounded-2xl overflow-hidden p-6 relative border-t border-white/10 z-10 group"
      >
        {/* Tab Selection */}
        <div className="flex relative p-1 bg-black/40 rounded-xl mb-6 border border-white/5">
          <button
            type="button"
            onClick={() => { setActiveTab('create'); setError(''); }}
            className={`flex-1 relative z-10 py-2.5 rounded-lg text-sm font-medium tracking-wide transition-colors ${
              activeTab === 'create' ? 'text-white' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Create New Board
          </button>
          <button
            type="button"
            onClick={() => { setActiveTab('join'); setError(''); }}
            className={`flex-1 relative z-10 py-2.5 rounded-lg text-sm font-medium tracking-wide transition-colors ${
              activeTab === 'join' ? 'text-white' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Join Existing
          </button>
          
          {/* Animated Tab Background */}
          <motion.div
            layoutId="tabIndicator"
            className="absolute top-1 bottom-1 w-[calc(50%-4px)] bg-zinc-800 rounded-lg shadow-md shadow-black/20 border border-white/10"
            animate={{ left: activeTab === 'create' ? 4 : 'calc(50%)' }}
            transition={{ type: 'spring', bounce: 0.2, duration: 0.5 }}
          />
        </div>

        {/* Error Notification Alert */}
        <AnimatePresence>
          {error && (
            <motion.div 
              initial={{ opacity: 0, height: 0, marginBottom: 0 }}
              animate={{ opacity: 1, height: 'auto', marginBottom: 20 }}
              exit={{ opacity: 0, height: 0, marginBottom: 0 }}
              className="p-3 rounded-lg bg-zinc-900/80 border border-red-900/20 text-zinc-300 text-xs flex gap-2 items-start leading-relaxed overflow-hidden shadow-lg shadow-black/40"
            >
              <svg className="w-4 h-4 text-red-500 shrink-0 mt-0.5 animate-pulse" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <div>{error}</div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="relative overflow-hidden min-h-[220px]">
          <AnimatePresence mode="wait">
            {activeTab === 'create' ? (
              <motion.form 
                key="create"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                transition={{ duration: 0.3 }}
                onSubmit={handleCreateRoom} 
                className="space-y-4 absolute inset-0 group/form"
              >
                <div className="space-y-2 transition-opacity duration-300 group-focus-within/form:opacity-50 focus-within:!opacity-100">
                  <label className="text-xs font-semibold tracking-wider text-zinc-400 uppercase">Your Nickname</label>
                  <div className="relative">
                    <input
                      type="text"
                      placeholder="e.g. Alice"
                      maxLength={15}
                      value={nickname}
                      onChange={(e) => setNickname(e.target.value)}
                      className="w-full h-11 px-4 text-sm glass-input pr-10"
                      required
                    />
                    <div className="absolute right-3.5 top-1/2 -translate-y-1/2 text-zinc-500">
                      <svg className="w-4.5 h-4.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
                      </svg>
                    </div>
                  </div>
                </div>

                <div className="space-y-2 transition-opacity duration-300 group-focus-within/form:opacity-50 focus-within:!opacity-100">
                  <label className="text-xs font-semibold tracking-wider text-zinc-400 uppercase">Board Name</label>
                  <div className="relative">
                    <input
                      type="text"
                      placeholder="e.g. Architecture Brainstorm"
                      maxLength={40}
                      value={roomName}
                      onChange={(e) => setRoomName(e.target.value)}
                      className="w-full h-11 px-4 text-sm glass-input pr-10"
                      required
                    />
                    <div className="absolute right-3.5 top-1/2 -translate-y-1/2 text-zinc-500">
                      <svg className="w-4.5 h-4.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 17v-5M12 17V9M15 17v-3" />
                      </svg>
                    </div>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full h-11 rounded-xl bg-gradient-to-r from-zinc-100 to-zinc-300 hover:from-white hover:to-zinc-200 font-bold text-zinc-950 transition-all text-sm flex items-center justify-center gap-2 hover:scale-[1.01] hover:shadow-lg hover:shadow-white/10 active:scale-[0.99] disabled:opacity-50 disabled:scale-100 mt-2 cursor-pointer shadow-[0_4px_20px_rgba(255,255,255,0.08)]"
                >
                  {loading ? (
                    <div className="w-5 h-5 border-2 border-zinc-950 border-t-transparent rounded-full animate-spin"></div>
                  ) : (
                    <>
                      <span>Launch Board</span>
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
                      </svg>
                    </>
                  )}
                </button>
              </motion.form>
            ) : (
              <motion.form 
                key="join"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.3 }}
                onSubmit={handleJoinRoom} 
                className="space-y-4 absolute inset-0 group/form"
              >
                <div className="space-y-2 transition-opacity duration-300 group-focus-within/form:opacity-50 focus-within:!opacity-100">
                  <label className="text-xs font-semibold tracking-wider text-zinc-400 uppercase">Your Nickname</label>
                  <div className="relative">
                    <input
                      type="text"
                      placeholder="e.g. Bob"
                      maxLength={15}
                      value={nickname}
                      onChange={(e) => setNickname(e.target.value)}
                      className="w-full h-11 px-4 text-sm glass-input pr-10"
                      required
                    />
                    <div className="absolute right-3.5 top-1/2 -translate-y-1/2 text-zinc-500">
                      <svg className="w-4.5 h-4.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
                      </svg>
                    </div>
                  </div>
                </div>

                <div className="space-y-2 transition-opacity duration-300 group-focus-within/form:opacity-50 focus-within:!opacity-100">
                  <label className="text-xs font-semibold tracking-wider text-zinc-400 uppercase">Board Invite Code</label>
                  <div className="relative">
                    <input
                      type="text"
                      placeholder="Paste UUID Room Code"
                      value={roomCode}
                      onChange={(e) => setRoomCode(e.target.value)}
                      className="w-full h-11 px-4 text-sm glass-input pr-10"
                      required
                    />
                    <div className="absolute right-3.5 top-1/2 -translate-y-1/2">
                      <AnimatePresence mode="wait">
                        {isValidUUID ? (
                          <motion.svg key="check" initial={{ opacity: 0, scale: 0 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0 }} className="w-4.5 h-4.5 text-zinc-200" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12"></polyline>
                          </motion.svg>
                        ) : (
                          <motion.svg key="icon" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="w-4.5 h-4.5 text-zinc-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                          </motion.svg>
                        )}
                      </AnimatePresence>
                    </div>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full h-11 rounded-xl bg-gradient-to-r from-zinc-100 to-zinc-300 hover:from-white hover:to-zinc-200 font-bold text-zinc-950 transition-all text-sm flex items-center justify-center gap-2 hover:scale-[1.01] hover:shadow-lg hover:shadow-white/10 active:scale-[0.99] disabled:opacity-50 disabled:scale-100 mt-2 cursor-pointer shadow-[0_4px_20px_rgba(255,255,255,0.08)]"
                >
                  {loading ? (
                    <div className="w-5 h-5 border-2 border-zinc-950 border-t-transparent rounded-full animate-spin"></div>
                  ) : (
                    <>
                      <span>Join Board Session</span>
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
                      </svg>
                    </>
                  )}
                </button>
              </motion.form>
            )}
          </AnimatePresence>
        </div>
      </motion.div>

      {/* Sleek Feature Showcases Footer */}
      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.6, duration: 0.8 }}
        className="mt-12 flex flex-wrap justify-center gap-3 max-w-2xl text-center px-4 z-10"
      >
        <div className="flex items-center gap-2 text-[11px] font-medium text-zinc-400 bg-zinc-900/30 px-3.5 py-1.5 rounded-full border border-white/5 backdrop-blur-sm hover:border-white/10 transition-all cursor-default select-none">
          <svg className="w-3.5 h-3.5 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
          <span>Realtime Vector Sync</span>
        </div>
        <div className="flex items-center gap-2 text-[11px] font-medium text-zinc-400 bg-zinc-900/30 px-3.5 py-1.5 rounded-full border border-white/5 backdrop-blur-sm hover:border-white/10 transition-all cursor-default select-none">
          <svg className="w-3.5 h-3.5 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
          <span>Interactive Shape Docks</span>
        </div>
        <div className="flex items-center gap-2 text-[11px] font-medium text-zinc-400 bg-zinc-900/30 px-3.5 py-1.5 rounded-full border border-white/5 backdrop-blur-sm hover:border-white/10 transition-all cursor-default select-none">
          <svg className="w-3.5 h-3.5 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
          <span>Live Cursors & Chat</span>
        </div>
        <div className="flex items-center gap-2 text-[11px] font-medium text-zinc-400 bg-zinc-900/30 px-3.5 py-1.5 rounded-full border border-white/5 backdrop-blur-sm hover:border-white/10 transition-all cursor-default select-none">
          <svg className="w-3.5 h-3.5 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
          <span>DB History Recovery</span>
        </div>
      </motion.div>
      
      {/* System Status Badge */}
      <motion.div 
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 1, duration: 0.5 }}
        className="absolute bottom-6 flex items-center gap-2 bg-zinc-900/50 backdrop-blur-md border border-white/5 py-1.5 px-3 rounded-full z-10"
      >
        <div className="w-1.5 h-1.5 rounded-full bg-white animate-pulse shadow-[0_0_8px_rgba(255,255,255,0.8)]"></div>
        <span className="text-[10px] font-semibold text-zinc-400 tracking-wider uppercase">All Systems Operational</span>
      </motion.div>

    </div>
  );
}

