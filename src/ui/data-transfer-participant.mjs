import { flushReminderWork } from '../storage/reminder-service.mjs';

export const isDataTransferBusy = () => Boolean(window.calendarDataTransferBusy);

// Every native window flushes its own drafts before a store is read or replaced.
// The Rust coordinator holds the window lease until the filesystem work finishes.
export function registerDataTransferParticipant({ root, prepare, reload }) {
  if (!window.__TAURI__?.event?.listen) return;
  const label = window.__TAURI__.window?.getCurrentWindow?.().label;
  const options = label ? { target: label } : undefined;
  let lease = null;
  let settling = Promise.resolve();
  const unlisteners = [];
  const invoke = (name, args) => window.__TAURI__.core.invoke(name, args);
  const register = async () => {
    unlisteners.push(
      await window.__TAURI__.event.listen(
        'calendar://data-transfer-request',
        async ({ payload }) => {
          if (payload.windowLabel && payload.windowLabel !== label) return;
          // A following operation can arrive while the previous end event is still
          // loading the new store. Finish that refresh before taking its next lease.
          await settling;
          if (lease) {
            await invoke('complete_data_transfer', {
              id: payload.id,
              error: '窗口正在处理另一项数据操作，请稍后重试',
            });
            return;
          }
          lease = payload.id;
          window.calendarDataTransferBusy = true;
          root.inert = true;
          let error = null;
          try {
            await prepare?.();
            await flushReminderWork();
          } catch (reason) {
            error = String(reason.message || reason);
          }
          await invoke('complete_data_transfer', { id: lease, error }).catch(console.error);
        },
        options,
      ),
    );
    unlisteners.push(
      await window.__TAURI__.event.listen(
        'calendar://data-transfer-end',
        async ({ payload }) => {
          if ((payload.windowLabel && payload.windowLabel !== label) || payload.id !== lease) return;
          settling = (async () => {
            try {
              if (payload.reload) await reload?.();
            } catch (error) {
              console.error(error);
            } finally {
              lease = null;
              window.calendarDataTransferBusy = false;
              root.inert = false;
            }
          })();
          await settling;
        },
        options,
      ),
    );
  };
  register().catch(console.error);
  window.addEventListener('beforeunload', () => unlisteners.forEach((unlisten) => unlisten()), {
    once: true,
  });
}
