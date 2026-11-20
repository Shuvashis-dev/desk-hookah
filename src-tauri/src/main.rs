// Desk Hookah, created by Shuvashis Gautam. MIT License (see LICENSE).

// Hide the console window in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    desk_hookah_lib::run()
}
