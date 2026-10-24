use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, path::PathBuf, sync::Mutex};
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_dialog::DialogExt;

mod window_placement;
mod calendar_data;
mod day_window_handoff;
use window_placement::{place_adjacent, Placement, Rect, Side, Size};

const MAIN_WINDOW_LABEL: &str = "main";
const MONTH_WINDOW_LABEL: &str = "month-view";
const SETTINGS_WINDOW_LABEL: &str = "settings";
const DAY_WINDOW_PREFIX: &str = "day-";
const SHOW_TODAY_MENU_ID: &str = "show_today";
const QUIT_MENU_ID: &str = "quit";
const DATA_DIR_NAME: &str = "calendar-data";
const STORAGE_SETTINGS_FILE_NAME: &str = "storage-settings.json";
const WINDOW_GAP: f64 = 12.0;

struct PlannedWindow {
    placement: Placement,
    logical_width: f64,
    logical_height: f64,
}

#[derive(Default)]
struct DayWindowDates(Mutex<HashMap<String, String>>);

#[derive(Default)]
struct DayWindowOperation(tauri::async_runtime::Mutex<()>);

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsNavigation {
    tab: Option<String>,
    revision: u64,
}

// The same lock serializes creation and records requests received before JS is ready.
#[derive(Default)]
struct SettingsWindowState(Mutex<SettingsNavigation>);

#[derive(Default)]
struct CalendarNavigation(Mutex<(u64, HashMap<String, serde_json::Value>)>);

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DayData {
    date: String,
    #[serde(default)]
    note: String,
    #[serde(default)]
    tasks: Vec<serde_json::Value>,
    updated_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TagTemplates {
    version: u16,
    groups: Vec<serde_json::Value>,
    updated_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LongTasks {
    version: u16,
    #[serde(default)]
    tasks: Vec<serde_json::Value>,
    updated_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StorageSettings {
    data_dir: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageLocation {
    is_default: bool,
    path: Option<String>,
    effective_path: String,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(DayWindowDates::default())
        .manage(DayWindowOperation::default())
        .manage(day_window_handoff::DayWindowHandoffs::default())
        .manage(calendar_data::CalendarDataLock::default())
        .manage(SettingsWindowState::default())
        .manage(CalendarNavigation::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            load_day,
            calendar_data::load_reminder_state,
            calendar_data::read_calendar_days,
            calendar_data::commit_reminder_plan,
            save_day,
            load_tag_templates,
            save_tag_templates,
            load_long_tasks,
            save_long_tasks,
            load_storage_location,
            set_storage_location,
            reset_storage_location,
            pick_data_directory,
            open_tag_manager_window,
            open_month_window,
            open_settings_window,
            get_settings_navigation,
            get_calendar_navigation,
            open_day_window,
            claim_day_window_date,
            complete_day_window_handoff,
            exit_app
        ])
        .setup(|app| {
            let menu = MenuBuilder::new(app)
                .text(SHOW_TODAY_MENU_ID, "打开今日日程")
                .separator()
                .text(QUIT_MENU_ID, "退出日枝")
                .build()?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("日枝 · FloraGrid")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| match event {
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                    | TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    } => show_main_window(tray.app_handle()),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            SHOW_TODAY_MENU_ID => show_main_window(app),
            QUIT_MENU_ID => request_frontend_exit(app),
            _ => {}
        })
        .on_window_event(|window, event| {
            if window.label() != MAIN_WINDOW_LABEL {
                return;
            }

            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        // The original main window can have handed its date to another window.
        let _ = window.emit("calendar://show-today-requested", ());
    }
}

fn request_frontend_exit(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.emit("calendar://exit-requested", ());
    } else {
        app.exit(0);
    }
}

#[tauri::command]
async fn open_tag_manager_window(
    app: tauri::AppHandle,
    caller: tauri::WebviewWindow,
) -> Result<(), String> {
    open_settings_window_inner(&app, &caller, Some("tags".into()))
}

#[tauri::command]
async fn open_month_window(
    app: tauri::AppHandle,
    caller: tauri::WebviewWindow,
    panel: Option<String>,
    rule_id: Option<String>,
) -> Result<(), String> {
    let intent = panel.map(|panel| serde_json::json!({"panel":panel,"ruleId":rule_id}));
    if let Some(window) = app.get_webview_window(MONTH_WINDOW_LABEL) {
        if let Some(ref intent) = intent { post_calendar_navigation(&app, MONTH_WINDOW_LABEL, intent.clone())?; }
        window.show().map_err(|error| error.to_string())?;
        window.unminimize().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let plan = plan_window(&caller, (1180.0, 820.0), (900.0, 640.0), None, 0);
    let (width, height) = planned_size(&plan, (1180.0, 820.0));
    let window = WebviewWindowBuilder::new(
        &app,
        MONTH_WINDOW_LABEL,
        WebviewUrl::App("index.html#month".into()),
    )
    .title("日枝 · 月视图")
    .inner_size(width, height)
    .min_inner_size(900.0, 640.0)
    .transparent(true)
    .decorations(false)
    .resizable(true)
    .maximizable(false)
    .visible(false)
    .build()
    .map_err(|error| format!("Failed to open month window: {}", error))?;

    if let Some(intent) = intent { post_calendar_navigation(&app, MONTH_WINDOW_LABEL, intent)?; }
    show_new_window(&window, plan)
}

#[tauri::command]
async fn open_settings_window(
    app: tauri::AppHandle,
    caller: tauri::WebviewWindow,
    tab: Option<String>,
) -> Result<(), String> {
    open_settings_window_inner(&app, &caller, tab)
}

#[tauri::command]
async fn get_settings_navigation(
    state: tauri::State<'_, SettingsWindowState>,
) -> Result<SettingsNavigation, String> {
    state.0.lock().map(|navigation| navigation.clone())
        .map_err(|error| error.to_string())
}

fn open_settings_window_inner(
    app: &tauri::AppHandle,
    caller: &tauri::WebviewWindow,
    tab: Option<String>,
) -> Result<(), String> {
    if let Some(value) = tab.as_deref() {
        if !matches!(value, "theme" | "data" | "tags") {
            return Err("Unknown settings tab".into());
        }
    }
    let state = app.state::<SettingsWindowState>();
    let mut navigation = state.0.lock().map_err(|error| error.to_string())?;
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        let request = if tab.is_some() {
            navigation.tab = tab;
            navigation.revision += 1;
            Some(navigation.clone())
        } else {
            None
        };
        drop(navigation);
        if let Some(request) = request {
            window.emit("calendar://settings-navigate", request)
                .map_err(|error| error.to_string())?;
        }
        window.show().map_err(|error| error.to_string())?;
        window.unminimize().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    navigation.tab = tab;
    navigation.revision += 1;
    let route = match navigation.tab.as_deref() {
        Some(tab) => format!("index.html#settings?tab={tab}"),
        None => "index.html#settings".into(),
    };
    let plan = plan_window(caller, (780.0, 560.0), (560.0, 420.0), None, 0);
    let (width, height) = planned_size(&plan, (780.0, 560.0));
    let window = WebviewWindowBuilder::new(
        app,
        SETTINGS_WINDOW_LABEL,
        WebviewUrl::App(route.into()),
    )
    .title("日枝 · 设置")
    .inner_size(width, height)
    .min_inner_size(560.0, 420.0)
    .transparent(true)
    .decorations(false)
    .resizable(true)
    .maximizable(false)
    .visible(false)
    .build()
    .map_err(|error| format!("Failed to open settings window: {}", error))?;

    drop(navigation);
    show_new_window(&window, plan)
}

#[tauri::command]
async fn open_day_window(
    app: tauri::AppHandle,
    caller: tauri::WebviewWindow,
    date: String,
    task_id: Option<String>,
    note: Option<bool>,
    include_deleted: Option<bool>,
) -> Result<(), String> {
    validate_date(&date)?;
    let operation = app.state::<DayWindowOperation>();
    let _guard = operation.0.lock().await;
    let intent = serde_json::json!({"date":date,"taskId":task_id,"note":note.unwrap_or(false),"includeDeleted":include_deleted.unwrap_or(false)});
    let state = app.state::<DayWindowDates>();
    let mut dates = state.0.lock().map_err(|error| error.to_string())?;
    dates.retain(|label, _| app.get_webview_window(label).is_some());
    if let Some(label) = dates
        .iter()
        .find_map(|(label, current_date)| (current_date == &date).then_some(label.clone()))
    {
        drop(dates);
        post_calendar_navigation(&app, &label, intent)?;
        focus_day_window(&app, &label)?;
        return Ok(());
    }

    let base_label = format!("{}{}", DAY_WINDOW_PREFIX, date);
    let mut label = base_label.clone();
    let mut suffix = 2;
    while app.get_webview_window(&label).is_some() {
        label = format!("{}-{}", base_label, suffix);
        suffix += 1;
    }

    let (preferred_side, cascade_index) = day_window_context(&app, &caller);
    let plan = plan_window(
        &caller,
        (400.0, 820.0),
        (360.0, 520.0),
        preferred_side,
        cascade_index,
    );
    let (width, height) = planned_size(&plan, (400.0, 820.0));
    let window = WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::App(format!("index.html?view=day&date={}", date).into()),
    )
    .title(format!("日枝 · 日视图 {}", date))
    .inner_size(width, height)
    .min_inner_size(360.0, 520.0)
    .transparent(true)
    .decorations(false)
    .resizable(true)
    .maximizable(false)
    .visible(false)
    .build()
    .map_err(|error| format!("Failed to open day window: {}", error))?;

    post_calendar_navigation(&app, &label, intent)?;
    dates.insert(label, date);
    drop(dates);

    show_new_window(&window, plan)
}

#[tauri::command]
async fn claim_day_window_date(window: tauri::WebviewWindow, date: String, take_over: Option<bool>) -> Result<bool, String> {
    validate_date(&date)?;
    let app = window.app_handle();
    let label = window.label().to_string();
    if label != MAIN_WINDOW_LABEL && !label.starts_with(DAY_WINDOW_PREFIX) {
        return Err("Only day windows can claim a date".to_string());
    }

    let operation = app.state::<DayWindowOperation>();
    let _guard = operation.0.lock().await;
    let existing_label = {
        let state = app.state::<DayWindowDates>();
        let mut dates = state.0.lock().map_err(|error| error.to_string())?;
        dates.retain(|label, _| app.get_webview_window(label).is_some());
        dates.iter().find_map(|(other_label, current_date)| {
            (other_label != &label && current_date == &date).then_some(other_label.clone())
        })
    };
    if let Some(ref existing_label) = existing_label {
        if !take_over.unwrap_or(false) {
            focus_day_window(app, existing_label)?;
            return Ok(false);
        }
        if let Some(existing) = app.get_webview_window(existing_label) {
            let request = prepare_day_window_handoff(&existing).await?;
            if app.get_webview_window(&label).is_none() {
                let _ = existing.emit("calendar://day-handoff-cancelled", serde_json::json!({"id":request}));
                return Err("当前日视图已关闭".into());
            }
            if let Err(error) = existing.hide() {
                let _ = existing.emit("calendar://day-handoff-cancelled", serde_json::json!({"id":request}));
                return Err(error.to_string());
            }
            if existing_label != MAIN_WINDOW_LABEL { let _ = existing.close(); }
        }
    }

    let state = app.state::<DayWindowDates>();
    let mut dates = state.0.lock().map_err(|error| error.to_string())?;
    if let Some(existing_label) = existing_label { dates.remove(&existing_label); }
    let title = format!("日枝 · 日视图 {}", date);
    dates.insert(label, date);
    drop(dates);
    let _ = window.set_title(&title);
    Ok(true)
}

async fn prepare_day_window_handoff(window: &tauri::WebviewWindow) -> Result<String, String> {
    let state = window.app_handle().state::<day_window_handoff::DayWindowHandoffs>();
    let (id, receive) = state.begin(window.label())?;
    if let Err(error) = window.emit("calendar://day-handoff-requested", serde_json::json!({"id":id})) {
        state.cancel(&id);
        return Err(error.to_string());
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        receive.recv_timeout(std::time::Duration::from_secs(8))
            .map_err(|_| "另一个日视图未完成保存，请重试".to_string())?
    }).await.map_err(|e| e.to_string()).and_then(|saved| saved);
    state.cancel(&id);
    if result.is_err() { let _ = window.emit("calendar://day-handoff-cancelled", serde_json::json!({"id":id})); }
    result.map(|_| id)
}

#[tauri::command]
async fn complete_day_window_handoff(window: tauri::WebviewWindow, id: String, error: Option<String>) -> Result<(), String> {
    window.app_handle().state::<day_window_handoff::DayWindowHandoffs>().finish(window.label(), &id, error)
}

fn post_calendar_navigation(app: &tauri::AppHandle, label: &str, mut intent: serde_json::Value) -> Result<(), String> {
    let state = app.state::<CalendarNavigation>();
    let mut navigation = state.0.lock().map_err(|e| e.to_string())?;
    navigation.0 += 1;
    intent["revision"] = serde_json::json!(navigation.0);
    navigation.1.insert(label.into(), intent.clone());
    drop(navigation);
    if let Some(window) = app.get_webview_window(label) { window.emit("calendar://navigate", intent).map_err(|e| e.to_string())?; }
    Ok(())
}

#[tauri::command]
async fn get_calendar_navigation(window: tauri::WebviewWindow) -> Result<Option<serde_json::Value>, String> {
    let state = window.app_handle().state::<CalendarNavigation>();
    let navigation = state.0.lock().map_err(|e| e.to_string())?;
    Ok(navigation.1.get(window.label()).cloned())
}

fn focus_day_window(app: &tauri::AppHandle, label: &str) -> Result<(), String> {
    let window = app
        .get_webview_window(label)
        .ok_or_else(|| "Day window no longer exists".to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

fn plan_window(
    caller: &tauri::WebviewWindow,
    preferred_size: (f64, f64),
    minimum_size: (f64, f64),
    preferred_side: Option<Side>,
    cascade_index: usize,
) -> Option<PlannedWindow> {
    let monitor = caller.current_monitor().ok().flatten()?;
    let source = window_rect(caller)?;
    let work_area = monitor.work_area();
    let work = Rect {
        x: work_area.position.x,
        y: work_area.position.y,
        width: work_area.size.width as i32,
        height: work_area.size.height as i32,
    };
    let scale = monitor.scale_factor();
    if !scale.is_finite() || scale <= 0.0 {
        return None;
    }
    let physical_size = |size: (f64, f64)| Size {
        width: (size.0 * scale).round() as i32,
        height: (size.1 * scale).round() as i32,
    };
    let placement = place_adjacent(
        source,
        work,
        physical_size(preferred_size),
        physical_size(minimum_size),
        (WINDOW_GAP * scale).round() as i32,
        preferred_side,
        cascade_index,
    );

    Some(PlannedWindow {
        logical_width: placement.rect.width as f64 / scale,
        logical_height: placement.rect.height as f64 / scale,
        placement,
    })
}

fn planned_size(plan: &Option<PlannedWindow>, fallback: (f64, f64)) -> (f64, f64) {
    plan.as_ref()
        .map(|plan| (plan.logical_width, plan.logical_height))
        .unwrap_or(fallback)
}

fn show_new_window(
    window: &tauri::WebviewWindow,
    plan: Option<PlannedWindow>,
) -> Result<(), String> {
    if let Some(plan) = plan {
        let position = tauri::PhysicalPosition::new(plan.placement.rect.x, plan.placement.rect.y);
        if let Err(error) = window.set_position(position) {
            eprintln!("Failed to position {}: {}", window.label(), error);
        }
    }
    window.show().map_err(|error| error.to_string())?;
    let _ = window.set_focus();
    Ok(())
}

fn window_rect(window: &tauri::WebviewWindow) -> Option<Rect> {
    let position = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    Some(Rect {
        x: position.x,
        y: position.y,
        width: size.width as i32,
        height: size.height as i32,
    })
}

fn day_window_context(
    app: &tauri::AppHandle,
    caller: &tauri::WebviewWindow,
) -> (Option<Side>, usize) {
    if caller.label() != MONTH_WINDOW_LABEL {
        return (None, 0);
    }
    let Some(source) = window_rect(caller) else {
        return (None, 0);
    };
    let Some(monitor) = caller.current_monitor().ok().flatten() else {
        return (None, 0);
    };
    let work_area = monitor.work_area();
    let work = Rect {
        x: work_area.position.x,
        y: work_area.position.y,
        width: work_area.size.width as i32,
        height: work_area.size.height as i32,
    };
    let on_same_monitor = |rect: Rect| {
        let center_x = rect.x + rect.width / 2;
        let center_y = rect.y + rect.height / 2;
        center_x >= work.x
            && center_x < work.x + work.width
            && center_y >= work.y
            && center_y < work.y + work.height
    };
    let preferred_side = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .filter(|window| window.is_visible().unwrap_or(false))
        .and_then(|window| window_rect(&window))
        .filter(|rect| on_same_monitor(*rect))
        .and_then(|main| {
            if main.x + main.width <= source.x {
                Some(Side::Left)
            } else if main.x >= source.x + source.width {
                Some(Side::Right)
            } else {
                None
            }
        });
    let cascade_index = app
        .webview_windows()
        .values()
        .filter(|window| {
            window.label() == MAIN_WINDOW_LABEL || window.label().starts_with(DAY_WINDOW_PREFIX)
        })
        .filter(|window| window.is_visible().unwrap_or(false))
        .filter_map(window_rect)
        .filter(|rect| on_same_monitor(*rect))
        .count();

    (preferred_side, cascade_index)
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
async fn load_day(app: tauri::AppHandle, date: String) -> Result<Option<DayData>, String> {
    calendar_data::load_day_locked(&app, &date)
}

#[tauri::command]
async fn save_day(app: tauri::AppHandle, day: DayData, base_reminder_ids: Option<Vec<String>>, today: Option<String>) -> Result<DayData, String> {
    let today = today.unwrap_or_else(|| day.date.clone());
    validate_date(&today)?;
    calendar_data::save_day_locked(&app, day, base_reminder_ids.unwrap_or_default(), &today)
}

#[tauri::command]
fn load_tag_templates(app: tauri::AppHandle) -> Result<Option<TagTemplates>, String> {
    let path = tag_templates_file_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read tag templates: {}", error))?;
    let data = serde_json::from_str(&content)
        .map_err(|error| format!("Failed to parse tag templates: {}", error))?;
    Ok(Some(data))
}

#[tauri::command]
fn save_tag_templates(app: tauri::AppHandle, mut templates: TagTemplates) -> Result<(), String> {
    let path = tag_templates_file_path(&app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Failed to resolve tag template directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create tag template directory: {}", error))?;

    templates.updated_at = Some(current_timestamp());
    let content = serde_json::to_string_pretty(&templates)
        .map_err(|error| format!("Failed to serialize tag templates: {}", error))?;
    fs::write(&path, content)
        .map_err(|error| format!("Failed to save tag templates: {}", error))?;
    Ok(())
}

#[tauri::command]
fn load_long_tasks(app: tauri::AppHandle) -> Result<Option<LongTasks>, String> {
    let path = long_tasks_file_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read long tasks: {}", error))?;
    let data = serde_json::from_str(&content)
        .map_err(|error| format!("Failed to parse long tasks: {}", error))?;
    Ok(Some(data))
}

#[tauri::command]
fn save_long_tasks(app: tauri::AppHandle, mut tasks: LongTasks) -> Result<(), String> {
    let path = long_tasks_file_path(&app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Failed to resolve long tasks directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create long tasks directory: {}", error))?;

    tasks.updated_at = Some(current_timestamp());
    let content = serde_json::to_string_pretty(&tasks)
        .map_err(|error| format!("Failed to serialize long tasks: {}", error))?;
    fs::write(&path, content).map_err(|error| format!("Failed to save long tasks: {}", error))?;
    Ok(())
}

#[tauri::command]
fn load_storage_location(app: tauri::AppHandle) -> Result<StorageLocation, String> {
    storage_location(&app)
}

#[tauri::command]
async fn set_storage_location(app: tauri::AppHandle, path: String) -> Result<StorageLocation, String> {
    let path = PathBuf::from(path);
    if !path.exists() {
        return Err("Selected data folder does not exist".to_string());
    }
    if !path.is_dir() {
        return Err("Selected data location must be a folder".to_string());
    }
    let data_lock = app.state::<calendar_data::CalendarDataLock>();
    let _guard = data_lock.0.lock().map_err(|error| error.to_string())?;

    write_storage_settings(
        &app,
        StorageSettings {
            data_dir: Some(path_to_string(path)?),
        },
    )?;
    storage_location(&app)
}

#[tauri::command]
async fn reset_storage_location(app: tauri::AppHandle) -> Result<StorageLocation, String> {
    let data_lock = app.state::<calendar_data::CalendarDataLock>();
    let _guard = data_lock.0.lock().map_err(|error| error.to_string())?;
    write_storage_settings(&app, StorageSettings::default())?;
    storage_location(&app)
}

#[tauri::command]
async fn pick_data_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let selected =
        tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
            .await
            .map_err(|error| format!("Failed to open folder picker: {}", error))?;

    selected
        .map(|path| {
            path.into_path()
                .map_err(|error| format!("Failed to resolve selected folder: {}", error))
                .and_then(path_to_string)
        })
        .transpose()
}

fn day_file_path(app: &tauri::AppHandle, date: &str) -> Result<PathBuf, String> {
    validate_date(date)?;
    let year = &date[0..4];
    let month = &date[5..7];
    let data_dir = data_root(app)?;

    Ok(data_dir
        .join("days")
        .join(year)
        .join(month)
        .join(format!("{}.json", date)))
}

fn tag_templates_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_root(app)?.join("tag-templates.json"))
}

fn long_tasks_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_root(app)?.join("long-tasks.json"))
}

fn storage_location(app: &tauri::AppHandle) -> Result<StorageLocation, String> {
    let settings = read_storage_settings(app)?;
    let default_path = default_data_root(app)?;
    let custom_path = settings
        .data_dir
        .as_ref()
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from);
    let effective_path = custom_path.clone().unwrap_or(default_path);

    Ok(StorageLocation {
        is_default: custom_path.is_none(),
        path: custom_path.map(path_to_string).transpose()?,
        effective_path: path_to_string(effective_path)?,
    })
}

fn data_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let settings = read_storage_settings(app)?;
    if let Some(path) = settings.data_dir.filter(|path| !path.trim().is_empty()) {
        return Ok(PathBuf::from(path));
    }
    default_data_root(app)
}

fn default_data_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to get app data directory: {}", error))?
        .join(DATA_DIR_NAME))
}

fn storage_settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Failed to get app config directory: {}", error))?
        .join(STORAGE_SETTINGS_FILE_NAME))
}

fn read_storage_settings(app: &tauri::AppHandle) -> Result<StorageSettings, String> {
    let path = storage_settings_path(app)?;
    if !path.exists() {
        return Ok(StorageSettings::default());
    }

    let content = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read storage settings: {}", error))?;
    serde_json::from_str(&content)
        .map_err(|error| format!("Failed to parse storage settings: {}", error))
}

fn write_storage_settings(app: &tauri::AppHandle, settings: StorageSettings) -> Result<(), String> {
    let path = storage_settings_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Failed to resolve storage settings directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create storage settings directory: {}", error))?;
    let content = serde_json::to_string_pretty(&settings)
        .map_err(|error| format!("Failed to serialize storage settings: {}", error))?;
    fs::write(&path, content).map_err(|error| format!("Failed to save storage settings: {}", error))
}

fn path_to_string(path: PathBuf) -> Result<String, String> {
    path.into_os_string()
        .into_string()
        .map_err(|_| "Path contains invalid Unicode".to_string())
}

fn validate_date(date: &str) -> Result<(), String> {
    let bytes = date.as_bytes();
    let is_valid = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit());

    if is_valid {
        Ok(())
    } else {
        Err("Date format must be YYYY-MM-DD".to_string())
    }
}

fn current_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    millis.to_string()
}
