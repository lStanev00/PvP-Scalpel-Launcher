use std::path::{Path, PathBuf};
use std::process::Command;

use registry::{Data, Hive, Security};
use std::fs;
use reqwest::Client;
use serde_json::Value;

#[tauri::command]
pub fn get_wow_path() -> Option<String> {
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
pub fn get_desktop_path() -> Option<String> {
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
pub fn get_desktop_version() -> Option<String> {
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
pub fn launch_desktop_app() -> Result<(), String> {
    let exe = find_desktop_exe().ok_or_else(|| "Desktop app not found".to_string())?;
    Command::new(&exe)
        .spawn()
        .map_err(|err| format!("Failed to launch desktop app: {err}"))?;
    Ok(())
}

#[tauri::command]
pub fn get_addon_version() -> Option<String> {
    let addons_root = get_wow_path()?;
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

#[tauri::command]
pub async fn get_manifest() -> Result<Value, String> {
    let manifest = api_get_json("/CDN/getManifest").await?;
    println!("Manifest: {manifest}");
    Ok(manifest)
}



