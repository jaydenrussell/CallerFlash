import {
  Palette, RotateCcw, Bell,
  Clock, PhoneIncoming
} from 'lucide-react';
import { useAppStore, type ToastConfig } from '../store/useAppStore';
import { simulateIncomingCall } from '../utils/simulateIncomingCall';

const fontFamilies = [
  'Inter', 'Segoe UI', 'Arial', 'Helvetica', 'Roboto',
  'Verdana', 'Georgia', 'Courier New', 'Consolas',
];

export function ToastSettings() {
  const {
    toastConfig, setToastConfig, addDiagnosticLog,
  } = useAppStore();

  // All changes auto-persist via the Zustand store + JSON localStorage
  // hydration in useAppStore. There is no Save button — toggles commit
  // on every change, matching the behavior of the in-app Preferences
  // and SIP Settings pages.
  const update = (updates: Partial<ToastConfig>) => setToastConfig(updates);

  const handleReset = () => {
    setToastConfig({
      fontSize: 16,
      fontFamily: 'Inter',
      textColor: '#ffffff',
      backgroundColor: '#1a1a2e',
      accentColor: '#60cdff',
      duration: 8,
      position: 'top-right',
      soundEnabled: true,
      soundName: 'chime',
      autoCopyToClipboard: true,
      showCallerName: true,
      showTimestamp: true,
      maxWidth: 420,
      borderRadius: 12,
      opacity: 95,
      style: 'custom',
    });
    addDiagnosticLog({
      level: 'info',
      category: 'TOAST',
      message: 'Toast configuration reset to defaults',
    });
  };

  // Fire a real incoming call through the same code path the SIP
  // listener would use. In the Electron build this opens the dedicated
  // frameless toast window; in the web demo it renders in-app.
  const handlePreview = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent click from propagating to titlebar/drag region
    simulateIncomingCall('toast-settings');
    addDiagnosticLog({
      level: 'info',
      category: 'TOAST',
      message: toastConfig.style === 'native' ? 'Native notification preview fired' : 'Modern toast preview fired',
    });
  };

  return (
    <div className="space-y-3 animate-fade-in">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-win-text">Notifications</h2>
          <p className="text-xs text-win-text-secondary mt-0.5">
            Changes save automatically — drag the live toast to set a custom position.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handlePreview}
            className="flex items-center gap-2 px-3 py-1.5 bg-win-accent/15 hover:bg-win-accent/25 text-win-accent rounded-lg text-sm font-medium transition-colors border border-win-accent/20"
          >
            <PhoneIncoming className="w-3.5 h-3.5" />
            {toastConfig.style === 'native' ? 'Test Native Windows' : 'Test Modern'}
          </button>
          <button
            onClick={handleReset}
            className="flex items-center gap-2 px-3 py-1.5 bg-win-surface hover:bg-win-surface-hover text-win-text-secondary rounded-lg text-sm font-medium transition-colors border border-win-border"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
        {/* Notification Style */}
        <Section icon={<Bell className="w-4 h-4" />} title="Notification style" desc="How incoming call alerts appear">
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => update({ style: 'custom' })}
                className={`flex flex-col items-center gap-1.5 px-3 py-3 rounded-xl border transition-all ${
                  toastConfig.style === 'custom'
                    ? 'bg-win-accent/15 border-win-accent/40 text-win-accent'
                    : 'bg-win-card border-win-border/50 text-win-text-secondary hover:border-win-border hover:bg-win-surface-hover'
                }`}
              >
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-win-accent/30 to-blue-500/20 flex items-center justify-center">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="3" width="20" height="14" rx="2"/>
                    <path d="M8 21h8"/>
                    <path d="M12 17v4"/>
                    <circle cx="12" cy="10" r="3" fill="currentColor" stroke="none"/>
                  </svg>
                </div>
                <span className="text-xs font-semibold">Modern</span>
                <span className="text-[10px] text-center leading-tight opacity-70">Always-on-top window with progress bar and caller details</span>
              </button>
              <button
                type="button"
                onClick={() => update({ style: 'native' })}
                className={`flex flex-col items-center gap-1.5 px-3 py-3 rounded-xl border transition-all ${
                  toastConfig.style === 'native'
                    ? 'bg-win-accent/15 border-win-accent/40 text-win-accent'
                    : 'bg-win-card border-win-border/50 text-win-text-secondary hover:border-win-border hover:bg-win-surface-hover'
                }`}
              >
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-white/10 to-white/5 flex items-center justify-center">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                    <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                  </svg>
                </div>
                <span className="text-xs font-semibold">Native Windows</span>
                <span className="text-[10px] text-center leading-tight opacity-70">OS notification that works reliably when app is backgrounded</span>
              </button>
            </div>
            <p className="text-[11px] text-win-text-tertiary leading-snug mt-1">
              {toastConfig.style === 'custom'
                ? 'Dedicated always-on-top window with progress bar, caller details, and auto-copy.'
                : 'Standard OS notification in the notification center. Reliable when app is minimized.'}
            </p>
          </div>
        </Section>

        {/* Appearance & Behavior */}
        <Section icon={<Palette className="w-4 h-4" />} title="Appearance & Behavior" desc="Look, feel, and features">
          <div className="space-y-3">
            <div className={`grid grid-cols-2 gap-3 ${toastConfig.style === 'native' ? 'opacity-40 pointer-events-none' : ''}`}>
              <SliderField
                label="Font Size"
                value={toastConfig.fontSize}
                min={10}
                max={28}
                step={1}
                unit="px"
                disabled={toastConfig.style === 'native'}
                onChange={(v) => update({ fontSize: v })}
              />
              <InputField label="Font Family">
                <div className="relative">
                  <select
                    value={toastConfig.fontFamily}
                    disabled={toastConfig.style === 'native'}
                    onChange={(e) => update({ fontFamily: e.target.value })}
                    className="w-full px-2 py-1 bg-win-card border border-win-border rounded-lg text-xs text-win-text focus:outline-none focus:border-win-accent transition-colors appearance-none pr-8 disabled:opacity-40"
                    style={{ fontFamily: toastConfig.fontFamily }}
                  >
                    {fontFamilies.map((font) => (
                      <option key={font} value={font} style={{ fontFamily: font }}>{font}</option>
                    ))}
                  </select>
                  <svg className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-win-text-tertiary pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </div>
              </InputField>
            </div>

            <div className={`grid grid-cols-3 gap-2 ${toastConfig.style === 'native' ? 'opacity-40 pointer-events-none' : ''}`}>
              <ColorField
                label="Text"
                value={toastConfig.textColor}
                disabled={toastConfig.style === 'native'}
                onChange={(v) => update({ textColor: v })}
              />
              <ColorField
                label="Background"
                value={toastConfig.backgroundColor}
                disabled={toastConfig.style === 'native'}
                onChange={(v) => update({ backgroundColor: v })}
              />
              <ColorField
                label="Accent"
                value={toastConfig.accentColor}
                disabled={toastConfig.style === 'native'}
                onChange={(v) => update({ accentColor: v })}
              />
            </div>

            <div className={`grid grid-cols-3 gap-3 ${toastConfig.style === 'native' ? 'opacity-40 pointer-events-none' : ''}`}>
              <SliderField
                label="Radius"
                value={toastConfig.borderRadius}
                min={0}
                max={24}
                step={1}
                unit="px"
                disabled={toastConfig.style === 'native'}
                onChange={(v) => update({ borderRadius: v })}
              />
              <SliderField
                label="Opacity"
                value={toastConfig.opacity}
                min={50}
                max={100}
                step={1}
                unit="%"
                disabled={toastConfig.style === 'native'}
                onChange={(v) => update({ opacity: v })}
              />
              <SliderField
                label="Width"
                value={toastConfig.maxWidth}
                min={300}
                max={600}
                step={10}
                unit="px"
                disabled={toastConfig.style === 'native'}
                onChange={(v) => update({ maxWidth: v })}
              />
            </div>
            
            <div className="grid grid-cols-2 gap-2 mt-1">
              <ToggleField
                label="Sound enabled"
                value={toastConfig.soundEnabled}
                onChange={(v) => update({ soundEnabled: v })}
              />
              <ToggleField
                label="Show caller name"
                value={toastConfig.showCallerName}
                disabled={toastConfig.style === 'native'}
                onChange={(v) => update({ showCallerName: v })}
              />
              <ToggleField
                label="Show timestamp"
                value={toastConfig.showTimestamp}
                disabled={toastConfig.style === 'native'}
                onChange={(v) => update({ showTimestamp: v })}
              />
            </div>

            {toastConfig.style === 'native' && (
              <p className="text-[11px] text-win-text-tertiary italic">
                Some appearance options are only available in Modern style.
              </p>
            )}
          </div>
        </Section>

        {/* Sound */}
        {toastConfig.style === 'custom' && (
        <Section icon={<Bell className="w-4 h-4" />} title="Sound" desc="Choose a ringtone for incoming calls">
          <div className="space-y-2">
            <select
              value={toastConfig.soundName}
              onChange={(e) => update({ soundName: e.target.value })}
              className="w-full px-2.5 py-2 bg-win-card border border-win-border rounded-lg text-xs text-win-text focus:outline-none focus:border-win-accent transition-colors appearance-none pr-8"
            >
              <option value="chime">Chime</option>
              <option value="ring">Phone Ring</option>
              <option value="beep">Beep</option>
              <option value="gentle">Gentle</option>
            </select>
            <p className="text-[11px] text-win-text-tertiary">
              Generated by your speakers — no audio files needed.
            </p>
          </div>
        </Section>
        )}

        {/* Duration */}
        <Section icon={<Clock className="w-4 h-4" />} title="Duration" desc="How long toasts stay visible (drag to reposition)">
          <SliderField
            label="Duration"
            value={toastConfig.duration}
            min={3}
            max={30}
            step={1}
            unit="sec"
            onChange={(v) => update({ duration: v })}
          />
        </Section>
      </div>
    </div>
  );
}

function Section({ icon, title, desc, children }: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-win-surface rounded-xl border border-win-border p-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-win-accent">{icon}</span>
        <h3 className="text-sm font-semibold text-win-text">{title}</h3>
      </div>
      <p className="text-xs text-win-text-tertiary mb-2">{desc}</p>
      {children}
    </div>
  );
}

function InputField({ label, children }: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-win-text-secondary mb-1.5">{label}</label>
      {children}
    </div>
  );
}

function SliderField({ label, value, min, max, step, unit, disabled, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <div className={disabled ? 'opacity-40' : ''}>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-xs font-medium text-win-text-secondary">{label}</label>
        <span className="text-xs font-semibold text-win-accent">{value}{unit}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full disabled:opacity-40"
      />
    </div>
  );
}

function ColorField({ label, value, disabled, onChange }: {
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div className={disabled ? 'opacity-40 pointer-events-none' : ''}>
      <label className="block text-xs font-medium text-win-text-secondary mb-1.5">{label}</label>
      <div className="relative h-10 rounded-lg border border-win-border bg-win-card overflow-hidden">
        <input
          type="color"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 w-full h-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        />
        <div className="absolute inset-2 rounded pointer-events-none" style={{ backgroundColor: value }} />
        <div className="absolute bottom-1 left-2 right-2 text-xs font-mono text-win-text-secondary bg-black/40 px-1.5 py-0.5 rounded pointer-events-none truncate">
          {value}
        </div>
      </div>
    </div>
  );
}

function ToggleField({ label, value, disabled, onChange }: {
  label: string;
  value: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!value)}
      className={`flex w-full items-center justify-between rounded-lg border border-win-border/50 px-3 py-2.5 transition-colors ${disabled ? 'opacity-40 cursor-not-allowed' : 'bg-win-card hover:border-win-border hover:bg-win-surface-hover'}`}
    >
      <span className="text-sm text-win-text">{label}</span>
      <div className={`relative h-[22px] w-10 rounded-full transition-colors flex-shrink-0 ${value ? 'bg-win-accent' : 'bg-win-border'}`}>
        <div className={`absolute top-[3px] h-4 w-4 rounded-full bg-white shadow transition-transform ${value ? 'translate-x-[21px]' : 'translate-x-[3px]'}`} />
      </div>
    </button>
  );
}
