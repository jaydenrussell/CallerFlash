import {
  Phone, Shield,
  Code, BookOpen, Zap, GitBranch
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { formatVersion } from '../utils/formatVersion';

export function About() {
  const { updateInfo } = useAppStore();

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Compact header — single GitHub link is in the sidebar footer. */}
      <div>
        <h2 className="text-xl font-bold text-win-text">About</h2>
        <p className="text-xs text-win-text-secondary mt-0.5">
          CallerFlash {formatVersion(updateInfo.currentVersion)} · MIT License
        </p>
      </div>

      <p className="text-sm text-win-text-secondary">
        SIP-compliant Windows client with toast notifications, clipboard
        auto-copy, and a system-tray background listener that keeps SIP
        registration alive when the window is hidden.
      </p>

      {/* Features Grid */}
      <div>
        <h3 className="text-sm font-semibold text-win-text mb-2">Features</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          <FeatureCard
            icon={<Phone className="w-3.5 h-3.5" />}
            title="Universal SIP"
            description="UDP, TCP, or TLS — works with any compliant SIP provider."
            color="#60cdff"
          />
          <FeatureCard
            icon={<Zap className="w-3.5 h-3.5" />}
            title="Toast Notifications"
            description="Modern customizable or Windows Native — two distinct styles."
            color="#f59e0b"
          />
          <FeatureCard
            icon={<Shield className="w-3.5 h-3.5" />}
            title="Clipboard Auto-Copy"
            description="Sanitized caller number auto-copied to clipboard."
            color="#6ccb5f"
          />
          <FeatureCard
            icon={<Code className="w-3.5 h-3.5" />}
            title="Full Customization"
            description="Font, colors, position, duration, border radius, opacity."
            color="#a78bfa"
          />
          <FeatureCard
            icon={<GitBranch className="w-3.5 h-3.5" />}
            title="Verified Updates"
            description="Authenticode + SHA-256 + Ed25519 — three independent layers."
            color="#34d399"
          />
          <FeatureCard
            icon={<BookOpen className="w-3.5 h-3.5" />}
            title="Diagnostics"
            description="SIP, toast, and system logs with export."
            color="#f472b6"
          />
        </div>
      </div>

      {/* Tech Stack */}
      <div className="bg-win-surface rounded-xl border border-win-border p-3">
        <h3 className="text-sm font-semibold text-win-text mb-2 flex items-center gap-2">
          <Code className="w-4 h-4 text-win-accent" />
          Technology Stack
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1.5">
          {[
            { name: 'Tauri', desc: 'Desktop runtime' },
            { name: 'React', desc: 'UI framework' },
            { name: 'TypeScript', desc: 'Type safety' },
            { name: 'Tailwind CSS', desc: 'Styling' },
            { name: 'Zustand', desc: 'State' },
            { name: 'lucide-react', desc: 'Icons' },
          ].map((tech) => (
            <div key={tech.name} className="px-2.5 py-1.5 bg-win-card rounded-lg border border-win-border/50">
              <p className="text-xs font-medium text-win-text">{tech.name}</p>
              <p className="text-[10px] text-win-text-tertiary">{tech.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function FeatureCard({ icon, title, description, color }: {
  icon: React.ReactNode;
  title: string;
  description: string;
  color: string;
}) {
  return (
    <div className="bg-win-surface rounded-xl border border-win-border p-4 hover:border-win-border-light transition-colors">
      <div className="flex items-center gap-2.5 mb-2">
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: `${color}15`, color }}
        >
          {icon}
        </div>
        <h4 className="text-sm font-semibold text-win-text">{title}</h4>
      </div>
      <p className="text-xs text-win-text-tertiary leading-relaxed">{description}</p>
    </div>
  );
}
