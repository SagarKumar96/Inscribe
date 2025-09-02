import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import AppShell from "./components/AppShell";
import ThemeSwitcher from "./components/ThemeSwitcher";
import DeviceTable, { BlockDeviceRow } from "./components/DeviceTable";
import LogsPane from "./components/LogsPane";
import ConfirmModal from "./components/ConfirmModal";

interface BlockDevice {
	name: string;
	path: string;
	size: string;
	model?: string;
	transport?: string;
	removable: boolean;
}

function bytesToGiB(bytesStr: string): string {
	const n = Number(bytesStr);
	if (!Number.isFinite(n) || n <= 0) return "-";
	return (n / (1024 ** 3)).toFixed(2) + " GiB";
}

function App() {
	const [devices, setDevices] = useState<BlockDevice[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [selectedDevice, setSelectedDevice] = useState<string>("");
	const [isoPath, setIsoPath] = useState<string>("");
	const [progressBytes, setProgressBytes] = useState<number>(0);
	const [flashing, setFlashing] = useState(false);
	const [erasing, setErasing] = useState(false);
	const [eraseMode, setEraseMode] = useState<string>("zero");
	const [totalBytes, setTotalBytes] = useState<number | null>(null);
	const [logs, setLogs] = useState<string[]>([]);
	const [toasts, setToasts] = useState<{ id: number; type: "info" | "success" | "error"; message: string }[]>([]);
	const [presetUrl, setPresetUrl] = useState<string>("");
	const [expectedSha, setExpectedSha] = useState<string>("");
	const [calcSha, setCalcSha] = useState<string>("");
	const [ackRiskFlash, setAckRiskFlash] = useState<boolean>(false);
	const [ackRiskErase, setAckRiskErase] = useState<boolean>(false);
	const [validateAfterFlash, setValidateAfterFlash] = useState<boolean>(true);

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
		} catch (e: any) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		loadDevices();
		invoke("start_hotplug_monitor").catch(() => {});
		const unlistenFlash = listen<{ bytes_written: number; total_bytes?: number }>("flash-progress", (event) => {
			setProgressBytes(event.payload.bytes_written);
			if (event.payload.total_bytes !== undefined) setTotalBytes(event.payload.total_bytes ?? null);
			setLogs((l) => [...l, `Flash: ${(event.payload.bytes_written / (1024 ** 2)).toFixed(1)} MiB`]);
		});
		const unlistenErase = listen<{ bytes_processed: number; total_bytes?: number }>("erase-progress", (event) => {
			setProgressBytes(event.payload.bytes_processed);
			if (event.payload.total_bytes !== undefined) setTotalBytes(event.payload.total_bytes ?? null);
			setLogs((l) => [...l, `Erase: ${(event.payload.bytes_processed / (1024 ** 2)).toFixed(1)} MiB`]);
		});
		const unlistenDevices = listen("devices-changed", () => {
			setLogs((l) => [...l, "Devices changed, refreshing list..."]);
			loadDevices();
		});
		return () => {
			unlistenFlash.then((un) => un());
			unlistenErase.then((un) => un());
			unlistenDevices.then((un) => un());
		};
	}, []);

	const deviceOptions = useMemo(() => devices.map((d) => ({
		value: d.path,
		label: `${d.path} (${bytesToGiB(d.size)})`,
	})), [devices]);

	const rows: BlockDeviceRow[] = useMemo(() => devices.map((d) => ({
		name: d.name,
		path: d.path,
		size: bytesToGiB(d.size),
		model: d.model,
		transport: d.transport,
		removable: d.removable,
	})), [devices]);

	const selectedInfo = useMemo(() => devices.find(d => d.path === selectedDevice) || null, [devices, selectedDevice]);
	const isRisky = !!(selectedInfo && !selectedInfo.removable && (selectedInfo.transport ?? "").toLowerCase() !== "usb");

	const percent = totalBytes && totalBytes > 0 ? Math.min(100, Math.round((progressBytes / totalBytes) * 100)) : null;

	return (
		<AppShell
			header={
				<div className="flex items-center gap-2">
					<span>Inscribe</span>
				</div>
			}
			sidebar={
				<div className="flex flex-col gap-4">
					<div className="flex items-center justify-between">
						<button className="btn btn-ghost btn-sm" onClick={loadDevices} disabled={loading}>
							{loading ? "Refreshing..." : "Refresh"}
						</button>
					</div>
					<div className="divider my-0">Settings</div>
					<ThemeSwitcher />
					<label className="label gap-2">
						<span className="label-text">Default erase mode</span>
						<select className="select select-bordered select-sm" value={eraseMode} onChange={(e) => setEraseMode(e.target.value)}>
							<option value="zero">Zero fill</option>
							<option value="random">Random fill</option>
							<option value="blkdiscard">blkdiscard (fast)</option>
							<option value="wipefs">wipefs (clear signatures)</option>
						</select>
					</label>
				</div>
			}
		>
			{error && (
				<div className="alert alert-error">
					<span>{error}</span>
				</div>
			)}

			<div className="card bg-base-100 shadow">
				<div className="card-body">
					<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
						<div className="form-control md:col-span-1">
							<label className="label"><span className="label-text">Select device</span></label>
							<select className="select select-bordered" value={selectedDevice} onChange={(e) => setSelectedDevice(e.target.value)}>
								<option value="">-- choose --</option>
								{deviceOptions.map((opt) => (
									<option key={opt.value} value={opt.value}>{opt.label}</option>
								))}
							</select>
						</div>
						<div className="form-control md:col-span-2">
							<label className="label"><span className="label-text">ISO path</span></label>
							<div className="join">
								<input className="input input-bordered join-item w-full" placeholder="/path/to/file.iso" value={isoPath} onChange={(e) => setIsoPath(e.target.value)} />
								<button className="btn btn-secondary join-item" onClick={async () => {
									try {
										const file = await openDialog({ multiple: false, filters: [{ name: "ISO images", extensions: ["iso", "img"] }] });
										if (typeof file === "string") setIsoPath(file);
									} catch (e: any) {
										pushToast("error", String(e));
									}
								}}>Choose</button>
							</div>
						</div>
					</div>

					<div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
						<div className="form-control">
							<label className="label"><span className="label-text">Presets (download + verify)</span></label>
							<select className="select select-bordered" value={presetUrl} onChange={(e) => setPresetUrl(e.target.value)}>
								<option value="">-- choose a preset --</option>
								<option value="https://releases.ubuntu.com/24.04/ubuntu-24.04.1-desktop-amd64.iso">Ubuntu 24.04.1 Desktop</option>
								<option value="https://download.fedoraproject.org/pub/fedora/linux/releases/40/Workstation/x86_64/iso/Fedora-Workstation-Live-x86_64-40-1.14.iso">Fedora 40 Workstation</option>
							</select>
						</div>
						<div className="form-control">
							<label className="label"><span className="label-text">Expected SHA-256</span></label>
							<input className="input input-bordered" placeholder="optional checksum" value={expectedSha} onChange={(e) => setExpectedSha(e.target.value.trim())} />
							{calcSha && (
								<div className={`text-sm mt-1 ${expectedSha && calcSha.toLowerCase() === expectedSha.toLowerCase() ? "text-success" : "opacity-70"}`}>
									Calculated: {calcSha.slice(0, 32)}…
								</div>
							)}
						</div>
						<div className="form-control justify-end">
							<div className="join">
								<button className="btn join-item" disabled={!presetUrl} onClick={async () => {
									try {
										const dest = await saveDialog({ defaultPath: presetUrl.split('/').pop() || "image.iso" });
										if (!dest) return;
										pushToast("info", "Downloading preset...");
										const hex = await invoke<string>("download_with_sha256", { url: presetUrl, destPath: dest, expectedSha256: expectedSha || null });
										setIsoPath(dest);
										setCalcSha(hex);
										if (expectedSha && hex.toLowerCase() !== expectedSha.toLowerCase()) {
											pushToast("error", "Checksum mismatch after download");
										} else {
											pushToast("success", "Downloaded and verified");
										}
									} catch (e: any) {
										pushToast("error", String(e));
									}
							}}>Download</button>
							<button className="btn join-item" disabled={!isoPath} onClick={async () => {
								try {
									const hex = await invoke<string>("compute_sha256", { path: isoPath });
									setCalcSha(hex);
									if (expectedSha) {
										if (hex.toLowerCase() === expectedSha.toLowerCase()) pushToast("success", "Checksum matches");
										else pushToast("error", "Checksum mismatch");
									}
								} catch (e: any) {
									pushToast("error", String(e));
								}
							}}>Hash file</button>
						</div>
						</div>
					</div>

					<div className="mt-4 flex items-center gap-3 flex-wrap">
						<button className="btn btn-primary" disabled={!selectedDevice || !isoPath || flashing || erasing} onClick={() => {
							setAckRiskFlash(false);
							(document.getElementById("confirm-flash") as HTMLDialogElement | null)?.showModal();
						}}>{flashing ? "Flashing..." : "Flash ISO"}</button>
						<button className="btn btn-warning" disabled={!selectedDevice || erasing || flashing} onClick={() => {
							setAckRiskErase(false);
							(document.getElementById("confirm-erase") as HTMLDialogElement | null)?.showModal();
						}}>{erasing ? "Erasing..." : "Secure Erase"}</button>
						<label className="label cursor-pointer gap-2">
							<input type="checkbox" className="checkbox checkbox-sm" checked={validateAfterFlash} onChange={(e) => setValidateAfterFlash(e.target.checked)} />
							<span className="label-text">Validate after flash</span>
						</label>
						{percent !== null ? (
							<div className="flex items-center gap-2">
								<progress className="progress progress-primary w-56" value={percent} max="100"></progress>
								<span className="text-sm opacity-70">{percent}%</span>
							</div>
						) : progressBytes > 0 ? (
							<span className="text-sm opacity-70">{(progressBytes / (1024 ** 2)).toFixed(1)} MiB processed</span>
						) : null}
					</div>
				</div>
			</div>

			<DeviceTable devices={rows} />
			<LogsPane logs={logs} />

			<ConfirmModal
				id="confirm-flash"
				title="Flash ISO"
				body={
					<div className="flex flex-col gap-2">
						<span>This will erase all data on <b>{selectedDevice}</b> and flash the selected image.</span>
						{isRisky && (
							<div className="alert alert-error">
								<span>This looks like a system/internal disk. Confirm you understand the risk.</span>
							</div>
						)}
						{isRisky && (
							<label className="label cursor-pointer gap-2">
								<input type="checkbox" className="checkbox" checked={ackRiskFlash} onChange={(e) => setAckRiskFlash(e.target.checked)} />
								<span className="label-text">I understand this may wipe my system disk</span>
							</label>
						)}
					</div>
				}
				disabled={isRisky && !ackRiskFlash}
				confirmLabel="Flash"
				onConfirm={async () => {
					setFlashing(true);
					setProgressBytes(0);
					setTotalBytes(null);
					setError(null);
					setLogs((l) => [...l, `Starting flash → ${isoPath} → ${selectedDevice}`]);
					try {
						await invoke("flash_iso", { isoPath, devicePath: selectedDevice });
						pushToast("success", "Flashing completed");
						if (validateAfterFlash) {
							setLogs((l) => [...l, "Validating image (samples)..."]);
							try {
								const ok = await invoke<boolean>("validate_flash_sample", { devicePath: selectedDevice, isoPath, sampleCount: 3, sampleSize: 1024 * 1024 });
								if (ok) pushToast("success", "Validation passed (sampled)"); else pushToast("error", "Validation failed");
							} catch (ve: any) {
								pushToast("error", String(ve));
							}
						}
					} catch (e: any) {
						setError(String(e));
						pushToast("error", String(e));
					} finally {
						setFlashing(false);
					}
				}}
			/>

			<ConfirmModal
				id="confirm-erase"
				title="Secure Erase"
				body={
					<div className="flex flex-col gap-2">
						<span>This will ERASE ALL DATA on <b>{selectedDevice}</b> using <b>{eraseMode}</b>.</span>
						{isRisky && (
							<div className="alert alert-error">
								<span>This looks like a system/internal disk. Confirm you understand the risk.</span>
							</div>
						)}
						{isRisky && (
							<label className="label cursor-pointer gap-2">
								<input type="checkbox" className="checkbox" checked={ackRiskErase} onChange={(e) => setAckRiskErase(e.target.checked)} />
								<span className="label-text">I understand this may wipe my system disk</span>
							</label>
						)}
					</div>
				}
				disabled={isRisky && !ackRiskErase}
				confirmLabel="Erase"
				onConfirm={async () => {
					setErasing(true);
					setProgressBytes(0);
					setTotalBytes(null);
					setError(null);
					setLogs((l) => [...l, `Starting erase (${eraseMode}) → ${selectedDevice}`]);
					try {
						await invoke("secure_erase", { devicePath: selectedDevice, mode: eraseMode });
						pushToast("success", "Erase completed");
					} catch (e: any) {
						setError(String(e));
						pushToast("error", String(e));
					} finally {
						setErasing(false);
					}
				}}
			/>

			{/* Toasts */}
			<div className="toast toast-end">
				{toasts.map((t) => (
					<div key={t.id} className={`alert ${t.type === "error" ? "alert-error" : t.type === "success" ? "alert-success" : "alert-info"}`}>
						<span>{t.message}</span>
					</div>
				))}
			</div>

		</AppShell>
	);
}

export default App;
