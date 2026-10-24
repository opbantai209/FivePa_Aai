import React, { useState } from 'react';
import { Sparkles, Code, Cpu, Palette, Smartphone, Shield } from 'lucide-react';

interface GigImageProps {
  src?: string | null;
  title?: string;
  category?: string;
  className?: string;
}

export const GigImage: React.FC<GigImageProps> = ({
  src,
  title = 'Professional Gig Service',
  category = 'Technology & Programming',
  className = ''
}) => {
  const [hasError, setHasError] = useState(false);

  const getCategoryTheme = (cat?: string) => {
    const c = (cat || '').toLowerCase();
    if (c.includes('ai') || c.includes('data')) {
      return {
        bg: 'from-slate-950 via-indigo-950 to-slate-900',
        accent: 'text-indigo-400',
        border: 'border-indigo-500/30',
        badgeBg: 'bg-indigo-500/20 text-indigo-300',
        icon: <Cpu className="w-5 h-5 text-indigo-400" />
      };
    }
    if (c.includes('design') || c.includes('creative')) {
      return {
        bg: 'from-slate-950 via-purple-950 to-slate-900',
        accent: 'text-purple-400',
        border: 'border-purple-500/30',
        badgeBg: 'bg-purple-500/20 text-purple-300',
        icon: <Palette className="w-5 h-5 text-purple-400" />
      };
    }
    if (c.includes('mobile') || c.includes('app')) {
      return {
        bg: 'from-slate-950 via-blue-950 to-slate-900',
        accent: 'text-blue-400',
        border: 'border-blue-500/30',
        badgeBg: 'bg-blue-500/20 text-blue-300',
        icon: <Smartphone className="w-5 h-5 text-blue-400" />
      };
    }
    return {
      bg: 'from-slate-950 via-slate-900 to-emerald-950',
      accent: 'text-emerald-400',
      border: 'border-emerald-500/30',
      badgeBg: 'bg-emerald-500/20 text-emerald-300',
      icon: <Code className="w-5 h-5 text-emerald-400" />
    };
  };

  const theme = getCategoryTheme(category);
  const hasValidImageSrc = Boolean(
    src &&
    typeof src === 'string' &&
    src.trim() !== '' &&
    (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('/') || src.startsWith('blob:') || src.startsWith('data:'))
  );

  if (hasValidImageSrc && !hasError) {
    return (
      <div className={`relative overflow-hidden bg-slate-900 ${className}`}>
        <img
          src={src!}
          alt={title}
          className="w-full h-full object-cover"
          onError={() => setHasError(true)}
          loading="lazy"
        />
      </div>
    );
  }

  return (
    <div className={`relative overflow-hidden bg-gradient-to-br ${theme.bg} p-5 flex flex-col justify-between select-none ${className}`}>
      <div className="absolute -right-8 -bottom-8 w-32 h-32 rounded-full bg-white/5 blur-xl pointer-events-none" />
      
      <div className="flex items-center justify-between relative z-10">
        <span className={`text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-md ${theme.badgeBg} border ${theme.border} backdrop-blur-md`}>
          {category || 'Verified Service'}
        </span>
        <div className="w-8 h-8 rounded-xl bg-white/10 backdrop-blur-md flex items-center justify-center border border-white/10 shadow-sm">
          {theme.icon}
        </div>
      </div>

      <div className="my-auto space-y-2 py-3 relative z-10">
        <h4 className="text-xs sm:text-sm font-black text-white line-clamp-2 leading-snug tracking-tight drop-shadow-md">
          {title}
        </h4>
      </div>

      <div className="flex items-center justify-between text-[10px] font-mono text-slate-300 opacity-90 relative z-10 pt-2 border-t border-white/10">
        <span className="flex items-center gap-1 font-bold text-emerald-400">
          <Shield className="w-3 h-3" /> 100% Escrow Protected
        </span>
        <span className="text-slate-400">WorkPerHour</span>
      </div>
    </div>
  );
};
