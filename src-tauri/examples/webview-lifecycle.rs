//! No DevTools/CDP: exercise the real Windows runtime in an isolated data directory.
//! cargo run --manifest-path src-tauri/Cargo.toml --example webview-lifecycle
#[path = "../src/webview_process.rs"]
mod webview_process;

use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::Manager;

fn debug_log(line: &str) {
    println!("{line}");
}

fn main() {
    // Prevent an inherited debugger setting from changing process lifetime.
    std::env::remove_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");
    let ticks = Arc::new(AtomicUsize::new(0));
    let count = ticks.clone();
    std::thread::spawn(move || loop {
        count.fetch_add(1, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(10));
    });
    let data = std::env::temp_dir().join(format!("dsh-webview-proof-{}", std::process::id()));
    tauri::Builder::default()
        .setup(move |app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let result = (|| -> Result<(), String> {
                    for cycle in 1..=20 {
                        let window = tauri::WebviewWindowBuilder::new(
                            &handle,
                            "proof",
                            tauri::WebviewUrl::App("index.html".into()),
                        )
                        .data_directory(data.clone())
                        .visible(false)
                        .build()
                        .map_err(|e| e.to_string())?;
                        std::thread::sleep(Duration::from_millis(400));
                        let processes = webview_process::ProcessSet::capture(&window)?;
                        let before = ticks.load(Ordering::SeqCst);
                        window.destroy().map_err(|e| e.to_string())?;
                        drop(window);
                        processes.wait_for_exit(Duration::from_secs(5))?;
                        let until = std::time::Instant::now() + Duration::from_secs(2);
                        while handle.get_webview_window("proof").is_some() {
                            if std::time::Instant::now() >= until {
                                return Err("window-not-removed".into());
                            }
                            std::thread::sleep(Duration::from_millis(20));
                        }
                        std::thread::sleep(Duration::from_millis(100));
                        if ticks.load(Ordering::SeqCst) <= before {
                            return Err("background-stopped".into());
                        }
                        println!("cycle={cycle} zero_windows=true background_alive=true");
                    }
                    Ok(())
                })();
                match result {
                    Ok(()) => {
                        println!("PASS: 20 destroy/recreate cycles, all owned processes exited");
                        handle.exit(0);
                    }
                    Err(error) => {
                        eprintln!("FAIL: {error}");
                        handle.exit(1);
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("build proof")
        .run(|_, event| {
            if let tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } = event
            {
                api.prevent_exit();
            }
        });
}
