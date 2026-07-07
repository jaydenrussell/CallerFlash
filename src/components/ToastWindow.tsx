import { useEffect, useState, useRef, useCallback } from 'react';
import { Phone, X, User } from 'lucide-react';
import { sanitizeCallerNumberForClipboard } from '../security/secretRedactor';

const POSITION_STORAGE_KEY = 'callerflash-toast-position';

interface ActiveToast {
  id: string;
  callerNumber: string;
  callerName: string;
  timestamp: string; // ISO — Date isn't serializable through IPC
  // Local copy of toast config at the time of arrival so the window
  // can render without needing the main-window store.
  config: {
    duration: number;
    backgroundColor: string;
    accentColor: string;
    textColor: string;
    borderRadius: number;
    opacity: number;
    fontFamily: string;
    fontSize: number;
    autoCopyToClipboard: boolean;
    showCallerName: boolean;
    showTimestamp: boolean;
    maxWidth: number;
  };
}

interface ToastEventData {
  id: string;
  callerNumber: string;
  callerName: string;
  timestamp: string;
  config: ActiveToast['config'];
}

/**
 * Renders the toast UI in a separate frameless Electron BrowserWindow
 * so the call alert is visible even when the main app is hidden to
 * the tray. Subscribes to IPC events from main process and renders
 * one ToastItem per active call.
 */
export function ToastWindow() {
  const [activeToasts, setActiveToasts] = useState<ActiveToast[]>([]);

  useEffect(() => {
    // Apply saved position on mount so the toast appears where the
    // user last placed it.
    try {
      const saved = localStorage.getItem(POSITION_STORAGE_KEY);
      if (saved) {
        const { x, y } = JSON.parse(saved) as { x: number; y: number };
        if (Number.isFinite(x) && Number.isFinite(y)) {
          window.callerflash?.toast?.setPosition?.(x, y);
        }
      }
    } catch {
      // Ignore parse errors; fall through to default position.
    }

    // Claim any call data that was sent before this window was ready
    if (window.callerflash?.toast?.getInitial) {
      window.callerflash.toast.getInitial().then((data) => {
        if (data) setActiveToasts((prev) => [...prev, data as ActiveToast]);
      });
    }
  }, []);

  useEffect(() => {
    if (!window.callerflash?.toast?.onShow) return;
    const off = window.callerflash.toast.onShow((data: ToastEventData) => {
      setActiveToasts((prev) => [...prev, data as ActiveToast]);
    });
    return () => off?.();
  }, []);

  const dismiss = useCallback((id: string) => {
    setActiveToasts((prev) => {
      const next = prev.filter((t) => t.id !== id);
      // Auto-hide the window when the last toast clears.
      if (next.length === 0) {
        window.callerflash?.toast?.hide?.();
      }
      return next;
    });
  }, []);

  return (
    <div
      className="w-screen h-screen overflow-hidden"
      style={{
        // The toast window itself is transparent; only the toast
        // cards paint pixels.
        background: 'transparent',
      }}
    >
      {activeToasts.map((toast, idx) => (
        <ToastItem
          key={toast.id}
          toast={toast}
          onDismiss={() => dismiss(toast.id)}
          stackIndex={idx}
        />
      ))}
    </div>
  );
}

function ToastItem({
  toast,
  onDismiss,
  stackIndex,
}: {
  toast: ActiveToast;
  onDismiss: () => void;
  stackIndex: number;
}) {
  const config = toast.config;

  const [isExiting, setIsExiting] = useState(false);
  const [progress, setProgress] = useState(100);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState<{ dx: number; dy: number } | null>(null);
  const dragRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{
    mouseX: number;
    mouseY: number;
    windowX: number;
    windowY: number;
  } | null>(null);
  const timerStartRef = useRef(Date.now());
  const remainingRef = useRef(config.duration * 1000);

  // Timer & progress
  useEffect(() => {
    const duration = config.duration * 1000;
    timerStartRef.current = Date.now();
    remainingRef.current = duration;

    const progressInterval = setInterval(() => {
      const elapsed = Date.now() - timerStartRef.current;
      const rem = Math.max(0, remainingRef.current - elapsed);
      const pct = (rem / duration) * 100;
      setProgress(pct);
      if (pct <= 0) clearInterval(progressInterval);
    }, 50);

    const dismissTimer = setTimeout(() => {
      setIsExiting(true);
      setTimeout(onDismiss, 300);
    }, duration);

    return () => {
      clearTimeout(dismissTimer);
      clearInterval(progressInterval);
    };
  }, [config.duration, onDismiss]);

  // Auto copy to clipboard on mount. We rely on the host platform's
  // clipboard (in the toast window this is Electron's clipboard API,
  // invoked through navigator.clipboard).
  useEffect(() => {
    if (config.autoCopyToClipboard) {
      const clean = sanitizeCallerNumberForClipboard(toast.callerNumber);
      if (clean) navigator.clipboard?.writeText(clean).catch((e) => console.error('[ToastWindow] clipboard write failed:', e));
    }
  }, []);

  // Drag the OS window itself. In a frameless Electron BrowserWindow
  // we use the renderer to compute the new position and apply it via
  // IPC; the OS moves the window in response.
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('[data-dismiss]')) return;
      e.preventDefault();
      const startDrag = (windowX: number, windowY: number) => {
        dragStartRef.current = {
          mouseX: e.clientX,
          mouseY: e.clientY,
          windowX,
          windowY,
        };
        setIsDragging(true);
      };
      const getter = window.callerflash?.toast?.getPosition;
      if (getter) {
        // The bridge returns Promise<{x, y} | null>; null means the
        // toast window isn't ready yet — start from (0,0) and let the
        // first mousemove apply a fresh position via setPosition.
        Promise.resolve(getter()).then((pos) => {
          startDrag(pos?.x ?? 0, pos?.y ?? 0);
        });
      } else {
        startDrag(0, 0);
      }
    },
    []
  );

  useEffect(() => {
    if (!isDragging) return;
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragStartRef.current) return;
      const dx = e.clientX - dragStartRef.current.mouseX;
      const dy = e.clientY - dragStartRef.current.mouseY;
      const newX = dragStartRef.current.windowX + dx;
      const newY = dragStartRef.current.windowY + dy;
      setDragOffset({ dx, dy });
      // Move the OS window live.
      window.callerflash?.toast?.setPosition?.(newX, newY);
    };
    const handleMouseUp = () => {
      setIsDragging(false);
      if (dragStartRef.current && dragOffset) {
        const x = dragStartRef.current.windowX + dragOffset.dx;
        const y = dragStartRef.current.windowY + dragOffset.dy;
        try {
          localStorage.setItem(
            POSITION_STORAGE_KEY,
            JSON.stringify({ x, y })
          );
        } catch {
          // localStorage may be disabled; ignore.
        }
      }
      setDragOffset(null);
      dragStartRef.current = null;
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, dragOffset]);

  const handleDismiss = useCallback(() => {
    setIsExiting(true);
    setTimeout(onDismiss, 300);
  }, [onDismiss]);

  return (
    <div
      ref={dragRef}
      onMouseDown={handleMouseDown}
      className={`fixed ${isExiting ? 'animate-slide-out' : 'animate-slide-in'} ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
      style={{
        top: `${stackIndex * 8}px`,
        right: 0,
        left: 0,
        width: '100%',
        maxWidth: '100%',
        userSelect: 'none',
        transition: isDragging ? 'none' : undefined,
      }}
    >
      <div
        className="relative overflow-hidden shadow-2xl border border-white/10"
        style={{
          backgroundColor: config.backgroundColor,
          borderRadius: `${config.borderRadius}px`,
          opacity: config.opacity / 100,
          fontFamily: config.fontFamily,
        }}
      >
        <div
          className="absolute top-0 left-0 w-1 h-full"
          style={{ backgroundColor: config.accentColor }}
        />

        <div className="p-4 pl-5">
          <div className="flex items-start gap-3">
            <div className="relative flex-shrink-0 mt-0.5">
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center"
                style={{ backgroundColor: `${config.accentColor}20` }}
              >
                <Phone className="w-5 h-5" style={{ color: config.accentColor }} />
              </div>
              <div
                className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full animate-ping"
                style={{ backgroundColor: '#6ccb5f' }}
              />
              <div
                className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full"
                style={{ backgroundColor: '#6ccb5f' }}
              />
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <p
                  className="font-semibold truncate"
                  style={{
                    color: config.accentColor,
                    fontSize: `${config.fontSize - 2}px`,
                  }}
                >
                  Incoming Call
                </p>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {config.showTimestamp && (
                    <span
                      style={{
                        color: config.textColor + '70',
                        fontSize: `${config.fontSize - 4}px`,
                      }}
                    >
                      {new Date(toast.timestamp).toLocaleTimeString()}
                    </span>
                  )}
                  <button
                    data-dismiss
                    onClick={handleDismiss}
                    className="p-1 rounded hover:bg-white/10 transition-colors"
                  >
                    <X className="w-4 h-4" style={{ color: config.textColor + '80' }} />
                  </button>
                </div>
              </div>

              <p
                className="font-bold mt-1.5 tracking-wide"
                style={{
                  color: config.textColor,
                  fontSize: `${config.fontSize + 4}px`,
                }}
              >
                {toast.callerNumber}
              </p>

              {config.showCallerName && toast.callerName && (
                <div className="flex items-center gap-1.5 mt-1">
                  <User className="w-3.5 h-3.5" style={{ color: config.textColor + '60' }} />
                  <p
                    className="truncate"
                    style={{
                      color: config.textColor + 'bb',
                      fontSize: `${config.fontSize - 2}px`,
                    }}
                  >
                    {toast.callerName}
                  </p>
                </div>
              )}

            </div>
          </div>
        </div>

        <div className="h-[3px] w-full" style={{ backgroundColor: `${config.accentColor}10` }}>
          <div
            className="h-full transition-all duration-100 ease-linear"
            style={{ width: `${progress}%`, backgroundColor: config.accentColor }}
          />
        </div>
      </div>
    </div>
  );
}
