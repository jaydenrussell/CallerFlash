import { useState } from 'react';
import {
  Phone, PhoneIncoming, PhoneMissed, PhoneOutgoing,
  Search, Trash2, Copy, Check, Filter, Download
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';

export function CallHistory() {
  const { callHistory, clearCallHistory, setClipboardText, addDiagnosticLog } = useAppStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const filteredCalls = callHistory.filter((call) => {
    const matchesSearch =
      call.callerNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
      call.callerName.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesFilter = filterStatus === 'all' || call.status === filterStatus;
    return matchesSearch && matchesFilter;
  });

  const handleCopy = (number: string, id: string) => {
    const clean = number.replace(/\D/g, '');
    navigator.clipboard?.writeText(clean).catch(() => {});
    setClipboardText(clean);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
    addDiagnosticLog({
      level: 'info',
      category: 'SYSTEM',
      message: `Copied number to clipboard from call history`,
    });
  };

  const exportCSV = () => {
    const csv = [
      'Number,Name,Time,Direction,Status',
      ...callHistory.map(c =>
        `"${c.callerNumber}","${c.callerName}","${c.timestamp.toISOString()}","${c.direction}","${c.status}"`
      ),
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `callerflash-history-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);

    addDiagnosticLog({
      level: 'info',
      category: 'SYSTEM',
      message: `Exported ${callHistory.length} call records to CSV`,
    });
  };

  return (
    <div className="flex flex-col h-full space-y-3 animate-fade-in">
      <div className="flex flex-wrap items-center justify-between gap-3 flex-shrink-0">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-win-text">Call History</h2>
          <p className="text-xs text-win-text-secondary mt-0.5">
            {callHistory.length} total calls • Click any number to copy to clipboard
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={exportCSV}
            disabled={callHistory.length === 0}
            className="flex items-center gap-2 px-3.5 py-2 bg-win-surface hover:bg-win-surface-hover text-win-text-secondary rounded-lg text-sm font-medium transition-colors border border-win-border disabled:opacity-40"
          >
            <Download className="w-4 h-4" />
            Export CSV
          </button>
          <button
            onClick={clearCallHistory}
            disabled={callHistory.length === 0}
            className="flex items-center gap-2 px-3.5 py-2 bg-win-error/10 hover:bg-win-error/20 text-win-error rounded-lg text-sm font-medium transition-colors border border-win-error/20 disabled:opacity-40"
          >
            <Trash2 className="w-4 h-4" />
            Clear All
          </button>
        </div>
      </div>

      {/* Search and Filter Bar */}
      <div className="flex flex-wrap items-center gap-3 flex-shrink-0">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-win-text-tertiary" />
          <input
            type="text"
            placeholder="Search by name or number..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-win-surface border border-win-border rounded-lg text-sm text-win-text placeholder:text-win-text-tertiary focus:outline-none focus:border-win-accent transition-colors"
          />
        </div>
        <div className="flex items-center gap-1 bg-win-surface border border-win-border rounded-lg p-1">
          <Filter className="w-4 h-4 text-win-text-tertiary ml-2" />
          {['all', 'answered', 'missed', 'rejected'].map((status) => (
            <button
              key={status}
              onClick={() => setFilterStatus(status)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                filterStatus === status
                  ? 'bg-win-accent/20 text-win-accent'
                  : 'text-win-text-secondary hover:text-win-text hover:bg-win-surface-hover'
              }`}
            >
              {status.charAt(0).toUpperCase() + status.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Call List - fills remaining height */}
      <div className="flex-1 min-h-0 bg-win-surface rounded-xl border border-win-border overflow-hidden flex flex-col">
        {/* Header */}
        <div className="grid grid-cols-12 gap-4 px-4 py-3 border-b border-win-border bg-win-card flex-shrink-0">
          <span className="col-span-1 text-xs font-semibold text-win-text-tertiary uppercase tracking-wider">Type</span>
          <span className="col-span-3 text-xs font-semibold text-win-text-tertiary uppercase tracking-wider">Number</span>
          <span className="col-span-3 text-xs font-semibold text-win-text-tertiary uppercase tracking-wider">Caller Name</span>
          <span className="col-span-2 text-xs font-semibold text-win-text-tertiary uppercase tracking-wider">Time</span>
          <span className="col-span-1 text-xs font-semibold text-win-text-tertiary uppercase tracking-wider">Status</span>
          <span className="col-span-2 text-xs font-semibold text-win-text-tertiary uppercase tracking-wider text-right">Actions</span>
        </div>

        {/* Rows - scrollable */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {filteredCalls.length === 0 ? (
            <div className="text-center py-12">
              <Phone className="w-10 h-10 text-win-text-tertiary mx-auto mb-3" />
              <p className="text-sm text-win-text-secondary">
                {callHistory.length === 0 ? 'No calls recorded yet' : 'No calls match your search'}
              </p>
            </div>
          ) : (
            filteredCalls.map((call) => (
              <div
                key={call.id}
                className="grid grid-cols-12 gap-4 px-4 py-3 border-b border-win-border/50 hover:bg-win-surface-hover transition-colors items-center group"
              >
                <div className="col-span-1">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                    call.direction === 'inbound'
                      ? call.status === 'answered' ? 'bg-win-success/15' : 'bg-win-error/15'
                      : 'bg-win-accent/15'
                  }`}>
                    {call.direction === 'inbound' ? (
                      call.status === 'answered' ? (
                        <PhoneIncoming className="w-4 h-4 text-win-success" />
                      ) : (
                        <PhoneMissed className="w-4 h-4 text-win-error" />
                      )
                    ) : (
                      <PhoneOutgoing className="w-4 h-4 text-win-accent" />
                    )}
                  </div>
                </div>
                <div className="col-span-3">
                  <p className="text-sm font-semibold text-win-text font-mono tracking-wide">
                    {call.callerNumber}
                  </p>
                </div>
                <div className="col-span-3">
                  <p className="text-sm text-win-text-secondary">{call.callerName}</p>
                </div>
                <div className="col-span-2">
                  <p className="text-xs text-win-text-secondary">
                    {call.timestamp.toLocaleDateString()}
                  </p>
                  <p className="text-xs text-win-text-tertiary">
                    {call.timestamp.toLocaleTimeString()}
                  </p>
                </div>
                <div className="col-span-1">
                  <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold ${
                    call.status === 'answered' ? 'bg-win-success/15 text-win-success' :
                    call.status === 'missed' ? 'bg-win-error/15 text-win-error' :
                    'bg-win-warning/15 text-win-warning'
                  }`}>
                    {call.status}
                  </span>
                </div>
                <div className="col-span-2 flex justify-end">
                  <button
                    onClick={() => handleCopy(call.callerNumber, call.id)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-win-accent/10 text-win-accent hover:bg-win-accent/20 transition-colors opacity-0 group-hover:opacity-100"
                  >
                    {copiedId === call.id ? (
                      <>
                        <Check className="w-3.5 h-3.5" />
                        Copied!
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        Copy
                      </>
                    )}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
