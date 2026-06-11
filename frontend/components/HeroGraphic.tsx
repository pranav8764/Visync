'use client';
import { motion } from 'framer-motion';

export default function HeroGraphic() {
  return (
    <div className="relative w-full max-w-lg mx-auto h-48 md:h-56 mb-12 perspective-[1000px] pointer-events-none hidden sm:block">
      <motion.div
        animate={{
          y: [0, -12, 0],
          rotateX: [25, 28, 25],
          rotateY: [-15, -12, -15],
          rotateZ: [2, 1, 2]
        }}
        transition={{
          duration: 6,
          repeat: Infinity,
          ease: "easeInOut"
        }}
        className="w-full h-full bg-zinc-900/60 border border-white/10 rounded-2xl shadow-2xl backdrop-blur-xl absolute top-0 left-0 p-4 flex flex-col gap-3 transform-style-3d shadow-white/5"
      >
        {/* Fake Top Toolbar */}
        <div className="flex justify-between items-center w-full">
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-zinc-300"></div>
            <div className="w-24 h-4 bg-white/10 rounded-md"></div>
          </div>
          <div className="flex gap-1.5">
            <div className="w-6 h-6 rounded-full bg-zinc-400/80 border border-white/20"></div>
            <div className="w-6 h-6 rounded-full bg-zinc-500/80 border border-white/20"></div>
          </div>
        </div>

        {/* Fake Canvas Center Tools */}
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 flex items-center gap-1.5 bg-zinc-800/80 p-1.5 rounded-xl border border-white/10 shadow-lg">
          <div className="w-6 h-6 rounded-lg bg-white/10"></div>
          <div className="w-6 h-6 rounded-lg bg-zinc-300 border border-zinc-200"></div>
          <div className="w-6 h-6 rounded-lg bg-white/10"></div>
          <div className="w-px h-4 bg-white/10 mx-1"></div>
          <div className="w-6 h-6 rounded-lg bg-white/10"></div>
        </div>

        {/* Fake Strokes & Collaborators */}
        <svg className="absolute inset-0 w-full h-full opacity-60">
          <path d="M 50 100 Q 150 50 250 120 T 350 80" fill="transparent" stroke="#a1a1aa" strokeWidth="4" strokeLinecap="round" />
          <path d="M 80 150 Q 180 200 280 140" fill="transparent" stroke="#f4f4f5" strokeWidth="4" strokeLinecap="round" />
          
          {/* Fake collaborative cursors */}
          <g transform="translate(250, 120)">
            <path d="M0 0 L 12 12 L 5 12 L 0 17 Z" fill="#ffffff" stroke="#18181b" strokeWidth="1.5" />
            <rect x="8" y="14" width="30" height="10" rx="3" fill="#ffffff" stroke="#18181b" strokeWidth="1" />
          </g>
          
          <g transform="translate(180, 180)">
            <path d="M0 0 L 12 12 L 5 12 L 0 17 Z" fill="#27272a" stroke="#ffffff" strokeWidth="1.5" />
            <rect x="8" y="14" width="24" height="10" rx="3" fill="#27272a" stroke="#ffffff" strokeWidth="1" />
          </g>
        </svg>

      </motion.div>
    </div>
  );
}
