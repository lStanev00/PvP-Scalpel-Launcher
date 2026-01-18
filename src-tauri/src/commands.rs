use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, OnceLock};

use registry::{Data, Hive, Security};
use std::fs;
use reqwest::Client;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, Notify};

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

fn emit_log(app: &AppHandle, message: &str) {
    let _ = app.emit_to("main", "launcher-log", message.to_string());
}

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

#[tauri::command]
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



