# 默认提醒音效

- `plop.ogg`：用户提供的原始音频，2026-11-06 选为“默认”音效。
- `plop.wav`：从原始音频转换的 22050 Hz、单声道、16 位 PCM WAV，约 0.173 秒，未调整音量、音调或裁剪。
- Rust 通过 `include_bytes!` 内置 WAV，播放无需访问外部音频文件。

转换使用 FFmpeg 解码和重采样（`-ac 1 -ar 22050 -acodec pcm_s16le -f s16le`），再用 Python `wave` 写入标准 44 字节 WAV 头，以符合原生音频校验。

原始文件 SHA-256：`652eaa41a72b68809c7c36dd8ad766b6522612497ab94df25f3bcfa114e27960`。
