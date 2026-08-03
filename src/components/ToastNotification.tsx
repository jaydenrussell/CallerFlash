import { useEffect, useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Phone, X, User } from 'lucide-react';
import { useAppStore, type CallRecord } from '../store/useAppStore';
import { sanitizeCallerNumberForClipboard } from '../security/secretRedactor';

interface ToastNotificationProps {
  call: CallRecord;
  onDismiss: (id: string) => void;
  stackIndex: number;
}

export function ToastNotification({ call, onDismiss, stackIndex }: ToastNotificationProps) {
  const {
    toastConfig, setClipboardText, addDiagnosticLog,
    toastDragPosition, setToastDragPosition,
  } = useAppStore();

  const [isExiting, setIsExiting] = useState(false);
  const [progress, setProgress] = useState(100);
  const [isDragging, setIsDragging] = useState(false);
  const [localPos, setLocalPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{ mouseX: number; mouseY: number; elX: number; elY: number } | null>(null);
  const isPausedRef = useRef(false);
  const timerStartRef = useRef(0);
  const remainingRef = useRef(toastConfig.duration * 1000);

  // Timer & progress
  useEffect(() => {
    const duration = toastConfig.duration * 1000;
    timerStartRef.current = Date.now();
    remainingRef.current = duration;

    let progressInterval: ReturnType<typeof setInterval>;
    let dismissTimer: ReturnType<typeof setTimeout>;

    const startTimers = () => {
      timerStartRef.current = Date.now();
      progressInterval = setInterval(() => {
        if (isPausedRef.current) return;
        const elapsed = Date.now() - timerStartRef.current;
        const rem = Math.max(0, remainingRef.current - elapsed);
        const pct = (rem / duration) * 100;
        setProgress(pct);
        if (pct <= 0) {
          clearInterval(progressInterval);
        }
      }, 50);

      dismissTimer = setTimeout(() => {
        setIsExiting(true);
        setTimeout(() => onDismiss(call.id), 300);
      }, remainingRef.current);
    };

    startTimers();

    return () => {
      clearTimeout(dismissTimer);
      clearInterval(progressInterval);
    };
  }, []);

  // Auto copy to clipboard on mount. The number is passed through a strict
  // sanitizer that strips everything except digits and a leading + — this
  // prevents a malicious caller-name field from being smuggled into the
  // clipboard alongside the number (which could then be auto-pasted into a
  // terminal, SQL field, or shell).
  useEffect(() => {
    if (toastConfig.autoCopyToClipboard) {
      const cleanNumber = sanitizeCallerNumberForClipboard(call.callerNumber);
      if (!cleanNumber) {
        addDiagnosticLog({
          level: 'warning',
          category: 'TOAST',
          message: 'Refused to copy empty/sanitized number to clipboard',
        });
        return;
      }
      navigator.clipboard?.writeText(cleanNumber).then(() => {
        setClipboardText(cleanNumber);
        addDiagnosticLog({
          level: 'info',
          category: 'TOAST',
          message: `Auto-copied sanitized number to clipboard`,
          details: `Length: ${cleanNumber.length} digits (source sanitized)`,
        });
      }).catch((err) => {
        addDiagnosticLog({
          level: 'error',
          category: 'TOAST',
          message: `Clipboard write failed: ${err instanceof Error ? err.message : 'permission denied'}`,
        });
      });
    }
  }, []);

  // Drag handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Don't drag if clicking the X button
    if ((e.target as HTMLElement).closest('[data-dismiss]')) return;

    e.preventDefault();
    const el = dragRef.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      elX: rect.left,
      elY: rect.top,
    };
    setIsDragging(true);
    isPausedRef.current = true;
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragStartRef.current) return;
      const dx = e.clientX - dragStartRef.current.mouseX;
      const dy = e.clientY - dragStartRef.current.mouseY;
      const newX = dragStartRef.current.elX + dx;
      const newY = dragStartRef.current.elY + dy;
      setLocalPos({ x: newX, y: newY });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      isPausedRef.current = false;
      // Persist position for future toasts
      if (localPos) {
        setToastDragPosition(localPos);
        addDiagnosticLog({
          level: 'info',
          category: 'TOAST',
          message: `Toast position saved: (${Math.round(localPos.x)}, ${Math.round(localPos.y)})`,
        });
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, localPos]);

  const handleDismiss = () => {
    setIsExiting(true);
    setTimeout(() => onDismiss(call.id), 300);
  };

  // Compute position: use localPos (actively dragging) > saved drag position > CSS corner
  const getPositionStyle = (): React.CSSProperties => {
    // If this toast has been dragged locally, use that
    if (localPos) {
      return {
        position: 'fixed',
        left: `${localPos.x}px`,
        top: `${localPos.y + stackIndex * 8}px`,
        right: 'auto',
        bottom: 'auto',
      };
    }
    // If a previous drag position was saved, use that
    if (toastDragPosition) {
      return {
        position: 'fixed',
        left: `${toastDragPosition.x}px`,
        top: `${toastDragPosition.y + stackIndex * 8}px`,
        right: 'auto',
        bottom: 'auto',
      };
    }
    // Default corner positioning
    const positions: Record<string, React.CSSProperties> = {
      'top-right': { top: `${16 + stackIndex * 8}px`, right: '16px' },
      'top-left': { top: `${16 + stackIndex * 8}px`, left: '16px' },
      'bottom-right': { bottom: `${16 + stackIndex * 8}px`, right: '16px' },
      'bottom-left': { bottom: `${16 + stackIndex * 8}px`, left: '16px' },
    };
    return {
      position: 'fixed',
      ...positions[toastConfig.position],
    };
  };

  // Portal the toast directly to document.body so it cannot be clipped
  // or stacking-context-trapped by any parent (the App shell uses
  // `overflow-hidden` and several flex layers that previously could
  // swallow the toast). z-index is set inline with !important to
  // beat any third-party styles.
  return createPortal(
    <div
      ref={dragRef}
      onMouseDown={handleMouseDown}
      className={`${isExiting ? 'animate-slide-out' : 'animate-slide-in'} ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
      style={{
        ...getPositionStyle(),
        zIndex: 2147483647, // max safe int; sits above anything in the app
        maxWidth: `min(${toastConfig.maxWidth}px, calc(100vw - 24px))`,
        width: `min(${toastConfig.maxWidth}px, calc(100vw - 24px))`,
        userSelect: 'none',
        transition: isDragging ? 'none' : undefined,
        pointerEvents: 'auto',
      }}
    >
      <div
        className="relative overflow-hidden shadow-2xl border border-white/10"
        style={{
          backgroundColor: toastConfig.backgroundColor,
          borderRadius: `${toastConfig.borderRadius}px`,
          opacity: toastConfig.opacity / 100,
          fontFamily: toastConfig.fontFamily,
        }}
      >
        {/* Accent bar */}
        <div
          className="absolute top-0 left-0 w-1 h-full"
          style={{ backgroundColor: toastConfig.accentColor }}
        />

        {/* Content */}
        <div className="p-4 pl-5">
          <div className="flex items-start gap-3">
            {/* Phone icon with pulse */}
            <div className="relative flex-shrink-0 mt-0.5">
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center"
                style={{ backgroundColor: `${toastConfig.accentColor}20` }}
              >
                <Phone
                  className="w-5 h-5"
                  style={{ color: toastConfig.accentColor }}
                />
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

            {/* Call info */}
            <div className="flex-1 min-w-0">
              {/* Header row: "Incoming Call" left, timestamp + X right */}
              <div className="flex items-center justify-between gap-2">
                <p
                  className="font-semibold truncate"
                  style={{
                    color: toastConfig.accentColor,
                    fontSize: `${toastConfig.fontSize - 2}px`,
                  }}
                >
                  Incoming Call
                </p>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {toastConfig.showTimestamp && (
                    <span
                      style={{
                        color: toastConfig.textColor + '70',
                        fontSize: `${toastConfig.fontSize - 4}px`,
                      }}
                    >
                      {call.timestamp.toLocaleTimeString()}
                    </span>
                  )}
                  <button
                    data-dismiss
                    onClick={handleDismiss}
                    className="p-1 rounded hover:bg-white/10 transition-colors"
                  >
                    <X className="w-4 h-4" style={{ color: toastConfig.textColor + '80' }} />
                  </button>
                </div>
              </div>

              {/* Caller Number */}
              <p
                className="font-bold mt-1.5 tracking-wide"
                style={{
                  color: toastConfig.textColor,
                  fontSize: `${toastConfig.fontSize + 4}px`,
                }}
              >
                {call.callerNumber}
              </p>

              {/* Caller Name */}
              {toastConfig.showCallerName && call.callerName && (
                <div className="flex items-center gap-1.5 mt-1">
                  <User className="w-3.5 h-3.5" style={{ color: toastConfig.textColor + '60' }} />
                  <p
                    className="truncate"
                    style={{
                      color: toastConfig.textColor + 'bb',
                      fontSize: `${toastConfig.fontSize - 2}px`,
                    }}
                  >
                    {call.callerName}
                  </p>
                </div>
              )}

            </div>
          </div>
        </div>

        {/* Drag hint */}
        <div className="absolute top-1/2 -translate-y-1/2 left-2.5 flex flex-col gap-[3px] opacity-30">
          <div className="w-[3px] h-[3px] rounded-full" style={{ backgroundColor: toastConfig.textColor }} />
          <div className="w-[3px] h-[3px] rounded-full" style={{ backgroundColor: toastConfig.textColor }} />
          <div className="w-[3px] h-[3px] rounded-full" style={{ backgroundColor: toastConfig.textColor }} />
        </div>

        {/* Progress bar */}
        <div className="h-[3px] w-full" style={{ backgroundColor: `${toastConfig.accentColor}10` }}>
          <div
            className="h-full transition-all duration-100 ease-linear"
            style={{
              width: `${progress}%`,
              backgroundColor: toastConfig.accentColor,
            }}
          />
        </div>
      </div>
    </div>,
    document.body
  );
}

export function ToastContainer() {
  const { activeToasts, removeToast } = useAppStore();

  return (
    <>
      {activeToasts.map((call, index) => (
        <ToastNotification
          key={call.id}
          call={call}
          onDismiss={removeToast}
          stackIndex={index}
        />
      ))}
    </>
  );
}
