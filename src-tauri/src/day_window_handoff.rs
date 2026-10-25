use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Mutex,
    },
};

type SaveResult = Result<(), String>;
type PendingSave = (String, mpsc::Sender<SaveResult>);

#[derive(Default)]
pub struct DayWindowHandoffs {
    sequence: AtomicU64,
    pending: Mutex<HashMap<String, PendingSave>>,
}

impl DayWindowHandoffs {
    pub fn begin(&self, label: &str) -> Result<(String, mpsc::Receiver<SaveResult>), String> {
        let id = format!(
            "day-handoff-{}",
            self.sequence.fetch_add(1, Ordering::Relaxed)
        );
        let (send, receive) = mpsc::channel();
        self.pending
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id.clone(), (label.into(), send));
        Ok((id, receive))
    }

    pub fn finish(&self, label: &str, id: &str, error: Option<String>) -> Result<(), String> {
        let mut pending = self.pending.lock().map_err(|e| e.to_string())?;
        if !pending
            .get(id)
            .is_some_and(|(expected, _)| expected == label)
        {
            return Err("日视图交接已取消，请重试".into());
        }
        let (_, send) = pending.remove(id).unwrap();
        send.send(error.map_or(Ok(()), Err))
            .map_err(|_| "日视图交接已超时，请重试".into())
    }

    pub fn cancel(&self, id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_requested_window_can_acknowledge_its_saved_data() {
        let state = DayWindowHandoffs::default();
        let (id, receive) = state.begin("main").unwrap();
        assert!(state.finish("day-other", &id, None).is_err());
        assert!(receive.try_recv().is_err());
        state.finish("main", &id, None).unwrap();
        assert_eq!(receive.recv().unwrap(), Ok(()));
        assert!(state.finish("main", &id, None).is_err());
    }

    #[test]
    fn failed_save_and_cancelled_requests_never_acknowledge_success() {
        let state = DayWindowHandoffs::default();
        let (failed, receive) = state.begin("main").unwrap();
        state
            .finish("main", &failed, Some("保存失败".into()))
            .unwrap();
        assert_eq!(receive.recv().unwrap(), Err("保存失败".into()));
        let (cancelled, receive) = state.begin("main").unwrap();
        state.cancel(&cancelled);
        assert!(state.finish("main", &cancelled, None).is_err());
        assert!(receive.recv().is_err());
    }
}
