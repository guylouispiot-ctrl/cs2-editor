import {
  useState,
  useRef,
  type MouseEvent,
  type SyntheticEvent,
} from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import "./App.css";

type MediaFile = {
  path: string;
  name: string;
  type: "video" | "audio";
  duration?: number;
  thumbnail?: string;
};

type TimelineClip = {
  id: string;
  sourcePath: string;
  sourceName: string;

  // Partie utilisée dans la vidéo source
  start: number;
  end: number;

  // Position du clip dans la timeline
  position: number;
  freezeFrameTime?: number;
  freezeFrameSrc?: string;
};

type TimelineAudioClip = {
  id: string;
  sourcePath: string;
  sourceName: string;
  start: number;
  end: number;
  position: number;
  track: "voice" | "audio";
};

type VideoFrame = {
  time: number;
  src: string;
};

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds)) {
    return "00:00";
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);

  return `${String(minutes).padStart(2, "0")}:${String(
    remainingSeconds
  ).padStart(2, "0")}`;
}

function getClipDuration(clip: TimelineClip) {
  return Math.max(0, clip.end - clip.start);
}

function getTimelineEnd(clip: TimelineClip) {
  return clip.position + getClipDuration(clip);
}

function getSourceTimeAtTimelinePosition(
  clip: TimelineClip,
  timelineTime: number
) {
  return clip.start + (timelineTime - clip.position);
}

function getTimelinePositionAtSourceTime(
  clip: TimelineClip,
  sourceTime: number
) {
  return clip.position + (sourceTime - clip.start);
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const captureVideoFrameAtTime = async (
  sourcePath: string,
  time: number
): Promise<string> => {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;

  try {
    await new Promise<void>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        cleanup();
        reject(new Error("La vidéo met trop de temps à charger."));
      }, 15000);
      const cleanup = () => {
        window.clearTimeout(timeoutId);
        video.onloadedmetadata = null;
        video.onerror = null;
      };

      video.onloadedmetadata = () => {
        cleanup();
        resolve();
      };
      video.onerror = () => {
        cleanup();
        reject(new Error("Impossible de lire l’image à figer."));
      };
      video.src = convertFileSrc(sourcePath);
      video.load();
    });

    const frameTime = clamp(time, 0, Math.max(0, video.duration - 0.001));
    await new Promise<void>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        cleanup();
        reject(new Error("La recherche de l’image a expiré."));
      }, 10000);
      const cleanup = () => {
        window.clearTimeout(timeoutId);
        video.onseeked = null;
        video.onloadeddata = null;
        video.onerror = null;
      };
      const ready = () => {
        cleanup();
        resolve();
      };

      video.onseeked = ready;
      video.onerror = () => {
        cleanup();
        reject(new Error("Impossible de rechercher l’image à figer."));
      };

      if (Math.abs(video.currentTime - frameTime) < 0.01) {
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          ready();
        } else {
          video.onloadeddata = ready;
        }
      } else {
        video.currentTime = frameTime;
      }
    });

    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Impossible de créer l’image fixe.");
    }

    context.fillStyle = "#090a0d";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const scale = Math.min(
      canvas.width / video.videoWidth,
      canvas.height / video.videoHeight
    );
    const width = video.videoWidth * scale;
    const height = video.videoHeight * scale;
    context.drawImage(
      video,
      (canvas.width - width) / 2,
      (canvas.height - height) / 2,
      width,
      height
    );
    return canvas.toDataURL("image/jpeg", 0.9);
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
};

function App() {
  
  const [isExporting, setIsExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState("");

  const handleExport = async () => {
    if (isExporting) return;

    if (videoClips.length === 0) {
      setExportMessage("Ajoute au moins un clip vidéo à la timeline.");
      return;
    }

    try {
      const outputPath = await save({
        title: "Exporter le montage CS2",
        defaultPath: "montage-cs2.mp4",
        filters: [
          {
            name: "Vidéo MP4",
            extensions: ["mp4"],
          },
        ],
      });

      if (!outputPath) return;

      setIsExporting(true);
      setExportMessage("Export en cours…");

      const clips = [...videoClips]
        .sort((a, b) => a.position - b.position)
        .map((clip) => ({
          sourcePath: clip.sourcePath,
          start: clip.start,
          end: clip.end,
          position: clip.position,
          freezeFrameTime: clip.freezeFrameTime ?? null,
        }));

      const result = await invoke<string>("export_video", {
        clips,
        outputPath,
      });

      setExportMessage(result);
    } catch (error) {
      setExportMessage(`Erreur d'export : ${String(error)}`);
    } finally {
      setIsExporting(false);
    }
  };
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const transitioningToClipRef = useRef<string | null>(null);
  const startingPendingPlayRef = useRef<string | null>(null);

  const [mediaFiles, setMediaFiles] = useState<MediaFile[]>([]);
  const [selectedVideo, setSelectedVideo] =
    useState<MediaFile | null>(null);

  const [videoClips, setVideoClips] = useState<TimelineClip[]>([]);
  const [activeClipId, setActiveClipId] =
    useState<string | null>(null);

  const [audioClips, setAudioClips] = useState<TimelineAudioClip[]>([]);
  const [waveformCache, setWaveformCache] = useState<
  Record<string, number[]>
>({});
  const [activeAudioClipId, setActiveAudioClipId] = useState<string | null>(null);
  const [activeAudioTrim, setActiveAudioTrim] = useState<"start" | "end" | null>(null);

  const [playheadTime, setPlayheadTime] = useState(0);
  const [freezeDuration, setFreezeDuration] = useState(2);
  const [pendingPlayClipId, setPendingPlayClipId] =
  useState<string | null>(null);
  const [timelineScale, setTimelineScale] = useState(15);
  const [videoFrames, setVideoFrames] = useState<Record<string, VideoFrame[]>>({});

  const [trimMode, setTrimMode] = useState<
    "start" | "end" | null
  >(null);

  /*
   * -------------------------------------------------------
   * IMPORT
   * -------------------------------------------------------
   */

  const importMedia = async () => {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [
        {
          name: "Médias",
          extensions: [
            "mp4",
            "mov",
            "mkv",
            "webm",
            "avi",
            "mp3",
            "wav",
            "m4a",
            "ogg",
            "flac",
          ],
        },
      ],
    });

    if (!selected) {
      return;
    }

    const files = Array.isArray(selected)
      ? selected
      : [selected];

    const newFiles: MediaFile[] = files.map((path) => {
      const fileName =
        path.split("\\").pop() ?? path;

      const extension = fileName
        .split(".")
        .pop()
        ?.toLowerCase();

      const audioExtensions = [
        "mp3",
        "wav",
        "m4a",
        "ogg",
        "flac",
      ];

      return {
        path,
        name: fileName,
        type: audioExtensions.includes(
          extension ?? ""
        )
          ? "audio"
          : "video",
      };
    });

    setMediaFiles((current) => [
      ...current,
      ...newFiles,
    ]);

    for (const file of newFiles.filter((item) => item.type === "audio")) {
      void generateWaveform(file);
    }

    for (const file of newFiles.filter((item) => item.type === "video")) {
      void generateVideoThumbnail(file);
    }
  };

  /*
   * -------------------------------------------------------
   * SELECTION D'UNE VIDEO
   * -------------------------------------------------------
   */

 
  const selectVideo = (file: MediaFile) => {
    setActiveAudioClipId(null);
    void generateVideoThumbnail(file);

    const existingClip = videoClips.find(
      (clip) => clip.sourcePath === file.path
    );

    setSelectedVideo(file);
    setPendingPlayClipId(null);
    videoRef.current?.pause();

    if (existingClip) {
      setActiveClipId(existingClip.id);
      setPlayheadTime(existingClip.position);
      return;
    }

    // Calcule la fin de la dernière vidéo sur la timeline
    const timelineEnd = videoClips.reduce(
      (latestEnd, clip) =>
        Math.max(latestEnd, clip.position + (clip.end - clip.start)),
      0
    );

    const newClip: TimelineClip = {
      id: `${Date.now()}-${Math.random()}`,
      sourcePath: file.path,
      sourceName: file.name,
      start: 0,
      end: file.duration ?? 0,
      position: timelineEnd,
    };

    setVideoClips((currentClips) => [
      ...currentClips,
      newClip,
    ]);

    setActiveClipId(newClip.id);
    setPlayheadTime(newClip.position);
  };

  /*
   * -------------------------------------------------------
   * SELECTION D'UN CLIP DE LA TIMELINE
   * -------------------------------------------------------
   */

  const selectTimelineClip = (
    clip: TimelineClip
  ) => {
    setActiveAudioClipId(null);
    setActiveClipId(clip.id);
    setPendingPlayClipId(null);
    videoRef.current?.pause();

    const file = mediaFiles.find(
      (media) => media.path === clip.sourcePath
    );

    if (file) {
      setSelectedVideo(file);
    }

    setPlayheadTime(clip.position);

    requestAnimationFrame(() => {
      if (videoRef.current) {
        videoRef.current.currentTime =
          clip.start;
      }
    });
  };

  /*
   * -------------------------------------------------------
   * DEPLACER UN CLIP
   * -------------------------------------------------------
   */
const handleClipMouseDown = (
  event: MouseEvent<HTMLDivElement>,
  clipId: string
) => {
  // Si on clique sur une poignée de trim,
  // on laisse le trim gérer le clic.
  const target = event.target as HTMLElement;

  if (target.closest(".trim-handle")) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  const clip = videoClips.find(
    (item) => item.id === clipId
  );

  if (!clip) return;

  setActiveClipId(clipId);

  const startMouseX = event.clientX;
  const originalPosition = clip.position;

  const handleMouseMove = (
    moveEvent: globalThis.MouseEvent
  ) => {
    const deltaX =
      moveEvent.clientX - startMouseX;

    const deltaTime = deltaX / timelineScale;

    const newPosition = Math.max(
      0,
      originalPosition + deltaTime
    );

    setVideoClips((currentClips) =>
      currentClips.map((item) =>
        item.id === clipId
          ? {
              ...item,
              position: newPosition,
            }
          : item
      )
    );
  };

  const handleMouseUp = () => {
    window.removeEventListener(
      "mousemove",
      handleMouseMove
    );

    window.removeEventListener(
      "mouseup",
      handleMouseUp
    );
  };

  window.addEventListener(
    "mousemove",
    handleMouseMove
  );

  window.addEventListener(
    "mouseup",
    handleMouseUp
  );
};

  const generateVideoThumbnail = async (file: MediaFile) => {
    if (!file.path || videoFrames[file.path]?.length) {
      return;
    }

    if (typeof document === "undefined") {
      return;
    }

    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = "anonymous";

    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          video.onloadedmetadata = null;
          video.onerror = null;
        };

        video.onloadedmetadata = () => {
          cleanup();
          resolve();
        };

        video.onerror = () => {
          cleanup();
          reject(new Error("Impossible de charger la vidéo pour la timeline."));
        };

        video.src = convertFileSrc(file.path);
        video.load();
      });

      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      const interval = duration > 0 ? Math.min(10, Math.max(5, duration / 12)) : 5;
      const frames: VideoFrame[] = [];

      const captureAt = async (time: number) => {
        await new Promise<void>((resolve, reject) => {
          let timeoutId: number;
          const cleanup = () => {
            video.onseeked = null;
            video.onloadeddata = null;
            video.onerror = null;
            window.clearTimeout(timeoutId);
          };

          const captureFrame = () => {
            try {
              const canvas = document.createElement("canvas");
              canvas.width = 220;
              canvas.height = 124;

              const context = canvas.getContext("2d");
              if (!context) {
                throw new Error("Impossible de créer le canvas des miniatures.");
              }

              context.fillStyle = "#111318";
              context.fillRect(0, 0, canvas.width, canvas.height);

              const sourceWidth = video.videoWidth || canvas.width;
              const sourceHeight = video.videoHeight || canvas.height;
              const ratio = Math.min(canvas.width / sourceWidth, canvas.height / sourceHeight);
              const drawWidth = sourceWidth * ratio;
              const drawHeight = sourceHeight * ratio;
              const x = (canvas.width - drawWidth) / 2;
              const y = (canvas.height - drawHeight) / 2;

              context.drawImage(video, x, y, drawWidth, drawHeight);
              const frame = {
                time,
                src: canvas.toDataURL("image/jpeg", 0.82),
              };
              frames.push(frame);
              setVideoFrames((current) => ({
                ...current,
                [file.path]: [...(current[file.path] ?? []), frame].sort(
                  (left, right) => left.time - right.time
                ),
              }));

              if (time === 0) {
                setMediaFiles((current) =>
                  current.map((item) =>
                    item.path === file.path && !item.thumbnail
                      ? { ...item, thumbnail: frame.src }
                      : item
                  )
                );
              }

              cleanup();
              resolve();
            } catch (error) {
              cleanup();
              reject(error);
            }
          };

          const requestedTime = Math.min(
            Math.max(time, 0),
            Math.max(duration, 0)
          );

          video.onseeked = captureFrame;
          video.onerror = () => {
            cleanup();
            reject(new Error("Erreur de capture de la miniature."));
          };
          timeoutId = window.setTimeout(() => {
            cleanup();
            reject(new Error("Délai dépassé pendant la capture d’une miniature."));
          }, 10000);

          if (Math.abs(video.currentTime - requestedTime) < 0.01) {
            if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
              captureFrame();
            } else {
              video.onloadeddata = captureFrame;
            }
            return;
          }

          try {
            video.currentTime = requestedTime;
          } catch {
            cleanup();
            resolve();
          }
        });
      };

      const maxFrames = Math.max(1, Math.ceil(duration / interval));
      for (let index = 0; index < maxFrames; index += 1) {
        const time = Math.min(index * interval, duration || 0);
        if (duration > 0 && time <= duration + 0.01) {
          await captureAt(time);
        }
      }

      setVideoFrames((current) => ({
        ...current,
        [file.path]: frames,
      }));

      setMediaFiles((current) =>
        current.map((item) =>
          item.path === file.path && !item.thumbnail
            ? { ...item, thumbnail: frames[0]?.src ?? item.thumbnail }
            : item
        )
      );
    } catch (error) {
      console.warn("Miniatures vidéo non disponibles :", file.name, error);
    }
  };

  const generateWaveform = async (file: MediaFile) => {
    if (waveformCache[file.path]) {
      return;
    }

    let audioContext: AudioContext | null = null;

    try {
      const audioUrl = convertFileSrc(file.path);
      const response = await fetch(audioUrl);

      if (!response.ok) {
        throw new Error(
          `Impossible de lire le fichier audio : ${response.status}`
        );
      }

      const arrayBuffer = await response.arrayBuffer();

      audioContext = new window.AudioContext();

      const audioBuffer = await audioContext.decodeAudioData(
        arrayBuffer
      );

      const channel = audioBuffer.getChannelData(0);
      const numberOfBars = 160;
      const samplesPerBar = Math.max(
        1,
        Math.floor(channel.length / numberOfBars)
      );

      const peaks: number[] = [];

      for (let i = 0; i < numberOfBars; i++) {
        const start = i * samplesPerBar;
        const end = Math.min(
          start + samplesPerBar,
          channel.length
        );

        let peak = 0;

        for (let j = start; j < end; j++) {
          peak = Math.max(peak, Math.abs(channel[j]));
        }

        peaks.push(peak);
      }

      const maxPeak = Math.max(...peaks, 0.001);

      const normalizedPeaks = peaks.map((peak) => {
        const normalized = peak / maxPeak;
        return Math.max(0.12, Math.pow(normalized, 0.65));
      });

      console.log(
        "Spectre audio calculé :",
        file.name,
        normalizedPeaks.length,
        normalizedPeaks.slice(0, 10)
      );

      setWaveformCache((current) => ({
        ...current,
        [file.path]: normalizedPeaks,
      }));
    } catch (error) {
      console.error(
        "Erreur lors de la création de la forme d'onde :",
        error
      );
    } finally {
      if (audioContext && audioContext.state !== "closed") {
        await audioContext.close();
      }
    }
  };

  const addAudioToTimeline = (
    file: MediaFile,
    track: "voice" | "audio" = "audio"
  ) => {
    console.log("Ajout d'un fichier audio à la timeline :", file.name);
    void generateWaveform(file);
    const existing = audioClips.find(
      (clip) => clip.sourcePath === file.path && clip.track === track
    );
    if (existing) {
      setActiveAudioClipId(existing.id);
      return;
    }

    const newClip: TimelineAudioClip = {
      id: `${Date.now()}-${Math.random()}`,
      sourcePath: file.path,
      sourceName: file.name,
      start: 0,
      end: file.duration ?? 0,
      position: playheadTime,
      track,
    };
    setAudioClips((current) => [...current, newClip]);
    setActiveAudioClipId(newClip.id);
    setActiveClipId(null);
  };

  const handleAudioLoaded = (
    file: MediaFile,
    event: SyntheticEvent<HTMLAudioElement>
  ) => {
    const duration = event.currentTarget.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;

    setMediaFiles((current) =>
      current.map((item) => item.path === file.path ? { ...item, duration } : item)
    );
    setAudioClips((current) =>
      current.map((clip) =>
        clip.sourcePath === file.path && clip.end === 0
          ? { ...clip, end: duration }
          : clip
      )
    );

    void generateWaveform(file);
  };

  const handleAudioClipMouseDown = (
    event: MouseEvent<HTMLDivElement>,
    clipId: string
  ) => {
    if ((event.target as HTMLElement).closest(".audio-trim-handle")) return;
    event.preventDefault();
    event.stopPropagation();

    const clip = audioClips.find((item) => item.id === clipId);
    if (!clip) return;
    setActiveAudioClipId(clipId);
    setActiveClipId(null);

    const startX = event.clientX;
    const originalPosition = clip.position;
    const move = (e: globalThis.MouseEvent) => {
      const position = Math.max(0, originalPosition + (e.clientX - startX) / timelineScale);
      setAudioClips((current) =>
        current.map((item) => item.id === clipId ? { ...item, position } : item)
      );
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const handleAudioTrimMouseDown = (
    event: MouseEvent<HTMLDivElement>,
    clipId: string,
    mode: "start" | "end"
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const clip = audioClips.find((item) => item.id === clipId);
    if (!clip) return;

    setActiveAudioClipId(clipId);
    setActiveClipId(null);
    setActiveAudioTrim(mode);

    const startX = event.clientX;
    const originalStart = clip.start;
    const originalEnd = clip.end;
    const originalPosition = clip.position;
    const sourceDuration =
      mediaFiles.find((file) => file.path === clip.sourcePath)?.duration ?? originalEnd;

    const move = (e: globalThis.MouseEvent) => {
      const delta = (e.clientX - startX) / timelineScale;
      setAudioClips((current) => current.map((item) => {
        if (item.id !== clipId) return item;
        if (mode === "start") {
          const start = Math.max(0, Math.min(originalStart + delta, originalEnd - 0.1));
          return {
            ...item,
            start,
            position: Math.max(0, originalPosition + start - originalStart),
          };
        }
        return {
          ...item,
          end: Math.max(originalStart + 0.1, Math.min(originalEnd + delta, sourceDuration || originalEnd)),
        };
      }));
    };
    const up = () => {
      setActiveAudioTrim(null);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

const handlePlayheadMouseDown = (
  event: MouseEvent<HTMLDivElement>
) => {
  event.preventDefault();
  event.stopPropagation();

  const trackContent =
    event.currentTarget.closest(
      ".track-content"
    ) as HTMLDivElement | null;

  if (!trackContent) {
    return;
  }

  const updatePlayhead = (
    clientX: number
  ) => {
    const rect =
      trackContent.getBoundingClientRect();

    /*
     * Position de la souris par rapport
     * au début réel de la timeline.
     */
    const x = Math.max(
      0,
      clientX - rect.left + trackContent.scrollLeft
    );

    const timelineDuration = videoClips.reduce(
      (maximum, clip) =>
        Math.max(maximum, getTimelineEnd(clip)),
      0
    );

    const newTime = Math.min(
      x / timelineScale,
      timelineDuration || Infinity
    );

    setPlayheadTime(newTime);

    const targetClip = videoClips
      .filter(
        (clip) =>
          newTime >= clip.position &&
          newTime <= getTimelineEnd(clip)
      )
      .sort(
        (first, second) =>
          first.position - second.position
      )[0];

    if (!targetClip) {
      videoRef.current?.pause();
      setActiveClipId(null);
      return;
    }

    setActiveClipId(targetClip.id);

    /*
     * Synchronisation avec le lecteur vidéo.
     */
    if (videoRef.current) {
      const sourceTime = Math.max(
        targetClip.start,
        Math.min(
          getSourceTimeAtTimelinePosition(
            targetClip,
            newTime
          ),
          targetClip.end
        )
      );

      videoRef.current.currentTime = sourceTime;
    }
  };

  /*
   * Position immédiate au clic.
   */
  updatePlayhead(event.clientX);

  const handleMouseMove = (
    moveEvent: globalThis.MouseEvent
  ) => {
    updatePlayhead(
      moveEvent.clientX
    );
  };

  const handleMouseUp = () => {
    window.removeEventListener(
      "mousemove",
      handleMouseMove
    );

    window.removeEventListener(
      "mouseup",
      handleMouseUp
    );
  };

  window.addEventListener(
    "mousemove",
    handleMouseMove
  );

  window.addEventListener(
    "mouseup",
    handleMouseUp
  );
};

  const handleTimelineBackgroundMouseDown = (
    event: MouseEvent<HTMLDivElement>
  ) => {
    const target = event.target as HTMLElement;

    if (
      target.closest(".timeline-clip") ||
      target.closest(".timeline-playhead")
    ) {
      return;
    }

    handlePlayheadMouseDown(event);
  };

  const handleTimelineWheel = (
    event: React.WheelEvent<HTMLDivElement>
  ) => {
    event.preventDefault();

    const delta = event.deltaY;
    setTimelineScale((current) =>
      clamp(current + delta * -0.02, 18, 80)
    );
  };

  /*
   * -------------------------------------------------------
   * TRIM
   * -------------------------------------------------------
   */

const handleTrimMouseDown = (
  event: MouseEvent<HTMLDivElement>,
  clipId: string,
  mode: "start" | "end"
) => {
  event.preventDefault();
  event.stopPropagation();

  const clip = videoClips.find((item) => item.id === clipId);
  if (!clip) return;

  const startMouseX = event.clientX;
  const originalStart = clip.start;
  const originalEnd = clip.end;
  const originalPosition = clip.position;
  const videoDuration =
    mediaFiles.find(
      (file) => file.path === clip.sourcePath
    )?.duration ?? originalEnd;

  setTrimMode(mode);
  setActiveClipId(clipId);

  const handleMouseMove = (
    moveEvent: globalThis.MouseEvent
  ) => {
    const deltaX = moveEvent.clientX - startMouseX;
    const deltaTime = deltaX / timelineScale;

    setVideoClips((currentClips) =>
      currentClips.map((item) => {
        if (item.id !== clipId) {
          return item;
        }

        if (mode === "start") {
          const newStart = clamp(
            originalStart + deltaTime,
            0,
            Math.max(0, originalEnd - 0.1)
          );

          const startDelta = newStart - originalStart;
          const newPosition = clamp(
            originalPosition + startDelta,
            0,
            originalPosition + Math.max(0, originalEnd - originalStart - 0.1)
          );

          return {
            ...item,
            start: newStart,
            position: newPosition,
          };
        }

        const newEnd = clamp(
          originalEnd + deltaTime,
          originalStart + 0.1,
          videoDuration || originalEnd
        );

        return {
          ...item,
          end: newEnd,
        };
      })
    );
  };

  const handleMouseUp = () => {
    setTrimMode(null);

    window.removeEventListener(
      "mousemove",
      handleMouseMove
    );

    window.removeEventListener(
      "mouseup",
      handleMouseUp
    );
  };

  window.addEventListener(
    "mousemove",
    handleMouseMove
  );

  window.addEventListener(
    "mouseup",
    handleMouseUp
  );
};

  const handleKeyDown = (
    event: React.KeyboardEvent
  ) => {
    /*
    * On ne fait rien si l'utilisateur
    * est en train d'écrire dans un champ.
    */
    const target =
      event.target as HTMLElement;

    if (
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable
    ) {
      return;
    }

    /*
    * Touche Suppr / Delete
    */
    if (
      event.key === "Delete" ||
      event.key === "Backspace"
    ) {
      if (activeAudioClipId) {
        event.preventDefault();
        setAudioClips((current) => current.filter((clip) => clip.id !== activeAudioClipId));
        setActiveAudioClipId(null);
        setActiveAudioTrim(null);
        return;
      }
      if (!activeClipId) return;

      event.preventDefault();

      videoRef.current?.pause();
      setPendingPlayClipId(null);
      setTrimMode(null);

      /*
      * Supprime uniquement le clip sélectionné.
      */
      setVideoClips((current) =>
        current.filter(
          (clip) =>
            clip.id !== activeClipId
        )
      );

      /*
      * Plus aucun clip sélectionné.
      */
      setActiveClipId(null);
    }
  };


  const handleSplitVideo = () => {
    if (!activeClipId) {
      return;
    }

    const clip = videoClips.find(
      (item) => item.id === activeClipId
    );

    if (!clip) {
      return;
    }

    /*
     * La tête de lecture doit être à l'intérieur
     * du clip.
     */
    const sourceCutTime =
      getSourceTimeAtTimelinePosition(
        clip,
        playheadTime
      );

    if (
      sourceCutTime <= clip.start + 0.05 ||
      sourceCutTime >= clip.end - 0.05
    ) {
      return;
    }

    /*
     * Premier morceau
     */
    const firstClip: TimelineClip = {
      ...clip,
      id: `${Date.now()}-first-${Math.random()}`,
      end: sourceCutTime,
    };

    /*
     * Deuxième morceau
     */
    const secondClip: TimelineClip = {
      ...clip,
      id: `${Date.now()}-second-${Math.random()}`,
      start: sourceCutTime,
      position: getTimelinePositionAtSourceTime(
        clip,
        sourceCutTime
      ),
    };

    /*
     * On remplace le clip original
     * par les deux nouveaux clips.
     */
    setVideoClips((current) =>
      current.flatMap((item) =>
        item.id === clip.id
          ? [firstClip, secondClip]
          : [item]
      )
    );

    /*
     * Le deuxième morceau devient
     * le clip actif.
     */
    setActiveClipId(secondClip.id);

    /*
     * On garde la tête de lecture
     * sur la coupe.
     */
    setPlayheadTime(playheadTime);

    requestAnimationFrame(() => {
      if (videoRef.current) {
        videoRef.current.currentTime =
          sourceCutTime;
      }
    });
  };

  const handleAddFreezeFrame = async () => {
    const clip = videoClips.find((item) => item.id === activeClipId);
    if (
      !clip ||
      playheadTime < clip.position ||
      playheadTime >= getTimelineEnd(clip) - 0.05 ||
      clip.freezeFrameTime !== undefined
    ) {
      return;
    }

    const sourceTime = getSourceTimeAtTimelinePosition(clip, playheadTime);
    const duration = Math.min(freezeDuration, clip.end - sourceTime);
    if (duration < 0.1) {
      setExportMessage("Place la tête de lecture plus tôt dans le clip.");
      return;
    }

    videoRef.current?.pause();
    setExportMessage("");

    try {
      const freezeFrameSrc = await captureVideoFrameAtTime(
        clip.sourcePath,
        sourceTime
      );
      const freezePosition = playheadTime;
      const freezeEnd = sourceTime + duration;
      const freezeClip: TimelineClip = {
        ...clip,
        id: `${Date.now()}-freeze-${Math.random()}`,
        start: sourceTime,
        end: freezeEnd,
        position: freezePosition,
        freezeFrameTime: sourceTime,
        freezeFrameSrc,
      };
      const replacement: TimelineClip[] = [];

      if (sourceTime > clip.start + 0.01) {
        replacement.push({
          ...clip,
          id: `${Date.now()}-before-${Math.random()}`,
          end: sourceTime,
        });
      }
      replacement.push(freezeClip);

      if (freezeEnd < clip.end - 0.01) {
        replacement.push({
          ...clip,
          id: `${Date.now()}-after-${Math.random()}`,
          start: freezeEnd,
          position: freezePosition + duration,
          freezeFrameTime: undefined,
          freezeFrameSrc: undefined,
        });
      }

      setVideoClips((current) =>
        current.flatMap((item) =>
          item.id === clip.id ? replacement : [item]
        )
      );
      setActiveClipId(freezeClip.id);
      setPlayheadTime(freezePosition);
      if (videoRef.current && selectedVideo?.path === clip.sourcePath) {
        videoRef.current.currentTime = sourceTime;
      }

      if (duration < freezeDuration) {
        setExportMessage(
          `Image figée pendant ${duration.toFixed(1)} s, jusqu’à la fin du clip source.`
        );
      }
    } catch (error) {
      setExportMessage(`Impossible de créer l’arrêt sur image : ${String(error)}`);
    }
  };

  /*
   * -------------------------------------------------------
   * VIDEO
   * -------------------------------------------------------
   */


const playMontage = () => {
  const orderedClips = [...videoClips].sort(
    (a, b) => a.position - b.position
  );

  if (orderedClips.length === 0) {
    return;
  }

  // Prend le clip sous la tête de lecture.
  // Sinon, prend le prochain clip, ou le premier.
  const targetClip =
    orderedClips.find(
      (clip) =>
        playheadTime >= clip.position &&
        playheadTime < getTimelineEnd(clip)
    ) ??
    orderedClips.find(
      (clip) => clip.position >= playheadTime
    ) ??
    orderedClips[0];

  const targetFile = mediaFiles.find(
    (file) => file.path === targetClip.sourcePath
  );

  if (!targetFile) {
    return;
  }

  setActiveClipId(targetClip.id);

  const sourceTime = Math.max(
    targetClip.start,
    Math.min(
      getSourceTimeAtTimelinePosition(
        targetClip,
        playheadTime >= targetClip.position &&
          playheadTime < getTimelineEnd(targetClip)
          ? playheadTime
          : targetClip.position
      ),
      targetClip.end
    )
  );

  // Si la vidéo affichée est déjà la bonne.
  if (targetFile.path === selectedVideo?.path) {
    setPendingPlayClipId(null);
    videoRef.current?.pause();

    requestAnimationFrame(() => {
      const video = videoRef.current;
      if (!video) return;

      video.currentTime = sourceTime;
      setPlayheadTime(
        getTimelinePositionAtSourceTime(
          targetClip,
          sourceTime
        )
      );

      void video.play().catch((error) => {
        console.error(
          "Impossible de lire le montage :",
          error
        );
      });
    });

    return;
  }

  // Sinon, charge le fichier du prochain clip.
  videoRef.current?.pause();
  setPendingPlayClipId(targetClip.id);
  setSelectedVideo(targetFile);
};


const handleVideoLoaded = (
  event: SyntheticEvent<HTMLVideoElement>
) => {
  const video = event.currentTarget;
  const duration = video.duration;

  if (!selectedVideo) {
    return;
  }

  // Met à jour la durée réelle du fichier.
  setMediaFiles((files) =>
    files.map((file) =>
      file.path === selectedVideo.path
        ? { ...file, duration }
        : file
    )
  );

  // Complète la durée des clips non renseignés.
  setVideoClips((clips) =>
    clips.map((clip) =>
      clip.sourcePath === selectedVideo.path &&
      clip.end === 0
        ? { ...clip, end: duration }
        : clip
    )
  );

  // Si on attend un clip suivant, prépare sa position.
  if (pendingPlayClipId) {
    const nextClip = videoClips.find(
      (clip) =>
        clip.id === pendingPlayClipId &&
        clip.sourcePath === selectedVideo.path
    );

    if (!nextClip) {
      console.error(
        "Clip suivant introuvable :",
        pendingPlayClipId
      );
      setPendingPlayClipId(null);
      transitioningToClipRef.current = null;
      startingPendingPlayRef.current = null;
      return;
    }

    console.log(
      "Nouvelle vidéo chargée :",
      nextClip.sourceName,
      "position source :",
      nextClip.start
    );

    setActiveClipId(nextClip.id);
    setPlayheadTime(nextClip.position);

    // Important : ne pas lancer play() ici.
    // On attend la fin du déplacement temporel.
    if (
      Math.abs(video.currentTime - nextClip.start) > 0.05
    ) {
      video.currentTime = nextClip.start;
    }
  }
};

const tryStartPendingPlayback = (
  event: SyntheticEvent<HTMLVideoElement>
) => {
  const video = event.currentTarget;
  const pendingId = pendingPlayClipId;

  if (!pendingId || !selectedVideo) {
    return;
  }

  // Attendre que la vidéo soit prête et que le seek soit terminé.
  if (
    video.seeking ||
    video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA
  ) {
    return;
  }

  const nextClip = videoClips.find(
    (clip) =>
      clip.id === pendingId &&
      clip.sourcePath === selectedVideo.path
  );

  if (!nextClip) {
    return;
  }

  // Si le lecteur n'est pas à la bonne position,
  // on déclenche la recherche et on attend seeked.
  if (Math.abs(video.currentTime - nextClip.start) > 0.05) {
    video.currentTime = nextClip.start;
    return;
  }

  // Évite plusieurs appels play() pour le même clip.
  if (startingPendingPlayRef.current === pendingId) {
    return;
  }

  startingPendingPlayRef.current = pendingId;

  console.log(
    "Démarrage du clip suivant :",
    nextClip.sourceName
  );

  void video.play()
    .then(() => {
      // Ne nettoie l'état que si c'est toujours
      // le clip attendu qui est en cours de lancement.
      if (startingPendingPlayRef.current === pendingId) {
        setPendingPlayClipId((current) =>
          current === pendingId ? null : current
        );

        if (transitioningToClipRef.current === pendingId) {
          transitioningToClipRef.current = null;
        }

        startingPendingPlayRef.current = null;
      }
    })
    .catch((error: unknown) => {
      console.error(
        "Impossible de démarrer le clip suivant :",
        error
      );

      startingPendingPlayRef.current = null;
    });
};

const advanceFromClip = (
  video: HTMLVideoElement,
  clip: TimelineClip
) => {
  if (transitioningToClipRef.current) return;
  const clipEnd = getTimelineEnd(clip);

  const nextClip = videoClips
  .filter(
    (item) =>
      item.id !== clip.id &&
      item.position >= clipEnd - 0.05 &&
      Math.abs(item.position - clipEnd) <= 0.05
  )
  .sort(
    (a, b) => a.position - b.position
  )[0];

  if (!nextClip) {
    video.pause();
    setPlayheadTime(clipEnd);
    return;
  }

  
if (nextClip.sourcePath === clip.sourcePath) {
  setActiveClipId(nextClip.id);
  setPlayheadTime(nextClip.position);

  // Si les deux portions se suivent dans le fichier
  // source, on évite une recherche inutile dans la vidéo.
  const sourceIsContinuous =
    Math.abs(clip.end - nextClip.start) < 0.05;

  if (!sourceIsContinuous) {
    video.currentTime = nextClip.start;
  }

  // Ne pas mettre le lecteur en pause :
  // il continue naturellement si la source est continue.
  if (video.paused) {
    void video.play().catch(() => undefined);
  }

  return;
}
  const nextFile = mediaFiles.find(
    (file) => file.path === nextClip.sourcePath
  );

  if (!nextFile) {
    video.pause();
    setPlayheadTime(clipEnd);
    return;
  }

  transitioningToClipRef.current = nextClip.id;
  setPendingPlayClipId(nextClip.id);
  setSelectedVideo(nextFile);
  video.pause();
};

const handleVideoTimeUpdate = (
  event: SyntheticEvent<HTMLVideoElement>
) => {
  const video = event.currentTarget;
  const clip = videoClips.find(
    (item) => item.id === activeClipId
  );

  if (!clip) {
    return;
  }

  const timelineTime = getTimelinePositionAtSourceTime(
    clip,
    Math.min(video.currentTime, clip.end)
  );
  setPlayheadTime(timelineTime);

  if (video.currentTime < clip.end - 0.05) {
    return;
  }

  advanceFromClip(video, clip);
};

const handleVideoEnded = (
  event: SyntheticEvent<HTMLVideoElement>
) => {
  const clip = videoClips.find(
    (item) => item.id === activeClipId
  );
  if (!clip || transitioningToClipRef.current) return;

  setPlayheadTime(getTimelineEnd(clip));
  advanceFromClip(event.currentTarget, clip);
};

const handleVideoPlay = (
  event: SyntheticEvent<HTMLVideoElement>
) => {
  const video = event.currentTarget;

  // Si aucun clip n'est actif, cherche celui
  // situé sous la tête de lecture.
  if (!activeClipId) {
    const targetClip = videoClips
      .filter(
        (clip) =>
          playheadTime >= clip.position &&
          playheadTime < getTimelineEnd(clip)
      )
      .sort(
        (a, b) => b.position - a.position
      )[0];

    if (!targetClip) {
      video.pause();
      return;
    }

    setActiveClipId(targetClip.id);

    const targetFile = mediaFiles.find(
      (file) => file.path === targetClip.sourcePath
    );

    if (!targetFile) {
      video.pause();
      return;
    }

    if (targetFile.path !== selectedVideo?.path) {
      setPendingPlayClipId(targetClip.id);
      setSelectedVideo(targetFile);
      video.pause();
      return;
    }

    video.currentTime = Math.max(
      targetClip.start,
      Math.min(
        getSourceTimeAtTimelinePosition(
          targetClip,
          playheadTime
        ),
        targetClip.end
      )
    );

    return;
  }

  const clip = videoClips.find(
    (item) => item.id === activeClipId
  );

  if (!clip) {
    video.pause();
    return;
  }

  // Si le lecteur est en dehors du clip,
  // on le repositionne au bon endroit.
  if (
    video.currentTime < clip.start ||
    video.currentTime >= clip.end
  ) {
    video.currentTime = clip.start;
    setPlayheadTime(clip.position);
  }
};

  /*
   * -------------------------------------------------------
   * LISTES
   * -------------------------------------------------------
   */

  const videos = mediaFiles.filter(
    (file) => file.type === "video"
  );

  const audios = mediaFiles.filter(
    (file) => file.type === "audio"
  );
  const canFreezeActiveClip = videoClips.some(
    (clip) =>
      clip.id === activeClipId &&
      clip.freezeFrameTime === undefined &&
      playheadTime >= clip.position &&
      playheadTime < getTimelineEnd(clip) - 0.05
  );
  const activeFreezeClip = videoClips.find(
    (clip) =>
      clip.id === activeClipId &&
      clip.sourcePath === selectedVideo?.path &&
      clip.freezeFrameSrc &&
      playheadTime >= clip.position &&
      playheadTime < getTimelineEnd(clip)
  );


  const renderWaveformBars = (sourcePath: string, clipId: string) => {
    const waveform = waveformCache[sourcePath] ?? [];
    const bars =
      waveform.length > 0
        ? waveform
        : Array.from({ length: 22 }, (_, index) => {
            const seed = (index % 5) / 5;
            return 0.2 + seed * 0.7;
          });

    return bars.map((peak, index) => {
      const safePeak = Number.isFinite(peak) ? peak : 0.2;
      const height = clamp(safePeak * 100, 12, 100);

      return (
        <div
          key={`${clipId}-wave-${index}`}
          className="audio-waveform-bar"
          style={{
            height: `${height}%`,
            opacity: 0.45 + safePeak * 0.7,
          }}
        />
      );
    });
  };

  const renderClipFrames = (clip: TimelineClip) => {
    if (clip.freezeFrameSrc) {
      return (
        <img
          src={clip.freezeFrameSrc}
          alt=""
          className="timeline-video-frame timeline-video-frame-fallback"
        />
      );
    }

    const frames = videoFrames[clip.sourcePath] ?? [];
    const visibleFrames = frames.filter(
      (frame) => frame.time >= clip.start && frame.time <= clip.end
    );

    if (visibleFrames.length === 0) {
      const fallbackThumbnail = mediaFiles.find(
        (file) => file.path === clip.sourcePath
      )?.thumbnail;

      return fallbackThumbnail ? (
        <img
          src={fallbackThumbnail}
          alt=""
          className="timeline-video-frame timeline-video-frame-fallback"
        />
      ) : null;
    }

    const clipDuration = Math.max(clip.end - clip.start, 0.001);
    const filmstripWidth = Math.max(clipDuration * timelineScale, 220);

    return visibleFrames.map((frame, index) => {
      const nextFrame = visibleFrames[index + 1];
      const segmentStart = index === 0 ? clip.start : frame.time;
      const segmentEnd = nextFrame?.time ?? clip.end;
      const left =
        ((segmentStart - clip.start) / clipDuration) * filmstripWidth;
      const width = Math.max(
        ((segmentEnd - segmentStart) / clipDuration) * filmstripWidth,
        1
      );

      return (
        <img
          key={`${clip.id}-${frame.time}`}
          src={frame.src}
          alt=""
          className="timeline-video-frame"
          style={{
            left: `${left}px`,
            width: `${width}px`,
          }}
        />
      );
    });
  };

  const renderAudioTrack = (track: "voice" | "audio") => (
    <>
      {track === "audio" &&
        videoClips.map((videoClip) => {
          const duration = Math.max(
            0,
            videoClip.end - videoClip.start
          );
          const isActive = videoClip.id === activeClipId;

          return (
            <div
              key={`video-audio-${videoClip.id}`}
              className={`timeline-audio-clip ${
                isActive ? "timeline-audio-clip-active" : ""
              }`}
              style={{
                left: `${videoClip.position * timelineScale}px`,
                width: `${duration * timelineScale}px`,
              }}
              onClick={(event) => {
                event.stopPropagation();
                selectTimelineClip(videoClip);
              }}
              title={`Audio intégré : ${videoClip.sourceName}`}
            >
              <div className="timeline-audio-clip-content">
                <div className="timeline-audio-clip-name">
                  🎵 {videoClip.sourceName}
                </div>

                <div className="timeline-audio-clip-duration">
                  {formatDuration(duration)}
                </div>

                <div className="audio-waveform">
                  {renderWaveformBars(videoClip.sourcePath, videoClip.id)}
                </div>
              </div>
            </div>
          );
        })}

      {audioClips
        .filter((clip) => clip.track === track)
        .map((clip) => {
          const duration = Math.max(0, clip.end - clip.start);
          const isActive = clip.id === activeAudioClipId;

          return (
            <div
              key={clip.id}
              className={`timeline-audio-clip ${
                isActive ? "timeline-audio-clip-active" : ""
              }`}
              style={{
                left: `${clip.position * timelineScale}px`,
                width: `${duration * timelineScale}px`,
              }}
              onMouseDown={(event) =>
                handleAudioClipMouseDown(event, clip.id)
              }
              onClick={(event) => {
                event.stopPropagation();
                setActiveAudioClipId(clip.id);
                setActiveClipId(null);
              }}
              title={`${clip.sourceName} — ${formatDuration(duration)}`}
            >
              <div
                className={`audio-trim-handle audio-trim-handle-left ${
                  activeAudioTrim === "start" && isActive ? "active" : ""
                }`}
                onMouseDown={(event) =>
                  handleAudioTrimMouseDown(event, clip.id, "start")
                }
              />

              <div className="timeline-audio-clip-content">
                <div className="timeline-audio-clip-name">
                  🎵 {clip.sourceName}
                </div>
                <div className="timeline-audio-clip-duration">
                  {formatDuration(duration)}
                </div>

                <div className="audio-waveform">
                  {renderWaveformBars(clip.sourcePath, clip.id)}
                </div>
              </div>

              <div
                className={`audio-trim-handle audio-trim-handle-right ${
                  activeAudioTrim === "end" && isActive ? "active" : ""
                }`}
                onMouseDown={(event) =>
                  handleAudioTrimMouseDown(event, clip.id, "end")
                }
              />
            </div>
          );
        })}
    </>
  );

  /*
   * -------------------------------------------------------
   * RENDER
   * -------------------------------------------------------
   */

  return (
    <div className="app"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >

      <header className="topbar">
        <div className="logo">
          🎬 <span>CS2 EDITOR</span>
        </div>

        <button className="settings-button">
          ⚙️
        </button>
      </header>

      <main className="workspace">

        <aside className="sidebar">

          <h2>MEDIA</h2>

          <button
            className="import-button"
            onClick={importMedia}
          >
            ＋ Importer
          </button>

          <div className="media-section">

            <h3>🎬 Vidéos</h3>

            {videos.length === 0 ? (
              <div className="empty-message">
                Aucun clip importé
              </div>
            ) : (
              videos.map((file, index) => (
                <div
                  className={`media-item ${
                    selectedVideo?.path ===
                    file.path
                      ? "selected"
                      : ""
                  }`}
                  key={`${file.path}-${index}`}
                  onClick={() =>
                    selectVideo(file)
                  }
                >
                  🎬 {file.name}
                </div>
              ))
            )}

          </div>

          <div className="media-section">

            <h3>🎵 Audios</h3>

            {audios.length === 0 ? (
              <div className="empty-message">
                Aucun audio importé
              </div>
            ) : (
              audios.map((file, index) => (
                <div
                  className="media-item audio-media-item"
                  key={`${file.path}-${index}`}
                >
                  <span
                    className="audio-media-name"
                    onClick={() => addAudioToTimeline(file, "audio")}
                    title="Cliquer pour ajouter à la piste AUDIO"
                  >
                    🎵 {file.name}
                  </span>
                  <button
                    className="add-voice-button"
                    onClick={() => addAudioToTimeline(file, "voice")}
                    title="Ajouter à la piste VOIX"
                  >
                    VOIX
                  </button>
                  <audio
                    src={convertFileSrc(file.path)}
                    preload="metadata"
                    onLoadedMetadata={(event) => handleAudioLoaded(file, event)}
                    style={{ display: "none" }}
                  />
                </div>
              ))
            )}

          </div>

        </aside>

        <section className="editor">

          <div className="preview">

            {selectedVideo ? (
              <div className="video-preview">
                <video
                  ref={videoRef}
                  className="video-player"
                  src={convertFileSrc(selectedVideo.path)}
                  controls
                  onLoadedMetadata={handleVideoLoaded}
                  onCanPlay={tryStartPendingPlayback}
                  onSeeked={tryStartPendingPlayback}
                  onTimeUpdate={handleVideoTimeUpdate}
                  onEnded={handleVideoEnded}
                  onPlay={handleVideoPlay}
                />
                {activeFreezeClip?.freezeFrameSrc && (
                  <img
                    className="freeze-frame-overlay"
                    src={activeFreezeClip.freezeFrameSrc}
                    alt="Image figée"
                  />
                )}
              </div>
            ) : (
              <div className="preview-content">

                <div className="preview-icon">
                  🎮
                </div>

                <p>
                  Aucun clip sélectionné
                </p>

                <span>
                  Importe une vidéo pour commencer
                </span>

              </div>
            )}
            
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                gap: "12px",
                padding: "12px",
              }}
            >
              <button
                className="import-button"
                onClick={playMontage}
                disabled={videoClips.length === 0}
              >
                ▶ Lire le montage
              </button>

              <button
                className="split-button"
                onClick={() => videoRef.current?.pause()}
                disabled={!selectedVideo}
              >
                ⏸ Pause
              </button>
            </div>

          </div>

          <div className="timeline">

            <div className="timeline-header">

              <span>
                TIMELINE
              </span>

              <span>
                {formatDuration(
                  playheadTime
                )}
              </span>

            </div>

            {/* OUTILS TIMELINE */}

            <div className="timeline-tools">

              <button
                className="split-button"
                onClick={handleSplitVideo}
                disabled={
                  !activeClipId
                }
              >
                ✂️ Couper
              </button>

              <label className="freeze-duration-control">
                <input
                  className="freeze-duration-input"
                  type="number"
                  min="0.1"
                  max="30"
                  step="0.5"
                  value={freezeDuration}
                  aria-label="Durée de l’image fixe en secondes"
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isFinite(value) && value > 0) {
                      setFreezeDuration(clamp(value, 0.1, 30));
                    }
                  }}
                />
                <span>s</span>
              </label>

              <button
                className="freeze-frame-button"
                onClick={() => void handleAddFreezeFrame()}
                disabled={!canFreezeActiveClip}
                title="Figer l’image à la tête de lecture"
              >
                ❄ Image fixe
              </button>

              <span className="playhead-time">
                Position :{" "}
                {formatDuration(
                  playheadTime
                )}
              </span>

            </div>

            {/* VIDEO */}

            <div className="track">

              <div className="track-name">
                🎬 VIDEO
              </div>

              <div
                className="track-content"
                onMouseDown={
                  handleTimelineBackgroundMouseDown
                }
                onWheel={handleTimelineWheel}
              >
              <div
                className="timeline-playhead"
                style={{
                  left: `${playheadTime * timelineScale}px`,
                }}
                onMouseDown={handlePlayheadMouseDown}
              >
                <div className="playhead-handle" />
              </div>

            {videoClips.map((clip) => {

                  const clipDuration =
                    clip.end -
                    clip.start;

                  const isActive =
                    clip.id ===
                    activeClipId;

                  const sourceFile = mediaFiles.find(
                    (file) => file.path === clip.sourcePath
                  );

                  return (
                    <div
                      key={clip.id}
                      className={`timeline-clip ${
                        isActive
                          ? "timeline-clip-active"
                          : ""
                      } ${clip.freezeFrameTime !== undefined ? "timeline-clip-freeze" : ""}`}
                      style={{
                        left: `${clip.position * timelineScale}px`,
                        width: `${Math.max(
                          clipDuration * timelineScale,
                          150
                        )}px`,
                        backgroundImage: sourceFile?.thumbnail
                          ? `linear-gradient(180deg, rgba(16,20,28,0.18), rgba(16,20,28,0.65)), url(${sourceFile.thumbnail})`
                          : undefined,
                        backgroundSize: "cover",
                        backgroundPosition: "center",
                      }}
                      onMouseDown={(event) =>
                        handleClipMouseDown(
                          event,
                          clip.id
                        )
                      }
                      onClick={() =>
                        selectTimelineClip(clip)
                      }
                    >

                      {/* HANDLE GAUCHE */}

                      <div
                        className={`trim-handle trim-handle-left ${
                          trimMode ===
                          "start"
                            ? "active"
                            : ""
                        }`}
                        onMouseDown={(
                          event
                        ) =>
                          handleTrimMouseDown(
                            event,
                            clip.id,
                            "start"
                          )
                        }
                      />

                      {/* CONTENU */}

                      <div className="timeline-clip-content">
                        <div className="timeline-clip-frame-strip">
                          {renderClipFrames(clip)}
                        </div>

                        <div className="timeline-clip-meta">
                          <div className="timeline-clip-name">
                            {clip.sourceName}
                          </div>

                          <div className="timeline-clip-duration">
                            {formatDuration(
                              clipDuration
                            )}
                          </div>
                        </div>
                      </div>

                      {/* HANDLE DROIT */}

                      <div
                        className={`trim-handle trim-handle-right ${
                          trimMode ===
                          "end"
                            ? "active"
                            : ""
                        }`}
                        onMouseDown={(
                          event
                        ) =>
                          handleTrimMouseDown(
                            event,
                            clip.id,
                            "end"
                          )
                        }
                      />

                    </div>
                  );
                })}

              </div>
            </div>

            {/* VOIX */}

            <div className="track">

              <div className="track-name">
                🎙️ VOIX
              </div>

              <div className="track-content">
                {renderAudioTrack("voice")}
              </div>

            </div>

            {/* AUDIO */}

            <div className="track">

              <div className="track-name">
                🎵 AUDIO
              </div>

              <div className="track-content">
                {renderAudioTrack("audio")}
              </div>

            </div>

          </div>

        </section>

      </main>

      <footer className="bottom-bar">

        <button>
          🎙️ Voix off
        </button>

        <button>
          📝 Sous-titres
        </button>

        <button>
          📐 Format
        </button>

        <div className="spacer" />

        <button
          className="export-button"
          onClick={handleExport}
          disabled={isExporting}
        >
          {isExporting ? "⏳ Export en cours…" : "🚀 Exporter"}
        </button>
              {exportMessage && (
        <span className="export-message" title={exportMessage}>
          {exportMessage}
        </span>
        )}

      </footer>

    </div>
  );
}

export default App;

