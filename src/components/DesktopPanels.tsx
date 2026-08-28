import {
  Disc3, Download, GripVertical, Heart, Info, ListEnd, ListMusic, MessageSquareQuote,
  Minimize2, MonitorSpeaker, MoreHorizontal, Pause, Play, Plus, Radio, SkipBack, SkipForward,
  Trash2, UserRound, X,
} from "lucide-react";
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import type { CSSProperties } from "react";
import { Fragment, useEffect, useRef, useState } from "react";
import { useArtworkColor } from "../hooks/useArtworkColor";
import { useMenuFocus } from "../hooks/useMenuFocus";
import type { PlaybackController } from "../hooks/usePlayback";
import { externalProviderLabel } from "../lib/externalSource";
import type {
  ConnectCommand, ConnectPeer, ConnectSnapshot, ContextPanelMode, LyricsResult, SongSummary,
} from "../types";
import { MediaArtwork } from "./MediaArtwork";
import { PlaybackProgress } from "./RangeSlider";

type ContextPanelProps = {
  mode: ContextPanelMode;
  onClose: () => void;
  playback: PlaybackController;
  lyrics: LyricsResult;
  lyricsLoading: boolean;
  connect: ConnectSnapshot;
  groupId?: string;
  onMoveHere: (peer: ConnectPeer) => void;
  onMoveToDevice: (peer: ConnectPeer) => void;
  onResize: (event: ReactPointerEvent) => void;
  onResizeKey: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onSend: (peerId: string, command: ConnectCommand) => void;
  onStartGroup: () => void;
  onStopGroup: () => void;
  onSaveQueue: () => void;
  lyricsAutoScroll: boolean;
  lyricsTextSize: "small" | "standard" | "large";
  width: number;
};

export function DesktopContextPanel(props: ContextPanelProps) {
  const title = props.mode === "nowPlaying" ? "Now Playing" : props.mode === "queue" ? "Queue" : props.mode === "lyrics" ? "Lyrics" : "Devices";
  return (
    <aside className="context-panel" aria-label={title}>
      <button aria-label="Resize context panel" aria-orientation="vertical" aria-valuemax={460} aria-valuemin={280} aria-valuenow={Math.round(props.width)} className="context-panel__resizer" onKeyDown={props.onResizeKey} onPointerDown={props.onResize} role="separator" type="button" />
      <header>
        <div><p className="eyebrow">{props.mode === "connect" ? "SPLICE CONNECT" : "SPLICE"}</p><h2>{title}</h2></div>
        <button aria-label={`Close ${title}`} onClick={props.onClose} type="button"><X size={20} /></button>
      </header>
      {props.mode === "nowPlaying" && <NowPlayingPanel playback={props.playback} />}
      {props.mode === "queue" && <QueuePanel onSaveQueue={props.onSaveQueue} playback={props.playback} />}
      {props.mode === "lyrics" && <LyricsPanel autoScroll={props.lyricsAutoScroll} lyrics={props.lyrics} loading={props.lyricsLoading} playback={props.playback} textSize={props.lyricsTextSize} />}
      {props.mode === "connect" && (
        <ConnectPanel
          canHandoff={Boolean(props.playback.current)}
          groupId={props.groupId}
          onMoveHere={props.onMoveHere}
          onMoveToDevice={props.onMoveToDevice}
          onSend={props.onSend}
          onStartGroup={props.onStartGroup}
          onStopGroup={props.onStopGroup}
          snapshot={props.connect}
        />
      )}
    </aside>
  );
}

function NowPlayingPanel({ playback }: { playback: PlaybackController }) {
  if (!playback.current) return <PanelEmpty icon={ListMusic} text="Choose something to play." />;
  const source = externalProviderLabel(playback.current.id);
  return (
    <div className="now-panel">
      <MediaArtwork alt={`${playback.current.title} cover`} className="now-panel__art" coverArt={playback.current.coverArt} />
      <div className="now-panel__copy">
        <h3>{playback.current.title}</h3>
        <p>{playback.current.artist}</p>
        <small>{playback.current.album}</small>
      </div>
      <div className="now-panel__details">
        <span>Playing from</span><strong>{playback.contextLabel}</strong>
        <span>Quality</span><strong>{[playback.current.bitRate ? `${playback.current.bitRate} kbps` : undefined, playback.current.suffix?.toUpperCase()].filter(Boolean).join(" · ") || "Original"}{source ? ` · ${source}` : ""}</strong>
      </div>
    </div>
  );
}

function QueuePanel({ onSaveQueue, playback }: { onSaveQueue: () => void; playback: PlaybackController }) {
  const [dragging, setDragging] = useState<number>();
  const [dragTarget, setDragTarget] = useState<number>();
  if (!playback.queue.length) return <PanelEmpty icon={ListMusic} text="Your queue is empty." />;
  const manualStart = playback.index + 1;
  const contextStart = manualStart + playback.manualQueueCount;
  const canReorder = (index: number) => index >= manualStart && index < contextStart;
  const beginDrag = (event: ReactDragEvent, index: number) => {
    if (!canReorder(index)) { event.preventDefault(); return; }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(index));
    setDragging(index);
  };
  const drop = (event: ReactDragEvent, index: number) => {
    event.preventDefault();
    const from = dragging ?? Number(event.dataTransfer.getData("text/plain"));
    if (Number.isInteger(from) && canReorder(from) && canReorder(index)) playback.moveQueueItem(from, index);
    setDragging(undefined);
    setDragTarget(undefined);
  };
  return (
    <div className="queue-list">
      <div className="queue-list__heading"><span>{playback.queue.length} tracks</span><span><button onClick={onSaveQueue} type="button">Save as playlist</button>{playback.manualQueueCount > 0 && <button onClick={playback.clearManualQueue} type="button">Clear manual</button>}<button onClick={playback.clearUpcoming} type="button">Clear upcoming</button></span></div>
      {playback.undoQueueLabel && <div className="queue-undo" role="status"><span>{playback.undoQueueLabel}</span><button onClick={playback.undoQueueMutation} type="button">Undo</button></div>}
      {playback.queue.map((song, index) => (
        <Fragment key={`${song.id}-${index}`}>
          {index === manualStart && playback.manualQueueCount > 0 && <p className="queue-section-label">Next in queue</p>}
          {index === contextStart && index > playback.index && <p className="queue-section-label">Next from {playback.contextLabel}</p>}
        <div
          className={`${index === playback.index ? "queue-row queue-row--active" : "queue-row"}${dragging === index ? " queue-row--dragging" : ""}${dragTarget === index ? " queue-row--drop-target" : ""}`}
          draggable={canReorder(index)}
          onDragEnd={() => { setDragging(undefined); setDragTarget(undefined); }}
          onDragEnter={() => { if (canReorder(index)) setDragTarget(index); }}
          onDragOver={(event) => { if (canReorder(index)) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
          onDragStart={(event) => beginDrag(event, index)}
          onDrop={(event) => drop(event, index)}
        >
          <button className="queue-row__main" onClick={() => playback.playQueue(playback.queue, index, true, 0, playback.contextLabel)} type="button">
            <MediaArtwork alt="" className="queue-row__art" coverArt={song.coverArt} />
            <span><strong>{song.title}</strong><small>{song.artist}</small></span>
            {index === playback.index && <span className="playing-bars" aria-label="Playing"><i /><i /><i /></span>}
          </button>
          {index !== playback.index && (
            <span className="queue-row__tools">
              {canReorder(index) && <button aria-label={`Reorder ${song.title}`} className="queue-row__grip" data-queue-reorder={index} onKeyDown={(event) => {
                if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                const target = event.key === "ArrowUp" ? index - 1 : index + 1;
                if (!canReorder(target)) return;
                event.preventDefault();
                playback.moveQueueItem(index, target);
                window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-queue-reorder='${target}']`)?.focus());
              }} title="Drag, or use the arrow keys, to reorder" type="button"><GripVertical size={15} /></button>}
              <button aria-label={`Remove ${song.title}`} onClick={() => playback.removeQueueItem(index)} type="button"><X size={14} /></button>
            </span>
          )}
        </div>
        </Fragment>
      ))}
    </div>
  );
}

function LyricsPanel({ autoScroll, lyrics, loading, playback, textSize }: { autoScroll: boolean; lyrics: LyricsResult; loading: boolean; playback: PlaybackController; textSize: "small" | "standard" | "large" }) {
  if (!playback.current) return <PanelEmpty icon={MessageSquareQuote} text="Play a track to see its lyrics." />;
  if (loading) return <div className="panel-loading">Loading lyrics…</div>;
  if (!lyrics.lines.length) return <PanelEmpty icon={MessageSquareQuote} text="No lyrics were returned for this song." />;
  return <LyricsLines autoScroll={autoScroll} lyrics={lyrics} playback={playback} textSize={textSize} />;
}

function LyricsLines({ autoScroll, lyrics, playback, textSize }: { autoScroll: boolean; lyrics: LyricsResult; playback: PlaybackController; textSize: "small" | "standard" | "large" }) {
  const activeIndex = activeLyricIndex(lyrics, playback.position);
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!autoScroll) return;
    if (typeof activeRef.current?.scrollIntoView !== "function") return;
    activeRef.current.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "center",
    });
  }, [activeIndex, autoScroll]);
  return (
    <div className={`lyrics-panel lyrics-panel--${textSize}`} aria-label={lyrics.synced ? "Synced lyrics" : "Lyrics"}>
      {lyrics.lines.map((line, index) => lyrics.synced ? (
        <button aria-current={index === activeIndex ? "true" : undefined} className={index === activeIndex ? "lyric-line lyric-line--active" : "lyric-line"} key={`${line.start}-${index}`} onClick={() => playback.seek(line.start)} ref={index === activeIndex ? activeRef : undefined} type="button">
          {line.value || "Instrumental"}
        </button>
      ) : <p className="lyric-line lyric-line--plain" key={`${line.start}-${index}`}>{line.value || "Instrumental"}</p>)}
    </div>
  );
}

function activeLyricIndex(lyrics: LyricsResult, position: number) {
  return lyrics.synced
    ? lyrics.lines.reduce((active, line, index) => line.start <= position + 0.12 ? index : active, 0)
    : -1;
}

function ConnectPanel({ canHandoff, groupId, onMoveHere, onMoveToDevice, onSend, onStartGroup, onStopGroup, snapshot }: {
  canHandoff: boolean;
  groupId?: string;
  onMoveHere: (peer: ConnectPeer) => void;
  onMoveToDevice: (peer: ConnectPeer) => void;
  onSend: (peerId: string, command: ConnectCommand) => void;
  onStartGroup: () => void;
  onStopGroup: () => void;
  snapshot: ConnectSnapshot;
}) {
  return (
    <div className="connect-panel">
      <div className="connect-local">
        <MonitorSpeaker size={21} />
        <span><strong>This computer</strong><small>{snapshot.isAvailable ? "Visible on your local network" : "Local discovery unavailable"}</small></span>
        <i className={snapshot.isAvailable ? "connect-dot connect-dot--online" : "connect-dot"} />
      </div>
      {canHandoff && snapshot.peers.length > 0 && (
        <button className={groupId ? "group-session group-session--active" : "group-session"} onClick={groupId ? onStopGroup : onStartGroup} type="button">
          <MonitorSpeaker size={18} /><span><strong>{groupId ? "End group session" : "Play on every device"}</strong><small>{groupId ? "This computer is keeping the group in sync." : "Start a synchronized session with the players below."}</small></span>
        </button>
      )}
      {snapshot.peers.length ? snapshot.peers.map((peer) => (
        <section className="connect-device" key={peer.id}>
          <div className="connect-device__identity">
            <MonitorSpeaker size={21} />
            <span><strong>{peer.name}</strong><small>{peer.platform}{peer.playback.title ? ` · ${peer.playback.title}` : " · Not playing"}</small></span>
          </div>
          {peer.playback.trackId && (
            <><div className="connect-device__track">
              <MediaArtwork alt="" className="queue-row__art" coverArt={peer.playback.coverArtId} />
              <span><strong>{peer.playback.title}</strong><small>{peer.playback.artist}</small></span>
            </div><PlaybackProgress className="connect-device__progress" duration={peer.playback.duration} isPlaying={peer.playback.isPlaying} onSeek={(value) => onSend(peer.id, { name: "seek", value })} position={peer.playback.position} /></>
          )}
          <div className="connect-device__controls">
            <button aria-label={`Previous on ${peer.name}`} onClick={() => onSend(peer.id, { name: "previous" })} type="button"><SkipBack fill="currentColor" size={16} /></button>
            <button aria-label={`${peer.playback.isPlaying ? "Pause" : "Play"} on ${peer.name}`} onClick={() => onSend(peer.id, { name: peer.playback.isPlaying ? "pause" : "play" })} type="button">{peer.playback.isPlaying ? <Pause fill="currentColor" size={17} /> : <Play fill="currentColor" size={17} />}</button>
            <button aria-label={`Next on ${peer.name}`} onClick={() => onSend(peer.id, { name: "next" })} type="button"><SkipForward fill="currentColor" size={16} /></button>
          </div>
          <div className="connect-device__actions">
            {peer.playback.trackId && <button onClick={() => onMoveHere(peer)} type="button">Play here</button>}
            {canHandoff && <button className="connect-primary" onClick={() => onMoveToDevice(peer)} type="button">Play on {peer.name}</button>}
          </div>
        </section>
      )) : <PanelEmpty icon={MonitorSpeaker} text="No other Splice players found on this network." />}
    </div>
  );
}

function PanelEmpty({ icon: Icon, text }: { icon: typeof ListMusic; text: string }) {
  return <div className="panel-empty"><Icon size={36} /><p>{text}</p></div>;
}

type FullPlayerStyle = CSSProperties & { "--player-color": string };

export function FullPlayer({ liked, lyrics, lyricsAutoScroll, lyricsLoading, lyricsTextSize, onClose, onOpenAlbum, onOpenArtist, onOpenPanel, onToggleLike, playback }: {
  liked: boolean;
  lyrics: LyricsResult;
  lyricsAutoScroll: boolean;
  lyricsLoading: boolean;
  lyricsTextSize: "small" | "standard" | "large";
  onClose: () => void;
  onOpenAlbum: (id: string) => void;
  onOpenArtist: (id: string) => void;
  onOpenPanel: (mode: ContextPanelMode) => void;
  onToggleLike: () => void;
  playback: PlaybackController;
}) {
  const [surface, setSurface] = useState<"artwork" | "lyrics">("artwork");
  const [menuOpen, setMenuOpen] = useState(false);
  const exitRef = useRef<HTMLButtonElement>(null);
  const artworkColor = useArtworkColor(playback.current?.coverArt);
  useEffect(() => {
    exitRef.current?.focus();
    return () => document.querySelector<HTMLButtonElement>("[data-full-player-toggle]")?.focus();
  }, []);
  if (!playback.current) return null;
  const current = playback.current;
  const quality = [current.bitRate ? `${current.bitRate} kbps` : "Original", current.suffix?.toUpperCase()].filter(Boolean).join(" · ");
  const style = { "--player-color": artworkColor ?? "rgb(30, 75, 55)" } as FullPlayerStyle;
  const showPanel = (mode: ContextPanelMode) => { setMenuOpen(false); onOpenPanel(mode); };
  const openAlbum = () => { if (current.albumId) { onClose(); onOpenAlbum(current.albumId); } };
  const openArtist = () => { if (current.artistId) { onClose(); onOpenArtist(current.artistId); } };

  return (
    <section
      aria-label="Expanded player"
      className={`full-player full-player--${surface}`}
      onKeyDown={(event) => {
        if (event.key === "Escape" && menuOpen) {
          event.stopPropagation();
          setMenuOpen(false);
        }
      }}
      style={style}
    >
      <header className="full-player__header">
        <span className="full-player__context"><strong>{current.title}</strong><small>Playing from {playback.contextLabel}</small></span>
        <div className="full-player__header-actions">
          <div aria-label="Expanded player view" className="full-player__view-options" role="radiogroup">
            <button aria-checked={surface === "artwork"} aria-label="Show artwork" className={surface === "artwork" ? "full-player__header-action full-player__header-action--active" : "full-player__header-action"} onClick={() => setSurface("artwork")} role="radio" title="Artwork" type="button"><Disc3 size={19} /></button>
            <button aria-checked={surface === "lyrics"} aria-label="Show lyrics" className={surface === "lyrics" ? "full-player__header-action full-player__header-action--active" : "full-player__header-action"} disabled={!lyricsLoading && lyrics.lines.length === 0} onClick={() => setSurface("lyrics")} role="radio" title="Lyrics" type="button"><MessageSquareQuote size={19} /></button>
          </div>
          <button aria-label="Open queue" className="full-player__header-action" onClick={() => showPanel("queue")} title="Queue" type="button"><ListMusic size={19} /></button>
          <button aria-label="Open Splice Connect devices" className="full-player__header-action" onClick={() => showPanel("connect")} title="Devices" type="button"><MonitorSpeaker size={19} /></button>
          <div className="full-player__menu-wrap">
            <button aria-expanded={menuOpen} aria-haspopup="menu" aria-label="More options" className="full-player__header-action" onClick={() => setMenuOpen((value) => !value)} title="More" type="button"><MoreHorizontal size={20} /></button>
            {menuOpen && <div aria-label="Current track" className="full-player__menu" role="menu">
              {current.artistId && <button onClick={openArtist} role="menuitem" type="button"><UserRound size={16} />Go to artist</button>}
              {current.albumId && <button onClick={openAlbum} role="menuitem" type="button"><Disc3 size={16} />Go to album</button>}
              <button onClick={() => { onToggleLike(); setMenuOpen(false); }} role="menuitem" type="button"><Heart fill={liked ? "currentColor" : "none"} size={16} />{liked ? "Remove from Liked Songs" : "Save to Liked Songs"}</button>
              <button onClick={() => showPanel("queue")} role="menuitem" type="button"><ListMusic size={16} />Open queue</button>
            </div>}
          </div>
          <button aria-label="Exit full player" className="full-player__close" onClick={onClose} ref={exitRef} type="button"><Minimize2 size={21} /></button>
        </div>
      </header>

      <div className="full-player__scroll">
        {surface === "artwork" ? <>
          <section aria-label="Artwork" className="full-player__hero">
            <MediaArtwork alt={`${current.title} cover`} className="full-player__art" coverArt={current.coverArt} />
          </section>
          <section aria-label="About current track" className="full-player__details">
            <article className="full-player__detail-card full-player__detail-card--artist">
              <UserRound size={24} /><p className="eyebrow">ABOUT THE ARTIST</p><h2>{current.artist}</h2><p>Artist information from your connected music server.</p>
              {current.artistId && <button onClick={openArtist} type="button">View artist</button>}
            </article>
            <article className="full-player__detail-card"><p className="eyebrow">CREDITS</p><h2>Credits</h2><dl><dt>Main artist</dt><dd>{current.artist}</dd><dt>Source</dt><dd>{playback.contextLabel}</dd></dl></article>
            <article className="full-player__detail-card full-player__detail-card--album">
              <MediaArtwork alt={`${current.album} cover`} className="full-player__detail-art" coverArt={current.coverArt} />
              <span><p className="eyebrow">FROM THE ALBUM</p><h2>{current.album}</h2><p>{[current.artist, current.year].filter(Boolean).join(" · ")}</p>{current.albumId && <button onClick={openAlbum} type="button">View album</button>}</span>
            </article>
            <article className="full-player__detail-card"><Info size={22} /><p className="eyebrow">PLAYBACK</p><h2>{quality}</h2><p>{current.duration ? `${Math.floor(current.duration / 60)} min ${Math.floor(current.duration % 60)} sec` : "Duration unavailable"}</p></article>
          </section>
        </> : <section aria-label="Lyrics" className="full-player__lyrics-surface">
          <div className="full-player__lyrics-heading"><span><p className="eyebrow">LYRICS</p><h2>{lyrics.synced ? "Following playback" : "Full lyrics"}</h2></span><button aria-label="Show artwork" onClick={() => setSurface("artwork")} type="button"><X size={20} /></button></div>
          {lyricsLoading ? <div className="full-player__lyrics-empty">Loading lyrics…</div> : lyrics.lines.length ? <FullLyrics autoScroll={lyricsAutoScroll} lyrics={lyrics} playback={playback} textSize={lyricsTextSize} /> : <div className="full-player__lyrics-empty">No lyrics were returned for this song.</div>}
        </section>}
      </div>
    </section>
  );
}

function FullLyrics({ autoScroll, lyrics, playback, textSize }: { autoScroll: boolean; lyrics: LyricsResult; playback: PlaybackController; textSize: "small" | "standard" | "large" }) {
  const activeIndex = activeLyricIndex(lyrics, playback.position);
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!autoScroll || !lyrics.synced) return;
    if (typeof activeRef.current?.scrollIntoView !== "function") return;
    activeRef.current.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "center" });
  }, [activeIndex, autoScroll, lyrics.synced]);
  return (
    <div className={`full-lyrics full-lyrics--${textSize}`}>
      {lyrics.lines.map((line, index) => lyrics.synced ? (
        <button
          aria-current={index === activeIndex ? "true" : undefined}
          className={index === activeIndex ? "full-lyrics__line full-lyrics__line--active" : index < activeIndex ? "full-lyrics__line full-lyrics__line--past" : "full-lyrics__line"}
          key={`${line.start}-${index}`}
          onClick={() => playback.seek(line.start)}
          ref={index === activeIndex ? activeRef : undefined}
          type="button"
        >{line.value || "Instrumental"}</button>
      ) : <p className="full-lyrics__line full-lyrics__line--plain" key={`${line.start}-${index}`}>{line.value || "Instrumental"}</p>)}
    </div>
  );
}

function prefersReducedMotion() {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export type TrackMenuState = { song: SongSummary; index: number; x: number; y: number };

export function TrackContextMenu({ downloaded, liked, menu, onAddToPlaylist, onClose, onDownload, onEnqueue, onOpenAlbum, onOpenArtist, onPlayNext, onRadio, onRemoveDownload, onRemoveFromPlaylist, onToggleLike, targetCount }: {
  downloaded: boolean;
  liked: boolean;
  menu: TrackMenuState;
  onAddToPlaylist: () => void;
  onClose: () => void;
  onDownload: () => void;
  onEnqueue: () => void;
  onOpenAlbum?: () => void;
  onOpenArtist?: () => void;
  onPlayNext: () => void;
  onRadio: () => void;
  onRemoveDownload: () => void;
  onRemoveFromPlaylist?: () => void;
  onToggleLike: () => void;
  targetCount: number;
}) {
  const menuRef = useMenuFocus(onClose);
  const style = { left: Math.max(8, Math.min(menu.x, window.innerWidth - 270)), top: Math.max(8, Math.min(menu.y, window.innerHeight - 380)) };
  const stop = (action: () => void) => (event: ReactMouseEvent) => { event.stopPropagation(); action(); onClose(); };
  const many = targetCount > 1;
  return (
    <div className="context-menu" ref={menuRef} role="menu" style={style}>
      <strong className="context-menu__title">{many ? `${targetCount} songs` : menu.song.title}</strong>
      <button onClick={stop(onPlayNext)} role="menuitem" type="button"><ListEnd size={16} />Play next</button>
      <button onClick={stop(onEnqueue)} role="menuitem" type="button"><ListMusic size={16} />Add to queue</button>
      <button onClick={stop(onAddToPlaylist)} role="menuitem" type="button"><Plus size={16} />Add to playlist…</button>
      <button onClick={stop(onToggleLike)} role="menuitem" type="button"><Heart fill={liked ? "currentColor" : "none"} size={16} />{liked ? "Remove from Liked Songs" : "Save to Liked Songs"}</button>
      <button onClick={stop(downloaded ? onRemoveDownload : onDownload)} role="menuitem" type="button">{downloaded ? <Trash2 size={16} /> : <Download size={16} />}{downloaded ? "Remove download" : "Download"}</button>
      {!many && <><span className="context-menu__separator" />
      <button onClick={stop(onRadio)} role="menuitem" type="button"><Radio size={16} />Go to song radio</button>
      {onOpenArtist && <button onClick={stop(onOpenArtist)} role="menuitem" type="button"><UserRound size={16} />Go to artist</button>}
      {onOpenAlbum && <button onClick={stop(onOpenAlbum)} role="menuitem" type="button"><Disc3 size={16} />Go to album</button>}</>}
      {onRemoveFromPlaylist && !many && <><span className="context-menu__separator" /><button className="context-menu__danger" onClick={stop(onRemoveFromPlaylist)} role="menuitem" type="button"><Trash2 size={16} />Remove from this playlist</button></>}
    </div>
  );
}
