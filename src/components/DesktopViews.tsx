import { Coffee, Disc3, Download, HardDrive, Heart, LayoutGrid, List, LoaderCircle, Pencil, Play, Radio, RotateCcw, Shuffle, Trash2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type {
  AlbumDetail, AlbumSummary, ArtistDetail, ArtistSummary, ConnectedLibrary, ContextPanelMode,
  DesktopRoute, HomeOverview, HomeShortcut, JumpBackInItem, LibraryOverview, PlaylistDetail,
  PlaylistSummary, RadioResult, SearchResults, SongSummary,
} from "../types";
import { AlbumCard, ArtistCard, formatDuration, PlaylistCard, TrackTable } from "./Catalog";
import { MediaArtwork } from "./MediaArtwork";
import { SmoothRange } from "./RangeSlider";
import { useArtworkColor } from "../hooks/useArtworkColor";
import type { DownloadsController } from "../hooks/useDownloads";
import {
  audioFormats, effectiveStreamQuality, homeRowLabels, homeRows, lyricsSources, lyricsTextSizes, qualityTiers, tierDetail,
  tierLabel, transcodes, type AudioFormat, type DesktopSettings, type HomeRow, type QualityTier,
} from "../lib/settings";
import { offlineCacheDegraded } from "../lib/persistence";

export const searchFilters = ["all", "songs", "artists", "albums", "playlists"] as const;
export type SearchFilter = (typeof searchFilters)[number];

export type CardMenu = {
  album: (album: AlbumSummary, event: ReactMouseEvent) => void;
  artist: (artist: ArtistSummary, event: ReactMouseEvent) => void;
  playlist: (playlist: PlaylistSummary, event: ReactMouseEvent) => void;
};

export type DetailState = AlbumDetail | PlaylistDetail | ArtistDetail;
export type LibraryFilter = "playlists" | "artists" | "albums";

function readRecentSearches(key: string) {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}

export function PageHeading({ eyebrow, title, subtitle }: { eyebrow?: string; title: string; subtitle?: string }) {
  return <div className="desktop-content__heading">{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>;
}

export function HomeView({ cardMenu, data, error, hiddenRows, jumpBackIn, likedAlbums, onOpen, onOpenJumpBackIn, onOpenShortcut, onPlay, onPlayShortcut, onRetry, rowOrder, shortcuts, title }: {
  cardMenu: CardMenu;
  data: HomeOverview;
  error?: string;
  hiddenRows: HomeRow[];
  jumpBackIn: JumpBackInItem[];
  likedAlbums: AlbumSummary[];
  onOpen: (album: AlbumSummary) => void;
  onOpenJumpBackIn: (item: JumpBackInItem) => void;
  onOpenShortcut: (item: HomeShortcut) => void;
  onPlay: (album: AlbumSummary) => void;
  onPlayShortcut: (item: HomeShortcut) => void;
  onRetry: () => void;
  rowOrder: HomeRow[];
  shortcuts: HomeShortcut[];
  title: string;
}) {
  type AlbumHomeRow = Exclude<HomeRow, "jumpBackIn">;
  const named: Record<AlbumHomeRow, Array<readonly [string, AlbumSummary[]]>> = {
    recentlyPlayed: [[homeRowLabels.recentlyPlayed, data.recent]],
    recentlyAdded: [[homeRowLabels.recentlyAdded, data.newest]],
    onRepeat: [[homeRowLabels.onRepeat, data.frequent]],
    genreMixes: (data.genres ?? []).map((shelf) => [shelf.name, shelf.albums] as const),
    albumsFeaturingLiked: [[homeRowLabels.albumsFeaturingLiked, likedAlbums]],
    discover: [[homeRowLabels.discover, data.random]],
  };
  const visibleRows = rowOrder.filter((row) => !hiddenRows.includes(row));
  const shelves = visibleRows
    .filter((row): row is AlbumHomeRow => row !== "jumpBackIn")
    .flatMap((row) => named[row]);
  // Match iOS' cooldown rule: an album already visible in the leading server
  // history should not immediately repeat in Jump back in beneath it.
  const leadingRecentAlbums = new Set(data.recent.slice(0, 8).map((album) => album.id));
  const distinctJumpBackIn = jumpBackIn.filter((item) => item.kind !== "album" || !leadingRecentAlbums.has(item.id));
  const jumpBackInVisible = visibleRows.includes("jumpBackIn") && distinctJumpBackIn.length > 0;
  return <>
    <PageHeading title={title} />
    {shortcuts.length > 0 && <div aria-label="Quick access" className="home-quick-grid">{shortcuts.map((item) => <article key={`${item.kind}:${item.id}`}>
      <button aria-label={`Open ${item.title}`} className="home-quick-grid__open" onClick={() => onOpenShortcut(item)} type="button">
        {item.kind === "liked" ? <span className="home-quick-grid__art liked-mini"><Heart fill="currentColor" size={22} /></span> : <MediaArtwork alt="" className="home-quick-grid__art" coverArt={item.coverArt} fallback={item.kind === "playlist" ? "playlist" : "album"} />}
        <span><strong>{item.title}</strong><small>{item.subtitle}</small></span>
      </button>
      <button aria-label={`Play ${item.title}`} className="home-quick-grid__play" onClick={() => onPlayShortcut(item)} type="button"><Play fill="currentColor" size={18} /></button>
    </article>)}</div>}
    {error && <RetryState message={error} onRetry={onRetry} />}
    {visibleRows.map((row) => row === "jumpBackIn"
      ? distinctJumpBackIn.length > 0 && <section className="catalog-shelf" key={row}><h2>{homeRowLabels.jumpBackIn}</h2><div className="catalog-row">{distinctJumpBackIn.map((item) => <article className={`catalog-card${item.kind === "artist" ? " catalog-card--artist" : ""}`} key={`${item.kind}:${item.id}`}>
        <button className="catalog-card__body" onClick={() => onOpenJumpBackIn(item)} type="button">
          <MediaArtwork alt="" coverArt={item.coverArt} fallback={item.kind} shape={item.kind === "artist" ? "circle" : "square"} />
          <strong title={item.title}>{item.title}</strong><span title={item.subtitle}>{item.subtitle}</span>
        </button>
      </article>)}</div></section>
      : named[row].map(([name, albums]) => albums.length > 0 && <section className="catalog-shelf" key={`${row}:${name}`}><h2>{name}</h2><div className="catalog-row">{albums.map((album) => <AlbumCard album={album} key={`${name}-${album.id}`} onMenu={(event) => cardMenu.album(album, event)} onOpen={onOpen} onPlay={onPlay} />)}</div></section>))}
    {!error && !shortcuts.length && !jumpBackInVisible && shelves.every(([, albums]) => albums.length === 0) && <EmptyState title="Nothing to show on Home" body="Add music to the connected server, or turn a shelf back on in Settings." />}
  </>;
}

export function SearchView({ cardMenu, currentId, data, filter, hasResults, historyKey, home, isLoading, isPlaying, onFilter, onMenu, onOpenAlbum, onOpenArtist, onOpenPlaylist, onPlayAlbum, onPlayPlaylist, onPlaySongs, onRecent, onSelect, playlists, query, selectedIds }: {
  filter: SearchFilter; onFilter: (filter: SearchFilter) => void;
  cardMenu: CardMenu; currentId?: string; data: SearchResults; hasResults: boolean; historyKey: string; home: HomeOverview; isLoading: boolean; isPlaying: boolean;
  onMenu: (song: SongSummary, index: number, event: ReactMouseEvent) => void; onOpenAlbum: (album: AlbumSummary) => void; onOpenArtist: (artist: ArtistSummary) => void; onOpenPlaylist: (playlist: PlaylistSummary) => void;
  onPlayAlbum: (album: AlbumSummary) => void; onPlayPlaylist: (playlist: PlaylistSummary) => void; onPlaySongs: (songs: SongSummary[], index: number) => void; onRecent: (query: string) => void;
  onSelect: (song: SongSummary, index: number, event: ReactMouseEvent) => void; playlists: PlaylistSummary[]; query: string; selectedIds: Set<string>;
}) {
  const [recent, setRecent] = useState(() => readRecentSearches(historyKey));
  const topSong = data.songs[0];
  const topAlbum = data.albums[0];
  const topArtist = data.artists[0];
  useEffect(() => setRecent(readRecentSearches(historyKey)), [historyKey, query]);
  useEffect(() => {
    const move = (event: KeyboardEvent) => {
      if (!(event.target instanceof HTMLElement) || !event.target.matches("[data-search-result]")) return;
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const results = Array.from(document.querySelectorAll<HTMLElement>("[data-search-result]"));
      const index = results.indexOf(event.target);
      const next = event.key === "ArrowDown" ? Math.min(results.length - 1, index + 1) : Math.max(0, index - 1);
      event.preventDefault();
      results[next]?.focus();
    };
    window.addEventListener("keydown", move);
    return () => window.removeEventListener("keydown", move);
  }, []);
  return <>
    <PageHeading title="Search" subtitle={query ? `Results from your server for “${query}”` : "Artists, albums, playlists, and songs from your connected library."} />
    {query && !isLoading && hasResults && <div className="filter-chips">{searchFilters.map((value) => <button aria-pressed={filter === value} className={filter === value ? "filter-chip filter-chip--active" : "filter-chip"} key={value} onClick={() => onFilter(value)} type="button">{value === "all" ? "All" : value[0].toUpperCase() + value.slice(1)}</button>)}</div>}
    {isLoading && <LoadingState label="Searching your server" />}
    {!query && recent.length > 0 && <section className="recent-searches"><header><h2>Recent searches</h2><button onClick={() => { localStorage.removeItem(historyKey); setRecent([]); }} type="button">Clear all</button></header><div>{recent.map((item) => <button key={item} onClick={() => onRecent(item)} type="button">{item}</button>)}</div></section>}
    {!query && <section className="catalog-shelf"><h2>Browse your library</h2><div className="catalog-grid">{home.random.slice(0, 12).map((album) => <AlbumCard album={album} key={album.id} onMenu={(event) => cardMenu.album(album, event)} onOpen={onOpenAlbum} onPlay={onPlayAlbum} />)}</div></section>}
    {query && !isLoading && !hasResults && <EmptyState title="No results found" body="Check the spelling or try fewer words." />}
    {query && !isLoading && hasResults && filter === "all" && <section className="top-result"><h2>Top result</h2>{topSong ? <article><button data-search-result onClick={() => onPlaySongs(data.songs, 0)} type="button"><MediaArtwork alt="" className="top-result__art" coverArt={topSong.coverArt} /><span><small>SONG</small><strong>{topSong.title}</strong><em>{topSong.artist}</em></span><Play fill="currentColor" size={22} /></button></article> : topAlbum ? <article><button data-search-result onClick={() => onOpenAlbum(topAlbum)} type="button"><MediaArtwork alt="" className="top-result__art" coverArt={topAlbum.coverArt} /><span><small>ALBUM</small><strong>{topAlbum.title}</strong><em>{topAlbum.artist}</em></span></button></article> : topArtist ? <article><button data-search-result onClick={() => onOpenArtist(topArtist)} type="button"><MediaArtwork alt="" className="top-result__art" coverArt={topArtist.coverArt} fallback="artist" shape="circle" /><span><small>ARTIST</small><strong>{topArtist.name}</strong><em>{topArtist.albumCount ? `${topArtist.albumCount} albums` : "Artist"}</em></span></button></article> : playlists[0] ? <article><button data-search-result onClick={() => onOpenPlaylist(playlists[0])} type="button"><MediaArtwork alt="" className="top-result__art" coverArt={playlists[0].coverArt} fallback="playlist" /><span><small>PLAYLIST</small><strong>{playlists[0].name}</strong><em>{playlists[0].owner ?? "Playlist"}</em></span></button></article> : null}</section>}
    {data.songs.length > 0 && (filter === "all" || filter === "songs") && <section className="result-section"><h2>Songs</h2><TrackTable currentId={currentId} isPlaying={isPlaying} onMenu={onMenu} onPlay={(index) => onPlaySongs(data.songs, index)} onSelect={onSelect} selectedIds={selectedIds} songs={data.songs} /></section>}
    {data.artists.length > 0 && (filter === "all" || filter === "artists") && <section className="catalog-shelf"><h2>Artists</h2><div className="catalog-grid">{data.artists.map((artist) => <ArtistCard artist={artist} key={artist.id} onMenu={(event) => cardMenu.artist(artist, event)} onOpen={onOpenArtist} />)}</div></section>}
    {data.albums.length > 0 && (filter === "all" || filter === "albums") && <section className="catalog-shelf"><h2>Albums</h2><div className="catalog-grid">{data.albums.map((album) => <AlbumCard album={album} key={album.id} onMenu={(event) => cardMenu.album(album, event)} onOpen={onOpenAlbum} onPlay={onPlayAlbum} />)}</div></section>}
    {playlists.length > 0 && (filter === "all" || filter === "playlists") && <section className="catalog-shelf"><h2>Playlists</h2><div className="catalog-grid">{playlists.map((playlist) => <PlaylistCard key={playlist.id} onMenu={(event) => cardMenu.playlist(playlist, event)} onOpen={onOpenPlaylist} onPlay={onPlayPlaylist} playlist={playlist} />)}</div></section>}
  </>;
}

export function LibraryView({ cardMenu, error, filter, grid, items, onFilter, onOpenAlbum, onOpenArtist, onOpenPlaylist, onPlayAlbum, onPlayPlaylist, onRetry, onToggleGrid }: { cardMenu: CardMenu; error?: string; filter: LibraryFilter; grid: boolean; items: Array<AlbumSummary | ArtistSummary | PlaylistSummary>; onFilter: (filter: LibraryFilter) => void; onOpenAlbum: (album: AlbumSummary) => void; onOpenArtist: (artist: ArtistSummary) => void; onOpenPlaylist: (playlist: PlaylistSummary) => void; onPlayAlbum: (album: AlbumSummary) => void; onPlayPlaylist: (playlist: PlaylistSummary) => void; onRetry: () => void; onToggleGrid: () => void }) {
  const [visibleCount, setVisibleCount] = useState(240);
  useEffect(() => setVisibleCount(240), [filter, items.length]);
  const visible = items.slice(0, visibleCount);
  return <><PageHeading title="Your Library" subtitle={`${items.length.toLocaleString()} ${filter} from your music server.`} /><div className="filter-chips">{(["playlists", "artists", "albums"] as LibraryFilter[]).map((value) => <button aria-pressed={filter === value} className={filter === value ? "filter-chip filter-chip--active" : "filter-chip"} key={value} onClick={() => onFilter(value)} type="button">{value[0].toUpperCase() + value.slice(1)}</button>)}<button className="filter-chip filter-chip--sort" onClick={onToggleGrid} title={grid ? "Show as list" : "Show as grid"} type="button">{grid ? <List size={13} /> : <LayoutGrid size={13} />}{grid ? "List" : "Grid"}</button></div>{error && <RetryState message={error} onRetry={onRetry} />}<div className={grid ? "catalog-grid" : "catalog-list"}>{filter === "albums" && (visible as AlbumSummary[]).map((album) => <AlbumCard album={album} key={album.id} onMenu={(event) => cardMenu.album(album, event)} onOpen={onOpenAlbum} onPlay={onPlayAlbum} />)}{filter === "artists" && (visible as ArtistSummary[]).map((artist) => <ArtistCard artist={artist} key={artist.id} onMenu={(event) => cardMenu.artist(artist, event)} onOpen={onOpenArtist} />)}{filter === "playlists" && (visible as PlaylistSummary[]).map((playlist) => <PlaylistCard key={playlist.id} onMenu={(event) => cardMenu.playlist(playlist, event)} onOpen={onOpenPlaylist} onPlay={onPlayPlaylist} playlist={playlist} />)}</div>{visibleCount < items.length && <div className="load-more"><button onClick={() => setVisibleCount((count) => Math.min(items.length, count + 240))} type="button">Show more</button><span>{visible.length.toLocaleString()} of {items.length.toLocaleString()}</span></div>}{!error && items.length === 0 && <EmptyState title={`No ${filter} found`} body={`Your server did not return any ${filter}.`} />}</>;
}

export function LikedView({ currentId, isPlaying, onMenu, onPlay, onPlayCollection, onSelect, onToggleShuffle, onToggleStar, selectedIds, shuffleArmed, songs }: { currentId?: string; isPlaying: boolean; onMenu: (song: SongSummary, index: number, event: ReactMouseEvent) => void; onPlay: (songs: SongSummary[], index: number) => void; onPlayCollection: (songs: SongSummary[], label: string) => void; onSelect: (song: SongSummary, index: number, event: ReactMouseEvent) => void; onToggleShuffle: () => void; onToggleStar: (song: SongSummary) => void; selectedIds: Set<string>; shuffleArmed: boolean; songs: SongSummary[] }) {
  return <><div className="liked-hero"><span><Heart fill="currentColor" size={64} /></span><div><p className="eyebrow">PLAYLIST</p><h1>Liked Songs</h1><p>{songs.length} {songs.length === 1 ? "song" : "songs"}</p></div></div>{songs.length > 0 && <div className="collection-actions"><button aria-label="Play Liked Songs" className="primary-play" onClick={() => onPlayCollection(songs, "Liked Songs")} type="button"><Play fill="currentColor" size={26} /></button><ShuffleToggle armed={shuffleArmed} onToggle={onToggleShuffle} /></div>}{songs.length ? <TrackTable currentId={currentId} isPlaying={isPlaying} onMenu={onMenu} onPlay={(index) => onPlay(songs, index)} onSelect={onSelect} onToggleStar={onToggleStar} selectedIds={selectedIds} showDateAdded songs={songs} /> : <EmptyState title="Songs you like will appear here" body="Use the heart beside a song to save it." />}</>;
}

export function DetailView({ cardMenu, collectionStarred, currentId, detail, onEnlarge, downloads, isLoading, isPlaying, onDelete, onDownloadCollection, onMenu, onOpenAlbum, onOpenArtist, onPlay, onPlayAlbum, onPlayCollection, onRadio, onRemoveCollection, onRename, onReorder, onSelect, onToggleCollectionStar, onToggleShuffle, onToggleStar, ownsPlaylist, route, selectedIds, shuffleArmed }: { cardMenu: CardMenu; collectionStarred: boolean; currentId?: string; detail?: DetailState; onEnlarge: (coverArt: string | undefined, alt: string) => void; downloads: DownloadsController; isLoading: boolean; isPlaying: boolean; onDelete: () => void; onDownloadCollection: (songs: SongSummary[]) => void; onMenu: (song: SongSummary, index: number, event: ReactMouseEvent) => void; onOpenAlbum: (id: string) => void; onOpenArtist: (id: string) => void; onPlay: (songs: SongSummary[], index: number, label: string) => void; onPlayAlbum: (album: AlbumSummary) => void; onPlayCollection: (songs: SongSummary[], label: string) => void; onRadio: (song: SongSummary) => void; onRemoveCollection: (songs: SongSummary[]) => void; onRename: () => void; onReorder: (from: number, to: number) => void; onSelect: (song: SongSummary, index: number, event: ReactMouseEvent) => void; onToggleCollectionStar: () => void; onToggleShuffle: () => void; onToggleStar: (song: SongSummary) => void; ownsPlaylist: boolean; route: DesktopRoute; selectedIds: Set<string>; shuffleArmed: boolean }) {
  if (isLoading || !detail) return <LoadingState label="Loading from your server" />;
  if (route.kind === "artist" && "albums" in detail) return <><CollectionHero coverArt={detail.coverArt} /><div className="collection-hero collection-hero--artist"><button aria-label={`Enlarge ${detail.name} portrait`} className="hero-art-button" onClick={() => onEnlarge(detail.coverArt, `${detail.name} portrait`)} type="button"><MediaArtwork alt={`${detail.name} portrait`} className="collection-hero__art" coverArt={detail.coverArt} fallback="artist" shape="circle" /></button><div><p className="eyebrow">ARTIST</p><h1>{detail.name}</h1><p>{detail.albumCount ?? detail.albums.length} albums</p></div></div><div className="collection-actions">{detail.topSongs?.length ? <button className="primary-play" aria-label={`Play ${detail.name}`} onClick={() => onPlayCollection(detail.topSongs!, detail.name)} type="button"><Play fill="currentColor" size={26} /></button> : null}{detail.topSongs?.length ? <ShuffleToggle armed={shuffleArmed} onToggle={onToggleShuffle} /> : null}<button aria-pressed={collectionStarred} className={collectionStarred ? "secondary-action secondary-action--armed" : "secondary-action"} onClick={onToggleCollectionStar} type="button"><Heart fill={collectionStarred ? "currentColor" : "none"} size={17} /> {collectionStarred ? "Following" : "Follow"}</button>{detail.topSongs?.[0] && <button className="secondary-action" onClick={() => onRadio(detail.topSongs![0])} type="button"><Radio size={17} /> Artist radio</button>}</div>{detail.topSongs?.length ? <section className="result-section"><h2>Popular</h2><TrackTable currentId={currentId} isPlaying={isPlaying} onMenu={onMenu} onOpenAlbum={onOpenAlbum} onOpenArtist={onOpenArtist} onPlay={(index) => onPlay(detail.topSongs!, index, detail.name)} onSelect={onSelect} onToggleStar={onToggleStar} selectedIds={selectedIds} songs={detail.topSongs.slice(0, 10)} /></section> : null}<section className="catalog-shelf"><h2>Discography</h2><div className="catalog-grid">{detail.albums.map((album) => <AlbumCard album={album} key={album.id} onMenu={(event) => cardMenu.album(album, event)} onOpen={() => onOpenAlbum(album.id)} onPlay={onPlayAlbum} />)}</div></section>{detail.appearances?.length ? <section className="catalog-shelf"><h2>Appears on</h2><div className="catalog-grid">{detail.appearances.map((album) => <AlbumCard album={album} key={album.id} onMenu={(event) => cardMenu.album(album, event)} onOpen={() => onOpenAlbum(album.id)} onPlay={onPlayAlbum} />)}</div></section> : null}</>;
  if (!("songs" in detail)) return null;
  const isAlbum = route.kind === "album";
  const title = isAlbum ? (detail as AlbumDetail).title : (detail as PlaylistDetail).name;
  const creator = isAlbum ? (detail as AlbumDetail).artist : (detail as PlaylistDetail).owner ?? "Playlist";
  const allDownloaded = detail.songs.length > 0 && detail.songs.every((song) => downloads.downloadedIds.has(song.id));
  return <><CollectionHero coverArt={detail.coverArt} /><div className="collection-hero"><button aria-label={`Enlarge ${title} cover`} className="hero-art-button" onClick={() => onEnlarge(detail.coverArt, `${title} cover`)} type="button"><MediaArtwork alt={`${title} cover`} className="collection-hero__art" coverArt={detail.coverArt} fallback={isAlbum ? "album" : "playlist"} /></button><div><p className="eyebrow">{isAlbum ? "ALBUM" : "PLAYLIST"}</p><h1>{title}</h1><p>{creator} · {detail.songs.length} songs · {formatDuration(detail.duration)}</p></div></div><div className="collection-actions"><button className="primary-play" aria-label={`Play ${title}`} onClick={() => onPlayCollection(detail.songs, title)} type="button"><Play fill="currentColor" size={26} /></button>{detail.songs[0] && <ShuffleToggle armed={shuffleArmed} onToggle={onToggleShuffle} />}{isAlbum && <button aria-label={collectionStarred ? "Remove album from Liked" : "Save album to Liked"} aria-pressed={collectionStarred} className={collectionStarred ? "secondary-action collection-icon-action secondary-action--armed" : "secondary-action collection-icon-action"} onClick={onToggleCollectionStar} title={collectionStarred ? "Remove album from Liked" : "Save album to Liked"} type="button"><Heart fill={collectionStarred ? "currentColor" : "none"} size={22} /></button>}{detail.songs.length > 0 && <button aria-label={allDownloaded ? "Remove download" : "Download"} className="secondary-action collection-icon-action" onClick={() => allDownloaded ? onRemoveCollection(detail.songs) : onDownloadCollection(detail.songs)} title={allDownloaded ? "Remove download" : "Download"} type="button"><Download size={22} /></button>}{!isAlbum && ownsPlaylist && <button className="secondary-action" onClick={onRename} type="button"><Pencil size={16} /> Rename</button>}{!isAlbum && ownsPlaylist && <button className="secondary-action secondary-action--danger" onClick={onDelete} type="button"><Trash2 size={16} /> Delete</button>}</div>{detail.songs.length ? <TrackTable currentId={currentId} downloadProgress={downloads.progress} downloadedIds={downloads.downloadedIds} isPlaying={isPlaying} onMenu={onMenu} onOpenAlbum={onOpenAlbum} onOpenArtist={onOpenArtist} onPlay={(index) => onPlay(detail.songs, index, title)} onReorder={!isAlbum && ownsPlaylist ? onReorder : undefined} onSelect={onSelect} onToggleStar={onToggleStar} selectedIds={selectedIds} showAlbum={!isAlbum} songs={detail.songs} /> : <EmptyState title="This collection is empty" body="The connected server returned no songs." />}</>;
}

export function RadioView({ currentId, data, isLoading, isPlaying, onMenu, onPlay, onPlayCollection, onSelect, onToggleShuffle, onToggleStar, selectedIds, shuffleArmed, title }: { currentId?: string; data?: RadioResult; isLoading: boolean; isPlaying: boolean; onMenu: (song: SongSummary, index: number, event: ReactMouseEvent) => void; onPlay: (songs: SongSummary[], index: number) => void; onPlayCollection: (songs: SongSummary[], label: string) => void; onSelect: (song: SongSummary, index: number, event: ReactMouseEvent) => void; onToggleShuffle: () => void; onToggleStar: (song: SongSummary) => void; selectedIds: Set<string>; shuffleArmed: boolean; title: string }) {
  if (isLoading || !data) return <LoadingState label="Building your radio" />;
  return <><div className="radio-hero"><span><Radio size={70} /></span><div><p className="eyebrow">MADE FOR YOU</p><h1>{title}</h1><p>An endless-feeling mix from your own server.</p></div></div><div className="collection-actions"><button aria-label={`Play ${title}`} className="primary-play" onClick={() => onPlayCollection(data.songs, title)} type="button"><Play fill="currentColor" size={26} /></button><ShuffleToggle armed={shuffleArmed} onToggle={onToggleShuffle} /></div><TrackTable currentId={currentId} isPlaying={isPlaying} onMenu={onMenu} onPlay={(index) => onPlay(data.songs, index)} onSelect={onSelect} onToggleStar={onToggleStar} selectedIds={selectedIds} songs={data.songs} /></>;
}

function formatBytes(bytes: number) {
  if (bytes < 1_000_000) return `${Math.max(0, bytes / 1_000).toFixed(1)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

export function DownloadsView({ currentId, downloads, isPlaying, onClear, onMenu, onPlay, onSelect }: { currentId?: string; downloads: DownloadsController; isPlaying: boolean; onClear: () => void; onMenu: (song: SongSummary, index: number, event: ReactMouseEvent) => void; onPlay: (songs: SongSummary[], index: number) => void; onSelect: (song: SongSummary, index: number, event: ReactMouseEvent) => void }) {
  const songs = downloads.items.map((item) => item.song);
  if (downloads.loading) return <LoadingState label="Loading offline music" />;
  return <><PageHeading eyebrow="OFFLINE" title="Downloads" subtitle="Music stored on this computer for this server profile." /><div className="download-summary"><span><HardDrive size={19} /><strong>{songs.length} {songs.length === 1 ? "track" : "tracks"}</strong><small>{formatBytes(downloads.totalBytes)} used</small></span>{songs.length > 0 && <button onClick={onClear} type="button"><Trash2 size={16} /> Clear downloads</button>}</div>{songs.length > 0 ? <TrackTable currentId={currentId} downloadProgress={downloads.progress} downloadedIds={downloads.downloadedIds} isPlaying={isPlaying} onMenu={onMenu} onPlay={(index) => onPlay(songs, index)} onSelect={onSelect} showDateAdded songs={songs} /> : <EmptyState title="No downloads yet" body="Use a song or collection menu to make music available offline." />}{downloads.failures.length > 0 && <section className="download-failures"><h2>{downloads.failures.length} {downloads.failures.length === 1 ? "track" : "tracks"} did not finish</h2><p>The rest of the batch continued. Retry the ones that stalled.</p><ul>{downloads.failures.slice(0, 30).map((failure) => <li key={failure.song.id}><span><strong>{failure.song.title}</strong><small>{failure.message}</small></span><button onClick={() => void downloads.download(failure.song).catch(() => undefined)} type="button">Retry</button></li>)}</ul><button className="secondary-action" onClick={() => void downloads.retryFailed()} type="button"><RotateCcw size={16} /> Retry all</button></section>}{Object.values(downloads.progress).some((item) => item.status === "downloading" || item.status === "paused") && <section className="download-transfers"><h2>Transfers</h2>{Object.values(downloads.progress).filter((item) => item.status !== "complete").map((item) => <div key={item.id}><Download size={17} /><span><strong>{item.status === "paused" ? "Paused" : item.status === "failed" ? "Needs attention" : "Downloading"}</strong><small>{item.message ?? (item.total ? `${formatBytes(item.received)} of ${formatBytes(item.total)}` : formatBytes(item.received))}</small></span>{item.status === "downloading" && <button onClick={() => void downloads.pause(item.id)} type="button">Pause</button>}</div>)}</section>}</>;
}

export function ProfileView({ connectionStatus, library, onDevices, onSettings, onSignOut, overview }: { connectionStatus: "online" | "offline"; library: ConnectedLibrary; onDevices: () => void; onSettings: () => void; onSignOut: () => void; overview: LibraryOverview }) {
  return <><div className="profile-hero"><span>{library.server.username.slice(0, 1).toUpperCase()}</span><div><p className="eyebrow">SPLICE PROFILE</p><h1>{library.server.username}</h1><p><i className={connectionStatus === "online" ? "profile-status profile-status--online" : "profile-status"} />{connectionStatus === "online" ? "Connected" : "Offline"} · {library.server.displayHost}</p></div></div><div className="profile-stats"><span><strong>{overview.albums.length.toLocaleString()}</strong><small>Albums</small></span><span><strong>{overview.artists.length.toLocaleString()}</strong><small>Artists</small></span><span><strong>{overview.playlists.length.toLocaleString()}</strong><small>Playlists</small></span><span><strong>{overview.starredSongs.length.toLocaleString()}</strong><small>Liked songs</small></span></div><div className="profile-actions"><button className="modal-primary" onClick={onSettings} type="button">Settings</button><button onClick={onDevices} type="button">Splice Connect</button><button onClick={onSignOut} type="button">Switch account</button></div></>;
}

export function SettingsView({ contextWidth, downloads, library, onClearDownloads, onOpenPanel, onReload, onResetLayout, onSleep, settings, sidebarWidth, sleepRemaining, updateSetting, resetSettings }: { contextWidth: number; downloads: DownloadsController; library: ConnectedLibrary; onClearDownloads: () => void; onOpenPanel: (mode: ContextPanelMode) => void; onReload: () => void; onResetLayout: () => void; onSleep: (minutes: number | undefined) => void; settings: DesktopSettings; sidebarWidth: number; sleepRemaining?: number; updateSetting: <K extends keyof DesktopSettings>(key: K, value: DesktopSettings[K]) => void; resetSettings: () => void }) {
  const [cache, setCache] = useState({ files: 0, bytes: 0 });
  const [diagnosticsPath, setDiagnosticsPath] = useState<string>();
  useEffect(() => { void invoke<string | null>("diagnostics_path").then((path) => setDiagnosticsPath(path ?? undefined)).catch(() => undefined); }, []);
  const refreshCache = () => void invoke<{ files: number; bytes: number }>("cache_stats").then((value) => setCache(value && Number.isFinite(value.files) && Number.isFinite(value.bytes) ? value : { files: 0, bytes: 0 })).catch(() => setCache({ files: 0, bytes: 0 }));
  useEffect(refreshCache, []);
  const streamTier = effectiveStreamQuality(settings);
  return <><PageHeading title="Settings" subtitle="Desktop playback, library, and device preferences." /><div className="settings-grid">
    <section><h2>Account</h2><dl><dt>Server</dt><dd>{library.server.displayHost}</dd><dt>Username</dt><dd>{library.server.username}</dd><dt>Server software</dt><dd>{library.server.serverType ?? "Subsonic compatible"} {library.server.serverVersion ?? ""}</dd><dt>API</dt><dd>{library.server.apiVersion ?? "Unknown"}</dd></dl><button disabled={settings.offlineMode} onClick={onReload} type="button">Refresh library</button></section>

    <section><h2>Playback</h2>
      <SettingToggle checked={settings.gapless} label="Gapless playback" hint="Joins a natural transition with no silence between tracks." onChange={(value) => updateSetting("gapless", value)} />
      <SettingToggle checked={settings.autoplay} label="Autoplay" hint="Keeps going with similar songs when the queue runs out." onChange={(value) => updateSetting("autoplay", value)} />
      <div className="setting-row setting-row--pickers"><span><strong>Shuffle order</strong><small>{settings.shuffleMode === "fewerRepeats" ? "Plays what you have not heard lately first." : "Pure random order."}</small></span><span className="setting-row__controls"><select aria-label="Shuffle order" onChange={(event) => updateSetting("shuffleMode", event.target.value as DesktopSettings["shuffleMode"])} value={settings.shuffleMode}><option value="fewerRepeats">Fewer repeats</option><option value="random">Random</option></select></span></div>
      <label className="setting-row setting-row--slider"><span><strong>Crossfade</strong><small>{settings.crossfadeSeconds ? `${settings.crossfadeSeconds}s on natural transitions only` : "Off"}</small></span><SmoothRange aria-label="Crossfade seconds" max={12} min={0} onChange={(value) => updateSetting("crossfadeSeconds", value)} step={1} value={settings.crossfadeSeconds} /></label>
      <SettingToggle checked={settings.lyricsAutoScroll} label="Lyrics follow playback" hint="Keeps the active line centred while a synced lyric plays." onChange={(value) => updateSetting("lyricsAutoScroll", value)} />
      <div className="setting-row setting-row--pickers"><span><strong>Lyrics source</strong><small>Auto checks your server first, then uses LRCLIB when the server has no lyrics.</small></span><span className="setting-row__controls"><select aria-label="Lyrics source" onChange={(event) => updateSetting("lyricsSource", event.target.value as DesktopSettings["lyricsSource"])} value={settings.lyricsSource}>{lyricsSources.map((source) => <option key={source} value={source}>{source === "auto" ? "Auto" : source === "server" ? "Music server" : "LRCLIB (public)"}</option>)}</select></span></div>
      <div className="setting-row setting-row--pickers"><span><strong>Lyrics text size</strong><small>Applies to the lyrics panel.</small></span><span className="setting-row__controls"><select aria-label="Lyrics text size" onChange={(event) => updateSetting("lyricsTextSize", event.target.value as DesktopSettings["lyricsTextSize"])} value={settings.lyricsTextSize}>{lyricsTextSizes.map((size) => <option key={size} value={size}>{size[0].toUpperCase() + size.slice(1)}</option>)}</select></span></div>
      <SettingToggle checked={settings.hideExternalPlaylists} label="Hide external playlists" hint="Leaves out playlists that come from a connected provider rather than your server." onChange={(value) => updateSetting("hideExternalPlaylists", value)} />
      <SettingToggle checked={settings.hideExplicitContent} label="Hide explicit content" hint="Filters explicit tracks out of browsing. Downloads are never hidden." onChange={(value) => updateSetting("hideExplicitContent", value)} />
      <SettingToggle checked={settings.keepPlayingInBackground} label="Keep playing when the window closes" hint="Closing hides Splice to the tray instead of quitting. Quit always stops playback." onChange={(value) => updateSetting("keepPlayingInBackground", value)} />
    </section>

    <section><h2>Audio quality</h2>
      <SettingToggle checked={settings.offlineMode} label="Offline mode" hint="Makes no network requests. Only downloaded music plays." onChange={(value) => updateSetting("offlineMode", value)} />
      <SettingToggle checked={settings.dataSaver} label="Data saver" hint="Overrides streaming quality with Low until you turn it off." onChange={(value) => updateSetting("dataSaver", value)} />
      <QualityPicker disabled={settings.dataSaver} format={settings.streamFormat} label="Streaming" onFormat={(value) => updateSetting("streamFormat", value)} onTier={(value) => updateSetting("streamQuality", value)} tier={streamTier} />
      <QualityPicker format={settings.downloadFormat} label="Downloads" onFormat={(value) => updateSetting("downloadFormat", value)} onTier={(value) => updateSetting("downloadQuality", value)} tier={settings.downloadQuality} />
    </section>

    <section><h2>Home shelves</h2>
      <p className="setting-note">Choose the server and listening-history shelves that appear on Home.</p>
      <ul className="row-order">{settings.homeRowOrder.map((row, index) => {
        const hidden = settings.hiddenHomeRows.includes(row);
        return <li key={row}>
          <label><input checked={!hidden} onChange={() => updateSetting("hiddenHomeRows", hidden ? settings.hiddenHomeRows.filter((item) => item !== row) : [...settings.hiddenHomeRows, row])} type="checkbox" /><span>{homeRowLabels[row]}</span></label>
          <span>
            <button aria-label={`Move ${homeRowLabels[row]} up`} disabled={index === 0} onClick={() => updateSetting("homeRowOrder", swapRows(settings.homeRowOrder, index, index - 1))} type="button">↑</button>
            <button aria-label={`Move ${homeRowLabels[row]} down`} disabled={index === settings.homeRowOrder.length - 1} onClick={() => updateSetting("homeRowOrder", swapRows(settings.homeRowOrder, index, index + 1))} type="button">↓</button>
          </span>
        </li>;
      })}</ul>
      <div className="settings-actions"><button onClick={() => { updateSetting("homeRowOrder", [...homeRows]); updateSetting("hiddenHomeRows", []); }} type="button">Reset shelves</button></div>
    </section>

    <section><h2>Sleep timer</h2>
      <p>{sleepRemaining === undefined ? "No timer running." : `Playback stops in ${Math.ceil(sleepRemaining / 60_000)} min.`}</p>
      <div className="settings-actions">{[15, 30, 45, 60].map((minutes) => <button key={minutes} onClick={() => onSleep(minutes)} type="button">{minutes} min</button>)}{sleepRemaining !== undefined && <button className="modal-danger" onClick={() => onSleep(undefined)} type="button">Cancel</button>}</div>
    </section>

    <section><h2>Desktop layout</h2><dl><dt>Library width</dt><dd>{Math.round(sidebarWidth)} px</dd><dt>Context width</dt><dd>{Math.round(contextWidth)} px</dd><dt>Queue recovery</dt><dd>On</dd><dt>Media keys</dt><dd>{mediaKeySupport()}</dd></dl><div className="settings-actions"><button onClick={() => onOpenPanel("nowPlaying")} type="button">Open Now Playing</button><button onClick={onResetLayout} type="button">Reset layout</button><button onClick={resetSettings} type="button">Reset preferences</button></div></section>

    <section><h2>Offline storage</h2><dl><dt>Downloaded tracks</dt><dd>{downloads.items.length.toLocaleString()}</dd><dt>Audio usage</dt><dd>{formatBytes(downloads.totalBytes)}</dd><dt>Artwork cache</dt><dd>{cache.files.toLocaleString()} files · {formatBytes(cache.bytes)}</dd><dt>Profile scope</dt><dd>{library.server.username}@{library.server.displayHost}</dd><dt>Offline browsing</dt><dd>{offlineCacheDegraded() ? "Limited — this library is too large for the local store" : "Saved"}</dd></dl><p>Partial downloads are retained so interrupted transfers can resume. Downloaded audio always plays before the network copy.</p><div className="settings-actions">{downloads.items.length > 0 && <button onClick={onClearDownloads} type="button">Clear downloads</button>}{cache.files > 0 && <button onClick={() => void invoke("clear_artwork_cache").then(() => { setCache({ files: 0, bytes: 0 }); })} type="button">Clear artwork cache</button>}</div></section>

    <section><h2>Diagnostics</h2>
      <p>Splice records what it is doing to a log file — launches, failures, anything the interface reports, and any crash of the previous session. Nothing leaves this computer unless you send it.</p>
      <dl><dt>Log file</dt><dd className="settings-path">{diagnosticsPath ?? "Not created yet"}</dd></dl>
      <div className="settings-actions"><button disabled={!diagnosticsPath} onClick={() => void invoke("reveal_diagnostics").catch(() => undefined)} type="button">Show log</button></div>
    </section>

    <section><h2>Splice Connect</h2><p>Players signed in to this server account can hand off playback, act as remotes, or join a synchronized group.</p><button onClick={() => onOpenPanel("connect")} type="button">Open devices</button></section>

    <section><h2>Keyboard</h2><dl><dt>Search</dt><dd>⌘/Ctrl K</dd><dt>Play or pause</dt><dd>Space</dd><dt>Queue</dt><dd>⌘/Ctrl ⇧ Q</dd><dt>Preferences</dt><dd>⌘/Ctrl ,</dd><dt>Shortcut help</dt><dd>?</dd></dl><p>Back and Forward also follow your platform’s browser shortcuts.</p></section>
  </div>
  {/* Outside the grid on purpose: as another <section> it would read as one
      more settings card competing with Playback and Offline storage. Sitting
      under the grid it closes the page instead of interrupting it. */}
  <footer className="settings-support">
    {/* No supporting copy. Anything framing this as "Splice is free" would be
        a pricing claim, and the iOS app is not committed to being free once it
        reaches the App Store. The link stands on its own. */}
    <button onClick={() => void invoke("open_support_page").catch(() => undefined)} type="button">
      <Coffee size={15} /> Buy me a coffee
    </button>
  </footer></>;
}

/// WebKitGTK does not implement Media Session, so the Linux build cannot claim
/// media-key support the way macOS and Windows can.
function mediaKeySupport() {
  if (!("mediaSession" in navigator)) return "Unavailable in this webview";
  return document.documentElement.dataset.platform === "linux" ? "Limited on Linux (no MPRIS yet)" : "On";
}

/// Full-bleed cover, opened from a hero or the full player. Escape and a click
/// anywhere dismiss it.
export function ArtworkLightbox({ alt, coverArt, onClose }: { alt: string; coverArt?: string; onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return (
    <button aria-label={`Close ${alt}`} className="artwork-lightbox" onClick={onClose} type="button">
      <MediaArtwork alt={alt} className="artwork-lightbox__art" coverArt={coverArt} />
    </button>
  );
}

/// Paints the tint behind the hero. Rendered as a sibling so the heading
/// markup keeps its own stacking and the wash can bleed past the page padding.
function CollectionHero({ coverArt }: { coverArt?: string }) {
  const color = useArtworkColor(coverArt);
  if (!color) return null;
  return <div aria-hidden="true" className="collection-wash" style={{ background: `linear-gradient(180deg, ${color} 0%, rgba(18,18,18,0) 62%)` }} />;
}

function swapRows(order: HomeRow[], from: number, to: number) {
  const next = [...order];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

function SettingToggle({ checked, hint, label, onChange }: { checked: boolean; hint: string; label: string; onChange: (value: boolean) => void }) {
  return <label className="setting-row"><span><strong>{label}</strong><small>{hint}</small></span><input checked={checked} onChange={(event) => onChange(event.target.checked)} type="checkbox" /></label>;
}

function QualityPicker({ disabled, format, label, onFormat, onTier, tier }: { disabled?: boolean; format: AudioFormat; label: string; onFormat: (value: AudioFormat) => void; onTier: (value: QualityTier) => void; tier: QualityTier }) {
  return (
    <div className="setting-row setting-row--pickers">
      <span><strong>{label}</strong><small>{tierDetail(tier)}{transcodes(tier) ? ` · ${format.toUpperCase()}` : " · no transcode"}</small></span>
      <span className="setting-row__controls">
        <select aria-label={`${label} quality`} disabled={disabled} onChange={(event) => onTier(Number(event.target.value) as QualityTier)} value={tier}>
          {qualityTiers.map((value) => <option key={value} value={value}>{tierLabel(value)}</option>)}
        </select>
        <select aria-label={`${label} format`} disabled={disabled || !transcodes(tier)} onChange={(event) => onFormat(event.target.value as AudioFormat)} value={format}>
          {audioFormats.map((value) => <option key={value} value={value}>{value.toUpperCase()}</option>)}
        </select>
      </span>
    </div>
  );
}

/// Arm-only, matching the iOS engine: this flips the one shared shuffle flag
/// and starts nothing. Play consumes the flag.
export function ShuffleToggle({ armed, onToggle }: { armed: boolean; onToggle: () => void }) {
  return <button aria-label={armed ? "Disable shuffle" : "Enable shuffle"} aria-pressed={armed} className={armed ? "secondary-action collection-icon-action secondary-action--armed" : "secondary-action collection-icon-action"} onClick={onToggle} title={armed ? "Disable shuffle" : "Enable shuffle"} type="button"><Shuffle size={22} /></button>;
}

export function LoadingState({ label }: { label: string }) { return <div aria-busy="true" className="loading-state" role="status"><div className="loading-state__signal"><LoaderCircle className="loading-spinner" size={24} /><p>{label}</p></div><div aria-hidden="true" className="loading-skeleton"><i /><i /><i /></div></div>; }
export function RetryState({ message, onRetry }: { message: string; onRetry: () => void }) { return <div className="retry-state" role="status"><p>{message}</p><button onClick={onRetry} type="button"><RotateCcw size={14} /> Retry</button></div>; }
export function EmptyState({ body, title }: { body: string; title: string }) { return <section className="empty-library"><Disc3 size={46} /><h2>{title}</h2><p>{body}</p></section>; }
