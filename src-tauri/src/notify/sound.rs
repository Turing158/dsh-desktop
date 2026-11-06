//! Native sound playback remains available while the webview is suspended.
use base64::Engine;
use std::sync::Mutex;

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Preferences {
    pub enabled: bool,
    pub sound_enabled: bool,
    pub sound: String,
    pub custom_name: String,
    pub custom_audio: String,
}
impl Default for Preferences {
    fn default() -> Self {
        Self { enabled: true, sound_enabled: true, sound: "system".into(), custom_name: String::new(), custom_audio: String::new() }
    }
}
impl Preferences {
    pub fn valid(&self) -> bool {
        matches!(self.sound.as_str(), "system" | "default" | "custom")
            && self.custom_name.chars().count() <= 255
            && (self.custom_audio.is_empty() && self.sound != "custom" || decode(&self.custom_audio).is_ok())
    }
    pub fn system_audio(&self) -> bool { self.enabled && self.sound_enabled && self.sound == "system" }
}

fn decode(data: &str) -> Result<Vec<u8>, String> {
    if data.len() > 1_800_000 { return Err("invalid-notification-audio".into()); }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.strip_prefix("data:audio/wav;base64,").ok_or("invalid-notification-audio")?)
        .map_err(|_| "invalid-notification-audio")?;
    // Accept only the bounded canonical PCM format emitted by the importer.
    if bytes.len() < 46 || &bytes[0..4] != b"RIFF" || &bytes[8..16] != b"WAVEfmt "
        || &bytes[36..40] != b"data" { return Err("invalid-notification-audio".into()); }
    let u16_at = |i| u16::from_le_bytes([bytes[i], bytes[i+1]]);
    let u32_at = |i| u32::from_le_bytes(bytes[i..i+4].try_into().unwrap());
    if u32_at(4) as u64 + 8 != bytes.len() as u64 || u32_at(16) != 16 || u16_at(20) != 1
        || u16_at(22) != 1 || u32_at(24) != 22050 || u32_at(28) != 44100
        || u16_at(32) != 2 || u16_at(34) != 16 || u32_at(40) as u64 + 44 != bytes.len() as u64
        || (bytes.len() - 44) % 2 != 0 || bytes.len() > 44 + 44100 * 30 {
        return Err("invalid-notification-audio".into());
    }
    Ok(bytes)
}

fn default_clip() -> Vec<u8> {
    // Embed the user's plop clip so playback works offline and from the tray.
    include_bytes!("../../assets/sounds/plop.wav").to_vec()
}

// PlaySound retains the memory in async mode. Stop before replacing/dropping it.
#[derive(Default)]
pub struct Player(Mutex<Vec<u8>>);
#[cfg(windows)]
#[link(name = "winmm")]
extern "system" {
    fn PlaySoundW(sound: *const u16, module: *mut std::ffi::c_void, flags: u32) -> i32;
}
#[cfg(windows)]
const SND_ASYNC: u32 = 0x0001;
#[cfg(windows)]
const SND_NODEFAULT: u32 = 0x0002;
#[cfg(windows)]
const SND_MEMORY: u32 = 0x0004;
#[cfg(windows)]
const SND_ALIAS: u32 = 0x10000;
impl Player {
    pub fn play(&self, prefs: &Preferences) -> Result<(), String> {
        if !prefs.valid() { return Err("invalid-notification-audio".into()); }
        #[cfg(windows)]
        {
            let mut buffer = self.0.lock().map_err(|_| "notification-audio-busy")?;
            unsafe { PlaySoundW(std::ptr::null(), std::ptr::null_mut(), 0); }
            let (pointer, flags) = if prefs.sound == "system" {
                // Windows' notification alias follows the user's sound scheme.
                let alias: Vec<u16> = "Notification.Default\0".encode_utf16().collect();
                let ok = unsafe { PlaySoundW(alias.as_ptr(), std::ptr::null_mut(), SND_ALIAS | SND_ASYNC | SND_NODEFAULT) };
                return if ok != 0 { Ok(()) } else { Err("notification-audio-unavailable".into()) };
            } else {
                *buffer = if prefs.sound == "custom" { decode(&prefs.custom_audio)? } else { default_clip() };
                (buffer.as_ptr().cast::<u16>(), SND_MEMORY | SND_ASYNC | SND_NODEFAULT)
            };
            if unsafe { PlaySoundW(pointer, std::ptr::null_mut(), flags) } == 0 { return Err("notification-audio-unavailable".into()); }
            Ok(())
        }
        #[cfg(not(windows))]
        Err("notification-audio-unavailable".into())
    }
    pub fn stop(&self) {
        if let Ok(mut buffer) = self.0.lock() {
            #[cfg(windows)]
            unsafe { PlaySoundW(std::ptr::null(), std::ptr::null_mut(), 0); }
            buffer.clear();
        }
    }
}
impl Drop for Player { fn drop(&mut self) { self.stop(); } }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_pcm_and_rejects_malformed_or_oversized_clips() {
        let clip = default_clip();
        let data = |bytes: &[u8]| format!("data:audio/wav;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes));
        assert_eq!(decode(&data(&clip)).unwrap(), clip);
        for bytes in [&clip[..20], &clip[..clip.len()-1], b"not audio"] { assert!(decode(&data(bytes)).is_err()); }
        let mut bad_length = clip.clone();
        bad_length[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(decode(&data(&bad_length)).is_err());
        assert!(decode("https://example.com/a.wav").is_err());
        assert!(!Preferences { sound: "custom".into(), ..Default::default() }.valid());
        assert!(!Preferences { custom_audio: "x".repeat(1_800_001), ..Default::default() }.valid());
    }
    #[test]
    fn sound_and_notification_switches_control_system_audio() {
        assert!(Preferences::default().system_audio());
        for prefs in [Preferences { enabled: false, ..Default::default() }, Preferences { sound_enabled: false, ..Default::default() }, Preferences { sound: "default".into(), ..Default::default() }] {
            assert!(!prefs.system_audio());
        }
    }
}
