use super::{current_timestamp, data_root, day_file_path, validate_date, DayData};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};
use tauri::Manager;

#[derive(Default)]
pub struct CalendarDataLock(pub Mutex<()>);
static STAMP: AtomicU64 = AtomicU64::new(0);
fn stamp() -> String {
    format!(
        "{}-{}",
        current_timestamp(),
        STAMP.fetch_add(1, Ordering::Relaxed)
    )
}
fn state_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(data_root(app)?.join("reminders.json"))
}
fn atomic_json(path: &Path, value: &Value) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("Invalid data path")?).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.pending");
    fs::write(
        &temp,
        serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(&temp, path).map_err(|e| format!("保存 {} 失败：{}", path.display(), e))
}
fn read_json(path: &Path) -> Result<Option<Value>, String> {
    if !path.exists() {
        return Ok(None);
    }
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map(Some)
        .map_err(|e| format!("读取 {} 失败：{}", path.display(), e))
}
pub(crate) fn recover(app: &tauri::AppHandle) -> Result<(), String> {
    recover_at(&data_root(app)?)
}
// A chosen destination may also contain an interrupted reminder transaction.
// Finish it before inspecting/migrating, so it cannot replay over the copied data.
pub(crate) fn recover_at(root: &Path) -> Result<(), String> {
    super::data_archive::recover(root)?;
    let journal = root.join("reminder-transaction.json");
    if let Some(plan) = read_json(&journal)? {
        let mut files = Vec::new();
        for day in plan["days"]
            .as_array()
            .ok_or("Invalid reminder transaction")?
        {
            let date = day["date"].as_str().ok_or("Invalid transaction date")?;
            validate_date(date)?;
            files.push(super::data_archive::FileRecord {
                name: format!("days/{}/{}/{}.json", &date[..4], &date[5..7], date),
                data: day.clone(),
            });
        }
        files.push(super::data_archive::FileRecord {
            name: "reminders.json".into(),
            data: plan["store"].clone(),
        });
        super::data_archive::validate_records(&files)?;
        for file in files {
            let path = super::data_archive::safe_file(root, &file.name)?;
            super::data_archive::atomic_value(&path, &file.data)?;
        }
        fs::remove_file(journal).map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn store(app: &tauri::AppHandle) -> Result<Value, String> {
    Ok(read_json(&state_path(app)?)?.unwrap_or_else(
        || json!({"version":1,"revision":0,"sealedThrough":null,"rules":[],"exceptions":{}}),
    ))
}
fn read_day(app: &tauri::AppHandle, date: &str) -> Result<Option<DayData>, String> {
    read_json(&day_file_path(app, date)?)?
        .map(serde_json::from_value)
        .transpose()
        .map_err(|e| e.to_string())
}
fn write_transaction(app: &tauri::AppHandle, days: &[Value], next: &Value) -> Result<(), String> {
    atomic_json(
        &data_root(app)?.join("reminder-transaction.json"),
        &json!({"days":days,"store":next}),
    )?;
    recover(app)
}
fn all_dates(path: &Path, dates: &mut Vec<String>) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_dir() {
            all_dates(&entry.path(), dates)?;
        } else if kind.is_file() {
            if let Some(name) = entry
                .file_name()
                .to_str()
                .and_then(|n| n.strip_suffix(".json"))
            {
                if validate_date(name).is_ok() {
                    dates.push(name.to_string());
                }
            }
        }
    }
    Ok(())
}
pub fn load_day_locked(app: &tauri::AppHandle, date: &str) -> Result<Option<DayData>, String> {
    let state = app.state::<CalendarDataLock>();
    let _guard = state.0.lock().map_err(|e| e.to_string())?;
    recover(app)?;
    read_day(app, date)
}
fn flatten(tasks: &[Value], into: &mut HashMap<String, Value>) {
    for task in tasks {
        if let Some(id) = task["id"].as_str() {
            into.insert(id.into(), task.clone());
        }
        if let Some(children) = task["children"].as_array() {
            flatten(children, into);
        }
    }
}
fn pristine(task: &Value) -> bool {
    task["reminder"].is_object()
        && task["reminder"]["edited"] != true
        && task["status"] == "active"
        && task["tags"].as_array().map_or(true, |v| v.is_empty())
        && task["children"].as_array().map_or(true, |v| v.is_empty())
        && json!({"title":task["title"].as_str().unwrap_or(""),"color":task["color"],"pinned":task["pinned"]==true,"kind":task["kind"].as_str().unwrap_or("routine")})
            == task["reminder"]["baseline"]
}

fn merge(
    tasks: Vec<Value>,
    current: &HashMap<String, Value>,
    base: &[String],
    date: &str,
    today: &str,
    store: &mut Value,
) -> Vec<Value> {
    tasks
        .into_iter()
        .filter_map(|mut task| {
            if let Some(children) = task["children"].as_array() {
                task["children"] =
                    json!(merge(children.clone(), current, base, date, today, store));
            }
            let Some(rule) = task["reminder"]["ruleId"].as_str().map(String::from) else {
                return Some(task);
            };
            let id = task["id"].as_str().unwrap_or("").to_string();
            let key = format!("{}|{}", rule, date);
            if task["status"] == "deleted" {
                store["exceptions"][&key] = json!("deleted");
                return Some(task);
            }
            if store["exceptions"][&key] == "deleted" {
                store["exceptions"].as_object_mut().unwrap().remove(&key);
            }
            if let Some(now) = current.get(&id) {
                if now["reminder"]["signature"] != task["reminder"]["signature"] {
                    if pristine(&task) {
                        return Some(now.clone());
                    }
                    if date > today {
                        task.as_object_mut().unwrap().remove("reminder");
                        store["exceptions"][&key] = json!("detached");
                    }
                }
            } else if base.contains(&id) && date > today {
                if pristine(&task) {
                    return None;
                }
                task.as_object_mut().unwrap().remove("reminder");
                store["exceptions"][&key] = json!("detached");
            }
            Some(task)
        })
        .collect()
}

pub fn save_day_locked(
    app: &tauri::AppHandle,
    mut day: DayData,
    base: Vec<String>,
    today: &str,
) -> Result<DayData, String> {
    let state = app.state::<CalendarDataLock>();
    let _guard = state.0.lock().map_err(|e| e.to_string())?;
    recover(app)?;
    let mut next = store(app)?;
    let old_store = next.clone();
    let current = read_day(app, &day.date)?;
    let mut current_tasks = HashMap::new();
    if let Some(ref current) = current {
        flatten(&current.tasks, &mut current_tasks);
    }
    let mut incoming = HashMap::new();
    flatten(&day.tasks, &mut incoming);
    for id in &base {
        if !incoming.contains_key(id) {
            if let Some(rule) = id
                .strip_prefix("reminder-")
                .and_then(|v| v.strip_suffix(&format!("-{}", day.date)))
            {
                next["exceptions"][format!("{}|{}", rule, day.date)] = json!("deleted");
            }
        }
    }
    day.tasks = merge(
        day.tasks,
        &current_tasks,
        &base,
        &day.date,
        today,
        &mut next,
    );
    let mut submitted = HashMap::new();
    flatten(&day.tasks, &mut submitted);
    if let Some(current) = current {
        for task in current.tasks {
            let id = task["id"].as_str().unwrap_or("");
            if task["reminder"].is_object()
                && !base.iter().any(|v| v == id)
                && !submitted.contains_key(id)
            {
                day.tasks.push(task);
            }
        }
    }
    day.updated_at = Some(stamp());
    let value = serde_json::to_value(&day).map_err(|e| e.to_string())?;
    if next != old_store {
        next["revision"] = json!(old_store["revision"].as_u64().unwrap_or(0) + 1);
        write_transaction(app, &[value], &next)?;
    } else {
        atomic_json(&day_file_path(app, &day.date)?, &value)?;
    }
    Ok(day)
}

#[tauri::command]
pub async fn load_reminder_state(app: tauri::AppHandle) -> Result<Value, String> {
    let state = app.state::<CalendarDataLock>();
    let _guard = state.0.lock().map_err(|e| e.to_string())?;
    recover(&app)?;
    Ok(json!({"state":store(&app)?,"identity":data_root(&app)?.to_string_lossy()}))
}
#[tauri::command]
pub async fn read_calendar_days(
    app: tauri::AppHandle,
    from: String,
    through: String,
) -> Result<Vec<DayData>, String> {
    validate_date(&from)?;
    validate_date(&through)?;
    let state = app.state::<CalendarDataLock>();
    let _guard = state.0.lock().map_err(|e| e.to_string())?;
    recover(&app)?;
    let mut dates = Vec::new();
    all_dates(&data_root(&app)?.join("days"), &mut dates)?;
    dates.sort();
    dates.dedup();
    dates
        .into_iter()
        .filter(|date| date >= &from && date <= &through)
        .map(|date| read_day(&app, &date))
        .collect::<Result<Vec<_>, _>>()
        .map(|days| days.into_iter().flatten().collect())
}
#[tauri::command]
pub async fn commit_reminder_plan(
    app: tauri::AppHandle,
    expected_revision: u64,
    identity: Option<String>,
    mut next: Value,
    days: Vec<Value>,
    bases: HashMap<String, Option<String>>,
) -> Result<Value, String> {
    let state = app.state::<CalendarDataLock>();
    let _guard = state.0.lock().map_err(|e| e.to_string())?;
    recover(&app)?;
    if identity.as_deref() != Some(data_root(&app)?.to_string_lossy().as_ref()) {
        return Err("数据目录已更改，请重新操作".into());
    }
    let old = store(&app)?;
    if old["revision"].as_u64().unwrap_or(0) != expected_revision {
        return Err("REMINDERS_CONFLICT".into());
    }
    let mut changes = Vec::new();
    let mut seen = HashSet::new();
    for value in days {
        let mut day: DayData = serde_json::from_value(value).map_err(|e| e.to_string())?;
        if !seen.insert(day.date.clone()) {
            return Err("Duplicate transaction date".into());
        }
        let current = read_day(&app, &day.date)?;
        if current.as_ref().and_then(|d| d.updated_at.clone())
            != bases.get(&day.date).cloned().flatten()
        {
            return Err("REMINDERS_CONFLICT".into());
        }
        if current
            .as_ref()
            .map_or(false, |d| d.tasks == day.tasks && d.note == day.note)
            || (current.is_none() && day.tasks.is_empty() && day.note.is_empty())
        {
            continue;
        }
        day.updated_at = Some(stamp());
        changes.push(serde_json::to_value(day).map_err(|e| e.to_string())?);
    }
    if next == old && changes.is_empty() {
        return Ok(json!({"store":old,"changedDates":[]}));
    }
    next["revision"] = json!(expected_revision + 1);
    let changed: Vec<String> = changes
        .iter()
        .map(|d| d["date"].as_str().unwrap().to_string())
        .collect();
    write_transaction(&app, &changes, &next)?;
    Ok(json!({"store":next,"changedDates":changed}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn task() -> Value {
        json!({"id":"reminder-rule-x-2026-10-31","title":"生日","status":"active","color":"#c5b985","pinned":false,"kind":"birthday","tags":[],"children":[],
            "reminder":{"ruleId":"rule-x","signature":"old","edited":false,"baseline":{"title":"生日","color":"#c5b985","pinned":false,"kind":"birthday"}}})
    }
    #[test]
    fn stale_future_save_does_not_resurrect_removed_auto_task() {
        let task = task();
        let mut store = json!({"exceptions":{}});
        let merged = merge(
            vec![task.clone()],
            &HashMap::new(),
            &[task["id"].as_str().unwrap().into()],
            "2026-10-31",
            "2026-10-24",
            &mut store,
        );
        assert!(merged.is_empty());
    }
    #[test]
    fn user_completed_task_survives_as_an_independent_task() {
        let mut task = task();
        task["status"] = json!("completed");
        let mut store = json!({"exceptions":{}});
        let merged = merge(
            vec![task.clone()],
            &HashMap::new(),
            &[task["id"].as_str().unwrap().into()],
            "2026-10-31",
            "2026-10-24",
            &mut store,
        );
        assert_eq!(merged[0]["status"], "completed");
        assert!(merged[0].get("reminder").is_none());
        assert_eq!(store["exceptions"]["rule-x|2026-10-31"], "detached");
    }
    #[test]
    fn stale_unmodified_task_uses_the_current_generated_version() {
        let old = task();
        let mut current = old.clone();
        current["title"] = json!("新名称");
        current["reminder"]["signature"] = json!("new");
        let mut map = HashMap::new();
        map.insert(old["id"].as_str().unwrap().into(), current.clone());
        let result = merge(
            vec![old],
            &map,
            &[],
            "2026-10-31",
            "2026-10-24",
            &mut json!({"exceptions":{}}),
        );
        assert_eq!(result[0], current);
    }
    #[test]
    fn atomic_replacement_works_for_existing_json_files() {
        let dir = std::env::temp_dir().join(format!("calendar-json-test-{}", stamp()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("day.json");
        atomic_json(&file, &json!({"value":1})).unwrap();
        atomic_json(&file, &json!({"value":2})).unwrap();
        assert_eq!(read_json(&file).unwrap().unwrap()["value"], 2);
        fs::remove_file(file).unwrap();
        fs::remove_dir(dir).unwrap();
    }
}
