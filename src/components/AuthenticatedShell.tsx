import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowDownUp, ArrowLeft, ArrowRight, Home, Download, Heart, Library, LogOut, Pin, Play, Plus,
  Search, Settings, UserRound, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentPropsWithoutRef, CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { usePlayback } from "../hooks/usePlayback";
import { useDownloads } from "../hooks/useDownloads";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { dedupeAlbums, dedupeArtists, dedupeSearchResults, parseExternalSource, trackMetadataKey } from "../lib/externalSource";
import { isExternalLiked, mergeExternalLikes, setExternalLiked } from "../lib/externalLikes";
import { cacheDetail, cachedDetail, cacheHome, cacheLibraryOverview, cachedDataFor } from "../lib/persistence";
import { driftCorrection, projectedGroupPosition } from "../lib/connectClock";
import { endGroupDiagnostics, logConnectEvent, noteGroupSample, noteGroupTrackChange } from "../lib/connectDiagnostics";
import { readRecentCollections, rememberRecentCollection } from "../lib/recentCollections";
import { useSettings } from "../lib/settings";
import type {
  AlbumDetail, AlbumSummary, ArtistDetail, ArtistSummary, ConnectedLibrary, ConnectCommand,
  ConnectGroup, ConnectPeer, ConnectSnapshot, ContextPanelMode, DesktopRoute, HomeOverview, HomeShortcut,
  JumpBackInItem, LibraryOverview, LyricsResult, PlayQueueSnapshot, PlaylistDetail, PlaylistSummary,
  RadioResult, SearchResults, SongSummary,
} from "../types";
import { readSongDrag, SONG_DRAG_TYPE } from "./Catalog";
import { Brand } from "./Brand";
import {
  DesktopContextPanel, FullPlayer, TrackContextMenu, type TrackMenuState,
} from "./DesktopPanels";
import { MediaArtwork } from "./MediaArtwork";
import { AddToPlaylistDialog, CollectionMenu, SelectionBar, type CollectionMenuState } from "./Selection";
import { PlayerBar } from "./PlayerBar";
import * as Views from "./DesktopViews";

type AuthenticatedShellProps = {
  library: ConnectedLibrary;
  onConnectionRestored: (library: ConnectedLibrary) => void;
  onSignedOut: () => void;
};
type DetailState = AlbumDetail | PlaylistDetail | ArtistDetail;
type LibraryFilter = "playlists" | "artists" | "albums";
type LocalGroupSession = { id: string; leaderID: string; memberIDs: string[] };

/// How long a leader waits for devices to answer an invitation. Long enough
/// for a follower to resolve a cold track against the server, short enough
/// that a listener does not think the button is broken.
const GROUP_JOIN_TIMEOUT_MS = 3_000;

const emptySearch: SearchResults = { songs: [], albums: [], artists: [] };
const emptyLyrics: LyricsResult = { synced: false, lines: [] };

function routeKey(route: DesktopRoute) {
  return "id" in route ? `${route.kind}:${route.id}` : route.kind;
}

function greeting() {
  const hour = new Date().getHours();
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

function reasonMessage(reason: unknown, fallback: string) {
  const message = typeof reason === "string" ? reason : fallback;
  // Warn rather than error: these are handled failures that the user already
  // sees. The point is that the log knows about them too.
  console.warn("[splice]", message, reason instanceof Error ? reason : "");
  return message;
}

function readNumber(key: string, fallback: number) {
  const saved = localStorage.getItem(key);
  if (saved === null || saved.trim() === "") return fallback;
  const value = Number(saved);
  return Number.isFinite(value) ? value : fallback;
}

function readRecentSearches(key: string) {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}

export function AuthenticatedShell({ library, onConnectionRestored, onSignedOut }: AuthenticatedShellProps) {
  const cached = cachedDataFor(library);
  const profileScope = `${library.server.displayHost}|${library.server.username}`;
  const { settings, update: updateSetting, reset: resetSettings } = useSettings(profileScope);
  const queueExhausted = useRef<(last: SongSummary) => void>(() => undefined);
  const playback = usePlayback(profileScope, {
    shuffleMode: settings.shuffleMode,
    crossfadeSeconds: settings.crossfadeSeconds,
    equalizer: settings.equalizer,
    gapless: settings.gapless,
    autoplay: settings.autoplay,
    onQueueExhausted: (last) => queueExhausted.current(last),
  });
  const downloads = useDownloads();
  const playbackRef = useRef(playback);
  playbackRef.current = playback;
  const workspaceRef = useRef<HTMLDivElement>(null);
  const searchHistoryKey = `splice.search.history:${encodeURIComponent(`${library.server.displayHost}|${library.server.username}`)}`;
  const scrollPositions = useRef(new Map<string, number>());
  const [history, setHistory] = useState<DesktopRoute[]>([{ kind: "home" }]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const route = history[historyIndex];
  const [homeData, setHomeData] = useState<HomeOverview>(cached?.home ?? { newest: library.albums, recent: [], frequent: [], random: [], genres: [] });
  const [libraryData, setLibraryData] = useState<LibraryOverview>(() => {
    const initial = cached?.overview ?? { albums: library.albums, artists: [], playlists: [], starredSongs: [], starredAlbums: [], starredArtists: [] };
    return { ...initial, starredSongs: mergeExternalLikes(library, initial.starredSongs) };
  });
  const [connection, setConnection] = useState(library.connection ?? { status: "online" as const });
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilter>("playlists");
  const [librarySearch, setLibrarySearch] = useState("");
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResults>(emptySearch);
  const [searching, setSearching] = useState(false);
  const [searchFilter, setSearchFilter] = useState<Views.SearchFilter>("all");
  const [detail, setDetail] = useState<DetailState>();
  const [radioData, setRadioData] = useState<RadioResult>();
  const [pageLoading, setPageLoading] = useState(false);
  const [homeError, setHomeError] = useState<string>();
  const [libraryError, setLibraryError] = useState<string>();
  const [pageError, setPageError] = useState<string>();
  const [syncingResources, setSyncingResources] = useState(0);
  const [reconnecting, setReconnecting] = useState(false);
  const [leavingSession, setLeavingSession] = useState(false);
  const [toast, setToast] = useState<string>();
  const [panelMode, setPanelMode] = useState<ContextPanelMode>();
  const [fullPlayer, setFullPlayer] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [lyrics, setLyrics] = useState<LyricsResult>(emptyLyrics);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [connectState, setConnectState] = useState<ConnectSnapshot>({ isAvailable: false, peers: [], commands: [] });
  const connectRef = useRef(connectState);
  connectRef.current = connectState;
  /// Measured clock offsets by peer id, in milliseconds, from the Rust side's
  /// probe. Held in a ref rather than read off `connectState` because the
  /// commands in a snapshot are applied in the same tick that delivered it,
  /// before React has published the new state.
  const clockOffsets = useRef<Record<string, number>>({});
  /// The peer this device is currently acting as a remote for. iOS has always
  /// had this mode (`connectedPeerID` in PlayerEngine); the desktop sent a
  /// handoff, paused itself, and then its own transport drove nothing, so the
  /// only way to control the other device was three small buttons in a panel.
  const [remoteDevice, setRemoteDevice] = useState<{ id: string; name: string }>();
  const remoteRef = useRef(remoteDevice);
  remoteRef.current = remoteDevice;
  const [groupSession, setGroupSession] = useState<LocalGroupSession>();
  const groupRef = useRef(groupSession);
  groupRef.current = groupSession;
  const lastGroupTrack = useRef<string | undefined>(undefined);
  /// The invitation this device is waiting on answers for. A member is a
  /// device that came back and said it is rendering the session, not one this
  /// device managed to write a frame at: a stale-but-open socket accepts
  /// writes long after the peer behind it stopped listening, which is how a
  /// session used to report a member it had never reached.
  const pendingInvite = useRef<{
    sessionId: string; awaiting: Set<string>; accepted: string[]; declined: Map<string, string>;
  } | undefined>(undefined);
  /// The session revision this device has applied, as follower or leader.
  const groupRevision = useRef(0);
  /// Consecutive failed sends per member. A member that cannot be reached three
  /// times running is dropped from the session rather than addressed forever.
  const groupSendFailures = useRef(new Map<string, number>());
  const [sidebarWidth, setSidebarWidth] = useState(() => Math.max(72, Math.min(420, readNumber("splice.sidebar.width", 280))));
  const [trackMenu, setTrackMenu] = useState<TrackMenuState>();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const selectionAnchor = useRef(0);
  const [createPlaylistOpen, setCreatePlaylistOpen] = useState(false);
  const [saveQueueOpen, setSaveQueueOpen] = useState(false);
  const [clearDownloadsConfirm, setClearDownloadsConfirm] = useState(false);
  const [signOutConfirm, setSignOutConfirm] = useState(false);
  const [lightbox, setLightbox] = useState<{ coverArt?: string; alt: string }>();
  const [playlistTarget, setPlaylistTarget] = useState<SongSummary[]>();
  const [playlistEdit, setPlaylistEdit] = useState<{ id: string; name: string }>();
  const [playlistDelete, setPlaylistDelete] = useState<{ id: string; name: string }>();
  const [collectionMenu, setCollectionMenu] = useState<CollectionMenuState>();
  const [dropPlaylistId, setDropPlaylistId] = useState<string>();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [jumpBackIn, setJumpBackIn] = useState<JumpBackInItem[]>(() => readRecentCollections(profileScope));
  const pinnedKey = `splice.pinned:${encodeURIComponent(profileScope)}`;
  const [pinned, setPinned] = useState<Set<string>>(() => {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(pinnedKey) ?? "[]");
      return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
    } catch {
      return new Set<string>();
    }
  });
  const [librarySort, setLibrarySort] = useState<"recents" | "alphabetical">(() => localStorage.getItem("splice.library.sort") === "alphabetical" ? "alphabetical" : "recents");
  useEffect(() => localStorage.setItem("splice.library.sort", librarySort), [librarySort]);
  const togglePinned = useCallback((id: string) => {
    setPinned((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { localStorage.setItem(pinnedKey, JSON.stringify([...next])); } catch { /* a full store still applies this session */ }
      return next;
    });
  }, [pinnedKey]);
  const [workspaceScrolled, setWorkspaceScrolled] = useState(false);
  const [contextWidth, setContextWidth] = useState(() => Math.max(280, Math.min(460, readNumber("splice.context.width", 350))));
  const [sleepAt, setSleepAt] = useState<number>();
  const [sleepRemaining, setSleepRemaining] = useState<number>();
  const restoredServerQueue = useRef(false);
  // Offline fallbacks read through a ref so a library refresh does not re-issue
  // the live search or rebuild radio behind the user.
  const offlineSourceRef = useRef({ albums: libraryData.albums, artists: libraryData.artists, starredSongs: libraryData.starredSongs, downloads: downloads.items });
  offlineSourceRef.current = { albums: libraryData.albums, artists: libraryData.artists, starredSongs: libraryData.starredSongs, downloads: downloads.items };

  useEffect(() => localStorage.setItem("splice.sidebar.width", String(sidebarWidth)), [sidebarWidth]);
  useEffect(() => localStorage.setItem("splice.context.width", String(contextWidth)), [contextWidth]);
  useEffect(() => setJumpBackIn(readRecentCollections(profileScope)), [profileScope]);

  // The expanded artwork surface fills the workspace while the persistent
  // player remains mounted. Tauri removes platform chrome; browser tests and
  // unsupported hosts keep the same in-webview composition.
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    void getCurrentWindow().setFullscreen(fullPlayer).catch(() => undefined);
  }, [fullPlayer]);

  const navigate = useCallback((next: DesktopRoute) => {
    if (routeKey(next) === routeKey(history[historyIndex])) return;
    scrollPositions.current.set(routeKey(history[historyIndex]), workspaceRef.current?.scrollTop ?? 0);
    setHistory((current) => [...current.slice(0, historyIndex + 1), next]);
    setHistoryIndex((value) => value + 1);
    setSelectedIds(new Set());
    setPageError(undefined);
    setAccountOpen(false);
  }, [history, historyIndex]);

  const goBack = useCallback(() => {
    scrollPositions.current.set(routeKey(route), workspaceRef.current?.scrollTop ?? 0);
    setHistoryIndex((value) => Math.max(0, value - 1));
  }, [route]);
  const goForward = useCallback(() => {
    scrollPositions.current.set(routeKey(route), workspaceRef.current?.scrollTop ?? 0);
    setHistoryIndex((value) => Math.min(history.length - 1, value + 1));
  }, [history.length, route]);

  useEffect(() => {
    const position = scrollPositions.current.get(routeKey(route)) ?? 0;
    window.requestAnimationFrame(() => workspaceRef.current?.scrollTo({ top: position }));
  }, [route]);

  const reloadHome = useCallback(() => {
    setHomeError(undefined);
    setSyncingResources((count) => count + 1);
    invoke<HomeOverview>("load_home").then((raw) => {
      const value: HomeOverview = {
        newest: dedupeAlbums(raw.newest),
        recent: dedupeAlbums(raw.recent),
        frequent: dedupeAlbums(raw.frequent),
        random: dedupeAlbums(raw.random),
        genres: (raw.genres ?? []).map((shelf) => ({ ...shelf, albums: dedupeAlbums(shelf.albums) })),
      };
      setHomeData(value);
      cacheHome(library, value);
      setConnection({ status: "online" });
    }).catch((reason) => {
      const message = reasonMessage(reason, "Home could not be refreshed.");
      setHomeError(message);
      setConnection((current) => ({ status: "offline", message: current.message ?? message }));
    }).finally(() => setSyncingResources((count) => Math.max(0, count - 1)));
  }, [library]);
  const reloadLibrary = useCallback(() => {
    setLibraryError(undefined);
    setSyncingResources((count) => count + 1);
    invoke<LibraryOverview>("load_library").then((value) => {
      const merged = {
        ...value,
        albums: dedupeAlbums(value.albums),
        artists: dedupeArtists(value.artists),
        starredAlbums: dedupeAlbums(value.starredAlbums),
        starredArtists: dedupeArtists(value.starredArtists),
        starredSongs: mergeExternalLikes(library, value.starredSongs),
      };
      setLibraryData(merged);
      cacheLibraryOverview(library, merged);
      setConnection({ status: "online" });
    }).catch((reason) => {
      const message = reasonMessage(reason, "Your library could not be refreshed.");
      setLibraryError(message);
      setConnection((current) => ({ status: "offline", message: current.message ?? message }));
    }).finally(() => setSyncingResources((count) => Math.max(0, count - 1)));
  }, [library]);

  const offline = connection.status === "offline" || settings.offlineMode;

  // Navidrome's play queue is the cross-client recovery point used by iOS as
  // well. A profile's local queue wins when it exists; otherwise desktop picks
  // up the server queue without unexpectedly starting playback.
  useEffect(() => {
    if (offline || restoredServerQueue.current) return;
    restoredServerQueue.current = true;
    if (playbackRef.current.queue.length) return;
    void invoke<PlayQueueSnapshot | null>("get_play_queue")
      .then((snapshot) => {
        if (!snapshot?.songs?.length || playbackRef.current.queue.length) return;
        const match = snapshot.currentId ? snapshot.songs.findIndex((song) => song.id === snapshot.currentId) : 0;
        playbackRef.current.playQueue(snapshot.songs, Math.max(0, match), false, snapshot.position, "Synced queue");
        setToast("Queue restored from your other Splice devices");
      })
      .catch(() => undefined);
  }, [offline]);

  const saveServerQueue = useCallback(() => {
    const controller = playbackRef.current;
    if (offline || !controller.current || !controller.queue.length) return;
    void invoke("save_play_queue", {
      ids: controller.queue.slice(0, 1_000).map((song) => song.id),
      currentId: controller.current.id,
      position: controller.position,
    }).catch(() => undefined);
  }, [offline]);

  useEffect(() => {
    if (offline || !playback.current) return;
    const timeout = window.setTimeout(saveServerQueue, 700);
    return () => window.clearTimeout(timeout);
  }, [offline, playback.current?.id, playback.index, playback.queue, saveServerQueue]);

  useEffect(() => {
    if (offline) return;
    const interval = window.setInterval(saveServerQueue, 5_000);
    const onVisibility = () => { if (document.visibilityState === "hidden") saveServerQueue(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { window.clearInterval(interval); document.removeEventListener("visibilitychange", onVisibility); };
  }, [offline, saveServerQueue]);

  useEffect(() => {
    if (!offline) {
      reloadHome();
      reloadLibrary();
    }
  }, [offline, reloadHome, reloadLibrary]);

  useEffect(() => {
    if (sleepAt === undefined) {
      setSleepRemaining(undefined);
      return;
    }
    const tick = () => {
      const remaining = Math.max(0, sleepAt - Date.now());
      setSleepRemaining(remaining);
      if (remaining > 0) return;
      setSleepAt(undefined);
      if (playbackRef.current.isPlaying) void playbackRef.current.toggle();
      setToast("Sleep timer ended playback");
    };
    tick();
    const interval = window.setInterval(tick, 1_000);
    return () => window.clearInterval(interval);
  }, [sleepAt]);

  queueExhausted.current = (last: SongSummary) => {
    if (offline) return;
    void invoke<RadioResult>("get_radio", { seedId: last.id, title: `${last.title} Radio`, count: 20 })
      .then((result) => {
        const fresh = result.songs.filter((song) => song.id !== last.id);
        if (!fresh.length) return;
        playbackRef.current.appendToQueue(fresh);
        playbackRef.current.next();
        setToast("Autoplay continued with similar songs");
      })
      .catch(() => undefined);
  };

  useEffect(() => {
    let active = true;
    setSearchFilter("all");
    if (route.kind !== "search" || !query.trim()) {
      setSearchResults(emptySearch);
      setSearching(false);
      return () => { active = false };
    }
    if (offline) {
      const needle = query.trim().toLowerCase();
      const source = offlineSourceRef.current;
      const songs = [...source.starredSongs, ...source.downloads.map((item) => item.song)]
        .filter((song, index, all) => all.findIndex((item) => item.id === song.id) === index)
        .filter((song) => `${song.title} ${song.artist} ${song.album}`.toLowerCase().includes(needle));
      setSearchResults({
        songs,
        albums: source.albums.filter((album) => `${album.title} ${album.artist}`.toLowerCase().includes(needle)).slice(0, 60),
        artists: source.artists.filter((artist) => artist.name.toLowerCase().includes(needle)).slice(0, 60),
      });
      setSearching(false);
      return () => { active = false };
    }
    const timeout = window.setTimeout(() => {
      setSearching(true);
      setPageError(undefined);
      invoke<SearchResults>("search_catalog", { query: query.trim() })
        .then((results) => {
          if (!active) return;
          setSearchResults(dedupeSearchResults(results));
          const saved = readRecentSearches(searchHistoryKey);
          localStorage.setItem(searchHistoryKey, JSON.stringify([query.trim(), ...saved.filter((item) => item !== query.trim())].slice(0, 8)));
        })
        .catch((reason) => active && setPageError(reasonMessage(reason, "Search is unavailable.")))
        .finally(() => active && setSearching(false));
    }, 220);
    return () => { active = false; window.clearTimeout(timeout); };
  }, [offline, query, route.kind, searchHistoryKey]);

  useEffect(() => {
    if (!("id" in route) || !(route.kind === "album" || route.kind === "playlist" || route.kind === "artist")) {
      setDetail(undefined);
      return;
    }
    let active = true;
    if (offline) {
      const saved = cachedDetail(library, route.kind, route.id);
      if (saved) {
        setDetail(saved);
        setPageError(undefined);
      } else {
        setDetail(undefined);
        setPageError("This page has not been saved for offline browsing. Reconnect to open it.");
      }
      setPageLoading(false);
      return () => { active = false };
    }
    const command = route.kind === "album" ? "get_album" : route.kind === "playlist" ? "get_playlist" : "get_artist";
    setPageLoading(true);
    setPageError(undefined);
    invoke<DetailState>(command, { id: route.id })
      .then((value) => {
        if (!active) return;
        setDetail(value);
        cacheDetail(library, route.kind, route.id, value);
      })
      .catch((reason) => active && setPageError(reasonMessage(reason, "This page could not be opened.")))
      .finally(() => active && setPageLoading(false));
    return () => { active = false };
  }, [library, offline, route]);

  useEffect(() => {
    if (route.kind !== "radio") { setRadioData(undefined); return; }
    let active = true;
    if (offline) {
      const songs = offlineSourceRef.current.downloads.map((item) => item.song).filter((song) => song.id !== route.id).slice(0, 60);
      setRadioData({ title: route.title, songs });
      setPageLoading(false);
      if (!songs.length) setPageError("Radio needs a server connection or more downloaded tracks.");
      return () => { active = false };
    }
    setPageLoading(true);
    invoke<RadioResult>("get_radio", { seedId: route.id, title: route.title, count: 60 })
      .then((value) => active && setRadioData(value))
      .catch((reason) => active && setPageError(reasonMessage(reason, "Radio could not be started.")))
      .finally(() => active && setPageLoading(false));
    return () => { active = false };
  }, [offline, route]);

  useEffect(() => {
    if (!playback.current) { setLyrics(emptyLyrics); return; }
    if (offline) { setLyrics(emptyLyrics); setLyricsLoading(false); return; }
    let active = true;
    setLyricsLoading(true);
    invoke<LyricsResult>("get_lyrics", {
      id: playback.current.id,
      source: settings.lyricsSource,
      artist: playback.current.artist,
      title: playback.current.title,
      album: playback.current.album,
      duration: playback.current.duration,
    })
      .then((value) => active && setLyrics(value?.lines ? value : emptyLyrics))
      .catch(() => active && setLyrics(emptyLyrics))
      .finally(() => active && setLyricsLoading(false));
    return () => { active = false };
  }, [offline, playback.current?.id, settings.lyricsSource]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(undefined), 2600);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const openPanel = useCallback((mode: ContextPanelMode) => {
    setPanelMode((current) => {
      const next = current === mode ? undefined : mode;
      if (next) {
        localStorage.setItem("splice.panel", next);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const editable = target?.matches("input, textarea, [contenteditable='true']");
      // Space activates whatever control has focus. Only an unfocused surface —
      // or a track row, which spec 7 gives to the transport — reaches playback.
      const spaceOwner = target?.closest("button, a[href], select, summary, [role='menuitem'], [role='tab']");
      const rowOwner = Boolean(target?.closest("[role='row']"));
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key.toLowerCase() === "k") { event.preventDefault(); navigate({ kind: "search" }); window.requestAnimationFrame(() => document.querySelector<HTMLInputElement>("[data-search-input]")?.focus()); }
      else if (!editable && event.code === "Space" && (!spaceOwner || rowOwner)) { event.preventDefault(); void playbackRef.current.toggle(); }
      else if ((event.altKey && event.key === "ArrowLeft") || (event.metaKey && event.key === "[")) { event.preventDefault(); goBack(); }
      else if ((event.altKey && event.key === "ArrowRight") || (event.metaKey && event.key === "]")) { event.preventDefault(); goForward(); }
      else if (modifier && event.shiftKey && event.key.toLowerCase() === "q") { event.preventDefault(); openPanel("queue"); }
      else if (modifier && event.key === ",") { event.preventDefault(); navigate({ kind: "settings" }); }
      else if (!editable && modifier && event.key === "ArrowRight") { event.preventDefault(); playbackRef.current.next(); }
      else if (!editable && modifier && event.key === "ArrowLeft") { event.preventDefault(); playbackRef.current.previous(); }
      else if (!editable && modifier && event.key === "ArrowUp") { event.preventDefault(); playbackRef.current.setVolume(playbackRef.current.volume + 0.05); }
      else if (!editable && modifier && event.key === "ArrowDown") { event.preventDefault(); playbackRef.current.setVolume(playbackRef.current.volume - 0.05); }
      else if (!editable && (event.key === "F11" || (event.ctrlKey && event.metaKey && event.key.toLowerCase() === "f"))) { event.preventDefault(); if (playbackRef.current.current) setFullPlayer((value) => !value); }
      else if (!editable && event.key === "?") { event.preventDefault(); setShortcutsOpen((value) => !value); }
      else if (event.key === "Escape") {
        if (accountOpen) setAccountOpen(false);
        else if (shortcutsOpen) setShortcutsOpen(false);
        else if (signOutConfirm) setSignOutConfirm(false);
        else if (clearDownloadsConfirm) setClearDownloadsConfirm(false);
        else if (collectionMenu) setCollectionMenu(undefined);
        else if (playlistDelete) setPlaylistDelete(undefined);
        else if (playlistEdit) setPlaylistEdit(undefined);
        else if (playlistTarget) setPlaylistTarget(undefined);
        else if (createPlaylistOpen) setCreatePlaylistOpen(false);
        else if (trackMenu) setTrackMenu(undefined);
        else if (selectedIds.size) setSelectedIds(new Set());
        else if (fullPlayer) setFullPlayer(false);
        else if (panelMode) setPanelMode(undefined);
        else if (route.kind === "search" && query) setQuery("");
        else if (route.kind === "search") goBack();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [accountOpen, clearDownloadsConfirm, collectionMenu, createPlaylistOpen, fullPlayer, goBack, goForward, navigate, openPanel, panelMode, playlistDelete, playlistEdit, playlistTarget, query, route.kind, selectedIds, shortcutsOpen, signOutConfirm, trackMenu]);

  // The native menu owns no behaviour of its own: it forwards to the same
  // handlers the keyboard and the player bar use.
  useEffect(() => {
    let dispose: (() => void) | undefined;
    void listen<string>("menu-command", ({ payload }) => {
      const controller = playbackRef.current;
      if (payload === "preferences") navigate({ kind: "settings" });
      else if (payload === "search") navigate({ kind: "search" });
      else if (payload === "playpause") void controller.toggle();
      else if (payload === "next") controller.next();
      else if (payload === "previous") controller.previous();
      else if (payload === "shuffle") controller.setShuffle((value) => !value);
      else if (payload === "repeat") controller.cycleRepeat();
      else if (payload === "queue") openPanel("queue");
      else if (payload === "lyrics") openPanel("lyrics");
      else if (payload === "devices") openPanel("connect");
      else if (payload === "fullplayer") setFullPlayer((value) => Boolean(controller.current) && !value);
      else if (payload === "shortcuts") setShortcutsOpen(true);
    }).then((unlisten) => { dispose = unlisten; }).catch(() => undefined);
    return () => dispose?.();
  }, [navigate, openPanel]);

  const applyHandoff = useCallback(async (handoff: NonNullable<ConnectCommand["handoff"]>, label = "Splice Connect", startAt?: number) => {
    const active = await invoke<SongSummary[]>("get_songs_by_ids", { ids: [handoff.currentTrackID] });
    if (!active[0]) throw new Error("The active track was not available on this server.");
    playbackRef.current.playQueue(active, 0, handoff.isPlaying, startAt ?? handoff.position, label);
    if (handoff.trackIDs.length <= 1) return;
    const expectedTrackId = active[0].id;
    const songs = await invoke<SongSummary[]>("get_songs_by_ids", { ids: handoff.trackIDs.slice(0, 1000) });
    if (playbackRef.current.current?.id === expectedTrackId) {
      playbackRef.current.replaceQueuePreservingCurrent(songs);
    }
  }, []);

  const applyConnectCommand = useCallback(async (command: ConnectCommand) => {
    const controller = playbackRef.current;
    const leaderOffset = (leaderID: string) => clockOffsets.current[leaderID];

    if (command.name === "groupAccept" || command.name === "groupDecline") {
      const reply = command.groupReply;
      const invite = pendingInvite.current;
      if (!reply || !invite || invite.sessionId !== reply.sessionID) return;
      if (!invite.awaiting.delete(reply.deviceID)) return;
      if (command.name === "groupAccept") invite.accepted.push(reply.deviceID);
      else invite.declined.set(reply.deviceID, reply.reason ?? "declined");
      return;
    }
    if (command.name === "play" && !controller.isPlaying) return void await controller.toggle();
    if (command.name === "pause" && controller.isPlaying) return void await controller.toggle();
    if (command.name === "toggle") return void await controller.toggle();
    if (command.name === "previous") return controller.previous();
    if (command.name === "next") return controller.next();
    if (command.name === "seek" && command.value !== undefined) return controller.seek(command.value);
    // An incoming transfer means this device is the one playing now, so it
    // stops being a remote for anyone else — otherwise the bar would keep
    // claiming "Playing on <device>" over its own audio.
    if (command.name === "handoff" && command.handoff) {
      setRemoteDevice(undefined);
      return void await applyHandoff(command.handoff);
    }

    if (command.name === "groupJoin" && command.groupJoin) {
      const { group, handoff } = command.groupJoin;
      const localId = connectRef.current.localDeviceId ?? "";
      /// A join this device will not honour has to say so. Returning silently
      /// left the leader unable to tell a refusal from a frame that never
      /// arrived, so it kept addressing a device that never joined.
      const decline = (reason: string) => {
        logConnectEvent("group_declined", { session: group.id, reason });
        void sendGroupFrame(group.leaderID, {
          name: "groupDecline",
          groupReply: { sessionID: group.id, deviceID: localId, revision: group.revision ?? 0, reason },
        });
      };
      // An output belongs to one session at a time.
      const existing = groupRef.current;
      if (existing && existing.id !== group.id) return decline("in another session");
      setRemoteDevice(undefined);
      // Start where the leader's clock has reached by now, not where it was
      // when the frame left. iOS has always done this; the desktop used the
      // raw handoff position and so began every group session — and, because
      // the leader resends a join at each track change, every track — already
      // behind by the whole transit plus the time spent resolving the track.
      const offset = leaderOffset(group.leaderID);
      const joinAt = projectedGroupPosition(group, offset);
      groupRevision.current = group.revision ?? 0;
      logConnectEvent("group_joined", {
        session: group.id,
        startAt: Math.round(joinAt * 1000) / 1000,
        skew: Date.now() - group.sentAt,
        offset: offset === undefined ? "none" : Math.round(offset * 10) / 10,
        queued: handoff.trackIDs.length,
      });
      try {
        await applyHandoff(handoff, "Group Session", joinAt);
      } catch {
        // The track could not be resolved here. v1 let this throw out of the
        // command loop, which both lost every command behind it and told the
        // leader nothing.
        return decline("track unresolved");
      }
      setGroupSession({ id: group.id, leaderID: group.leaderID, memberIDs: [] });
      setPanelMode("connect");
      // Only now is this device rendering the session, so only now may it
      // claim membership.
      void sendGroupFrame(group.leaderID, {
        name: "groupAccept",
        groupReply: { sessionID: group.id, deviceID: localId, revision: group.revision ?? 0 },
      });
      return;
    }

    if (command.name === "groupSync" && command.group && groupRef.current?.id === command.group.id) {
      const group = command.group;
      // A revision older than the one already applied is a controller that has
      // not caught up. Honouring it would undo what the session did since.
      const revision = group.revision ?? 0;
      if (revision < groupRevision.current) {
        logConnectEvent("group_stale_frame", { session: group.id, frame: revision, applied: groupRevision.current });
        return;
      }
      groupRevision.current = revision;
      const offset = leaderOffset(group.leaderID);
      const target = projectedGroupPosition(group, offset);
      const skew = Date.now() - group.sentAt;
      if (controller.current?.id !== group.trackID) {
        const trackIndex = controller.queue.findIndex((song) => song.id === group.trackID);
        // The leader has moved to a track this device does not hold yet. Wait
        // for the groupJoin that carries it. Falling through here used to seek
        // whatever was playing locally to the leader's position in a different
        // song, which is what made a follower on the wrong track jump around.
        if (trackIndex < 0) {
          logConnectEvent("group_track_missing", { session: group.id, track: group.trackID });
          return;
        }
        noteGroupTrackChange(group.id);
        controller.endConvergence();
        controller.playQueue(controller.queue, trackIndex, group.isPlaying, target, "Group Session");
        return;
      }
      // Both playheads are read exactly and the leader's clock is measured, so
      // this is real drift rather than two stale samples plus whatever the two
      // wall clocks disagree by. That is what makes correcting by rate worth
      // doing: v1's whole 1.25 s window now converges silently instead.
      const drift = controller.positionNow() - target;
      const correction = driftCorrection(drift);
      if (correction.kind === "converge") {
        controller.convergeRate(correction.rate, correction.seconds);
      } else {
        // Inside the deadband, a running nudge has done its job and normal
        // speed resumes now rather than at its deadline.
        controller.endConvergence();
        if (correction.kind === "seek") controller.seek(target);
      }
      noteGroupSample(group.id, { drift, skew, offset, correction: correction.kind });
      if (group.isPlaying !== controller.isPlaying) {
        if (!group.isPlaying) controller.endConvergence();
        await controller.toggle();
      }
      return;
    }

    if (command.name === "groupLeave") {
      controller.endConvergence();
      groupRevision.current = 0;
      endGroupDiagnostics("leader-ended");
      logConnectEvent("group_left", { session: command.group?.id ?? "unknown" });
      setGroupSession(undefined);
    }
  }, [applyHandoff]);

  const applyConnectCommandRef = useRef(applyConnectCommand);
  applyConnectCommandRef.current = applyConnectCommand;

  useEffect(() => {
    let active = true;
    let inFlight = false;
    let missed = false;
    async function poll() {
      if (inFlight) { missed = true; return; }
      inFlight = true;
      try {
        let snapshot: ConnectSnapshot | undefined;
        try {
          snapshot = await invoke<ConnectSnapshot>("connect_snapshot");
        } catch {
          // Only a failed snapshot means Connect itself is unreachable. A
          // command that could not be applied used to land here too and put
          // "Local discovery unavailable" on a panel that was working fine.
          if (active) setConnectState((value) => ({ ...value, isAvailable: false, commands: [] }));
          return;
        }
        if (!active) return;
        // A snapshot that came back without its arrays is a tick to skip, not
        // evidence the network went away. The previous catch-all swallowed
        // this shape silently and reported Connect as unavailable instead.
        if (!snapshot || !Array.isArray(snapshot.peers)) return;
        clockOffsets.current = snapshot.clockOffsets ?? {};
        setConnectState({ ...snapshot, commands: [] });
        for (const command of snapshot.commands ?? []) {
          if (!active) break;
          try {
            await applyConnectCommandRef.current(command);
          } catch (reason) {
            // The Rust side has already drained the batch, so a throw that
            // escaped this loop lost every command behind it for good.
            setPageError(reasonMessage(reason, "A command from another device could not be applied."));
          }
        }
      } finally {
        inFlight = false;
        if (missed && active) { missed = false; void poll(); }
      }
    }
    void poll();
    const interval = window.setInterval(poll, 1000);
    // The reader thread knows the moment a command frame lands. Waiting for the
    // next tick cost every remote action up to a second before it was even
    // seen; the snapshot drain stays the delivery path so nothing is lost.
    let disposeEvent: (() => void) | undefined;
    void listen("connect-commands-pending", () => void poll())
      .then((unlisten) => { if (active) disposeEvent = unlisten; else unlisten(); })
      .catch(() => undefined);
    return () => { active = false; window.clearInterval(interval); disposeEvent?.(); };
  }, []);

  useEffect(() => {
    function publish() {
      const controller = playbackRef.current;
      const session = groupRef.current;
      void invoke("publish_connect_playback", {
        playback: {
          trackID: controller.current?.id, title: controller.current?.title, artist: controller.current?.artist,
          album: controller.current?.album, coverArtID: controller.current?.coverArt, isPlaying: controller.isPlaying,
          position: controller.positionNow(), duration: controller.duration,
        },
        // Published so another device can see, before it tries to take this
        // one, that it is already rendering a session or already driving a
        // third device.
        commitment: {
          sessionID: session?.id,
          leaderID: session?.leaderID,
          revision: groupRevision.current,
          controllingPeerID: remoteRef.current?.id,
        },
      }).catch(() => undefined);
    }
    publish();
    const interval = window.setInterval(publish, 2000);
    return () => window.clearInterval(interval);
  }, []);

  /// What the player bar and expanded player actually drive.
  ///
  /// While this device is a remote, the transport sends absolute commands to
  /// the peer and the play state comes from the peer's published clock, but the
  /// track identity stays local — it is the same queue, deliberately held here
  /// in step. Everything that must keep touching real local audio (the Connect
  /// publish loop, the group leader clock) uses `playbackRef` and is unaffected.
  const remotePeer = remoteDevice ? connectState.peers.find((peer) => peer.id === remoteDevice.id) : undefined;
  const transport = useMemo(() => {
    if (!remoteDevice) return playback;
    const send = (command: ConnectCommand) => {
      void invoke("send_connect_command", { peerId: remoteDevice.id, command })
        .catch(() => setPageError(`Splice could not reach ${remoteDevice.name}.`));
    };
    return {
      ...playback,
      isPlaying: remotePeer?.playback.isPlaying ?? false,
      position: remotePeer?.playback.position ?? playback.position,
      duration: remotePeer?.playback.duration || playback.duration,
      toggle: async () => send({ name: "toggle" }),
      next: () => send({ name: "next" }),
      previous: () => send({ name: "previous" }),
      seek: (value: number) => send({ name: "seek", value }),
    };
  }, [playback, remoteDevice, remotePeer]);

  /// A device that has gone quiet on the network cannot be driven any more.
  /// The Rust side already waits twelve seconds before expiring a peer, so
  /// this does not fire on a momentary gap.
  useEffect(() => {
    if (!remoteDevice || !connectState.isAvailable) return;
    if (connectState.peers.some((peer) => peer.id === remoteDevice.id)) return;
    logConnectEvent("remote_end", { peer: remoteRef.current?.id ?? "unknown", reason: "peer left the network" });
    setRemoteDevice(undefined);
    setToast(`${remoteDevice.name} is no longer on this network`);
  }, [connectState.isAvailable, connectState.peers, remoteDevice]);

  async function sendRemote(peerId: string, command: ConnectCommand) {
    try { await invoke("send_connect_command", { peerId, command }); }
    catch (reason) { setPageError(reasonMessage(reason, "That device is no longer available.")); }
  }

  /// The same send without the error banner, for frames this device emits on a
  /// timer rather than because someone pressed something. The group leader sends
  /// once a second per member; routing that through `sendRemote` put a visible
  /// error on screen every second for as long as a member stayed unreachable.
  async function sendGroupFrame(peerId: string, command: ConnectCommand) {
    try {
      await invoke("send_connect_command", { peerId, command });
      groupSendFailures.current.delete(peerId);
      return true;
    } catch {
      groupSendFailures.current.set(peerId, (groupSendFailures.current.get(peerId) ?? 0) + 1);
      return false;
    }
  }

  useEffect(() => {
    const interval = window.setInterval(() => {
      const group = groupRef.current;
      const controller = playbackRef.current;
      const localId = connectRef.current.localDeviceId;
      if (!group || group.leaderID !== localId || !controller.current) return;
      const trackKey = `${group.id}:${controller.current.id}`;
      // A track change is an accepted state change, so it advances the
      // session. Sync frames in between carry the revision they belong to.
      if (trackKey !== lastGroupTrack.current) groupRevision.current += 1;
      const state: ConnectGroup = { id: group.id, leaderID: group.leaderID, trackID: controller.current.id, position: controller.positionNow(), isPlaying: controller.isPlaying, sentAt: Date.now(), revision: groupRevision.current };
      const frame: ConnectCommand = trackKey !== lastGroupTrack.current
        ? { name: "groupJoin", groupJoin: { group: state, handoff: { trackIDs: controller.queue.slice(0, 1000).map((song) => song.id), currentTrackID: controller.current.id, position: state.position, isPlaying: controller.isPlaying } } }
        : { name: "groupSync", group: state };
      if (frame.name === "groupJoin") lastGroupTrack.current = trackKey;
      void Promise.all(group.memberIDs.map((peerId) => sendGroupFrame(peerId, frame))).then((results) => {
        const lost = group.memberIDs.filter((peerId, index) => !results[index] && (groupSendFailures.current.get(peerId) ?? 0) >= 3);
        if (!lost.length) return;
        for (const peerId of lost) groupSendFailures.current.delete(peerId);
        logConnectEvent("group_member_dropped", { session: group.id, dropped: lost.length });
        setGroupSession((value) => value && value.id === group.id
          ? { ...value, memberIDs: value.memberIDs.filter((peerId) => !lost.includes(peerId)) }
          : value);
        setToast(lost.length === 1 ? "A device left the group session" : `${lost.length} devices left the group session`);
      });
    }, 1000);
    return () => window.clearInterval(interval);
  }, []);

  const retryConnection = useCallback(async () => {
    if (reconnecting) return;
    setReconnecting(true);
    setConnection({ status: "offline", message: "Reconnecting…" });
    try {
      const restored = await invoke<ConnectedLibrary | null>("restore_session");
      if (!restored) throw new Error("No saved login is available.");
      setConnection({ status: "online" });
      onConnectionRestored(restored);
    } catch (reason) {
      setConnection({ status: "offline", message: reasonMessage(reason, "The server is still unavailable.") });
    } finally {
      setReconnecting(false);
    }
  }, [onConnectionRestored, reconnecting]);

  async function leaveSession(forgetSavedLogin: boolean) {
    if (leavingSession) return;
    setLeavingSession(true);
    try {
      await invoke("disconnect_server", { forgetSavedLogin });
      onSignedOut();
    } catch (reason) {
      setPageError(reasonMessage(reason, forgetSavedLogin ? "Splice could not remove the saved login." : "Splice could not switch accounts."));
      setSignOutConfirm(false);
    } finally {
      setLeavingSession(false);
    }
  }

  useEffect(() => {
    const onOnline = () => {
      if (connection.status === "offline" && !settings.offlineMode && !reconnecting) void retryConnection();
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [connection.status, retryConnection, settings.offlineMode]);

  /// Every user-initiated play routes through here so that "playing on another
  /// device" behaves the way it does on iOS: the remote device receives the new
  /// queue, and this device loads the same queue *paused*. Keeping the local
  /// queue in step is what lets the player bar, the queue view and "Play here"
  /// stay truthful about what is playing while the audio is somewhere else.
  const startPlayback = useCallback((songs: SongSummary[], index: number, label: string, position = 0) => {
    if (!songs.length) return;
    const safeIndex = Math.max(0, Math.min(index, songs.length - 1));
    const remote = remoteRef.current;
    playbackRef.current.playQueue(songs, safeIndex, !remote, position, label);
    if (!remote) return;
    void invoke("send_connect_command", {
      peerId: remote.id,
      command: { name: "handoff", handoff: {
        trackIDs: songs.slice(0, 1000).map((song) => song.id),
        currentTrackID: songs[safeIndex].id,
        position,
        isPlaying: true,
      } },
    }).catch(() => setPageError(`Splice could not reach ${remote.name}.`));
    setToast(`Playing on ${remote.name}`);
  }, []);

  const playCollection = useCallback((songs: SongSummary[], label: string) => {
    if (!songs.length) return;
    const start = playbackRef.current.shuffle ? Math.floor(Math.random() * songs.length) : 0;
    startPlayback(songs, start, label);
  }, [startPlayback]);

  async function downloadCollection(songs: SongSummary[]) {
    setToast(`Downloading ${songs.length} ${songs.length === 1 ? "track" : "tracks"}…`);
    const { completed, failed } = await downloads.downloadMany(songs);
    if (!failed.length) setToast(`${completed} ${completed === 1 ? "track" : "tracks"} available offline`);
    else setToast(`${completed} downloaded · ${failed.length} did not finish. Retry them in Downloads.`);
  }

  async function removeCollection(songs: SongSummary[]) {
    for (const song of songs) await downloads.remove(song.id).catch(() => undefined);
    setToast("Removed from downloads");
  }

  async function clearAllDownloads() {
    setClearDownloadsConfirm(false);
    try {
      await downloads.clear();
      setToast("Downloads cleared");
    } catch (reason) {
      setPageError(reasonMessage(reason, "Downloads could not be cleared."));
    }
  }

  async function playAlbum(album: AlbumSummary, start = 0) {
    try {
      const saved = offline ? cachedDetail(library, "album", album.id) : undefined;
      const full = saved && "songs" in saved ? saved as AlbumDetail : await invoke<AlbumDetail>("get_album", { id: album.id });
      if (start === 0) playCollection(full.songs, full.title);
      else startPlayback(full.songs, start, full.title);
    } catch (reason) { setPageError(reasonMessage(reason, "That album could not be played.")); }
  }

  async function playPlaylist(playlist: PlaylistSummary, start = 0) {
    try {
      const saved = offline ? cachedDetail(library, "playlist", playlist.id) : undefined;
      const full = saved && "songs" in saved ? saved as PlaylistDetail : await invoke<PlaylistDetail>("get_playlist", { id: playlist.id });
      if (start === 0) playCollection(full.songs, full.name);
      else startPlayback(full.songs, start, full.name);
    } catch (reason) { setPageError(reasonMessage(reason, "That playlist could not be played.")); }
  }

  async function toggleSongStar(song: SongSummary) {
    const external = Boolean(parseExternalSource(song.id));
    const starred = external ? !isExternalLiked(library, song) : !song.starred;
    try {
      if (external) setExternalLiked(library, song, starred);
      else await invoke("set_starred", { id: song.id, itemType: "song", starred });
      const matches = (item: SongSummary) => external ? trackMetadataKey(item) === trackMetadataKey(song) : item.id === song.id;
      const update = (songs: SongSummary[]) => songs.map((item) => matches(item) ? { ...item, starred: starred ? new Date().toISOString() : undefined } : item);
      setLibraryData((value) => ({ ...value, starredSongs: starred ? update([...value.starredSongs.filter((item) => !matches(item)), song]) : value.starredSongs.filter((item) => !matches(item)) }));
      setDetail((value) => value && "songs" in value ? { ...value, songs: update(value.songs) } : value);
      setRadioData((value) => value ? { ...value, songs: update(value.songs) } : value);
      setToast(starred ? "Saved to Liked Songs" : "Removed from Liked Songs");
    } catch (reason) { setPageError(reasonMessage(reason, "Liked Songs could not be updated.")); }
  }

  async function downloadSong(song: SongSummary) {
    try {
      await downloads.download(song);
      setToast(`${song.title} is available offline`);
    } catch (reason) {
      setPageError(reasonMessage(reason, "The song could not be downloaded."));
    }
  }

  async function removeDownloadedSong(song: SongSummary) {
    try {
      await downloads.remove(song.id);
      setToast(`Removed ${song.title} from downloads`);
    } catch (reason) {
      setPageError(reasonMessage(reason, "The download could not be removed."));
    }
  }

  async function createPlaylist(name: string) {
    try {
      const created = await invoke<PlaylistDetail>("create_playlist", { name: name.trim() });
      setCreatePlaylistOpen(false);
      reloadLibrary();
      navigate({ kind: "playlist", id: created.id });
    } catch (reason) { setPageError(reasonMessage(reason, "The playlist could not be created.")); }
  }

  async function renamePlaylist(playlistId: string, name: string) {
    try {
      await invoke("rename_playlist", { playlistId, name });
      if (route.kind === "playlist" && route.id === playlistId) {
        setDetail((value) => value && "name" in value ? { ...value, name: name.trim() } : value);
      }
      reloadLibrary();
      setToast("Playlist renamed");
    } catch (reason) { setPageError(reasonMessage(reason, "The playlist could not be renamed.")); }
  }

  async function deletePlaylist(playlistId: string) {
    try {
      await invoke("delete_playlist", { playlistId });
      setPlaylistDelete(undefined);
      reloadLibrary();
      setToast("Playlist deleted");
      if (route.kind === "playlist" && route.id === playlistId) navigate({ kind: "library" });
    } catch (reason) { setPageError(reasonMessage(reason, "The playlist could not be deleted.")); }
  }

  /// Songs for a collection the user acted on without opening it.
  async function collectionSongs(menu: CollectionMenuState) {
    if (menu.kind === "album") return (await invoke<AlbumDetail>("get_album", { id: menu.id })).songs;
    if (menu.kind === "playlist") return (await invoke<PlaylistDetail>("get_playlist", { id: menu.id })).songs;
    return (await invoke<ArtistDetail>("get_artist", { id: menu.id })).topSongs ?? [];
  }

  async function runCollectionAction(menu: CollectionMenuState, action: "play" | "enqueue" | "download") {
    try {
      const songs = await collectionSongs(menu);
      if (!songs.length) { setToast("That collection has no songs."); return; }
      if (action === "play") playCollection(songs, menu.name);
      else if (action === "enqueue") { songs.forEach((song) => playback.enqueue(song)); setToast(`${songs.length} added to queue`); }
      else await downloadCollection(songs);
    } catch (reason) { setPageError(reasonMessage(reason, "That collection could not be opened.")); }
  }

  async function setCollectionStarred(kind: "album" | "artist", id: string, starred: boolean, summary?: AlbumSummary | ArtistSummary) {
    try {
      await invoke("set_starred", { id, itemType: kind, starred });
      const stamp = starred ? new Date().toISOString() : undefined;
      setLibraryData((value) => {
        if (kind === "album") {
          const album = (summary ?? value.albums.find((item) => item.id === id)) as AlbumSummary | undefined;
          const without = value.starredAlbums.filter((item) => item.id !== id);
          return { ...value, starredAlbums: starred && album ? [{ ...album, starred: stamp }, ...without] : without };
        }
        const artist = (summary ?? value.artists.find((item) => item.id === id)) as ArtistSummary | undefined;
        const without = value.starredArtists.filter((item) => item.id !== id);
        return { ...value, starredArtists: starred && artist ? [{ ...artist, starred: stamp }, ...without] : without };
      });
      setToast(kind === "album" ? (starred ? "Saved album to Liked" : "Removed album from Liked") : (starred ? "Following artist" : "Unfollowed artist"));
    } catch (reason) { setPageError(reasonMessage(reason, "That could not be saved to your library.")); }
  }

  /// Subsonic cannot move a row, so the whole order is rewritten. The optimistic
  /// local move is reconciled with whatever the server returns.
  async function reorderCurrentPlaylist(from: number, to: number) {
    if (route.kind !== "playlist" || !detail || !("songs" in detail)) return;
    const next = [...detail.songs];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setDetail((value) => value && "songs" in value ? { ...value, songs: next } : value);
    try {
      const updated = await invoke<PlaylistDetail>("set_playlist_songs", { playlistId: route.id, songIds: next.map((song) => song.id) });
      setDetail(updated);
      cacheDetail(library, "playlist", route.id, updated);
    } catch (reason) {
      setDetail((value) => value && "songs" in value ? { ...value, songs: detail.songs } : value);
      setPageError(reasonMessage(reason, "The playlist order could not be saved."));
    }
  }

  async function saveQueueAsPlaylist(name: string) {
    const songs = playbackRef.current.queue;
    if (!songs.length) return;
    setSaveQueueOpen(false);
    try {
      const created = await invoke<PlaylistDetail>("create_playlist", { name: name.trim() });
      await invoke("add_songs_to_playlist", { playlistId: created.id, songIds: songs.map((song) => song.id) });
      reloadLibrary();
      setToast(`Saved ${songs.length} ${songs.length === 1 ? "song" : "songs"} to ${created.name}`);
      navigate({ kind: "playlist", id: created.id });
    } catch (reason) { setPageError(reasonMessage(reason, "The queue could not be saved as a playlist.")); }
  }

  async function addSongIdsToPlaylist(songIds: string[], playlist: PlaylistSummary) {
    try {
      await invoke("add_songs_to_playlist", { playlistId: playlist.id, songIds });
      setToast(songIds.length === 1 ? `Added to ${playlist.name}` : `Added ${songIds.length} songs to ${playlist.name}`);
      reloadLibrary();
    } catch (reason) { setPageError(reasonMessage(reason, "Those songs could not be added to that playlist.")); }
  }

  async function removeFromCurrentPlaylist(index: number) {
    if (route.kind !== "playlist") return;
    try {
      await invoke("remove_song_from_playlist", { playlistId: route.id, songIndex: index });
      setDetail((value) => value && "songs" in value ? { ...value, songs: value.songs.filter((_, itemIndex) => itemIndex !== index) } : value);
      setToast("Removed from playlist");
    } catch (reason) { setPageError(reasonMessage(reason, "The song could not be removed from this playlist.")); }
  }

  async function movePlaybackTo(peer: ConnectPeer) {
    if (!playback.current || !playback.queue.length) return;
    // A transferred queue is capped at 1,000 entries (`docs/connect/WIRE-V1.md`).
    // The other transfer sites already sliced; these two sent the whole queue,
    // and a receiver that enforces the cap refuses the frame outright rather
    // than truncating it, so a long queue moved nothing at all.
    await sendRemote(peer.id, { name: "handoff", handoff: { trackIDs: playback.queue.slice(0, 1000).map((song) => song.id), currentTrackID: playback.current.id, position: playback.positionNow(), isPlaying: playback.isPlaying } });
    // Moving between devices has to stop the first one; the handoff only ever
    // starts the new one, so without this both would be playing.
    const previous = remoteRef.current;
    if (previous && previous.id !== peer.id) await sendRemote(previous.id, { name: "pause" });
    if (playback.isPlaying) await playback.toggle();
    // The local queue stays loaded and paused, so this device becomes a remote
    // for that peer rather than simply going quiet.
    logConnectEvent("remote_begin", { peer: peer.id, peerName: peer.name, platform: peer.platform, trigger: "chosen", movedFrom: previous?.id ? "another device" : "here" });
    setRemoteDevice({ id: peer.id, name: peer.name });
    setToast(`Playing on ${peer.name}`);
  }

  async function playPeerHere(peer: ConnectPeer) {
    if (!peer.playback.trackID) return;
    // Taking the audio back ends remote control, whichever device it was for —
    // including a third device that was playing until now.
    const previous = remoteRef.current;
    if (previous && previous.id !== peer.id) void sendRemote(previous.id, { name: "pause" });
    if (previous) logConnectEvent("remote_end", { peer: previous.id, reason: "played here" });
    setRemoteDevice(undefined);
    try {
      const songs = await invoke<SongSummary[]>("get_songs_by_ids", { ids: [peer.playback.trackID] });
      if (!songs?.length) throw new Error(`${peer.name} is playing something this server could not resolve.`);
      // Still a one-track queue: peer state carries only the current track, so
      // recovering the rest of what that device holds needs a new message.
      playback.playQueue(songs, 0, peer.playback.isPlaying, peer.playback.position, peer.name);
      await sendRemote(peer.id, { name: "pause" });
    } catch (reason) { setPageError(reasonMessage(reason, "That track is not available on this server.")); }
  }

  async function startGroup() {
    const localId = connectState.localDeviceId;
    if (!localId || !playback.current || !connectState.peers.length) return;
    // A device already rendering another session, or already driving a third
    // device, is not available to take. Inviting it only produces a decline.
    const candidates = connectState.peers.filter((peer) => {
      const commitment = peer.commitment;
      return !commitment || (!commitment.sessionID && !commitment.controllingPeerID);
    });
    if (!candidates.length) {
      setPageError("Every nearby Splice device is already in a session.");
      return;
    }
    const sessionId = crypto.randomUUID();
    const startAt = playback.positionNow();
    const handoff = { trackIDs: playback.queue.slice(0, 1000).map((song) => song.id), currentTrackID: playback.current.id, position: startAt, isPlaying: playback.isPlaying };
    // A new session id starts its own revision count.
    groupRevision.current = 1;
    const group: ConnectGroup = { id: sessionId, leaderID: localId, trackID: playback.current.id, position: startAt, isPlaying: playback.isPlaying, sentAt: Date.now(), revision: 1 };
    lastGroupTrack.current = `${sessionId}:${playback.current.id}`;
    // A member is a device that answered. `sendGroupFrame` returning true only
    // means the frame reached this device's own network stack, which a
    // stale-but-open connection reports for a long time after the peer behind
    // it stopped listening. That is what made a session report a member it had
    // never reached.
    const reachable = await Promise.all(candidates.map(async (peer) =>
      await sendGroupFrame(peer.id, { name: "groupJoin", groupJoin: { group, handoff } }) ? peer.id : undefined));
    const awaiting = new Set(reachable.filter((peerId): peerId is string => Boolean(peerId)));
    groupSendFailures.current.clear();
    if (!awaiting.size) {
      lastGroupTrack.current = undefined;
      groupRevision.current = 0;
      logConnectEvent("group_invited", { session: sessionId, invited: candidates.length, accepted: 0, declined: 0, unanswered: 0, reasons: "", queued: handoff.trackIDs.length, unreachable: candidates.length });
      setPageError("No other Splice device could be reached.");
      return;
    }
    const invite = { sessionId, awaiting, accepted: [] as string[], declined: new Map<string, string>() };
    pendingInvite.current = invite;
    // Bounded, because a follower has real work to do first: it resolves the
    // track against the server before it can honestly claim to have joined.
    const deadline = Date.now() + GROUP_JOIN_TIMEOUT_MS;
    while (invite.awaiting.size && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    pendingInvite.current = undefined;
    const members = invite.accepted;
    logConnectEvent("group_invited", {
      session: sessionId,
      invited: candidates.length,
      accepted: members.length,
      declined: invite.declined.size,
      unanswered: invite.awaiting.size,
      reasons: [...invite.declined.values()].sort().join(","),
      queued: handoff.trackIDs.length,
    });
    if (!members.length) {
      lastGroupTrack.current = undefined;
      groupRevision.current = 0;
      setPageError(invite.declined.size
        ? "No other Splice device could join right now."
        : "No other Splice device answered.");
      return;
    }
    setGroupSession({ id: sessionId, leaderID: localId, memberIDs: members });
    // Only now has a session actually started, which is what iOS's
    // `connect_group_started` has always meant.
    logConnectEvent("group_started", { session: sessionId, members: members.length, revision: groupRevision.current });
    setToast(`Group session started on ${members.length + 1} devices`);
  }

  async function stopGroup() {
    const session = groupRef.current;
    if (!session) return;
    for (const peerId of session.memberIDs) await sendRemote(peerId, { name: "groupLeave", group: { id: session.id, leaderID: session.leaderID, trackID: playback.current?.id ?? "", position: playback.positionNow(), isPlaying: playback.isPlaying, sentAt: Date.now() } });
    endGroupDiagnostics("stopped here");
    logConnectEvent("group_stopped", { session: session.id, members: session.memberIDs.length });
    setGroupSession(undefined);
    lastGroupTrack.current = undefined;
    setToast("Group session ended");
  }

  function openTrackMenu(song: SongSummary, index: number, event: ReactMouseEvent) {
    setTrackMenu({ song, index, x: event.clientX, y: event.clientY });
  }

  function selectTrack(song: SongSummary, index: number, event: ReactMouseEvent) {
    const songs = visibleSongs;
    setSelectedIds((current) => {
      if (event.shiftKey) {
        const start = Math.min(selectionAnchor.current, index);
        const end = Math.max(selectionAnchor.current, index);
        return new Set(songs.slice(start, end + 1).map((item, offset) => `${item.id}-${start + offset}`));
      }
      selectionAnchor.current = index;
      if (event.metaKey || event.ctrlKey) {
        const next = new Set(current);
        const occurrence = `${song.id}-${index}`;
        if (next.has(occurrence)) next.delete(occurrence); else next.add(occurrence);
        return next;
      }
      return new Set([`${song.id}-${index}`]);
    });
  }

  function beginResize(event: ReactPointerEvent) {
    event.preventDefault();
    const start = event.clientX;
    const initial = sidebarWidth;
    const move = (moveEvent: PointerEvent) => setSidebarWidth(Math.max(72, Math.min(420, initial + moveEvent.clientX - start)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function beginContextResize(event: ReactPointerEvent) {
    event.preventDefault();
    const start = event.clientX;
    const initial = contextWidth;
    const move = (moveEvent: PointerEvent) => setContextWidth(Math.max(280, Math.min(460, initial - (moveEvent.clientX - start))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function resizeSidebarWithKeyboard(event: ReactKeyboardEvent<HTMLButtonElement>) {
    const next = event.key === "ArrowLeft" ? sidebarWidth - 12
      : event.key === "ArrowRight" ? sidebarWidth + 12
        : event.key === "Home" ? 72
          : event.key === "End" ? 420
            : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setSidebarWidth(Math.max(72, Math.min(420, next)));
  }

  function resizeContextWithKeyboard(event: ReactKeyboardEvent<HTMLButtonElement>) {
    const next = event.key === "ArrowLeft" ? contextWidth + 12
      : event.key === "ArrowRight" ? contextWidth - 12
        : event.key === "Home" ? 280
          : event.key === "End" ? 460
            : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setContextWidth(Math.max(280, Math.min(460, next)));
  }

  // The explicit filter is a browsing filter: it never hides a track the user
  // already downloaded on purpose.
  const hideExplicit = settings.hideExplicitContent;
  const filterSongs = useCallback((songs: SongSummary[]) => hideExplicit
    ? songs.filter((song) => !song.explicitStatus || song.explicitStatus === "clean")
    : songs, [hideExplicit]);
  const shownDetail = useMemo(() => {
    if (!detail) return detail;
    if ("songs" in detail) return { ...detail, songs: filterSongs(detail.songs) };
    return { ...detail, topSongs: detail.topSongs ? filterSongs(detail.topSongs) : detail.topSongs };
  }, [detail, filterSongs]);
  const shownSearch = useMemo(() => ({ ...searchResults, songs: filterSongs(searchResults.songs) }), [filterSongs, searchResults]);
  const shownLiked = useMemo(() => filterSongs(libraryData.starredSongs), [filterSongs, libraryData.starredSongs]);
  const shownRadio = useMemo(() => radioData ? { ...radioData, songs: filterSongs(radioData.songs) } : radioData, [filterSongs, radioData]);

  const visibleSongs = shownDetail && "songs" in shownDetail ? shownDetail.songs : route.kind === "liked" ? shownLiked : route.kind === "downloads" ? downloads.items.map((item) => item.song) : route.kind === "radio" ? shownRadio?.songs ?? [] : shownSearch.songs;
  const selectedSongs = visibleSongs.filter((song, index) => selectedIds.has(`${song.id}-${index}`));

  async function addSongsToPlaylists(songs: SongSummary[], playlists: PlaylistSummary[]) {
    let added = 0;
    try {
      for (const playlist of playlists) {
        await invoke("add_songs_to_playlist", { playlistId: playlist.id, songIds: songs.map((song) => song.id) });
        added += songs.length;
      }
      setToast(playlists.length === 1 ? `Added to ${playlists[0].name}` : `Added to ${playlists.length} playlists`);
      reloadLibrary();
    } catch (reason) {
      setPageError(reasonMessage(reason, added ? "Only some songs could be added to that playlist." : "The song could not be added to that playlist."));
    }
  }

  async function toggleSelectionLike(songs: SongSummary[]) {
    const allLiked = songs.every((song) => isSongLiked(song));
    for (const song of songs) {
      if (isSongLiked(song) === allLiked) await toggleSongStar(song);
    }
    setSelectedIds(new Set());
  }

  function isSongLiked(song: SongSummary) {
    return parseExternalSource(song.id)
      ? isExternalLiked(library, song)
      : Boolean(song.starred) || libraryData.starredSongs.some((item) => item.id === song.id);
  }

  const rememberJumpBackIn = useCallback((item: JumpBackInItem) => {
    setJumpBackIn(rememberRecentCollection(profileScope, item));
  }, [profileScope]);
  const openAlbum = useCallback((album: AlbumSummary) => {
    rememberJumpBackIn({ kind: "album", id: album.id, title: album.title, subtitle: `Album · ${album.artist}`, coverArt: album.coverArt });
    navigate({ kind: "album", id: album.id });
  }, [navigate, rememberJumpBackIn]);
  const openArtist = useCallback((artist: ArtistSummary) => {
    rememberJumpBackIn({ kind: "artist", id: artist.id, title: artist.name, subtitle: "Artist", coverArt: artist.coverArt });
    navigate({ kind: "artist", id: artist.id });
  }, [navigate, rememberJumpBackIn]);
  const openPlaylist = useCallback((playlist: PlaylistSummary) => {
    rememberJumpBackIn({ kind: "playlist", id: playlist.id, title: playlist.name, subtitle: playlist.owner ? `Playlist · ${playlist.owner}` : "Playlist", coverArt: playlist.coverArt });
    navigate({ kind: "playlist", id: playlist.id });
  }, [navigate, rememberJumpBackIn]);
  const openAlbumById = (id: string) => {
    const summary = libraryData.albums.find((album) => album.id === id)
      ?? (playback.current?.albumId === id ? { id, title: playback.current.album, artist: playback.current.artist, coverArt: playback.current.coverArt } : undefined);
    if (summary) openAlbum(summary);
    else navigate({ kind: "album", id });
  };
  const openArtistById = (id: string) => {
    const summary = libraryData.artists.find((artist) => artist.id === id)
      ?? (playback.current?.artistId === id ? { id, name: playback.current.artist, coverArt: playback.current.coverArt } : undefined);
    if (summary) openArtist(summary);
    else navigate({ kind: "artist", id });
  };
  const startRadio = (song: SongSummary) => navigate({ kind: "radio", id: song.id, title: `${song.title} Radio` });
  const toggleShuffle = () => playback.setShuffle((value) => !value);
  const detailTitle = detail ? ("name" in detail ? detail.name : "title" in detail ? detail.title : undefined) : undefined;
  const routeTitle = route.kind === "home" ? greeting() : route.kind === "search" ? "Search" : route.kind === "library" ? "Your Library" : route.kind === "liked" ? "Liked Songs" : route.kind === "downloads" ? "Downloads" : route.kind === "profile" ? "Profile" : route.kind === "settings" ? "Settings" : route.kind === "radio" ? route.title : "Splice";
  const visiblePlaylists = settings.hideExternalPlaylists
    ? libraryData.playlists.filter((playlist) => parseExternalSource(playlist.id)?.type !== "playlist")
    : libraryData.playlists;
  const homeShortcuts = useMemo<HomeShortcut[]>(() => {
    const items: HomeShortcut[] = [];
    if (shownLiked.length) items.push({ kind: "liked", id: "liked", title: "Liked Songs", subtitle: `${shownLiked.length} songs` });
    items.push(...visiblePlaylists.slice(0, 2).map((playlist) => ({
      kind: "playlist" as const,
      id: playlist.id,
      title: playlist.name,
      subtitle: playlist.owner ? `Playlist · ${playlist.owner}` : "Playlist",
      coverArt: playlist.coverArt,
    })));
    const albums = [...homeData.recent, ...homeData.frequent]
      .filter((album, index, all) => all.findIndex((item) => item.id === album.id) === index);
    for (const album of albums) {
      if (items.length >= 6) break;
      items.push({ kind: "album", id: album.id, title: album.title, subtitle: album.artist, coverArt: album.coverArt });
    }
    return items.slice(0, 6);
  }, [homeData.frequent, homeData.recent, shownLiked.length, visiblePlaylists]);
  const openHomeShortcut = (item: HomeShortcut) => {
    if (item.kind === "liked") navigate({ kind: "liked" });
    else if (item.kind === "playlist") openPlaylist({ id: item.id, name: item.title, owner: item.subtitle.startsWith("Playlist · ") ? item.subtitle.slice(11) : undefined, coverArt: item.coverArt });
    else openAlbum({ id: item.id, title: item.title, artist: item.subtitle, coverArt: item.coverArt });
  };
  const playHomeShortcut = (item: HomeShortcut) => {
    if (item.kind === "liked") playCollection(shownLiked, "Liked Songs");
    else if (item.kind === "playlist") void playPlaylist({ id: item.id, name: item.title, coverArt: item.coverArt });
    else void playAlbum({ id: item.id, title: item.title, artist: item.subtitle, coverArt: item.coverArt });
  };
  const openJumpBackIn = (item: JumpBackInItem) => {
    if (item.kind === "album") openAlbum({ id: item.id, title: item.title, artist: item.subtitle.replace(/^Album · /, ""), coverArt: item.coverArt });
    else if (item.kind === "artist") openArtist({ id: item.id, name: item.title, coverArt: item.coverArt });
    else openPlaylist({ id: item.id, name: item.title, owner: item.subtitle.startsWith("Playlist · ") ? item.subtitle.slice(11) : undefined, coverArt: item.coverArt });
  };
  const matchingSearchPlaylists = query.trim()
    ? visiblePlaylists.filter((playlist) => playlist.name.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 30)
    : [];
  const hasSearchResults = searchResults.songs.length + searchResults.albums.length + searchResults.artists.length + matchingSearchPlaylists.length > 0;
  const allLibraryItems = libraryFilter === "playlists" ? visiblePlaylists : libraryFilter === "artists" ? libraryData.artists : libraryData.albums;
  const libraryItems = allLibraryItems.filter((item) => ("name" in item ? item.name : item.title).toLowerCase().includes(librarySearch.toLowerCase()));
  // Pinned rows float to the top of whatever ordering is in effect.
  const orderedLibraryItems = [...libraryItems].sort((a, b) => {
    const pinnedDelta = Number(pinned.has(b.id)) - Number(pinned.has(a.id));
    if (pinnedDelta) return pinnedDelta;
    if (librarySort === "alphabetical") return ("name" in a ? a.name : a.title).localeCompare("name" in b ? b.name : b.title);
    return 0;
  });
  const sidebarLibraryItems = librarySearch ? orderedLibraryItems : orderedLibraryItems.slice(0, 600);
  // Albums the user already has liked songs on, newest like first.
  const likedAlbums = useMemo(() => {
    const byId = new Map(libraryData.albums.map((album) => [album.id, album]));
    const seen = new Set<string>();
    const albums: AlbumSummary[] = [];
    for (const song of libraryData.starredSongs) {
      if (!song.albumId || seen.has(song.albumId)) continue;
      seen.add(song.albumId);
      const album = byId.get(song.albumId) ?? { id: song.albumId, title: song.album, artist: song.artist, artistId: song.artistId, coverArt: song.coverArt, year: song.year };
      albums.push(album);
      if (albums.length >= 24) break;
    }
    return albums;
  }, [libraryData.albums, libraryData.starredSongs]);

  const openCollectionMenu = (kind: CollectionMenuState["kind"], id: string, name: string, event: ReactMouseEvent) => {
    event.preventDefault();
    setCollectionMenu({ kind, id, name, x: event.clientX, y: event.clientY });
  };
  const cardMenu = {
    album: (album: AlbumSummary, event: ReactMouseEvent) => openCollectionMenu("album", album.id, album.title, event),
    artist: (artist: ArtistSummary, event: ReactMouseEvent) => openCollectionMenu("artist", artist.id, artist.name, event),
    playlist: (playlist: PlaylistSummary, event: ReactMouseEvent) => openCollectionMenu("playlist", playlist.id, playlist.name, event),
  };
  const menuStarred = collectionMenu?.kind === "album"
    ? libraryData.starredAlbums.some((album) => album.id === collectionMenu.id)
    : collectionMenu?.kind === "artist"
      ? libraryData.starredArtists.some((artist) => artist.id === collectionMenu.id)
      : false;

  const collectionStarred = route.kind === "album"
    ? libraryData.starredAlbums.some((album) => album.id === route.id)
    : route.kind === "artist"
      ? libraryData.starredArtists.some((artist) => artist.id === route.id)
      : false;
  // Only the owner can rename, delete or reorder a server playlist.
  const ownsCurrentPlaylist = route.kind === "playlist" && detail !== undefined && "songs" in detail
    && (!(detail as PlaylistDetail).owner || (detail as PlaylistDetail).owner === library.server.username);
  const currentLiked = Boolean(playback.current && (
    isExternalLiked(library, playback.current)
    || libraryData.starredSongs.some((song) => song.id === playback.current?.id)
  ));

  return (
    <div className={`desktop-shell${panelMode ? " desktop-shell--panel" : ""}${fullPlayer ? " desktop-shell--expanded" : ""}`} style={{ "--sidebar-width": `${sidebarWidth}px`, "--context-width": `${contextWidth}px` } as CSSProperties}>
      <aside className={sidebarWidth < 160 ? "desktop-sidebar desktop-sidebar--compact" : "desktop-sidebar"}>
        <Brand compact={sidebarWidth < 160} />
        <nav aria-label="Main navigation">
          <NavButton active={route.kind === "home"} icon={Home} label="Home" onClick={() => navigate({ kind: "home" })} />
          <NavButton active={route.kind === "search"} icon={Search} label="Search" onClick={() => navigate({ kind: "search" })} />
        </nav>
        <div className="sidebar-library-header"><button className={route.kind === "library" ? "desktop-nav desktop-nav--active" : "desktop-nav"} onClick={() => navigate({ kind: "library" })} type="button"><Library fill={route.kind === "library" ? "currentColor" : "none"} size={21} />Your Library</button><button aria-label="Create playlist" className="sidebar-create" onClick={() => setCreatePlaylistOpen(true)} title="Create playlist" type="button"><Plus size={18} /><span>Create</span></button></div>
        <div className="sidebar-tools"><label className="sidebar-search"><Search size={14} /><input aria-label="Search your library" onChange={(event) => setLibrarySearch(event.target.value)} placeholder="Search your library" value={librarySearch} /></label><button aria-label={`Sort library by ${librarySort === "alphabetical" ? "recent activity" : "name"}`} className="sidebar-sort" onClick={() => setLibrarySort((value) => value === "recents" ? "alphabetical" : "recents")} title={librarySort === "alphabetical" ? "Sort by recent activity" : "Sort by name"} type="button"><ArrowDownUp size={15} /></button></div>
        <div className="filter-chips filter-chips--sidebar">{(["playlists", "artists", "albums"] as LibraryFilter[]).map((value) => <button aria-pressed={libraryFilter === value} className={libraryFilter === value ? "filter-chip filter-chip--active" : "filter-chip"} key={value} onClick={() => setLibraryFilter(value)} title={`Show ${value}`} type="button">{value[0].toUpperCase() + value.slice(1)}</button>)}</div>
        <button aria-label="Liked Songs" className={route.kind === "liked" ? "sidebar-collection sidebar-collection--active" : "sidebar-collection"} onClick={() => navigate({ kind: "liked" })} title="Liked Songs" type="button"><span className="liked-mini"><Heart fill="currentColor" size={20} /></span><span><strong>Liked Songs</strong><small>Playlist · {libraryData.starredSongs.length} songs</small></span></button>
        <button aria-label="Downloads" className={route.kind === "downloads" ? "sidebar-collection sidebar-collection--active" : "sidebar-collection"} onClick={() => navigate({ kind: "downloads" })} title="Downloads" type="button"><span className="downloads-mini"><Download size={20} /></span><span><strong>Downloads</strong><small>{downloads.items.length} available offline</small></span></button>
        <div className="sidebar-collections" aria-label="Your library">
          {libraryFilter === "playlists" && (sidebarLibraryItems as PlaylistSummary[]).map((playlist) => <SidebarCollectionRow active={route.kind === "playlist" && route.id === playlist.id} className={dropPlaylistId === playlist.id ? "sidebar-collection--drop" : undefined} coverArt={playlist.coverArt} fallback="playlist" key={playlist.id} onContextMenu={(event) => cardMenu.playlist(playlist, event)} onDoubleClick={() => void playPlaylist(playlist)} onDragLeave={() => setDropPlaylistId((value) => value === playlist.id ? undefined : value)} onDragOver={(event) => { if (!event.dataTransfer.types.includes(SONG_DRAG_TYPE)) return; event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDropPlaylistId(playlist.id); }} onDrop={(event) => { event.preventDefault(); setDropPlaylistId(undefined); const ids = readSongDrag(event); if (ids.length) void addSongIdsToPlaylist(ids, playlist); }} onOpen={() => openPlaylist(playlist)} onPin={() => togglePinned(playlist.id)} onPlay={() => void playPlaylist(playlist)} pinned={pinned.has(playlist.id)} subtitle={`Playlist${playlist.owner ? ` · ${playlist.owner}` : ""}`} title={playlist.name} />)}
          {libraryFilter === "artists" && (sidebarLibraryItems as ArtistSummary[]).map((artist) => <SidebarCollectionRow active={route.kind === "artist" && route.id === artist.id} coverArt={artist.coverArt} fallback="artist" key={artist.id} onContextMenu={(event) => cardMenu.artist(artist, event)} onOpen={() => openArtist(artist)} onPin={() => togglePinned(artist.id)} pinned={pinned.has(artist.id)} shape="circle" subtitle="Artist" title={artist.name} />)}
          {libraryFilter === "albums" && (sidebarLibraryItems as AlbumSummary[]).map((album) => <SidebarCollectionRow active={route.kind === "album" && route.id === album.id} coverArt={album.coverArt} key={album.id} onContextMenu={(event) => cardMenu.album(album, event)} onDoubleClick={() => void playAlbum(album)} onOpen={() => openAlbum(album)} onPin={() => togglePinned(album.id)} onPlay={() => void playAlbum(album)} pinned={pinned.has(album.id)} subtitle={`Album · ${album.artist}`} title={album.title} />)}
        </div>
        <button aria-label="Resize library sidebar" aria-orientation="vertical" aria-valuemax={420} aria-valuemin={72} aria-valuenow={Math.round(sidebarWidth)} className="sidebar-resizer" onKeyDown={resizeSidebarWithKeyboard} onPointerDown={beginResize} role="separator" type="button" />
      </aside>

      <main className={`desktop-workspace desktop-workspace--${route.kind}`}>
        <header className={workspaceScrolled ? "desktop-topbar desktop-topbar--scrolled" : "desktop-topbar"} data-tauri-drag-region>
          <div className="desktop-topbar__leading"><div className="history-controls"><button aria-label="Back" disabled={historyIndex === 0} onClick={goBack} title="Back" type="button"><ArrowLeft size={19} /></button><button aria-label="Forward" disabled={historyIndex === history.length - 1} onClick={goForward} title="Forward" type="button"><ArrowRight size={19} /></button></div>{workspaceScrolled && route.kind !== "search" && <strong className="desktop-topbar__title">{detailTitle ?? routeTitle}</strong>}</div>
          <label className="desktop-search"><Search size={19} /><input autoFocus={route.kind === "search"} data-search-input onChange={(event) => { if (route.kind !== "search") navigate({ kind: "search" }); setQuery(event.target.value); }} onFocus={() => { if (route.kind !== "search") navigate({ kind: "search" }); }} onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); document.querySelector<HTMLElement>("[data-search-result]")?.focus(); } }} placeholder="What do you want to listen to?" value={query} />{query && <button aria-label="Clear search" onClick={() => setQuery("")} type="button"><X size={17} /></button>}</label>
          <div className="desktop-topbar__trailing">
            <div aria-live="polite" className={`sync-status${offline ? " sync-status--offline" : ""}${syncingResources > 0 ? " sync-status--syncing" : ""}`} title={offline ? connection.message : syncingResources > 0 ? "Refreshing your server library" : "Connected to your music server"}>
              <i aria-hidden="true" /><span>{offline ? "Offline" : syncingResources > 0 ? "Syncing" : "Online"}</span>
            </div>
            <AccountMenu
              busy={leavingSession}
              host={library.server.displayHost}
              onOpenChange={setAccountOpen}
              onProfile={() => navigate({ kind: "profile" })}
              onSettings={() => navigate({ kind: "settings" })}
              onSignOut={() => setSignOutConfirm(true)}
              onSwitchAccount={() => void leaveSession(false)}
              open={accountOpen}
              username={library.server.username}
            />
          </div>
        </header>
        <div className="desktop-content" onScroll={(event) => setWorkspaceScrolled(event.currentTarget.scrollTop > 4)} ref={workspaceRef}>
          {offline && (
            <div className="connection-banner" role="status">
              <span><strong>{settings.offlineMode ? "Offline mode" : "Server unavailable"}</strong><small>{settings.offlineMode ? "Offline mode is on in Settings. Only downloaded music plays." : connection.message ?? "Showing the last library saved on this computer."}</small></span>
              {settings.offlineMode
                ? <button onClick={() => updateSetting("offlineMode", false)} type="button">Go online</button>
                : <button disabled={reconnecting} onClick={() => void retryConnection()} type="button">{reconnecting ? "Reconnecting…" : "Reconnect"}</button>}
            </div>
          )}
          {pageError && <div className="page-error" role="alert">{pageError}<button aria-label="Dismiss error" onClick={() => setPageError(undefined)} type="button"><X size={15} /></button></div>}
          {route.kind === "home" && <Views.HomeView cardMenu={cardMenu} data={homeData} error={homeError} hiddenRows={settings.hiddenHomeRows} jumpBackIn={jumpBackIn} likedAlbums={likedAlbums} onOpen={openAlbum} onOpenJumpBackIn={openJumpBackIn} onOpenShortcut={openHomeShortcut} onPlay={playAlbum} onPlayShortcut={playHomeShortcut} onRetry={reloadHome} rowOrder={settings.homeRowOrder} shortcuts={homeShortcuts} title={routeTitle} />}
          {route.kind === "search" && <Views.SearchView cardMenu={cardMenu} currentId={playback.current?.id} data={shownSearch} filter={searchFilter} onFilter={setSearchFilter} hasResults={hasSearchResults} historyKey={searchHistoryKey} home={homeData} isLoading={searching} isPlaying={playback.isPlaying} onMenu={openTrackMenu} onOpenAlbum={openAlbum} onOpenArtist={openArtist} onOpenPlaylist={openPlaylist} onPlayAlbum={playAlbum} onPlayPlaylist={playPlaylist} onPlaySongs={(songs, index) => startPlayback(songs, index, `Search for ${query}`)} onRecent={setQuery} onSelect={selectTrack} playlists={matchingSearchPlaylists} query={query} selectedIds={selectedIds} />}
          {route.kind === "library" && <Views.LibraryView cardMenu={cardMenu} error={libraryError} filter={libraryFilter} grid={settings.libraryGridView} items={libraryItems} onToggleGrid={() => updateSetting("libraryGridView", !settings.libraryGridView)} onFilter={setLibraryFilter} onOpenAlbum={openAlbum} onOpenArtist={openArtist} onOpenPlaylist={openPlaylist} onPlayAlbum={playAlbum} onPlayPlaylist={playPlaylist} onRetry={reloadLibrary} />}
          {route.kind === "liked" && <Views.LikedView currentId={playback.current?.id} isPlaying={playback.isPlaying} onMenu={openTrackMenu} onPlay={(songs, index) => startPlayback(songs, index, "Liked Songs")} onPlayCollection={playCollection} onSelect={selectTrack} onToggleShuffle={toggleShuffle} onToggleStar={toggleSongStar} selectedIds={selectedIds} shuffleArmed={playback.shuffle} songs={shownLiked} />}
          {route.kind === "downloads" && <Views.DownloadsView currentId={playback.current?.id} downloads={downloads} isPlaying={playback.isPlaying} onClear={() => setClearDownloadsConfirm(true)} onMenu={openTrackMenu} onPlay={(songs, index) => startPlayback(songs, index, "Downloads")} onSelect={selectTrack} />}
          {(route.kind === "album" || route.kind === "playlist" || route.kind === "artist") && (pageError && !detail && !pageLoading ? <Views.EmptyState title="This page is unavailable" body="Reconnect to your server, then try again." /> : <Views.DetailView cardMenu={cardMenu} collectionStarred={collectionStarred} onEnlarge={(coverArt, alt) => setLightbox({ coverArt, alt })} onDelete={() => detail && "name" in detail && setPlaylistDelete({ id: route.kind === "playlist" ? route.id : "", name: detail.name })} currentId={playback.current?.id} detail={shownDetail} downloads={downloads} isLoading={pageLoading} isPlaying={playback.isPlaying} onDownloadCollection={(songs) => void downloadCollection(songs)} onMenu={openTrackMenu} onOpenAlbum={openAlbumById} onOpenArtist={openArtistById} onPlay={(songs, index, label) => startPlayback(songs, index, label)} onPlayAlbum={playAlbum} onPlayCollection={playCollection} onRadio={startRadio} onRemoveCollection={(songs) => void removeCollection(songs)} onRename={() => detail && "name" in detail && setPlaylistEdit({ id: route.kind === "playlist" ? route.id : "", name: detail.name })} onReorder={(from, to) => void reorderCurrentPlaylist(from, to)} onSelect={selectTrack} onToggleCollectionStar={() => (route.kind === "album" || route.kind === "artist") && void setCollectionStarred(route.kind, route.id, !collectionStarred, detail as AlbumSummary | ArtistSummary | undefined)} onToggleShuffle={toggleShuffle} onToggleStar={toggleSongStar} ownsPlaylist={ownsCurrentPlaylist} route={route} selectedIds={selectedIds} shuffleArmed={playback.shuffle} />)}
          {route.kind === "radio" && <Views.RadioView currentId={playback.current?.id} data={shownRadio} isLoading={pageLoading} isPlaying={playback.isPlaying} onMenu={openTrackMenu} onPlay={(songs, index) => startPlayback(songs, index, route.title)} onPlayCollection={playCollection} onSelect={selectTrack} onToggleShuffle={toggleShuffle} onToggleStar={toggleSongStar} selectedIds={selectedIds} shuffleArmed={playback.shuffle} title={route.title} />}
          {route.kind === "profile" && <Views.ProfileView connectionStatus={connection.status} library={library} overview={libraryData} onDevices={() => openPanel("connect")} onSettings={() => navigate({ kind: "settings" })} onSignOut={() => void leaveSession(false)} />}
          {route.kind === "settings" && <Views.SettingsView contextWidth={contextWidth} downloads={downloads} library={library} onClearDownloads={() => setClearDownloadsConfirm(true)} onOpenPanel={openPanel} onReload={() => { reloadHome(); reloadLibrary(); }} onResetLayout={() => { setSidebarWidth(280); setContextWidth(350); setToast("Desktop layout reset"); }} onSleep={(minutes) => { setSleepAt(minutes === undefined ? undefined : Date.now() + minutes * 60_000); setToast(minutes === undefined ? "Sleep timer cancelled" : `Playback stops in ${minutes} min`); }} resetSettings={resetSettings} settings={settings} sidebarWidth={sidebarWidth} sleepRemaining={sleepRemaining} updateSetting={updateSetting} />}
        </div>
      </main>

      {panelMode && <DesktopContextPanel connect={connectState} groupId={groupSession?.id} lyrics={lyrics} lyricsLoading={lyricsLoading} mode={panelMode} onClose={() => setPanelMode(undefined)} onMoveHere={playPeerHere} onMoveToDevice={movePlaybackTo} remoteDeviceId={remoteDevice?.id} lyricsAutoScroll={settings.lyricsAutoScroll} lyricsTextSize={settings.lyricsTextSize} onResize={beginContextResize} onResizeKey={resizeContextWithKeyboard} onSaveQueue={() => setSaveQueueOpen(true)} onSend={sendRemote} onStartGroup={startGroup} onStopGroup={stopGroup} playback={playback} width={contextWidth} />}
      <PlayerBar expanded={fullPlayer} liked={currentLiked} onOpenDevices={() => openPanel("connect")} remoteDevice={remoteDevice} onOpenAlbum={(id) => { setFullPlayer(false); openAlbumById(id); }} onOpenArtist={(id) => { setFullPlayer(false); openArtistById(id); }} onOpenPanel={openPanel} onToggleExpanded={() => setFullPlayer((value) => !value)} onToggleLike={() => playback.current && void toggleSongStar({ ...playback.current, starred: currentLiked ? new Date().toISOString() : undefined })} panelMode={panelMode} playback={transport} />
      {fullPlayer && <FullPlayer liked={currentLiked} lyrics={lyrics} lyricsAutoScroll={settings.lyricsAutoScroll} lyricsLoading={lyricsLoading} lyricsTextSize={settings.lyricsTextSize} onClose={() => setFullPlayer(false)} onOpenAlbum={(id) => { setFullPlayer(false); openAlbumById(id); }} onOpenArtist={(id) => { setFullPlayer(false); openArtistById(id); }} onOpenPanel={openPanel} onToggleLike={() => playback.current && void toggleSongStar({ ...playback.current, starred: currentLiked ? new Date().toISOString() : undefined })} playback={transport} />}
      {trackMenu && (() => {
        const targets = selectedIds.has(`${trackMenu.song.id}-${trackMenu.index}`) && selectedSongs.length > 1 ? selectedSongs : [trackMenu.song];
        return <><button aria-label="Close track menu" className="context-menu-scrim" onClick={() => setTrackMenu(undefined)} type="button" /><TrackContextMenu
          downloaded={targets.every((song) => downloads.downloadedIds.has(song.id))}
          liked={targets.every((song) => isSongLiked(song))}
          menu={trackMenu}
          onAddToPlaylist={() => setPlaylistTarget(targets)}
          onClose={() => setTrackMenu(undefined)}
          onDownload={() => targets.length > 1 ? void downloadCollection(targets) : void downloadSong(trackMenu.song)}
          onEnqueue={() => { targets.forEach((song) => playback.enqueue(song)); setToast(targets.length > 1 ? `${targets.length} added to queue` : "Added to queue"); }}
          onOpenAlbum={trackMenu.song.albumId ? () => openAlbumById(trackMenu.song.albumId!) : undefined}
          onOpenArtist={trackMenu.song.artistId ? () => openArtistById(trackMenu.song.artistId!) : undefined}
          onPlayNext={() => { [...targets].reverse().forEach((song) => playback.playNext(song)); setToast(targets.length > 1 ? `${targets.length} playing next` : "Playing next"); }}
          onRadio={() => startRadio(trackMenu.song)}
          onRemoveDownload={() => targets.length > 1 ? void removeCollection(targets) : void removeDownloadedSong(trackMenu.song)}
          onRemoveFromPlaylist={route.kind === "playlist" && targets.length === 1 ? () => void removeFromCurrentPlaylist(trackMenu.index) : undefined}
          onToggleLike={() => targets.length > 1 ? void toggleSelectionLike(targets) : void toggleSongStar(trackMenu.song)}
          targetCount={targets.length}
        /></>;
      })()}
      {selectedIds.size > 0 && (
        <SelectionBar
          allLiked={selectedSongs.length > 0 && selectedSongs.every((song) => isSongLiked(song))}
          allSelected={selectedIds.size >= visibleSongs.length && visibleSongs.length > 0}
          onAddToPlaylist={() => setPlaylistTarget(selectedSongs)}
          onClear={() => setSelectedIds(new Set())}
          onEnqueue={() => { selectedSongs.forEach((song) => playback.enqueue(song)); setToast(`${selectedSongs.length} added to queue`); setSelectedIds(new Set()); }}
          onPlayNext={() => { [...selectedSongs].reverse().forEach((song) => playback.playNext(song)); setToast(`${selectedSongs.length} playing next`); setSelectedIds(new Set()); }}
          onSelectAll={() => setSelectedIds((current) => current.size >= visibleSongs.length ? new Set() : new Set(visibleSongs.map((song, index) => `${song.id}-${index}`)))}
          onToggleLike={() => void toggleSelectionLike(selectedSongs)}
          selectedCount={selectedIds.size}
        />
      )}
      {playlistTarget && (
        <AddToPlaylistDialog
          onCancel={() => setPlaylistTarget(undefined)}
          onConfirm={(playlists) => { const songs = playlistTarget; setPlaylistTarget(undefined); setSelectedIds(new Set()); void addSongsToPlaylists(songs, playlists); }}
          onCreate={() => { setPlaylistTarget(undefined); setCreatePlaylistOpen(true); }}
          playlists={libraryData.playlists}
          songs={playlistTarget}
        />
      )}
      {createPlaylistOpen && <NameDialog confirmLabel="Create" eyebrow="NEW PLAYLIST" onCancel={() => setCreatePlaylistOpen(false)} onConfirm={createPlaylist} title="Create playlist" />}
      {saveQueueOpen && <NameDialog confirmLabel="Save" eyebrow="QUEUE" initialValue={playback.contextLabel} onCancel={() => setSaveQueueOpen(false)} onConfirm={(name) => void saveQueueAsPlaylist(name)} title={`Save ${playback.queue.length} songs as a playlist`} />}
      {playlistEdit && (
        <NameDialog
          confirmLabel="Rename"
          eyebrow="PLAYLIST"
          initialValue={playlistEdit.name}
          onCancel={() => setPlaylistEdit(undefined)}
          onConfirm={(name) => { const target = playlistEdit.id; setPlaylistEdit(undefined); void renamePlaylist(target, name); }}
          title="Rename playlist"
        />
      )}
      {playlistDelete && (
        <ConfirmDialog
          body="This deletes the playlist on the server for everyone who can see it. Downloaded songs stay on this computer."
          confirmLabel="Delete playlist"
          eyebrow="PLAYLIST"
          onCancel={() => setPlaylistDelete(undefined)}
          onConfirm={() => void deletePlaylist(playlistDelete.id)}
          title={`Delete ${playlistDelete.name}?`}
        />
      )}
      {clearDownloadsConfirm && (
        <ConfirmDialog
          body="Every downloaded track for this server profile will be removed from this computer. Your server library and playlists will not change."
          confirmLabel="Clear downloads"
          eyebrow="OFFLINE MUSIC"
          onCancel={() => setClearDownloadsConfirm(false)}
          onConfirm={() => void clearAllDownloads()}
          title="Clear all downloads?"
        />
      )}
      {signOutConfirm && (
        <ConfirmDialog
          body={`This removes the saved login for ${library.server.displayHost} from this computer. Downloads and cached artwork stay on disk.`}
          confirmLabel="Sign out"
          eyebrow="ACCOUNT"
          onCancel={() => setSignOutConfirm(false)}
          onConfirm={() => void leaveSession(true)}
          title={`Sign out ${library.server.username}?`}
        />
      )}
      {collectionMenu && <>
        <button aria-label="Close menu" className="context-menu-scrim" onClick={() => setCollectionMenu(undefined)} type="button" />
        <CollectionMenu
          canEdit={libraryData.playlists.some((playlist) => playlist.id === collectionMenu.id && (!playlist.owner || playlist.owner === library.server.username))}
          menu={collectionMenu}
          onClose={() => setCollectionMenu(undefined)}
          onDelete={() => setPlaylistDelete({ id: collectionMenu.id, name: collectionMenu.name })}
          onDownload={() => void runCollectionAction(collectionMenu, "download")}
          onEnqueue={() => void runCollectionAction(collectionMenu, "enqueue")}
          onOpen={() => navigate({ kind: collectionMenu.kind, id: collectionMenu.id })}
          onPin={() => togglePinned(collectionMenu.id)}
          onPlay={() => void runCollectionAction(collectionMenu, "play")}
          onRename={() => setPlaylistEdit({ id: collectionMenu.id, name: collectionMenu.name })}
          onToggleStar={() => collectionMenu.kind !== "playlist" && void setCollectionStarred(collectionMenu.kind, collectionMenu.id, !menuStarred)}
          pinned={pinned.has(collectionMenu.id)}
          starred={menuStarred}
        />
      </>}
      {lightbox && <Views.ArtworkLightbox alt={lightbox.alt} coverArt={lightbox.coverArt} onClose={() => setLightbox(undefined)} />}
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
      {toast && <div className="desktop-toast" role="status">{toast}</div>}
    </div>
  );
}

function AccountMenu({ busy, host, onOpenChange, onProfile, onSettings, onSignOut, onSwitchAccount, open, username }: {
  busy: boolean;
  host: string;
  onOpenChange: (open: boolean) => void;
  onProfile: () => void;
  onSettings: () => void;
  onSignOut: () => void;
  onSwitchAccount: () => void;
  open: boolean;
  username: string;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);
  const choose = (action: () => void) => {
    onOpenChange(false);
    action();
  };
  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not(:disabled)") ?? []);
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = current;
    if (event.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % items.length;
    else if (event.key === "ArrowUp") next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key === "Escape") {
      event.preventDefault();
      onOpenChange(false);
      buttonRef.current?.focus();
      return;
    } else return;
    event.preventDefault();
    items[next]?.focus();
  };
  return (
    <div className="account-menu-wrap">
      <button aria-expanded={open} aria-haspopup="menu" aria-label="Open account menu" className="account-pill" onClick={() => onOpenChange(!open)} ref={buttonRef} title="Account" type="button">{username.slice(0, 1).toUpperCase()}</button>
      {open && <>
        <button aria-label="Close account menu" className="account-menu-scrim" onClick={() => { onOpenChange(false); buttonRef.current?.focus(); }} tabIndex={-1} type="button" />
        <div aria-label="Account" className="account-menu" onKeyDown={onMenuKeyDown} ref={menuRef} role="menu">
          <div className="account-menu__identity"><strong>{username}</strong><small>{host}</small></div>
          <button onClick={() => choose(onProfile)} role="menuitem" type="button"><UserRound size={17} /> Profile</button>
          <button onClick={() => choose(onSettings)} role="menuitem" type="button"><Settings size={17} /> Settings</button>
          <div className="account-menu__separator" />
          <button disabled={busy} onClick={() => choose(onSwitchAccount)} role="menuitem" type="button"><UserRound size={17} /> Switch account</button>
          <button disabled={busy} onClick={() => choose(onSignOut)} role="menuitem" type="button"><LogOut size={17} /> Sign out</button>
        </div>
      </>}
    </div>
  );
}

function NavButton({ active, icon: Icon, label, onClick }: { active: boolean; icon: typeof Home; label: string; onClick: () => void }) {
  return <button aria-current={active ? "page" : undefined} className={active ? "desktop-nav desktop-nav--active" : "desktop-nav"} onClick={onClick} type="button"><Icon fill={active ? "currentColor" : "none"} size={21} />{label}</button>;
}

type SidebarCollectionRowProps = Omit<ComponentPropsWithoutRef<"div">, "title"> & {
  active: boolean;
  coverArt?: string;
  fallback?: "album" | "artist" | "playlist";
  onOpen: () => void;
  onPin: () => void;
  onPlay?: () => void;
  pinned: boolean;
  shape?: "square" | "circle";
  subtitle: string;
  title: string;
};

function SidebarCollectionRow({ active, className, coverArt, fallback = "album", onOpen, onPin, onPlay, pinned, shape = "square", subtitle, title, ...rowProps }: SidebarCollectionRowProps) {
  const classes = ["sidebar-collection", active ? "sidebar-collection--active" : "", className].filter(Boolean).join(" ");
  return (
    <div className={classes} {...rowProps}>
      <button aria-current={active ? "page" : undefined} aria-label={`Open ${title}`} className="sidebar-collection__main" onClick={onOpen} title={title} type="button">
        <span className="sidebar-collection__cover"><MediaArtwork alt="" className="sidebar-collection__art" coverArt={coverArt} fallback={fallback} shape={shape} /></span>
        <span className="sidebar-collection__copy"><strong>{title}</strong><small>{subtitle}</small></span>
      </button>
      {onPlay && <button aria-label={`Play ${title}`} className="sidebar-collection__play" onClick={onPlay} onDoubleClick={(event) => event.stopPropagation()} title={`Play ${title}`} type="button"><Play fill="currentColor" size={13} /></button>}
      <button aria-label={`${pinned ? "Unpin" : "Pin"} ${title}`} className={pinned ? "sidebar-collection__pin sidebar-collection__pin--on" : "sidebar-collection__pin"} onClick={onPin} onDoubleClick={(event) => event.stopPropagation()} title={pinned ? "Unpin" : "Pin to top"} type="button"><Pin size={13} /></button>
    </div>
  );
}

function NameDialog({ confirmLabel, eyebrow, initialValue = "", onCancel, onConfirm, title }: { confirmLabel: string; eyebrow: string; initialValue?: string; onCancel: () => void; onConfirm: (name: string) => void; title: string }) {
  const [name, setName] = useState(initialValue);
  const dialogRef = useDialogFocus<HTMLFormElement>(onCancel);
  return <div className="modal-scrim"><form aria-labelledby="name-dialog-title" aria-modal="true" className="desktop-modal" onSubmit={(event) => { event.preventDefault(); if (name.trim()) onConfirm(name); }} ref={dialogRef} role="dialog"><p className="eyebrow">{eyebrow}</p><h2 id="name-dialog-title">{title}</h2><label>Name<input autoFocus maxLength={120} onChange={(event) => setName(event.target.value)} placeholder="My playlist" value={name} /></label><div><button onClick={onCancel} type="button">Cancel</button><button className="modal-primary" disabled={!name.trim()} type="submit">{confirmLabel}</button></div></form></div>;
}

const shortcutRows: Array<[string, string]> = [
  ["Play or pause", "Space"],
  ["Search", "⌘/Ctrl K"],
  ["Back / Forward", "⌘ [ / ⌘ ]  ·  Alt ← / Alt →"],
  ["Previous / Next track", "⌘/Ctrl ← / →"],
  ["Volume up / down", "⌘/Ctrl ↑ / ↓"],
  ["Queue", "⌘/Ctrl ⇧ Q"],
  ["Preferences", "⌘/Ctrl ,"],
  ["Full player", "F11 · ⌃⌘F"],
  ["Shortcut help", "?"],
  ["Dismiss", "Esc"],
];

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useDialogFocus<HTMLDivElement>(onClose);
  return (
    <div className="modal-scrim">
      <div aria-labelledby="shortcuts-title" aria-modal="true" className="desktop-modal desktop-modal--list" ref={dialogRef} role="dialog">
        <p className="eyebrow">KEYBOARD</p>
        <h2 id="shortcuts-title">Shortcuts</h2>
        <dl className="shortcut-list">{shortcutRows.map(([action, keys]) => <div key={action}><dt>{action}</dt><dd>{keys}</dd></div>)}</dl>
        <div><span className="selection-bar__spacer" /><button className="modal-primary" onClick={onClose} type="button">Done</button></div>
      </div>
    </div>
  );
}

function ConfirmDialog({ body, confirmLabel, eyebrow, onCancel, onConfirm, title }: { body: string; confirmLabel: string; eyebrow: string; onCancel: () => void; onConfirm: () => void; title: string }) {
  const dialogRef = useDialogFocus<HTMLDivElement>(onCancel);
  return <div className="modal-scrim"><div aria-labelledby="confirm-dialog-title" aria-modal="true" className="desktop-modal" ref={dialogRef} role="dialog"><p className="eyebrow">{eyebrow}</p><h2 id="confirm-dialog-title">{title}</h2><p className="modal-copy">{body}</p><div><button onClick={onCancel} type="button">Cancel</button><button className="modal-danger" onClick={onConfirm} type="button">{confirmLabel}</button></div></div></div>;
}
