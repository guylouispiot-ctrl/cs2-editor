
use serde::Deserialize;
use std::process::Command;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn check_ffmpeg() -> Result<String, String> {
    let output = Command::new("ffmpeg")
        .arg("-version")
        .output()
        .map_err(|e| format!("Impossible de lancer FFmpeg : {}", e))?;

    if !output.status.success() {
        return Err("FFmpeg a renvoyé une erreur.".to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or("FFmpeg détecté")
        .to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportClip {
    source_path: String,
    start: f64,
    end: f64,
    position: f64,
    freeze_frame_time: Option<f64>,
}

#[tauri::command]

fn export_video(
    clips: Vec<ExportClip>,
    output_path: String,
) -> Result<String, String> {
    if clips.is_empty() {
        return Err("La timeline ne contient aucun clip vidéo.".to_string());
    }

    if output_path.trim().is_empty() {
        return Err("Le chemin du fichier de sortie est vide.".to_string());
    }

    for clip in &clips {
        if !clip.start.is_finite()
            || !clip.end.is_finite()
            || !clip.position.is_finite()
            || clip.start < 0.0
            || clip.end <= clip.start
            || clip.position < 0.0
            || clip.freeze_frame_time.map(|time| {
                !time.is_finite() || time < 0.0
            }).unwrap_or(false)
        {
            return Err(
                "Un clip contient des valeurs de durée ou de position invalides."
                    .to_string(),
            );
        }
    }

    let total_duration = clips
        .iter()
        .map(|clip| clip.position + clip.end - clip.start)
        .fold(0.0_f64, f64::max);

    let mut command = Command::new("ffmpeg");
    command.arg("-y");

    for clip in &clips {
        command.arg("-i").arg(&clip.source_path);
    }

    let mut filter = format!(
        "color=c=black:s=1920x1080:r=60:d={:.6},format=yuv420p[base0]",
        total_duration
    );

    let mut previous = "base0".to_string();
    let mut audio_labels: Vec<String> = Vec::new();

    for (index, clip) in clips.iter().enumerate() {
        let duration = clip.end - clip.start;
        let clip_end = clip.position + duration;

        // Vidéo : découpe normale ou maintien de la première frame.
        if let Some(freeze_time) = clip.freeze_frame_time {
            filter.push_str(&format!(
                ";[{}:v]trim=start={:.6},select='eq(n,0)',\
setpts=PTS-STARTPTS,\
tpad=stop_mode=clone:stop_duration={:.6},\
trim=duration={:.6},\
setpts=PTS-STARTPTS+{:.6}/TB,\
scale=1920:1080:force_original_aspect_ratio=decrease,\
pad=1920:1080:(ow-iw)/2:(oh-ih)/2,\
fps=60,format=yuv420p[v{}]",
                index,
                freeze_time,
                duration,
                duration,
                clip.position,
                index
            ));
        } else {
            filter.push_str(&format!(
                ";[{}:v]trim=start={:.6}:end={:.6},\
setpts=PTS-STARTPTS+{:.6}/TB,\
scale=1920:1080:force_original_aspect_ratio=decrease,\
pad=1920:1080:(ow-iw)/2:(oh-ih)/2,\
fps=60,format=yuv420p[v{}]",
                index,
                clip.start,
                clip.end,
                clip.position,
                index
            ));
        }

        let next = format!("base{}", index + 1);

        filter.push_str(&format!(
            ";[{}][v{}]overlay=eof_action=pass:\
enable='between(t,{:.6},{:.6})'[{}]",
            previous,
            index,
            clip.position,
            clip_end,
            next
        ));

        previous = next;

        // Audio : récupère le son s'il existe dans la vidéo.
        // atrim utilise les mêmes limites que la découpe vidéo.

        // Audio : découpe exactement la même portion que la vidéo.
        // Normalise le format et complète avec du silence si nécessaire.
        let audio_label = format!("a{}", index);

        filter.push_str(&format!(
            ";[{}:a]atrim=start={:.6}:duration={:.6},\
            asetpts=PTS-STARTPTS,\
            aresample=48000,\
            aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,\
            apad=whole_dur={:.6},\
            atrim=duration={:.6}[{}]",
            index,
            clip.start,
            duration,
            duration,
            duration,
            audio_label
        ));

        audio_labels.push(format!("[{}]", audio_label));
    }

    
    // Assemble les sons dans l'ordre des clips vidéo.
    // Comme les clips se suivent, on concatène au lieu de les mélanger.
    if !audio_labels.is_empty() {
        filter.push_str(&format!(
            ";{}concat=n={}:v=0:a=1[aout]",
            audio_labels.join(""),
            audio_labels.len()
        ));
    }

    command
        .arg("-filter_complex")
        .arg(filter)
        .arg("-map")
        .arg(format!("[{}]", previous));

    if !audio_labels.is_empty() {
        command.arg("-map").arg("[aout]");
    }

    command
        .arg("-t")
        .arg(format!("{:.6}", total_duration))
        .arg("-c:v")
        .arg("libx264")
        .arg("-preset")
        .arg("medium")
        .arg("-crf")
        .arg("18")
        .arg("-pix_fmt")
        .arg("yuv420p")
        .arg("-c:a")
        .arg("aac")
        .arg("-b:a")
        .arg("192k")
        .arg("-ar")
        .arg("48000")
        .arg("-movflags")
        .arg("+faststart")
        .arg(&output_path);

    let output = command
        .output()
        .map_err(|e| format!("Impossible de lancer FFmpeg : {}", e))?;

    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr);
        let details: String = error
            .chars()
            .rev()
            .take(4000)
            .collect::<String>()
            .chars()
            .rev()
            .collect();

        return Err(format!("Échec de l'export FFmpeg :\n{}", details));
    }

    Ok(format!("Export terminé : {}", output_path))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            check_ffmpeg,
            export_video
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}