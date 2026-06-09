'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import CanvasBoard from '@/components/CanvasBoard';
import { useStore } from '@/lib/useStore';

export default function RoomPage() {
  const params = useParams();
  const roomId = params.roomId as string;
  const router = useRouter();
  const username = useStore((state) => state.username);
  const setUsername = useStore((state) => state.setUsername);
  
  const [userId, setUserId] = useState<string>('');
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    let currentUsername = username;

    // If no username is set in Zustand, check localStorage
    if (!currentUsername || currentUsername.trim() === '') {
      const savedNickname = localStorage.getItem('visync_nickname');
      if (savedNickname) {
        setUsername(savedNickname);
        currentUsername = savedNickname;
      } else {
        router.push(`/?code=${roomId}`);
        return;
      }
    }

    let id = sessionStorage.getItem('visync_user_id');
    // If no ID exists for this tab, or the nickname changed, generate a new one
    if (!id || !id.startsWith(`${currentUsername}_`)) {
      id = `${currentUsername}_${Math.random().toString(36).substring(2, 9)}`;
      sessionStorage.setItem('visync_user_id', id);
    }
    setUserId(id);
    setIsLoaded(true);
  }, [username, router, roomId, setUsername]);

  if (!isLoaded || !userId || !username) {
    return <div className="flex items-center justify-center h-[100dvh]">Loading...</div>;
  }

  return <CanvasBoard roomId={roomId} userId={userId} />;
}
