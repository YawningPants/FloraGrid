use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_dialog::DialogExt;

const MAIN_WINDOW_LABEL: &str = "main";
const TAG_MANAGER_WINDOW_LABEL: &str = "tag-manager";
const SHOW_TODAY_MENU_ID: &str = "show_today";
const QUIT_MENU_ID: &str = "quit";
const DATA_DIR_NAME: &str = "calendar-data";
const STORAGE_SETTINGS_FILE_NAME: &str = "storage-settings.json";

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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            load_day,
            save_day,
            load_tag_templates,
            save_tag_templates,
            load_storage_location,
            set_storage_location,
            reset_storage_location,
            pick_data_directory,
            open_tag_manager_window,
            exit_app
        ])
        .setup(|app| {
            let menu = MenuBuilder::new(app)
                .text(SHOW_TODAY_MENU_ID, "Show today's tasks")
                .separator()
                .text(QUIT_MENU_ID, "Quit")
                .build()?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Desktop Calendar")
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
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
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
async fn open_tag_manager_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(TAG_MANAGER_WINDOW_LABEL) {
        window.show().map_err(|error| error.to_string())?;
        window.unminimize().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    WebviewWindowBuilder::new(
        &app,
        TAG_MANAGER_WINDOW_LABEL,
        WebviewUrl::App("index.html#tag-manager".into()),
    )
    .title("长期标签管理")
    .inner_size(760.0, 520.0)
    .min_inner_size(560.0, 420.0)
    .transparent(true)
    .decorations(false)
    .resizable(true)
    .maximizable(false)
    .build()
    .map_err(|error| format!("Failed to open tag manager window: {}", error))?;

    Ok(())
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn load_day(app: tauri::AppHandle, date: String) -> Result<Option<DayData>, String> {
    let path = day_file_path(&app, &date)?;
    if !path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read day data: {}", error))?;
    let data = serde_json::from_str(&content)
        .map_err(|error| format!("Failed to parse day data: {}", error))?;
    Ok(Some(data))
}

#[tauri::command]
fn save_day(app: tauri::AppHandle, mut day: DayData) -> Result<(), String> {
    let path = day_file_path(&app, &day.date)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Failed to resolve day data directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create day data directory: {}", error))?;

    day.updated_at = Some(current_timestamp());
    let content = serde_json::to_string_pretty(&day)
        .map_err(|error| format!("Failed to serialize day data: {}", error))?;
    fs::write(&path, content).map_err(|error| format!("Failed to save day data: {}", error))?;
    Ok(())
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
fn load_storage_location(app: tauri::AppHandle) -> Result<StorageLocation, String> {
    storage_location(&app)
}

#[tauri::command]
fn set_storage_location(app: tauri::AppHandle, path: String) -> Result<StorageLocation, String> {
    let path = PathBuf::from(path);
    if !path.exists() {
        return Err("Selected data folder does not exist".to_string());
    }
    if !path.is_dir() {
        return Err("Selected data location must be a folder".to_string());
    }

    write_storage_settings(
        &app,
        StorageSettings {
            data_dir: Some(path_to_string(path)?),
        },
    )?;
    storage_location(&app)
}

#[tauri::command]
fn reset_storage_location(app: tauri::AppHandle) -> Result<StorageLocation, String> {
    write_storage_settings(&app, StorageSettings::default())?;
    storage_location(&app)
}

#[tauri::command]
async fn pick_data_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let selected = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().blocking_pick_folder()
    })
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
    fs::write(&path, content)
        .map_err(|error| format!("Failed to save storage settings: {}", error))
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
