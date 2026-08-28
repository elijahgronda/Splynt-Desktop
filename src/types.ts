export type AlbumSummary = {
  id: string;
  title: string;
  artist: string;
  artistId?: string;
  year?: number;
  coverArt?: string;
  duration?: number;
  songCount?: number;
  created?: string;
  starred?: string;
};

export type ArtistSummary = {
  id: string;
  name: string;
  coverArt?: string;
  albumCount?: number;
  starred?: string;
};

export type PlaylistSummary = {
  id: string;
  name: string;
  owner?: string;
  coverArt?: string;
  songCount?: number;
  duration?: number;
  changed?: string;
  public?: boolean;
};

export type SongSummary = {
  id: string;
  title: string;
  artist: string;
  artistId?: string;
  album: string;
  albumId?: string;
  coverArt?: string;
  duration?: number;
  track?: number;
  discNumber?: number;
  year?: number;
  suffix?: string;
  bitRate?: number;
  starred?: string;
  created?: string;
  explicitStatus?: string;
};

export type AlbumDetail = AlbumSummary & { songs: SongSummary[] };
export type PlaylistDetail = PlaylistSummary & { songs: SongSummary[] };
export type ArtistDetail = ArtistSummary & { albums: AlbumSummary[]; topSongs?: SongSummary[]; appearances?: AlbumSummary[] };

export type ServerInfo = {
  displayHost: string;
  username: string;
  serverType?: string;
  serverVersion?: string;
  apiVersion?: string;
};

export type ConnectedLibrary = {
  server: ServerInfo;
  albums: AlbumSummary[];
  connection?: {
    status: "online" | "offline";
    message?: string;
  };
};

export type SavedProfileSummary = {
  id: string;
  displayHost: string;
  username: string;
  allowsSelfSigned: boolean;
  isActive: boolean;
};

export type GenreShelf = {
  name: string;
  albums: AlbumSummary[];
};

export type HomeOverview = {
  newest: AlbumSummary[];
  recent: AlbumSummary[];
  frequent: AlbumSummary[];
  random: AlbumSummary[];
  genres: GenreShelf[];
};

export type JumpBackInItem = {
  kind: "album" | "artist" | "playlist";
  id: string;
  title: string;
  subtitle: string;
  coverArt?: string;
};

export type HomeShortcut = {
  kind: "album" | "playlist" | "liked";
  id: string;
  title: string;
  subtitle: string;
  coverArt?: string;
};

export type LibraryOverview = {
  albums: AlbumSummary[];
  artists: ArtistSummary[];
  playlists: PlaylistSummary[];
  starredSongs: SongSummary[];
  starredAlbums: AlbumSummary[];
  starredArtists: ArtistSummary[];
};

export type SearchResults = {
  songs: SongSummary[];
  albums: AlbumSummary[];
  artists: ArtistSummary[];
};

export type LyricsLine = {
  start: number;
  value: string;
};

export type LyricsResult = {
  synced: boolean;
  lines: LyricsLine[];
};

export type PlayQueueSnapshot = {
  songs: SongSummary[];
  currentId?: string;
  position: number;
};

export type RadioResult = {
  title: string;
  songs: SongSummary[];
};

export type DownloadItem = {
  song: SongSummary;
  bytes: number;
  downloadedAt: number;
  fileName: string;
};

export type DownloadProgress = {
  id: string;
  received: number;
  total?: number;
  status: "downloading" | "paused" | "complete" | "failed";
  message?: string;
};

export type DownloadFailure = {
  song: SongSummary;
  message: string;
  paused: boolean;
};

export type ConnectRequest = {
  server: string;
  username: string;
  password: string;
  allowsSelfSigned: boolean;
  rememberMe: boolean;
};

export type DesktopRoute =
  | { kind: "home" }
  | { kind: "search" }
  | { kind: "library" }
  | { kind: "liked" }
  | { kind: "downloads" }
  | { kind: "profile" }
  | { kind: "settings" }
  | { kind: "radio"; id: string; title: string }
  | { kind: "album"; id: string }
  | { kind: "playlist"; id: string }
  | { kind: "artist"; id: string };

export type RepeatMode = "off" | "all" | "one";

export type ConnectPlayback = {
  trackId?: string;
  title?: string;
  artist?: string;
  album?: string;
  coverArtId?: string;
  isPlaying: boolean;
  position: number;
  duration: number;
};

export type ConnectPeer = {
  id: string;
  name: string;
  platform: string;
  playback: ConnectPlayback;
  updatedAt: number;
};

export type ConnectHandoff = {
  trackIds: string[];
  currentTrackId: string;
  position: number;
  isPlaying: boolean;
};

export type ConnectGroup = {
  id: string;
  leaderId: string;
  trackId: string;
  position: number;
  isPlaying: boolean;
  sentAt: number;
};

export type ConnectGroupJoin = {
  group: ConnectGroup;
  handoff: ConnectHandoff;
};

export type ConnectCommand = {
  name: "play" | "pause" | "toggle" | "previous" | "next" | "seek" | "handoff" | "groupJoin" | "groupSync" | "groupLeave";
  value?: number;
  handoff?: ConnectHandoff;
  group?: ConnectGroup;
  groupJoin?: ConnectGroupJoin;
};

export type ConnectSnapshot = {
  isAvailable: boolean;
  localDeviceId?: string;
  peers: ConnectPeer[];
  commands: ConnectCommand[];
};

export type ContextPanelMode = "nowPlaying" | "queue" | "lyrics" | "connect";
