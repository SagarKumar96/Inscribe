"use client";
import { useEffect, useMemo, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import * as Dialog from "@radix-ui/react-dialog";
// Removed sonner to use unified in-app toasts
import * as Tabs from "@radix-ui/react-tabs";
import { motion } from "framer-motion";
import { useTheme as useNextTheme } from "next-themes";
import { getVersion } from "@tauri-apps/api/app";

const GH_OWNER = process.env.NEXT_PUBLIC_GH_OWNER || "";
const GH_REPO = process.env.NEXT_PUBLIC_GH_REPO || "";

interface BlockDevice {
  name: string;
  path: string;
  size: string;
  model?: string;
  vendor?: string;
  serial?: string;
  transport?: string;
  removable: boolean;
}

function bytesToGiB(bytesStr: string): string {
  const n = Number(bytesStr);
  if (!Number.isFinite(n) || n <= 0) return "-";
  return (n / 1024 ** 3).toFixed(2) + " GiB";
}

function getErrorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    return typeof m === "string" ? m : JSON.stringify(err);
  }
  try { return JSON.stringify(err); } catch { return String(err); }
}

export default function Home() {
  const [devices, setDevices] = useState<BlockDevice[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDevice, setSelectedDevice] = useState<string>("");
  const [isoPath, setIsoPath] = useState<string>("");
  const [progressBytes, setProgressBytes] = useState<number>(0);
  const [flashing, setFlashing] = useState(false);
  const [erasing, setErasing] = useState(false);
  const [formatting, setFormatting] = useState(false);
  const [formatPercent, setFormatPercent] = useState<number | null>(null);
  const [eraseMode, setEraseMode] = useState<string>(typeof window !== "undefined" ? (localStorage.getItem("ds:eraseMode") ?? "auto") : "auto");
  const [formatFs, setFormatFs] = useState<string>("ext4");
  const [formatLabel, setFormatLabel] = useState<string>("USB");
  const [totalBytes, setTotalBytes] = useState<number | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [toasts, setToasts] = useState<{ id: number; type: "info" | "success" | "error"; message: string }[]>([]);
  const [appVersion, setAppVersion] = useState<string>("");
  const [activeTab, setActiveTab] = useState<string>("flash");
  const [updating, setUpdating] = useState<boolean>(false);
  const [isFlashDialogOpen, setIsFlashDialogOpen] = useState(false);
  const [isEraseDialogOpen, setIsEraseDialogOpen] = useState(false);
  const [eraseConfirmText, setEraseConfirmText] = useState("");
  const [presetUrl, setPresetUrl] = useState<string>("");
  const [expectedSha, setExpectedSha] = useState<string>("");
  const [calcSha, setCalcSha] = useState<string>("");
  const [validateAfterFlash, setValidateAfterFlash] = useState<boolean>(true);
  const [ackRiskFlash, setAckRiskFlash] = useState<boolean>(false);
  const [selectedPresetIndex, setSelectedPresetIndex] = useState<number | null>(null);
  type DeviceDetails = { blockdevices?: Array<DeviceNode> };
  type DeviceNode = {
    type?: string;
    path?: string;
    name?: string;
    model?: string | null;
    vendor?: string | null;
    tran?: string | null;
    rm?: boolean;
    serial?: string | null;
    size?: number | string | null;
    children?: Array<PartitionNode>;
  };
  type PartitionNode = {
    path?: string;
    size?: number | string | null;
    fstype?: string | null;
    parttypename?: string | null;
  };
  const [deviceDetails, setDeviceDetails] = useState<DeviceDetails | null>(null);
  const [theme, setTheme] = useState<string>(typeof window !== "undefined" ? (localStorage.getItem("ds:theme") ?? "system") : "system");
  const { setTheme: setNextTheme } = useNextTheme();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [hideInternalDevices, setHideInternalDevices] = useState<boolean>(typeof window !== "undefined" ? (localStorage.getItem("ds:hideInternal") !== "false") : true);
  const [autoRefreshMode, setAutoRefreshMode] = useState<string>(typeof window !== "undefined" ? (localStorage.getItem("ds:autoRefresh") ?? "hotplug") : "hotplug");
  const autoRefreshModeRef = useRef<string>(typeof window !== "undefined" ? (localStorage.getItem("ds:autoRefresh") ?? "hotplug") : "hotplug");
  const [afterAction, setAfterAction] = useState<string>(typeof window !== "undefined" ? (localStorage.getItem("ds:afterAction") ?? "none") : "none");
  const afterActionRef = useRef<string>(typeof window !== "undefined" ? (localStorage.getItem("ds:afterAction") ?? "none") : "none");
  const [downloadDir, setDownloadDir] = useState<string>(typeof window !== "undefined" ? (localStorage.getItem("ds:dlDir") ?? "") : "");
  const [deps, setDeps] = useState<Array<{ package: string; tool: string; installed: boolean }> | null>(null);
  const [depsChecking, setDepsChecking] = useState(false);
  const [depsInstalling, setDepsInstalling] = useState(false);

  function applyThemeChoice(choice: string) {
    const root = document.documentElement;
    try { root.classList.remove("dim", "oled"); } catch {}
    if (choice === "system") {
      setNextTheme("system");
    } else if (choice === "light") {
      setNextTheme("light");
    } else if (choice === "dark") {
      setNextTheme("dark");
    } else if (choice === "dim") {
      setNextTheme("dark");
      try { root.classList.add("dim"); } catch {}
    } else if (choice === "oled") {
      setNextTheme("dark");
      try { root.classList.add("oled"); } catch {}
    }
  }

  useEffect(() => {
    if (typeof window === "undefined") return;
    applyThemeChoice(theme);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const logsRef = useRef<HTMLDivElement | null>(null);

  function pushToast(type: "info" | "success" | "error", message: string) {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, type, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }

  async function loadDevices() {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<BlockDevice[]>("list_block_devices");
      setDevices(result);
      // Also refresh detailed tree so cards have up-to-date partitions
      try {
        const v = await invoke<unknown>("get_device_details");
        if (v && typeof v === "object") setDeviceDetails(v as DeviceDetails);
      } catch {}
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadDevices();
    // One-time setup: install polkit rule if missing; will prompt once
    invoke<boolean>("ensure_setup").then((installed) => {
      if (installed) {
        pushToast("success", "Initial setup complete. Future operations won't prompt.");
      }
    }).catch(() => {});
    invoke("start_hotplug_monitor").catch(() => {});
    getVersion().then(setAppVersion).catch(() => {});
    // Load detailed lsblk tree once
    invoke<unknown>("get_device_details").then((v) => {
      if (v && typeof v === "object") setDeviceDetails(v as DeviceDetails);
    }).catch(() => {});
    const unlistenFlash = listen<{ bytes_written: number; total_bytes?: number }>("flash-progress", (event) => {
      setProgressBytes(event.payload.bytes_written);
      if (event.payload.total_bytes !== undefined) setTotalBytes(event.payload.total_bytes ?? null);
      setLogs((l) => [...l, `Flash: ${(event.payload.bytes_written / 1024 ** 2).toFixed(1)} MiB`]);
    });
    const unlistenErase = listen<{ bytes_processed: number; total_bytes?: number }>("erase-progress", (event) => {
      setProgressBytes(event.payload.bytes_processed);
      if (event.payload.total_bytes !== undefined) setTotalBytes(event.payload.total_bytes ?? null);
      setLogs((l) => [...l, `Erase: ${(event.payload.bytes_processed / 1024 ** 2).toFixed(1)} MiB`]);
    });
    const unlistenFormat = listen<{ percent: number; message?: string }>("format-progress", (event) => {
      const hasMessage = !!event.payload.message;
      const msg = hasMessage ? ` (${event.payload.message})` : "";
      setLogs((l) => [...l, `Format: ${event.payload.percent}%${msg}`]);
      if (!hasMessage) {
        setFormatPercent((prev) => {
          const next = Math.max(0, Math.min(100, event.payload.percent));
          // Enforce monotonic non-decreasing progress for stability
          return prev == null ? next : Math.max(prev, next);
        });
      }
    });
    const unlistenFlashDone = listen<{ ok: boolean; error?: string }>("flash-complete", async (event) => {
      if (event.payload.ok) {
        pushToast("success", "Flashing completed");
        if (validateAfterFlash) {
          const params = lastFlashRef.current;
          if (params) {
            setLogs((l) => [...l, "Validating image (samples)..."]);
            try {
              const ok = await invoke<boolean>("validate_flash_sample", { devicePath: params.devicePath, isoPath: params.isoPath, sampleCount: 3, sampleSize: 1024 * 1024 });
              if (ok) pushToast("success", "Validation passed (sampled)"); else pushToast("error", "Validation failed");
            } catch (ve: unknown) {
              pushToast("error", getErrorMessage(ve));
            }
          }
        }
        const act = afterActionRef.current;
        if (act === "logs") setActiveTab("logs");
        else if (act === "devices") { setActiveTab("devices"); loadDevices(); }
      } else {
        const msg = event.payload.error ?? "Flashing failed";
        setError(msg);
        pushToast("error", msg);
      }
      setFlashing(false);
    });
    const unlistenEraseDone = listen<{ ok: boolean; error?: string }>("erase-complete", (event) => {
      if (event.payload.ok) {
        pushToast("success", "Erase completed");
        const act = afterActionRef.current;
        if (act === "logs") setActiveTab("logs");
        else if (act === "devices") { setActiveTab("devices"); loadDevices(); }
      } else {
        const msg = event.payload.error ?? "Erase failed";
        setError(msg);
        pushToast("error", msg);
      }
      setErasing(false);
    });
    const unlistenFormatDone = listen<{ ok: boolean; error?: string }>("format-complete", (event) => {
      if (event.payload.ok) {
        pushToast("success", "Format completed");
        const act = afterActionRef.current;
        if (act === "logs") setActiveTab("logs");
        else if (act === "devices") { setActiveTab("devices"); loadDevices(); }
      } else {
        const msg = event.payload.error ?? "Format failed";
        setError(msg);
        pushToast("error", msg);
      }
      setFlashing(false);
      setErasing(false);
      setFormatting(false);
    });
    const unlistenDevices = listen("devices-changed", () => {
      setLogs((l) => [...l, "Devices changed, refreshing list..."]);
      if (autoRefreshModeRef.current !== "off") loadDevices();
    });
    return () => {
      unlistenFlash.then((un) => un());
      unlistenErase.then((un) => un());
      unlistenFlashDone.then((un) => un());
      unlistenEraseDone.then((un) => un());
      unlistenFormat.then((un) => un());
      unlistenFormatDone.then((un) => un());
      unlistenDevices.then((un) => un());
    };
  }, []);

  useEffect(() => { autoRefreshModeRef.current = autoRefreshMode; }, [autoRefreshMode]);
  useEffect(() => { afterActionRef.current = afterAction; }, [afterAction]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let timer: number | null = null;
    if (autoRefreshMode.startsWith("interval-")) {
      const ms = autoRefreshMode === "interval-5" ? 5000 : autoRefreshMode === "interval-15" ? 15000 : 60000;
      timer = window.setInterval(() => { loadDevices(); }, ms);
    }
    return () => { if (timer) window.clearInterval(timer); };
  }, [autoRefreshMode]);

  useEffect(() => {
    logsRef.current?.scrollTo({ top: logsRef.current.scrollHeight });
  }, [logs]);

  const safeDevices = useMemo(() => {
    if (!hideInternalDevices) return devices;
    return devices.filter((d) => !( !d.removable && (d.transport ?? "").toLowerCase() !== "usb" ));
  }, [devices, hideInternalDevices]);

  const deviceOptions = useMemo(
    () => safeDevices.map((d) => ({ value: d.path, label: `${d.vendor ?? d.model ?? d.name} — ${d.path} (${bytesToGiB(d.size)})` })),
    [safeDevices]
  );

  const candidatePaths = useMemo(() => new Set(safeDevices.map((d) => d.path)), [safeDevices]);
  const selectedInfo = useMemo(() => devices.find((d) => d.path === selectedDevice) || null, [devices, selectedDevice]);
  const isRisky = !!(selectedInfo && !selectedInfo.removable && (selectedInfo.transport ?? "").toLowerCase() !== "usb");
  const lastFlashRef = useRef<{ devicePath: string; isoPath: string } | null>(null);

  const detailsByPath = useMemo(() => {
    const map = new Map<string, DeviceNode>();
    const nodes = deviceDetails?.blockdevices ?? [];
    for (const n of nodes ?? []) {
      if (n && n.type === "disk" && n.path) map.set(n.path, n);
    }
    return map;
  }, [deviceDetails]);

  function toggleExpanded(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }

  async function checkDeps() {
    try {
      setDepsChecking(true);
      const res = await invoke<{ deps: Array<{ package: string; tool: string; installed: boolean }> }>("check_runtime_deps");
      setDeps(res.deps);
      const missing = (res.deps || []).filter((d) => !d.installed).length;
      if (missing === 0) pushToast("success", "All dependencies present");
      else pushToast("info", `${missing} dependency${missing === 1 ? "" : "ies"} missing`);
    } catch (e: unknown) {
      pushToast("error", getErrorMessage(e));
    } finally {
      setDepsChecking(false);
    }
  }

  async function installDeps() {
    try {
      setDepsInstalling(true);
      pushToast("info", "Requesting to install required packages (will prompt)...");
      await invoke("install_runtime_deps");
      pushToast("success", "Dependencies installed");
      await checkDeps();
    } catch (e: unknown) {
      pushToast("error", getErrorMessage(e));
    } finally {
      setDepsInstalling(false);
    }
  }

  const presets: Array<{ label: string; url?: string; dynamic?: "kali-latest" }> = [
    { label: "Ubuntu 24.04.1 Desktop", url: "https://releases.ubuntu.com/24.04/ubuntu-24.04.1-desktop-amd64.iso" },
    { label: "Fedora 40 Workstation", url: "https://download.fedoraproject.org/pub/fedora/linux/releases/40/Workstation/x86_64/iso/Fedora-Workstation-Live-x86_64-40-1.14.iso" },
    { label: "Kali Linux Live (latest)", dynamic: "kali-latest" },
    { label: "Arch Linux (latest)", url: "https://geo.mirror.pkgbuild.com/iso/latest/archlinux-x86_64.iso" },
    { label: "Tails (latest)", url: "https://mirrors.edge.kernel.org/tails/stable/tails-amd64-latest/tails-amd64-latest.iso" },
    { label: "Alpine Linux (latest stable)", url: "https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/x86_64/alpine-standard-latest-x86_64.iso" },
    { label: "openSUSE Tumbleweed DVD (Current)", url: "https://download.opensuse.org/tumbleweed/iso/openSUSE-Tumbleweed-DVD-x86_64-Current.iso" },
  ];

  async function resolveKaliLatest(): Promise<{ url: string; sha256?: string }> {
    try {
      const base = "https://cdimage.kali.org/current/";
      const res = await fetch(base);
      const html = await res.text();
      const isoMatch = html.match(/href=\"(kali-linux-[^\"]*-live-amd64\.iso)\"/i);
      if (!isoMatch) throw new Error("Could not find latest Kali ISO");
      const isoName = isoMatch[1];
      let sha256: string | undefined;
      try {
        const sumsRes = await fetch(base + "SHA256SUMS");
        const sums = await sumsRes.text();
        const line = sums.split("\n").find((ln) => ln.includes(isoName));
        if (line) sha256 = line.trim().split(/\s+/)[0];
      } catch {}
      return { url: base + isoName, sha256 };
    } catch (e) {
      throw e;
    }
  }

  const bytesPercent = totalBytes && totalBytes > 0 ? Math.min(100, Math.round((progressBytes / totalBytes) * 100)) : null;
  const progressPercent = formatting ? formatPercent : bytesPercent;
  // Smoothed MB/s calculation based on progress events
  const [lastBytesTs, setLastBytesTs] = useState<{ b: number; t: number } | null>(null);
  const [speedMBs, setSpeedMBs] = useState<number | null>(null);
  useEffect(() => {
    if (!erasing && !flashing) { setLastBytesTs(null); setSpeedMBs(null); return; }
    const now = performance.now();
    setLastBytesTs((prev) => {
      if (!prev) return { b: progressBytes, t: now };
      const db = progressBytes - prev.b;
      const dt = (now - prev.t) / 1000;
      if (dt > 0 && db >= 0) {
        const inst = db / (1024 * 1024) / dt;
        setSpeedMBs((s) => (s == null ? inst : s * 0.7 + inst * 0.3));
      }
      return { b: progressBytes, t: now };
    });
  }, [progressBytes, erasing, flashing]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Tabs.Root value={activeTab} onValueChange={setActiveTab}>
        <div className="grid min-h-screen grid-cols-[16rem_1fr]">
          <aside className="border-r border-border bg-surface/60 backdrop-blur supports-[backdrop-filter]:bg-surface/50 sticky top-0 h-svh p-3 flex flex-col gap-4">
            <div className="px-2 pt-1">
              <div className="text-base font-semibold tracking-tight">Inscribe</div>
              <div className="text-[11px] opacity-70 mt-0.5">{appVersion ? `v${appVersion}` : ""}</div>
            </div>
            <Tabs.List className="flex flex-col gap-1">
              <Tabs.Trigger value="flash" className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-left hover:bg-surface-muted data-[state=active]:bg-[--tab-active]">
                <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L3 14h7v8l11-14h-7z" /></svg>
                <span>Flash</span>
              </Tabs.Trigger>
              <Tabs.Trigger value="format" className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-left hover:bg-surface-muted data-[state=active]:bg-[--tab-active]">
                <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /></svg>
                <span>Format</span>
              </Tabs.Trigger>
              <Tabs.Trigger value="erase" className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-left hover:bg-surface-muted data-[state=active]:bg-[--tab-active]">
                <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>
                <span>Secure Erase</span>
              </Tabs.Trigger>
              <Tabs.Trigger value="devices" className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-left hover:bg-surface-muted data-[state=active]:bg-[--tab-active]">
                <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="8" rx="2" /><rect x="6" y="14" width="12" height="6" rx="2" /></svg>
                <span>Devices</span>
              </Tabs.Trigger>
              <Tabs.Trigger value="logs" className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-left hover:bg-surface-muted data-[state=active]:bg-[--tab-active]">
                <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" /></svg>
                <span>Logs</span>
              </Tabs.Trigger>
              <Tabs.Trigger value="settings" className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-left hover:bg-surface-muted data-[state=active]:bg-[--tab-active]">
                <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 5 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.49A1.65 1.65 0 0 0 5 8a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 3.49V3a2 2 0 1 1 4 0v.49a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.2.5.2 1.05 0 1.54.2.49.2 1.04 0 1.54Z" /></svg>
                <span>Settings</span>
              </Tabs.Trigger>
            </Tabs.List>
            <div className="mt-auto px-2 pb-2 text-[11px] opacity-70">
              Modern USB imaging utility
            </div>
          </aside>

          <main className="flex min-h-svh flex-col">
            <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-surface/70 backdrop-blur supports-[backdrop-filter]:bg-surface/50 px-4 py-3">
              <div className="text-sm font-medium">
                {({ flash: "Flash ISO", erase: "Secure Erase", devices: "Devices", logs: "Logs", settings: "Settings" } as Record<string, string>)[activeTab] ?? "Inscribe"}
              </div>
              <div className="flex items-center gap-4">
                {(flashing || erasing || formatting) && (
                  <div className="flex items-center gap-2">
                    <svg aria-hidden="true" className="h-3.5 w-3.5 animate-spin opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" className="opacity-20" /><path d="M22 12a10 10 0 0 1-10 10" /></svg>
                    <div className="hidden md:flex items-center gap-2">
                      <span className="text-xs opacity-70">{flashing ? "Flashing" : formatting ? "Formatting" : "Erasing"}</span>
                      <div className="w-40 h-2 rounded-full bg-track overflow-hidden">
                        <div className={`${flashing ? "bg-blue-600" : formatting ? "bg-emerald-600" : "bg-amber-600"} h-full`} style={{ width: `${progressPercent ?? 0}%` }} />
                      </div>
                      <span className="text-xs opacity-70">{progressPercent !== null ? `${progressPercent}%` : `${(progressBytes / (1024 ** 2)).toFixed(1)} MiB`}</span>
                    </div>
                  </div>
                )}
                <button
                  className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm border border-border hover:bg-surface-muted"
                  onClick={loadDevices}
                  disabled={loading}
                  aria-label="Refresh devices"
                >
                  {loading ? "Refreshing..." : "Refresh devices"}
                </button>
                <button
                  className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm bg-foreground text-background hover:opacity-90"
                  onClick={async () => {
                    if (!appVersion) { pushToast("error", "App version unknown"); return; }
                    if (!GH_OWNER || !GH_REPO) { pushToast("error", "Set NEXT_PUBLIC_GH_OWNER and NEXT_PUBLIC_GH_REPO at build time"); return; }
                    try {
                      setUpdating(true);
                      pushToast("info", "Checking for updates...");
                      const res = await invoke<{ updated: boolean; latest: string }>("github_update_self", { owner: GH_OWNER, repo: GH_REPO, currentVersion: appVersion });
                      if (!res.updated) {
                        pushToast("success", `Up to date (latest ${res.latest || appVersion})`);
                      } else {
                        pushToast("success", `Updated to ${res.latest}. Relaunching...`);
                        try { await invoke("relaunch_appimage"); } catch {}
                      }
                    } catch (e: unknown) {
                      pushToast("error", getErrorMessage(e));
                    } finally {
                      setUpdating(false);
                    }
                  }}
                  aria-label="Update"
                >
                  {updating ? "Updating..." : "Update"}
                </button>
              </div>
            </header>

            <div className="p-4">
              {error && (
                <div className="mb-4 rounded-xl border border-red-300/50 bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100 p-3">
                  <span>{error}</span>
                </div>
              )}

              <Tabs.Content value="flash" asChild>
                <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.15 }} className="rounded-xl border border-border bg-surface p-4 space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="space-y-2 md:col-span-1">
                      <label className="text-sm opacity-80">Select device</label>
                      <select className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                        value={selectedDevice} onChange={(e) => setSelectedDevice(e.target.value)}>
                        <option value="">-- choose --</option>
                        {deviceOptions.map((opt) => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-2 md:col-span-2">
                      <label className="text-sm opacity-80">ISO path</label>
                      <div className="flex gap-2">
                        <input className="flex-1 rounded-md border border-border bg-transparent px-3 py-2"
                          placeholder="/path/to/file.iso" value={isoPath} onChange={(e) => setIsoPath(e.target.value)} />
                        <button className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm bg-surface-muted hover:opacity-90"
                          onClick={async () => {
                            try {
                              const file = await openDialog({ multiple: false, filters: [{ name: "ISO images", extensions: ["iso", "img"] }] });
                              if (typeof file === "string") setIsoPath(file);
                            } catch (err: unknown) {
                              pushToast("error", getErrorMessage(err));
                            }
                          }}>Choose</button>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <label className="text-sm opacity-80">Presets (download + verify)</label>
                      <select
                        className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                        value={selectedPresetIndex ?? ''}
                        onChange={(e) => {
                          const idx = e.target.value === '' ? null : Number(e.target.value);
                          setSelectedPresetIndex(idx);
                          if (idx != null) {
                            const p = presets[idx];
                            if (p.url) setPresetUrl(p.url); else setPresetUrl("");
                          } else {
                            setPresetUrl("");
                          }
                        }}
                      >
                        <option value="">-- choose a preset --</option>
                        {presets.map((p, i) => (
                          <option key={i} value={i}>{p.label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm opacity-80">Expected SHA-256</label>
                      <input className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm" placeholder="optional checksum" value={expectedSha} onChange={(e) => setExpectedSha(e.target.value.trim())} />
                      {calcSha && (
                        <div className={`text-xs mt-1 ${expectedSha && calcSha.toLowerCase() === expectedSha.toLowerCase() ? "text-green-600" : "opacity-70"}`}>
                          Calculated: {calcSha.slice(0, 32)}…
                        </div>
                      )}
                    </div>
                    <div className="flex items-end">
                      <div className="flex gap-2">
                        <button className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm border border-border hover:bg-surface-muted" disabled={selectedPresetIndex == null} onClick={async () => {
                          try {
                            const idx = selectedPresetIndex;
                            if (idx == null) return;
                            let finalUrl = presets[idx].url || "";
                            let preferredSha: string | undefined;
                            if (presets[idx].dynamic === "kali-latest") {
                              const r = await resolveKaliLatest();
                              finalUrl = r.url;
                              preferredSha = r.sha256;
                            }
                            const filename = finalUrl.split('/').pop() || "image.iso";
                            const defaultPath = downloadDir ? `${downloadDir}/${filename}` : filename;
                            const dest = await saveDialog({ defaultPath });
                            if (!dest) return;
                            pushToast("info", "Downloading preset...");
                            const expect = expectedSha || preferredSha || null;
                            const hex = await invoke<string>("download_with_sha256", { url: finalUrl, destPath: dest, expectedSha256: expect });
                            setIsoPath(dest as unknown as string);
                            setCalcSha(hex);
                            if (expect && hex.toLowerCase() !== String(expect).toLowerCase()) {
                              pushToast("error", "Checksum mismatch after download");
                            } else {
                              pushToast("success", "Downloaded and verified");
                              if (!expectedSha && preferredSha) setExpectedSha(preferredSha);
                            }
                          } catch (e: unknown) {
                            pushToast("error", getErrorMessage(e));
                          }
                        }}>Download</button>
                        <button className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm border border-border hover:bg-surface-muted" disabled={!isoPath} onClick={async () => {
                          try {
                            const hex = await invoke<string>("compute_sha256", { path: isoPath });
                            setCalcSha(hex);
                            if (expectedSha) {
                              if (hex.toLowerCase() === expectedSha.toLowerCase()) pushToast("success", "Checksum matches");
                              else pushToast("error", "Checksum mismatch");
                            }
                          } catch (e: unknown) {
                            pushToast("error", getErrorMessage(e));
                          }
                        }}>Hash file</button>
                      </div>
                    </div>
                  </div>

                  <div className="mt-2 flex items-center gap-3 flex-wrap">
                    <Dialog.Root open={isFlashDialogOpen} onOpenChange={(open) => { setIsFlashDialogOpen(open); if (open) setAckRiskFlash(false); }}>
                      <Dialog.Trigger asChild>
                        <button className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                          disabled={!selectedDevice || !isoPath || flashing || erasing}>
                          {flashing ? "Flashing..." : "Flash ISO"}
                        </button>
                      </Dialog.Trigger>
                      <Dialog.Portal>
                        <Dialog.Overlay className="fixed inset-0" style={{ background: "var(--overlay)" }} />
                        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-4 w-[28rem] max-w-[calc(100vw-2rem)]">
                          <Dialog.Title className="text-lg font-semibold">Flash ISO</Dialog.Title>
                          <div className="py-3">This will erase all data on <b>{selectedDevice}</b> and flash the selected image. Continue?</div>
                          {isRisky && (
                            <div className="mb-2 rounded-md border border-red-300/50 bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100 p-2">
                              This looks like a system/internal disk. Confirm you understand the risk.
                            </div>
                          )}
                          {isRisky && (
                            <label className="flex items-center gap-2 text-sm">
                              <input type="checkbox" className="h-4 w-4" checked={ackRiskFlash} onChange={(e) => setAckRiskFlash(e.target.checked)} />
                              <span>I understand this may wipe my system disk</span>
                            </label>
                          )}
                          <div className="flex justify-end gap-2 mt-3">
                            <Dialog.Close asChild>
                              <button className="rounded-lg px-3 py-2 text-sm border border-border">Cancel</button>
                            </Dialog.Close>
                            <button className="rounded-lg px-3 py-2 text-sm bg-red-600 text-white hover:bg-red-700" disabled={isRisky && !ackRiskFlash} onClick={async () => {
                              setIsFlashDialogOpen(false);
                              setFlashing(true);
                              setProgressBytes(0);
                              setTotalBytes(null);
                              setError(null);
                              setLogs((l) => [...l, `Starting flash → ${isoPath} → ${selectedDevice}`]);
                              lastFlashRef.current = { devicePath: selectedDevice, isoPath };
                              try {
                                await invoke("start_flash_iso", { isoPath, devicePath: selectedDevice });
                              } catch (err: unknown) {
                                setError(getErrorMessage(err));
                                pushToast("error", getErrorMessage(err));
                                setFlashing(false);
                              }
                            }}>Flash</button>
                          </div>
                        </Dialog.Content>
                      </Dialog.Portal>
                    </Dialog.Root>

                    <label className="inline-flex items-center gap-2 text-sm">
                      <input type="checkbox" className="h-4 w-4" checked={validateAfterFlash} onChange={(e) => setValidateAfterFlash(e.target.checked)} />
                      <span>Validate after flash</span>
                    </label>

                    {progressPercent !== null ? (
                      <div className="flex items-center gap-2">
                        <div className="w-56 h-2 rounded-full bg-track overflow-hidden">
                          <div className="h-full bg-blue-600" style={{ width: `${progressPercent}%` }} />
                        </div>
                        <span className="text-sm opacity-70">{progressPercent}%</span>
                        {speedMBs != null && (
                          <span className="text-xs opacity-60 ml-2">{speedMBs.toFixed(1)} MB/s</span>
                        )}
                      </div>
                    ) : progressBytes > 0 ? (
                      <span className="text-sm opacity-70">{(progressBytes / (1024 ** 2)).toFixed(1)} MiB processed{speedMBs != null ? ` · ${speedMBs.toFixed(1)} MB/s` : ""}</span>
                    ) : null}
                  </div>
                </motion.div>
              </Tabs.Content>

              <Tabs.Content value="erase" asChild>
                <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.15 }} className="rounded-xl border border-border bg-surface p-4 space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="space-y-2 md:col-span-1">
                      <label className="text-sm opacity-80">Select device</label>
                      <select className="w-full rounded-md border border-border bg-transparent px-3 py-2"
                        value={selectedDevice} onChange={(e) => setSelectedDevice(e.target.value)}>
                        <option value="">-- choose --</option>
                        {deviceOptions.map((opt) => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="mt-2 flex items-center gap-3 flex-wrap">
                    <Dialog.Root open={isEraseDialogOpen} onOpenChange={(open) => { setIsEraseDialogOpen(open); if (!open) setEraseConfirmText(""); }}>
                      <Dialog.Trigger asChild>
                        <button className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
                          disabled={!selectedDevice || erasing || flashing}>
                          {erasing ? "Erasing..." : "Secure Erase"}
                        </button>
                      </Dialog.Trigger>
                      <Dialog.Portal>
                        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
                        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 w-[28rem] max-w-[calc(100vw-2rem)]">
                          <Dialog.Title className="text-lg font-semibold">Secure Erase</Dialog.Title>
                          <div className="py-3 space-y-2">
                            <div>This will ERASE ALL DATA on <b>{selectedDevice}</b> using <b>{eraseMode}</b>.</div>
                            <div className="text-sm opacity-80">Type ERASE to confirm.</div>
                            <input
                              className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2"
                              placeholder="Type ERASE to confirm"
                              value={eraseConfirmText}
                              onChange={(e) => setEraseConfirmText(e.target.value)}
                            />
                          </div>
                          <div className="flex justify-end gap-2">
                            <Dialog.Close asChild>
                              <button className="rounded-lg px-3 py-2 text-sm border border-neutral-300 dark:border-neutral-700">Cancel</button>
                            </Dialog.Close>
                            <button className="rounded-lg px-3 py-2 text-sm bg-red-600 text-white hover:bg-red-700" onClick={async () => {
                              if (eraseConfirmText.trim().toUpperCase() !== "ERASE") {
                                pushToast("error", "Please type ERASE to confirm.");
                                return;
                              }
                              // Close dialog immediately, then start work
                              setIsEraseDialogOpen(false);
                              setErasing(true);
                              setProgressBytes(0);
                              setTotalBytes(null);
                              setError(null);
                              setLogs((l) => [...l, `Starting erase (${eraseMode}) → ${selectedDevice}`]);
                              try {
                                await invoke("start_secure_erase", { devicePath: selectedDevice, mode: eraseMode });
                              } catch (err: unknown) {
                                setError(getErrorMessage(err));
                                pushToast("error", getErrorMessage(err));
                                setErasing(false);
                                setEraseConfirmText("");
                              }
                            }}>Erase</button>
                          </div>
                        </Dialog.Content>
                      </Dialog.Portal>
                    </Dialog.Root>

                    {progressPercent !== null ? (
                      <div className="flex items-center gap-2">
                        <div className="w-56 h-2 rounded-full bg-neutral-200 dark:bg-neutral-800 overflow-hidden">
                          <div className="h-full bg-amber-600" style={{ width: `${progressPercent}%` }} />
                        </div>
                        <span className="text-sm opacity-70">{progressPercent}%</span>
                        {speedMBs != null && (
                          <span className="text-xs opacity-60 ml-2">{speedMBs.toFixed(1)} MB/s</span>
                        )}
                      </div>
                    ) : progressBytes > 0 ? (
                      <span className="text-sm opacity-70">{(progressBytes / (1024 ** 2)).toFixed(1)} MiB processed{speedMBs != null ? ` · ${speedMBs.toFixed(1)} MB/s` : ""}</span>
                    ) : null}
                  </div>
                </motion.div>
              </Tabs.Content>

              <Tabs.Content value="devices" asChild>
                <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.15 }} className="rounded-xl border border-border bg-surface p-4">
                  {safeDevices.length === 0 ? (
                    <div className="px-4 py-16 text-center text-sm opacity-70">No removable drives found</div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {safeDevices.map((d) => {
                        const det = detailsByPath.get(d.path);
                        const open = expanded.has(d.path);
                        const risky = !d.removable && (d.transport ?? "").toLowerCase() !== "usb";
                        const display = d.vendor ?? d.model ?? d.name;
                        const transport = d.transport ?? (d.removable ? "removable" : "-");
                        return (
                          <div key={d.path} className="rounded-xl border border-border bg-surface overflow-hidden">
                            <button
                              className="w-full flex items-start justify-between gap-3 px-4 py-3 hover:bg-surface-muted"
                              onClick={() => toggleExpanded(d.path)}
                              aria-expanded={open}
                            >
                              <div className="min-w-0 text-left">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-medium truncate">{display}</span>
                                  {risky && (
                                    <span className="inline-flex items-center rounded-md bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-600 dark:text-red-300 border border-red-500/20">system?</span>
                                  )}
                                </div>
                                <div className="mt-0.5 text-[11px] opacity-70 truncate">{d.path} • {bytesToGiB(d.size)} • {transport}</div>
                              </div>
                              <svg aria-hidden="true" className={`h-4 w-4 shrink-0 transition-transform ${open ? "rotate-180" : "rotate-0"}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
                            </button>
                            {open && (
                              <div className="px-4 pb-3">
                                <div className="grid grid-cols-2 gap-2 text-xs">
                                  <div><span className="opacity-60">Vendor:</span> {d.vendor ?? "-"}</div>
                                  <div><span className="opacity-60">Model:</span> {d.model ?? "-"}</div>
                                  <div><span className="opacity-60">Serial:</span> {d.serial ?? "-"}</div>
                                  <div><span className="opacity-60">Transport:</span> {transport}</div>
                                </div>
                                <div className="mt-2 border-t border-border pt-2">
                                  <div className="text-xs font-medium mb-1">Partitions</div>
                                  {Array.isArray(det?.children) && det!.children!.length > 0 ? (
                                    <ul className="text-xs space-y-1">
                                      {det!.children!.map((p) => (
                                        <li key={p.path ?? Math.random().toString(36)} className="flex items-center justify-between">
                                          <span className="truncate">{p.path ?? "-"}</span>
                                          <span className="opacity-70 ml-2">{bytesToGiB(String(p.size ?? "0"))} • {p.fstype ?? p.parttypename ?? "-"}</span>
                                        </li>
                                      ))}
                                    </ul>
                                  ) : (
                                    <div className="text-xs opacity-70">No partitions</div>
                                  )}
                                </div>
                                <div className="mt-3 flex flex-wrap gap-2">
                                  <button
                                    className={`rounded-md px-2.5 py-1 text-xs border border-border ${selectedDevice === d.path ? "bg-[--tab-active]" : "hover:bg-surface-muted"}`}
                                    onClick={() => setSelectedDevice(d.path)}
                                  >{selectedDevice === d.path ? "Selected" : "Select"}</button>
                                  <button className="rounded-md px-2.5 py-1 text-xs border border-border hover:bg-surface-muted" onClick={() => { setSelectedDevice(d.path); setActiveTab("flash"); }}>Flash</button>
                                  <button className="rounded-md px-2.5 py-1 text-xs border border-border hover:bg-surface-muted" onClick={() => { setSelectedDevice(d.path); setActiveTab("erase"); }}>Erase</button>
                                  <button className="rounded-md px-2.5 py-1 text-xs border border-border hover:bg-surface-muted" onClick={() => { setSelectedDevice(d.path); setActiveTab("format"); }}>Format</button>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </motion.div>
              </Tabs.Content>

              <Tabs.Content value="logs" asChild>
                <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.15 }} className="rounded-xl border border-border bg-surface p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <button className="rounded-lg px-2 py-1 text-xs border border-border" onClick={() => setLogs([])}>Clear</button>
                    <button className="rounded-lg px-2 py-1 text-xs border border-border" onClick={async () => {
                      try {
                        const path = await saveDialog({ defaultPath: "inscribe-logs.txt" });
                        if (typeof path === "string") {
                          const content = logs.join("\n");
                          await invoke("save_text_file", { path, contents: content });
                          pushToast("success", `Saved logs to ${path}`);
                        }
                      } catch (err: unknown) {
                        pushToast("error", getErrorMessage(err));
                      }
                    }}>Export .txt</button>
                  </div>
                  <div ref={logsRef} className="px-1 py-1 max-h-72 overflow-auto font-mono text-sm whitespace-pre-wrap">
                    {logs.length === 0 ? (
                      <span className="opacity-70">No logs yet</span>
                    ) : logs.map((l, i) => (
                      <div key={i}>{l}</div>
                    ))}
                  </div>
                </motion.div>
              </Tabs.Content>

              <Tabs.Content value="format" asChild>
                <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.15 }} className="rounded-xl border border-border bg-surface p-4 space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="space-y-2 md:col-span-1">
                      <label className="text-sm opacity-80">Select device</label>
                      <select className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm" value={selectedDevice} onChange={(e) => setSelectedDevice(e.target.value)}>
                        <option value="">-- choose --</option>
                        {deviceOptions.map((opt) => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-2 md:col-span-1">
                      <label className="text-sm opacity-80">Filesystem</label>
                      <select className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm" value={formatFs} onChange={(e) => setFormatFs(e.target.value)}>
                        <option value="ext4">ext4 (Linux)</option>
                        <option value="fat32">FAT32 (UEFI/legacy)</option>
                        <option value="exfat">exFAT</option>
                        <option value="ntfs">NTFS</option>
                      </select>
                    </div>
                    <div className="space-y-2 md:col-span-1">
                      <label className="text-sm opacity-80">Label</label>
                      <input className="w-full rounded-md border border-border bg-transparent px-3 py-2" placeholder="USB" value={formatLabel} onChange={(e) => setFormatLabel(e.target.value)} />
                    </div>
                  </div>
                  <div className="mt-2 flex items-center gap-3 flex-wrap">
                    <button className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50" disabled={!selectedDevice || erasing || flashing || formatting} onClick={async () => {
                      setFormatting(true);
                      setProgressBytes(0);
                      setTotalBytes(100);
                      setError(null);
                      setLogs((l) => [...l, `Starting format (${formatFs}) → ${selectedDevice}`]);
                      try {
                        await invoke("start_format_device", { devicePath: selectedDevice, fs: formatFs, label: formatLabel });
                      } catch (err: unknown) {
                        setError(getErrorMessage(err));
                        pushToast("error", getErrorMessage(err));
                        setFormatting(false);
                      }
                    }}>Format</button>
                    {progressPercent !== null ? (
                      <div className="flex items-center gap-2">
                        <div className="w-56 h-2 rounded-full bg-track overflow-hidden">
                          <div className="h-full bg-emerald-600" style={{ width: `${progressPercent}%` }} />
                        </div>
                        <span className="text-sm opacity-70">{progressPercent}%</span>
                      </div>
                    ) : null}
                  </div>
                </motion.div>
              </Tabs.Content>

              <Tabs.Content value="settings" asChild>
                <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.15 }} className="rounded-xl border border-border bg-surface p-4 space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <label className="text-sm opacity-80">Default erase mode</label>
                      <select className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                        value={eraseMode} onChange={(e) => { const v = e.target.value; setEraseMode(v); try { localStorage.setItem("ds:eraseMode", v); } catch {} }}>
                        <option value="auto">Auto (fast if supported)</option>
                        <option value="zero">Zero fill</option>
                        <option value="random">Random fill</option>
                        <option value="blkdiscard">blkdiscard (fast)</option>
                        <option value="wipefs">wipefs (clear signatures)</option>
                      </select>
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm opacity-80">Theme</label>
                      <select className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                        value={theme} onChange={(e) => {
                          const v = e.target.value; setTheme(v);
                          applyThemeChoice(v);
                          try { localStorage.setItem("ds:theme", v); } catch {}
                        }}>
                        <option value="system">System</option>
                        <option value="light">Light</option>
                        <option value="dark">Dark</option>
                        <option value="dim">Dim</option>
                        <option value="oled">OLED Black</option>
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <label className="text-sm opacity-80">Device safety</label>
                      <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" className="h-4 w-4" checked={hideInternalDevices} onChange={(e) => { const v = e.target.checked; setHideInternalDevices(v); try { localStorage.setItem("ds:hideInternal", String(v)); } catch {} }} />
                        <span>Hide internal/system disks</span>
                      </label>
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm opacity-80">Auto-refresh devices</label>
                      <select className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                        value={autoRefreshMode}
                        onChange={(e) => { const v = e.target.value; setAutoRefreshMode(v); try { localStorage.setItem("ds:autoRefresh", v); } catch {} }}>
                        <option value="hotplug">On hotplug events</option>
                        <option value="interval-5">Every 5 seconds</option>
                        <option value="interval-15">Every 15 seconds</option>
                        <option value="interval-60">Every 60 seconds</option>
                        <option value="off">Manual only</option>
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <label className="text-sm opacity-80">After-action behavior</label>
                      <select className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                        value={afterAction}
                        onChange={(e) => { const v = e.target.value; setAfterAction(v); try { localStorage.setItem("ds:afterAction", v); } catch {} }}>
                        <option value="none">Do nothing</option>
                        <option value="logs">Switch to Logs</option>
                        <option value="devices">Switch to Devices</option>
                      </select>
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm opacity-80">Default download directory</label>
                      <div className="flex gap-2">
                        <input className="flex-1 rounded-md border border-border bg-transparent px-3 py-2 text-sm" placeholder="e.g. /home/user/Downloads" value={downloadDir} onChange={(e) => { const v = e.target.value; setDownloadDir(v); try { localStorage.setItem("ds:dlDir", v); } catch {} }} />
                        <button className="rounded-md px-3 py-2 text-sm border border-border hover:bg-surface-muted" onClick={() => { setDownloadDir(""); try { localStorage.removeItem("ds:dlDir"); } catch {} }}>Clear</button>
                      </div>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm opacity-80">Privileges</label>
                    <div className="flex gap-2 flex-wrap">
                      <button className="rounded-md px-3 py-2 text-sm border border-border hover:bg-surface-muted" onClick={async () => {
                        try { const changed = await invoke<boolean>("ensure_setup"); pushToast("success", changed ? "Setup updated" : "Setup already OK"); }
                        catch (e: unknown) { pushToast("error", getErrorMessage(e)); }
                      }}>Re-run setup</button>
                      <button className="rounded-md px-3 py-2 text-sm border border-border hover:bg-surface-muted" onClick={checkDeps} disabled={depsChecking}>{depsChecking ? "Checking deps..." : "Check dependencies"}</button>
                      <button className="rounded-md px-3 py-2 text-sm border border-border hover:bg-surface-muted" onClick={installDeps} disabled={depsInstalling}>{depsInstalling ? "Installing..." : "Install missing"}</button>
                    </div>
                    {deps && (
                      <div className="mt-2 rounded-md border border-border p-2">
                        <div className="text-xs font-medium mb-1">Runtime dependencies</div>
                        <ul className="text-xs space-y-0.5">
                          {deps.map((d, i) => (
                            <li key={i} className="flex justify-between">
                              <span>{d.package} ({d.tool})</span>
                              <span className={d.installed ? "text-emerald-600" : "text-red-600"}>{d.installed ? "installed" : "missing"}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <div className="text-xs opacity-70">Uses a helper with sudoers and polkit. Admin rights required once. On some systems you may need additional runtime packages; use the checker above.</div>
                  </div>
                  <div className="text-xs opacity-70">Tip: You can change theme in your OS appearance settings.</div>
                </motion.div>
              </Tabs.Content>
            </div>

            <div className="fixed right-4 bottom-4 space-y-2">
              {toasts.map((t) => (
                <div key={t.id} className={`rounded-lg px-3 py-2 text-sm shadow border ${t.type === "error" ? "border-red-300/50 bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100" : t.type === "success" ? "border-green-300/50 bg-green-50 text-green-900 dark:bg-green-950 dark:text-green-100" : "border-blue-300/50 bg-blue-50 text-blue-900 dark:bg-blue-950 dark:text-blue-100"}`}>
                  <span>{t.message}</span>
                </div>
              ))}
            </div>
          </main>
        </div>
      </Tabs.Root>
      {(flashing || erasing || formatting) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm" style={{ background: "var(--overlay)" }}>
          <div className="rounded-xl border border-border bg-surface p-5 w-[28rem] max-w-[calc(100vw-2rem)] shadow">
            <div className="text-base font-semibold mb-3">{flashing ? "Flashing image" : formatting ? "Formatting" : "Secure Erase"}</div>
            <div className="flex items-center gap-2 mb-3">
              <svg aria-hidden="true" className="h-4 w-4 animate-spin opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" className="opacity-20" /><path d="M22 12a10 10 0 0 1-10 10" /></svg>
              <span className="text-sm opacity-80">{flashing ? `Writing to ${selectedDevice}` : formatting ? `Formatting ${selectedDevice} (${formatFs})` : `Erasing ${selectedDevice} (${eraseMode})`}{flashing || erasing ? (speedMBs != null ? ` · ${speedMBs.toFixed(1)} MB/s` : "") : ""}</span>
            </div>
            {progressPercent !== null ? (
              <div className="flex items-center gap-2">
                <div className="w-full h-2 rounded-full bg-track overflow-hidden">
                  <div className={`h-full ${flashing ? "bg-blue-600" : formatting ? "bg-emerald-600" : "bg-amber-600"}`} style={{ width: `${progressPercent}%` }} />
                </div>
                <span className="text-sm opacity-70 whitespace-nowrap">{progressPercent}%</span>
                <button
                  className="ml-auto rounded-md px-2 py-1 text-xs border border-border hover:bg-surface-muted"
                  onClick={async () => {
                    try { await invoke("cancel_active_operation"); } catch {}
                  }}
                >Cancel</button>
              </div>
            ) : (
              <div className="text-sm opacity-70">{(progressBytes / (1024 ** 2)).toFixed(1)} MiB processed{(flashing || erasing) && speedMBs != null ? ` · ${speedMBs.toFixed(1)} MB/s` : ""}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
