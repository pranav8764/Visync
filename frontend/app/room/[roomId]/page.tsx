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
  
  const [userId, setUserId] = useState<string>('');
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    // If no username is set in Zustand, it means the user bypassed the home page
    // (e.g., direct link or page refresh). Redirect them to the join flow.
    if (!username || username.trim() === '') {
      router.push(`/?code=${roomId}`);
      return;
    }

    let id = localStorage.getItem('visync_user_id');
    if (!id) {
      id = `user-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      localStorage.setItem('visync_user_id', id);
    }
    setUserId(id);
    setIsLoaded(true);
  }, [username, router, roomId]);

  if (!isLoaded || !userId || !username) {
    return <div className="flex items-center justify-center h-[100dvh]">Loading...</div>;
  }

  return <CanvasBoard roomId={roomId} userId={userId} />;
}
