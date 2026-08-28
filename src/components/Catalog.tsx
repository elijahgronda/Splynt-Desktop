import { CheckCircle2, Cloud, Heart, MoreHorizontal, Pause, Play } from "lucide-react";
import { useRef, useState } from "react";
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from "react";
import type { AlbumSummary, ArtistSummary, DownloadProgress, PlaylistSummary, SongSummary } from "../types";
import { parseExternalSource } from "../lib/externalSource";
import { MediaArtwork } from "./MediaArtwork";

export function formatDuration(value?: number) {
  if (!value || !Number.isFinite(value)) return "—";
  const total = Math.max(0, Math.round(value));
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date) : undefined;
}

type AlbumCardProps = {
  album: AlbumSummary;
  onMenu?: (event: ReactMouseEvent) => void;
  onOpen: (album: AlbumSummary) => void;
  onPlay: (album: AlbumSummary) => void;
};

export function AlbumCard({ album, onMenu, onOpen, onPlay }: AlbumCardProps) {
  return (
    <article className="catalog-card" onContextMenu={onMenu ? (event) => { event.preventDefault(); onMenu(event); } : undefined}>
      <button className="catalog-card__body" data-search-result onClick={() => onOpen(album)} type="button">
        <MediaArtwork alt={`${album.title} cover`} coverArt={album.coverArt} />
        <strong title={album.title}>{album.title}</strong>
        <span title={album.artist}>{album.artist}{album.year ? ` · ${album.year}` : ""}</span>
      </button>
      <button className="catalog-card__play" aria-label={`Play ${album.title}`} onClick={() => onPlay(album)} type="button">
        <Play fill="currentColor" size={21} />
      </button>
    </article>
  );
}

type ArtistCardProps = { artist: ArtistSummary; onMenu?: (event: ReactMouseEvent) => void; onOpen: (artist: ArtistSummary) => void };

export function ArtistCard({ artist, onMenu, onOpen }: ArtistCardProps) {
  return (
    <article className="catalog-card catalog-card--artist" onContextMenu={onMenu ? (event) => { event.preventDefault(); onMenu(event); } : undefined}>
      <button className="catalog-card__body" data-search-result onClick={() => onOpen(artist)} type="button">
        <MediaArtwork alt={`${artist.name} portrait`} coverArt={artist.coverArt} fallback="artist" shape="circle" />
        <strong title={artist.name}>{artist.name}</strong>
        <span>Artist{artist.albumCount ? ` · ${artist.albumCount} albums` : ""}</span>
      </button>
    </article>
  );
}

type PlaylistCardProps = {
  playlist: PlaylistSummary;
  onMenu?: (event: ReactMouseEvent) => void;
  onOpen: (playlist: PlaylistSummary) => void;
  onPlay: (playlist: PlaylistSummary) => void;
};

export function PlaylistCard({ playlist, onMenu, onOpen, onPlay }: PlaylistCardProps) {
  return (
    <article className="catalog-card" onContextMenu={onMenu ? (event) => { event.preventDefault(); onMenu(event); } : undefined}>
      <button className="catalog-card__body" data-search-result onClick={() => onOpen(playlist)} type="button">
        <MediaArtwork alt={`${playlist.name} cover`} coverArt={playlist.coverArt} fallback="playlist" />
        <strong title={playlist.name}>{playlist.name}</strong>
        <span>{playlist.owner ? `By ${playlist.owner}` : "Playlist"}{playlist.songCount ? ` · ${playlist.songCount} songs` : ""}</span>
      </button>
      <button className="catalog-card__play" aria-label={`Play ${playlist.name}`} onClick={() => onPlay(playlist)} type="button">
        <Play fill="currentColor" size={21} />
      </button>
    </article>
  );
}

type TrackTableProps = {
  songs: SongSummary[];
  currentId?: string;
  isPlaying?: boolean;
  onPlay: (index: number) => void;
  onOpenAlbum?: (id: string) => void;
  onOpenArtist?: (id: string) => void;
  onToggleStar?: (song: SongSummary) => void;
  onMenu?: (song: SongSummary, index: number, event: ReactMouseEvent) => void;
  onSelect?: (song: SongSummary, index: number, event: ReactMouseEvent) => void;
  selectedIds?: Set<string>;
  downloadedIds?: Set<string>;
  downloadProgress?: Record<string, DownloadProgress>;
  showDateAdded?: boolean;
  showAlbum?: boolean;
  onReorder?: (from: number, to: number) => void;
};

/// The payload every track drag carries. A drop target reads it to learn which
/// songs were dragged, whether that is one row or a whole selection.
export const SONG_DRAG_TYPE = "application/x-splice-songs";

export function readSongDrag(event: ReactDragEvent): string[] {
  try {
    const raw = event.dataTransfer.getData(SONG_DRAG_TYPE);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function TrackTable({
  songs,
  currentId,
  isPlaying,
  onPlay,
  onOpenAlbum,
  onOpenArtist,
  onToggleStar,
  onMenu,
  onSelect,
  selectedIds,
  downloadedIds,
  downloadProgress,
  showDateAdded,
  showAlbum = true,
  onReorder,
}: TrackTableProps) {
  const activeIndex = currentId ? songs.findIndex((song) => song.id === currentId) : -1;
  const dragFrom = useRef<number | undefined>(undefined);
  const [dropTarget, setDropTarget] = useState<number>();
  return (
    <div aria-label="Songs" aria-rowcount={songs.length + 1} className={showAlbum ? "track-table" : "track-table track-table--no-album"} role="grid">
      <div className="track-row track-row--header" role="row">
        <span role="columnheader">#</span><span role="columnheader">Title</span>{showAlbum && <span role="columnheader">Album</span>}<span aria-label="Duration" role="columnheader">◷</span>
      </div>
      {songs.map((song, index) => {
        const active = index === activeIndex;
        const selected = selectedIds?.has(`${song.id}-${index}`) ?? false;
        const external = Boolean(parseExternalSource(song.id));
        const offline = downloadedIds?.has(song.id) ?? false;
        const transfer = downloadProgress?.[song.id];
        const quality = [song.bitRate ? `${song.bitRate} kbps` : undefined, song.suffix?.toUpperCase()].filter(Boolean).join(" · ");
        return (
          <div
            aria-selected={selected}
            className={`${active ? "track-row track-row--active" : "track-row"}${selected ? " track-row--selected" : ""}${dropTarget === index ? " track-row--drop" : ""}`}
            key={`${song.id}-${index}`}
            onClick={(event) => onSelect?.(song, index, event)}
            onContextMenu={(event) => { event.preventDefault(); onMenu?.(song, index, event); }}
            onDoubleClick={() => onPlay(index)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onPlay(index);
                return;
              }
              if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
              const rows = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLElement>("[role='row'][tabindex='0']") ?? []);
              const current = rows.indexOf(event.currentTarget);
              const next = event.key === "ArrowDown" ? Math.min(rows.length - 1, current + 1) : Math.max(0, current - 1);
              event.preventDefault();
              rows[next]?.focus();
            }}
            role="row"
            aria-rowindex={index + 2}
            data-search-result
            draggable
            onDragEnd={() => { dragFrom.current = undefined; setDropTarget(undefined); }}
            onDragLeave={() => setDropTarget((value) => value === index ? undefined : value)}
            onDragOver={onReorder ? (event) => { if (dragFrom.current === undefined) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropTarget(index); } : undefined}
            onDragStart={(event) => {
              // Dragging a row that is part of a selection drags the selection.
              const ids = selectedIds?.has(`${song.id}-${index}`)
                ? songs.filter((item, itemIndex) => selectedIds.has(`${item.id}-${itemIndex}`)).map((item) => item.id)
                : [song.id];
              event.dataTransfer.setData(SONG_DRAG_TYPE, JSON.stringify(ids));
              event.dataTransfer.setData("text/plain", song.title);
              event.dataTransfer.effectAllowed = "copyMove";
              dragFrom.current = ids.length === 1 ? index : undefined;
            }}
            onDrop={onReorder ? (event) => {
              const from = dragFrom.current;
              dragFrom.current = undefined;
              setDropTarget(undefined);
              if (from === undefined || from === index) return;
              event.preventDefault();
              onReorder(from, index);
            } : undefined}
            tabIndex={0}
          >
            <span className="track-row__index-cell" role="gridcell"><button className="track-row__index" aria-label={`Play ${song.title}`} onClick={(event) => { event.stopPropagation(); onPlay(index); }} type="button">
              {active && isPlaying ? <Pause fill="currentColor" size={14} /> : <><span>{index + 1}</span><Play className="track-row__hover-play" fill="currentColor" size={14} /></>}
            </button></span>
            <span className="track-row__title" role="gridcell">
              <strong>{song.title}{song.explicitStatus && song.explicitStatus !== "clean" && <span aria-label="Explicit" className="explicit-badge">E</span>}{external && <Cloud aria-label="External source" className="external-source" size={12} />}{offline && <CheckCircle2 aria-label="Available offline" className="downloaded-source" size={13} />}</strong>
              {song.artistId && onOpenArtist ? (
                <button onClick={(event) => { event.stopPropagation(); onOpenArtist(song.artistId!); }} type="button">{song.artist}</button>
              ) : <small>{song.artist}</small>}{showDateAdded && song.created && formatDate(song.created) && <small className="track-date">Added {formatDate(song.created)}</small>}
            </span>
            {showAlbum && <span className="track-row__album" role="gridcell">
              {song.albumId && onOpenAlbum ? <button onClick={(event) => { event.stopPropagation(); onOpenAlbum(song.albumId!); }} type="button">{song.album}</button> : song.album}
            </span>}
            <span className="track-row__duration" role="gridcell">
              {quality && <small className="track-quality">{quality}</small>}
              {transfer?.status === "downloading" && <small className="download-progress-label">{transfer.total ? `${Math.min(100, Math.round(transfer.received / transfer.total * 100))}%` : "Downloading"}</small>}
              {onToggleStar && (
                <button className={song.starred ? "track-like track-like--active" : "track-like"} aria-label={song.starred ? "Remove from Liked Songs" : "Save to Liked Songs"} onClick={(event) => { event.stopPropagation(); onToggleStar(song); }} type="button">
                  <Heart fill={song.starred ? "currentColor" : "none"} size={15} />
                </button>
              )}
              {onMenu && <button aria-label={`More options for ${song.title}`} className="track-menu" onClick={(event) => { event.stopPropagation(); onMenu(song, index, event); }} type="button"><MoreHorizontal size={17} /></button>}
              {formatDuration(song.duration)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
