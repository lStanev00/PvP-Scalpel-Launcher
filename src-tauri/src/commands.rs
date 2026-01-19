use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, OnceLock};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use registry::{Data, Hive, Security};
use std::fs;
use std::fs::File;
use std::io;
use futures_util::StreamExt;
use reqwest::Client;
use reqwest::Url;
use serde::Serialize;
use serde_json::Value;
use sysinfo::System;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;
use tokio::sync::{Mutex, Notify};
use zip::ZipArchive;
use urlencoding::encode;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

// In-memory single-flight cache for the manifest endpoint.
struct ManifestCache {
    value: Option<Value>,
    fetching: bool,
    notify: Arc<Notify>,
}

impl ManifestCache {
    fn new() -> Self {
        Self {
            value: None,
            fetching: false,
            notify: Arc::new(Notify::new()),
        }
    }
}

static MANIFEST_CACHE: OnceLock<Mutex<ManifestCache>> = OnceLock::new();
// Global cancel flag for a single in-flight action.
static ACTION_CANCELLED: AtomicBool = AtomicBool::new(false);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ActionProgress {
    phase: String,
    progress: Option<u64>,
    message: String,
    log: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    ok: bool,
    error_code: Option<String>,
    error_message: Option<String>,
}

// Emit log lines for the frontend to consume.
fn emit_log(app: &AppHandle, message: &str) {
    let _ = app.emit_to("main", "launcher-log", message.to_string());
}

fn emit_action_progress(app: &AppHandle, phase: &str, progress: Option<u64>, message: &str, log: &str) {
    let payload = ActionProgress {
        phase: phase.to_string(),
        progress,
        message: message.to_string(),
        log: log.to_string(),
    };
    let _ = app.emit_to("main", "action-progress", payload);
}

fn emit_addon_reload_notice(app: &AppHandle) {
    let _ = app.emit_to(
        "main",
        "addon-reload-required",
        "WoW is running. Type /reload to activate the updated addon.".to_string(),
    );
}

// Check for a running WoW process to decide whether to show the reload dialog.
fn is_wow_running() -> bool {
    let mut system = System::new_all();
    system.refresh_processes();
    system.processes().values().any(|process| {
        let name = process.name().to_lowercase();
        name == "wow.exe" || name == "wow"
    })
}

// Fast cancel check used by long-running action steps.
fn ensure_not_cancelled() -> Result<(), String> {
    if ACTION_CANCELLED.load(Ordering::SeqCst) {
        return Err("CANCELLED".to_string());
    }
    Ok(())
}

// Resolve a writable temp directory under app data.
fn temp_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("Failed to resolve app data dir: {err}"))?;
    let tmp = base.join("tmp");
    fs::create_dir_all(&tmp).map_err(|err| format!("Failed to create temp dir: {err}"))?;
    Ok(tmp)
}

// Ask the API for a CDN download URL for the given key.
async fn request_download_url(key: &str) -> Result<String, String> {
    let encoded = encode(key);
    let url = format!("{}/CDN/download/{}", API_BASE, encoded);
    let client = Client::new();
    let response = client
        .get(url)
        .header("600", "BasicPass")
        .send()
        .await
        .map_err(|err| format!("Download URL request failed: {err}"))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("Download URL request failed: HTTP {status}"));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|err| format!("Download URL response failed: {err}"))?;

    if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
        if let Some(url) = value.as_str() {
            return Ok(url.to_string());
        }
        if let Some(url) = value.get("url").and_then(|v| v.as_str()) {
            return Ok(url.to_string());
        }
        if let Some(url) = value.get("downloadUrl").and_then(|v| v.as_str()) {
            return Ok(url.to_string());
        }
    }

    let text = String::from_utf8_lossy(&bytes).trim().to_string();
    if text.starts_with("http") {
        return Ok(text);
    }

    Err("Download URL response was not a URL".to_string())
}

// Only allow https downloads from the CDN response.
fn validate_https_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|err| format!("Invalid download URL: {err}"))?;
    if url.scheme() != "https" {
        return Err("Download URL must use https".to_string());
    }
    Ok(url)
}

// Stream the download to disk while emitting progress events.
async fn download_with_progress(app: &AppHandle, url: &Url, dest: &Path) -> Result<(), String> {
    let client = Client::new();
    let response = client
        .get(url.clone())
        .send()
        .await
        .map_err(|err| format!("Download failed: {err}"))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("Download failed: HTTP {status}"));
    }

    let total = response.content_length();
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|err| format!("Failed to create download file: {err}"))?;
    let mut downloaded: u64 = 0;
    let mut last_percent: u64 = 0;
    let mut last_emit = Instant::now();

    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        ensure_not_cancelled()?;
        let chunk = chunk.map_err(|err| format!("Download stream failed: {err}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|err| format!("Download write failed: {err}"))?;
        downloaded += chunk.len() as u64;

        if let Some(total) = total {
            let percent = (downloaded.saturating_mul(100) / total).min(100);
            if percent != last_percent || last_emit.elapsed().as_millis() > 500 {
                last_percent = percent;
                last_emit = Instant::now();
                emit_action_progress(app, "DOWNLOADING", Some(percent), "Downloading", "");
            }
        } else if last_emit.elapsed().as_millis() > 750 {
            last_emit = Instant::now();
            emit_action_progress(app, "DOWNLOADING", None, "Downloading", "");
        }
    }

    file.flush()
        .await
        .map_err(|err| format!("Download flush failed: {err}"))?;
    emit_action_progress(app, "DOWNLOADING", Some(100), "Downloading", "Download complete");
    Ok(())
}

// ZipSlip-safe extraction using enclosed paths only.
fn extract_zip_secure(zip_path: &Path, dest_dir: &Path) -> Result<(), String> {
    let file = File::open(zip_path).map_err(|err| format!("Zip open failed: {err}"))?;
    let mut archive = ZipArchive::new(file).map_err(|err| format!("Zip read failed: {err}"))?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|err| format!("Zip entry failed: {err}"))?;
        let entry_path = entry
            .enclosed_name()
            .ok_or_else(|| "Zip entry has invalid path".to_string())?;
        let out_path = dest_dir.join(entry_path);

        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|err| format!("Zip dir create failed: {err}"))?;
            continue;
        }

        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|err| format!("Zip dir create failed: {err}"))?;
        }

        let mut outfile = File::create(&out_path).map_err(|err| format!("Zip file create failed: {err}"))?;
        io::copy(&mut entry, &mut outfile).map_err(|err| format!("Zip extract failed: {err}"))?;
    }

    Ok(())
}

// Replace a directory with a cross-volume copy fallback.
fn replace_dir_atomic(source: &Path, target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("Target dir create failed: {err}"))?;
    }

    if target.exists() {
        fs::remove_dir_all(target).map_err(|err| format!("Target cleanup failed: {err}"))?;
    }

    if let Err(err) = fs::rename(source, target) {
        if err.raw_os_error() == Some(17) {
            copy_dir_recursive(source, target)?;
            fs::remove_dir_all(source).map_err(|err| format!("Source cleanup failed: {err}"))?;
        } else {
            return Err(format!("Failed to move into place: {err}"));
        }
    }
    Ok(())
}

// Recursive directory copy used for cross-volume replacements.
fn copy_dir_recursive(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|err| format!("Target dir create failed: {err}"))?;
    for entry in fs::read_dir(source).map_err(|err| format!("Source dir read failed: {err}"))? {
        let entry = entry.map_err(|err| format!("Source dir entry failed: {err}"))?;
        let path = entry.path();
        let dest = target.join(entry.file_name());
        let meta = entry.metadata().map_err(|err| format!("Source metadata failed: {err}"))?;
        if meta.is_dir() {
            copy_dir_recursive(&path, &dest)?;
        } else {
            fs::copy(&path, &dest).map_err(|err| format!("File copy failed: {err}"))?;
        }
    }
    Ok(())
}
// Resolve WoW AddOns path from registry keys (read-only).
fn read_wow_path() -> Option<String> {
    let main_key = r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Battle.net\Game\wow";

    if let Ok(key) = Hive::LocalMachine.open(main_key, Security::Read) {
        if let Ok(Data::String(path)) = key.value("InstallLocation") {
            let wow = path.to_string_lossy();
            let result = format!("{}\\Interface\\AddOns", wow.trim_end_matches(['\\', '/']));
            return Some(result);
        }
    }

    let fallback = r"SOFTWARE\WOW6432Node\Blizzard Entertainment\World of Warcraft";

    if let Ok(key) = Hive::LocalMachine.open(fallback, Security::Read) {
        if let Ok(Data::String(path)) = key.value("InstallPath") {
            let wow = path.to_string_lossy();
            let result = format!("{}\\Interface\\AddOns", wow.trim_end_matches(['\\', '/']));
            return Some(result);
        }
    }

    None
}

#[tauri::command]
pub fn get_wow_path(app: AppHandle) -> Option<String> {
    let result = read_wow_path();
    match result.as_deref() {
        Some(path) => emit_log(&app, &format!("WoW path detected ({path})")),
        None => emit_log(&app, "WoW path not found"),
    }
    result
}

// Locate the desktop app install directory via uninstall registry entries.
fn read_desktop_path() -> Option<String> {
    let keys = [
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PvP Scalpel",
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\bg.pvpscalpel.desktop",
        r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\bg.pvpscalpel.desktop",
    ];
    let values = ["InstallLocation", "InstallPath", "InstallDir", "DisplayIcon"];

    let hives = [Hive::CurrentUser, Hive::LocalMachine];

    for hive in hives {
        for key_path in keys {
            if let Ok(key) = hive.open(key_path, Security::Read) {
            for value in values {
                if let Ok(Data::String(path)) = key.value(value) {
                    let raw = path.to_string_lossy();
                    let cleaned = raw.split(',').next().unwrap_or(&raw);
                    let cleaned = cleaned.trim_matches('"').trim_end_matches(['\\', '/']);

                    if value == "DisplayIcon" {
                        let display = Path::new(cleaned);
                        if let Some(parent) = display.parent() {
                            if let Some(parent) = parent.to_str() {
                                return Some(parent.to_string());
                            }
                        }
                    } else {
                        return Some(cleaned.to_string());
                    }
                }
            }
        }
        }
    }

    None
}

#[tauri::command]
pub fn get_desktop_path(app: AppHandle) -> Option<String> {
    let result = read_desktop_path();
    match result.as_deref() {
        Some(path) => emit_log(&app, &format!("Desktop path detected ({path})")),
        None => emit_log(&app, "Desktop path not found"),
    }
    result
}

// Extract the desktop app version from uninstall registry entries.
fn read_desktop_version() -> Option<String> {
    let keys = [
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PvP Scalpel",
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\bg.pvpscalpel.desktop",
        r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\bg.pvpscalpel.desktop",
    ];
    let values = ["DisplayVersion", "Version", "ProductVersion"];

    let hives = [Hive::CurrentUser, Hive::LocalMachine];

    for hive in hives {
        for key_path in keys {
            if let Ok(key) = hive.open(key_path, Security::Read) {
                for value in values {
                    if let Ok(Data::String(version)) = key.value(value) {
                        return Some(version.to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    None
}

#[tauri::command]
pub fn get_desktop_version(app: AppHandle) -> Option<String> {
    let result = read_desktop_version();
    match result.as_deref() {
        Some(version) => emit_log(&app, &format!("Desktop version detected ({version})")),
        None => emit_log(&app, "Desktop version not found"),
    }
    result
}

// Resolve the desktop executable path based on registry metadata.
fn find_desktop_exe() -> Option<PathBuf> {
    let keys = [
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PvP Scalpel",
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\bg.pvpscalpel.desktop",
        r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\bg.pvpscalpel.desktop",
    ];
    let hives = [Hive::CurrentUser, Hive::LocalMachine];

    for hive in hives {
        for key_path in keys {
            let key = match hive.open(key_path, Security::Read) {
                Ok(key) => key,
                Err(_) => continue,
            };

            if let Ok(Data::String(path)) = key.value("DisplayIcon") {
                let raw = path.to_string_lossy();
                let cleaned = raw.split(',').next().unwrap_or(&raw);
                let cleaned = cleaned.trim_matches('"');
                let candidate = PathBuf::from(cleaned);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }

            let binary = if let Ok(Data::String(name)) = key.value("MainBinaryName") {
                Some(name.to_string_lossy().to_string())
            } else {
                None
            };

            if let Some(binary) = binary {
                for value in ["InstallLocation", "InstallPath", "InstallDir"] {
                    if let Ok(Data::String(path)) = key.value(value) {
                        let root = path.to_string_lossy();
                        let root = root.trim_matches('"').trim_end_matches(['\\', '/']);
                        let candidate = Path::new(root).join(&binary);
                        if candidate.is_file() {
                            return Some(candidate);
                        }
                    }
                }
            }
        }
    }

    None
}

#[tauri::command]
pub fn launch_desktop_app(app: AppHandle) -> Result<(), String> {
    let exe = match find_desktop_exe() {
        Some(exe) => exe,
        None => {
            emit_log(&app, "Desktop app not found");
            return Err("Desktop app not found".to_string());
        }
    };
    emit_log(&app, "Launch requested");
    Command::new(&exe)
        .spawn()
        .map_err(|err| {
            emit_log(&app, &format!("Launch failed: {err}"));
            format!("Failed to launch desktop app: {err}")
        })?;
    emit_log(&app, "Desktop app launched");
    Ok(())
}

#[tauri::command]
pub fn get_addon_version(app: AppHandle) -> Option<String> {
    let result = read_addon_version();
    match result.as_deref() {
        Some(version) => emit_log(&app, &format!("Addon version detected ({version})")),
        None => emit_log(&app, "Addon version not found"),
    }
    result
}

// Parse the addon version from the PvP_Scalpel.toc file.
fn read_addon_version() -> Option<String> {
    let addons_root = read_wow_path()?;
    let toc_path = Path::new(&addons_root).join("PvP_Scalpel").join("PvP_Scalpel.toc");
    let contents = match fs::read_to_string(&toc_path) {
        Ok(contents) => contents,
        Err(err) => {
            eprintln!("Addon version lookup failed: unable to read {:?}", toc_path);
            eprintln!("Addon version lookup failed: {err}");
            return None;
        }
    };

    for line in contents.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("## Version:") {
            let version = rest.trim();
            if !version.is_empty() {
                return Some(version.to_string());
            }
        }
    }

    eprintln!("Addon version lookup failed: missing '## Version:' in {:?}", toc_path);
    None
}

const API_BASE: &str = "https://api.pvpscalpel.com";

// Fetch a JSON payload from the API with the required header.
async fn api_get_json(path: &str) -> Result<Value, String> {
    let url = format!("{}{}", API_BASE, path);
    let client = Client::new();
    let response = client
        .get(url)
        .header("600", "BasicPass")
        .send()
        .await
        .map_err(|err| format!("Manifest request failed: {err}"))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("Manifest request failed: HTTP {status}"));
    }

    response
        .json::<Value>()
        .await
        .map_err(|err| format!("Manifest parse failed: {err}"))
}

// Single-flight manifest fetch to avoid parallel downloads.
async fn load_manifest() -> Result<(Value, bool), String> {
    let cache = MANIFEST_CACHE.get_or_init(|| Mutex::new(ManifestCache::new()));

    loop {
        let mut guard = cache.lock().await;
        if let Some(value) = guard.value.clone() {
            return Ok((value, true));
        }

        if guard.fetching {
            let notify = guard.notify.clone();
            drop(guard);
            notify.notified().await;
            continue;
        }

        guard.fetching = true;
        drop(guard);

        let fetched = api_get_json("/CDN/manifest").await;

        let mut guard = cache.lock().await;
        guard.fetching = false;
        match fetched {
            Ok(value) => {
                guard.value = Some(value.clone());
                guard.notify.notify_waiters();
                return Ok((value, false));
            }
            Err(err) => {
                guard.notify.notify_waiters();
                return Err(err);
            }
        }
    }
}

#[tauri::command]
pub async fn get_manifest(app: AppHandle) -> Result<Value, String> {
    let (manifest, cache_hit) = load_manifest().await?;
    if cache_hit {
        emit_log(&app, "Manifest loaded (cache)");
    } else {
        emit_log(&app, "Manifest fetched");
    }
    Ok(manifest)
}

#[tauri::command]
// Cancel a single in-progress action; checked during download/install/verify.
pub fn cancel_action() {
    ACTION_CANCELLED.store(true, Ordering::SeqCst);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherSnapshot {
    pub wow_path: Option<String>,
    pub desktop_path: Option<String>,
    pub desktop_version: Option<String>,
    pub addon_version: Option<String>,
    pub desktop_target: Option<String>,
    pub addon_target: Option<String>,
}

// Emit a structured comparison result for each component.
fn log_version_compare(app: &AppHandle, label: &str, local: Option<&str>, target: Option<&str>) -> Option<bool> {
    match (local, target) {
        (Some(local), Some(target)) => {
            if local == target {
                emit_log(app, &format!("{label} version OK ({local})"));
                Some(true)
            } else {
                emit_log(app, &format!("{label} mismatch (local {local}, target {target})"));
                Some(false)
            }
        }
        _ => {
            emit_log(app, &format!("{label} version check skipped"));
            None
        }
    }
}

fn manifest_entry_version(manifest: &Value, key: &str) -> Option<String> {
    manifest
        .get(key)
        .and_then(|entry| entry.get("version"))
        .and_then(|version| version.as_str())
        .map(|value| value.to_string())
}

// Run NSIS installer silently and return exit code.
async fn run_nsis_installer(path: PathBuf) -> Result<i32, String> {
    tokio::task::spawn_blocking(move || {
        let mut cmd = Command::new(&path);
        cmd.arg("/S");
        #[cfg(windows)]
        {
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let status = cmd.status().map_err(|err| format!("Installer failed to start: {err}"))?;
        Ok(status.code().unwrap_or(-1))
    })
    .await
    .map_err(|err| format!("Installer task failed: {err}"))?
}

// Extract addon archive, normalize layout, and replace the target addon folder.
async fn install_addon_from_zip(app: &AppHandle, zip_path: &Path) -> Result<(), String> {
    let tmp = temp_dir(app)?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("Time error: {err}"))?
        .as_millis();
    let extract_dir = tmp.join(format!("addon_extract_{stamp}"));
    if extract_dir.exists() {
        fs::remove_dir_all(&extract_dir).map_err(|err| format!("Temp cleanup failed: {err}"))?;
    }
    fs::create_dir_all(&extract_dir).map_err(|err| format!("Temp extract dir failed: {err}"))?;

    let zip_path = zip_path.to_path_buf();
    let extract_dir_clone = extract_dir.clone();
    tokio::task::spawn_blocking(move || extract_zip_secure(&zip_path, &extract_dir_clone))
        .await
        .map_err(|err| format!("Zip task failed: {err}"))??;

    let addon_folder = extract_dir.join("PvP_Scalpel");
    let toc_path = addon_folder.join("PvP_Scalpel.toc");
    if !toc_path.is_file() {
        let root_toc = extract_dir.join("PvP_Scalpel.toc");
        if root_toc.is_file() {
            if !addon_folder.exists() {
                fs::create_dir_all(&addon_folder)
                    .map_err(|err| format!("Addon dir create failed: {err}"))?;
            }
            for entry in fs::read_dir(&extract_dir)
                .map_err(|err| format!("Addon dir read failed: {err}"))?
            {
                let entry = entry.map_err(|err| format!("Addon dir entry failed: {err}"))?;
                let path = entry.path();
                if path == addon_folder {
                    continue;
                }
                let name = entry.file_name();
                let dest = addon_folder.join(name);
                if dest.exists() {
                    if dest.is_dir() {
                        fs::remove_dir_all(&dest).map_err(|err| format!("Addon overwrite failed: {err}"))?;
                    } else {
                        fs::remove_file(&dest).map_err(|err| format!("Addon overwrite failed: {err}"))?;
                    }
                }
                fs::rename(&path, &dest).map_err(|err| format!("Addon move failed: {err}"))?;
            }
        }
    }

    let toc_path = addon_folder.join("PvP_Scalpel.toc");
    if !toc_path.is_file() {
        return Err("Addon archive missing PvP_Scalpel.toc".to_string());
    }

    let addons_root = read_wow_path().ok_or_else(|| "WoW AddOns path not found".to_string())?;
    let addons_root_path = Path::new(&addons_root);
    let target_dir = addons_root_path.join("PvP_Scalpel");
    let legacy_backup = addons_root_path.join("PvP_Scalpel.bak");
    if legacy_backup.exists() {
        fs::remove_dir_all(&legacy_backup).map_err(|err| format!("Backup cleanup failed: {err}"))?;
    }
    let legacy_zip = addons_root_path.join("PvP_Scalpel.zip");
    if legacy_zip.is_file() {
        fs::remove_file(&legacy_zip).map_err(|err| format!("Zip cleanup failed: {err}"))?;
    }
    replace_dir_atomic(&addon_folder, &target_dir)?;

    if extract_dir.exists() {
        let _ = fs::remove_dir_all(&extract_dir);
    }
    Ok(())
}

// Re-read versions after install/update to confirm success.
fn verify_after_action(app: &AppHandle, manifest: &Value, action: &str) -> Result<(), String> {
    let desktop_version = read_desktop_version();
    let addon_version = read_addon_version();
    let desktop_target = manifest_entry_version(manifest, "desktop");
    let addon_target = manifest_entry_version(manifest, "addon");

    let desktop_ok = log_version_compare(
        app,
        "Desktop",
        desktop_version.as_deref(),
        desktop_target.as_deref(),
    );
    let addon_ok = log_version_compare(
        app,
        "Addon",
        addon_version.as_deref(),
        addon_target.as_deref(),
    );

    match action {
        "INSTALL_DESKTOP" | "UPDATE_DESKTOP" => {
            if desktop_ok == Some(true) {
                Ok(())
            } else {
                Err("Desktop verification failed".to_string())
            }
        }
        "INSTALL_ADDON" | "UPDATE_ADDON" => {
            if addon_ok == Some(true) {
                Ok(())
            } else {
                Err("Addon verification failed".to_string())
            }
        }
        _ => Err("Unsupported action".to_string()),
    }
}

#[tauri::command]
// End-to-end action phase: request URL -> download -> install -> verify.
pub async fn perform_action(app: AppHandle, action: String) -> Result<ActionResult, String> {
    ACTION_CANCELLED.store(false, Ordering::SeqCst);
    emit_action_progress(&app, "REQUEST_URL", None, "Requesting download URL", "Requesting download URL");

    let manifest = match load_manifest().await {
        Ok((manifest, cache_hit)) => {
            if cache_hit {
                emit_log(&app, "Manifest loaded (cache)");
            } else {
                emit_log(&app, "Manifest fetched");
            }
            manifest
        }
        Err(err) => {
            emit_log(&app, &format!("Manifest load failed: {err}"));
            return Ok(ActionResult {
                ok: false,
                error_code: Some("MANIFEST_FAILED".to_string()),
                error_message: Some(err),
            });
        }
    };

    let manifest_key = match action.as_str() {
        "INSTALL_DESKTOP" | "UPDATE_DESKTOP" => "desktop",
        "INSTALL_ADDON" | "UPDATE_ADDON" => "addon",
        _ => {
            return Ok(ActionResult {
                ok: false,
                error_code: Some("INVALID_ACTION".to_string()),
                error_message: Some("Unsupported action".to_string()),
            })
        }
    };

    if let Err(_) = ensure_not_cancelled() {
        return Ok(ActionResult {
            ok: false,
            error_code: Some("CANCELLED".to_string()),
            error_message: Some("Action cancelled".to_string()),
        });
    }
    let download_url = match request_download_url(manifest_key).await {
        Ok(url) => url,
        Err(err) => {
            emit_log(&app, &format!("Download URL failed: {err}"));
            return Ok(ActionResult {
                ok: false,
                error_code: Some("URL_FAILED".to_string()),
                error_message: Some(err),
            });
        }
    };

    let url = match validate_https_url(&download_url) {
        Ok(url) => url,
        Err(err) => {
            emit_log(&app, &format!("Download URL invalid: {err}"));
            return Ok(ActionResult {
                ok: false,
                error_code: Some("URL_INVALID".to_string()),
                error_message: Some(err),
            });
        }
    };

    let filename = url
        .path_segments()
        .and_then(|segments| segments.last())
        .filter(|name| !name.is_empty())
        .unwrap_or("download.bin");
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("Time error: {err}"))?
        .as_millis();
    let tmp = temp_dir(&app)?;
    let download_path = tmp.join(format!("{stamp}_{filename}"));

    emit_action_progress(&app, "DOWNLOADING", Some(0), "Downloading", "Download started");
    if let Err(err) = download_with_progress(&app, &url, &download_path).await {
        emit_log(&app, &format!("Download failed: {err}"));
        return Ok(ActionResult {
            ok: false,
            error_code: Some(if err == "CANCELLED" { "CANCELLED" } else { "DOWNLOAD_FAILED" }.to_string()),
            error_message: Some(err),
        });
    }

    if let Err(_) = ensure_not_cancelled() {
        return Ok(ActionResult {
            ok: false,
            error_code: Some("CANCELLED".to_string()),
            error_message: Some("Action cancelled".to_string()),
        });
    }
    emit_action_progress(&app, "INSTALLING", None, "Installing", "Install started");
    let install_result = match action.as_str() {
        "INSTALL_DESKTOP" | "UPDATE_DESKTOP" => match run_nsis_installer(download_path.clone()).await {
            Ok(exit_code) => {
                if exit_code == 0 {
                    Ok(())
                } else {
                    Err(format!("Installer exit code: {exit_code}"))
                }
            }
            Err(err) => Err(err),
        },
        "INSTALL_ADDON" | "UPDATE_ADDON" => install_addon_from_zip(&app, &download_path).await,
        _ => Err("Unsupported action".to_string()),
    };

    if let Err(err) = install_result {
        emit_log(&app, &format!("Install failed: {err}"));
        return Ok(ActionResult {
            ok: false,
            error_code: Some("INSTALL_FAILED".to_string()),
            error_message: Some(err),
        });
    }

    if matches!(action.as_str(), "INSTALL_ADDON" | "UPDATE_ADDON") && is_wow_running() {
        emit_log(&app, "WoW running: addon installed, reload required");
        emit_addon_reload_notice(&app);
    }

    if let Err(_) = ensure_not_cancelled() {
        return Ok(ActionResult {
            ok: false,
            error_code: Some("CANCELLED".to_string()),
            error_message: Some("Action cancelled".to_string()),
        });
    }

    emit_action_progress(&app, "VERIFYING", None, "Verifying", "Verification started");
    if let Err(err) = verify_after_action(&app, &manifest, &action) {
        emit_log(&app, &format!("Verification failed: {err}"));
        return Ok(ActionResult {
            ok: false,
            error_code: Some("VERIFY_FAILED".to_string()),
            error_message: Some(err),
        });
    }

    emit_log(&app, "Verification complete");
    let _ = fs::remove_file(&download_path);
    Ok(ActionResult {
        ok: true,
        error_code: None,
        error_message: None,
    })
}

#[tauri::command]
// Full detection + comparison workflow used by the frontend.
pub async fn get_launcher_snapshot(app: AppHandle) -> Result<LauncherSnapshot, String> {
    emit_log(&app, "Launcher initialized");

    let wow_path = read_wow_path();
    match wow_path.as_deref() {
        Some(path) => emit_log(&app, &format!("WoW path detected ({path})")),
        None => emit_log(&app, "WoW path not found"),
    }

    let desktop_path = read_desktop_path();
    match desktop_path.as_deref() {
        Some(path) => emit_log(&app, &format!("Desktop path detected ({path})")),
        None => emit_log(&app, "Desktop path not found"),
    }

    let desktop_version = read_desktop_version();
    match desktop_version.as_deref() {
        Some(version) => emit_log(&app, &format!("Desktop version detected ({version})")),
        None => emit_log(&app, "Desktop version not found"),
    }

    let addon_version = read_addon_version();
    match addon_version.as_deref() {
        Some(version) => emit_log(&app, &format!("Addon version detected ({version})")),
        None => emit_log(&app, "Addon version not found"),
    }

    let manifest = match load_manifest().await {
        Ok((manifest, cache_hit)) => {
            if cache_hit {
                emit_log(&app, "Manifest loaded (cache)");
            } else {
                emit_log(&app, "Manifest fetched");
            }
            Some(manifest)
        }
        Err(err) => {
            emit_log(&app, &format!("Manifest load failed: {err}"));
            None
        }
    };

    let desktop_target = manifest
        .as_ref()
        .and_then(|manifest| manifest.get("desktop"))
        .and_then(|desktop| desktop.get("version"))
        .and_then(|version| version.as_str())
        .map(|value| value.to_string());

    let addon_target = manifest
        .as_ref()
        .and_then(|manifest| manifest.get("addon"))
        .and_then(|addon| addon.get("version"))
        .and_then(|version| version.as_str())
        .map(|value| value.to_string());

    let desktop_ok = log_version_compare(
        &app,
        "Desktop",
        desktop_version.as_deref(),
        desktop_target.as_deref(),
    );
    let addon_ok = log_version_compare(
        &app,
        "Addon",
        addon_version.as_deref(),
        addon_target.as_deref(),
    );

    match (desktop_ok, addon_ok, manifest.is_some()) {
        (Some(true), Some(true), true) => emit_log(&app, "Outcome: versions match, launch ready"),
        (Some(false), _, _) | (_, Some(false), _) => emit_log(&app, "Outcome: update required"),
        _ => emit_log(&app, "Outcome: version check incomplete"),
    }

    Ok(LauncherSnapshot {
        wow_path,
        desktop_path,
        desktop_version,
        addon_version,
        desktop_target,
        addon_target,
    })
}
