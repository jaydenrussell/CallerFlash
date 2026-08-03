import { useState, useEffect } from 'react';
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
    label: 'VoIP.ms — Canada',
    options: [
      { value: 'montreal.voip.ms', label: 'Montreal 1 (montreal.voip.ms)' },
      { value: 'montreal2.voip.ms', label: 'Montreal 2 (montreal2.voip.ms)' },
      { value: 'montreal3.voip.ms', label: 'Montreal 3 (montreal3.voip.ms)' },
      { value: 'montreal4.voip.ms', label: 'Montreal 4 (montreal4.voip.ms)' },
      { value: 'montreal5.voip.ms', label: 'Montreal 5 (montreal5.voip.ms)' },
      { value: 'montreal6.voip.ms', label: 'Montreal 6 (montreal6.voip.ms)' },
      { value: 'montreal7.voip.ms', label: 'Montreal 7 (montreal7.voip.ms)' },
      { value: 'montreal8.voip.ms', label: 'Montreal 8 (montreal8.voip.ms)' },
      { value: 'montreal9.voip.ms', label: 'Montreal 9 (montreal9.voip.ms)' },
      { value: 'montreal10.voip.ms', label: 'Montreal 10 (montreal10.voip.ms)' },
      { value: 'toronto.voip.ms', label: 'Toronto 1 (toronto.voip.ms)' },
      { value: 'toronto2.voip.ms', label: 'Toronto 2 (toronto2.voip.ms)' },
      { value: 'toronto3.voip.ms', label: 'Toronto 3 (toronto3.voip.ms)' },
      { value: 'toronto4.voip.ms', label: 'Toronto 4 (toronto4.voip.ms)' },
      { value: 'toronto5.voip.ms', label: 'Toronto 5 (toronto5.voip.ms)' },
      { value: 'toronto6.voip.ms', label: 'Toronto 6 (toronto6.voip.ms)' },
      { value: 'toronto7.voip.ms', label: 'Toronto 7 (toronto7.voip.ms)' },
      { value: 'toronto8.voip.ms', label: 'Toronto 8 (toronto8.voip.ms)' },
      { value: 'toronto9.voip.ms', label: 'Toronto 9 (toronto9.voip.ms)' },
      { value: 'toronto10.voip.ms', label: 'Toronto 10 (toronto10.voip.ms)' },
      { value: 'vancouver.voip.ms', label: 'Vancouver 1 (vancouver.voip.ms)' },
      { value: 'vancouver2.voip.ms', label: 'Vancouver 2 (vancouver2.voip.ms)' },
      { value: 'vancouver3.voip.ms', label: 'Vancouver 3 (vancouver3.voip.ms)' },
    ],
  },
  {
    label: 'VoIP.ms — United States',
    options: [
      { value: 'atlanta.voip.ms', label: 'Atlanta 1 (atlanta.voip.ms)' },
      { value: 'atlanta2.voip.ms', label: 'Atlanta 2 (atlanta2.voip.ms)' },
      { value: 'chicago.voip.ms', label: 'Chicago 1 (chicago.voip.ms)' },
      { value: 'chicago2.voip.ms', label: 'Chicago 2 (chicago2.voip.ms)' },
      { value: 'chicago3.voip.ms', label: 'Chicago 3 (chicago3.voip.ms)' },
      { value: 'chicago4.voip.ms', label: 'Chicago 4 (chicago4.voip.ms)' },
      { value: 'dallas.voip.ms', label: 'Dallas 1 (dallas.voip.ms)' },
      { value: 'dallas2.voip.ms', label: 'Dallas 2 (dallas2.voip.ms)' },
      { value: 'denver.voip.ms', label: 'Denver 1 (denver.voip.ms)' },
      { value: 'denver2.voip.ms', label: 'Denver 2 (denver2.voip.ms)' },
      { value: 'houston.voip.ms', label: 'Houston 1 (houston.voip.ms)' },
      { value: 'houston2.voip.ms', label: 'Houston 2 (houston2.voip.ms)' },
      { value: 'losangeles.voip.ms', label: 'Los Angeles 1 (losangeles.voip.ms)' },
      { value: 'losangeles2.voip.ms', label: 'Los Angeles 2 (losangeles2.voip.ms)' },
      { value: 'losangeles3.voip.ms', label: 'Los Angeles 3 (losangeles3.voip.ms)' },
      { value: 'losangeles4.voip.ms', label: 'Los Angeles 4 (losangeles4.voip.ms)' },
      { value: 'newyork.voip.ms', label: 'New York 1 (newyork.voip.ms)' },
      { value: 'newyork2.voip.ms', label: 'New York 2 (newyork2.voip.ms)' },
      { value: 'newyork3.voip.ms', label: 'New York 3 (newyork3.voip.ms)' },
      { value: 'newyork4.voip.ms', label: 'New York 4 (newyork4.voip.ms)' },
      { value: 'newyork5.voip.ms', label: 'New York 5 (newyork5.voip.ms)' },
      { value: 'newyork6.voip.ms', label: 'New York 6 (newyork6.voip.ms)' },
      { value: 'newyork7.voip.ms', label: 'New York 7 (newyork7.voip.ms)' },
      { value: 'newyork8.voip.ms', label: 'New York 8 (newyork8.voip.ms)' },
      { value: 'sanjose.voip.ms', label: 'San Jose 1 (sanjose.voip.ms)' },
      { value: 'sanjose2.voip.ms', label: 'San Jose 2 (sanjose2.voip.ms)' },
      { value: 'seattle.voip.ms', label: 'Seattle 1 (seattle.voip.ms)' },
      { value: 'seattle2.voip.ms', label: 'Seattle 2 (seattle2.voip.ms)' },
      { value: 'seattle3.voip.ms', label: 'Seattle 3 (seattle3.voip.ms)' },
      { value: 'tampa.voip.ms', label: 'Tampa 1 (tampa.voip.ms)' },
      { value: 'tampa2.voip.ms', label: 'Tampa 2 (tampa2.voip.ms)' },
      { value: 'tampa3.voip.ms', label: 'Tampa 3 (tampa3.voip.ms)' },
      { value: 'tampa4.voip.ms', label: 'Tampa 4 (tampa4.voip.ms)' },
      { value: 'washington.voip.ms', label: 'Washington DC 1 (washington.voip.ms)' },
      { value: 'washington2.voip.ms', label: 'Washington DC 2 (washington2.voip.ms)' },
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
  const [passwordDraft, setPasswordDraft] = useState('');
  const [saved, setSaved] = useState(false);

  // Sync password from store after async decryption completes. The secret is
  // held in `localConfig` only — it is never rendered into the input until the
  // user deliberately reveals it (see the eye toggle below).
  useEffect(() => {
    if (sipConfig.password) {
      setLocalConfig(prev => ({ ...prev, password: sipConfig.password }));
    }
  }, [sipConfig.password]);

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

  const handleSave = async () => {
    const configChanged = JSON.stringify(localConfig) !== JSON.stringify(sipConfig);
    // Await the save so the "Saved" indicator only appears after the
    // async encrypt + write completes (never show a false positive).
    await setSipConfig(localConfig);
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
      server: 'atlanta.voip.ms',
      port: 5060,
      username: '',
      password: '',
      authUsername: '',
      protocol: 'UDP',
      codec: 'G.711u',
      registerExpiry: 300,
    };
    setLocalConfig(defaults);
    setPasswordDraft('');
    setShowPassword(false);
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
                  onChange={(e) => updateLocal({ port: parseInt(e.target.value, 10) || 5060 })}
                  className="w-full px-3 py-2 bg-win-card border border-win-border rounded-lg text-sm text-win-text focus:outline-none focus:border-win-accent transition-colors"
                />

              </InputField>
              <InputField label="Protocol">
                <div className="relative">
                  <select
                    value={localConfig.protocol}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === 'UDP' || v === 'TCP' || v === 'TLS') {
                        if ((v === 'UDP' || v === 'TCP') && localConfig.port === 5061) {
                          updateLocal({ protocol: v, port: 5060 });
                        } else if (v === 'TLS' && localConfig.port === 5060) {
                          updateLocal({ protocol: v, port: 5061 });
                        } else {
                          updateLocal({ protocol: v });
                        }
                      }
                    }}
                    className="w-full px-3 py-2 bg-win-card border border-win-border rounded-lg text-sm text-win-text focus:outline-none focus:border-win-accent transition-colors appearance-none pr-10"
                  >
                    <option value="UDP">UDP</option>
                    <option value="TCP">TCP</option>
                    <option value="TLS">TLS</option>
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
                  onChange={(e) => updateLocal({ registerExpiry: parseInt(e.target.value, 10) || 300 })}
                  className="w-full px-3 py-2 bg-win-card border border-win-border rounded-lg text-sm text-win-text focus:outline-none focus:border-win-accent transition-colors"
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
          headerRight={
            <div
              className="flex items-start gap-1.5 rounded-lg border border-win-success/20 bg-win-success/8 px-2 py-1 max-w-[240px]"
              title="Server inputs are sanitized — paths, credentials in the URI, and whitespace are stripped. Passwords are encrypted at rest via DPAPI."
            >
              <ShieldCheck className="w-3 h-3 text-win-success flex-shrink-0 mt-0.5" />
              <p className="text-[11px] text-win-text-secondary leading-snug">
                Sanitized inputs &bull; DPAPI encryption
              </p>
            </div>
          }
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
                    value={passwordDraft}
                    onChange={(e) => {
                      setPasswordDraft(e.target.value);
                      updateLocal({ password: e.target.value });
                    }}
                    placeholder={localConfig.password ? '••••••••' : 'Enter SIP password'}
                    name="sip-password"
                    autoComplete="off"
                    spellCheck={false}
                    data-private="true"
                    className="w-full px-3 py-2 pr-10 bg-win-card border border-win-border rounded-lg text-sm text-win-text placeholder:text-win-text-tertiary focus:outline-none focus:border-win-accent transition-colors"
                  />
                  <button
                    onClick={() => {
                      if (showPassword) {
                        setShowPassword(false);
                        setPasswordDraft('');
                      } else {
                        setPasswordDraft(localConfig.password);
                        setShowPassword(true);
                      }
                    }}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-win-text-tertiary hover:text-win-text transition-colors"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                  </button>
                </div>
              </InputField>
            </div>
          </div>
        </SettingsSection>
      </div>
    </div>
  );
}

function SettingsSection({ icon, title, description, children, headerRight }: {
  icon: React.ReactNode;
  title: string;
  description: string;
  children: React.ReactNode;
  headerRight?: React.ReactNode;
}) {
  return (
    <div className="bg-win-surface rounded-xl border border-win-border p-3">
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="flex items-center gap-2">
          <span className="text-win-accent">{icon}</span>
          <h3 className="text-sm font-semibold text-win-text">{title}</h3>
        </div>
        {headerRight}
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

