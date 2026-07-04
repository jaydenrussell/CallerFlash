import { useState, useEffect, useRef, useCallback } from 'react';

interface ToastData {
  id?: string;
  callerNumber?: string;
  callerName?: string;
  timestamp?: string;
  config?: {
    duration?: number;
    backgroundColor?: string;
    accentColor?: string;
    textColor?: string;
    borderRadius?: number;
    opacity?: number;
    fontFamily?: string;
    fontSize?: number;
    showCallerName?: boolean;
    showTimestamp?: boolean;
    maxWidth?: number;
    autoCopyToClipboard?: boolean;
  };
}

function hexToRgb(hex: string): string {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `${r},${g},${b}`;
}

export function ToastWindow() {
  const [data, setData] = useState<ToastData | null>(null);
  const [progress, setProgress] = useState(100);
  const startRef = useRef<number>(0);
  const durationMsRef = useRef<number>(10000);
  const rafRef = useRef<number>(0);
  const closedRef = useRef(false);

  // Get initial data from main process on mount
  useEffect(() => {
    if (!window.callerflash?.toast?.getInitial) return;
    window.callerflash.toast.getInitial().then((d: ToastData | null) => {
      if (d) setData(d);
    }).catch(() => {});
  }, []);

  // Subscribe to subsequent toast calls (window reuse)
  useEffect(() => {
    if (!window.callerflash?.toast?.onShow) return;
    return window.callerflash.toast.onShow((d: ToastData) => {
      closedRef.current = false;
      setData(d);
      startRef.current = Date.now();
      setProgress(100);
    });
  }, []);

  // Auto-close timer + progress bar
  useEffect(() => {
    if (!data) return;

    const duration = data.config?.duration ?? 10;
    durationMsRef.current = duration * 1000;
    startRef.current = Date.now();
    closedRef.current = false;
    setProgress(100);

    const tick = () => {
      if (closedRef.current) return;
      const elapsed = Date.now() - startRef.current;
      const remaining = Math.max(0, durationMsRef.current - elapsed);
      setProgress((remaining / durationMsRef.current) * 100);
      if (remaining > 0) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);

    const timer = setTimeout(() => {
      if (!closedRef.current) {
        closedRef.current = true;
        window.close();
      }
    }, durationMsRef.current + 500);

    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(rafRef.current);
    };
  }, [data]);

  if (!data) return null;

  const c = data.config || {};
  const accentColor = c.accentColor || '#60cdff';
  const bgColor = c.backgroundColor || '#1a1a2e';
  const textColor = c.textColor || '#ffffff';
  const borderRadius = c.borderRadius ?? 16;
  const opacity = c.opacity != null ? c.opacity / 100 : 1;
  const fontFamily = c.fontFamily || "'Segoe UI', system-ui, sans-serif";
  const fontSize = c.fontSize || 14;
  const showCallerName = c.showCallerName !== false;
  const showTimestamp = c.showTimestamp !== false;

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        overflow: 'hidden',
        background: 'transparent',
        fontFamily,
        margin: 0,
        padding: 0,
      }}
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          background: bgColor,
          borderRadius: `${borderRadius}px`,
          border: `2px solid ${accentColor}66`,
          boxShadow: `0 12px 40px rgba(0,0,0,0.8), 0 0 60px ${accentColor}26`,
          overflow: 'hidden',
          position: 'relative',
          opacity,
          animation: 'slideIn 0.35s cubic-bezier(.16,1,.3,1) forwards',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Accent bar */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: 5,
            height: '100%',
            background: accentColor,
            boxShadow: `0 0 12px ${accentColor}`,
          }}
        />

        {/* Body */}
        <div style={{ padding: '14px 16px 14px 20px', display: 'flex', gap: 12, height: '100%' }}>
          {/* Phone icon with ping */}
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: '50%',
              background: `${accentColor}20`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              position: 'relative',
            }}
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke={accentColor}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
            </svg>
            {/* Ping animation */}
            <div
              style={{
                position: 'absolute',
                top: -2,
                right: -2,
                width: 12,
                height: 12,
                borderRadius: '50%',
                background: '#6ccb5f',
                animation: 'pulse 1.2s ease-in-out infinite',
              }}
            />
          </div>

          {/* Info */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: accentColor,
                marginBottom: 4,
                textTransform: 'uppercase',
                letterSpacing: 1,
              }}
            >
              Incoming Call
            </div>
            <div
              style={{
                fontSize: fontSize + 8,
                fontWeight: 700,
                color: textColor,
                letterSpacing: 0.5,
                lineHeight: 1.2,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {data.callerNumber || 'Unknown'}
            </div>
            {showCallerName && data.callerName && (
              <div
                style={{
                  fontSize: fontSize,
                  color: `rgba(${hexToRgb(textColor)},0.7)`,
                  marginTop: 3,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {data.callerName}
              </div>
            )}
            {showTimestamp && data.timestamp && (
              <div
                style={{
                  fontSize: fontSize - 3,
                  color: `rgba(${hexToRgb(textColor)},0.4)`,
                  marginTop: 4,
                }}
              >
                {new Date(data.timestamp).toLocaleTimeString()}
              </div>
            )}
          </div>
        </div>

        {/* Progress bar */}
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            width: '100%',
            height: 4,
            background: `${accentColor}10`,
          }}
        >
          <div
            style={{
              height: '100%',
              width: `${progress}%`,
              background: accentColor,
              transition: 'width 100ms linear',
            }}
          />
        </div>
      </div>

      {/* CSS keyframes injected via style tag */}
      <style>{`
        @keyframes slideIn {
          from { transform: translateY(-20px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
        @keyframes pulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.8); opacity: 0; }
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body { width: 100%; height: 100%; overflow: hidden; background: transparent; }
      `}</style>
    </div>
  );
}
