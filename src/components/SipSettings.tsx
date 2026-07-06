import { useState } from 'react';
import {
  Server, Lock, Save, RotateCcw,
  ChevronDown, Eye, EyeOff, ShieldCheck, Wifi, WifiOff
} from 'lucide-react';
import { useAppStore, type SipConfig } from '../store/useAppStore';
import { sanitizeSipServer } from '../security/secretRedactor';

interface ProviderOption {
  value: string;
  label: string;
}

interface ProviderGroup {
  label: string;
  options: ProviderOption[];
}

const sipProviders: ProviderGroup[] = [
  {
    label: 'Custom',
    options: [
      { value: '__custom__', label: 'Custom SIP Server…' },
    ],
  },
  {
    label: 'VoIP.ms',
    options: [
      { value: 'atlanta1.voip.ms', label: 'Atlanta 1 (atlanta1.voip.ms)' },
      { value: 'atlanta2.voip.ms', label: 'Atlanta 2 (atlanta2.voip.ms)' },
      { value: 'chicago1.voip.ms', label: 'Chicago 1 (chicago1.voip.ms)' },
      { value: 'chicago2.voip.ms', label: 'Chicago 2 (chicago2.voip.ms)' },
      { value: 'dallas1.voip.ms', label: 'Dallas 1 (dallas1.voip.ms)' },
      { value: 'dallas2.voip.ms', label: 'Dallas 2 (dallas2.voip.ms)' },
      { value: 'denver1.voip.ms', label: 'Denver (denver1.voip.ms)' },
      { value: 'houston1.voip.ms', label: 'Houston (houston1.voip.ms)' },
      { value: 'losangeles1.voip.ms', label: 'Los Angeles (losangeles1.voip.ms)' },
      { value: 'montreal1.voip.ms', label: 'Montreal 1 (montreal1.voip.ms)' },
      { value: 'montreal2.voip.ms', label: 'Montreal 2 (montreal2.voip.ms)' },
      { value: 'newyork1.voip.ms', label: 'New York 1 (newyork1.voip.ms)' },
      { value: 'newyork2.voip.ms', label: 'New York 2 (newyork2.voip.ms)' },
      { value: 'seattle1.voip.ms', label: 'Seattle (seattle1.voip.ms)' },
      { value: 'toronto1.voip.ms', label: 'Toronto 1 (toronto1.voip.ms)' },
      { value: 'toronto2.voip.ms', label: 'Toronto 2 (toronto2.voip.ms)' },
      { value: 'vancouver1.voip.ms', label: 'Vancouver (vancouver1.voip.ms)' },
    ],
  },
  {
    label: 'Twilio',
    options: [
      { value: 'sip.twilio.com', label: 'Twilio Global (sip.twilio.com)' },
    ],
  },
  {
    label: 'Telnyx',
    options: [
      { value: 'sip.telnyx.com', label: 'Telnyx Global (sip.telnyx.com)' },
    ],
  },
  {
    label: 'Bandwidth',
    options: [
      { value: 'gw.bandwidth.com', label: 'Bandwidth Gateway (gw.bandwidth.com)' },
    ],
  },
  {
    label: 'Vonage / Nexmo',
    options: [
      { value: 'sip.nexmo.com', label: 'Vonage / Nexmo (sip.nexmo.com)' },
    ],
  },
  {
    label: 'Plivo',
    options: [
      { value: 'phone.plivo.com', label: 'Plivo (phone.plivo.com)' },
    ],
  },
  {
    label: 'Flowroute',
    options: [
      { value: 'sip.flowroute.com', label: 'Flowroute (sip.flowroute.com)' },
    ],
  },
  {
    label: 'Anveo',
    options: [
      { value: 'sip.anveo.com', label: 'Anveo (sip.anveo.com)' },
    ],
  },
  {
    label: 'CallCentric',
    options: [
      { value: 'callcentric.com', label: 'CallCentric (callcentric.com)' },
    ],
  },
  {
    label: 'Sipgate',
    options: [
      { value: 'sipgate.com', label: 'Sipgate (sipgate.com)' },
      { value: 'sipgate.co.uk', label: 'Sipgate UK (sipgate.co.uk)' },
    ],
  },
  {
    label: 'OnSIP',
    options: [
      { value: 'sip.onsip.com', label: 'OnSIP (sip.onsip.com)' },
    ],
  },
  {
    label: '8x8',
    options: [
      { value: 'sip.8x8.com', label: '8x8 (sip.8x8.com)' },
    ],
  },
  {
    label: 'RingCentral',
    options: [
      { value: 'sip.ringcentral.com', label: 'RingCentral (sip.ringcentral.com)' },
    ],
  },
];

// Flat list of all known server values for membership checking
const knownServerValues = new Set(
  sipProviders.flatMap((g) => g.options.map((o) => o.value)).filter((v) => v !== '__custom__')
);

export function SipSettings() {
  const {
    sipConfig,
    setSipConfig,
    addDiagnosticLog,
    sipConnected,
    sipRegistered,
    isConnecting,
    connectSip,
    disconnectSip,
  } = useAppStore();
  const [localConfig, setLocalConfig] = useState<SipConfig>({ ...sipConfig });
  const [showPassword, setShowPassword] = useState(false);
  const [saved, setSaved] = useState(false);

  // Custom mode is on if the current server isn't in the known list
  const isCustomServer = !knownServerValues.has(localConfig.server);
  const [customMode, setCustomMode] = useState(isCustomServer);

  const updateLocal = (updates: Partial<SipConfig>) => {
    setLocalConfig((prev) => ({ ...prev, ...updates }));
  };

  const handleServerSelect = (value: string) => {
    if (value === '__custom__') {
      setCustomMode(true);
      updateLocal({ server: '' });
    } else {
      setCustomMode(false);
      updateLocal({ server: value });
    }
  };

  const handleConnectToggle = () => {
    if (sipConnected) {
      disconnectSip();
      return;
    }
    connectSip();
  };

  const handleSave = () => {
    const configChanged = JSON.stringify(localConfig) !== JSON.stringify(sipConfig);
    setSipConfig(localConfig);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    addDiagnosticLog({
      level: 'success',
      category: 'SIP',
      message: 'SIP configuration saved',
      details: `Server: ${localConfig.server}:${localConfig.port}, Protocol: ${localConfig.protocol}`,
    });
    
    // If connected and config changed, reconnect with new settings
    if (sipConnected && configChanged) {
      addDiagnosticLog({
        level: 'info',
        category: 'SIP',
        message: 'Settings changed — reconnecting with new configuration…',
      });
      disconnectSip();
      // Delay slightly to let the socket close before reconnecting
      setTimeout(() => {
        connectSip();
      }, 500);
    } else if (!sipConnected && localConfig.server && localConfig.username && localConfig.password) {
      // Auto-connect on save if not connected
      connectSip();
    }
  };

  const handleReset = () => {
    const defaults: SipConfig = {
      server: 'atlanta1.voip.ms',
      port: 5060,
      username: '',
      password: '',
      authUsername: '',
      protocol: 'UDP',
      codec: 'G.711u',
      stunServer: 'stun.l.google.com',
      registerExpiry: 300,
    };
    setLocalConfig(defaults);
    setCustomMode(false);
    addDiagnosticLog({
      level: 'info',
      category: 'SIP',
      message: 'SIP configuration reset to defaults',
    });
  };

  const dropdownValue = customMode ? '__custom__' : localConfig.server;

  return (
    <div className="space-y-3 animate-fade-in">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-win-text">SIP Settings</h2>
          <p className="text-xs text-win-text-secondary mt-0.5">Connection parameters for your SIP provider</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {sipConnected && (
            <div className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium mr-1 ${
              sipRegistered 
                ? 'bg-win-success/10 border-win-success/20 text-win-success'
                : 'bg-win-warning/10 border-win-warning/20 text-win-warning'
            }`}>
              {sipRegistered ? <ShieldCheck className="w-3.5 h-3.5" /> : <div className="w-3.5 h-3.5 border-2 border-win-warning border-t-transparent rounded-full animate-spin" />}
              {sipRegistered ? 'Registered' : 'Registering...'}
            </div>
          )}
          <button
            onClick={handleConnectToggle}
            disabled={isConnecting}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
              sipConnected
                ? 'bg-win-error/15 hover:bg-win-error/25 text-win-error border border-win-error/20'
                : 'bg-win-success/15 hover:bg-win-success/25 text-win-success border border-win-success/20'
            } disabled:opacity-50`}
          >
            {isConnecting ? (
              <>
                <div className="w-3.5 h-3.5 border-2 border-win-accent border-t-transparent rounded-full animate-spin" />
                Connecting…
              </>
            ) : sipConnected ? (
              <>
                <WifiOff className="w-4 h-4" />
                Disconnect
              </>
            ) : (
              <>
                <Wifi className="w-4 h-4" />
                Connect
              </>
            )}
          </button>
          <button
            onClick={handleReset}
            className="flex items-center gap-2 px-3 py-1.5 bg-win-surface hover:bg-win-surface-hover text-win-text-secondary rounded-lg text-sm font-medium transition-colors border border-win-border"
          >
            <RotateCcw className="w-4 h-4" />
            Reset
          </button>
          <button
            onClick={handleSave}
            className="flex items-center gap-2 px-3.5 py-1.5 bg-win-accent hover:bg-win-accent-hover text-black rounded-lg text-sm font-semibold transition-colors"
          >
            <Save className="w-4 h-4" />
            {saved ? 'Saved!' : 'Save'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
        {/* Server Configuration */}
        <SettingsSection
          icon={<Server className="w-4 h-4" />}
          title="Server"
          description="SIP server address and connection"
        >
          <div className="space-y-3">
            <InputField label="SIP Provider">
              <div className="relative">
                <select
                  value={dropdownValue}
                  onChange={(e) => handleServerSelect(e.target.value)}
                  className="w-full px-3 py-2 bg-win-card border border-win-border rounded-lg text-sm text-win-text focus:outline-none focus:border-win-accent transition-colors appearance-none pr-10"
                >
                  {sipProviders.map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {group.options.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-win-text-tertiary pointer-events-none" />
              </div>
            </InputField>

            <InputField
              label="Server Address"
              hint={customMode ? 'any host or IP' : 'editable'}
            >
              <input
                type="text"
                value={localConfig.server}
                onChange={(e) => {
                  const safe = sanitizeSipServer(e.target.value);
                  if (e.target.value.trim() && !safe) {
                    addDiagnosticLog({
                      level: 'warning',
                      category: 'SIP',
                      message: 'Rejected SIP server input — contains path, userinfo, or whitespace',
                    });
                    return;
                  }
                  updateLocal({ server: safe });
                  setCustomMode(!knownServerValues.has(safe));
                }}
                placeholder="sip.example.com"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                className="w-full px-3 py-2 bg-win-card border border-win-border rounded-lg text-sm text-win-text font-mono placeholder:text-win-text-tertiary focus:outline-none focus:border-win-accent transition-colors"
              />
            </InputField>

            <div className="grid grid-cols-2 gap-2">
              <InputField label="Port">
                <input
                  type="number"
                  value={localConfig.port}
                  onChange={(e) => updateLocal({ port: parseInt(e.target.value) || 5060 })}
                  className="w-full px-3 py-2 bg-win-card border border-win-border rounded-lg text-sm text-win-text focus:outline-none focus:border-win-accent transition-colors"
                />
              </InputField>
              <InputField label="Protocol">
                <div className="relative">
                  <select
                    value={localConfig.protocol}
                    onChange={(e) => updateLocal({ protocol: e.target.value as any })}
                    className="w-full px-3 py-2 bg-win-card border border-win-border rounded-lg text-sm text-win-text focus:outline-none focus:border-win-accent transition-colors appearance-none pr-10"
                  >
                    <option value="UDP">UDP</option>
                    <option value="TCP">TCP</option>
                    <option value="TLS">TLS (Encrypted)</option>
                  </select>
                  <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-win-text-tertiary pointer-events-none" />
                </div>
              </InputField>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <InputField label="Registration Expiry" hint="seconds">
                <input
                  type="number"
                  min={30}
                  max={3600}
                  value={localConfig.registerExpiry}
                  onChange={(e) => updateLocal({ registerExpiry: parseInt(e.target.value) || 300 })}
                  className="w-full px-3 py-2 bg-win-card border border-win-border rounded-lg text-sm text-win-text focus:outline-none focus:border-win-accent transition-colors"
                />
              </InputField>
              <InputField label="STUN Server">
                <input
                  type="text"
                  value={localConfig.stunServer}
                  onChange={(e) => updateLocal({ stunServer: e.target.value })}
                  placeholder="stun.l.google.com"
                  className="w-full px-3 py-2 bg-win-card border border-win-border rounded-lg text-sm text-win-text font-mono placeholder:text-win-text-tertiary focus:outline-none focus:border-win-accent transition-colors"
                />
              </InputField>
            </div>
          </div>
        </SettingsSection>

        {/* Authentication */}
        <SettingsSection
          icon={<Lock className="w-4 h-4" />}
          title="Authentication"
          description="SIP account credentials"
        >
          <div className="space-y-2">
            <InputField label="SIP Username">
              <input
                type="text"
                value={localConfig.username}
                onChange={(e) => updateLocal({ username: e.target.value })}
                placeholder="username"
                className="w-full px-3 py-2 bg-win-card border border-win-border rounded-lg text-sm text-win-text placeholder:text-win-text-tertiary focus:outline-none focus:border-win-accent transition-colors"
              />
            </InputField>

            <div className="grid grid-cols-2 gap-2">
              <InputField label="Auth Username" hint="usually the same">
                <input
                  type="text"
                  value={localConfig.authUsername}
                  onChange={(e) => updateLocal({ authUsername: e.target.value })}
                  placeholder="username"
                  className="w-full px-3 py-2 bg-win-card border border-win-border rounded-lg text-sm text-win-text placeholder:text-win-text-tertiary focus:outline-none focus:border-win-accent transition-colors"
                />
              </InputField>
              <InputField label="SIP Password">
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={localConfig.password}
                    onChange={(e) => updateLocal({ password: e.target.value })}
                    placeholder="••••••••"
                    name="sip-password"
                    autoComplete="off"
                    spellCheck={false}
                    data-private="true"
                    className="w-full px-3 py-2 pr-10 bg-win-card border border-win-border rounded-lg text-sm text-win-text placeholder:text-win-text-tertiary focus:outline-none focus:border-win-accent transition-colors"
                  />
                  <button
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-win-text-tertiary hover:text-win-text transition-colors"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </InputField>
            </div>

            <div
              className="flex items-start gap-1.5 rounded-lg border border-win-success/20 bg-win-success/8 px-2.5 py-1.5"
              title="Server inputs are sanitized — paths, credentials in the URI, and whitespace are stripped. Passwords are encrypted at rest (Windows DPAPI via Electron safeStorage in production)."
            >
              <ShieldCheck className="w-3 h-3 text-win-success flex-shrink-0 mt-0.5" />
              <p className="text-[11px] text-win-text-secondary leading-snug">
                Server inputs are sanitized. Passwords encrypted at rest via DPAPI.
              </p>
            </div>
          </div>
        </SettingsSection>
      </div>
    </div>
  );
}

function SettingsSection({ icon, title, description, children }: {
  icon: React.ReactNode;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-win-surface rounded-xl border border-win-border p-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-win-accent">{icon}</span>
        <h3 className="text-sm font-semibold text-win-text">{title}</h3>
      </div>
      <p className="text-xs text-win-text-tertiary mb-2">{description}</p>
      {children}
    </div>
  );
}

function InputField({ label, hint, children }: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-win-text-secondary mb-1.5">
        {label}
        {hint && <span className="text-win-text-tertiary ml-1 font-normal">({hint})</span>}
      </label>
      {children}
    </div>
  );
}

