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

  const handlePreview = (e: React.MouseEvent) => {
    e.stopPropagation();
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
        {/* Row 1: Style + Duration side by side */}
        <div className="bg-win-surface rounded-xl border border-win-border p-3">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-win-accent"><Bell className="w-4 h-4" /></span>
            <h3 className="text-sm font-semibold text-win-text">Notification style</h3>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => update({ style: 'custom' })}
              title="Always-on-top window with progress bar and caller details"
              className={`flex items-center gap-2 px-2.5 py-2 rounded-lg border transition-all ${
                toastConfig.style === 'custom'
                  ? 'bg-win-accent/15 border-win-accent/40 text-win-accent'
                  : 'bg-win-card border-win-border/50 text-win-text-secondary hover:border-win-border hover:bg-win-surface-hover'
              }`}
            >
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-win-accent/30 to-blue-500/20 flex items-center justify-center flex-shrink-0">
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="3" width="20" height="14" rx="2"/>
                  <path d="M8 21h8"/>
                  <path d="M12 17v4"/>
                  <circle cx="12" cy="10" r="3" fill="currentColor" stroke="none"/>
                </svg>
              </div>
              <span className="text-xs font-semibold">Modern</span>
            </button>
            <button
              type="button"
              onClick={() => update({ style: 'native' })}
              title="Standard OS notification in the notification center"
              className={`flex items-center gap-2 px-2.5 py-2 rounded-lg border transition-all ${
                toastConfig.style === 'native'
                  ? 'bg-win-accent/15 border-win-accent/40 text-win-accent'
                  : 'bg-win-card border-win-border/50 text-win-text-secondary hover:border-win-border hover:bg-win-surface-hover'
              }`}
            >
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-white/10 to-white/5 flex items-center justify-center flex-shrink-0">
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                  <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                </svg>
              </div>
              <span className="text-xs font-semibold">Native</span>
            </button>
          </div>
        </div>

        {/* Duration + Sound */}
        <div className="bg-win-surface rounded-xl border border-win-border p-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-win-accent"><Clock className="w-4 h-4" /></span>
                <h3 className="text-sm font-semibold text-win-text">Duration</h3>
              </div>
              <SliderField
                label="Display time"
                value={toastConfig.duration}
                min={3}
                max={30}
                step={1}
                unit="sec"
                onChange={(v) => update({ duration: v })}
              />
            </div>
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-win-accent"><Bell className="w-4 h-4" /></span>
                <h3 className="text-sm font-semibold text-win-text">Sound</h3>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-win-text-secondary">Ringtone</span>
                <div className="flex items-center gap-2">
                  {toastConfig.style === 'custom' ? (
                    <select
                      value={toastConfig.soundName}
                      onChange={(e) => update({ soundName: e.target.value })}
                      className="px-2 py-1 bg-win-card border border-win-border rounded-lg text-xs text-win-text focus:outline-none focus:border-win-accent transition-colors appearance-none pr-6"
                    >
                      <option value="chime">Chime</option>
                      <option value="ring">Phone Ring</option>
                      <option value="beep">Beep</option>
                      <option value="gentle">Gentle</option>
                    </select>
                  ) : (
                    <span className="text-xs text-win-text-tertiary">Uses OS default</span>
                  )}
                  <ToggleField
                    label=""
                    value={toastConfig.soundEnabled}
                    onChange={(v) => update({ soundEnabled: v })}
                    compact
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Behavior */}
        <div className="bg-win-surface rounded-xl border border-win-border p-3">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-win-accent"><RotateCcw className="w-4 h-4" /></span>
            <h3 className="text-sm font-semibold text-win-text">Behavior</h3>
          </div>
          <div className="space-y-1.5">
            <ToggleField
              label="Auto-copy to clipboard"
              description="Copy caller number to clipboard when a call arrives"
              value={toastConfig.autoCopyToClipboard}
              onChange={(v) => update({ autoCopyToClipboard: v })}
            />
            <ToggleField
              label="Show caller name"
              description="Display caller name in the toast notification"
              value={toastConfig.showCallerName}
              disabled={toastConfig.style === 'native'}
              onChange={(v) => update({ showCallerName: v })}
            />
            <ToggleField
              label="Show timestamp"
              description="Display call time in the toast notification"
              value={toastConfig.showTimestamp}
              disabled={toastConfig.style === 'native'}
              onChange={(v) => update({ showTimestamp: v })}
            />
          </div>
        </div>

        {/* Modern-only appearance */}
        {toastConfig.style === 'custom' && (
        <div className="bg-win-surface rounded-xl border border-win-border p-3 lg:col-span-2">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-win-accent"><Palette className="w-4 h-4" /></span>
            <h3 className="text-sm font-semibold text-win-text">Appearance</h3>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            <div className="col-span-1">
              <SliderField
                label="Font size"
                value={toastConfig.fontSize}
                min={10}
                max={28}
                step={1}
                unit="px"
                onChange={(v) => update({ fontSize: v })}
              />
            </div>
            <InputField label="Font">
              <select
                value={toastConfig.fontFamily}
                onChange={(e) => update({ fontFamily: e.target.value })}
                className="w-full px-2 py-1.5 bg-win-card border border-win-border rounded-lg text-xs text-win-text focus:outline-none focus:border-win-accent transition-colors appearance-none pr-6"
                style={{ fontFamily: toastConfig.fontFamily }}
              >
                {fontFamilies.map((font) => (
                  <option key={font} value={font} style={{ fontFamily: font }}>{font}</option>
                ))}
              </select>
            </InputField>
            <ColorField
              label="Text"
              value={toastConfig.textColor}
              onChange={(v) => update({ textColor: v })}
            />
            <ColorField
              label="BG"
              value={toastConfig.backgroundColor}
              onChange={(v) => update({ backgroundColor: v })}
            />
            <ColorField
              label="Accent"
              value={toastConfig.accentColor}
              onChange={(v) => update({ accentColor: v })}
            />
            <SliderField
              label="Width"
              value={toastConfig.maxWidth}
              min={300}
              max={600}
              step={10}
              unit="px"
              onChange={(v) => update({ maxWidth: v })}
            />
          </div>
          <div className="grid grid-cols-3 gap-2 mt-2">
            <SliderField
              label="Radius"
              value={toastConfig.borderRadius}
              min={0}
              max={24}
              step={1}
              unit="px"
              onChange={(v) => update({ borderRadius: v })}
            />
            <SliderField
              label="Opacity"
              value={toastConfig.opacity}
              min={50}
              max={100}
              step={1}
              unit="%"
              onChange={(v) => update({ opacity: v })}
            />
            <div />
          </div>
        </div>
        )}
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
      <label className="block text-xs font-medium text-win-text-secondary mb-1">{label}</label>
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
      <div className="flex items-center justify-between mb-1">
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
      <label className="block text-xs font-medium text-win-text-secondary mb-1">{label}</label>
      <div className="relative h-9 rounded-lg border border-win-border bg-win-card overflow-hidden">
        <input
          type="color"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 w-full h-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        />
        <div className="absolute inset-1.5 rounded pointer-events-none" style={{ backgroundColor: value }} />
        <div className="absolute bottom-0.5 left-1.5 right-1.5 text-[10px] font-mono text-win-text-secondary bg-black/40 px-1 py-0.5 rounded pointer-events-none truncate">
          {value}
        </div>
      </div>
    </div>
  );
}

function ToggleField({ label, value, disabled, onChange, compact, description }: {
  label: string;
  value: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  compact?: boolean;
  description?: string;
}) {
  if (compact) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(!value)}
        className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 transition-colors text-xs font-medium ${
          disabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-win-surface-hover'
        } ${value ? 'bg-win-accent/15 border-win-accent/30 text-win-accent' : 'bg-win-card border-win-border/50 text-win-text-secondary'}`}
      >
        {label && <span>{label}</span>}
        <span className={`inline-block w-5 h-[14px] rounded-full transition-colors ${value ? 'bg-win-accent' : 'bg-win-border'}`}>
          <span className={`block h-3 w-3 rounded-full bg-white shadow transition-transform mt-[1px] ${value ? 'translate-x-[9px]' : 'translate-x-[1px]'}`} />
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!value)}
      className={`flex w-full items-center justify-between rounded-lg border border-win-border/50 px-3 py-2.5 transition-colors ${disabled ? 'opacity-40 cursor-not-allowed' : 'bg-win-card hover:border-win-border hover:bg-win-surface-hover'}`}
    >
      <div className="text-left min-w-0 pr-2">
        <span className="text-sm text-win-text">{label}</span>
        {description && (
          <p className="text-[11px] text-win-text-tertiary leading-tight mt-0.5">{description}</p>
        )}
      </div>
      <div className={`relative h-[22px] w-10 rounded-full transition-colors flex-shrink-0 ${value ? 'bg-win-accent' : 'bg-win-border'}`}>
        <div className={`absolute top-[3px] h-4 w-4 rounded-full bg-white shadow transition-transform ${value ? 'translate-x-[21px]' : 'translate-x-[3px]'}`} />
      </div>
    </button>
  );
}
