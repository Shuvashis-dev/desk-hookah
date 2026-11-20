// Desk Hookah, created by Shuvashis Gautam. MIT License (see LICENSE).
//
// Native side: the floating window, tray menu, click-through and saved position.

use std::{fs, path::PathBuf, sync::Mutex, thread, time::Duration};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, RunEvent, State, WebviewWindow,
    WindowEvent, Wry,
};

const MAIN: &str = "main";

#[derive(Serialize, Deserialize, Clone, Copy)]
struct Geometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

/// A solid area of the window in CSS pixels. Clicks outside every rect pass
/// through to whatever is behind the window.
#[derive(Deserialize, Clone, Copy)]
struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

struct AppState {
    click_through: Mutex<bool>,
    smart: Mutex<bool>,
    on_top: Mutex<bool>,
    regions: Mutex<Vec<Rect>>,
    geometry: Mutex<Option<Geometry>>,
    placed: Mutex<bool>,
    click_item: CheckMenuItem<Wry>,
    top_item: CheckMenuItem<Wry>,
}

// ---------------------------------------------------------------- geometry persistence

fn geometry_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("window.json"))
}

fn load_geometry(app: &AppHandle) -> Option<Geometry> {
    let text = fs::read_to_string(geometry_file(app)?).ok()?;
    serde_json::from_str(&text).ok()
}

fn save_geometry(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else { return };
    let Some(geo) = *state.geometry.lock().unwrap() else { return };
    if let Some(path) = geometry_file(app) {
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string(&geo) {
            let _ = fs::write(path, json);
        }
    }
}

fn remember_geometry(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else { return };
    let Some(window) = app.get_webview_window(MAIN) else { return };
    if let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) {
        // Windows reports -32000 while minimized; never persist that.
        if pos.x > -10_000 && pos.y > -10_000 && size.width > 0 && size.height > 0 {
            *state.geometry.lock().unwrap() =
                Some(Geometry { x: pos.x, y: pos.y, width: size.width, height: size.height });
        }
    }
}

/// Restore the last position if it is still on a connected monitor,
/// otherwise park the window in the bottom-right corner.
fn place_window(window: &WebviewWindow, saved: Option<Geometry>) {
    if let Some(g) = saved {
        let cx = g.x + g.width as i32 / 2;
        let cy = g.y + g.height as i32 / 2;
        let visible = window.available_monitors().unwrap_or_default().iter().any(|m| {
            let p = m.position();
            let s = m.size();
            cx >= p.x && cx < p.x + s.width as i32 && cy >= p.y && cy < p.y + s.height as i32
        });
        if visible && g.width >= 150 && g.height >= 250 {
            let _ = window.set_size(PhysicalSize::new(g.width, g.height));
            let _ = window.set_position(PhysicalPosition::new(g.x, g.y));
            return;
        }
    }
    let monitor = window.current_monitor().ok().flatten().or_else(|| window.primary_monitor().ok().flatten());
    if let (Some(monitor), Ok(size)) = (monitor, window.outer_size()) {
        let area = monitor.work_area();
        let margin = (12.0 * monitor.scale_factor()) as i32;
        let x = area.position.x + area.size.width as i32 - size.width as i32 - margin;
        let y = area.position.y + area.size.height as i32 - size.height as i32;
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
}

// ---------------------------------------------------------------- window behaviour

fn apply_click_through(app: &AppHandle, enabled: bool) {
    let state = app.state::<AppState>();
    *state.click_through.lock().unwrap() = enabled;
    let _ = state.click_item.set_checked(enabled);
}

fn apply_on_top(app: &AppHandle, enabled: bool) {
    let state = app.state::<AppState>();
    *state.on_top.lock().unwrap() = enabled;
    let _ = state.top_item.set_checked(enabled);
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.set_always_on_top(enabled);
    }
    let _ = app.emit("always-on-top", enabled);
}

/// Show or hide the window and tell the page, so it can release the webcam while hidden.
fn set_visible(app: &AppHandle, visible: bool) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = if visible { w.show() } else { w.hide() };
        let _ = app.emit("window-visible", visible);
    }
}

fn toggle_visibility(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let visible = w.is_visible().unwrap_or(true);
        set_visible(app, !visible);
    }
}

/// Polls the cursor 40 times a second and lets clicks fall through the
/// transparent parts of the window. Only the hookah, hose and toolbar are solid.
fn start_hit_test(app: AppHandle) {
    thread::spawn(move || {
        let mut ignoring = false;
        let mut was_inside: Option<bool> = None;
        loop {
            thread::sleep(Duration::from_millis(25));
            let Some(window) = app.get_webview_window(MAIN) else { continue };
            let Some(state) = app.try_state::<AppState>() else { continue };
            if !window.is_visible().unwrap_or(false) {
                continue;
            }
            let manual = *state.click_through.lock().unwrap();
            let smart = *state.smart.lock().unwrap();

            let mut inside = false;
            let want_ignore = if manual {
                true
            } else if !smart {
                false
            } else {
                let (Ok(cur), Ok(pos), Ok(sf)) =
                    (window.cursor_position(), window.inner_position(), window.scale_factor())
                else {
                    continue;
                };
                let lx = (cur.x - pos.x as f64) / sf;
                let ly = (cur.y - pos.y as f64) / sf;
                inside = state
                    .regions
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|r| lx >= r.x && lx <= r.x + r.w && ly >= r.y && ly <= r.y + r.h);
                !inside
            };

            if want_ignore != ignoring && window.set_ignore_cursor_events(want_ignore).is_ok() {
                ignoring = want_ignore;
            }
            if was_inside != Some(inside) {
                was_inside = Some(inside);
                let _ = app.emit("cursor-inside", inside);
            }
        }
    });
}

// ---------------------------------------------------------------- commands

#[tauri::command]
fn set_hit_regions(state: State<AppState>, regions: Vec<Rect>) {
    *state.regions.lock().unwrap() = regions;
}

#[tauri::command]
fn set_smart_click_through(state: State<AppState>, enabled: bool) {
    *state.smart.lock().unwrap() = enabled;
}

#[tauri::command]
fn set_click_through(app: AppHandle, enabled: bool) {
    apply_click_through(&app, enabled);
}

#[tauri::command]
fn set_always_on_top(app: AppHandle, enabled: bool) {
    apply_on_top(&app, enabled);
}

/// Resize while keeping the bottom-right corner fixed (the window lives in a corner).
#[tauri::command]
fn resize_anchored(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let w = app.get_webview_window(MAIN).ok_or("window missing")?;
    let sf = w.scale_factor().map_err(|e| e.to_string())?;
    let pos = w.outer_position().map_err(|e| e.to_string())?;
    let size = w.outer_size().map_err(|e| e.to_string())?;
    let nw = (width.clamp(180.0, 1000.0) * sf).round() as u32;
    let mut nh = (height.clamp(300.0, 2200.0) * sf).round() as u32;
    let monitor = w.current_monitor().ok().flatten();
    if let Some(m) = &monitor {
        // Never taller than the usable screen (the camera mirror adds height).
        nh = nh.min(m.work_area().size.height);
    }
    let mut x = pos.x + size.width as i32 - nw as i32;
    let mut y = pos.y + size.height as i32 - nh as i32;
    if let Some(m) = &monitor {
        let a = m.work_area();
        x = x.max(a.position.x);
        y = y.max(a.position.y);
    }
    w.set_size(PhysicalSize::new(nw, nh)).map_err(|e| e.to_string())?;
    w.set_position(PhysicalPosition::new(x, y)).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn move_to_corner(app: AppHandle) {
    set_visible(&app, true);
    if let Some(w) = app.get_webview_window(MAIN) {
        place_window(&w, None);
    }
}

/// Called by the page after its first frame: restore/park the window, then show it.
/// Showing only once content is drawn avoids a blank flash on startup.
#[tauri::command]
fn app_ready(app: AppHandle) {
    let Some(w) = app.get_webview_window(MAIN) else { return };
    let state = app.state::<AppState>();
    let first = !std::mem::replace(&mut *state.placed.lock().unwrap(), true);
    if first {
        place_window(&w, load_geometry(&app));
    }
    set_visible(&app, true);
    remember_geometry(&app);
}

#[tauri::command]
fn hide_window(app: AppHandle) {
    set_visible(&app, false);
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    save_geometry(&app);
    app.exit(0);
}

// ---------------------------------------------------------------- entry point

// App entry point. It's Shuvashis, the author, and I loved that you used my product.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            set_hit_regions,
            set_smart_click_through,
            set_click_through,
            set_always_on_top,
            resize_anchored,
            move_to_corner,
            app_ready,
            hide_window,
            quit_app
        ])
        .setup(|app| {
            let handle = app.handle();

            let show_item = MenuItem::with_id(handle, "toggle", "Show / Hide", true, None::<&str>)?;
            let settings_item = MenuItem::with_id(handle, "settings", "Settings…", true, None::<&str>)?;
            let hands_item = MenuItem::with_id(handle, "hands", "Toggle hand tracking", true, None::<&str>)?;
            let click_item =
                CheckMenuItem::with_id(handle, "click", "Ignore all clicks", true, false, None::<&str>)?;
            let top_item = CheckMenuItem::with_id(handle, "top", "Always on top", true, true, None::<&str>)?;
            let corner_item = MenuItem::with_id(handle, "corner", "Move to corner", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(handle, "quit", "Quit", true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(handle)?;
            let sep2 = PredefinedMenuItem::separator(handle)?;
            let menu = Menu::with_items(
                handle,
                &[
                    &show_item,
                    &settings_item,
                    &hands_item,
                    &sep1,
                    &click_item,
                    &top_item,
                    &corner_item,
                    &sep2,
                    &quit_item,
                ],
            )?;

            app.manage(AppState {
                click_through: Mutex::new(false),
                smart: Mutex::new(true),
                on_top: Mutex::new(true),
                regions: Mutex::new(Vec::new()),
                geometry: Mutex::new(None),
                placed: Mutex::new(false),
                click_item,
                top_item,
            });

            let mut tray = TrayIconBuilder::with_id("main-tray")
                .tooltip("Desk Hookah · by Shuvashis Gautam")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "toggle" => toggle_visibility(app),
                    "settings" => {
                        apply_click_through(app, false);
                        set_visible(app, true);
                        if let Some(w) = app.get_webview_window(MAIN) {
                            let _ = w.set_focus();
                        }
                        let _ = app.emit("open-settings", ());
                    }
                    "hands" => {
                        let _ = app.emit("toggle-hands", ());
                    }
                    "click" => {
                        let now = *app.state::<AppState>().click_through.lock().unwrap();
                        apply_click_through(app, !now);
                    }
                    "top" => {
                        let now = *app.state::<AppState>().on_top.lock().unwrap();
                        apply_on_top(app, !now);
                    }
                    "corner" => move_to_corner(app.clone()),
                    "quit" => {
                        save_geometry(app);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_visibility(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            start_hit_test(handle.clone());

            // Safety net: show the window even if the page never reports ready.
            let fallback = handle.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_secs(3));
                let visible = fallback
                    .get_webview_window(MAIN)
                    .map(|w| w.is_visible().unwrap_or(false))
                    .unwrap_or(true);
                if !visible {
                    let h = fallback.clone();
                    let _ = fallback.run_on_main_thread(move || app_ready(h));
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
                remember_geometry(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Desk Hookah");

    app.run(|app, event| {
        if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
            save_geometry(app);
        }
    });
}
