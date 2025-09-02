// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use serde::Serialize;
use std::fs;
use std::io::{BufReader, Read};
use std::path::Path;
use std::process::{Command, Stdio};
use tauri::Emitter;
use std::sync::{Arc, Mutex};
use once_cell::sync::Lazy;
use std::sync::atomic::{AtomicU32, Ordering};
use sha2::{Digest, Sha256};
use hex::ToHex;
use semver::Version;
use std::os::unix::fs::PermissionsExt;
#[tauri::command]
fn get_device_details() -> Result<serde_json::Value, String> {
    // Return full lsblk JSON for a detailed view in the UI
    let output = Command::new("lsblk")
        .args(["-J", "-O", "-b"])
        .output()
        .map_err(|e| format!("failed to run lsblk: {}", e))?;
    if !output.status.success() {
        return Err(format!("lsblk failed with code {:?}", output.status.code()));
    }
    let v: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("failed to parse lsblk json: {}", e))?;
    Ok(v)
}

#[tauri::command]
fn save_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("write failed: {}", e))
}

#[derive(Debug, Serialize)]
pub struct BlockDevice {
    pub name: String,
    pub path: String,
    pub size: String,
    pub model: Option<String>,
    pub vendor: Option<String>,
    pub serial: Option<String>,
    pub transport: Option<String>,
    pub removable: bool,
}

#[tauri::command]
fn list_block_devices() -> Result<Vec<BlockDevice>, String> {
    eprintln!("[Inscribe] list_block_devices: invoking lsblk ...");
    // Use lsblk to list removable devices (including USB) in JSON
    let output = Command::new("lsblk")
        .args([
            "-J", // JSON output
            "-O", // all columns
            "-b", // bytes for sizes
        ])
        .output()
        .map_err(|e| format!("failed to run lsblk: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "lsblk failed with code {:?}",
            output.status.code()
        ));
    }

    let v: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("failed to parse lsblk json: {}", e))?;

    let mut devices: Vec<BlockDevice> = Vec::new();

    if let Some(blockdevices) = v.get("blockdevices").and_then(|x| x.as_array()) {
        for dev in blockdevices {
            let is_removable = dev
                .get("rm")
                .and_then(|x| x.as_u64())
                .map(|x| x == 1)
                .unwrap_or(false);

            let tran = dev
                .get("tran")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string());

            // Only include removable or usb transport devices
            let is_usb = tran
                .as_deref()
                .map(|t| t.eq_ignore_ascii_case("usb"))
                .unwrap_or(false);

            if !(is_removable || is_usb) {
                continue;
            }

            let name = dev
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let path = format!("/dev/{}", name);
            let size = dev
                .get("size")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let model = dev
                .get("model")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string());

            let vendor = dev
                .get("vendor")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string());

            let serial = dev
                .get("serial")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string());

            devices.push(BlockDevice {
                name,
                path,
                size,
                model,
                vendor,
                serial,
                transport: tran,
                removable: is_removable,
            });
        }
    }

    eprintln!("[Inscribe] list_block_devices: found {} candidate devices", devices.len());
    Ok(devices)
}

#[derive(Debug, Serialize, Clone)]
pub struct FlashProgress {
    pub bytes_written: u64,
    pub total_bytes: Option<u64>,
}

/// Read a progress stream that may use carriage returns ("\r") instead of newlines.
/// For each completed logical line, invoke the provided callback.
fn read_progress_stream<R: Read, F: FnMut(&str)>(reader: R, mut on_line: F) {
    let mut reader = BufReader::new(reader);
    let mut buf: Vec<u8> = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        match reader.read(&mut byte) {
            Ok(0) => {
                // EOF: flush any remaining buffer as a final line
                if !buf.is_empty() {
                    let line = String::from_utf8_lossy(&buf).to_string();
                    on_line(&line);
                }
                break;
            }
            Ok(_) => {
                let b = byte[0];
                if b == b'\n' || b == b'\r' {
                    if !buf.is_empty() {
                        let line = String::from_utf8_lossy(&buf).to_string();
                        on_line(&line);
                        buf.clear();
                    }
                } else {
                    buf.push(b);
                }
            }
            Err(_) => {
                // On read error, flush what we have and stop
                if !buf.is_empty() {
                    let line = String::from_utf8_lossy(&buf).to_string();
                    on_line(&line);
                }
                break;
            }
        }
    }
}

// Track one in-flight privileged child process; simple single-op model (erase/flash/format not concurrent)
static ACTIVE_PID: Lazy<AtomicU32> = Lazy::new(|| AtomicU32::new(0));

/// Spawn the privileged helper using sudo NOPASSWD if available, else fall back to pkexec.
fn spawn_privileged_helper(args: &[&str]) -> Result<std::process::Child, String> {
    let helper_path = "/usr/local/bin/inscribe-helper";
    // First try sudo -n to avoid interactive prompts
    let mut sudo_args: Vec<&str> = Vec::with_capacity(2 + args.len());
    sudo_args.push("-n");
    sudo_args.push(helper_path);
    sudo_args.extend_from_slice(args);
    if let Ok(child) = Command::new("sudo")
        .args(&sudo_args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        eprintln!("[Inscribe] spawn_privileged_helper: spawned via sudo -n");
        let pid = child.id(); ACTIVE_PID.store(pid as u32, Ordering::SeqCst);
        return Ok(child);
    }
    eprintln!("[Inscribe] spawn_privileged_helper: sudo spawn failed, falling back to pkexec");
    // pkexec will show a GUI prompt once, which is fine as a fallback
    let child = Command::new("pkexec")
        .arg(helper_path)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e2| format!("failed to spawn helper via pkexec: {}", e2))?;
    let pid = child.id(); ACTIVE_PID.store(pid as u32, Ordering::SeqCst);
    Ok(child)
}

#[tauri::command]
fn flash_iso(app: tauri::AppHandle, iso_path: String, device_path: String) -> Result<(), String> {
    eprintln!("[Inscribe] flash_iso: start iso='{}' dev='{}'", iso_path, device_path);
    // Safety checks: device_path should look like /dev/sdX or /dev/nvmeXnY
    let allowed = device_path.starts_with("/dev/sd") || device_path.starts_with("/dev/nvme");
    if !allowed {
        return Err("Refusing to write to non-block device".into());
    }

    // Verify ISO exists and get size
    let iso_md = fs::metadata(&iso_path).map_err(|e| format!("ISO not accessible: {}", e))?;
    let total_bytes = iso_md.len();

    // Prevent writing to system disk by checking root mount device
    if is_system_device(&device_path).map_err(|e| format!("system check failed: {}", e))? {
        return Err("Selected device appears to be the system/root disk; aborting.".into());
    }

    // Try to unmount any mounted partitions on the target device
    eprintln!("[Inscribe] flash_iso: unmounting children of {}", device_path);
    unmount_children(&device_path)?;

    // Delegate to helper via sudo (NOPASSWD) to handle unmount + dd with progress
    eprintln!("[Inscribe] flash_iso: spawning helper (sudo or pkexec) ...");
    let mut child = spawn_privileged_helper(&["flash", &iso_path, &device_path])?;

    // Read stderr for progress lines with running byte counts and keep a tail buffer for error messages
    let mut stderr_handle_opt = None;
    let stderr_tail: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    // Emit an initial progress event at 0 to render UI immediately
    let _ = app.emit(
        "flash-progress",
        FlashProgress { bytes_written: 0, total_bytes: Some(total_bytes) },
    );

    if let Some(stderr) = child.stderr.take() {
        let app_clone = app.clone();
        let tail_clone = Arc::clone(&stderr_tail);
        let handle = std::thread::spawn(move || {
            read_progress_stream(stderr, |line| {
                // Keep last 200 lines of stderr for diagnostics
                {
                    let mut buf = tail_clone.lock().ok();
                    if let Some(ref mut b) = buf {
                        b.push(line.to_string());
                        let len = b.len();
                        if len > 200 {
                            let drain_to = len - 200;
                            let _ = b.drain(0..drain_to);
                        }
                    }
                }
                eprintln!("[Inscribe/helper] {}", line);
                if let Some(bytes_str) = line.split_whitespace().next() {
                    if let Ok(bytes) = bytes_str.parse::<u64>() {
                        let _ = app_clone.emit(
                            "flash-progress",
                            FlashProgress { bytes_written: bytes, total_bytes: Some(total_bytes) },
                        );
                    }
                }
            });
        });
        stderr_handle_opt = Some(handle);
    }

    let status = child.wait().map_err(|e| format!("helper wait failed: {}", e))?;
    ACTIVE_PID.store(0, Ordering::SeqCst);
    if let Some(h) = stderr_handle_opt { let _ = h.join(); }
    if !status.success() {
        let tail = stderr_tail.lock().ok().map(|v| v.join("\n")).unwrap_or_default();
        let msg = if tail.trim().is_empty() { String::new() } else { format!("\n--- helper output ---\n{}", tail) };
        eprintln!("[Inscribe] flash_iso: helper failed status={:?}\n{}", status.code(), msg);
        return Err(format!("helper exited with status: {:?}{}", status.code(), msg));
    }

    // Sync to ensure data flushed
    let _ = Command::new("sync").status();
    // Emit a final progress event at 100%
    let _ = app.emit(
        "flash-progress",
        FlashProgress { bytes_written: total_bytes, total_bytes: Some(total_bytes) },
    );
    eprintln!("[Inscribe] flash_iso: completed successfully");
    Ok(())
}

fn is_system_device(device_path: &str) -> Result<bool, std::io::Error> {
    // Read /proc/mounts to find root device (/) and derive its parent disk
    let mounts = fs::read_to_string("/proc/mounts")?;
    let mut root_dev: Option<String> = None;
    for line in mounts.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 2 && parts[1] == "/" {
            root_dev = Some(parts[0].to_string());
            break;
        }
    }
    if let Some(root_partition) = root_dev {
        let root_parent = parent_block_device(&root_partition);
        let target_parent = parent_block_device(device_path);
        return Ok(root_parent == target_parent);
    }
    Ok(false)
}

fn parent_block_device(dev: &str) -> String {
    // Normalize common linux naming: sda, sda1 -> sda; nvme0n1, nvme0n1p2 -> nvme0n1
    if dev.starts_with("/dev/nvme") {
        // strip partition suffix p<nr>
        if let Some(idx) = dev.rfind('p') {
            let after = &dev[idx + 1..];
            if after.chars().all(|c| c.is_ascii_digit()) {
                return dev[..idx].to_string();
            }
        }
        return dev.to_string();
    }
    if dev.starts_with("/dev/sd") {
        // strip trailing digits
        let mut end = dev.len();
        for (i, ch) in dev.char_indices().rev() {
            if ch.is_ascii_digit() { end = i; } else { break; }
        }
        return dev[..end].to_string();
    }
    dev.to_string()
}

fn unmount_children(device_path: &str) -> Result<(), String> {
    // Delegate unmount to helper; it will unmount all partitions of the device
    eprintln!("[Inscribe] unmount_children: {}", device_path);
    let mut child = spawn_privileged_helper(&["unmount", device_path])
        .map_err(|e| format!("failed to spawn unmount helper: {}", e))?;
    let status = child
        .wait()
        .map_err(|e| format!("failed waiting unmount helper: {}", e))?;
    if !status.success() {
        eprintln!("[Inscribe] unmount_children: helper failed status={:?}", status.code());
        return Err(format!("unmount helper exited with status: {:?}", status.code()));
    }
    eprintln!("[Inscribe] unmount_children: done");
    Ok(())
}



#[derive(Debug, Serialize, Clone)]
pub struct EraseProgress {
    pub bytes_processed: u64,
    pub total_bytes: Option<u64>,
}

#[derive(Debug, Serialize, Clone)]
pub struct FormatProgress {
    pub percent: u8,
    pub message: Option<String>,
}

#[tauri::command]
fn secure_erase(app: tauri::AppHandle, device_path: String, mode: String) -> Result<(), String> {
    eprintln!("[Inscribe] secure_erase: start dev='{}' mode='{}'", device_path, mode);
    // Modes: zero, random, blkdiscard, wipefs
    let allowed = device_path.starts_with("/dev/sd") || device_path.starts_with("/dev/nvme");
    if !allowed { return Err("Refusing to operate on non-block device".into()); }
    if is_system_device(&device_path).map_err(|e| format!("system check failed: {}", e))? {
        return Err("Selected device appears to be the system/root disk; aborting.".into());
    }
    let total_bytes = device_size_bytes(&device_path);

    // Delegate to helper via sudo for erase; helper unmounts first
    eprintln!("[Inscribe] secure_erase: spawning helper (sudo or pkexec) ...");
    let mut child = spawn_privileged_helper(&["erase", &mode, &device_path])?;

    // Emit an initial progress event at 0 to render UI immediately (even if mode has no progress output)
    let _ = app.emit(
        "erase-progress",
        EraseProgress { bytes_processed: 0, total_bytes },
    );

    let mut stderr_handle_opt = None;
    let stderr_tail: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    if let Some(stderr) = child.stderr.take() {
        let app_clone = app.clone();
        let tail_clone = Arc::clone(&stderr_tail);
        let handle = std::thread::spawn(move || {
            read_progress_stream(stderr, |line| {
                {
                    let mut buf = tail_clone.lock().ok();
                    if let Some(ref mut b) = buf {
                        b.push(line.to_string());
                        let len = b.len();
                        if len > 200 {
                            let drain_to = len - 200;
                            let _ = b.drain(0..drain_to);
                        }
                    }
                }
                eprintln!("[Inscribe/helper] {}", line);
                if let Some(bytes_str) = line.split_whitespace().next() {
                    if let Ok(bytes) = bytes_str.parse::<u64>() {
                        let _ = app_clone.emit("erase-progress", EraseProgress { bytes_processed: bytes, total_bytes });
                    }
                }
            });
        });
        stderr_handle_opt = Some(handle);
    }

    let status = child.wait().map_err(|e| format!("wait failed: {}", e))?;
    ACTIVE_PID.store(0, Ordering::SeqCst);
    if let Some(h) = stderr_handle_opt { let _ = h.join(); }
    if !status.success() {
        let tail_joined = stderr_tail.lock().ok().map(|v| v.join("\n")).unwrap_or_default();
        let code_opt = status.code();
        let tail_has_nospace = tail_joined.contains("No space left on device");
        // dd returns non-zero when it hits end of device; treat that as success for erase
        if tail_has_nospace {
            eprintln!("[Inscribe] secure_erase: dd hit end-of-device; treating as success");
            if let Some(total) = total_bytes { let _ = app.emit("erase-progress", EraseProgress { bytes_processed: total, total_bytes: Some(total) }); }
            eprintln!("[Inscribe] secure_erase: completed successfully (EOD)");
            return Ok(());
        }
        // Trim error output to last 20 lines to avoid flooding the UI
        let short_tail = {
            let mut lines: Vec<&str> = tail_joined.lines().collect();
            let keep = 20usize.min(lines.len());
            lines.split_off(lines.len().saturating_sub(keep)).join("\n")
        };
        let msg = if short_tail.trim().is_empty() { String::new() } else { format!("\n--- helper output (last lines) ---\n{}", short_tail) };
        eprintln!("[Inscribe] secure_erase: helper failed status={:?}\n{}", code_opt, msg);
        return Err(format!("erase helper exited with status: {:?}{}", code_opt, msg));
    }
    let _ = Command::new("sync").status();
    // Emit a final progress event at 100% if we know the size
    if let Some(total) = total_bytes {
        let _ = app.emit("erase-progress", EraseProgress { bytes_processed: total, total_bytes: Some(total) });
    }
    eprintln!("[Inscribe] secure_erase: completed successfully");
    Ok(())
}

#[tauri::command]
fn format_device(app: tauri::AppHandle, device_path: String, fs: String, label: String) -> Result<(), String> {
    eprintln!("[Inscribe] format_device: start dev='{}' fs='{}' label='{}'", device_path, fs, label);
    let allowed = device_path.starts_with("/dev/sd") || device_path.starts_with("/dev/nvme");
    if !allowed { return Err("Refusing to operate on non-block device".into()); }
    if is_system_device(&device_path).map_err(|e| format!("system check failed: {}", e))? {
        return Err("Selected device appears to be the system/root disk; aborting.".into());
    }

    eprintln!("[Inscribe] format_device: spawning helper (sudo or pkexec) ...");
    let mut child = spawn_privileged_helper(&["format", &fs, &device_path, &label])?;

    // Emit initial 0%
    let _ = app.emit("format-progress", FormatProgress { percent: 0, message: Some("Starting".into()) });

    let mut stderr_handle_opt = None;
    if let Some(stderr) = child.stderr.take() {
        let app_clone = app.clone();
        let handle = std::thread::spawn(move || {
            read_progress_stream(stderr, |line| {
                eprintln!("[Inscribe/helper] {}", line);
                let l = line.trim();
                if let Some(rest) = l.strip_prefix("PERCENT ") {
                    if let Ok(p) = rest.split_whitespace().next().unwrap_or("").parse::<u8>() {
                        let _ = app_clone.emit("format-progress", FormatProgress { percent: p.min(100), message: None });
                    }
                } else if let Some(rest) = l.strip_prefix("MSG ") {
                    let _ = app_clone.emit("format-progress", FormatProgress { percent: 0, message: Some(rest.to_string()) });
                }
            });
        });
        stderr_handle_opt = Some(handle);
    }

    let status = child.wait().map_err(|e| format!("format wait failed: {}", e))?;
    ACTIVE_PID.store(0, Ordering::SeqCst);
    if let Some(h) = stderr_handle_opt { let _ = h.join(); }
    if !status.success() {
        eprintln!("[Inscribe] format_device: helper failed status={:?}", status.code());
        return Err(format!("format helper exited with status: {:?}", status.code()));
    }
    let _ = app.emit("format-progress", FormatProgress { percent: 100, message: Some("Done".into()) });
    eprintln!("[Inscribe] format_device: completed successfully");
    Ok(())
}

#[tauri::command]
fn compute_sha256(path: String) -> Result<String, String> {
    let mut file = fs::File::open(&path).map_err(|e| format!("open failed: {}", e))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("read failed: {}", e))?;
        if n == 0 { break; }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize();
    Ok(digest.encode_hex::<String>())
}

#[tauri::command]
fn download_with_sha256(url: String, dest_path: String, expected_sha256: Option<String>) -> Result<String, String> {
    use std::io::{Read, Write};
    let client = reqwest::blocking::Client::builder()
        .user_agent("inscribe/0.1")
        .build()
        .map_err(|e| format!("http client build: {}", e))?;
    let mut resp = client.get(&url).send().map_err(|e| format!("http get: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("download failed: HTTP {}", resp.status()));
    }
    let mut file = fs::File::create(&dest_path).map_err(|e| format!("create failed: {}", e))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = resp.read(&mut buf).map_err(|e| format!("read failed: {}", e))?;
        if n == 0 { break; }
        file.write_all(&buf[..n]).map_err(|e| format!("write failed: {}", e))?;
        hasher.update(&buf[..n]);
    }
    let hex = hasher.finalize().encode_hex::<String>();
    if let Some(exp) = expected_sha256 {
        if exp.to_lowercase() != hex {
            return Err(format!("checksum mismatch: expected {}, got {}", exp, hex));
        }
    }
    Ok(hex)
}

#[tauri::command]
fn validate_flash_sample(device_path: String, iso_path: String, sample_count: usize, sample_size: usize) -> Result<bool, String> {
    use std::fs::File;
    use std::io::{Seek, SeekFrom};
    if sample_count == 0 || sample_size == 0 { return Ok(true); }
    let mut iso = File::open(&iso_path).map_err(|e| format!("open iso: {}", e))?;
    let mut dev = File::open(&device_path).map_err(|e| format!("open device: {}", e))?;
    let total = fs::metadata(&iso_path).map_err(|e| format!("stat iso: {}", e))?.len();
    let step = if sample_count as u64 > 0 { total / sample_count as u64 } else { total };
    let mut buf_iso = vec![0u8; sample_size];
    let mut buf_dev = vec![0u8; sample_size];
    for i in 0..sample_count {
        let off = (i as u64).saturating_mul(step).min(total.saturating_sub(sample_size as u64));
        iso.seek(SeekFrom::Start(off)).map_err(|e| format!("seek iso: {}", e))?;
        dev.seek(SeekFrom::Start(off)).map_err(|e| format!("seek dev: {}", e))?;
        iso.read_exact(&mut buf_iso).map_err(|e| format!("read iso: {}", e))?;
        dev.read_exact(&mut buf_dev).map_err(|e| format!("read dev: {}", e))?;
        if buf_iso != buf_dev { return Ok(false); }
    }
    Ok(true)
}

#[tauri::command]
fn start_flash_iso(app: tauri::AppHandle, iso_path: String, device_path: String) -> Result<(), String> {
    // Spawn the blocking flash operation on a background thread and return immediately
    std::thread::spawn(move || {
        let result = flash_iso(app.clone(), iso_path, device_path);
        // Emit completion event with result
        let _ = app.emit(
            "flash-complete",
            match result {
                Ok(()) => serde_json::json!({"ok": true}),
                Err(e) => serde_json::json!({"ok": false, "error": e}),
            },
        );
    });
    Ok(())
}

#[tauri::command]
fn start_secure_erase(app: tauri::AppHandle, device_path: String, mode: String) -> Result<(), String> {
    // Spawn the blocking erase operation on a background thread and return immediately
    std::thread::spawn(move || {
        let result = secure_erase(app.clone(), device_path, mode);
        let _ = app.emit(
            "erase-complete",
            match result {
                Ok(()) => serde_json::json!({"ok": true}),
                Err(e) => serde_json::json!({"ok": false, "error": e}),
            },
        );
    });
    Ok(())
}

#[tauri::command]
fn start_format_device(app: tauri::AppHandle, device_path: String, fs: String, label: String) -> Result<(), String> {
    std::thread::spawn(move || {
        let result = format_device(app.clone(), device_path, fs, label);
        let _ = app.emit(
            "format-complete",
            match result {
                Ok(()) => serde_json::json!({"ok": true}),
                Err(e) => serde_json::json!({"ok": false, "error": e}),
            },
        );
    });
    Ok(())
}

#[tauri::command]
fn cancel_active_operation() -> Result<(), String> {
    let pid = ACTIVE_PID.load(Ordering::SeqCst);
    if pid == 0 { return Ok(()); }
    eprintln!("[Inscribe] cancel_active_operation: sending SIGTERM to {}", pid);
    // Best-effort terminate helper and its dd/mkfs children: use pkill on process group
    // Send TERM to the pid; helper is a simple shell script which will die, and children should receive SIGHUP.
    let _ = Command::new("sh").arg("-c").arg(format!("kill -TERM {} 2>/dev/null || true", pid)).status();
    Ok(())
}

fn device_size_bytes(device_path: &str) -> Option<u64> {
    // read /sys/block/<dev>/size * 512
    let dev_name = Path::new(device_path).file_name()?.to_str()?.to_string();
    let base = if dev_name.starts_with("nvme") {
        // nvme0n1p2 -> nvme0n1
        Path::new(&parent_block_device(device_path)).file_name()?.to_str()?.to_string()
    } else {
        // sda1 -> sda
        Path::new(&parent_block_device(device_path)).file_name()?.to_str()?.to_string()
    };
    let path = format!("/sys/block/{}/size", base);
    let sectors: u64 = fs::read_to_string(path).ok()?.trim().parse().ok()?;
    Some(sectors.saturating_mul(512))
}

#[tauri::command]
#[cfg(all(target_os = "linux", feature = "hotplug"))]
fn start_hotplug_monitor(app: tauri::AppHandle) -> Result<(), String> {
    std::thread::spawn(move || {
        let mut monitor = match udev::MonitorBuilder::new().and_then(|m| m.match_subsystem_devtype("block", None)).and_then(|m| m.listen()) {
            Ok(m) => m,
            Err(_) => return,
        };
        for event in monitor.into_iter() {
            let _ = app.emit("devices-changed", serde_json::json!({"action": format!("{:?}", event.event_type())}));
        }
    });
    Ok(())
}

#[tauri::command]
#[cfg(not(all(target_os = "linux", feature = "hotplug")))]
fn start_hotplug_monitor(_app: tauri::AppHandle) -> Result<(), String> { Ok(()) }

#[derive(Debug, Serialize)]
struct UpdateResult {
    updated: bool,
    latest: String,
}

#[tauri::command]
fn github_update_self(owner: String, repo: String, current_version: String) -> Result<UpdateResult, String> {
    // Only support AppImage self-update on Linux
    #[cfg(not(target_os = "linux"))]
    {
        return Err("Self-update is only supported on Linux AppImage".into());
    }

    #[cfg(target_os = "linux")]
    {
        // Running AppImage path is provided by APPIMAGE env var
        let appimage_path = std::env::var("APPIMAGE")
            .map_err(|_| "APPIMAGE environment not set; are you running from an AppImage?".to_string())?;
        let current_exe = Path::new(&appimage_path);
        let dest_dir = current_exe.parent().ok_or_else(|| "Could not determine AppImage directory".to_string())?;

        // Normalize current version (strip leading 'v')
        let cur_v = current_version.trim().trim_start_matches('v');
        let cur_sem = Version::parse(cur_v).unwrap_or_else(|_| Version::new(0,0,0));

        // Query GitHub latest release
        let api_url = format!("https://api.github.com/repos/{}/{}/releases/latest", owner, repo);
        let client = reqwest::blocking::Client::builder()
            .user_agent("inscribe-updater/0.1")
            .build()
            .map_err(|e| format!("http client build: {}", e))?;
        let resp = client.get(&api_url).header("Accept", "application/vnd.github+json").send()
            .map_err(|e| format!("http get: {}", e))?;
        if !resp.status().is_success() {
            return Err(format!("GitHub API error: HTTP {}", resp.status()));
        }
        let v: serde_json::Value = resp.json().map_err(|e| format!("parse json: {}", e))?;
        let tag = v.get("tag_name").and_then(|x| x.as_str()).unwrap_or("");
        let latest_v_str = tag.trim().trim_start_matches('v');
        let latest_sem = Version::parse(latest_v_str).unwrap_or_else(|_| Version::new(0,0,0));

        if latest_sem <= cur_sem {
            return Ok(UpdateResult { updated: false, latest: tag.to_string() });
        }

        // Determine arch synonyms
        let arch = std::env::consts::ARCH.to_lowercase();
        let mut arch_terms: Vec<&str> = vec![&arch];
        match arch.as_str() {
            "x86_64" => arch_terms.extend_from_slice(&["x86_64", "amd64"]),
            "aarch64" => arch_terms.extend_from_slice(&["aarch64", "arm64"]),
            _ => {}
        }

        // Pick AppImage asset matching our arch
        let assets = v.get("assets").and_then(|a| a.as_array()).ok_or_else(|| "No assets in release".to_string())?;
        let mut chosen_url: Option<&str> = None;
        let mut chosen_name: Option<&str> = None;
        for a in assets {
            let name = a.get("name").and_then(|x| x.as_str()).unwrap_or("");
            let url = a.get("browser_download_url").and_then(|x| x.as_str()).unwrap_or("");
            let lname = name.to_lowercase();
            if lname.ends_with(".appimage") && arch_terms.iter().any(|t| lname.contains(t)) {
                chosen_url = Some(url);
                chosen_name = Some(name);
                break;
            }
        }
        // Fallback: any .AppImage
        if chosen_url.is_none() {
            for a in assets {
                let name = a.get("name").and_then(|x| x.as_str()).unwrap_or("");
                let url = a.get("browser_download_url").and_then(|x| x.as_str()).unwrap_or("");
                if name.to_lowercase().ends_with(".appimage") {
                    chosen_url = Some(url);
                    chosen_name = Some(name);
                    break;
                }
            }
        }
        let dl_url = chosen_url.ok_or_else(|| "No AppImage asset found in latest release".to_string())?;
        let fname = chosen_name.unwrap_or("update.AppImage");

        // Download to same directory to allow atomic rename
        let tmp_path = dest_dir.join(format!("{}.download", fname));
        let mut resp = client.get(dl_url).send().map_err(|e| format!("download: {}", e))?;
        if !resp.status().is_success() { return Err(format!("download failed: HTTP {}", resp.status())); }
        {
            use std::io::Write;
            let mut out = fs::File::create(&tmp_path).map_err(|e| format!("create: {}", e))?;
            let mut buf = [0u8; 64 * 1024];
            loop {
                let n = resp.read(&mut buf).map_err(|e| format!("read: {}", e))?;
                if n == 0 { break; }
                out.write_all(&buf[..n]).map_err(|e| format!("write: {}", e))?;
            }
        }
        // chmod +x
        let mut perms = fs::metadata(&tmp_path).map_err(|e| format!("stat: {}", e))?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&tmp_path, perms).map_err(|e| format!("chmod: {}", e))?;

        // Atomic replace
        // If rename fails, try copy over
        match fs::rename(&tmp_path, &current_exe) {
            Ok(_) => {}
            Err(_) => {
                // Try copy then remove
                fs::copy(&tmp_path, &current_exe).map_err(|e| format!("copy: {}", e))?;
                let _ = fs::remove_file(&tmp_path);
            }
        }

        Ok(UpdateResult { updated: true, latest: tag.to_string() })
    }
}

#[tauri::command]
fn relaunch_appimage() -> Result<(), String> {
    #[cfg(not(target_os = "linux"))]
    { return Err("Relaunch only implemented for Linux AppImage".into()); }
    #[cfg(target_os = "linux")]
    {
        let appimage_path = std::env::var("APPIMAGE")
            .map_err(|_| "APPIMAGE environment not set; are you running from an AppImage?".to_string())?;
        let _ = Command::new(&appimage_path).spawn().map_err(|e| format!("spawn: {}", e))?;
        // Exit current process so the new one takes over
        std::process::exit(0);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    eprintln!("[Inscribe] Tauri run(): starting app ...");
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_block_devices,
            flash_iso,
            secure_erase,
            start_hotplug_monitor,
            elevate_permissions,
            ensure_setup,
            start_flash_iso,
            start_secure_erase,
            format_device,
            start_format_device,
            cancel_active_operation,
            get_device_details,
            save_text_file,
            compute_sha256,
            download_with_sha256,
            validate_flash_sample,
            github_update_self,
            relaunch_appimage,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn elevate_permissions() -> Result<(), String> {
    // Trigger a Polkit prompt proactively to cache credentials
    eprintln!("[Inscribe] elevate_permissions: pkexec true ...");
    let status = Command::new("pkexec")
        .arg("true")
        .status()
        .map_err(|e| format!("failed to run pkexec: {}", e))?;
    if !status.success() {
        return Err(format!("pkexec exited with status: {:?}", status.code()));
    }
    eprintln!("[Inscribe] elevate_permissions: ok");
    Ok(())
}

#[tauri::command]
fn ensure_setup() -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    {
        let helper_path = "/usr/local/bin/inscribe-helper";
        let sudoers_path = "/etc/sudoers.d/inscribe";

        let helper_ok = fs::metadata(helper_path)
            .map(|m| m.permissions().readonly() == false)
            .unwrap_or(false);
        let sudoers_ok = fs::metadata(sudoers_path).is_ok();
        // Only check helper content (world-readable). Sudoers is not readable by normal users (0440),
        // so rely on existence only to avoid repeated prompts.
        let needs_update = fs::read_to_string(helper_path)
            .map(|c| !c.contains("# Inscribe helper v6"))
            .unwrap_or(true);
        eprintln!("[Inscribe] ensure_setup: helper_ok={} sudoers_ok={} needs_update={}", helper_ok, sudoers_ok, needs_update);
        if helper_ok && sudoers_ok && !needs_update {
            return Ok(false);
        }

        // Ensure pkexec exists
        let pkexec_ok = Command::new("sh")
            .args(["-c", "command -v pkexec >/dev/null 2>&1"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !pkexec_ok {
            return Err("pkexec (polkit) is not installed; please install polkit.".into());
        }

        // Helper script content
        let helper_content = r#"#!/bin/sh
# Inscribe helper v6
set -eu

CMD="$1"; shift || true

is_valid_dev() {
  case "$1" in
    /dev/sd*|/dev/nvme*) return 0 ;;
    *) return 1 ;;
  esac
}
unmount_children() {
  DEV="$1"
  NAME="$(basename "$DEV")"
  PATHS=$(lsblk -rno NAME "/dev/$NAME" | awk '{print "/dev/"$1}')
  [ -n "$PATHS" ] || return 0
  MPS=$(lsblk -rno MOUNTPOINT $PATHS | sed '/^$/d')
  # Try udisksctl first, then fall back to umount; never fail the script on unmount errors
  echo "$MPS" | awk 'length>0' | sort -r | while read -r MP; do
    udisksctl unmount -b "$(findmnt -n -o SOURCE --target "$MP" 2>/dev/null || true)" >/dev/null 2>&1 || true
    umount -lf "$MP" >/dev/null 2>&1 || true
  done
}

case "$CMD" in
  unmount)
    DEV="$1"
    is_valid_dev "$DEV" || { echo "Invalid device" >&2; exit 2; }
    unmount_children "$DEV"
    ;;
  flash)
    ISO="$1"; DEV="$2"
    [ -r "$ISO" ] || { echo "ISO not readable" >&2; exit 2; }
    is_valid_dev "$DEV" || { echo "Invalid device" >&2; exit 2; }
    ROOTDEV=$(awk '$2=="/"{print $1}' /proc/mounts)
    [ "$ROOTDEV" = "$DEV" ] && { echo "Refusing to write root device" >&2; exit 2; }
    unmount_children "$DEV"
    # Use direct I/O and larger block size for steadier throughput; final sync ensures flush
    dd if="$ISO" of="$DEV" bs=16M iflag=fullblock oflag=direct status=progress
    sync
    ;;
  erase)
    MODE="$1"; DEV="$2"
    is_valid_dev "$DEV" || { echo "Invalid device" >&2; exit 2; }
    ROOTDEV=$(awk '$2=="/"{print $1}' /proc/mounts)
    [ "$ROOTDEV" = "$DEV" ] && { echo "Refusing to erase root device" >&2; exit 2; }
    unmount_children "$DEV"
    case "$MODE" in
      auto)
        # Try blkdiscard first; if unsupported, fall back to zero fill
        if blkdiscard "$DEV" >/dev/null 2>&1; then
          :
        else
          dd if=/dev/zero of="$DEV" bs=16M oflag=direct status=progress; sync
        fi
        ;;
      blkdiscard) blkdiscard "$DEV" ;;
      wipefs) wipefs -a "$DEV" ;;
      random) dd if=/dev/urandom of="$DEV" bs=4M oflag=direct status=progress; sync ;;
      zero|*) dd if=/dev/zero of="$DEV" bs=16M oflag=direct status=progress; sync ;;
    esac
    ;;
  format)
    FS="$1"; DEV="$2"; LABEL="$3"
    is_valid_dev "$DEV" || { echo "Invalid device" >&2; exit 2; }
    ROOTDEV=$(awk '$2=="/"{print $1}' /proc/mounts)
    [ "$ROOTDEV" = "$DEV" ] && { echo "Refusing to format root device" >&2; exit 2; }
    unmount_children "$DEV"
    # Create a single GPT partition spanning the whole device
    echo "MSG Partitioning" >&2
    sgdisk --zap-all "$DEV" >/dev/null 2>&1 || true
    partprobe "$DEV" >/dev/null 2>&1 || true
    echo "PERCENT 20" >&2
    sgdisk -og "$DEV" >/dev/null
    sgdisk -n 0:0:0 -t 0:0700 -c 0:"$LABEL" "$DEV" >/dev/null
    partprobe "$DEV" >/dev/null 2>&1 || true
    sleep 1
    echo "PERCENT 20" >&2
    # Determine partition path
    PART="${DEV}1"
    case "$DEV" in
      /dev/nvme*) PART="${DEV}p1" ;;
    esac
    # Make filesystem
    echo "MSG Creating filesystem $FS" >&2
    case "$FS" in
      ext4)
        # Faster ext4: lazy inode table init and discard, fewer passes
        mkfs.ext4 -F -E lazy_itable_init=1,lazy_journal_init=1,discard -L "$LABEL" "$PART" >/dev/null 2>&1 ;;
      fat32|vfat)
        mkfs.vfat -F 32 -n "$LABEL" "$PART" >/dev/null 2>&1 ;;
      exfat)
        mkfs.exfat -n "$LABEL" "$PART" >/dev/null 2>&1 ;;
      ntfs)
        mkfs.ntfs -F -L "$LABEL" "$PART" >/dev/null 2>&1 ;;
      *)
        echo "Unsupported filesystem" >&2; exit 2 ;;
    esac
    echo "PERCENT 80" >&2
    sync
    echo "PERCENT 100" >&2
    ;;
  *)
    echo "Usage: inscribe-helper {unmount|flash ISO DEV|erase MODE DEV}" >&2
    exit 2
    ;;
esac
"#;

        // Prepare sudoers drop-in to allow helper without password for common admin groups
        let sudoers_content = r#"# Inscribe sudoers v3
Cmnd_Alias INSCRIBE_CMDS = /usr/local/bin/inscribe-helper
%sudo ALL=(root) NOPASSWD: INSCRIBE_CMDS
%wheel ALL=(root) NOPASSWD: INSCRIBE_CMDS
"#;

        // Combine privileged steps into ONE pkexec call to avoid multiple prompts
        let setup_script = format!(
            r#"set -eu
echo "[Inscribe/setup] writing helper to {helper_path}" 1>&2
cat > {helper_path} << 'EOFH'
{helper_content}
EOFH
chmod 0755 {helper_path}
chown root:root {helper_path}

echo "[Inscribe/setup] writing sudoers to {sudoers_path}" 1>&2
cat > {sudoers_path} << 'EOFS'
{sudoers_content}
EOFS
chmod 0440 {sudoers_path}
chown root:root {sudoers_path}
/usr/sbin/visudo -cf {sudoers_path}
"#,
            helper_path = helper_path,
            helper_content = helper_content,
            sudoers_path = sudoers_path,
            sudoers_content = sudoers_content,
        );

        let status = Command::new("pkexec")
            .arg("/bin/sh")
            .arg("-c")
            .arg(&setup_script)
            .status()
            .map_err(|e| format!("failed to run pkexec setup script: {}", e))?;
        eprintln!("[Inscribe] ensure_setup: setup script exit={:?}", status.code());
        if !status.success() {
            return Err(format!("setup script exited with status: {:?}", status.code()));
        }

        Ok(true)
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(false)
    }
}
