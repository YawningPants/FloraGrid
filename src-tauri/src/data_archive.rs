use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    hash::{Hash, Hasher},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

pub const MAX_BYTES: u64 = 100 * 1024 * 1024;
const JOURNAL: &str = ".rizhi-transfer.json";
static SEQUENCE: AtomicU64 = AtomicU64::new(0);
pub fn stamp() -> String {
    format!(
        "{}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FileRecord {
    pub name: String,
    pub data: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub format: String,
    pub version: u32,
    pub exported_at: String,
    pub files: Vec<FileRecord>,
    #[serde(default)]
    pub preferences: Value,
}
impl Backup {
    pub fn new(files: Vec<FileRecord>, preferences: Value) -> Self {
        Self {
            format: "rizhi-backup".into(),
            version: 1,
            exported_at: stamp(),
            files,
            preferences,
        }
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub files: usize,
    pub days: usize,
    pub tasks: usize,
    pub long_tasks: usize,
    pub groups: usize,
    pub reminders: usize,
    pub exported_at: String,
    pub fingerprint: String,
}
pub fn fingerprint(bytes: &[u8]) -> String {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    format!("{:016x}-{}", h.finish(), bytes.len())
}
pub fn value_fingerprint(value: &Value) -> Result<String, String> {
    Ok(fingerprint(
        &serde_json::to_vec(value).map_err(|e| e.to_string())?,
    ))
}
fn linked(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}
pub fn canonical_root(path: &Path) -> Result<PathBuf, String> {
    let root = fs::canonicalize(path).map_err(|e| format!("无法打开文件夹：{e}"))?;
    if !root.is_dir() {
        return Err("请选择文件夹".into());
    }
    Ok(root)
}
pub fn validate_name(name: &str) -> Result<(), String> {
    if ["long-tasks.json", "tag-templates.json", "reminders.json"].contains(&name) {
        return Ok(());
    }
    let p: Vec<_> = name.split('/').collect();
    if p.len() != 4 || p[0] != "days" {
        return Err(format!("备份包含不支持的文件路径：{name}"));
    }
    let date = p[3].strip_suffix(".json").ok_or("日期文件格式不正确")?;
    super::validate_date(date)?;
    let year: u32 = date[..4].parse().map_err(|_| "日期不正确")?;
    let month: u32 = date[5..7].parse().map_err(|_| "日期不正确")?;
    let day: u32 = date[8..].parse().map_err(|_| "日期不正确")?;
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let limit = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        _ => 0,
    };
    if year == 0 || day == 0 || day > limit {
        return Err("日期不正确".into());
    }
    if p[1] != &date[..4] || p[2] != &date[5..7] {
        return Err("日期文件夹与日期不一致".into());
    }
    Ok(())
}
pub fn safe_file(root: &Path, name: &str) -> Result<PathBuf, String> {
    validate_name(name)?;
    let mut path = root.to_path_buf();
    for part in name.split('/') {
        path.push(part);
        if let Ok(meta) = fs::symlink_metadata(&path) {
            if linked(&meta) {
                return Err(format!(
                    "数据路径包含链接，请选择实际文件夹：{}",
                    path.display()
                ));
            }
        }
    }
    if !path.starts_with(root) {
        return Err("数据路径越界".into());
    }
    Ok(path)
}
fn read_value(path: &Path) -> Result<Value, String> {
    let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_BYTES {
        return Err("文件超过 100 MiB，暂不支持".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| format!("{} 不是有效的数据文件：{e}", path.display()))
}
fn check_tasks(tasks: &Value, depth: usize, seen: &mut HashSet<String>) -> Result<usize, String> {
    if depth > 64 {
        return Err("任务层级过深".into());
    }
    let array = tasks.as_array().ok_or("任务列表格式不正确")?;
    let mut count = 0;
    for task in array {
        let id = task["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or("任务缺少编号")?;
        if !seen.insert(id.into()) {
            return Err("同一天或同一任务库包含重复任务编号".into());
        }
        if !task["title"].is_string()
            || !matches!(
                task["status"].as_str(),
                Some("active" | "completed" | "failed" | "deleted")
            )
        {
            return Err("任务标题或状态不正确".into());
        }
        if let Some(children) = task.get("children") {
            count += check_tasks(children, depth + 1, seen)?;
        }
        if task.get("tags").is_some_and(|tags| !tags.is_array()) {
            return Err("任务标签格式不正确".into());
        }
        count += 1;
    }
    Ok(count)
}
fn check_spec(spec: &Value) -> Result<(), String> {
    if spec["title"].as_str().is_none_or(|s| s.trim().is_empty())
        || !matches!(spec["calendar"].as_str(), Some("solar" | "lunar"))
    {
        return Err("提醒名称或历法不正确".into());
    }
    match spec["frequency"].as_str() {
        Some("weekly") => {
            let days = spec["weekdays"].as_array().ok_or("提醒星期不正确")?;
            if days.is_empty() || days.iter().any(|d| d.as_u64().is_none_or(|d| d > 6)) {
                return Err("提醒星期不正确".into());
            }
        }
        Some("yearly" | "monthly") => {
            let day = spec["day"].as_u64().ok_or("提醒日期不正确")?;
            let lunar = spec["calendar"] == "lunar";
            if day == 0 || day > if lunar { 30 } else { 31 } {
                return Err("提醒日期不正确".into());
            }
            if spec["frequency"] == "yearly" {
                let month = spec["month"].as_u64().ok_or("提醒月份不正确")?;
                if month == 0 || month > 12 {
                    return Err("提醒月份不正确".into());
                }
                if !lunar {
                    let limit = match month {
                        2 => 29,
                        4 | 6 | 9 | 11 => 30,
                        _ => 31,
                    };
                    if day > limit {
                        return Err("提醒日期不正确".into());
                    }
                }
            }
        }
        _ => return Err("提醒频率不正确".into()),
    }
    Ok(())
}
fn check_reminders(data: &Value) -> Result<(), String> {
    let rules = data["rules"].as_array().ok_or("提醒规则格式不正确")?;
    if !data["exceptions"].is_object() {
        return Err("提醒例外格式不正确".into());
    }
    let mut ids = HashSet::new();
    for rule in rules {
        let id = rule["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("提醒编号不正确")?;
        if !ids.insert(id) {
            return Err("提醒编号重复".into());
        }
        for segment in rule["segments"].as_array().ok_or("提醒历史格式不正确")? {
            let from = segment["from"].as_str().ok_or("提醒启用日期不正确")?;
            validate_name(&format!(
                "days/{}/{}/{}.json",
                from.get(..4).unwrap_or(""),
                from.get(5..7).unwrap_or(""),
                from
            ))?;
            if let Some(through) = segment["through"].as_str() {
                validate_name(&format!(
                    "days/{}/{}/{}.json",
                    through.get(..4).unwrap_or(""),
                    through.get(5..7).unwrap_or(""),
                    through
                ))?;
                if through < from {
                    return Err("提醒历史日期范围不正确".into());
                }
            }
            check_spec(&segment["spec"])?;
        }
        if let Some(spec) = rule.get("lastSpec") {
            check_spec(spec)?;
        }
    }
    Ok(())
}
pub fn validate_records(files: &[FileRecord]) -> Result<(), String> {
    if files.len() > 50000 {
        return Err("备份文件数量过多".into());
    }
    let mut names = HashSet::new();
    for file in files {
        validate_name(&file.name)?;
        if !names.insert(&file.name) {
            return Err("备份包含重复文件".into());
        }
        if file.name.starts_with("days/") {
            let date = file
                .name
                .rsplit('/')
                .next()
                .unwrap()
                .trim_end_matches(".json");
            if file.data["date"].as_str() != Some(date)
                || file.data.get("note").is_some_and(|v| !v.is_string())
            {
                return Err("日记录日期或随笔格式不正确".into());
            }
            check_tasks(&file.data["tasks"], 0, &mut HashSet::new())?;
        } else if file.name == "long-tasks.json" {
            check_tasks(&file.data["tasks"], 0, &mut HashSet::new())?;
        } else if file.name == "tag-templates.json" {
            if !file.data["groups"].is_array() {
                return Err("长期标签分组格式不正确".into());
            }
            for group in file.data["groups"].as_array().unwrap() {
                if !group["tags"].is_array() {
                    return Err("长期标签格式不正确".into());
                }
            }
        } else {
            check_reminders(&file.data)?;
        }
    }
    Ok(())
}
pub fn read_backup(path: &Path) -> Result<(Backup, Summary), String> {
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > MAX_BYTES {
        return Err("备份超过 100 MiB，暂不支持".into());
    }
    let bytes = fs::read(path).map_err(|e| format!("无法读取备份：{e}"))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("备份超过 100 MiB，暂不支持".into());
    }
    let backup: Backup =
        serde_json::from_slice(&bytes).map_err(|e| format!("这不是有效的日枝备份：{e}"))?;
    if backup.format != "rizhi-backup" || backup.version != 1 {
        return Err("备份格式或版本不受支持，请确认使用了兼容的日枝版本".into());
    }
    validate_records(&backup.files)?;
    let mut summary = Summary {
        files: backup.files.len(),
        days: 0,
        tasks: 0,
        long_tasks: 0,
        groups: 0,
        reminders: 0,
        exported_at: backup.exported_at.clone(),
        fingerprint: fingerprint(&bytes),
    };
    for file in &backup.files {
        match file.name.as_str() {
            "long-tasks.json" => {
                summary.long_tasks = check_tasks(&file.data["tasks"], 0, &mut HashSet::new())?
            }
            "tag-templates.json" => summary.groups = file.data["groups"].as_array().unwrap().len(),
            "reminders.json" => summary.reminders = file.data["rules"].as_array().unwrap().len(),
            _ => {
                summary.days += 1;
                summary.tasks += check_tasks(&file.data["tasks"], 0, &mut HashSet::new())?;
            }
        }
    }
    Ok((backup, summary))
}
fn gather(
    root: &Path,
    relative: &str,
    depth: usize,
    names: &mut Vec<String>,
) -> Result<(), String> {
    if depth > 3 {
        return Ok(());
    }
    let dir = if relative.is_empty() {
        root.to_path_buf()
    } else {
        root.join(relative)
    };
    if !dir.exists() {
        return Ok(());
    }
    if linked(&fs::symlink_metadata(&dir).map_err(|e| e.to_string())?) {
        return Err("日记录目录包含链接".into());
    }
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        let rel = if relative.is_empty() {
            name
        } else {
            format!("{relative}/{name}")
        };
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if linked(&fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?)
            && (validate_name(&rel).is_ok() || rel == "days" || rel.starts_with("days/"))
        {
            return Err("数据目录包含链接，请选择实际文件夹".into());
        }
        if kind.is_dir()
            && ((depth == 0 && rel == "days")
                || (depth == 1
                    && rel
                        .rsplit('/')
                        .next()
                        .is_some_and(|s| s.len() == 4 && s.bytes().all(|c| c.is_ascii_digit())))
                || (depth == 2
                    && rel
                        .rsplit('/')
                        .next()
                        .is_some_and(|s| s.len() == 2 && s.bytes().all(|c| c.is_ascii_digit()))))
        {
            gather(root, &rel, depth + 1, names)?;
        } else if kind.is_file() && validate_name(&rel).is_ok() {
            safe_file(root, &rel)?;
            names.push(rel);
        }
    }
    Ok(())
}
pub fn snapshot(root: &Path) -> Result<Vec<FileRecord>, String> {
    let mut names = Vec::new();
    gather(root, "", 0, &mut names)?;
    names.sort();
    let mut total = 0;
    let mut files = Vec::new();
    for name in names {
        let path = safe_file(root, &name)?;
        total += fs::metadata(&path).map_err(|e| e.to_string())?.len();
        if total > MAX_BYTES {
            return Err("数据超过 100 MiB，暂不支持整库操作".into());
        }
        files.push(FileRecord {
            name,
            data: read_value(&path)?,
        });
    }
    validate_records(&files)?;
    Ok(files)
}
pub fn atomic_value(path: &Path, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("数据超过 100 MiB，暂不支持整库操作".into());
    }
    let parent = path.parent().ok_or("无法解析数据目录")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    if fs::symlink_metadata(path).is_ok_and(|meta| linked(&meta)) {
        return Err("不支持写入链接文件".into());
    }
    let pending = parent.join(format!(".rizhi-pending-{}", stamp()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&pending)
            .map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(&pending, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(pending);
    }
    result
}
pub fn write_backup(path: &Path, backup: &Backup) -> Result<(), String> {
    atomic_value(
        path,
        &serde_json::to_value(backup).map_err(|e| e.to_string())?,
    )
}
pub fn automatic_backup(
    root: &Path,
    files: Vec<FileRecord>,
    preferences: Value,
) -> Result<Option<String>, String> {
    if files.is_empty() {
        return Ok(None);
    }
    let path = root.join(format!("rizhi-before-change-{}.json", stamp()));
    write_backup(&path, &Backup::new(files, preferences))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}
pub fn recover(root: &Path) -> Result<(), String> {
    let journal = root.join(JOURNAL);
    if !journal.exists() {
        return Ok(());
    }
    let plan = read_value(&journal)?;
    if plan["format"] != "rizhi-transfer-journal" {
        return Err("数据恢复日志无效，请先保留文件夹并联系支持".into());
    }
    let before: Vec<FileRecord> =
        serde_json::from_value(plan["before"].clone()).map_err(|e| e.to_string())?;
    validate_records(&before)?;
    let after: Vec<String> =
        serde_json::from_value(plan["after"].clone()).map_err(|e| e.to_string())?;
    for name in &after {
        validate_name(name)?;
        safe_file(root, name)?;
    }
    let originals: HashSet<_> = before.iter().map(|f| f.name.as_str()).collect();
    for name in after {
        if !originals.contains(name.as_str()) {
            let path = safe_file(root, &name)?;
            if path.exists() {
                fs::remove_file(path).map_err(|e| e.to_string())?;
            }
        }
    }
    for file in before {
        atomic_value(&safe_file(root, &file.name)?, &file.data)?;
    }
    fs::remove_file(journal).map_err(|e| e.to_string())
}
pub fn replace<F: FnMut(usize, usize, &str) -> Result<(), String>>(
    root: &Path,
    files: &[FileRecord],
    mut progress: F,
) -> Result<(), String> {
    recover(root)?;
    validate_records(files)?;
    let before = snapshot(root)?;
    for file in files {
        safe_file(root, &file.name)?;
    }
    atomic_value(
        &root.join(JOURNAL),
        &json!({"format":"rizhi-transfer-journal","before":before,"after":files.iter().map(|f|&f.name).collect::<Vec<_>>()}),
    )?;
    let result = (|| {
        let wanted: HashSet<_> = files.iter().map(|f| f.name.as_str()).collect();
        let total = files.len()
            + before
                .iter()
                .filter(|f| !wanted.contains(f.name.as_str()))
                .count();
        let mut done = 0;
        for file in files {
            atomic_value(&safe_file(root, &file.name)?, &file.data)?;
            done += 1;
            progress(done, total, &file.name)?;
        }
        for file in &before {
            if !wanted.contains(file.name.as_str()) {
                fs::remove_file(safe_file(root, &file.name)?).map_err(|e| e.to_string())?;
                done += 1;
                progress(done, total, &file.name)?;
            }
        }
        fs::remove_file(root.join(JOURNAL)).map_err(|e| e.to_string())
    })();
    if let Err(error) = result {
        recover(root).map_err(|recovery| format!("{error}；自动恢复失败：{recovery}"))?;
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn folder() -> PathBuf {
        let path = std::env::temp_dir().join(format!("rizhi-transfer-test-{}", stamp()));
        fs::create_dir_all(&path).unwrap();
        fs::canonicalize(path).unwrap()
    }
    fn day(date: &str, title: &str) -> FileRecord {
        FileRecord {
            name: format!("days/{}/{}/{}.json", &date[..4], &date[5..7], date),
            data: json!({"date":date,"note":"随笔","tasks":[{"id":"t","title":title,"status":"active","tags":[],"children":[]}]}),
        }
    }
    #[test]
    fn rejects_paths_and_duplicate_dates_before_writing() {
        assert!(validate_name("../evil.json").is_err());
        assert!(validate_name("days/2026/02/2026-02-30.json").is_err());
        assert!(validate_name("days/2024/02/2024-02-29.json").is_ok());
        assert!(validate_name("days/2025/01/2026-01-01.json").is_err());
        assert!(validate_records(&[day("2026-01-01", "a"), day("2026-01-01", "b")]).is_err());
    }
    #[test]
    fn export_roundtrip_preserves_nested_metadata() {
        let dir = folder();
        let mut record = day("2026-01-01", "a");
        record.data["tasks"][0]["flower"] = json!({"variant":"lotus","tone":"rose"});
        replace(&dir, &[record.clone()], |_, _, _| Ok(())).unwrap();
        let archive = dir.join("backup.json");
        write_backup(
            &archive,
            &Backup::new(
                snapshot(&dir).unwrap(),
                json!({"theme":{"surfaceStyle":"notebook"}}),
            ),
        )
        .unwrap();
        let (loaded, summary) = read_backup(&archive).unwrap();
        assert_eq!(summary.tasks, 1);
        assert_eq!(loaded.files[0].data, record.data);
        assert_eq!(loaded.preferences["theme"]["surfaceStyle"], "notebook");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn failed_commit_restores_all_originals_and_preserves_other_files() {
        let dir = folder();
        replace(&dir, &[day("2026-01-01", "old")], |_, _, _| Ok(())).unwrap();
        fs::write(dir.join("other.txt"), "keep").unwrap();
        let result = replace(
            &dir,
            &[day("2026-01-01", "new"), day("2026-01-02", "second")],
            |done, _, _| {
                if done == 1 {
                    Err("injected".into())
                } else {
                    Ok(())
                }
            },
        );
        assert!(result.is_err());
        let saved = snapshot(&dir).unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].data["tasks"][0]["title"], "old");
        assert_eq!(fs::read_to_string(dir.join("other.txt")).unwrap(), "keep");
        assert!(!dir.join(JOURNAL).exists());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn interrupted_import_recovers_on_next_open() {
        let dir = folder();
        let original = day("2026-01-01", "old");
        replace(&dir, &[original.clone()], |_, _, _| Ok(())).unwrap();
        atomic_value(&dir.join(JOURNAL),&json!({"format":"rizhi-transfer-journal","before":[original],"after":["days/2026/01/2026-01-01.json","days/2026/01/2026-01-02.json"]})).unwrap();
        atomic_value(
            &safe_file(&dir, "days/2026/01/2026-01-02.json").unwrap(),
            &day("2026-01-02", "new").data,
        )
        .unwrap();
        recover(&dir).unwrap();
        assert_eq!(snapshot(&dir).unwrap().len(), 1);
        fs::remove_dir_all(dir).unwrap();
    }
}
