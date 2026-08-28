import {
  Cloud, Heart, ListMusic, Maximize2, MessageSquareQuote, MonitorSpeaker, Pause, Play,
  PanelRightOpen, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume1, Volume2, VolumeX,
} from "lucide-react";
import type { PlaybackController } from "../hooks/usePlayback";
import type { ContextPanelMode } from "../types";
import { parseExternalSource } from "../lib/externalSource";
import { MediaArtwork } from "./MediaArtwork";
import { PlaybackProgress, SmoothRange } from "./RangeSlider";

type PlayerBarProps = {
  playback: PlaybackController;
  panelMode?: ContextPanelMode;
  expanded: boolean;
  onOpenPanel: (mode: ContextPanelMode) => void;
  onOpenAlbum: (id: string) => void;
  onOpenArtist: (id: string) => void;
  onToggleExpanded: () => void;
  onToggleLike: () => void;
  liked: boolean;
};

export function PlayerBar({ expanded, playback, panelMode, onOpenAlbum, onOpenArtist, onOpenPanel, onToggleExpanded, onToggleLike, liked }: PlayerBarProps) {
  const VolumeIcon = playback.volume === 0 ? VolumeX : playback.volume < 0.55 ? Volume1 : Volume2;
  const external = Boolean(parseExternalSource(playback.current?.id));
  return (
    <footer className="desktop-player" aria-label="Player">
      <div className="player-identity">
        <button aria-label="Now playing view" aria-pressed={panelMode === "nowPlaying"} className="player-art-button" disabled={!playback.current} onClick={() => onOpenPanel("nowPlaying")} type="button">
          <MediaArtwork className="desktop-player__art" alt={playback.current ? `${playback.current.title} cover` : "No track selected"} coverArt={playback.current?.coverArt} />
        </button>
        <span className="player-identity__copy">
          {playback.current?.albumId ? <button className="player-identity__link player-identity__title" onClick={() => onOpenAlbum(playback.current!.albumId!)} type="button">{playback.current.title}{external && <Cloud aria-label="External source" size={11} />}</button> : <strong>{playback.current?.title ?? "No track selected"}{external && <Cloud aria-label="External source" size={11} />}</strong>}
          {playback.current?.artistId ? <button className="player-identity__link player-identity__artist" onClick={() => onOpenArtist(playback.current!.artistId!)} type="button">{playback.current.artist}</button> : <small>{playback.current?.artist ?? "Choose music from your server"}</small>}
        </span>
        {playback.current && (
          <button className={liked ? "player-icon player-icon--active" : "player-icon"} aria-label={liked ? "Remove from Liked Songs" : "Save to Liked Songs"} onClick={onToggleLike} type="button">
            <Heart fill={liked ? "currentColor" : "none"} size={17} />
          </button>
        )}
      </div>

      <div className="player-transport">
        <div className="player-transport__buttons">
          <button className={playback.shuffle ? "player-icon player-icon--active" : "player-icon"} aria-label="Shuffle" title="Shuffle" aria-pressed={playback.shuffle} onClick={() => playback.setShuffle((value) => !value)} type="button"><Shuffle size={17} /></button>
          <button className="player-icon" aria-label="Previous" title="Previous" disabled={!playback.current} onClick={playback.previous} type="button"><SkipBack fill="currentColor" size={18} /></button>
          <button className="player-play" aria-label={playback.isPlaying ? "Pause" : "Play"} disabled={!playback.current} onClick={playback.toggle} title={playback.isPlaying ? "Pause" : "Play"} type="button">
            {playback.isPlaying ? <Pause fill="currentColor" size={20} /> : <Play fill="currentColor" size={20} />}
          </button>
          <button className="player-icon" aria-label="Next" title="Next" disabled={!playback.current} onClick={playback.next} type="button"><SkipForward fill="currentColor" size={18} /></button>
          <button className={playback.repeat !== "off" ? "player-icon player-icon--active" : "player-icon"} aria-label={`Repeat ${playback.repeat}`} title={`Repeat: ${playback.repeat}`} onClick={playback.cycleRepeat} type="button">
            {playback.repeat === "one" ? <Repeat1 size={17} /> : <Repeat size={17} />}
          </button>
        </div>
        <PlaybackProgress disabled={!playback.current} duration={playback.duration} isPlaying={playback.isPlaying} onSeek={playback.seek} position={playback.position} />
        {playback.error && <span className="player-error" role="status">{playback.error}</span>}
      </div>

      <div className="player-actions">
        <button className={panelMode === "nowPlaying" ? "player-icon player-icon--active" : "player-icon"} aria-label="Now playing view" title="Now playing view" aria-pressed={panelMode === "nowPlaying"} onClick={() => onOpenPanel("nowPlaying")} type="button"><PanelRightOpen size={18} /></button>
        <button className={panelMode === "lyrics" ? "player-icon player-icon--active" : "player-icon"} aria-label="Lyrics" title="Lyrics" aria-pressed={panelMode === "lyrics"} onClick={() => onOpenPanel("lyrics")} type="button"><MessageSquareQuote size={18} /></button>
        <button className={panelMode === "queue" ? "player-icon player-icon--active" : "player-icon"} aria-label="Queue" title="Queue" aria-pressed={panelMode === "queue"} onClick={() => onOpenPanel("queue")} type="button"><ListMusic size={18} /></button>
        <button className={panelMode === "connect" ? "player-icon player-icon--active" : "player-icon"} aria-label="Splice Connect devices" title="Splice Connect devices" aria-pressed={panelMode === "connect"} onClick={() => onOpenPanel("connect")} type="button"><MonitorSpeaker size={18} /></button>
        <button className="player-icon" aria-label={playback.volume === 0 ? "Unmute" : "Mute"} title={playback.volume === 0 ? "Unmute" : "Mute"} onClick={() => playback.setVolume(playback.volume === 0 ? 0.8 : 0)} type="button"><VolumeIcon size={18} /></button>
        <SmoothRange aria-label="Volume" max={1} min={0} onChange={playback.setVolume} step={0.005} value={playback.volume} />
        <button aria-label={expanded ? "Exit full player" : "Open full player"} aria-pressed={expanded} className={expanded ? "player-icon player-icon--active" : "player-icon"} data-full-player-toggle disabled={!playback.current} onClick={onToggleExpanded} title={expanded ? "Exit full player" : "Open full player"} type="button"><Maximize2 size={17} /></button>
      </div>
    </footer>
  );
}
