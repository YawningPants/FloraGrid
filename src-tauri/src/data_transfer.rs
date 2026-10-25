use super::{
    calendar_data::CalendarDataLock,
    data_archive::{self as archive, Backup, FileRecord},
    day_window_handoff::DayWindowHandoffs,
    DayWindowOperation, StorageSettings,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
pub struct TransferReceipts(pub Mutex<HashMap<String, Receipt>>);
pub struct Receipt {
    source: PathBuf,
    destination: PathBuf,
    files: Vec<(String, String)>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub fingerprint: Option<String>,
    #[serde(default)]
    pub target_stamp: Option<String>,
    #[serde(default)]
    pub migrate: bool,
    #[serde(default)]
    pub use_default: bool,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub preferences: Value,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetInfo {
    path: String,
    empty: bool,
    files: usize,
    same_root: bool,
    related: bool,
    stamp: String,
}
fn display(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{}", rest)
    } else {
        text.strip_prefix(r"\\?\").unwrap_or(&text).into()
    }
}
fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let path = super::data_root(app)?;
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    archive::canonical_root(&path)
}
fn target(app: &tauri::AppHandle, path: Option<String>) -> Result<PathBuf, String> {
    let path = path
        .map(PathBuf::from)
        .unwrap_or(super::default_data_root(app)?);
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    archive::canonical_root(&path)
}
fn inspect_at(source: &Path, destination: &Path) -> Result<TargetInfo, String> {
    super::calendar_data::recover_at(destination)?;
    let files = archive::snapshot(destination)?;
    let mut names: Vec<_> = fs::read_dir(destination)
        .map_err(|e| e.to_string())?
        .map(|e| {
            e.map(|e| e.file_name().to_string_lossy().to_string())
                .map_err(|e| e.to_string())
        })
        .collect::<Result<_, _>>()?;
    names.sort();
    let signatures: Vec<_> = files
        .iter()
        .map(|f| Ok((f.name.clone(), archive::value_fingerprint(&f.data)?)))
        .collect::<Result<_, String>>()?;
    Ok(TargetInfo {
        path: display(destination),
        empty: names.is_empty(),
        files: files.len(),
        same_root: source == destination,
        related: source.starts_with(destination) || destination.starts_with(source),
        stamp: archive::value_fingerprint(&json!({"names":names,"files":signatures}))?,
    })
}
struct Progress {
    window: tauri::WebviewWindow,
    id: String,
    last: Instant,
}
impl Progress {
    fn send(&mut self, label: &str, ratio: f64, file: &str) {
        if ratio < 1.0 && self.last.elapsed() < Duration::from_millis(32) {
            return;
        }
        self.last = Instant::now();
        let _ = self.window.emit_to(
            self.window.label(),
            "calendar://data-transfer-progress",
            json!({"id":self.id,"label":label,"progress":ratio,"file":file}),
        );
    }
}
#[tauri::command]
pub async fn inspect_storage_target(
    app: tauri::AppHandle,
    path: Option<String>,
) -> Result<TargetInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let lock = app.state::<CalendarDataLock>();
        let _guard = lock.0.lock().map_err(|e| e.to_string())?;
        let source = root(&app)?;
        let destination = target(&app, path)?;
        inspect_at(&source, &destination)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn preview_backup_file(path: String) -> Result<archive::Summary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        archive::read_backup(Path::new(&path)).map(|(_, summary)| summary)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn pick_backup_path(app: tauri::AppHandle, save: bool) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dialog = app.dialog().file().add_filter("日枝备份", &["json"]);
        let path = if save {
            dialog.set_file_name("日枝备份.json").blocking_save_file()
        } else {
            dialog.blocking_pick_file()
        };
        path.map(|p| {
            p.into_path()
                .map_err(|e| e.to_string())
                .map(|p| display(&p))
        })
        .transpose()
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn complete_data_transfer(
    window: tauri::WebviewWindow,
    id: String,
    error: Option<String>,
) -> Result<(), String> {
    window
        .app_handle()
        .state::<DayWindowHandoffs>()
        .finish(window.label(), &id, error)
}
fn release(app: &tauri::AppHandle, leases: &[(String, String)], reload: bool) {
    for (label, id) in leases {
        app.state::<DayWindowHandoffs>().cancel(id);
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.emit_to(
                window.label(),
                "calendar://data-transfer-end",
                json!({"id":id,"reload":reload,"windowLabel":window.label()}),
            );
        }
    }
}
async fn prepare(app: &tauri::AppHandle, owner: &str) -> Result<Vec<(String, String)>, String> {
    let mut leases = Vec::new();
    for (label, window) in app.webview_windows() {
        if label == owner
            || !(label == "main"
                || label == "month-view"
                || label == "settings"
                || label.starts_with("day-"))
        {
            continue;
        }
        let (id, receive) = app.state::<DayWindowHandoffs>().begin(&label)?;
        leases.push((label, id.clone()));
        let result = if window
            .emit_to(
                window.label(),
                "calendar://data-transfer-request",
                json!({"id":id,"windowLabel":window.label()}),
            )
            .is_err()
        {
            Err("无法通知打开的窗口，请关闭后重试".into())
        } else {
            tauri::async_runtime::spawn_blocking(move || {
                receive
                    .recv_timeout(Duration::from_secs(8))
                    .map_err(|_| "有窗口尚未完成保存，请稍后重试".to_string())
                    .and_then(|r| r)
            })
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r)
        };
        if let Err(error) = result {
            release(app, &leases, false);
            return Err(error);
        }
    }
    Ok(leases)
}
fn clean_source(
    app: &tauri::AppHandle,
    token: &str,
    progress: &mut Progress,
) -> Result<Value, String> {
    let receipts = app.state::<TransferReceipts>();
    let mut map = receipts.0.lock().map_err(|e| e.to_string())?;
    let receipt = map.get(token).ok_or("清理凭证已过期；原数据已保留")?;
    if root(app)? != receipt.destination || receipt.source == receipt.destination {
        return Err("存储位置已变化，已保留原数据".into());
    }
    if archive::canonical_root(&receipt.source)? != receipt.source {
        return Err("原文件夹的位置或链接已变化，已保留原数据".into());
    }
    // Preflight every file before deleting anything; user/external edits invalidate cleanup.
    for (name, hash) in &receipt.files {
        let from = archive::safe_file(&receipt.source, name)?;
        let to = archive::safe_file(&receipt.destination, name)?;
        let destination: Value =
            serde_json::from_slice(&fs::read(to).map_err(|_| "目标数据已变化，已保留原数据")?)
                .map_err(|e| e.to_string())?;
        if archive::value_fingerprint(&destination)? != *hash {
            return Err("目标数据已变化，已保留原数据".into());
        }
        if from.exists() {
            let source: Value =
                serde_json::from_slice(&fs::read(&from).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            if archive::value_fingerprint(&source)? != *hash {
                return Err("原文件已被修改，未进行清理".into());
            }
        }
    }
    let mut deleted = 0;
    for (name, _) in &receipt.files {
        let path = archive::safe_file(&receipt.source, name)?;
        if path.exists() {
            fs::remove_file(path).map_err(|e| e.to_string())?;
            deleted += 1;
        }
        progress.send(
            "清理已迁移的原文件",
            deleted as f64 / receipt.files.len().max(1) as f64,
            name,
        );
    }
    map.remove(token);
    Ok(json!({"deleted":deleted}))
}
fn execute(
    app: &tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: Request,
) -> Result<Value, String> {
    let lock = app.state::<CalendarDataLock>();
    let _guard = lock.0.lock().map_err(|e| e.to_string())?;
    let mut progress = Progress {
        window,
        id: request.id,
        last: Instant::now() - Duration::from_secs(1),
    };
    if request.kind == "cleanup" {
        return clean_source(
            app,
            request.token.as_deref().ok_or("缺少清理凭证")?,
            &mut progress,
        );
    }
    let source = root(app)?;
    super::calendar_data::recover(app)?;
    progress.send("检查并保存数据", 0.04, "");
    let mut backup_path = None;
    match request.kind.as_str() {
        "export" => {
            let path = PathBuf::from(request.path.ok_or("请选择导出文件")?);
            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .ok_or("备份文件名无效")?;
            if name.starts_with(".rizhi-")
                || ["long-tasks.json", "tag-templates.json", "reminders.json"].contains(&name)
                || name
                    .strip_suffix(".json")
                    .is_some_and(|n| super::validate_date(n).is_ok())
            {
                return Err("备份不能覆盖日枝的数据文件，请换一个文件名".into());
            }
            let files = archive::snapshot(&source)?;
            progress.send("写入备份文件", 0.75, "");
            let count = files.len();
            archive::write_backup(&path, &Backup::new(files, request.preferences))?;
            progress.send("导出完成", 1.0, "");
            Ok(json!({"path":display(&path),"files":count}))
        }
        "import" => {
            let (backup, summary) =
                archive::read_backup(Path::new(request.path.as_deref().ok_or("请选择备份文件")?))?;
            if request.fingerprint.as_deref() != Some(&summary.fingerprint) {
                return Err("备份文件已变化，请重新选择并确认".into());
            }
            if backup.files.is_empty() {
                return Err("备份中没有可导入的数据".into());
            }
            let before = archive::snapshot(&source)?;
            progress.send("保存导入前的安全副本", 0.15, "");
            backup_path = archive::automatic_backup(&source, before, request.preferences)?;
            archive::replace(&source, &backup.files, |done, total, name| {
                progress.send(
                    "恢复数据",
                    0.2 + done as f64 / total.max(1) as f64 * 0.75,
                    name,
                );
                Ok(())
            })?;
            progress.send("导入完成", 1.0, "");
            Ok(
                json!({"files":backup.files.len(),"backupPath":backup_path,"preferences":backup.preferences}),
            )
        }
        "move" | "switch" => {
            let destination = target(
                app,
                if request.use_default {
                    None
                } else {
                    Some(request.path.ok_or("请选择文件夹")?)
                },
            )?;
            let info = inspect_at(&source, &destination)?;
            if info.same_root {
                return Err("当前已经使用这个文件夹".into());
            }
            if request.target_stamp.as_deref() != Some(&info.stamp) {
                return Err("目标文件夹内容已变化，请重新选择并确认".into());
            }
            let mut cleanup_token = None;
            if request.migrate {
                if info.related {
                    return Err("原位置与目标位置不能互相包含，请选择独立文件夹".into());
                }
                let files = archive::snapshot(&source)?;
                let hashes = files
                    .iter()
                    .map(|f| Ok((f.name.clone(), archive::value_fingerprint(&f.data)?)))
                    .collect::<Result<Vec<_>, String>>()?;
                let target_files = archive::snapshot(&destination)?;
                backup_path = archive::automatic_backup(
                    &destination,
                    target_files.clone(),
                    request.preferences,
                )?;
                let mut merged: BTreeMap<String, Value> =
                    target_files.into_iter().map(|f| (f.name, f.data)).collect();
                for file in files {
                    merged.insert(file.name, file.data);
                }
                let merged: Vec<_> = merged
                    .into_iter()
                    .map(|(name, data)| FileRecord { name, data })
                    .collect();
                archive::replace(&destination, &merged, |done, total, name| {
                    progress.send(
                        "迁移并核验数据",
                        0.1 + done as f64 / total.max(1) as f64 * 0.8,
                        name,
                    );
                    Ok(())
                })?;
                // Re-read copied data before switching the app or offering source deletion.
                for (name, hash) in &hashes {
                    let data: Value = serde_json::from_slice(
                        &fs::read(archive::safe_file(&destination, name)?)
                            .map_err(|e| e.to_string())?,
                    )
                    .map_err(|e| e.to_string())?;
                    if archive::value_fingerprint(&data)? != *hash {
                        return Err("迁移校验失败，原位置保持不变".into());
                    }
                }
                if !hashes.is_empty() {
                    let token = format!("migration-{}", archive::stamp());
                    let state = app.state::<TransferReceipts>();
                    let mut map = state.0.lock().map_err(|e| e.to_string())?;
                    if map.len() >= 4 {
                        map.clear();
                    }
                    map.insert(
                        token.clone(),
                        Receipt {
                            source: source.clone(),
                            destination: destination.clone(),
                            files: hashes,
                        },
                    );
                    cleanup_token = Some(token);
                }
            }
            super::write_storage_settings(
                app,
                StorageSettings {
                    data_dir: if request.use_default {
                        None
                    } else {
                        Some(display(&destination))
                    },
                },
            )?;
            progress.send("存储位置已切换", 1.0, "");
            Ok(
                json!({"location":super::storage_location(app)?,"cleanupToken":cleanup_token,"sourcePath":display(&source),"backupPath":backup_path}),
            )
        }
        _ => Err("不支持的数据操作".into()),
    }
}
#[tauri::command]
pub async fn perform_data_transfer(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: Request,
) -> Result<Value, String> {
    if request.kind == "cleanup" {
        let app_copy = app.clone();
        return tauri::async_runtime::spawn_blocking(move || execute(&app_copy, window, request))
            .await
            .map_err(|e| e.to_string())?;
    }
    let operations = app.state::<DayWindowOperation>();
    let _operation = operations.0.lock().await;
    let leases = prepare(&app, window.label()).await?;
    let changed = matches!(
        request.kind.as_str(),
        "export" | "import" | "move" | "switch"
    );
    let app_copy = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || execute(&app_copy, window, request))
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r);
    release(&app, &leases, changed && result.is_ok());
    result
}
