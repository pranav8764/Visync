'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import axios from 'axios';
import { useStore } from '@/lib/useStore';

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
    const adjectives = ['Creative', 'Swift', 'Vibrant', 'Artistic', 'Electric', 'Active', 'Dynamic', 'Genius', 'Clever', 'Radiant'];
    const animals = ['Owl', 'Falcon', 'Fox', 'Koala', 'Panda', 'Dolphin', 'Otter', 'Panther', 'Tiger', 'Badger'];
    const randAdj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const randAnim = animals[Math.floor(Math.random() * animals.length)];
    setNickname(`${randAdj} ${randAnim}`);

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
      // POST to create room
      const res = await axios.post(`${apiBaseUrl}/api/rooms`, {
        name: roomName.trim(),
        createdBy: nickname.trim(),
      });

      const room = res.data;
      
      // Store session info in Zustand
      const store = useStore.getState();
      store.setUsername(nickname.trim());
      store.setRoomName(room.name);
      store.setRoomId(room.id);

      // Redirect to room page
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
      // Clean room code UUID
      const cleanedCode = roomCode.trim();

      // GET room details
      const res = await axios.get(`${apiBaseUrl}/api/rooms/${cleanedCode}`);
      const room = res.data;

      // Store in Zustand
      const store = useStore.getState();
      store.setUsername(nickname.trim());
      store.setRoomName(room.name);
      store.setRoomId(room.id);

      // Redirect
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

  return (
    <div className="min-h-[100dvh] w-full flex flex-col justify-center items-center bg-radial-ambient bg-grid-pattern relative p-4 select-none">
      
      {/* Decorative Ambient Glowing Orbs */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-blue-600/10 rounded-full blur-3xl -z-10 pointer-events-none"></div>
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-purple-600/10 rounded-full blur-3xl -z-10 pointer-events-none"></div>

      {/* Visync Logo & Header */}
      <div className="flex flex-col items-center mb-8 animate-fade-in text-center">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-blue-600 to-purple-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
            <svg className="w-7 h-7 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="m12 3-1.912 5.886a1 1 0 0 1-.95.69H2.93a1 1 0 0 0-.588 1.8l5.022 3.655a1 1 0 0 1 .363 1.118l-1.913 5.885a1 1 0 0 0 1.54 1.118l5.023-3.654a1 1 0 0 1 1.176 0l5.023 3.654a1 1 0 0 0 1.54-1.118l-1.913-5.885a1 1 0 0 1 .363-1.118l5.022-3.656a1 1 0 0 0-.587-1.8h-6.206a1 1 0 0 1-.951-.69L12 3Z" />
            </svg>
          </div>
          <span className="text-4xl font-extrabold tracking-tight bg-gradient-to-r from-white via-zinc-200 to-zinc-400 bg-clip-text text-transparent">
            Visync
          </span>
        </div>
        <p className="text-zinc-400 text-sm max-w-sm tracking-wide">
          Realtime Collaborative Whiteboard & Instant Drawing Workspace
        </p>
      </div>

      {/* Main Glass Form Card */}
      <div className="w-full max-w-md glass-panel rounded-2xl overflow-hidden p-6 relative border-t border-white/10">
        
        {/* Tab Selection */}
        <div className="flex gap-2 p-1 bg-black/40 rounded-xl mb-6 border border-white/5">
          <button
            type="button"
            onClick={() => { setActiveTab('create'); setError(''); }}
            className={`flex-1 py-2.5 rounded-lg text-sm font-medium tracking-wide transition-all ${
              activeTab === 'create'
                ? 'bg-gradient-to-r from-blue-600/90 to-blue-500/90 text-white shadow-md shadow-blue-500/10'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5'
            }`}
          >
            Create New Board
          </button>
          <button
            type="button"
            onClick={() => { setActiveTab('join'); setError(''); }}
            className={`flex-1 py-2.5 rounded-lg text-sm font-medium tracking-wide transition-all ${
              activeTab === 'join'
                ? 'bg-gradient-to-r from-blue-600/90 to-blue-500/90 text-white shadow-md shadow-blue-500/10'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5'
            }`}
          >
            Join Existing
          </button>
        </div>

        {/* Error Notification Alert */}
        {error && (
          <div className="mb-5 p-3 rounded-lg bg-red-950/40 border border-red-800/40 text-red-300 text-xs flex gap-2 items-start leading-relaxed">
            <svg className="w-4 h-4 text-red-400 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <div>{error}</div>
          </div>
        )}

        {/* Create Board Form */}
        {activeTab === 'create' && (
          <form onSubmit={handleCreateRoom} className="space-y-4">
            <div className="space-y-2">
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

            <div className="space-y-2">
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
              className="w-full h-11 rounded-xl bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 font-semibold text-white transition-all text-sm flex items-center justify-center gap-2 hover:scale-[1.01] hover:shadow-lg hover:shadow-blue-500/20 active:scale-[0.99] disabled:opacity-50 disabled:scale-100"
            >
              {loading ? (
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
              ) : (
                <>
                  <span>Launch Board</span>
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
                  </svg>
                </>
              )}
            </button>
          </form>
        )}

        {/* Join Board Form */}
        {activeTab === 'join' && (
          <form onSubmit={handleJoinRoom} className="space-y-4">
            <div className="space-y-2">
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

            <div className="space-y-2">
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
                <div className="absolute right-3.5 top-1/2 -translate-y-1/2 text-zinc-500">
                  <svg className="w-4.5 h-4.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                  </svg>
                </div>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full h-11 rounded-xl bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 font-semibold text-white transition-all text-sm flex items-center justify-center gap-2 hover:scale-[1.01] hover:shadow-lg hover:shadow-blue-500/20 active:scale-[0.99] disabled:opacity-50 disabled:scale-100"
            >
              {loading ? (
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
              ) : (
                <>
                  <span>Join Board Session</span>
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
                  </svg>
                </>
              )}
            </button>
          </form>
        )}
      </div>

      {/* Sleek Feature Showcases Footer */}
      <div className="mt-12 flex flex-wrap justify-center gap-6 max-w-2xl text-center px-4 animate-fade-in delay-200">
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <svg className="w-4 h-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
          <span>Realtime Vector Sync</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <svg className="w-4 h-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
          <span>Interactive Shape Docks</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <svg className="w-4 h-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
          <span>Live Cursors & Chat</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <svg className="w-4 h-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
          <span>DB History Recovery</span>
        </div>
      </div>
    </div>
  );
}
