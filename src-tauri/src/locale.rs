//! Cached presentation language for native chrome before the DSH locale service starts.
//! DSH remains the preference owner; this cache is only updated by its active locale.
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
#[derive(Default)]
pub struct NativeLocale(pub Mutex<Option<String>>);
pub fn current(app: &AppHandle) -> Option<String> {
    let state = app.state::<NativeLocale>();
    let mut value = state.0.lock().ok()?;
    if value.is_none() {
        *value = app.path().app_data_dir().ok().and_then(|p| std::fs::read_to_string(p.join("locale-cache.txt")).ok())
            .filter(|s| s == "en" || s == "zh");
    }
    value.clone()
}
pub fn text<'a>(app: &AppHandle, zh: &'a str, en: &'a str) -> &'a str {
    if current(app).as_deref() == Some("en") { en } else { zh }
}
#[tauri::command]
pub fn desktop_locale_changed(app: AppHandle, locale: String) -> Result<(), String> {
    let language = if locale.to_lowercase().starts_with("zh") { "zh" } else { "en" };
    if current(&app).as_deref() == Some(language) { return Ok(()); }
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    std::fs::write(path.join("locale-cache.txt"), language).map_err(|e| e.to_string())?;
    *app.state::<NativeLocale>().0.lock().map_err(|e| e.to_string())? = Some(language.into());
    crate::tray::sync_checkmark(&app);
    Ok(())
}
pub fn initialization_script(app: &AppHandle) -> String {
    format!("window.__DSH_I18N_INITIAL__ = {};\nwindow.__DSH_I18N_MESSAGES__ = {};\n{}",
        serde_json::to_string(&current(app)).unwrap(),
        include_str!("../../dsh-plugin/i18n/en.json"),
        include_str!("../../dsh-plugin/i18n/runtime.js"))
}
