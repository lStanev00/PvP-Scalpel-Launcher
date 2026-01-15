use std::path::Path;

use registry::{Data, Hive, Security};
use std::fs;

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
