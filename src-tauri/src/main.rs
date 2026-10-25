// Release builds are desktop GUI apps; avoid allocating a console and its host process.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    desktop_calendar_lib::run()
}
