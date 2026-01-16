mod commands;

use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle,
    Emitter,
    Manager,
    Runtime,
    State,
};

#[tauri::command]
fn exit_app(app: AppHandle) {
    app.exit(0);
}

struct TrayMenuState<R: Runtime> {
    can_launch: Mutex<bool>,
    launch: MenuItem<R>,
    status: MenuItem<R>,
}

#[tauri::command]
fn update_tray_state(
    state: State<TrayMenuState<tauri::Wry>>,
    can_launch: bool,
    status_text: String,
) -> Result<(), String> {
    if let Ok(mut stored) = state.can_launch.lock() {
        *stored = can_launch;
    }
    state
        .launch
        .set_enabled(can_launch)
        .map_err(|e| e.to_string())?;
    state
        .status
        .set_text(format!("Status: {}", status_text))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.center();
                let _ = window.set_shadow(false);
            }
            tauri::async_runtime::spawn(async {
                if let Err(err) = commands::get_manifest().await {
                    eprintln!("Manifest fetch failed: {err}");
                }
            });
            let launch = MenuItem::with_id(app, "launch", "Launch PvP Scalpel", false, None::<&str>)?;
            let status = MenuItem::with_id(app, "status", "Status: Checking", false, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "Show Launcher", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "Hide Launcher", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&launch, &status, &sep1, &show, &hide, &sep2, &quit])?;
            let icon = app.default_window_icon().cloned();
            app.manage(TrayMenuState {
                can_launch: Mutex::new(false),
                launch: launch.clone(),
                status: status.clone(),
            });

            let mut tray_builder = TrayIconBuilder::with_id("main")
                .menu(&menu)
                .show_menu_on_left_click(true);
            if let Some(icon) = icon {
                tray_builder = tray_builder.icon(icon);
            }

            tray_builder
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "launch" => {
                        let can_launch = app
                            .state::<TrayMenuState<tauri::Wry>>()
                            .can_launch
                            .lock()
                            .map(|v| *v)
                            .unwrap_or(false);
                        if !can_launch {
                            return;
                        }
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                        let _ = app.emit_to("main", "tray-launch", ());
                    }
                    "show" => {
                        let _ = app.emit_to("main", "tray-show", ());
                    }
                    "hide" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.set_skip_taskbar(true);
                            let _ = window.hide();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::DoubleClick { .. } = event {
                        let app = tray.app_handle();
                        let _ = app.emit_to("main", "tray-show", ());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            exit_app,
            update_tray_state,
            commands::get_wow_path,
            commands::get_desktop_path,
            commands::get_desktop_version,
            commands::get_addon_version,
            commands::launch_desktop_app,
            commands::get_manifest
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}




