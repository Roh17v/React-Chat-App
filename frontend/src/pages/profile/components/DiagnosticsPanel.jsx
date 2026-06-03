/**
 * DiagnosticsPanel — shows offline-layer diagnostics for support/debugging.
 *
 * Renders the output of `getDiagnostics().snapshot()`:
 *   - localEncryption status with a visible warning when encryption is "none" (Req 10.4)
 *   - schemaVersion
 *   - mediaCacheSize (human-readable)
 *   - outboundQueueLength
 *   - ring-buffer events (scrollable list)
 *
 * A "Copy diagnostics" button writes `getDiagnostics().toClipboardText()` to
 * the clipboard (Requirements 14.1, 14.2, 14.3, 14.4).
 *
 * NOTE: This component only renders what the Diagnostics module exposes.
 * Message contents, file bytes, and auth tokens are already scrubbed by the
 * module itself (Req 14.4).
 */

import React, { useState, useCallback } from "react";
import { FiArrowLeft, FiClipboard, FiCheckCircle, FiAlertTriangle, FiShield, FiDatabase, FiSend, FiTag } from "react-icons/fi";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { getDiagnostics } from "@/offline/utils/Diagnostics";
import useAppStore from "@/store";

/**
 * Format a byte count as a human-readable string (e.g. "12.3 MB").
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return i === 0 ? `${value} B` : `${value.toFixed(1)} ${units[i]}`;
}

/**
 * Write text to clipboard. Tries the modern Clipboard API first, then falls
 * back to a hidden textarea + execCommand for older WebViews.
 * @param {string} text
 * @returns {Promise<void>}
 */
async function writeToClipboard(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Fallback for older WebViews (e.g. Android System WebView < 66)
  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  el.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0";
  document.body.appendChild(el);
  el.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(el);
  if (!ok) throw new Error("execCommand copy failed");
}

/**
 * A single diagnostic event row.
 * @param {{ event: import("@/offline/utils/Diagnostics").DiagnosticsEvent }} props
 */
function EventRow({ event }) {
  const outcomeColor =
    event.outcome === "ok"
      ? "text-emerald-400"
      : event.outcome === "warn"
        ? "text-amber-400"
        : "text-red-400";

  return (
    <div className="grid grid-cols-[1fr_auto] gap-x-3 py-2 px-3 border-b border-border-subtle/40 last:border-0 hover:bg-background-tertiary/40 transition-colors">
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-mono text-foreground-muted">{event.ts}</span>
          <span className="text-xs font-semibold text-foreground bg-background-tertiary rounded px-1.5 py-0.5">
            {event.category}
          </span>
          <span className="text-xs font-mono text-foreground-secondary">{event.code}</span>
          {event.durationMs != null && (
            <span className="text-xs text-foreground-muted">{event.durationMs}ms</span>
          )}
        </div>
        {event.meta && (
          <div className="mt-0.5 text-xs font-mono text-foreground-muted truncate">
            {JSON.stringify(event.meta)}
          </div>
        )}
      </div>
      <span className={`text-xs font-semibold self-start pt-0.5 ${outcomeColor}`}>
        {event.outcome}
      </span>
    </div>
  );
}

/**
 * A labelled stat row in the summary section.
 */
function StatRow({ icon: Icon, label, value, valueClassName }) {
  return (
    <div className="flex items-center justify-between py-2.5 px-3 border-b border-border-subtle/40 last:border-0">
      <div className="flex items-center gap-2 text-sm text-foreground-secondary">
        {Icon && <Icon className="w-4 h-4 text-foreground-muted" />}
        {label}
      </div>
      <span className={`text-sm font-mono font-medium ${valueClassName || "text-foreground"}`}>
        {value}
      </span>
    </div>
  );
}

/**
 * DiagnosticsPanel component.
 * @param {{ onBack: () => void }} props
 */
const DiagnosticsPanel = ({ onBack }) => {
  // Read localEncryption from the store (kept in sync by OfflineProvider)
  const localEncryption = useAppStore((state) => state.localEncryption);

  // Take a fresh snapshot on every render so the data is current
  const snapshot = getDiagnostics().snapshot();

  const [copying, setCopying] = useState(false);

  const handleCopy = useCallback(async () => {
    setCopying(true);
    try {
      const text = getDiagnostics().toClipboardText();
      await writeToClipboard(text);
      toast.success("Diagnostics copied to clipboard.");
    } catch (err) {
      console.error("[DiagnosticsPanel] clipboard write failed:", err);
      toast.error("Could not copy to clipboard.");
    } finally {
      setCopying(false);
    }
  }, []);

  const encryptionIsNone = localEncryption === "none";

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background p-4">
      {/* Ambient background */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 -left-32 w-96 h-96 bg-primary/10 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 -right-32 w-96 h-96 bg-primary/5 rounded-full blur-3xl" />
      </div>

      <div className="relative w-full max-w-lg animate-fade-in">
        {/* Back button */}
        <button
          onClick={onBack}
          className="absolute -top-12 left-0 flex items-center gap-2 text-foreground-secondary hover:text-foreground transition-colors group"
        >
          <FiArrowLeft className="w-5 h-5 group-hover:-translate-x-1 transition-transform" />
          <span className="text-sm font-medium">Back to profile</span>
        </button>

        {/* Card */}
        <div className="bg-background-secondary/80 backdrop-blur-xl border border-border rounded-3xl overflow-hidden shadow-chat-lg">
          {/* Top accent */}
          <div className="h-1 bg-gradient-to-r from-primary via-primary to-transparent" />

          <div className="p-6">
            {/* Header */}
            <div className="mb-6">
              <h1 className="text-xl font-bold text-foreground">Diagnostics</h1>
              <p className="text-sm text-foreground-secondary mt-1">
                Offline layer status &amp; event log
              </p>
            </div>

            {/* Encryption warning banner (Req 10.4) */}
            {encryptionIsNone && (
              <div className="mb-4 flex items-start gap-3 rounded-xl bg-amber-500/10 border border-amber-500/30 px-4 py-3">
                <FiAlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-amber-200">
                  ⚠️ Local data is not encrypted on this device.
                </p>
              </div>
            )}

            {/* Summary stats */}
            <div className="mb-5 rounded-xl bg-background-tertiary/60 border border-border-subtle overflow-hidden">
              <StatRow
                icon={FiShield}
                label="Local encryption"
                value={localEncryption ?? "—"}
                valueClassName={encryptionIsNone ? "text-amber-400" : "text-emerald-400"}
              />
              <StatRow
                icon={FiTag}
                label="Schema version"
                value={snapshot.schemaVersion != null ? String(snapshot.schemaVersion) : "—"}
              />
              <StatRow
                icon={FiDatabase}
                label="Media cache size"
                value={formatBytes(snapshot.mediaCacheSize)}
              />
              <StatRow
                icon={FiSend}
                label="Outbound queue"
                value={String(snapshot.outboundQueueLength)}
              />
            </div>

            {/* Event log */}
            <div className="mb-5">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-semibold text-foreground-secondary uppercase tracking-wide">
                  Event log
                </h2>
                <span className="text-xs text-foreground-muted">
                  {snapshot.events.length} event{snapshot.events.length !== 1 ? "s" : ""}
                </span>
              </div>
              <div className="rounded-xl border border-border-subtle overflow-hidden bg-background-tertiary/30">
                {snapshot.events.length === 0 ? (
                  <div className="py-8 text-center text-sm text-foreground-muted">
                    No events recorded yet.
                  </div>
                ) : (
                  <ScrollArea className="h-64">
                    {/* Show newest events first for quick triage */}
                    {[...snapshot.events].reverse().map((event, i) => (
                      <EventRow key={i} event={event} />
                    ))}
                  </ScrollArea>
                )}
              </div>
            </div>

            {/* Copy button */}
            <Button
              onClick={handleCopy}
              disabled={copying}
              className="w-full h-12 bg-primary hover:bg-primary-hover text-primary-foreground rounded-xl font-semibold text-base shadow-chat-glow transition-all duration-200 hover:shadow-lg disabled:opacity-50"
            >
              {copying ? (
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                  Copying…
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <FiClipboard className="w-4 h-4" />
                  Copy diagnostics
                </div>
              )}
            </Button>

            {/* Privacy note */}
            <p className="mt-3 text-center text-xs text-foreground-muted">
              Message content, file data, and auth tokens are never included.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DiagnosticsPanel;
